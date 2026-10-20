/**
 * 导入区块（迁移页签第三块）—— 粘贴与选文件走同一条「解析 → 识别形态 → 校验 → 写入」管线。
 *
 * 识别规则见 `shared/migrationStream`（裸配置 vs 完整迁移包）。
 * 两种输入只是喂给扫描器的数据源不同，后续处理完全一致，所以只有一个 `importEvents`。
 *
 * 关键约束（都在下面各自的注释里写明了原因）：
 * - 按流解码，**不**用 `file.text()`（V8 单字符串上限）
 * - 边解析边攒批，**不**先把整份载荷落地在内存里
 * - 配置整份校验失败时逐键救回（一个坏键不该让其余配置全丢）
 */
import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { configSchema } from '../../../shared/configSchema'
import { LEGACY_MAX_MESSAGE_BYTES, LEGACY_MAX_MESSAGE_RECORDS, estimateLegacyRecordBytes } from '../../../shared/legacyDb'
import type { LegacyBatchResult, LegacyStore } from '../../../shared/legacyDb'
import { scanMigrationJson } from '../../../shared/migrationStream'
import type { MigrationEvent } from '../../../shared/migrationStream'
import { unknownConfigKeys } from '../../../shared/migrationPayload'
import { send } from '../../../messaging/hub'
import { CONFIG_KEY } from '../../../shared/storageKeys'
import { writeConfigRaw } from '../../appStore'
import { FilePicker, Section, formatKeyList, storeLabel } from '../../widgets'

/** 粘贴文本只有一个块：扫描器对块边界无感知，单块即可复用同一条异步链路 */
async function* singleChunk(text: string): AsyncGenerator<string> {
    yield text
}

/**
 * 逐块解码文件内容（**不要**用 `file.text()`）。
 *
 * `Blob.text()` 会把整个文件解码成**一个** JS 字符串，大库直接撞 V8 的字符串上限；
 * `TextDecoderStream` 则是边解码边交付，内存只跟块大小相关。
 */
async function* readFileChunks(file: File): AsyncGenerator<string> {
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader()
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done === true) return
            if (typeof value === 'string' && value.length > 0) yield value
        }
    } finally {
        reader.releaseLock()
    }
}

interface MigrationResult {
    ok: boolean
    lines: MigrationLine[]
}

/**
 * 结果框里的一行。
 *
 * `warn` 是**逻辑状态**，不是展示样式：整份导入的成败由它汇总得出。
 * 之前这里只有一个字符串，于是靠 `line.startsWith('⚠')` 猜哪行是警告——
 * 那等于让翻译文案驱动业务判定：译者去掉/换掉符号、或新增一条忘了加 ⚠ 的警告行，
 * `ok` 就会静默说错。文案里保留 ⚠ 只是为了视觉，判断一律看这个字段。
 */
interface MigrationLine {
    text: string
    warn?: boolean
}

export function ImportSection(): ReactElement {
    const { t: tr } = useTranslation()
    const [busy, setBusy] = useState(false)
    const [result, setResult] = useState<MigrationResult | null>(null)
    const [pastedLength, setPastedLength] = useState(0)
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    /**
     * 配置合并导入。
     * 整份校验失败时**逐键救回**：一个坏键（例如旧版本遗留的枚举值）不该让其余配置全部丢弃。
     */
    const applyConfig = async (input: Record<string, unknown>): Promise<MigrationLine[]> => {
        const lines: MigrationLine[] = []
        const stored = (await browser.storage.local.get([CONFIG_KEY]))[CONFIG_KEY] as Record<string, unknown> | undefined
        const ignored = unknownConfigKeys(input)
        const candidates = Object.keys(input).filter((key) => !ignored.includes(key))

        const merged = configSchema.safeParse({ ...(stored ?? {}), ...input })
        if (merged.success) {
            await writeConfigRaw(merged.data as unknown as Record<string, unknown>)
            lines.push({ text: tr('migrate.configMerged', { n: candidates.length }) })
        } else {
            let next = { ...(stored ?? {}) }
            const applied: string[] = []
            const rejected: string[] = []
            for (const key of candidates) {
                const attempt = configSchema.safeParse({ ...next, [key]: input[key] })
                if (attempt.success) {
                    next = attempt.data as unknown as Record<string, unknown>
                    applied.push(key)
                } else {
                    rejected.push(key)
                }
            }
            await writeConfigRaw(next)
            lines.push({ text: tr('migrate.configMergedPartial', { applied: applied.length, candidates: candidates.length }), warn: rejected.length > 0 })
            if (rejected.length > 0) lines.push({ text: tr('migrate.configRejected', { n: rejected.length, keys: formatKeyList(rejected, tr) }), warn: true })
        }
        if (ignored.length > 0) lines.push({ text: tr('migrate.configIgnored', { n: ignored.length, keys: formatKeyList(ignored, tr) }), warn: true })
        return lines
    }

    /**
     * 四张库存表：**交给后台写入**（后台是视频库唯一写入者）。
     *
     * 结构校验与分批落库都在后台的 `LEGACY_DB_BATCH` 里（含二分隔离）；
     * options 只负责按消息体积预算切批并如实转述计数。
     * 切批是必需的：整表一次发过去会撞消息上限（与旧库导入同一个约束）。
     *
     * 记录是**边解析边攒批**的（见下方 `importEvents`），所以这里拿到的永远只有
     * 当前这一批，而不是整张表——大库导入的峰值内存由此恒定。
     */
    interface StoreTally {
        store: LegacyStore
        written: number
        invalid: number
        failed: number
        total: number
    }

    const createTally = (store: LegacyStore): StoreTally => ({ store, written: 0, invalid: 0, failed: 0, total: 0 })

    /** 一批记录 → 一条消息；计数累加进 tally，失败如实记录 */
    const flushBatch = async (tally: StoreTally, batch: unknown[]): Promise<void> => {
        if (batch.length === 0) return
        const result = await send<LegacyBatchResult>({ type: 'LEGACY_DB_BATCH', payload: { store: tally.store, records: batch } })
        tally.written += result.written
        tally.invalid += result.invalid
        tally.failed += result.failed
        tally.total += batch.length
    }

    const tallyLines = (tally: StoreTally): MigrationLine[] => {
        if (tally.total === 0) return []
        const label = storeLabel(tally.store, tr)
        const lines: MigrationLine[] = [{ text: tr('migrate.storeWritten', { store: label, written: tally.written, total: tally.total }) }]
        if (tally.invalid > 0) lines.push({ text: tr('migrate.storeInvalid', { store: label, n: tally.invalid }), warn: true })
        if (tally.failed > 0) lines.push({ text: tr('migrate.storeFailed', { store: label, n: tally.failed }), warn: true })
        return lines
    }

    /**
     * 导入主链路：消费扫描器事件，边解析边写入。
     *
     * 事件是**流式**来的（`shared/migrationStream`），所以这里不能先把载荷攒起来：
     * 一旦整表落地在内存里，大库又会回到「整串解析」的老问题。
     */
    const importEvents = async (events: AsyncIterable<MigrationEvent>, source: string): Promise<void> => {
        setBusy(true)
        try {
            const lines: MigrationLine[] = []
            const ignored: string[] = []
            let tally: StoreTally | null = null
            let batch: unknown[] = []
            let batchBytes = 0

            const closeStore = async (): Promise<void> => {
                if (!tally) return
                await flushBatch(tally, batch)
                lines.push(...tallyLines(tally))
                tally = null
                batch = []
                batchBytes = 0
            }

            for await (const event of events) {
                switch (event.type) {
                    case 'shape':
                        lines.push({ text: tr('migrate.recognized', { source, kind: event.shape === 'package' ? tr('migrate.kindPackage') : tr('migrate.kindConfig') }) })
                        break
                    case 'ignoredKey':
                        ignored.push(event.key)
                        break
                    case 'config':
                        lines.push(...(await applyConfig(event.value)))
                        break
                    case 'record': {
                        if (tally?.store !== event.store) {
                            await closeStore()
                            tally = createTally(event.store)
                        }
                        batch.push(event.value)
                        batchBytes += estimateLegacyRecordBytes(event.value)
                        if (batch.length >= LEGACY_MAX_MESSAGE_RECORDS || batchBytes >= LEGACY_MAX_MESSAGE_BYTES) {
                            await flushBatch(tally, batch)
                            batch = []
                            batchBytes = 0
                        }
                        break
                    }
                }
            }
            await closeStore()

            // 未识别的顶层键统一插在「识别为…」之后：事件是流式的，
            // 若等到结尾再 push 会把这条提示排到所有表之后，读起来像是「表导入的结果」。
            if (ignored.length > 0) lines.splice(1, 0, { text: tr('migrate.ignoredTop', { keys: formatKeyList(ignored, tr) }), warn: true })

            setResult({ ok: lines.every((line) => !line.warn), lines })
        } catch (error) {
            setResult({ ok: false, lines: [{ text: tr('migrate.importFailedLine', { message: error instanceof Error ? error.message : String(error) }) }] })
        } finally {
            setBusy(false)
        }
    }

    const importPasted = (): void => {
        const text = textareaRef.current?.value ?? ''
        void importEvents(scanMigrationJson(singleChunk(text)), tr('migrate.sourcePasted'))
    }

    /**
     * 文件导入：按流解码，**不**调用 `file.text()`。
     * `Blob.text()` 会把整个文件解成一个 JS 字符串，大库直接撞字符串上限；
     * 这里用 `TextDecoderStream` 分块喂给扫描器，内存只跟块大小相关。
     */
    const importFile = (file: File): void => {
        void importEvents(scanMigrationJson(readFileChunks(file)), tr('migrate.sourceFile', { name: file.name }))
    }

    return (
        <Section title={tr('migrate.importTitle')} note={tr('migrate.importNote')}>
            <textarea ref={textareaRef} className="paste-box" data-testid="migrate-paste" rows={8} spellCheck={false} placeholder={'{"downloadPath": "/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4", "filterLikedVideos": false}'} onInput={(event) => setPastedLength(event.currentTarget.value.length)} />
            <div className="action-row">
                <button type="button" className="primary" data-testid="migrate-paste-import" disabled={busy || pastedLength === 0} onClick={importPasted}>
                    {busy ? tr('migrate.importing') : tr('migrate.importPaste')}
                </button>
                <span className="paste-count">{pastedLength > 0 ? tr('migrate.pastedCount', { n: pastedLength.toLocaleString() }) : tr('migrate.pasteHint')}</span>
                <FilePicker accept="application/json,.json" disabled={busy} hint={tr('migrate.pickFile')} onPick={importFile} />
            </div>
            {result ? (
                <div className={`result-box ${result.ok ? 'ok' : 'warn'}`}>
                    {result.lines.map((line, index) => (
                        <p key={index}>{line.text}</p>
                    ))}
                </div>
            ) : null}
        </Section>
    )
}

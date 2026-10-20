/**
 * 迁移包的**流式解析** —— 文件导入与粘贴导入共用同一条链路。
 *
 * 为什么不能 `JSON.parse(text)`：
 * 视频库记录单条可达数 MB，整份导出文本会超过 V8 的单字符串上限（≈512 MiB）。
 * `file.text()` 先把字节解成**一个** JS 字符串，`JSON.parse` 再要一份等长的解析输入
 * —— 大库在第一步就抛 `allocation size overflow`。导出侧已经改成增量写
 * （见 `options/exportBundle`），导入侧必须同样增量读，否则「导出的备份导不回来」。
 *
 * 做法：把字节流解码成字符串块，用一个**字符级扫描器**只切出结构，不做整串解析：
 * - 顶层成员按文档顺序处理，`config` 与未知键逐值 `JSON.parse`（体积天然很小）；
 * - 四张表**逐条**切出元素原文再 `JSON.parse`，调用方可以边解析边分批入库，
 *   内存里始终只有当前一批记录。
 *
 * 关于「为什么不复用 `migrationPayload` 的对象判定」：
 * 那套规则的前提是「整个文档已经在内存里」，而这里恰恰不能把文档读进内存。
 * 能共享的部分已经共享（`LEGACY_STORES`、`isRecord`、i18n 错误键、`configSchema`）；
 * 剩下的只是「把字符流切成分片」，它本来就无法在已解析的对象上复用。
 *
 * 解析器对空白不敏感（换行/缩进任意），所以能读任何 JSON.stringify 产物，
 * 包括加缩进的旧版本导出文件。
 */
import { configSchema } from './configSchema'
import { i18n } from './i18n'
import { LEGACY_STORES, isRecord } from './legacyDb'
import type { LegacyStore } from './legacyDb'
import type { MigrationPayloadShape } from './migrationPayload'

/**
 * 裸配置对象的体积上限（字符）。
 *
 * 只有「整份文档都不是迁移包」时才需要把顶层攒成一个对象交给 zod——而配置本身
 * 只有几十个键、几十 KB。超过这个量级还不出现 config/四表键，说明它不是本扩展
 * 认识的配置，直接报「无法识别」比继续吃内存诚实。
 */
const BARE_CONFIG_MAX_CHARS = 8 * 1024 * 1024

/** 扫描器产出的事件（调用方按顺序消费，不需要自己理解 JSON 结构） */
export type MigrationEvent =
    /** 文档形态；`package` 在遇到第一个 config/表键时发出，`config` 在结尾发出 */
    | { type: 'shape'; shape: MigrationPayloadShape }
    | { type: 'config'; value: Record<string, unknown> }
    | { type: 'record'; store: LegacyStore; value: unknown }
    /** 迁移包顶层未被识别的键（如实上报，不静默丢弃） */
    | { type: 'ignoredKey'; key: string }

const CONFIG_KEYS = new Set(Object.keys(configSchema.shape))
const STORE_KEYS = new Set<string>(LEGACY_STORES)

const invalid = (detail: string): Error => new Error(i18n.t('error.invalidJson', { message: detail }))

/** JSON 空白 + BOM（文件解码通常已去掉 BOM，粘贴文本可能带） */
const isWhitespace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0xfeff

/**
 * 字符游标：跨块连续读取，块内用索引同步推进。
 *
 * 只有「当前块读完」时才 `await` 取下一块——若每个字符都 await 一次，
 * 大库就是几亿次微任务，导入会慢到不可用。
 */
class JsonCursor {
    private chunk = ''
    private index = 0
    private ended = false
    private readonly iterator: AsyncIterator<string>

    constructor(chunks: AsyncIterable<string>) {
        this.iterator = chunks[Symbol.asyncIterator]()
    }

    private async load(): Promise<boolean> {
        if (this.ended) return false
        const next = await this.iterator.next()
        if (next.done === true) {
            this.ended = true
            this.chunk = ''
            this.index = 0
            return false
        }
        this.chunk = next.value
        this.index = 0
        return true
    }

    peek(): string | undefined {
        return this.index < this.chunk.length ? this.chunk[this.index] : undefined
    }

    async skipWhitespace(): Promise<void> {
        for (;;) {
            while (this.index < this.chunk.length && isWhitespace(this.chunk.charCodeAt(this.index))) this.index++
            if (this.index < this.chunk.length) return
            if (!(await this.load())) return
        }
    }

    async take(char: string): Promise<void> {
        if (this.peek() !== char) throw invalid(`expected '${char}'`)
        this.index++
    }

    /** 读取一个完整 JSON 值的原文（字符串 / 数字 / 字面量 / 对象 / 数组） */
    async readValueText(): Promise<string> {
        await this.skipWhitespace()
        const first = this.peek()
        if (first === undefined) throw invalid('unexpected end of input')

        if (first === '"') return this.readStringText()

        if (first === '{' || first === '[') {
            const parts: string[] = []
            let depth = 0
            let inString = false
            let escaped = false
            for (;;) {
                const start = this.index
                while (this.index < this.chunk.length) {
                    const char = this.chunk[this.index]!
                    this.index++
                    if (inString) {
                        if (escaped) escaped = false
                        else if (char === '\\') escaped = true
                        else if (char === '"') inString = false
                        continue
                    }
                    if (char === '"') inString = true
                    else if (char === '{' || char === '[') depth++
                    else if (char === '}' || char === ']') {
                        depth--
                        if (depth === 0) {
                            parts.push(this.chunk.slice(start, this.index))
                            return parts.join('')
                        }
                    }
                }
                parts.push(this.chunk.slice(start))
                if (!(await this.load())) throw invalid('unexpected end of input')
            }
        }

        // 数字 / true / false / null：读到分隔符为止（可能跨块）
        const parts: string[] = []
        for (;;) {
            const start = this.index
            while (this.index < this.chunk.length) {
                const char = this.chunk[this.index]!
                if (char === ',' || char === '}' || char === ']' || isWhitespace(this.chunk.charCodeAt(this.index))) break
                this.index++
            }
            parts.push(this.chunk.slice(start, this.index))
            if (this.index < this.chunk.length) break
            if (!(await this.load())) break
        }
        const text = parts.join('')
        if (text === '') throw invalid('unexpected character')
        return text
    }

    private async readStringText(): Promise<string> {
        const parts: string[] = []
        let escaped = false
        // 起始引号本身要计入返回值（调用方直接 JSON.parse），但**不能**被当成结束引号
        let start = this.index
        this.index++
        for (;;) {
            while (this.index < this.chunk.length) {
                const char = this.chunk[this.index]!
                this.index++
                if (escaped) escaped = false
                else if (char === '\\') escaped = true
                else if (char === '"') {
                    parts.push(this.chunk.slice(start, this.index))
                    return parts.join('')
                }
            }
            parts.push(this.chunk.slice(start))
            if (!(await this.load())) throw invalid('unexpected end of input')
            start = 0
        }
    }
}

/**
 * 扫描迁移包，逐事件产出。
 *
 * 错误文案与判定顺序对齐「先整串解析再判形」的旧实现，唯一区别是
 * **条目按文档顺序即时处理**：同一份文档里若同时存在多处结构错误，
 * 报出的是文档里先出现的那个（旧实现按 `Object.keys` 顺序，两者通常一致）。
 */
export async function* scanMigrationJson(chunks: AsyncIterable<string>): AsyncGenerator<MigrationEvent, void, void> {
    const cursor = new JsonCursor(chunks)

    await cursor.skipWhitespace()
    const root = cursor.peek()
    if (root === undefined) throw new Error(i18n.t('error.emptyInput'))
    if (root !== '{') throw new Error(i18n.t('error.jsonObject'))
    await cursor.take('{')

    /** 尚未确定是迁移包时攒下的顶层键（若最终确认是包，它们都算「未识别的键」） */
    let bare: Record<string, unknown> = {}
    let bareChars = 0
    let packageMode = false
    let shapeEmitted = false
    let appliedConfig = false
    let appliedStore = false
    let first = true

    for (;;) {
        await cursor.skipWhitespace()
        const next = cursor.peek()
        if (next === undefined) throw invalid('unexpected end of input')
        if (first) {
            if (next === '}') {
                await cursor.take('}')
                break
            }
        } else if (next === ',') {
            await cursor.take(',')
            await cursor.skipWhitespace()
            if (cursor.peek() === '}') throw invalid('trailing comma')
        } else if (next === '}') {
            await cursor.take('}')
            break
        } else {
            throw invalid(`expected ',' or '}' but found '${next}'`)
        }
        first = false

        const keyText = await cursor.readValueText()
        if (!keyText.startsWith('"')) throw invalid('object keys must be strings')
        const key = JSON.parse(keyText) as string

        await cursor.skipWhitespace()
        await cursor.take(':')

        if (!packageMode && (STORE_KEYS.has(key) || key === 'config')) {
            packageMode = true
            if (!shapeEmitted) {
                shapeEmitted = true
                yield { type: 'shape', shape: 'package' }
            }
            // 之前攒下的键此刻定性：在迁移包里它们都是未识别的顶层键
            for (const ignored of Object.keys(bare)) yield { type: 'ignoredKey', key: ignored }
            bare = {}
        }

        if (STORE_KEYS.has(key)) {
            const store = key as LegacyStore
            await cursor.skipWhitespace()
            if (cursor.peek() !== '[') {
                const text = await cursor.readValueText()
                if (text !== 'null') throw new Error(i18n.t('error.storeNotArray', { store }))
                continue
            }
            await cursor.take('[')
            let firstItem = true
            for (;;) {
                await cursor.skipWhitespace()
                const char = cursor.peek()
                if (char === undefined) throw invalid('unexpected end of input')
                if (char === ']') {
                    await cursor.take(']')
                    break
                }
                if (!firstItem) {
                    await cursor.take(',')
                    await cursor.skipWhitespace()
                }
                firstItem = false
                const text = await cursor.readValueText()
                yield { type: 'record', store, value: JSON.parse(text) }
            }
            appliedStore = true
            continue
        }

        if (key === 'config') {
            const text = await cursor.readValueText()
            if (text !== 'null') {
                const value = JSON.parse(text) as unknown
                if (!isRecord(value)) throw new Error(i18n.t('error.configNotObject'))
                appliedConfig = true
                yield { type: 'config', value }
            }
            continue
        }

        const text = await cursor.readValueText()
        if (packageMode) {
            yield { type: 'ignoredKey', key }
        } else {
            bareChars += text.length
            if (bareChars > BARE_CONFIG_MAX_CHARS) throw new Error(i18n.t('error.unrecognized'))
            bare[key] = JSON.parse(text)
        }
    }

    if (packageMode) {
        if (!appliedConfig && !appliedStore) throw new Error(i18n.t('error.noImportable'))
        return
    }

    const keys = Object.keys(bare)
    if (keys.length === 0) throw new Error(i18n.t('error.jsonEmpty'))
    // 裸配置必须至少含一个本扩展认识的键，否则可能是一份无关 JSON：
    // 当成配置处理会被 zod 剥掉全部未知键并写入默认值，等于重置用户配置。
    if (!keys.some((key) => CONFIG_KEYS.has(key))) throw new Error(i18n.t('error.unrecognized'))
    yield { type: 'shape', shape: 'config' }
    yield { type: 'config', value: bare }
}

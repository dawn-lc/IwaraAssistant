/**
 * 导出区块（迁移页签第二块）—— 把整库导出成完整迁移包。
 *
 * ## 为什么两个输出目标共用一个 `pending`
 *
 * 两个目标都要把四张表**整表遍历一遍**（导出体积等于库的体积），且各自要持有一份产物：
 * 文件是一组 Blob 分块，剪贴板是拼好的整份字符串。两个按钮各自独立 = 可以同时点 →
 * 两轮全表遍历 + 两份产物同时在内存里。互斥是**真实约束**，不是风格问题。
 *
 * 互斥的最小表示就是一个值：它同时编码「有没有人在跑」（决定两个按钮的 disabled）
 * 与「谁在跑」（决定哪个按钮换文案）。拆成两个布尔反而要再加一个共享锁，状态更多。
 *
 * 与「三个区块共用一个 busy」的区别：那个枚举跨了三个**互不相关**的操作，
 * 让导入按钮显示导出的进行中文案——状态的作用域大于它影响的 UI 范围，是语义错误。
 * 这里两个目标共享同一条数据库遍历与同一份产物内存，作用域恰好一致。
 *
 * 用表驱动而不是两个平行三元表达式：新增第三个目标（例如导出到 Gist）只加一行数据，
 * 不会漏掉「忙碌文案」「禁用联动」这类必须同步的细节。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { LegacyStore } from '../../../shared/legacyDb'
import { CLIPBOARD_LIMIT_LABEL, CLIPBOARD_MAX_CHARS, createExportStream } from '../../exportBundle'
import { ProgressBar, Section, formatBytes, storeLabel } from '../../widgets'

const EXPORT_TARGETS = [
    { id: 'file', className: 'primary', labelKey: 'migrate.exportFile', busyKey: 'migrate.exporting' },
    { id: 'clipboard', className: 'ghost', labelKey: 'migrate.copyClipboard', busyKey: 'migrate.copying' }
] as const

type ExportTargetId = (typeof EXPORT_TARGETS)[number]['id']

export function ExportSection(): ReactElement {
    const { t: tr } = useTranslation()
    const [pending, setPending] = useState<ExportTargetId | null>(null)
    /**
     * 导出进度。1.6 GB 的库要跑几分钟（百来次分页消息），这段期间按钮只是变灰，
     * 用户完全看不出它在动——所以必须有进度条（与旧库导入、批量入库同一个组件）。
     */
    const [progress, setProgress] = useState<{ store: LegacyStore; done: number; total: number; bytes: number } | null>(null)

    /**
     * 导出全部数据（config + 视频库 + 关注/好友 + ID 映射），格式与粘贴/文件导入兼容。
     *
     * **不能**先把整份载荷拼成一个字符串：视频库单条记录可达数 MB，整库 JSON 文本会
     * 越过 V8 的单字符串上限（≈512 MiB），`JSON.stringify` 直接抛 `allocation size overflow`。
     * 序列化改由 `../../exportBundle` 按页增量产出（详见那里的注释），这里只负责落盘。
     */
    const exportAll = async (): Promise<void> => {
        setPending('file')
        setProgress(null)
        try {
            // 每块立刻转成 Blob 并丢掉原字符串：峰值只多一个块，而不是整份文本
            const parts: Blob[] = []
            // 体积从 Blob 读（UTF-8 真实字节），不拿字符数冒充
            let bytes = 0
            const onProgress = (next: { store: LegacyStore; done: number; total: number }): void => setProgress({ ...next, bytes })
            const streamWithProgress = createExportStream(onProgress)
            for await (const chunk of streamWithProgress.chunks) {
                const blob = new Blob([chunk])
                parts.push(blob)
                bytes += blob.size
            }
            const blob = new Blob(parts, { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            try {
                await browser.downloads.download({
                    url,
                    filename: 'IwaraAssistant-export.json',
                    conflictAction: 'uniquify',
                    saveAs: true
                })
            } finally {
                window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
            }
            toast.success(tr('migrate.exported', streamWithProgress.counts))
        } catch (error) {
            toast.error(tr('migrate.exportFailed', { message: error instanceof Error ? error.message : String(error) }), { duration: 6000 })
        } finally {
            setPending(null)
            setProgress(null)
        }
    }

    /**
     * 复制到剪贴板 —— 对齐油猴脚本的导出方式（它就是把配置文本复制到剪贴板）。
     * 这里复制的是**完整迁移包**，粘回本扩展可原样导入。
     *
     * 剪贴板 API 只接受单个字符串，所以这里必须设上限：超限时明确告诉用户改用文件导出，
     * 而不是把底层的「allocation size overflow」原样抛给用户。
     */
    const copyAll = async (): Promise<void> => {
        setPending('clipboard')
        setProgress(null)
        try {
            let bytes = 0
            const onProgress = (next: { store: LegacyStore; done: number; total: number }): void => setProgress({ ...next, bytes })
            const stream = createExportStream(onProgress)
            let text = ''
            for await (const chunk of stream.chunks) {
                if (text.length + chunk.length > CLIPBOARD_MAX_CHARS) throw new Error(tr('migrate.clipboardTooLarge', { limit: CLIPBOARD_LIMIT_LABEL }))
                text += chunk
                bytes += new TextEncoder().encode(chunk).length
            }
            await navigator.clipboard.writeText(text)
            toast.success(tr('migrate.copied', stream.counts))
        } catch (error) {
            toast.error(tr('migrate.copyFailed', { message: error instanceof Error ? error.message : String(error) }), { duration: 8000 })
        } finally {
            setPending(null)
            setProgress(null)
        }
    }

    /** 目标 id → 执行函数：按钮由同一张表生成，JSX 里不再出现平行分叉 */
    const runners: Record<ExportTargetId, () => Promise<void>> = { file: exportAll, clipboard: copyAll }

    /**
     * 进度文案：与进度条**共用同一份数据**（分开算两遍必然在 total=0 这类边界上漂移）。
     * 总量已知时走确定态；`total === 0`（空库）时没有比例可算，交给 ProgressBar 的不确定态。
     */
    const progressText = progress
        ? tr(pending === 'clipboard' ? 'migrate.copyProgress' : 'migrate.exportProgress', {
              store: storeLabel(progress.store, tr),
              done: progress.done.toLocaleString(),
              total: progress.total.toLocaleString(),
              size: formatBytes(progress.bytes)
          })
        : null

    return (
        <Section title={tr('migrate.exportTitle')} note={tr('migrate.exportNote')}>
            <div className="action-row">
                {EXPORT_TARGETS.map((target) => (
                    <button key={target.id} type="button" className={target.className} disabled={pending !== null} onClick={() => void runners[target.id]()}>
                        {pending === target.id ? tr(target.busyKey) : tr(target.labelKey)}
                    </button>
                ))}
            </div>
            {/* 进度：1.6 GB 的库要跑几分钟，没有这条就只能看著按钮发呆 */}
            {progressText ? (
                <>
                    <ProgressBar value={progress && progress.total > 0 ? progress.done / progress.total : undefined} label={progressText} testId="export-progress" />
                    <p className="note">{progressText}</p>
                </>
            ) : null}
            <p className="note">{tr('migrate.exportHint')}</p>
        </Section>
    )
}

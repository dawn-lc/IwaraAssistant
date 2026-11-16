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
 * ## 为什么运行态在 storage.session 而不是 useState
 *
 * `pending` / `progress` 原本都是页面 state，于是切换选项页签（组件卸载）再回来时：
 * 进度条消失、按钮变回可点，而**导出循环还在跑**（它挂在闭包里，不随组件卸载停止）。
 * 用户此时再点一次就是第二轮全表遍历 + 磁盘上第二份文件（`conflictAction: uniquify`
 * 让数据不坏，但几分钟白跑）。这跟站点遍历 / MediaCenter / 好友审批修的是同一个 bug，
 * 所以用同一套机制：后台（这里是页面里的循环）写 `storage.session` 快照，界面订阅 `onChanged`。
 *
 * 与另外三处唯一的不同是「生产者也是页面」，因此判活不能靠「内存里有没有任务」
 * （读的可能是另一个标签页）。改由 `BroadcastChannel` 问一句：真正还在跑的页面会应答，
 * 没有应答就是残骸——证据，不是猜时间。细节见 `../../exportRun.ts`。
 *
 * 用表驱动而不是两个平行三元表达式：新增第三个目标（例如导出到 Gist）只加一行数据，
 * 不会漏掉「忙碌文案」「禁用联动」这类必须同步的细节。
 */
import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { EXPORT_RUN_KEY } from '../../../shared/storageKeys'
import { CLIPBOARD_LIMIT_LABEL, CLIPBOARD_MAX_CHARS, createExportStream } from '../../exportBundle'
import { claimExportOwnership, exportRunRatio, IDLE_EXPORT_RUN, isExportOwnerAlive, parseExportRun } from '../../exportRun'
import type { ExportRun, ExportTarget } from '../../exportRun'
import { ProgressBar, Section, formatBytes, storeLabel, useStorageSnapshot } from '../../widgets'

const EXPORT_TARGETS = [
    { id: 'file', className: 'primary', labelKey: 'migrate.exportFile', busyKey: 'migrate.exporting' },
    { id: 'clipboard', className: 'ghost', labelKey: 'migrate.copyClipboard', busyKey: 'migrate.copying' }
] as const

type ExportTargetId = (typeof EXPORT_TARGETS)[number]['id']

/** 运行态更新：只给变化的部分，其余沿用上一份快照 */
type Report = (patch: Partial<ExportRun>) => void

export function ExportSection(): ReactElement {
    const { t: tr } = useTranslation()
    const [localBusy, setLocalBusy] = useState<ExportTargetId | null>(null)
    /** 本页正在导出时的「我还活着」应答器；收尾必须关掉，否则别的页面会以为还在跑 */
    const releaseRef = useRef<(() => void) | null>(null)

    const run = useStorageSnapshot<ExportRun>({
        area: 'session',
        key: EXPORT_RUN_KEY,
        parse: parseExportRun,
        initial: IDLE_EXPORT_RUN,
        // 初值要在这里做残骸归一（hook 自己只会读一遍存储）：快照说在跑，就问一句
        // 还有没有页面在跑——有就如实显示（另一个标签页在导），没有就是上次留下的残骸。
        readInitial: async () => {
            const stored = parseExportRun((await browser.storage.session.get(EXPORT_RUN_KEY))[EXPORT_RUN_KEY])
            if (!stored || stored.status !== 'running') return stored ?? IDLE_EXPORT_RUN
            if (await isExportOwnerAlive()) return stored
            const interrupted: ExportRun = { ...stored, status: 'interrupted', updatedAt: Date.now() }
            await browser.storage.session.set({ [EXPORT_RUN_KEY]: interrupted })
            return interrupted
        }
    })

    /**
     * 「在跑」= 本页点击 ∪ 快照 running。
     * 加后者是因为 `localBusy` 只是页面 state：切到别的页签再回来（组件重挂载）会丢，
     * 而导出还在另一个标签页里跑——那正是这个区块要修的 bug。
     */
    const running = localBusy !== null || run.status === 'running'
    const activeTarget = localBusy ?? (run.status === 'running' ? run.target : null)
    /** 快照说在跑、而本页没有在跑 ⇒ 是另一个标签页发起的 */
    const drivenElsewhere = localBusy === null && run.status === 'running'

    /**
     * 两个目标的公共外壳：置位 → 发布运行态 → 跑目标自己的产出 → 收尾。
     *
     * `body` 只负责「把块变成产物」（文件攒 Blob、剪贴板拼字符串），运行态与应答通道的维护
     * 统一在这里，避免两个目标各写一遍而在某个分支忘记关掉应答器（那会让界面永远显示在跑）。
     *
     * 收尾的两种写法都是**写终态**而不是删键：`useStorageSnapshot` 把「解析不出来」当成
     * 「这份值不可信，保留上一份」，删掉键会让界面一直停在最后那个 running 上。
     */
    const runExport = async (target: ExportTargetId, body: (report: Report) => Promise<void>): Promise<void> => {
        let last: ExportRun = { ...IDLE_EXPORT_RUN, status: 'running', target }
        const publish = (patch: Partial<ExportRun>): void => {
            last = { ...last, ...patch, updatedAt: Date.now() }
            void browser.storage.session.set({ [EXPORT_RUN_KEY]: last })
        }
        setLocalBusy(target)
        releaseRef.current = claimExportOwnership()
        publish({})
        try {
            await body(publish)
            // 成功即写回空闲：文件已落盘、剪贴板已写入，再留一条「已完成」只是把 toast 又说一遍
            publish({ status: 'idle' })
        } catch (error) {
            publish({ status: 'interrupted' })
            throw error
        } finally {
            setLocalBusy(null)
            releaseRef.current?.()
            releaseRef.current = null
        }
    }

    /**
     * 导出到文件（config + 视频库 + 关注/好友 + ID 映射），格式与粘贴/文件导入兼容。
     *
     * **不能**先把整份载荷拼成一个字符串：视频库单条记录可达数 MB，整库 JSON 文本会
     * 越过 V8 的单字符串上限（≈512 MiB），`JSON.stringify` 直接抛 `allocation size overflow`。
     * 序列化改由 `../../exportBundle` 按页增量产出（详见那里的注释），这里只负责落盘。
     */
    const exportAll = async (): Promise<void> => {
        try {
            await runExport('file', async (report) => {
                // 每块立刻转成 Blob 并丢掉原字符串：峰值只多一个块，而不是整份文本
                const parts: Blob[] = []
                // 体积从 Blob 读（UTF-8 真实字节），不拿字符数冒充
                let bytes = 0
                const stream = createExportStream((next) => report({ ...next, bytes }))
                for await (const chunk of stream.chunks) {
                    const blob = new Blob([chunk])
                    parts.push(blob)
                    bytes += blob.size
                    report({ bytes })
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
                toast.success(tr('migrate.exported', stream.counts))
            })
        } catch (error) {
            toast.error(tr('migrate.exportFailed', { message: error instanceof Error ? error.message : String(error) }), { duration: 6000 })
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
        try {
            await runExport('clipboard', async (report) => {
                let bytes = 0
                const stream = createExportStream((next) => report({ ...next, bytes }))
                let text = ''
                for await (const chunk of stream.chunks) {
                    if (text.length + chunk.length > CLIPBOARD_MAX_CHARS) throw new Error(tr('migrate.clipboardTooLarge', { limit: CLIPBOARD_LIMIT_LABEL }))
                    text += chunk
                    bytes += new TextEncoder().encode(chunk).length
                    report({ bytes })
                }
                await navigator.clipboard.writeText(text)
                toast.success(tr('migrate.copied', stream.counts))
            })
        } catch (error) {
            toast.error(tr('migrate.copyFailed', { message: error instanceof Error ? error.message : String(error) }), { duration: 8000 })
        }
    }

    /** 目标 id → 执行函数：按钮由同一张表生成，JSX 里不再出现平行分叉 */
    const runners: Record<ExportTargetId, () => Promise<void>> = { file: exportAll, clipboard: copyAll }

    /**
     * 进度文案：与进度条**共用同一份数据**（分开算两遍必然在 total=0 这类边界上漂移）。
     * 总量已知时走确定态；`total === 0`（空库）时没有比例可算，交给 ProgressBar 的不确定态。
     */
    const progressText = running
        ? tr(activeTarget === 'clipboard' ? 'migrate.copyProgress' : 'migrate.exportProgress', {
              store: storeLabel(run.store, tr),
              done: run.done.toLocaleString(),
              total: run.total.toLocaleString(),
              size: formatBytes(run.bytes)
          })
        : null

    return (
        <Section title={tr('migrate.exportTitle')} note={tr('migrate.exportNote')}>
            <div className="action-row">
                {EXPORT_TARGETS.map((target) => (
                    <button key={target.id} type="button" className={target.className} disabled={running} onClick={() => void runners[target.id]()}>
                        {activeTarget === target.id ? tr(target.busyKey) : tr(target.labelKey)}
                    </button>
                ))}
            </div>
            {/* 进度：1.6 GB 的库要跑几分钟，没有这条就只能看著按钮发呆 */}
            {progressText ? (
                <>
                    <ProgressBar value={exportRunRatio(run)} label={progressText} testId="export-progress" />
                    <p className="note">{progressText}</p>
                </>
            ) : null}
            {drivenElsewhere ? <p className="note">{tr('migrate.exportElsewhere')}</p> : null}
            {/* 中断痕迹：不假装成功，也不自动重跑（重跑是用户的选择） */}
            {!running && run.status === 'interrupted' ? <p className="note">{tr('migrate.exportInterrupted')}</p> : null}
            <p className="note">{tr('migrate.exportHint')}</p>
        </Section>
    )
}

/**
 * 任务页签 —— **待办收件箱 + 下载队列**
 *
 * ## 为什么是「收件箱」
 *
 * 源项目把大量交互放在页内 toast 上：自定义按钮（「打开视频链接」「重新解析」）、
 * 富文本、`hover` 暂停计时、`duration: -1` 常驻直到点掉。系统通知做不到这些
 * （Chrome 桌面版不渲染 `buttons`，Firefox 不支持；`timeoutType` 已废弃，连显示时长都不可控）。
 *
 * 所以分工是：**通知负责「叫你一声」，任务列表负责「让你做完」。**
 * 这决定了本页第一屏必须回答两件事：
 * 1. 有几件事在等我？（顶部告警条 + 分组胶囊）
 * 2. 每件事我该做什么？（行主操作随状态变，规则见 `shared/taskView.ts`）
 *
 * ## 与「进度表」的区别
 *
 * - 排序主轴是**分组**（需要处理 → 进行中 → 已完成），不是状态字符串的字母序
 * - 每行有**语义化的主操作**：跳过任务给「打开视频页」，外部视频给「打开原始地址」，
 *   失败给「重试」；而不是所有人共用一对「重试 / 移除」
 * - 「重试」不再对 `skipped` 可用：重试会重新过 `checkDownloadLink`，命中后又是
 *   `skipped`——那是「点了没反应」的死循环。想下必须走「强制下载」（显式绕门）
 * - **打开后续地址 = 手动处理完**：页面开成功后这条待办自动从队列移除（判据见
 *   `shared/taskView.ts` 的 `followUpOpenSettles`）。通知点击走同一条规则，
 *   所以「打开视频页」不会在两个入口给出不同结果
 *
 * ## 契约（e2e 依赖，改前先看这一段）
 *
 * - `table.tasks tbody tr` 每行一条任务；首列 `td.mono` 是视频 ID
 * - `.pill-<status>` 状态胶囊（`running` / `queued` / `failed` / `complete` / `skipped` / `handed-off`）
 * - 操作列**最后一个按钮永远是「移除」**（其它用例用 `button:last-child` 点它）
 * - `.queue-filters button` 是分组筛选
 */
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { QueueTask } from '../../shared/task'
import { sortTasks, taskCounts, taskGroupOf, taskPrimaryActionOf, taskSecondaryActionOf, taskProgressOf, taskStatusKey, isClearable, type TaskGroup } from '../../shared/taskView'
import { send } from '../../messaging/hub'
import { Section, relativeTime } from '../widgets'

type FilterId = 'all' | TaskGroup

const FILTERS: Array<{ id: FilterId; labelKey: 'status.all' | 'tasks.groupAttention' | 'tasks.groupActive' | 'tasks.groupDone'; match: (task: QueueTask) => boolean }> = [
    { id: 'all', labelKey: 'status.all', match: () => true },
    { id: 'attention', labelKey: 'tasks.groupAttention', match: (task) => taskGroupOf(task) === 'attention' },
    { id: 'active', labelKey: 'tasks.groupActive', match: (task) => taskGroupOf(task) === 'active' },
    { id: 'done', labelKey: 'tasks.groupDone', match: (task) => taskGroupOf(task) === 'done' }
]

const KIND_LABEL: Record<QueueTask['kind'], string> = {
    browser: 'Browser',
    aria2: 'Aria2',
    iwaradl: 'iwaradl',
    others: 'Others'
}

interface QueueActionResult {
    /** CLEAR_FINISHED 返回的**条数**（与 REMOVE_TASK 的布尔值不同，见 `RemoveResult`） */
    removed?: number
    retried?: number
    /** FORCE_DOWNLOAD 返回任务本身；`status` 仍是 `skipped` 说明又被门拦下了 */
    status?: QueueTask['status']
}

/** SYNC_DOWNLOAD_TASKS 的返回：两个可追踪后端各自的对账计数 */
interface SyncResult {
    aria2: { adopted: number; stopped: number; rejected: number }
    iwaradl: { updated: number; settled: number }
}

/**
 * REMOVE_TASK 的返回。
 *
 * 单独建模而不是并进 `QueueActionResult`：那个里的 `removed` 是**条数**（清除已结束），
 * 这里是**这一条删没删**。共用字段时 `if (result.removed)` 恰好也能跑，
 * 但类型是假的——改一处文案就可能写出 `removed ?? 0` 这种把 `true` 当 1 的代码。
 */
interface RemoveResult {
    removed: boolean
    /** 删除前真的取消了下载器（下载中的任务才有） */
    cancelled?: boolean
    /** 这个通道没有取消能力（iwaradl 只允许删 pending / others 只是开了个标签页） */
    untracked?: boolean
}

/** 操作结果文案：`info` 用于「没做任何事」（如任务已不在了），不该报成绿色的成功 */
interface ActionMessage {
    message: string
    tone?: 'success' | 'info'
}

/**
 * 进行中的队列操作键。
 *
 * 用字符串模板字面量而不是 `string`：行内按钮的 key 是 `retry-<id>` / `force-<id>` 这类
 * 拼出来的值，批量操作是固定名。之前写 `string | null` 时任何拼写错误都能通过编译，
 * 而按钮文案不依赖这个值，错了也不会有任何可见异常——属于只有类型能挡的一类错。
 */
type BusyKey = 'clear-finished' | 'retry-failed' | 'sync-download' | `retry-${string}` | `remove-${string}` | `force-${string}` | `open-${string}`

export function TasksTab({ queue }: { queue: QueueTask[] }): ReactElement {
    const [filter, setFilter] = useState<FilterId>('all')
    const [busy, setBusy] = useState<BusyKey | null>(null)
    const [expandedError, setExpandedError] = useState<string | null>(null)
    /** 批量操作的二次确认目标（内联确认，不用 window.confirm：不阻塞、可测、样式统一） */
    const [confirming, setConfirming] = useState<'clear' | 'retry' | null>(null)
    /** 下载中任务的行内确认：移除会真的取消下载，不能一点就没了 */
    const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
    const { t: tr } = useTranslation()
    const now = Date.now()

    const counts = useMemo(() => taskCounts(queue), [queue])
    /** 「重试全部失败」只对 failed 生效；skipped 重试是死循环（见文件头注释） */
    const failedCount = useMemo(() => queue.filter((task) => task.status === 'failed').length, [queue])
    /** 「清除已结束」的判据与后台 `clearFinished` 同源（`isClearable`）；skipped 属于待办，要留着入口 */
    const clearableCount = useMemo(() => queue.filter(isClearable).length, [queue])

    const visible = useMemo(() => {
        const matcher = FILTERS.find((item) => item.id === filter)?.match ?? (() => true)
        return sortTasks(queue.filter(matcher))
    }, [queue, filter])

    /**
     * 执行队列操作：统一捕获后台错误并提示（后台是唯一写者）。
     *
     * 泛型而不是固定 `QueueActionResult`：各请求的返回形状本来就不同
     * （删除返回布尔、清除返回条数、强制下载返回任务本身）。用一个大而全的
     * 接口去套，会让 `removed` 在两种含义之间摇摆——那正是类型开始说谎的地方。
     *
     * `done` 必须如实反映结果：`REMOVE_TASK` 在任务已被清理时会返回
     * `removed: false`（双击、另一个标签页先删、后台内存副本不含该任务），
     * 这种情况不能再报「已移除」——那是谎报成功。
     */
    const run = async <T,>(key: BusyKey, action: () => Promise<T | null>, done: (result: T) => ActionMessage): Promise<void> => {
        setBusy(key)
        try {
            const result = await action()
            if (!result) return
            const { message, tone = 'success' } = done(result)
            if (tone === 'success') toast.success(message)
            else toast.info(message)
        } catch (error) {
            toast.error(tr('common.operationFailed', { message: error instanceof Error ? error.message : String(error) }), { duration: 6000 })
        } finally {
            setBusy(null)
        }
    }

    /**
     * 「打开后续地址」= 用户去手动处理这条待办（看简介里的网盘链接 / 去外部源）。
     *
     * 打开的这一刻待办就结束了：源项目那类提示是页内 toast，点掉即消失；
     * 我们的记录是持久的，留着它「需要处理」只会越滚越多，待办清单就退化成历史遗留。
     * 顺序不能反——**页面开成功了才删记录**，开不出来还要留着重试（不能把待办弄丢）。
     */
    const openFollowUp = (task: QueueTask, url: string): void => {
        void run(
            `open-${task.id}`,
            async () => {
                await browser.tabs.create({ url, active: true })
                return send<RemoveResult>({ type: 'REMOVE_TASK', payload: { taskId: task.id } })
            },
            (result) => (result.removed ? { message: tr('tasks.handledRemoved', { id: task.videoId }) } : { message: tr('tasks.notInQueue', { id: task.videoId }), tone: 'info' as const })
        )
    }

    const retryOne = (task: QueueTask): void => {
        void run(
            `retry-${task.id}`,
            () => send<QueueActionResult>({ type: 'RETRY_TASK', payload: { taskId: task.id } }),
            () => ({ message: tr('tasks.retried', { id: task.videoId }) })
        )
    }

    /**
     * 强制下载：显式绕开「简介里有第三方网盘链接就不下载」那道门。
     *
     * 源项目里这个能力是隐式的（视频详情页点下载 → 页型是 Video → 门自己不生效）；
     * 扩展的任务列表不在页面上、拿不到页型，所以必须有 `FORCE_DOWNLOAD`。
     * 返回的 `status` 仍是 `skipped` 说明后台又拦了一次，这时不能报成功。
     */
    const forceOne = (task: QueueTask): void => {
        void run(
            `force-${task.id}`,
            () => send<QueueTask>({ type: 'FORCE_DOWNLOAD', payload: { videoId: task.videoId } }),
            (result) => (result.status === 'skipped' ? { message: tr('tasks.skippedDetail'), tone: 'info' } : { message: tr('tasks.forced', { id: task.videoId }) })
        )
    }

    /**
     * 移除。对下载中的任务，第一次点击先把按钮换成确认态。
     *
     * 之所以需要确认：后台会先调下载器的 cancel/remove 真的停下它——这是不可撤销的。
     * 其它状态（失败/已完成/跳过）删掉只是擦一行记录，一点即删。
     */
    const removeOne = (task: QueueTask): void => {
        if (task.status === 'running' && confirmingRemove !== task.id) {
            setConfirmingRemove(task.id)
            return
        }
        setConfirmingRemove(null)
        void run(
            `remove-${task.id}`,
            () => send<RemoveResult>({ type: 'REMOVE_TASK', payload: { taskId: task.id } }),
            (result) => {
                if (!result.removed) return { message: tr('tasks.notInQueue', { id: task.videoId }), tone: 'info' as const }
                // `untracked` = 记录删掉了，但那个后端不听我们的（iwaradl 运行中 / others）。
                // 报成「已取消」是撒谎，用户会以为文件不会再来。
                if (result.untracked) return { message: tr('tasks.removedUntracked', { id: task.videoId }), tone: 'info' as const }
                return { message: result.cancelled ? tr('tasks.cancelled', { id: task.videoId }) : tr('tasks.removed', { id: task.videoId }) }
            }
        )
    }

    /** 行主操作分发：做什么由 `taskPrimaryActionOf` 决定，这里只负责执行 */
    const runPrimary = (task: QueueTask): void => {
        const action = taskPrimaryActionOf(task)
        switch (action.kind) {
            case 'open':
                openFollowUp(task, action.url)
                return
            case 'retry':
                retryOne(task)
                return
            case 'force-download':
                forceOne(task)
                return
        }
    }

    /** 行次操作分发：私有视频除了「去加好友」，旁边还得留一颗「重试」 */
    const runSecondary = (task: QueueTask): void => {
        const action = taskSecondaryActionOf(task)
        if (action === null) return
        switch (action.kind) {
            case 'force-download':
                forceOne(task)
                return
            case 'retry':
                retryOne(task)
                return
        }
    }

    const clearFinished = (): void => {
        if (clearableCount === 0) return
        if (confirming !== 'clear') {
            setConfirming('clear')
            return
        }
        setConfirming(null)
        void run(
            'clear-finished',
            () => send<QueueActionResult>({ type: 'CLEAR_FINISHED', payload: {} }),
            (result) => ({ message: tr('tasks.cleared', { n: result.removed ?? 0 }) })
        )
    }

    const retryFailed = (): void => {
        if (failedCount === 0) return
        if (confirming !== 'retry') {
            setConfirming('retry')
            return
        }
        setConfirming(null)
        void run(
            'retry-failed',
            () => send<QueueActionResult>({ type: 'RETRY_FAILED', payload: {} }),
            (result) => ({ message: tr('tasks.retryFailedDone', { n: result.retried ?? 0 }) })
        )
    }

    return (
        <Section title={tr('tasks.title')}>
            {queue.length === 0 ? (
                <p className="note">{tr('tasks.empty')}</p>
            ) : (
                <>
                    {/* 通知叫不住的人，打开这一页要先看见「有事等你」 */}
                    {counts.attention > 0 ? (
                        <div className="queue-alert" role="status">
                            <span>{tr('tasks.attentionBanner', { n: counts.attention })}</span>
                            {filter !== 'attention' ? (
                                <button type="button" className="ghost" onClick={() => setFilter('attention')}>
                                    {tr('tasks.groupAttention')}
                                </button>
                            ) : null}
                        </div>
                    ) : null}

                    <div className="queue-toolbar">
                        <div className="queue-filters" role="tablist" aria-label={tr('tasks.filterLabel')}>
                            {FILTERS.map((item) => (
                                <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? 'active' : 'ghost'} onClick={() => setFilter(item.id)}>
                                    {tr(item.labelKey)}
                                    <span className="queue-count">{item.id === 'all' ? counts.total : counts[item.id]}</span>
                                </button>
                            ))}
                        </div>
                        <div className="queue-actions">
                            <button
                                type="button"
                                className="ghost"
                                disabled={busy !== null}
                                onClick={() => {
                                    // 与后端对账：aria2 的 WS 通知会丢、iwaradl 只能拉，
                                    // 点了就不等 alarm（5 min / 1 min）
                                    void run(
                                        'sync-download',
                                        () => send<SyncResult>({ type: 'SYNC_DOWNLOAD_TASKS', payload: {} }),
                                        () => ({ message: tr('tasks.synced'), tone: 'info' as const })
                                    )
                                }}
                            >
                                {busy === 'sync-download' ? tr('tasks.syncing') : tr('tasks.syncNow')}
                            </button>
                            <button type="button" className={confirming === 'retry' ? 'danger' : undefined} disabled={busy !== null || failedCount === 0} onClick={retryFailed}>
                                {confirming === 'retry' ? tr('tasks.retryFailedConfirm', { n: failedCount }) : tr('tasks.retryFailed')}
                            </button>
                            <button type="button" className={confirming === 'clear' ? 'danger' : 'ghost'} disabled={busy !== null || clearableCount === 0} onClick={clearFinished}>
                                {confirming === 'clear' ? tr('tasks.clearFinishedConfirm', { n: clearableCount }) : tr('tasks.clearFinished')}
                            </button>
                        </div>
                    </div>

                    {visible.length === 0 ? (
                        <p className="note">{tr('tasks.emptyFiltered')}</p>
                    ) : (
                        <table className="tasks">
                            <thead>
                                <tr>
                                    <th>{tr('tasks.colVideo')}</th>
                                    <th>{tr('tasks.colStatus')}</th>
                                    <th>{tr('tasks.colDetail')}</th>
                                    <th>{tr('tasks.colActions')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visible.map((task) => {
                                    const group = taskGroupOf(task)
                                    const primary = taskPrimaryActionOf(task)
                                    const secondary = taskSecondaryActionOf(task)
                                    const progress = taskProgressOf(task)
                                    const reason = task.status === 'failed' || task.status === 'skipped' || task.status === 'handed-off' ? task.detail : undefined
                                    const expanded = expandedError === task.id
                                    return (
                                        <tr key={task.id} className={`status-${task.status} group-${group}`}>
                                            <td className="mono">
                                                <div className="task-video">{task.videoId}</div>
                                                <div className="dim task-meta">{KIND_LABEL[task.kind] ?? task.kind}</div>
                                            </td>
                                            <td className="nowrap">
                                                <span className={`pill pill-${task.status}`}>{tr(`status.${taskStatusKey(task)}`)}</span>
                                                {progress === undefined ? null : <span className="task-progress"> · {Math.round(progress * 100)}%</span>}
                                                {task.attempts ? <span className="dim"> · {tr('tasks.attempts', { n: task.attempts })}</span> : null}
                                                <div className="dim task-meta">{relativeTime(task.updatedAt ?? task.createdAt, now)}</div>
                                            </td>
                                            <td>
                                                {task.filename ? <div className="mono filename">{task.filename}</div> : null}
                                                {task.kindRef ? <div className="mono dim">ref: {task.kindRef}</div> : null}
                                                {task.status === 'skipped' ? <div className="dim task-meta">{tr('tasks.skippedHint')}</div> : null}
                                                {reason ? (
                                                    task.status === 'skipped' ? (
                                                        <div className="error-text warn-text">{reason}</div>
                                                    ) : task.status === 'handed-off' ? (
                                                        // 已交付但不是「完成」：写清交给谁了，用户才不会以为文件已经在本地
                                                        <div className="dim task-meta">{reason}</div>
                                                    ) : (
                                                        <div className={expanded ? 'error-text' : 'error-text clamped'} title={reason} onClick={() => setExpandedError(expanded ? null : task.id)}>
                                                            {reason}
                                                        </div>
                                                    )
                                                ) : null}
                                            </td>
                                            <td className="nowrap">
                                                <button type="button" className="ghost" disabled={busy !== null || task.status === 'running'} title={task.status === 'running' ? tr('tasks.runningCannotAct') : undefined} onClick={() => runPrimary(task)}>
                                                    {tr(primary.labelKey)}
                                                </button>
                                                {secondary ? (
                                                    <button type="button" className="ghost" disabled={busy !== null} onClick={() => runSecondary(task)}>
                                                        {tr(secondary.labelKey)}
                                                    </button>
                                                ) : null}
                                                {/* 下载中也能移除：后台先取消下载器再删记录（见 background/download/cancel.ts） */}
                                                <button type="button" className={confirmingRemove === task.id ? 'danger' : 'ghost danger'} disabled={busy !== null} title={task.status === 'running' ? tr('tasks.runningCancelHint') : undefined} onClick={() => removeOne(task)}>
                                                    {confirmingRemove === task.id ? tr('tasks.cancelConfirm') : tr('common.remove')}
                                                </button>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    )}
                </>
            )}
            <div className="perm-row">
                <span className="note">{tr('tasks.footer')}</span>
            </div>
        </Section>
    )
}

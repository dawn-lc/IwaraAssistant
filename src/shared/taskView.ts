/**
 * 任务列表的**视图模型** —— 把内部状态机翻译成「用户视角的待办」。
 *
 * ## 为什么需要这一层
 *
 * 源项目里，很多交互点靠页内 toast 承担：自定义按钮（「打开视频链接」「重新解析」）、
 * 富文本、hover 暂停、常驻直到点掉。系统通知做不到这些（Chrome 桌面版不渲染 `buttons`，
 * Firefox 根本不支持；`timeoutType` 已废弃所以连显示时长都不可控）。
 *
 * 结论：**通知只负责「叫你一声」，真正的交互入口搬到任务列表**。
 * 那就要求任务列表不是「下载进度表」，而是「待办收件箱」：
 * 每条任务都要能回答「**它为什么在这儿**」和「**轮到我做什么**」。
 *
 * 这个文件把这两个问题做成纯函数，因为它决定的东西很容易写错又很难发现：
 * 判错「该重试」会让用户点一下什么都没发生（`skipped` 重试会被同一道门再拦一次），
 * 判错「该跳转」会把用户送到错误页面。都不报错，只是行为不对。
 *
 * ## 分组语义
 *
 * - `attention`（失败 / 刻意跳过）：**等用户决策**。这是通知的落点。
 * - `active`（排队 / 下载中）：不用管，看进度就行。
 * - `done`（完成 / 已交付）：历史。
 *
 * `skipped` 刻意**不**归入 `done`：它不是「结束」，是「悬而未决」——
 * 用户可能一辈子不处理它，但它始终是「你还有个视频没下」的记录。
 * 也刻意**不**归入 `active`：它不占角标、不占下载槽位、不阻止重新投递。
 *
 * `handed-off` 则**归入 `done`**：活已经交出去了（iwaradl / 外部下载器），
 * 扩展这边没有任何待办；它只是「我交出过什么」的记录，随时可以清掉。
 */
import type { QueueTask } from './task'

/** 用户视角的分组（与 `QueueTask['status']` 是不同维度的东西） */
export type TaskGroup = 'attention' | 'active' | 'done'

/** 分组判定：唯一真源，UI 筛选、排序、计数、告警条全部走它 */
export function taskGroupOf(task: Pick<QueueTask, 'status'>): TaskGroup {
    switch (task.status) {
        case 'failed':
        case 'skipped':
            return 'attention'
        case 'running':
        case 'queued':
            return 'active'
        case 'complete':
        case 'handed-off':
            return 'done'
    }
}

/**
 * 行主操作 —— 「这条任务现在最该做的一件事」。
 *
 * 判别联合而不是 `{ label, run }`：动作的**语义**（打开哪、要不要二次确认）必须能被
 * 测试与 UI 同时理解，闭包一旦塞进来就只剩 UI 自己能懂，也就没法给它写断言了。
 */
export type TaskPrimaryAction =
    /** 打开一个外部地址（视频页 / 外部嵌入源） */
    | { kind: 'open'; url: string; labelKey: 'tasks.actionOpenVideo' | 'tasks.actionOpenSource' }
    /** 重新提交（完成过的想再下一次、失败过的想再试） */
    | { kind: 'retry'; labelKey: 'common.retry' }
    /** 绕过第三方链接检查直接下载（`skipped` 唯一可行的前进方式） */
    | { kind: 'force-download'; labelKey: 'tasks.actionForceDownload' }

/** 与主操作并列的次操作（目前只有 `skipped` 用得上） */
export type TaskSecondaryAction = { kind: 'force-download'; labelKey: 'tasks.actionForceDownload' }

/**
 * 主操作。
 *
 * 三条不那么直观的规则，每条都对应一个真实踩坑：
 *
 * 1. **`skipped` 的主操作是「打开视频页」而不是「重试」**：
 *    重试会重新解析并再过一次 `checkDownloadLink`，命中后又是 `skipped`——
 *    用户看到的是「点了没反应」的死循环。想下就必须显式「强制下载」。
 * 2. **`failed` 带 `followUpUrl` 时主操作是「打开原始地址」**：
 *    那是外部嵌入视频（iwara 不托管），重试一百次也不会成功，链接是唯一有用的信息。
 * 3. **`running` / `queued` 也返回 `retry`**（由 UI 置灰）：
 *    让每行的按钮形状稳定（主操作槽位永远存在），否则行与行之间按钮错位，
 *    键盘焦点与屏幕阅读器顺序都会跳。
 */
export function taskPrimaryActionOf(task: QueueTask): TaskPrimaryAction {
    switch (task.status) {
        case 'skipped': {
            const url = task.followUpUrl
            // 没有跳转目标（脏数据）时退化为「强制下载」——它至少还能让用户把视频下下来
            return url !== undefined && url !== '' ? { kind: 'open', url, labelKey: 'tasks.actionOpenVideo' } : { kind: 'force-download', labelKey: 'tasks.actionForceDownload' }
        }
        case 'failed':
            if (task.followUpUrl !== undefined && task.followUpUrl !== '') return { kind: 'open', url: task.followUpUrl, labelKey: 'tasks.actionOpenSource' }
            return { kind: 'retry', labelKey: 'common.retry' }
        // `handed-off` 也给重试：想再交一次（比如外部下载器其实没接住）
        case 'running':
        case 'queued':
        case 'complete':
        case 'handed-off':
            return { kind: 'retry', labelKey: 'common.retry' }
    }
}

/** 次操作：只有「已经能打开视频页的跳过任务」才额外给一个强制下载入口 */
export function taskSecondaryActionOf(task: QueueTask): TaskSecondaryAction | null {
    if (task.status !== 'skipped') return null
    if (task.followUpUrl === undefined || task.followUpUrl === '') return null
    return { kind: 'force-download', labelKey: 'tasks.actionForceDownload' }
}

/** 分组排序权重：待办永远在最上面（通知没叫住的人，打开任务页第一眼要能看见） */
function groupRank(group: TaskGroup): number {
    switch (group) {
        case 'attention':
            return 0
        case 'active':
            return 1
        case 'done':
            return 2
    }
}

/** 同组内「最近更新优先」；没有时间戳的旧记录排后面 */
export function sortTasks(tasks: readonly QueueTask[]): QueueTask[] {
    return [...tasks].sort((a, b) => {
        const byGroup = groupRank(taskGroupOf(a)) - groupRank(taskGroupOf(b))
        if (byGroup !== 0) return byGroup
        const aTime = a.updatedAt ?? a.createdAt ?? 0
        const bTime = b.updatedAt ?? b.createdAt ?? 0
        return bTime - aTime
    })
}

export interface TaskCounts {
    attention: number
    active: number
    done: number
    total: number
}

/**
 * 「清除已结束」能清哪些 —— 后台的 `clearFinished` 与任务页按钮可用性共用这一条判据。
 *
 * 与分组**故意不完全一致**：`failed` 属于 `attention`（要用户处理），但它也是
 * 已经结束的一次尝试，用户有权一次性清掉那些不想再管的失败记录。
 * 真正不能清的是 `skipped`（唯一的待办入口）与 `active`（还在跑）。
 */
export function isClearable(task: Pick<QueueTask, 'status'>): boolean {
    switch (task.status) {
        case 'complete':
        case 'failed':
        case 'handed-off':
            return true
        case 'running':
        case 'queued':
        case 'skipped':
            return false
    }
}

/**
 * 界面该显示的进度（未知时 `undefined`）。
 *
 * 三条规则：
 * 1. 只在**进行中**（`running` / `queued`）显示：已完成/已失败显示一个百分比毫无意义，
 *    还会和状态胶囊抢注意力。
 * 2. 脏值不外溢：后端可能给出 1.2 或 NaN，一律夹到 0~1。
 * 3. `undefined` 就是「不知道」——不要回退成 0，那会让界面声称「刚开始」而实际快下完了。
 */
export function taskProgressOf(task: Pick<QueueTask, 'status' | 'progress'>): number | undefined {
    if (task.status !== 'running' && task.status !== 'queued') return undefined
    const value = task.progress
    if (value === undefined || !Number.isFinite(value)) return undefined
    return Math.min(1, Math.max(0, value))
}

/** 各分组计数（胶囊、标题、批量按钮的可用性都读它） */
export function taskCounts(tasks: readonly QueueTask[]): TaskCounts {
    const counts: TaskCounts = { attention: 0, active: 0, done: 0, total: tasks.length }
    for (const task of tasks) counts[taskGroupOf(task)]++
    return counts
}

/** 行状态文案的 i18n 键后缀（每个状态 × 通道都有专属键，绝不落到 default 显示原始英文） */
export function taskStatusKey(task: Pick<QueueTask, 'status' | 'kind'>): 'running' | 'runningAria2' | 'runningIwaradl' | 'queuedAria2' | 'queuedIwaradl' | 'queued' | 'complete' | 'failed' | 'skipped' | 'handedOff' {
    switch (task.status) {
        case 'running':
            if (task.kind === 'aria2') return 'runningAria2'
            if (task.kind === 'iwaradl') return 'runningIwaradl'
            return 'running'
        case 'queued':
            if (task.kind === 'aria2') return 'queuedAria2'
            if (task.kind === 'iwaradl') return 'queuedIwaradl'
            return 'queued'
        case 'complete':
            return 'complete'
        case 'failed':
            return 'failed'
        case 'skipped':
            return 'skipped'
        case 'handed-off':
            return 'handedOff'
    }
}

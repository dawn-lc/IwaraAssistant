/**
 * 好友审批的进度模型。
 *
 * ## 为什么不是「后台定期把进度写盘、前端轮询」
 *
 * 关键观察：**任务和它的运行状态死在同一个进程里**。
 * Chrome 的 service worker 被回收时，正在跑的审批连同它的模块级变量一起消失；
 * Firefox 的持久后台页只有在扩展重载/更新时才会重建，那时任务也一起没了。
 * 所以「任务还活着吗」的答案，唯一正确的来源就是**内存里那个任务对象本身**。
 *
 * 一旦把 `running: true` 写进持久层，两者的生命周期就解耦了：
 * 进程被杀 → 存储里永远留着 `running: true` → 界面永远转圈、按钮永远禁用，
 * 只能手动清存储才能恢复。这不是「概率很低」，而是**每次崩溃/重载都会发生**。
 *
 * 因此本模块的约定是：
 *   1. `running` **只来自内存**（`background/iwara/friendApprove.ts` 的 `liveTask`）；
 *   2. 持久层只负责「把内存里的快照送到别的上下文」以及「留下终态结果」；
 *   3. 读到 `running: true` 而内存里没有任务 → 一定是上一个进程的残骸，
 *      由 `settleInterrupted()` 判定为中断（**靠不变量判定，不靠心跳超时**）。
 *
 * 为什么不用心跳 + 超时：`collecting` 阶段会递归拉主页/论坛帖的全部评论与嵌套回复，
 * 期间没有任何进度变化，可能持续几分钟。用「N 秒没更新就算死」必然误杀真在跑的任务；
 * 而把心跳间隔压到能容忍的粒度，又等于把轮询成本还给了后台。
 *
 * ## 为什么是 `storage.session` 而不是 `storage.local`
 *
 * 进度是**会话级易失数据**，不该落盘。`storage.session` 是内存态、跨上下文可读、
 * 浏览器退出即清空——语义正好，且不产生磁盘写入。终态结果（`result`）一并留在会话里，
 * 符合「昨天那次的逐条结果没人会再看」这个事实。
 */

export type FriendApprovePhase = 'idle' | 'collecting' | 'deciding'

/** 一次审批的最终结果（同时经消息通道返回给调用方） */
export interface FriendApproveResult {
    /** 收到的请求总数 */
    total: number
    /** 批准成功数 */
    approved: number
    /** 批准失败数 */
    failed: number
    /** 条件不满足而跳过数 */
    skipped: number
    /** 人类可读的逐条结果（上限 100 条，避免消息/存储过大） */
    lines: string[]
    /** 请求多到超过分页上限，本次只处理了一部分 */
    truncated?: boolean
    /** 未登录 / 未选条件等致命原因 */
    error?: string
}

export interface FriendApproveProgress {
    /**
     * 是否正在跑。**只有内存里的任务能给出 true**：持久层里的 true 是残骸
     * （见文件头部说明），读取方一律经 `settleInterrupted()` 归一。
     */
    running: boolean
    /**
     * `collecting`：拉请求列表 + 评论证据（总量未知 → 进度条不确定态）
     * `deciding`：逐条判定与批准（total 已知 → 进度条确定态）
     */
    phase: FriendApprovePhase
    /** 已处理条数（仅 deciding 阶段有意义） */
    done: number
    /** 待处理总条数（拉完列表后才有值） */
    total: number
    approved: number
    skipped: number
    failed: number
    startedAt: number
    /** 结束时间（0 表示还没结束过） */
    finishedAt: number
    /** 上一次运行被中断（进程被杀 / 扩展重载），结果未知 */
    aborted?: boolean
    /** 终态结果；运行中为 undefined */
    result?: FriendApproveResult
    updatedAt: number
}

export const IDLE_FRIEND_APPROVE_PROGRESS: FriendApproveProgress = {
    running: false,
    phase: 'idle',
    done: 0,
    total: 0,
    approved: 0,
    skipped: 0,
    failed: 0,
    startedAt: 0,
    finishedAt: 0,
    updatedAt: 0
}

/**
 * 把「持久层说在跑、内存里却没任务」的记录归一为「已中断」。
 *
 * 返回 `null` 表示无需改写（要么本来没在跑，要么任务确实还活着）。
 * 纯函数：不改入参，调用方负责回写。
 */
export function settleInterrupted(record: FriendApproveProgress | null, taskAlive: boolean): FriendApproveProgress | null {
    if (!record || taskAlive || !record.running) return null
    return {
        ...record,
        running: false,
        // 保留 phase，界面据此说明「停在哪个阶段」；`running: false` 已足够让进度条消失
        aborted: true,
        // 用最后一次写入时间当作中断时间：那是我们能确定的最后活着的时刻
        finishedAt: record.updatedAt || Date.now()
    }
}

/**
 * 进度条的完成比例（0~1）；`undefined` = 不确定态。
 *
 * 三个返回 `undefined` 的场景各不相同，但都**不能**当成 0%：
 * - 没在跑：不该显示进度条（调用方据此隐藏）；
 * - `collecting`：评论证据的请求数无法预知，画一个百分比就是编造；
 * - `total` 为 0：列表还没拉回来。
 */
export function friendApproveRatio(progress: FriendApproveProgress | null | undefined): number | undefined {
    if (!progress || !progress.running) return undefined
    if (progress.phase !== 'deciding' || progress.total <= 0) return undefined
    return Math.min(1, Math.max(0, progress.done / progress.total))
}

/** 界面需要的一次性派生结果（纯函数，便于逐分支单测） */
export interface FriendApproveView {
    /** 是否显示「审批中」徽章 / 禁用按钮 / 进度条 */
    running: boolean
    /** 上一次运行被中断（有记录但没有结果） */
    aborted: boolean
    /** 进度条比例；`undefined` = 不确定态 */
    ratio: number | undefined
    /** 终态结果；运行中为 undefined（避免旧结果与新进度同时出现） */
    result?: FriendApproveResult
}

/**
 * 把快照归一成界面需要的形状。
 *
 * 抽成纯函数的理由：这些分支（运行中不显示旧结果、中断记录不显示结果、
 * `collecting` 不给百分比）以前只能靠「在浏览器里注入 storage」来验证，
 * 而现在 `running` 无法被伪造（它只来自后台内存），那条路走不通了。
 */
export function friendApproveView(snapshot: FriendApproveProgress | null | undefined): FriendApproveView {
    const running = snapshot?.running === true
    return {
        running,
        aborted: !running && snapshot?.aborted === true,
        ratio: friendApproveRatio(snapshot),
        result: running ? undefined : snapshot?.result
    }
}

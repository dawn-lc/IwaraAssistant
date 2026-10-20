/**
 * 两个守护进程后端的**容量与进度判据**（纯函数，可单测）。
 *
 * ## 为什么这里要知道后端的并发上限
 *
 * 浏览器通道的并发由我们控制（`browserConcurrentDownloads`），aria2 / iwaradl 却各自管自己的：
 * aria2 有 `max-concurrent-downloads`，超出后任务在它内部是 `waiting` 而不是 `active`。
 * 不读这个值就只有两种坏结果：把 `waiting` 当成「正在下载」（界面骗人），
 * 或者把我们的上限套到它们身上（两边打架）。
 *
 * iwaradl 没有配置类接口（`GET /api/tasks` 只给任务），所以它的「容量」只能从任务列表统计：
 * 有几条 `running`、几条在 `pending` 排队。
 */
import type { IwaradlStatus } from './iwaradlTask'

/** aria2 `getGlobalStat` 的可用部分 */
export interface Aria2GlobalStat {
    /** 正在下载（`active`） */
    active: number
    /** 在 aria2 自己队列里等待（`waiting`）——**不是**正在下载 */
    waiting: number
    /** 已停止的条目数（aria2 的 stopped 区，受 `--max-download-result` 限制） */
    stopped: number
    /** 全局下载速度（字节/秒） */
    downloadSpeed: number
}

/** aria2 `getGlobalOption` 里我们关心的那一项 */
export interface Aria2Limits {
    /** `max-concurrent-downloads`；aria2 默认 5 */
    maxConcurrent?: number
}

export interface Aria2Stats extends Aria2GlobalStat, Aria2Limits {}

/** 非负整数（RPC 返回的是字符串；脏值一律当 0，不要感染成 NaN） */
function count(value: unknown): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) return 0
    return Math.trunc(parsed)
}

/**
 * 解析 `aria2.getGlobalStat`。
 *
 * 返回 `undefined` 表示**响应形状不对**（对端不是 aria2 / 版本差异），
 * 与「全是 0」是两件事：前者应该提示端点配错，后者是空闲。
 */
export function parseAria2GlobalStat(raw: unknown): Aria2GlobalStat | undefined {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const record = raw as Record<string, unknown>
    if (!('numActive' in record) && !('numWaiting' in record)) return undefined
    return {
        active: count(record['numActive']),
        waiting: count(record['numWaiting']),
        stopped: count(record['numStopped']),
        downloadSpeed: count(record['downloadSpeed'])
    }
}

/**
 * 解析 `aria2.getGlobalOption` 的 `max-concurrent-downloads`。
 *
 * 取不到或值非法时返回 `undefined`——界面据此显示「未知」，
 * 而不是编一个默认值冒充用户的配置。
 */
export function parseAria2MaxConcurrent(raw: unknown): number | undefined {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const value = (raw as Record<string, unknown>)['max-concurrent-downloads']
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return Math.trunc(parsed)
}

/** iwaradl 任务列表的分布（它没有容量接口，只能从任务本身统计） */
export interface IwaradlStats {
    running: number
    pending: number
    completed: number
    failed: number
}

/**
 * 统计 iwaradl 任务列表。
 *
 * 只认四种已知状态（`parseIwaradlTasks` 已经把未知状态丢掉了），
 * 所以这里不需要 default 分支——多出来的值只可能来自有人改了模型，
 * 那种情况应该在解析层就挡掉（见 `test/iwaradlTask.test.ts`）。
 */
export function summarizeIwaradl(tasks: readonly { status: IwaradlStatus }[]): IwaradlStats {
    const stats: IwaradlStats = { running: 0, pending: 0, completed: 0, failed: 0 }
    for (const task of tasks) stats[task.status]++
    return stats
}

/**
 * 队列里的任务是否「后端仍在排队」而不是「正在传」。
 *
 * aria2 的 `waiting` 与 iwaradl 的 `pending` 都表示**还没开始下**。
 * UI 与取消策略都要按这个区分：把排队中的任务当成下载中，用户会以为带宽被占着。
 */
export function isBackendQueuedStatus(status: string): boolean {
    return status === 'waiting' || status === 'paused' || status === 'pending'
}

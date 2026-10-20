/**
 * 浏览器内建下载的「同时下载数」——纯判据（可单测），执行端在
 * `background/download/browserQueue.ts`。
 *
 * ## 为什么只有浏览器通道需要这个
 *
 * `downloads.download()` 一返回，**传输就在浏览器里继续跑了**，我们说什么它就同时下几个：
 * 批量投递只是每 3 秒发起一个，并不等上一个下完 → 勾 20 个视频就是 20 条并发传输打向同一个 CDN。
 * aria2 / iwaradl 各自的并发由守护进程自己控制（`max-concurrent-downloads` 等），
 * 扩展这边插手只会打架。
 *
 * ## 语义
 *
 * 槽位满时新任务**不丢、不失败**，而是落成 `queued` 排队，等前一个下载进入终态
 * （`downloads.onChanged`）后自动启动。用户看到的是「排队中」，不是「点了没反应」。
 */
import type { QueueTask } from './task'

export const BROWSER_CONCURRENCY_MIN = 1
/** 上限取 10：每条并发都是对站点 CDN 的一条连接，再往上更容易触发限流 */
export const BROWSER_CONCURRENCY_MAX = 10
export const BROWSER_CONCURRENCY_DEFAULT = 3

/** 配置值 → 实际可用槽位数（脏值不外溢：夹到 [MIN, MAX] 并取整） */
export function browserConcurrencyLimit(raw: number): number {
    if (!Number.isFinite(raw)) return BROWSER_CONCURRENCY_DEFAULT
    return Math.min(BROWSER_CONCURRENCY_MAX, Math.max(BROWSER_CONCURRENCY_MIN, Math.trunc(raw)))
}

/**
 * 还有空槽吗。
 *
 * @param active   队列里正在传的浏览器下载数（`kind === 'browser' && status === 'running'`）
 * @param starting 已占槽但还没出现在队列里的启动中任务数
 */
export function slotAvailable(active: number, starting: number, limit: number): boolean {
    return active + starting < browserConcurrencyLimit(limit)
}

/**
 * 下一个该启动的排队任务：只认 `browser` + `queued`，按入队时间先进先出。
 *
 * 没有 `createdAt` 的旧记录视为「最晚」——不能因为缺字段就让它插队到真正在等的人前面。
 */
export function nextQueuedBrowserTask(tasks: readonly QueueTask[]): QueueTask | undefined {
    let best: QueueTask | undefined
    let bestAt = Number.POSITIVE_INFINITY
    for (const task of tasks) {
        if (task.kind !== 'browser' || task.status !== 'queued') continue
        const at = task.createdAt ?? Number.POSITIVE_INFINITY
        if (best === undefined || at < bestAt) {
            best = task
            bestAt = at
        }
    }
    return best
}

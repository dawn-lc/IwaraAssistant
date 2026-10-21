/**
 * 「下载完成后推送到 MediaCenter」的待重试队列（纯判据，可单测）。
 *
 * ## 为什么需要它
 *
 * 源项目（`features/aria2Track.ts` 的 `case 'complete'`）在推送失败时**不放弃**：
 * 把 `pushFailedAt` 写回追踪队列，worker 继续活着，每 5 分钟重试一次，直到成功才出队。
 * 本扩展原先只是 `void pushVideoIdToMediaCenter(...)`——失败就一条 console 警告，
 * 用户的下载完成后如果 MediaCenter 恰好重启/网络抖动，这次推送就**永久丢失**，
 * 而界面上没有任何痕迹（任务已经是 complete，用户不会再看它）。
 *
 * ## 参数取自源实现
 *
 * - 重试间隔：`ARIA2_TRACK_PUSH_RETRY_INTERVAL = 5 * 60 * 1000`
 * - 终态：只有推送成功（或本就不需要推送）才把条目删掉
 *
 * ## 与源实现的一处有意差异
 *
 * 源项目的重试次数**无上限**（worker 只要活着就每 5 分钟试一次，直到用户关页面）。
 * 这里加 `MAX_PUSH_ATTEMPTS`：后台没有「页面」这个天然的生命周期终点，无上限意味着
 * 一个填错的 API Key 会让扩展永远每 5 分钟打一次端点，且每次写一遍持久层。
 * 24 次 ≈ 2 小时，足够覆盖重启/升级/短暂断网，超过就丢弃并留日志。
 */

/** 重试间隔（毫秒）——源 `ARIA2_TRACK_PUSH_RETRY_INTERVAL` */
export const PUSH_RETRY_INTERVAL_MS = 5 * 60 * 1000

/** 重试次数上限（源无上限，见文件头） */
export const MAX_PUSH_ATTEMPTS = 24

/** 一条待推送记录（键是 videoId） */
export interface PendingMediaCenterPush {
    videoId: string
    /** 完成后才知道的落盘文件名，推送时作为 `fallbackPath` */
    filename?: string
    /** 上次尝试时间（毫秒）；首次登记时是「已尝试过一次」的时刻 */
    lastAttemptAt: number
    /** 已尝试次数 */
    attempts: number
}

/** 待推送表：videoId → 记录 */
export type PendingPushTable = Record<string, PendingMediaCenterPush>

/**
 * 这条记录现在该不该重试：跨过间隔才试（首次登记时调用方已经试过一次）。
 *
 * 时间戳是脏值时不再重试——按「该丢弃」处理，否则一个写坏的时间戳会让任务永远
 * 卡在待推送表里。
 */
export function shouldRetryPush(entry: PendingMediaCenterPush, now: number): boolean {
    if (isPushExhausted(entry)) return false
    if (!Number.isFinite(entry.lastAttemptAt)) return false
    return now - entry.lastAttemptAt >= PUSH_RETRY_INTERVAL_MS
}

/** 重试次数已用尽（调用方应丢弃这条记录，而不是继续每 5 分钟打一次端点） */
export function isPushExhausted(entry: PendingMediaCenterPush): boolean {
    return !Number.isFinite(entry.attempts) || entry.attempts >= MAX_PUSH_ATTEMPTS
}

/** 登记/更新一条待推送记录（attempts 累加，时间戳刷新） */
export function nextPendingPush(previous: PendingMediaCenterPush | undefined, videoId: string, filename: string | undefined, now: number): PendingMediaCenterPush {
    return {
        videoId,
        ...(filename === undefined ? {} : { filename }),
        lastAttemptAt: now,
        attempts: (previous?.attempts ?? 0) + 1
    }
}

/**
 * 从存储里读出的任意值 → 可用的待推送表。
 *
 * 脏值逐条丢弃（与 `parseScanMemory` 同一原则）：一条记录写坏不该让整个重试机制停摆。
 */
export function parsePendingPushes(raw: unknown): PendingPushTable {
    const result: PendingPushTable = {}
    if (!raw || typeof raw !== 'object') return result
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const entry = value as Partial<PendingMediaCenterPush>
        if (typeof entry.videoId !== 'string' || entry.videoId === '') continue
        if (typeof entry.lastAttemptAt !== 'number' || !Number.isFinite(entry.lastAttemptAt)) continue
        if (typeof entry.attempts !== 'number' || !Number.isFinite(entry.attempts)) continue
        result[key] = {
            videoId: entry.videoId,
            ...(typeof entry.filename === 'string' ? { filename: entry.filename } : {}),
            lastAttemptAt: entry.lastAttemptAt,
            attempts: entry.attempts
        }
    }
    return result
}

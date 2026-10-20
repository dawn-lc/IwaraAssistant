/**
 * aria2 任务恢复的**判定规则**（纯函数，无 browser / 无 RPC，可单测）。
 *
 * 移植自源 `features/aria2Track.ts` 的一组判据。抽成纯函数的原因：这些规则决定
 * 「要不要动用户的下载任务」——尤其是「重启」和「换地址」都会打断正在跑的下载，
 * 判错一次就是白丢带宽；而调用点（WS 通知 / 5 分钟扫描）都不便单测。
 *
 * ## 与源实现的架构差异（不是简化，是通道不同）
 *
 * 源项目在页面里跑**每任务一个 worker**，`active` 时 4 秒轮询一次，所以能用
 * 「连续 16 次轮询速度都低」判定慢速。本扩展的实时通道是 aria2 WebSocket 通知，
 * 兜底是 5 分钟一次的 `scan-aria2` alarm——**没有 4 秒粒度的采样**。
 * 因此慢速判定改为「跨越两次扫描仍然低」：时间尺度从 ~64 秒变成 ~10 分钟。
 * 代价是最坏多等 10 分钟，收益是不用为了采样把 service worker 钉住。
 */
import { uriExpiresAt } from './url'

/** 任务状态的最小结构（`Aria2Status` 结构化兼容，避免 shared 反向依赖 background） */
export interface Aria2StatusLike {
    gid: string
    status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'
    totalLength?: string
    completedLength?: string
    downloadSpeed?: string
    files?: Array<{ uris?: Array<{ uri: string }> }>
}

/** 下载速度过慢阈值（字节/秒，16 KiB/s）——源 `ARIA2_SLOW_SPEED_THRESHOLD` */
export const SLOW_SPEED_THRESHOLD = 16 * 1024

/** 连续重建失败上限——源 `ARIA2_TRACK_MAX_REBUILD_ATTEMPTS` */
export const MAX_RECOVER_ATTEMPTS = 8

/**
 * 接近完成时不再因慢速重启（源同款 0.98）。
 *
 * 理由：最后几 % 往往只剩少量 data block，速度天然很低，此时重启等于把
 * 已经下好的 98% 丢掉重来。**但速度为 0 时不豁免**（源实现同款）——0 速度
 * 说明连接已经死了，等下去没有意义。
 */
export const SLOW_PROGRESS_EXEMPT_RATIO = 0.98

/** 下载进度（0~1）；totalLength 缺失或为 0 时返回 0（源 `getAria2Progress`） */
export function aria2Progress(status: Pick<Aria2StatusLike, 'totalLength' | 'completedLength'>): number {
    const total = Number(status.totalLength)
    const completed = Number(status.completedLength)
    if (!Number.isFinite(total) || total <= 0) return 0
    if (!Number.isFinite(completed) || completed < 0) return 0
    return Math.min(1, completed / total)
}

/**
 * 任务里最晚的过期时间：多源下载一个文件可能有多个 URL，取**最晚**的那个
 * （源 `aria2TrackTaskExpiry`）。比某个 URL 更晚过期，说明这个任务还能撑更久。
 *
 * `uriExpiresAt` 住在 `./url`（它是纯粹的 URL 判据，aria2 只是消费者）。
 */
export function taskLatestExpiry(status: Pick<Aria2StatusLike, 'files'>): number {
    let best = -Infinity
    for (const file of status.files ?? []) {
        for (const uri of file.uris ?? []) {
            const expires = uriExpiresAt(uri.uri)
            if (expires > best) best = expires
        }
    }
    return best
}

/** gid 活跃度优先级（源 `aria2TrackGidPriority`）：active > waiting > paused/complete > 其余 */
export function gidPriority(status: string | undefined): number {
    switch (status) {
        case 'active':
            return 3
        case 'waiting':
            return 2
        case 'paused':
        case 'complete':
            return 1
        default:
            return 0
    }
}

/**
 * 同一 videoId 有多个 gid 时该保留谁（源 scan 里的排序，逐项对齐）。
 *
 * 顺序：**URL 过期时间最晚** → 状态最活跃 → 队列已在追踪的那个。
 *
 * 为什么过期时间排第一：重复/重建留下的多个同源任务里，地址快过期那个
 * 随时会 403 失败，留着它当赢家等于主动选一个快要坏掉的连接。
 */
export function compareForKeep(a: Aria2StatusLike, b: Aria2StatusLike, queuedGid?: string): number {
    const expiryA = taskLatestExpiry(a)
    const expiryB = taskLatestExpiry(b)
    if (expiryA !== expiryB) return expiryA > expiryB ? -1 : 1
    const priorityA = gidPriority(a.status)
    const priorityB = gidPriority(b.status)
    if (priorityA !== priorityB) return priorityA > priorityB ? -1 : 1
    if (a.gid === queuedGid) return -1
    if (b.gid === queuedGid) return 1
    return 0
}

/**
 * 是否该因「速度过慢」重启这个任务。
 *
 * `slowSince` 是**第一次观察到低速**的时间戳（调用方维护）。`undefined` 表示
 * 本轮才第一次见到低速——只记录，不重启：单次采样受慢启动、并发抢占影响很大。
 *
 * `graceMs` 是观察窗口（本扩展用 2 次扫描间隔 ≈ 10 分钟；源项目用 16×4s ≈ 64s）。
 * 只有「跨过窗口仍然低速」才动手。
 */
export function shouldRestartForSlowSpeed(status: Pick<Aria2StatusLike, 'status' | 'totalLength' | 'completedLength' | 'downloadSpeed'>, slowSince: number | undefined, now: number, graceMs: number): boolean {
    if (status.status !== 'active') return false
    const speed = Number(status.downloadSpeed)
    if (!Number.isFinite(speed) || speed > SLOW_SPEED_THRESHOLD) return false
    if (slowSince === undefined || now - slowSince < graceMs) return false
    // 速度为 0：连接已死，接近完成也不豁免（源实现同款）
    if (speed === 0) return true
    return aria2Progress(status) <= SLOW_PROGRESS_EXEMPT_RATIO
}

/** 重建/重启次数是否已用尽（源 `nextRebuildAttempt` 的上限判定） */
export function recoverExhausted(attempts: number): boolean {
    return attempts >= MAX_RECOVER_ATTEMPTS
}

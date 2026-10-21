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
 * 因此慢速判定改为「连续 N 次扫描仍然低」：一次采样 ≈ 5 分钟，两次即动手。
 *
 * ⚠️ 用**采样次数**而不是时间窗口表达「持续多久」，是因为采样只发生在 alarm 触发的
 * 那一瞬间：写成「跨过 2 个扫描间隔」实际需要 3 次采样（10~15 分钟），且依赖
 * alarm 调度精度、电脑是否休眠、系统时钟是否被调整。次数没有这些假设。
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
 *
 * ⚠️ 这个排序**只在同一「活/终态」层内**使用——见 `planAria2Group`：
 * 跨层用过期时间排会让一条历史 complete（地址恰好还没过期）击败真正在下载的
 * active，把用户的下载停掉。
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

/** 任务是否还在 aria2 的活动队列里（`active` / `waiting` / `paused`） */
export function isLiveAria2Status(status: string): boolean {
    return status === 'active' || status === 'waiting' || status === 'paused'
}

/**
 * 同一个 videoId 的一组 aria2 任务的处置方案。
 *
 * 分三类，**处置方式完全不同**：
 *
 * | 类别 | 状态 | 处置 |
 * |---|---|---|
 * | 活跃副本 | active / waiting / paused | `remove` + `removeDownloadResult`（它们真的在抢带宽与文件） |
 * | 僵尸副本 | error / removed | 只 `removeDownloadResult`（清掉我们重建留下的垃圾结果记录） |
 * | 历史记录 | complete | **绝不触碰**（源 Issue #405） |
 *
 * ## 为什么历史记录必须单独一类
 *
 * 用户重新下载一个以前下过的视频时，aria2 里同时存在「旧的 complete」和「新的 active」。
 * 旧实现把它们一律当冗余 `stopRedundantTask`，而那个函数**无条件**调
 * `removeDownloadResult` —— 等于每次重下都把用户 aria2 里那条完成历史删掉。
 * 那正是源项目 Issue #405 描述的事故（脚本静默删除用户的下载历史），
 * 而本文件的注释里一直写着这条教训，实现却没守住。
 *
 * 留着历史记录不会让去重失效：下一轮扫描仍会看到它，但方案里它既不是活副本
 * （不需要停止）也不是僵尸（不需要清理），**不产生任何 RPC**。
 *
 * ## 为什么「赢家」只在活任务里选
 *
 * `compareForKeep` 的第一判据是 URL 过期时间。跨「活/终态」用它会出事：
 * 一条历史 `complete` 的地址完全可能比正在下载的 `active` 更晚过期
 * （`dispatch` 会复用页面快照，快照的 `expires` 可能只剩几分钟），
 * 于是历史记录当上赢家、`active` 被当成冗余 **remove 掉** —— 用户的下载被我们杀了。
 * 所以有活任务时只在活任务里选；没有活任务时才在全集里选（用于同步终态/收编）。
 */
export interface Aria2GroupPlan<T extends Aria2StatusLike> {
    winner: T
    /** 活跃副本：先停止再清结果 */
    liveLosers: T[]
    /** 僵尸副本（error / removed）：只清结果记录 */
    garbageLosers: T[]
    /** 历史记录（complete）：**绝不清理**，仅列出便于日志 */
    historyLosers: T[]
}

/** 一组同源任务的处置方案；空组返回 undefined */
export function planAria2Group<T extends Aria2StatusLike>(group: readonly T[], queuedGid?: string): Aria2GroupPlan<T> | undefined {
    if (group.length === 0) return undefined
    const live = group.filter((task) => isLiveAria2Status(task.status))
    const pool = live.length > 0 ? live : [...group]
    const winner = [...pool].sort((a, b) => compareForKeep(a, b, queuedGid))[0]!
    const plan: Aria2GroupPlan<T> = { winner, liveLosers: [], garbageLosers: [], historyLosers: [] }
    for (const task of group) {
        if (task.gid === winner.gid) continue
        if (isLiveAria2Status(task.status)) plan.liveLosers.push(task)
        else if (task.status === 'complete') plan.historyLosers.push(task)
        else plan.garbageLosers.push(task)
    }
    return plan
}

/**
 * 连续观察到低速的采样次数达到几次才重启。
 *
 * 2 = 「跨两次扫描」：第一次只记录（单次采样受慢启动、并发抢占影响很大），
 * 第二次仍低速才动手。一次采样 ≈ 5 分钟（`scan-aria2` 周期）。
 */
export const MIN_SLOW_POLLS = 2

/**
 * 是否该因「速度过慢」重启这个任务。
 *
 * `slowPolls` 是**累计到本轮的连续低速采样次数**（调用方负责记账：
 * 速度正常或任务离开 active 时清零）。`undefined` / 小于 `minPolls` 表示
 * 观察还不够——只记录，不重启。
 */
export function shouldRestartForSlowSpeed(status: Pick<Aria2StatusLike, 'status' | 'totalLength' | 'completedLength' | 'downloadSpeed'>, slowPolls: number | undefined, minPolls: number = MIN_SLOW_POLLS): boolean {
    if (status.status !== 'active') return false
    const speed = Number(status.downloadSpeed)
    if (!Number.isFinite(speed) || speed > SLOW_SPEED_THRESHOLD) return false
    if (slowPolls === undefined || slowPolls < minPolls) return false
    // 速度为 0：连接已死，接近完成也不豁免（源实现同款）
    if (speed === 0) return true
    return aria2Progress(status) <= SLOW_PROGRESS_EXEMPT_RATIO
}

/**
 * 扫描期间需要跨 SW 回收保留的两张计数表。
 *
 * ⚠️ 必须持久化：Chrome MV3 的 service worker 空闲约 30 秒就被回收，而扫描是
 * 5 分钟一次——**每一次扫描都是全新的 SW 实例**。只存模块级 `Map` 的话
 * 「连续 2 次扫描都低速」永远数不到 2，整个慢速恢复能力形同不存在
 * （2026-10-21 实测：功能自移植后从未触发过一次）。
 *
 * 存 `storage.session` 而不是 `storage.local`：观察状态属于「本次浏览器会话」，
 * 浏览器退出即清空，不会把上一次会话的陈旧计数带进来（任务早换了）。
 */
export interface Aria2ScanMemory {
    /** videoId → 累计连续低速采样次数 */
    slowPolls: Record<string, number>
    /** videoId → 连续恢复失败次数（达到 `MAX_RECOVER_ATTEMPTS` 才放弃） */
    recoverAttempts: Record<string, number>
}

/** 空白的扫描记忆 */
export function emptyScanMemory(): Aria2ScanMemory {
    return { slowPolls: {}, recoverAttempts: {} }
}

/**
 * 从存储里读出的任意值 → 可用的扫描记忆。
 *
 * 只保留「有限正数」条目：脏值（字符串、NaN、负数、null）必须丢弃而不是当作计数，
 * 否则一个写坏的值会让任务被无限重启或永远不重启。
 */
export function parseScanMemory(raw: unknown): Aria2ScanMemory {
    const result = emptyScanMemory()
    if (!raw || typeof raw !== 'object') return result
    const source = raw as { slowPolls?: unknown; recoverAttempts?: unknown }
    for (const key of ['slowPolls', 'recoverAttempts'] as const) {
        const table = source[key]
        if (!table || typeof table !== 'object') continue
        for (const [videoId, value] of Object.entries(table as Record<string, unknown>)) {
            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10_000) continue
            result[key][videoId] = value
        }
    }
    return result
}

/** 重建/重启次数是否已用尽（源 `nextRebuildAttempt` 的上限判定） */
export function recoverExhausted(attempts: number): boolean {
    return attempts >= MAX_RECOVER_ATTEMPTS
}

/**
 * 重建任务时，能不能用「任务现有地址」兜底。
 *
 * 源项目无条件兜底（`urls = oldUris`），本扩展**必须加这个门**：
 *
 * - `error` / `removed`：任务已经死了，旧地址是它唯一的线索，用它重建是唯一出路。
 * - `active` / `waiting` / `paused`：任务**还活着**。用同一批旧地址新建任务会造成：
 *   ① 同一个视频出现两个任务，抢写同一个输出文件（`allow-overwrite: true` 会从头覆盖）；
 *   ② 已下载的字节被丢掉重来（重建参数里没有 `continue`）；
 *   ③ 旧任务被 aria2 判成重复文件下载而消失。
 *
 * 2026-10-21 实测事故：慢速恢复的重建分支对 87 个**正在运行**的真实任务调了
 * `addUri`（因为重新解析失败、回退用了旧地址），给每个任务造了一个 0 字节副本，
 * 原任务随之消失。所以「有没有拿到新地址」必须参与判定，不能只看任务状态。
 */
export function canRebuildFromOldUris(status: string, hasFreshUrl: boolean): boolean {
    if (hasFreshUrl) return true
    return status === 'error' || status === 'removed'
}

/**
 * `aria2.changeUri` 的参数数组——**形状由真实 aria2 1.36.0 实测确定**，别再改：
 *
 * - `fileIndex` 是 **1-based**。传 0 会被拒：
 *   `The integer parameter at 1 has invalid value: the value must be greater than or equal to 1.`
 * - `position` 必须显式传 **0**。不传时新 URI 只追加到 `uris` 末尾，aria2 仍在用列表最前面
 *   那条旧 URI 下载（实测：加完新地址后 `used` 还是旧的）——「换地址」形同没换。
 */
export function buildChangeUriParams(gid: string, delUris: string[], addUris: string[]): unknown[] {
    return [gid, FIRST_FILE_INDEX, delUris, addUris, URI_POSITION_FRONT]
}

/** aria2 的文件序号从 1 开始 */
export const FIRST_FILE_INDEX = 1
/** changeUri 的 position：0 = 新地址插到最前，立刻成为正在使用的 URI */
export const URI_POSITION_FRONT = 0

/**
 * aria2 的「查不到这个 gid」错误。
 *
 * 实际报文（对 1.36.0 实测）：`{"code":1,"message":"GID 4cb40e84a20159b3 is not found"}`
 *
 * 必须**只认这一种**：`aria2API` 在传输层失败时会抛异常，两种情况的处置完全相反——
 * 查不到 = 任务真的没了（该收敛队列），连不上 = 什么都不知道（下一轮再说）。
 * 把「连不上」当成「任务没了」会让 aria2 一次重启把所有在跑的任务误判成失败。
 */
export function isAria2GidMissingError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' && /GID .* is not found/i.test(message)
}

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
import { RETRY_MAX_ATTEMPTS } from './constants'
import type { Aria2NetworkBackoff } from './aria2Network'
import { uriExpiresAt } from './url'

/** 任务状态的最小结构（`Aria2Status` 结构化兼容，避免 shared 反向依赖 background） */
export interface Aria2StatusLike {
    gid: string
    status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'
    totalLength?: string
    completedLength?: string
    downloadSpeed?: string
    connections?: string
    errorCode?: string
    files?: Array<{ path?: string; uris?: Array<{ uri: string; status?: string }> }>
}

// ── 「这个文件已经在系统里了」类错误（重建救不了，别白烧 8 轮）─────────

/** aria2 errorCode：同一路径已被另一个任务占用（`DUPLICATE_DOWNLOAD`） */
export const ARIA2_ERROR_DUPLICATE_DOWNLOAD = 11
/** aria2 errorCode：目标文件已存在但没有控制文件（`FILE_ALREADY_EXISTS`） */
export const ARIA2_ERROR_FILE_ALREADY_EXISTS = 13
/**
 * aria2 errorCode：**本地文件比远端文件大**（`The local file is larger than the remote file`）。
 *
 * 真机取证（2026-11-21，`zgC4YDXRi5Rq90`）：目标路径上的文件是上一次下载留下的完整文件（218 480 256 B），
 * 而服务端这次给的 `Content-Length` 更小，`continue=true` 的长度校验直接拒绝 → 0 字节、`errorCode 8`。
 * 重建同样无用（输出路径和那个更大的文件都没变），只有 `allow-overwrite=true` + `continue=false`
 * 把文件截断重下才行 —— 也就是任务页的「强制覆盖」。
 */
export const ARIA2_ERROR_LOCAL_FILE_LARGER = 8

/**
 * 该错误是否属于「文件层面已存在/被占用」，即**重建也一样会失败**。
 *
 * ## 为什么必须单独识别（这条错误文案本身有误导性）
 *
 * aria2 的报错写着「delete it or add --allow-overwrite=true」，但翻源码会发现：
 *
 * ```cpp
 * // RequestGroup.cc
 * void RequestGroup::shouldCancelDownloadForSafety() {
 *   if (option_->getAsBool(PREF_ALLOW_OVERWRITE)) return;   // ← allow-overwrite 只保护这一条路径
 *   if (!outfile.exists()) return;
 *   tryAutoFileRenaming();
 * }
 * void RequestGroup::tryAutoFileRenaming() {
 *   if (!option_->getAsBool(PREF_AUTO_FILE_RENAMING)) {     // ← 只看 auto-file-renaming
 *     throw ... fmt(MSG_FILE_ALREADY_EXISTS, ...);
 *   }
 * }
 * ```
 *
 * 也有一条路径来自 `adjustFilename()`：它发现**同一文件正被另一个 RequestGroup 处理**
 * （`isSameFileBeingDownloaded`）时同样调 `tryAutoFileRenaming()` —— 那里 `allow-overwrite`
 * **完全不参与判断**。所以即使我们（与源项目一样）传了 `allow-overwrite: true`，
 * 只要 aria2 的 `auto-file-renaming=false`，这条消息照样会出现。
 *
 * 实测（用户 aria2 1.36.0）：`getOption` 对任务返回 `allow-overwrite="true"`、
 * `auto-file-renaming="false"`、`continue="true"`，而报错文案仍在要求 allow-overwrite。
 *
 * ## 所以重建是无意义的
 *
 * 这两种错误的成因都在文件系统那一层：文件还在、或另一个任务正占着同一个输出路径。
 * `rebuildAria2Task` 走的是「清结果 + addUri」，addUri 换一个新 gid 但**输出路径不变**，
 * 下一轮必然再撞一次。旧实现会让它白跑 8 轮（每轮一次重解析 + 一次 addUri），
 * 最后仍标 failed —— 白白打了 16 次网络请求。
 */
export function isFileConflictErrorCode(code: string | number | undefined): boolean {
    if (code === undefined) return false
    const value = Number(code)
    return value === ARIA2_ERROR_FILE_ALREADY_EXISTS || value === ARIA2_ERROR_DUPLICATE_DOWNLOAD || value === ARIA2_ERROR_LOCAL_FILE_LARGER
}

/**
 * aria2 的「僵尸 active」：状态是 active，但一个连接都没有、一个字节都没下、所有 URI 还停留在
 * `waiting`（即引擎从未真正发起过请求）。
 *
 * 真机取证（2026-11-21，`p5YImxUBVZ6GTE` / gid `e4aed50d79232b5e`）：任务卡了几个小时，
 * `status=active totalLength=0 completedLength=0 connections=0`，`uris[0].status="waiting"`，
 * 而同一个 URL 从本机 `curl -r 0-0` 直接拿到 `206 Partial Content`——
 * 链接是好的，是 aria2 那个 RequestGroup 被我们的 `changeUri` 换址动作留在了「空转」状态。
 *
 * 对这种任务 `changeUri` 没用（它只往 URI 池里塞地址，不会重新驱动引擎），必须
 * **移除旧 gid 再 addUri**（见 `rebuildAria2Task` 的 `recreate`）。判定还需要叠加
 * 停滞采样（连续 2 次），否则「刚创建、正在解析域名」的瞬间也会被误判。
 */
/**
 * 一次 pause→unpause 之后，引擎到底有没有被重新驱动起来。
 *
 * 真机实测（aria2-next 3.1.1，僵尸 active 的 `e4aed50d79232b5e`）：`pause` 立刻把它变成 paused，
 * `unpause` 之后 5 秒内 `totalLength` 从 0 变成 124 520 936（URL 被真正请求到了）。
 * 所以「引擎动了」的最早信号是 **totalLength > 0 或 connections > 0**——不必等下载出字节。
 */
export function isAria2EngineAlive(status: { totalLength?: string; completedLength?: string; connections?: string; status?: string } | undefined): boolean {
    if (status === undefined) return false
    if (status.status === 'error' || status.status === 'removed') return false
    if (Number(status.totalLength ?? 0) > 0) return true
    if (Number(status.completedLength ?? 0) > 0) return true
    return Number(status.connections ?? 0) > 0
}

export function isIdleAria2Status(status: { status?: string; completedLength?: string; downloadSpeed?: string; connections?: string; files?: Array<{ uris?: Array<{ uri: string; status?: string }> }> }): boolean {
    if (status.status !== 'active') return false
    if (Number(status.completedLength ?? 0) > 0) return false
    if (Number(status.downloadSpeed ?? 0) > 0) return false
    if (Number(status.connections ?? 0) > 0) return false
    const uris = status.files?.[0]?.uris ?? []
    return uris.length === 0 || uris.every((entry) => entry.status === 'waiting')
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
 * 进度（0~1），**媒体任务单独走一条路**。
 *
 * 真机实测（aria2-next 3.1.1）：HLS 任务的 totalLength 恒为 0，进度只在 media.progress 里（"1.000000" 这种字符串）。直接调 aria2Progress 会返回 0，于是进度条永远 0%、慢速判据（要求 totalLength > 0）永不触发。
 *
 * 非媒体任务的行为与 aria2Progress 完全一致；媒体分支拿不到值时也返回 0——不猜，猜出来的百分比会盖掉真实状态。
 */
export function aria2ProgressOf(status: Pick<Aria2StatusLike, 'totalLength' | 'completedLength'> & { media?: { progress?: string } }): number {
    if (Number(status.totalLength) > 0) return aria2Progress(status)
    const raw = status.media?.progress
    if (typeof raw !== 'string' && typeof raw !== 'number') return 0
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return 0
    return Math.min(1, value)
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
 * 任务完成度（0~1）：aria2 的 `complete` 视为 100%，其余按字节比例。
 *
 * 单独包一层而不是直接 `aria2Progress`：`complete` 任务的 `totalLength`
 * 在某些场景下读不到（外部添加、控制文件丢失），直接算比例会得到 0，
 * 于是「已完成」在择优里输给一个刚起步的副本。
 */
export function aria2Completion(status: Pick<Aria2StatusLike, 'status' | 'totalLength' | 'completedLength'>): number {
    if (status.status === 'complete') return 1
    return aria2Progress(status)
}

/** 已完成字节数（脏值按 0 处理） */
function completedBytes(status: Pick<Aria2StatusLike, 'completedLength'>): number {
    const value = Number(status.completedLength)
    return Number.isFinite(value) && value > 0 ? value : 0
}

/** 任务的文件落盘路径（判断两条 complete 记录是不是同一个文件） */
export function aria2FilePath(status: Pick<Aria2StatusLike, 'files'>): string {
    return status.files?.[0]?.path ?? ''
}

/**
 * 同一 videoId 有多个 gid 时该保留谁。
 *
 * 顺序：**完成度最高 → 已完成字节更多** → URL 过期时间最晚 → 状态最活跃 →
 * 队列已在追踪的那个。
 *
 * ## 为什么完成度排第一（2026-10-22 调整）
 *
 * 之前按「URL 过期时间」排第一。但重复任务的成因几乎都是同一视频被投递了两次，
 * 两个 gid 各下一部分：按过期时间选，很可能留下一个 0% 的新任务，把已经下了
 * 80% 的那个 `remove` 掉——用户丢掉全部已下字节，还看到一条 “Download aborted.”。
 * 源实现没有这个问题（它的追踪队列按 videoId 做键，结构上不可能出现两个同源任务）。
 *
 * 过期时间的旧理由（别选一个马上 403 的地址）由恢复机制兜底：真 403 时
 * `tryRecover` 会重新解析并 `changeUri`，因为 `continue=true`，已下字节仍然保留。
 *
 * ⚠️ 这个排序**只在同一「活/终态」层内**使用——见 `planAria2Group`：
 * 跨层排序会让一条历史 complete（完成度 100%）击败真正在下载的 active，
 * 把用户的重下任务停掉。
 */
export function compareForKeep(a: Aria2StatusLike, b: Aria2StatusLike, queuedGid?: string): number {
    const completionA = aria2Completion(a)
    const completionB = aria2Completion(b)
    if (completionA !== completionB) return completionA > completionB ? -1 : 1
    const bytesA = completedBytes(a)
    const bytesB = completedBytes(b)
    if (bytesA !== bytesB) return bytesA > bytesB ? -1 : 1
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
 * 分四类，**处置方式完全不同**：
 *
 * | 类别 | 状态 | 处置 |
 * |---|---|---|
 * | 活跃副本 | active / waiting / paused | `remove` + `removeDownloadResult`（它们真的在抢带宽与文件） |
 * | 僵尸副本 | error / removed | 只 `removeDownloadResult`（清掉我们重建留下的垃圾结果记录） |
 * | 重复完成记录 | complete（同一落盘路径已有一条） | 只 `removeDownloadResult`（同一文件不可能存在两份，纯噪声） |
 * | 历史记录 | complete（路径各不相同） | **绝不触碰**（源 Issue #405） |
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
    /**
     * 重复的完成记录（与保留者指向**同一个落盘路径**）：只清结果。
     *
     * 用户要的是「一个视频一个任务」：同一个文件下完两次只会在 aria2 里留下
     * 两条一模一样的 complete，删掉多余那条不影响磁盘上的文件，也不影响
     * 「这条视频下过」的事实（保留者还在）。
     */
    duplicateHistory: T[]
    /** 历史记录（complete，路径各不相同）：**绝不清理**，仅列出便于日志 */
    historyLosers: T[]
}

/** 一组同源任务的处置方案；空组返回 undefined */
export function planAria2Group<T extends Aria2StatusLike>(group: readonly T[], queuedGid?: string): Aria2GroupPlan<T> | undefined {
    if (group.length === 0) return undefined
    const live = group.filter((task) => isLiveAria2Status(task.status))
    const pool = live.length > 0 ? live : [...group]
    const winner = [...pool].sort((a, b) => compareForKeep(a, b, queuedGid))[0]!
    const plan: Aria2GroupPlan<T> = { winner, liveLosers: [], garbageLosers: [], duplicateHistory: [], historyLosers: [] }
    // 同一路径只允许保留一条完成记录：多余的那些对应的是同一个磁盘文件
    const keptCompletePaths = new Set<string>()
    const winnerPath = winner.status === 'complete' ? aria2FilePath(winner) : ''
    if (winnerPath !== '') keptCompletePaths.add(winnerPath)
    for (const task of group) {
        if (task.gid === winner.gid) continue
        if (isLiveAria2Status(task.status)) {
            plan.liveLosers.push(task)
            continue
        }
        if (task.status === 'complete') {
            const path = aria2FilePath(task)
            if (path !== '' && keptCompletePaths.has(path)) {
                plan.duplicateHistory.push(task)
            } else {
                if (path !== '') keptCompletePaths.add(path)
                plan.historyLosers.push(task)
            }
            continue
        }
        plan.garbageLosers.push(task)
    }
    return plan
}

// ── 残留收编：aria2 里有、但扩展队列里没有的任务 ──────────────────────

/** 一条残留任务该不该收编成队列任务 */
export interface ResidualAdoptionPlan {
    /** 是否补入队（`false` = 本轮完全跳过，不发任何 RPC） */
    adopt: boolean
    /**
     * 收编时的 `attempts` 初值（`undefined` = 从 0 开始，即参与自动重试）。
     *
     * 失败残留给**满上限**：它们是历史遗留（实测用户 aria2 里 309 条 403），
     * `retry-failed` 每 30 分钟扫一遍失败任务，若从 0 开始会在半小时后同时重投 309 个
     * 早已过期的直链。要重试请用户在任务面板自己点（那会清零计数）。
     */
    attempts?: number
}

/**
 * 决定「aria2 里有、扩展队列里没有」的残留任务怎么处理。
 *
 * ## 完成表只能拦「完成态」，这一条是本函数的全部意义
 *
 * 旧实现的判据是 `status !== 'active' && status !== 'waiting'`，于是 `error` / `removed`
 * 也一起吃「30 天内已完成」的跳过分支。后果是实测出来的：
 *
 * - 用户的 aria2 里攒了 **309 条** `error`（`status=403`、`progress=0/0`、直链已过期 2~6 天）；
 * - 它们几乎都命中完成表——因为**同一视频更早那次下载成功过**（批量投递超发 → 排队
 *   到真正开跑时直链已失效 → 这次 403，而上一批里成功了一条）；
 * - 跳过既不清理也不入队：用户在任务面板里**看不到它们**，也没法重试，
 *   只能眼睁睁看 309 条死任务永远躺在 aria2 里（每 5 分钟还要传 4.6 MB 的 `tellStopped`）。
 *
 * 完成表的本职是「别把同一份文件重复处理 / 重复通知」，不是「替用户决定这次失败可以忽略」。
 * 所以：
 *
 * | aria2 状态 | 完成表命中 | 结论 |
 * |---|---|---|
 * | `complete` | 命中 | **跳过**（已完成，入队只会制造一条无动作的历史） |
 * | `complete` | 未命中 | 收编（保持 complete，顺带补记完成表） |
 * | `error` / `removed` | 任意 | **收编成 failed 待办**（用户要看得见、点得动） |
 * | `active` / `waiting` / `paused` | 任意 | 收编（外部直加的任务，交给后续同步） |
 */
export function planResidualAdoption(status: string, knownDone: boolean, maxAttempts: number = RETRY_MAX_ATTEMPTS): ResidualAdoptionPlan {
    if (status === 'complete') return knownDone ? { adopt: false } : { adopt: true }
    if (status === 'error' || status === 'removed') return { adopt: true, attempts: maxAttempts }
    return { adopt: true }
}

/**
 * 连续观察到低速的采样次数达到几次才重启。
 *
 * 2 = 「跨两次采样」：第一次只记录（单次采样受慢启动、并发抢占影响很大），
 * 第二次仍低速才动手。采样由 1 分钟的 probe 记账（扫描只读不记，见 tracker 的
 * `trackSlowObservation` 第二个参数），所以是「约 2 分钟」而不是「约 10 分钟」。
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
 * 停滞判定：`active` 但**字节数一点没动**。
 *
 * 与慢速判定的区别不是程度而是性质：慢速是「在动，但太慢」（看速度阈值 + 进度豁免），
 * 停滞是「完全不动」。所以这里**不看总长、不看进度比例**——媒体任务的 `totalLength`
 * 恒为 0（实测 aria2-next 3.1.x），进度豁免在它身上恒为 0 < 0.98 而永远"豁免"，
 * 等于永不恢复；而 aria2-next 3.1.x 的 403 又会永远停在 `active` 不报错，
 * 这条链路上除了「字节不动」没有任何别的信号可用。
 *
 * 判据是「已完成字节没变」而不是「速度是 0」：aria2 在两轮重试之间（`retry-wait=10`）
 * 速度也是 0，那只是正常的重试间隙。
 *
 * 证据必须跨采样：两次观测之间要隔够 `STALL_MIN_SAMPLE_INTERVAL_MS`，
 * 否则「两秒内两次零进展」什么也证明不了，反而会把刚启动的任务当成卡死。
 */
export const STALL_MIN_SAMPLE_INTERVAL_MS = 45_000

/** 连续几次「零进展」才判停滞（配合 1 分钟的 probe：约 2 分钟出手） */
export const MIN_STALL_POLLS = 2

/** 停滞采样：只记「上次看到多少进展、什么时候、连着几次没动」 */
export interface Aria2StallSample {
    /** 采样签名（已完成字节 + 媒体进度），变了就说明还在动 */
    signature: string
    polls: number
    at: number
}

/** 停滞采样用的签名：媒体任务靠 `media.progress` 兜底，普通任务靠 `completedLength` */
export function aria2StallSignature(status: Pick<Aria2StatusLike, 'totalLength' | 'completedLength'> & { media?: { progress?: string } }): string {
    return `${completedBytes(status)}|${aria2ProgressOf(status)}`
}

/**
 * 记一次停滞采样。返回 `undefined` 表示「不该再算停滞」（调用方删掉这条记录）。
 *
 * - 不在 `active`：排队/暂停/报错时字节不动是常态；
 * - 速度 > 0：在走；
 * - 签名变了：有进展，重新数；
 * - 签名没变但两次采样太近：**不累加**（1 分钟的 probe 与 5 分钟的扫描是两条独立定时器，
 *   撞在一起时不能让同一时刻各记一笔，否则判据会随定时器相位漂移）。
 */
export function nextStallSample(status: Pick<Aria2StatusLike, 'status' | 'totalLength' | 'completedLength' | 'downloadSpeed'> & { media?: { progress?: string } }, previous: Aria2StallSample | undefined, now: number = Date.now(), minIntervalMs: number = STALL_MIN_SAMPLE_INTERVAL_MS): Aria2StallSample | undefined {
    if (status.status !== 'active') return undefined
    const speed = Number(status.downloadSpeed)
    if (Number.isFinite(speed) && speed > 0) return undefined
    const signature = aria2StallSignature(status)
    if (!previous || previous.signature !== signature) return { signature, polls: 1, at: now }
    if (now - previous.at < minIntervalMs) return previous
    return { signature, polls: previous.polls + 1, at: now }
}

/** 是否该因「完全停滞」重启：连续 `minPolls` 次采样都没动 */
export function shouldRestartForStall(status: Pick<Aria2StatusLike, 'status' | 'downloadSpeed'>, sample: Aria2StallSample | undefined, minPolls: number = MIN_STALL_POLLS): boolean {
    if (status.status !== 'active') return false
    const speed = Number(status.downloadSpeed)
    if (Number.isFinite(speed) && speed > 0) return false
    return sample !== undefined && sample.polls >= minPolls
}

/**
 * 本轮 `tellStopped` 要请求多少条（P1-1）。
 *
 * 为什么不是「固定拉全量」：实测 1134 条结果的完整回包是 **12,815,311 B / 289 ms**，
 * 而只问计数（`getGlobalStat`）是 **153 B**。5 分钟一轮 ⇒ 每台机器每天约 3.5 GB 的
 * 本地回包与 JSON 解析，全花在「有没有新完成的任务」这件事上。
 *
 * 为什么不能简单调小：老条目会被漏掉（收编外部任务、判定 gid 是否已被清理都靠它）。
 * 所以用 aria2 自己的单调计数器做增量，再每 `ARIA2_FULL_SWEEP_ROUNDS` 轮做一次全量兜底。
 */
export interface Aria2StoppedWindow {
    /** 本轮请求条数；0 = 这一轮可以不请求 */
    num: number
    /** aria2 重启过：必须全量，且调用方要清空采样（旧 gid 全失效） */
    restarted: boolean
}

/** 单次增量拉取的上限（一条约 11 KB，256 条 ≈ 2.8 MB，仍远小于全量） */
export const ARIA2_STOPPED_PAGE = 256
/** 每多少轮做一次全量，保证外部任务收编与 gid 清理判定不会饿死（12 轮 ≈ 1 小时） */
export const ARIA2_FULL_SWEEP_ROUNDS = 12

export function planStoppedWindow(input: { sessionChanged: boolean; currentTotal: number; lastTotal: number; fullSweepDue: boolean; fullSize?: number }): Aria2StoppedWindow {
    const fullSize = input.fullSize ?? ARIA2_STOPPED_PAGE
    if (input.sessionChanged) return { num: fullSize, restarted: true }
    // 计数倒退只可能是 aria2 重启（numStoppedTotal 单调递增：被挤出/被删的条目也计入）。
    // 没有 sessionId 可读的分支上，这是「重启」的第二个信号，不能按 delta=0 跳过。
    if (Number.isFinite(input.currentTotal) && Number.isFinite(input.lastTotal) && input.lastTotal >= 0 && input.currentTotal < input.lastTotal) return { num: fullSize, restarted: true }
    if (input.fullSweepDue) return { num: fullSize, restarted: false }
    // 计数不可信（aria2 太老 / 回包缺字段 / 还没有基线）⇒ 全量，宁可多传一次
    if (!Number.isFinite(input.currentTotal) || !Number.isFinite(input.lastTotal) || input.lastTotal < 0) return { num: fullSize, restarted: false }
    const delta = Math.max(0, input.currentTotal - input.lastTotal)
    if (delta === 0) return { num: 0, restarted: false }
    // +8 余量：计数与结果入表之间有一瞬的竞态，宁可多拉几条
    return { num: Math.min(ARIA2_STOPPED_PAGE, delta + 8), restarted: false }
}

/**
 * 扫描期间需要跨 SW 回收保留的计数表。
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
    // 详见各字段注释（顺序保持与 `emptyScanMemory` 一致，便于人眼对照）
    /** videoId → 累计连续低速采样次数 */
    slowPolls: Record<string, number>
    /** videoId → 连续恢复失败次数（达到 `MAX_RECOVER_ATTEMPTS` 才放弃） */
    recoverAttempts: Record<string, number>
    /** videoId → 停滞采样（见 `nextStallSample`） */
    stallSamples: Record<string, Aria2StallSample>
    /** videoId → 上一次自动恢复的时间戳（见 `recoverCooldownRemaining`） */
    recoverAt: Record<string, number>
    /** videoId → 网络层失败退避（见 `shared/aria2Network.ts`） */
    networkFailures: Record<string, Aria2NetworkBackoff>
    /** 上次看到的 `numStoppedTotal`；-1 = 还没有基线（首次必须全量） */
    stoppedTotal: number
    /** aria2 会话 id：变了说明 aria2 重启过，旧 gid 与所有采样都失效 */
    sessionId: string
    /** 已完成的扫描轮数（决定什么时候做一次全量） */
    scanRound: number
    /** 网络熔断的解除时间戳（0 = 未熔断） */
    networkBreakerUntil: number
}

/** 空白的扫描记忆 */
export function emptyScanMemory(): Aria2ScanMemory {
    return { slowPolls: {}, recoverAttempts: {}, recoverAt: {}, stallSamples: {}, networkFailures: {}, stoppedTotal: -1, sessionId: '', scanRound: 0, networkBreakerUntil: 0 }
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
    // 时间戳不能套用上面「计数 ≤ 10000」的判据（毫秒时间戳必然超出）。只接受「像样的时间戳」：
    // 早于 2020 年 或 比现在还晚一小时以上的一律丢弃——后者会算出几天的冷却，等于把任务锁死。
    const recoverAtTable = (raw as { recoverAt?: unknown }).recoverAt
    if (recoverAtTable && typeof recoverAtTable === 'object') {
        const now = Date.now()
        for (const [videoId, value] of Object.entries(recoverAtTable as Record<string, unknown>)) {
            if (typeof value !== 'number' || !Number.isFinite(value)) continue
            if (value < 1_600_000_000_000 || value > now + 3_600_000) continue
            result.recoverAt[videoId] = value
        }
    }
    const stalls = (raw as { stallSamples?: unknown }).stallSamples
    if (stalls && typeof stalls === 'object') {
        for (const [videoId, value] of Object.entries(stalls as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue
            const sample = value as { signature?: unknown; polls?: unknown; at?: unknown }
            if (typeof sample.signature !== 'string') continue
            if (typeof sample.polls !== 'number' || !Number.isFinite(sample.polls) || sample.polls <= 0 || sample.polls > 10_000) continue
            if (typeof sample.at !== 'number' || !Number.isFinite(sample.at) || sample.at <= 0) continue
            result.stallSamples[videoId] = { signature: sample.signature, polls: sample.polls, at: sample.at }
        }
    }
    const source2 = raw as { stoppedTotal?: unknown; sessionId?: unknown; scanRound?: unknown; networkBreakerUntil?: unknown; networkFailures?: unknown }
    if (typeof source2.stoppedTotal === 'number' && Number.isFinite(source2.stoppedTotal) && source2.stoppedTotal >= 0) result.stoppedTotal = Math.floor(source2.stoppedTotal)
    if (typeof source2.sessionId === 'string') result.sessionId = source2.sessionId
    if (typeof source2.scanRound === 'number' && Number.isFinite(source2.scanRound) && source2.scanRound >= 0) result.scanRound = Math.floor(source2.scanRound)
    if (typeof source2.networkBreakerUntil === 'number' && Number.isFinite(source2.networkBreakerUntil) && source2.networkBreakerUntil > 0) result.networkBreakerUntil = source2.networkBreakerUntil
    if (source2.networkFailures && typeof source2.networkFailures === 'object') {
        for (const [videoId, value] of Object.entries(source2.networkFailures as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue
            const entry = value as { count?: unknown; lastAt?: unknown; nextAt?: unknown }
            if (typeof entry.count !== 'number' || !Number.isFinite(entry.count) || entry.count <= 0 || entry.count > 10_000) continue
            if (typeof entry.lastAt !== 'number' || !Number.isFinite(entry.lastAt) || entry.lastAt <= 0) continue
            if (typeof entry.nextAt !== 'number' || !Number.isFinite(entry.nextAt) || entry.nextAt <= 0) continue
            result.networkFailures[videoId] = { count: entry.count, lastAt: entry.lastAt, nextAt: entry.nextAt }
        }
    }
    return result
}

/** 重建/重启次数是否已用尽（源 `nextRebuildAttempt` 的上限判定） */
export function recoverExhausted(attempts: number): boolean {
    return attempts >= MAX_RECOVER_ATTEMPTS
}

/**
 * 同一个视频两次**自动**恢复之间的最小间隔。
 *
 * 为什么必须有：WS 的 `onDownloadError` 是事件驱动的——重建出来的新 gid 若在 1 秒内又 403，
 * 事件立刻再触发一次恢复。真机实测：8 轮上限在 **13 秒**内烧完，每一轮都是「重新解析 +
 * addUri」→ aria2 的 stopped 列表里留下 8 条同一视频的 `error` 残骸，而 iwara 那边挨了 8 次解析。
 * 自动恢复是兜底手段，不是重试风暴，因此按分钟级节流；用户手动「重建」走
 * `resetAria2RecoveryState`，不受这个冷却约束。
 */
export const ARIA2_RECOVER_MIN_INTERVAL_MS = 60_000

/**
 * 解析失败里「再怎么重试都不会好」的那一类。
 *
 * 这三条都是**站点语义**层面的结论，不是网络抖动：
 * - `errors.notFound`：视频被删 / 被作者下架 / 链接失效；
 * - `errors.privateVideo`：仅作者好友可见（真机日志里 /video 与 API 都只回这一句）；
 * - `errors.forbidden`：站点直接拒绝。
 *
 * 对这类视频用**旧直链**重建（旧实现的做法）只会得到 403：既救不回来，又在 aria2 的
 * stopped 列表里留下一条 `0 B error`。真机实测：一个私有视频每 40 秒左右重建一次新 gid。
 */
export function isUnrecoverableParseFailure(message: string): boolean {
    return /errors\.(notFound|privateVideo|forbidden)/.test(message)
}

/** 距允许下一次自动恢复还有多久（0 = 现在就可以） */
export function recoverCooldownRemaining(lastAt: number | undefined, now: number): number {
    if (lastAt === undefined || !Number.isFinite(lastAt) || lastAt <= 0) return 0
    const remaining = lastAt + ARIA2_RECOVER_MIN_INTERVAL_MS - now
    return remaining > 0 ? remaining : 0
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

/**
 * 一轮扫描最多对多少条「没在 aria2 任何列表里出现」的任务做逐条确认。
 *
 * 这些任务通常是残骸：gid 被 aria2 清掉（`tellStopped` 窗口滚出 / 用户清空结果 / aria2 重启），
 * 而队列里还写着 `running`。不对它们逐条 `tellStatus`，界面上的「下载中」就会永远比
 * aria2 的真实数量多（实测：界面 115 条 running，aria2 `numActive` 只有 1）。
 * 限 20 条是为了把这一轮的 RPC 与时长兜住；剩下的下一轮继续。
 */
export const ARIA2_UNSEEN_SETTLE_LIMIT = 20

/** 队列里该逐条确认的残骸：活状态 + 已绑定 gid + 本轮三个列表都没出现 */
export function pickUnseenQueueTasks<T extends { status: string; kind: string; kindRef?: string; createdAt?: number; updatedAt?: number }>(tasks: readonly T[], seenGids: ReadonlySet<string>, limit: number = ARIA2_UNSEEN_SETTLE_LIMIT): T[] {
    const stale = tasks.filter((task) => (task.status === 'running' || task.status === 'queued') && task.kind === 'aria2' && task.kindRef !== undefined && task.kindRef !== '' && !seenGids.has(task.kindRef))
    // 老的先处理：新任务可能只是还没进下一份列表（投递与扫描撞车），别急着判它死
    stale.sort((a, b) => (a.updatedAt ?? a.createdAt ?? 0) - (b.updatedAt ?? b.createdAt ?? 0))
    return stale.slice(0, Math.max(0, limit))
}

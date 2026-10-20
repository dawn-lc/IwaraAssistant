/**
 * aria2 任务追踪 —— 原 features/aria2Track.ts 的后台化（docs/01：锁/选举/GM 队列整体删除）
 *
 * 实时化（用户指定方案）：
 *  - 主路径：WebSocket 通知（onDownloadStart/Complete/Error）→ 即时终态落盘 + 系统通知；
 *    指令（tellStatus/changeUri/addUri/remove）也走 WS —— 全程零轮询
 *  - 兜底：scan-aria2 alarm（5 min）tellActive/tellStopped 对账（通知丢失/SW 挂起/外部直加任务）
 *
 * ## 与原版的差异（每条都有理由，不是省略）
 *
 * - GMLock/WebLock/选举/pagehide 让位 → 后台即管理器，0 行锁代码
 * - GMSyncDictionary 队列 → 项目队列（storage 唯一写者）；按 kindRef=gid 关联
 * - 终态去重表（30 天）保留：防 tellStopped 旧完成任务被反复提示/反复入队
 * - **每任务 worker + 4 秒轮询 → WS 通知 + 5 分钟扫描**：没有 4 秒采样，所以慢速判定的
 *   时间窗口从「16 次 × 4s」改为「2 次扫描间隔」，判据本身在 `shared/aria2Recover.ts` 里单测
 * - **恢复能力保留**：`error` / `removed` / `paused` / 慢速 → 重解析换地址（同目录 `recover.ts`）。
 *   这是原版最重要的能力，丢了就等于「链接过期后只能重新下载一遍」。
 */
import { DONE_RECORD_TTL_DAYS } from '../../../shared/constants'
import { i18n } from '../../../shared/i18n'
import { isNullOrUndefined, stringify } from '../../../shared/strings'
import type { QueueTask } from '../../../shared/task'
import { CONFIG_KEY } from '../../../shared/storageKeys'
import { compareForKeep, aria2Progress, recoverExhausted, shouldRestartForSlowSpeed, SLOW_SPEED_THRESHOLD } from '../../../shared/aria2Recover'
import { parseStoredConfig } from '../../storage/configStore'
import { addTask, findTask, getTasks, patchTask, notifyTask, syncTask } from '../../storage/queue'
import { EXTRACT_VIDEO_ID_FIELDS, aria2API, aria2TellStatus, extractVideoIdFromTask, isAria2Configured, type Aria2Status } from './client'
import { connect, onNotification, resetConnection } from './ws'
import { pushVideoIdToMediaCenter } from '../../iwara/mediaCenter'
import { isAria2QueueFull, rebuildAria2Task, restartAria2Task } from './recover'
import { notifyInfo } from '../../runtime/notify'

/** 扫描间隔（与 alarms.ts 的 scan-aria2 保持一致）：慢速判定的观察窗口按它算 */
const SCAN_INTERVAL_MS = 5 * 60 * 1000
/** 慢速观察窗口：跨过两次扫描仍然低速才重启（源项目用 16×4s，见文件头说明） */
const SLOW_SPEED_GRACE_MS = SCAN_INTERVAL_MS * 2

/**
 * 首次观察到「低速」的时间戳（videoId → 时间）。仅内存：
 * SW 被回收后重新计数——这是可接受的，重启判定本来就是「持续低速」而不是「曾经低速」。
 */
const slowSince = new Map<string, number>()
/** 连续恢复失败次数（videoId → 次数）；成功或被用户清理时归零 */
const recoverAttempts = new Map<string, number>()

/**
 * aria2 任务 → 队列状态映射（扫描对账用）。
 *
 * ⚠️ `waiting` 是**排队中**，不是「正在下载」：它是 aria2 自己的并发上限
 * （`max-concurrent-downloads`）满了，任务在它内部队列里等。旧实现把它也映射成
 * `running`，界面于是声称「N 条在下载」而实际只有 `max-concurrent-downloads` 条在传——
 * 用户既看不出真实占用，也没法解释「我设的同时下载数没生效」。
 * `paused` 同理（暂停也是没在传）。
 */
function statusOfAria2(status: Aria2Status['status']): QueueTask['status'] {
    switch (status) {
        case 'active':
            return 'running'
        case 'complete':
            return 'complete'
        case 'error':
        case 'removed':
            return 'failed'
        default:
            // waiting / paused
            return 'queued'
    }
}

/** 进度回写的阈值：变化小于 0.5% 不落盘。 */
const PROGRESS_EPSILON = 0.005

/**
 * 把「还在跑」的任务的实时状态同步回队列（状态 + 进度）。
 *
 * 两个都必须看：WS 的 `onDownloadStart` 可能丢（SW 挂起），那时队列里还是 `queued`
 * 而 aria2 已经在 `active`；反过来 `active` → `waiting`（用户改了 aria2 并发上限）也该反映。
 *
 * 进度用 `aria2Progress`（`completedLength / totalLength`）——与慢速重启判定同一个函数，
 * 两处用不同算法会让界面上的百分比和「接近完成」的豁免阈值对不上。
 */
async function syncLiveState(task: QueueTask, status: Aria2Status, nextStatus: QueueTask['status']): Promise<void> {
    const progress = aria2Progress(status)
    const statusChanged = task.status !== nextStatus
    // progress === 0 时不写：那既可能是「刚开始」也可能是「读不到 totalLength」，
    // 写成 0 等于替后端编了一个值
    const progressChanged = progress > 0 && Math.abs((task.progress ?? -1) - progress) >= PROGRESS_EPSILON
    if (!statusChanged && !progressChanged) return
    await patchTask(task.id, { status: nextStatus, ...(progressChanged ? { progress } : {}) })
}

// ── 终态去重表（原 ARIA2_TRACK_DONE）：videoId → doneAt，30 天窗口 ────────

function getDoneMap(): Promise<Record<string, number>> {
    return browser.storage.local.get('aria2TrackDone').then((stored) => {
        const value = stored['aria2TrackDone']
        return value && typeof value === 'object' ? (value as Record<string, number>) : {}
    })
}

async function markDone(videoId: string, doneAt = Date.now()): Promise<void> {
    const doneMap = await getDoneMap()
    doneMap[videoId] = doneAt
    await browser.storage.local.set({ aria2TrackDone: doneMap })
}

async function pruneDoneMap(): Promise<void> {
    const doneMap = await getDoneMap()
    const now = Date.now()
    const retention = DONE_RECORD_TTL_DAYS * 24 * 60 * 60 * 1000
    let changed = false
    for (const [videoId, doneAt] of Object.entries(doneMap)) {
        if (now - doneAt > retention) {
            delete doneMap[videoId]
            changed = true
        }
    }
    if (changed) await browser.storage.local.set({ aria2TrackDone: doneMap })
}

// ── WS 通知的实时终态处理 ────────────────────────────────────────────

interface GidNotificationPayload {
    gid: string
}

function payloadGid(params: unknown[]): string | undefined {
    const first = params[0] as GidNotificationPayload | undefined
    return first && typeof first.gid === 'string' ? first.gid : undefined
}

/** 下载完成：队列命中 → complete 落盘+通知；未命中（外部任务）→ 查 ID 记终态，静默 */
async function handleDownloadComplete(gid: string): Promise<void> {
    const task = findTask({ kindRef: gid, kind: 'aria2' })
    if (task) {
        task.status = 'complete'
        await syncTask(task)
        await notifyTask(task)
        await markDone(task.videoId)
        // MediaCenter 推送（实验特性关闭/未配置时内部直接返回）
        void pushVideoIdToMediaCenter(task.videoId, task.filename)
        return
    }
    // 外部任务（用户直接往 aria2 投的）：提取视频 ID 只记去重表，不打扰
    const status = await aria2TellStatus(gid)
    const videoId = status ? extractVideoIdFromTask(status) : undefined
    if (videoId) await markDone(videoId)
}

/** 下载失败：队列命中 → failed（aria2 errorMessage）；未命中 → 记日志 */
async function handleDownloadError(gid: string): Promise<void> {
    const task = findTask({ kindRef: gid, kind: 'aria2' })
    if (!task) return
    const status = await aria2TellStatus(gid)
    task.status = 'failed'
    task.detail = status?.errorMessage ?? i18n.t('notify.aria2Failed', { detail: status?.errorCode ?? i18n.t('notify.aria2UnknownCode') })
    await syncTask(task)
    await notifyTask(task)
}

/** 下载启动：队列在跑的任务维持 running（对账语义，无 UI 动作） */
function handleDownloadStart(gid: string): void {
    const task = findTask({ kindRef: gid, kind: 'aria2' })
    if (task && task.status !== 'running') void patchTask(task.id, { status: 'running' })
}

// ── 扫描对账（兜底）：tellActive + tellStopped → 补入队/清冗余 ─────────

async function stopRedundantTask(task: Aria2Status): Promise<void> {
    // 原 removeRedundantAria2Task：活跃任务先停止，再清结果记录
    if (task.status === 'active' || task.status === 'waiting' || task.status === 'paused') {
        try {
            await aria2API('aria2.remove', [task.gid])
        } catch {
            // 可能已被移除
        }
    }
    try {
        await aria2API('aria2.removeDownloadResult', [task.gid])
    } catch {
        // 结果条目可能已清
    }
}

/** 扫描 aria2 现有任务对账（原 scanAria2TasksAndEnqueue 精简移植） */
export async function scanAria2TasksAndEnqueue(): Promise<{ adopted: number; stopped: number; rejected: number }> {
    let adopted = 0
    let stopped = 0
    let rejected = 0
    if (!isAria2Configured()) return { adopted, stopped, rejected }
    try {
        const fields = EXTRACT_VIDEO_ID_FIELDS
        // 进度读数要单独请求：`EXTRACT_VIDEO_ID_FIELDS` 是**反查视频 ID** 的最小字段集，
        // 往里塞字节数会让另一处（恢复重建）多拿两个用不上的字段而无收益
        const progressFields = [...fields, 'totalLength', 'completedLength', 'downloadSpeed']
        const [actRes, stopRes] = await Promise.all([aria2API<Aria2Status[]>('aria2.tellActive', [progressFields]), aria2API<Aria2Status[]>('aria2.tellStopped', [0, 4096, progressFields])])
        const allTasks = [...(actRes.result ?? []), ...(stopRes.result ?? [])].filter((task) => isNullOrUndefined(task.bittorrent))

        // 按 videoId 分组（同一视频可能存在多个 gid：重复下载/重建残留）
        const groups = new Map<string, Aria2Status[]>()
        for (const task of allTasks) {
            const videoId = extractVideoIdFromTask(task)
            if (!videoId) {
                rejected++
                continue // 无 videoid 参数且路径无法反查（非本扩展添加）
            }
            const group = groups.get(videoId) ?? []
            group.push(task)
            groups.set(videoId, group)
        }

        await pruneDoneMap()
        const doneMap = await getDoneMap()

        for (const [videoId, group] of groups) {
            // 择优（源 `scanAria2TasksAndEnqueue` 的排序，已抽成纯函数）：
            // URL 过期时间最晚 → 状态最活联 → 队列已追踪。
            // **过期时间排第一**：重复/重建留下的多个同源任务里，地址快过期那个随时会 403。
            const queuedTask = findTaskByGids(group.map((task) => task.gid)) ?? getTasks().find((item) => item.videoId === videoId && item.kind === 'aria2')
            const winner = [...group].sort((a, b) => compareForKeep(a, b, queuedTask?.kindRef))[0]!
            for (const loser of group) {
                if (loser.gid === winner.gid) continue
                await stopRedundantTask(loser)
                stopped++
                if (queuedTask?.kindRef === loser.gid) await patchTask(queuedTask.id, { kindRef: winner.gid })
            }

            // ── 恢复：链接过期 / 暂停 / 慢速（源 `processAria2TrackTask` 的 active/paused/error 分支）──
            // 这三条必须在「同步终态」之前跑：error 任务此刻还不在队列里（或已在队列但标记 failed），
            // 先把它修好才能避免把一次可恢复的 403 当成终态失败。
            const recovered = await tryRecover(videoId, winner, queuedTask)
            if (recovered) continue

            if (queuedTask) {
                // 已在队列：除了 gid 修正，**还要把 aria2 的终态同步回队列**。
                // 旧实现这里直接 continue，于是「WS 断开期间下载完成」的任务会永远
                // 停在 running（实测：aria2 complete 106 MiB，队列仍是进行中），
                // 而这是 5 分钟一次的对账的唯一职责。
                const nextStatus = statusOfAria2(winner.status)
                if (nextStatus === 'complete' && queuedTask.status !== 'complete') await handleDownloadComplete(winner.gid)
                else if (nextStatus === 'failed' && queuedTask.status !== 'failed') await handleDownloadError(winner.gid)
                else await syncLiveState(queuedTask, winner, nextStatus)
                continue
            }
            if (doneMap[videoId] !== undefined && winner.status !== 'active' && winner.status !== 'waiting') {
                // 30 天内完成过的残留：停止并清结果，不入队。
                // ⚠️ 这里只停「本扩展自己的冗余任务」；不碰用户的历史完成记录（源 Issue #405 的教训）
                await stopRedundantTask(winner)
                stopped++
                continue
            }

            // 补入队（收编）：状态沿用 aria2 真实状态；complete 静默（原 alreadyComplete 语义）
            const task = await addTask({
                id: crypto.randomUUID(),
                videoId,
                kind: 'aria2',
                status: statusOfAria2(winner.status),
                kindRef: winner.gid
            })
            adopted++
            if (winner.status === 'complete') await markDone(videoId)
            if (winner.status === 'error') {
                task.detail = winner.errorMessage ?? i18n.t('notify.aria2AdoptedFailure')
                await syncTask(task)
            }
            console.info(`[iwara-assistant] aria2 现有任务已收编: ${videoId} (gid=${winner.gid}, ${winner.status})`)
        }
        console.info(`[iwara-assistant] aria2 扫描完成: 共 ${allTasks.length} 任务（收编 ${adopted}，停止冗余 ${stopped}，无主 ${rejected}）`)
    } catch (error) {
        console.warn('[iwara-assistant] aria2 扫描失败:', stringify(error))
    }
    return { adopted, stopped, rejected }
}

function findTaskByGids(gids: string[]): QueueTask | undefined {
    for (const gid of gids) {
        const task = findTask({ kindRef: gid, kind: 'aria2' })
        if (task) return task
    }
    return undefined
}

/**
 * 尝试恢复一个需要干预的任务（源 `processAria2TrackTask` 的 active/paused/error 分支）。
 *
 * 触发条件（全部来自源实现，判据在 `shared/aria2Recover.ts` 里单测过）：
 *
 * | aria2 状态 | 触发 | 手段 |
 * |---|---|---|
 * | `error` / `removed` | 链接过期/被移除（403 是典型） | `rebuildAria2Task`：restart→changeUri，失败才 addUri |
 * | `paused` | 用户手动暂停 / aria2 队列溢出 | `restartAria2Task`；队列满时**不动**（源同款守门） |
 * | `active` 且低速跨 2 次扫描 | 连接半死 | `restartAria2Task`；取不到新地址时不重启 |
 *
 * 为什么 error 一定要重解析而不是直接标 failed：iwara 直链带 `expires`，几小时后必然失效；
 * 不重解析就只剩「永远 failed + 用户重新勾选 → 又一条新任务」这条路，既丢进度又堆垃圾。
 *
 * 返回 `true` 表示「已处理」（调用方跳过本轮其余的终态同步/收编）。
 */
async function tryRecover(videoId: string, winner: Aria2Status, queuedTask: QueueTask | undefined): Promise<boolean> {
    // 低速观察窗口的记账：crossing 两次扫描仍低速才动手（见文件头「每任务 worker → WS 通知」）
    trackSlowObservation(videoId, winner)

    const needsRebuild = winner.status === 'error' || winner.status === 'removed'
    const needsRestart = winner.status === 'paused' || (winner.status === 'active' && shouldRestartForSlowSpeed(winner, slowSince.get(videoId), Date.now(), SLOW_SPEED_GRACE_MS))
    if (!needsRebuild && !needsRestart) return false

    // 恢复失败上限：超了就放弃（源弹「继续重试/取消」询问；后台没有页内交互，
    // 改为写 failed + 通知，用户可在任务面板手动重试——重试会清零计数）
    const attempts = recoverAttempts.get(videoId) ?? 0
    if (recoverExhausted(attempts)) {
        recoverAttempts.delete(videoId)
        slowSince.delete(videoId)
        if (queuedTask) {
            await patchTask(queuedTask.id, { status: 'failed', detail: i18n.t('notify.aria2RecoverFailed', { id: videoId }) })
            const failed = findTask({ id: queuedTask.id })
            if (failed) await notifyTask(failed)
        }
        return true
    }

    // paused 且 aria2 队列已满：不动（源同款）。aria2 的 paused 很可能就是并发上限导致的，
    // 此时重启只是把一个排队任务换成另一个排队任务，白烧一次解析请求。
    if (winner.status === 'paused' && (await isAria2QueueFull())) {
        console.debug(`[iwara-assistant] ${videoId} 暂停中且 aria2 队列已满，暂不恢复`)
        return true
    }

    const result = needsRebuild ? await rebuildAria2Task(winner.gid, videoId, winner) : await restartAria2Task(winner.gid, videoId, winner)
    if (!result) {
        recoverAttempts.set(videoId, attempts + 1)
        console.warn(`[iwara-assistant] ${videoId} 恢复失败（第 ${attempts + 1} 次），下轮再试`)
        // 返回 true：本轮不要再把它当终态上报（正在尝试修复）
        return true
    }

    recoverAttempts.delete(videoId)
    slowSince.delete(videoId)
    // gid 可能变了（`aria2.restart` 会返回新 gid）：不同步到队列，后续通知就全对不上
    if (queuedTask) await patchTask(queuedTask.id, { kindRef: result.gid, status: 'running' })
    else await addTask({ id: crypto.randomUUID(), videoId, kind: 'aria2', status: 'running', kindRef: result.gid })
    notifyInfo('aria2-recovered', i18n.t('notify.aria2Recovered', { id: videoId }), { kind: 'options', tab: 'tasks' })
    console.info(`[iwara-assistant] ${videoId} 已恢复下载 (${winner.status} → gid=${result.gid})`)
    return true
}

/**
 * 低速观察记账：把「第一次看到低速」的时间写进 `slowSince`，速度恢复或任务不在 active 就清掉。
 *
 * 单独一个函数是因为它必须**先于判定**执行（否则第一轮永远拿不到起点），
 * 而判定本身要求 `slowSince` 已存在——两件事写在一起很容易把顺序搅错。
 */
function trackSlowObservation(videoId: string, status: Aria2Status): void {
    if (status.status !== 'active') {
        slowSince.delete(videoId)
        return
    }
    const speed = Number(status.downloadSpeed)
    if (!Number.isFinite(speed) || speed > SLOW_SPEED_THRESHOLD) slowSince.delete(videoId)
    else if (!slowSince.has(videoId)) slowSince.set(videoId, Date.now())
}

/** 启动追踪：注册 WS 通知（实时主路径）+ 首轮扫描对账。boot 幂等（重复调用安全） */
export async function startAria2Tracking(): Promise<void> {
    if (!isAria2Configured()) return
    bindNotifications()
    await connect()
    await scanAria2TasksAndEnqueue()
}

/**
 * 端点/令牌变更后重启追踪。
 *
 * 两个真缺陷就发生在这里：
 * 1. `startAria2Tracking()` 以前在 `boot()` 里无条件下一次，用户改了 `aria2Path`
 *    之后后台内存里是新的地址，但**连接仍指向旧端点**（`connect()` 见连接就已连接就返回）；
 * 2. 通知处理器每次调用都重新注册，直接重入会让每个事件触发两次（双份通知/双份推送）。
 *
 * 所以：处理器只绑一次，重启只做「断开 + 重连 + 对账」。
 */
export async function restartAria2Tracking(): Promise<void> {
    if (!isAria2Configured()) return
    resetConnection()
    await startAria2Tracking()
}
/**
 * 端点指纹：只有 `aria2Path` / `aria2Token` 变了才需要重连——
 * 其他配置项（下载目录、代理、过滤开关）不影响 WS 连接。
 */
function endpointKey(config: { aria2Path: string; aria2Token: string }): string {
    return `${config.aria2Path}|${config.aria2Token}`
}

let trackedEndpoint = ''
let endpointWatchBound = false

/**
 * 记住当前端点，并在配置变化时按需重连（boot 调用一次，重复调用安全）。
 *
 * 放在本文件而不是 `index.ts`：重连是 aria2 后端自己的事，装配层不该知道
 * 「什么样的配置变化算端点变化」。
 */
export function watchAria2Endpoint(config: { aria2Path: string; aria2Token: string }): void {
    trackedEndpoint = endpointKey(config)
    if (endpointWatchBound) return
    endpointWatchBound = true
    browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return
        const change = changes[CONFIG_KEY]
        if (change === undefined) return
        void parseStoredConfig(change.newValue).then(async (next) => {
            const key = endpointKey(next)
            if (key === trackedEndpoint) return
            trackedEndpoint = key
            await restartAria2Tracking()
        })
    })
}
/** 事件处理器只绑一次（SW 重入时模块会重新求值，所以用模块级标记） */
let notificationsBound = false

function bindNotifications(): void {
    if (notificationsBound) return
    notificationsBound = true
    onNotification('aria2.onDownloadComplete', (params) => {
        const gid = payloadGid(params)
        if (gid) void handleDownloadComplete(gid)
    })
    onNotification('aria2.onBtDownloadComplete', (params) => {
        const gid = payloadGid(params)
        if (gid) void handleDownloadComplete(gid)
    })
    onNotification('aria2.onDownloadError', (params) => {
        const gid = payloadGid(params)
        if (gid) void handleDownloadError(gid)
    })
    onNotification('aria2.onDownloadStart', (params) => {
        const gid = payloadGid(params)
        if (gid) handleDownloadStart(gid)
    })
}

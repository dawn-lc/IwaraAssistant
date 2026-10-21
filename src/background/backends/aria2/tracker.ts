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
 * - **每任务 worker + 4 秒轮询 → WS 通知 + 分钟级探针 + 5 分钟扫描**
 *   - 源项目 active 时每 4 秒 `tellStatus`，慢速要连续 16 次（≈68 秒）
 *   - 本扩展的实时通道是 WS 通知（终态）+ `probe-aria2` 探针（1 分钟，只拉 `tellActive`，
 *     做慢速判定与进度回写）+ `scan-aria2` 对账（5 分钟，`tellStopped` 太重：实测 4.6 MB/次）
 *   - 慢速判定的「观察窗口」从「16 次 × 4s」改成「连续 2 次采样」，判据在
 *     `shared/aria2Recover.ts` 里单测；计数落 `storage.session`（否则 SW 每 30 秒回收一次，
 *     永远数不到 2 —— 2026-10-21 实测：该能力自移植以来一次都没触发过）
 * - **恢复能力保留**：`error` / `removed` / `paused` / 慢速 → 重解析换地址（同目录 `recover.ts`）。
 *   这是原版最重要的能力，丢了就等于「链接过期后只能重新下载一遍」。
 * - **完成态推送失败要重试**（源 `case 'complete'` 的 `pushFailedAt`）：本扩展交给
 *   `iwara/mediaCenterPushQueue.ts`，5 分钟一轮，但加了次数上限（源项目没有）。
 */
import { DONE_RECORD_TTL_DAYS } from '../../../shared/constants'
import { i18n } from '../../../shared/i18n'
import { isNullOrUndefined, stringify } from '../../../shared/strings'
import type { QueueTask } from '../../../shared/task'
import { ARIA2_SCAN_MEMORY_KEY, CONFIG_KEY } from '../../../shared/storageKeys'
import { emptyScanMemory, parseScanMemory, planAria2Group, aria2Progress, recoverExhausted, shouldRestartForSlowSpeed, isAria2GidMissingError, SLOW_SPEED_THRESHOLD, type Aria2ScanMemory } from '../../../shared/aria2Recover'
import { parseStoredConfig } from '../../storage/configStore'
import { addTask, findTask, getTasks, patchTask, notifyTask, syncTask, collapseDuplicateLiveTasks } from '../../storage/queue'
import { EXTRACT_VIDEO_ID_FIELDS, aria2API, aria2TellStatus, extractVideoIdFromTask, isAria2Configured, type Aria2Status } from './client'
import { connect, onNotification, resetConnection } from './ws'
import { pushAfterDownload, flushMediaCenterPushes } from '../../iwara/mediaCenterPushQueue'
import { isAria2QueueFull, rebuildAria2Task, restartAria2Task, type RecoverResult } from './recover'
import { notifyInfo } from '../../runtime/notify'

/**
 * 慢速观察的跨轮记忆（videoId → 累计连续低速采样次数）。
 *
 * ⚠️ **必须落存储，不能只用模块级 Map**：Chrome MV3 的 service worker 空闲约 30 秒
 * 就被回收，而扫描是 5 分钟一次——每次扫描都是全新的 SW 实例。只存内存的话
 * 「连续 2 次扫描都低速」永远数不到 2，整个慢速恢复能力形同不存在
 * （2026-10-21 实测：自移植以来从未触发过一次）。
 *
 * 用 `storage.session`：跨 SW 实例存活，浏览器退出即清空（观察状态属于本次会话）。
 */
let scanMemory: Aria2ScanMemory = emptyScanMemory()

/** 读回上一轮扫描留下的计数（脏值由 `parseScanMemory` 丢弃） */
async function loadScanMemory(): Promise<void> {
    try {
        const stored = await browser.storage.session.get(ARIA2_SCAN_MEMORY_KEY)
        scanMemory = parseScanMemory(stored?.[ARIA2_SCAN_MEMORY_KEY])
    } catch (error) {
        // storage.session 不可用（老版本宿主）：退化为内存态，功能降级但不影响扫描本身
        console.warn('[iwara-assistant] 读取 aria2 扫描记忆失败，本轮按空计数处理:', stringify(error))
        scanMemory = emptyScanMemory()
    }
}

/** 写回本轮计数，供 5 分钟后的下一次扫描（可能是新 SW 实例）继续累计 */
async function saveScanMemory(): Promise<void> {
    try {
        await browser.storage.session.set({ [ARIA2_SCAN_MEMORY_KEY]: scanMemory })
    } catch (error) {
        console.warn('[iwara-assistant] 保存 aria2 扫描记忆失败:', stringify(error))
    }
}

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
 * 扫描/探测统一取的字段集。
 *
 * `EXTRACT_VIDEO_ID_FIELDS` 是**反查视频 ID** 的最小集（恢复重建也用它）；
 * 进度读数要额外带上三个字节数。合成一份，避免两条路径各写一遍还写歪。
 */
const PROGRESS_FIELDS = [...EXTRACT_VIDEO_ID_FIELDS, 'totalLength', 'completedLength', 'downloadSpeed']

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
        // 推送失败会登记待重试（源 `aria2Track` 的 complete 分支：失败不放弃，5 分钟后重试）
        await pushAfterDownload(task.videoId, task.filename)
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

/**
 * 停止一个**活跃**副本（它真的在抢带宽、抢同一个输出文件）。
 *
 * 先 `remove` 再 `removeDownloadResult`：只 remove 会留下 stopped 记录，
 * 下轮扫描会把它当「另一个同源任务」重新收编（死循环）。
 */
async function stopLiveCopy(task: Aria2Status): Promise<void> {
    try {
        await aria2API('aria2.remove', [task.gid])
    } catch {
        // 可能已被移除
    }
    try {
        await aria2API('aria2.removeDownloadResult', [task.gid])
    } catch {
        // 结果条目可能已被清
    }
}

/**
 * 清理一个**僵尸**副本（`error` / `removed`）的结果记录。
 *
 * 只清结果、不 remove：这两种状态已经不在活动队列里，没有东西可停。
 * 清掉的目的是避免下轮扫描把我们自己重建留下的错误记录反复拾回来。
 */
async function discardGarbageCopy(task: Aria2Status): Promise<void> {
    try {
        await aria2API('aria2.removeDownloadResult', [task.gid])
    } catch {
        // 结果条目可能已清
    }
}

/** 扫描 aria2 现有任务对账（原 scanAria2TasksAndEnqueue 精简移植） */
export async function scanAria2TasksAndEnqueue(): Promise<{ adopted: number; stopped: number; rejected: number; lost: number }> {
    let adopted = 0
    let stopped = 0
    let rejected = 0
    let lost = 0
    if (!isAria2Configured()) return { adopted, stopped, rejected, lost }
    // 计数必须跨轮累计（Chrome SW 空闲 30s 就回收，扫描 5min 一次 → 每次都是新实例）
    await loadScanMemory()
    try {
        const [actRes, stopRes] = await Promise.all([aria2API<Aria2Status[]>('aria2.tellActive', [PROGRESS_FIELDS]), aria2API<Aria2Status[]>('aria2.tellStopped', [0, 4096, PROGRESS_FIELDS])])
        const allTasks = [...(actRes.result ?? []), ...(stopRes.result ?? [])].filter((task) => isNullOrUndefined(task.bittorrent))

        // 队列内去重：同一视频的多条活跃记录只留一条。
        // 用 `tellActive` 的 gid 作判据 —— 「真正在下的那条」应该被保留，
        // 而不是靠 timeStamp 猜（一条 queued 可能比真正在下的 running 更新）。
        const liveGids = new Set((actRes.result ?? []).map((task) => task.gid))
        await collapseDuplicateLiveTasks(liveGids)

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
            // 同一 videoId 的多个 gid 怎么处置（判据在 `planAria2Group`，已单测）：
            // 活副本停止 + 清结果 / 僵尸副本只清结果 / **complete 历史记录绝不触碰**。
            // 旧实现把三类一律当冗余，`stopRedundantTask` 无条件 `removeDownloadResult`——
            // 用户每重下一次以前下过的视频，就把自己 aria2 里那条完成历史删掉（源 Issue #405）。
            const queuedTask = findTaskByGids(group.map((task) => task.gid)) ?? getTasks().find((item) => item.videoId === videoId && item.kind === 'aria2')
            const plan = planAria2Group(group, queuedTask?.kindRef)
            if (!plan) continue
            const winner = plan.winner
            for (const loser of plan.liveLosers) {
                await stopLiveCopy(loser)
                stopped++
                if (queuedTask?.kindRef === loser.gid) await patchTask(queuedTask.id, { kindRef: winner.gid })
            }
            for (const loser of plan.garbageLosers) {
                await discardGarbageCopy(loser)
                stopped++
                if (queuedTask?.kindRef === loser.gid) await patchTask(queuedTask.id, { kindRef: winner.gid })
            }
            if (plan.historyLosers.length > 0) {
                // 历史记录：只记日志，不发任何 RPC
                console.debug(`[iwara-assistant] aria2 ${videoId} 保留 ${plan.historyLosers.length} 条完成历史（不清理）`)
            }

            // ── 恢复：链接过期 / 暂停 / 慢速（源 `processAria2TrackTask` 的 active/paused/error 分支）──
            // 这三条必须在「同步终态」之前跑：error 任务此刻还不在队列里（或已在队列但标记 failed），
            // 先把它修好才能避免把一次可恢复的 403 当成终态失败。
            //
            // ⚠️ **只对本扩展追踪中的任务做恢复**。源项目的分工是：扫描只负责「择优 / 停冗余 / 入队」，
            // 恢复跑在**每个任务自己的 worker** 里（`processAria2TrackTask`），只有已入队的任务才有 worker。
            // 早先这里不判 `queuedTask`，于是 aria2 里每一条 error 任务每轮扫描都会被 `addUri` 重建一次 →
            // aria2 里多出第二个同源任务 → 下轮扫描把它判成「冗余」`remove` + `removeDownloadResult` →
            // 再重建……实测出现 1 分半内 150+ 条 RPC（大量 `removeDownloadResult` 回
            // `GID xxx is not found`）。未入队的任务由下面的收编流程按真实状态落库，再走正常重试路径。
            const recovered = queuedTask ? await tryRecover(videoId, winner, queuedTask) : false
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
                // 30 天内完成过的残留：**只跳过入队，绝不清理 aria2 侧记录**。
                // 去重表职责是「防重复处理」，不是「删除历史」——完成/失败记录由用户自己管理。
                // 源项目曾把这里误改成 removeRedundantAria2Task 清结果，导致用户的 aria2 历史被脚本
                // 静默删除（其 Issue #405），注释与实现都保留这条教训。
                console.debug(`[iwara-assistant] aria2 ${videoId} 30 天内已完成，跳过残留任务 ${winner.gid}(${winner.status})`)
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

        // ── 反向对账：队列里仍活跃、但 aria2 已查不到的任务 ──
        // 上面的循环只遍历「aria2 里存在的任务」，所以 gid 被 aria2 滚出结果记录
        // （`max-download-result` 上限）或 aria2 重启过之后，队列里那条 running 就再没人管：
        // 实测留下一条 10 小时前仍显示「下载中（aria2 实时）」的僵尸任务。
        //
        // 判据用 tellStatus 的权威答复，且**只认** `GID ... is not found`：
        // 传输失败（抛异常）什么都不说明，留到下一轮——把「连不上」当成「任务没了」
        // 会让 aria2 重启一次就把所有在跑的任务误判成失败。
        const seenGids = new Set(allTasks.map((item) => item.gid))
        for (const zombie of getTasks()) {
            if (zombie.kind !== 'aria2') continue
            if (zombie.status !== 'running' && zombie.status !== 'queued') continue
            const gid = zombie.kindRef
            if (!gid || seenGids.has(gid)) continue
            try {
                const res = await aria2API<Aria2Status>('aria2.tellStatus', [gid, ['gid', 'status']])
                if (!isAria2GidMissingError(res.error)) continue
            } catch (error) {
                console.warn(`[iwara-assistant] aria2 ${zombie.videoId} 的 gid 查询失败，本轮跳过:`, stringify(error))
                continue
            }
            if (doneMap[zombie.videoId] !== undefined) {
                // 30 天内完成过：gid 没了但文件确实下好了，收敛成 complete 而不是失败
                await patchTask(zombie.id, { status: 'complete' })
                console.info(`[iwara-assistant] aria2 ${zombie.videoId} 的 gid 已被清理，但 30 天内完成过，收敛为 complete`)
            } else {
                await patchTask(zombie.id, { status: 'failed', detail: i18n.t('notify.aria2TaskMissing', { id: zombie.videoId }) })
                const failed = findTask({ id: zombie.id })
                if (failed) await notifyTask(failed)
                console.warn(`[iwara-assistant] aria2 ${zombie.videoId} 的 gid ${gid} 在 aria2 中已不存在，标为失败`)
            }
            lost++
        }
        console.info(`[iwara-assistant] aria2 扫描完成: 共 ${allTasks.length} 任务（收编 ${adopted}，停止冗余 ${stopped}，无主 ${rejected}，失效 ${lost}）`)
    } catch (error) {
        console.warn('[iwara-assistant] aria2 扫描失败:', stringify(error))
    } finally {
        // 无论中途怎么退出都要写回：漏写会让「连续 N 次低速」永远从 1 重新开始
        await saveScanMemory()
        // 终态收敛后可能已经没有活跃任务：让探测 alarm 自行退场
        await syncAria2ProbeAlarm()
    }
    // MediaCenter 推送重试：5 分钟一轮，与源项目的重试间隔一致
    await flushMediaCenterPushes()
    return { adopted, stopped, rejected, lost }
}

function findTaskByGids(gids: string[]): QueueTask | undefined {
    for (const gid of gids) {
        const task = findTask({ kindRef: gid, kind: 'aria2' })
        if (task) return task
    }
    return undefined
}

// ── 轻量探测：慢速判定 + 进度回写的实时通道 ──────────────────────────

/**
 * 活跃任务探测的 alarm 名（**按需创建**：队列里没有 aria2 活跃任务时它不存在）。
 *
 * 与 iwaradl 的 `scan-iwaradl` 同一套思路——常驻 1 分钟的 alarm 会让 SW 每分钟醒一次，
 * 哪怕一条任务都没有。
 */
export const ARIA2_PROBE_ALARM = 'probe-aria2'

/**
 * 探测周期（分钟）。
 *
 * 源项目在页面里**每任务一个 worker、active 时 4 秒 poll 一次**，慢速要连续 16 次
 * （≈68 秒）才动手；本扩展没有页内 worker，只能靠定时器采样。若沿用 5 分钟的
 * `scan-aria2` 做唯一采样源，`MIN_SLOW_POLLS=2` 意味着**10 分钟**才判一次慢速——
 * 用户会觉得「这功能没生效」。
 *
 * 为什么不是把 `scan-aria2` 直接提到 1 分钟：实测一次 `tellStopped(0, 4096)` 返回
 * **4.6 MB**（442 条结果、每条 16 个 uri），1 分钟一次就是 6.6 GB/天；而
 * `tellActive` 在没有活跃任务时只有 38 字节。慢速判定只需要「正在下载的任务」，
 * 所以单独用一条只拉 `tellActive` 的轻通道，2 次采样 ≈ 2 分钟。
 */
export const ARIA2_PROBE_PERIOD_MIN = 1

/** 队列里是否有需要盯的 aria2 任务（决定要不要开探测 alarm） */
export function hasActiveAria2Tasks(): boolean {
    return getTasks().some((task) => task.kind === 'aria2' && (task.status === 'running' || task.status === 'queued'))
}

/** 按当前队列对齐探测 alarm 的存在性（幂等：已存在则不动，避免不断重置计时） */
export async function syncAria2ProbeAlarm(): Promise<void> {
    const needed = isAria2Configured() && hasActiveAria2Tasks()
    const existing = await browser.alarms.get(ARIA2_PROBE_ALARM).catch(() => undefined)
    if (needed && !existing) {
        await browser.alarms.create(ARIA2_PROBE_ALARM, { periodInMinutes: ARIA2_PROBE_PERIOD_MIN })
        return
    }
    if (!needed && existing) await browser.alarms.clear(ARIA2_PROBE_ALARM)
}

/**
 * 轻量探测：只拉 `tellActive`，做「进度回写 + 慢速恢复」。
 *
 * 与 `scanAria2TasksAndEnqueue` 的分工（同源项目 worker 与 scan 的分工）：
 * - 这里 = worker 的高频轮询：只看正在跑的任务，判慢速、回写进度；
 * - scan = 对账：择优/停冗余/收编外部任务/同步终态（5 分钟）。
 *
 * 不做择优与停冗余：`tellActive` 只有 active 任务，同 videoId 的 waiting/error 副本
 * 不在这个视图里，判「冗余」会误杀。
 */
export async function probeAria2SlowTasks(): Promise<void> {
    if (!isAria2Configured()) return
    // 队列里没有活跃任务时直接返回：省掉一次 RPC，也让 alarm 能自行收敛（见 syncAria2ProbeAlarm）
    if (!hasActiveAria2Tasks()) {
        await syncAria2ProbeAlarm()
        return
    }
    await loadScanMemory()
    try {
        const res = await aria2API<Aria2Status[]>('aria2.tellActive', [PROGRESS_FIELDS])
        for (const status of res.result ?? []) {
            if (status.status !== 'active') continue
            const videoId = extractVideoIdFromTask(status)
            if (!videoId) continue
            const queuedTask = findTask({ kindRef: status.gid, kind: 'aria2' }) ?? getTasks().find((item) => item.videoId === videoId && item.kind === 'aria2')
            // 只处理本扩展追踪中的任务：未入队的由 scan 收编后走正常流程
            if (!queuedTask) continue
            const recovered = await tryRecover(videoId, status, queuedTask)
            if (recovered) continue
            await syncLiveState(queuedTask, status, 'running')
        }
    } catch (error) {
        console.warn('[iwara-assistant] aria2 活跃任务探测失败:', stringify(error))
    } finally {
        await saveScanMemory()
    }
}

/**
 * 尝试恢复一个需要干预的任务（源 `processAria2TrackTask` 的 active/paused/error 分支）。
 *
 * 触发条件（全部来自源实现，判据在 `shared/aria2Recover.ts` 里单测过）：
 *
 * | aria2 状态 | 触发 | 手段 |
 * |---|---|---|
 * | `error` / `removed` | 链接过期/被移除（403 是典型） | `rebuildAria2Task`：原地换地址，失败才 addUri |
 * | `paused` | 用户手动暂停 / aria2 队列溢出 | `restartAria2Task`；队列满时**不动**（源同款守门） |
 * | `active` 且连续 2 次扫描低速 | 连接半死 | `restartAria2Task`；失败降级 `rebuildAria2Task`（源同款「绝不静默放弃」） |
 *
 * 为什么 error 一定要重解析而不是直接标 failed：iwara 直链带 `expires`，几小时后必然失效；
 * 不重解析就只剩「永远 failed + 用户重新勾选 → 又一条新任务」这条路，既丢进度又堆垃圾。
 *
 * 返回 `true` 表示「已处理」（调用方跳过本轮其余的终态同步/收编）。
 */
async function tryRecover(videoId: string, winner: Aria2Status, queuedTask: QueueTask | undefined): Promise<boolean> {
    // 并发闸门：轻量探测（1 分钟）与对账扫描（5 分钟）是两条独立定时器，同一时刻
    // 命中同一个任务时，会重复解析 + 重复 changeUri（第二次用已被替换的旧 URI 列表，
    // aria2 只删得掉 0 条，反而把新地址又追加一遍）。已经在处理就当作「本轮已处理」。
    if (recovering.has(videoId)) return true
    recovering.add(videoId)
    try {
        return await recoverCore(videoId, winner, queuedTask)
    } finally {
        recovering.delete(videoId)
    }
}

/**
 * 正在恢复中的任务（进程内）。只用于拦住「两条定时器撞车」这种瞬时重叠，
 * 不需要持久化：SW 被回收时在途的恢复进程本身也一起没了。
 */
const recovering = new Set<string>()

async function recoverCore(videoId: string, winner: Aria2Status, queuedTask: QueueTask | undefined): Promise<boolean> {
    // 低速采样记账：本轮 +1（速度恢复/离开 active 时清零），返回值含本轮
    const slowPolls = trackSlowObservation(videoId, winner)

    const needsRebuild = winner.status === 'error' || winner.status === 'removed'
    const needsRestart = winner.status === 'paused' || (winner.status === 'active' && shouldRestartForSlowSpeed(winner, slowPolls))
    if (!needsRebuild && !needsRestart) return false

    // 恢复失败上限：超了就放弃（源弹「继续重试/取消」询问；后台没有页内交互，
    // 改为写 failed + 通知，用户可在任务面板手动重试——重试会清零计数）
    const attempts = scanMemory.recoverAttempts[videoId] ?? 0
    if (recoverExhausted(attempts)) {
        delete scanMemory.recoverAttempts[videoId]
        delete scanMemory.slowPolls[videoId]
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

    // 原地换地址优先；**只有「拿到了新地址但换不上去」才降级重建**。
    // 重新解析失败时绝不能降级：那会走「用旧地址 addUri」→ 给正在跑的任务再造一个副本，
    // 抢写同一文件并丢掉已下字节（2026-10-21 实测：87 个真实任务被这样复制）。
    let result: RecoverResult | undefined
    if (needsRebuild) {
        result = await rebuildAria2Task(winner.gid, videoId, winner)
    } else {
        const outcome = await restartAria2Task(winner.gid, videoId, winner)
        if (outcome.kind === 'ok') result = outcome.result
        else if (outcome.kind === 'uri-change-failed') {
            console.warn(`[iwara-assistant] ${videoId} 原地恢复失败，降级为重建任务`)
            result = await rebuildAria2Task(winner.gid, videoId, winner)
        } else {
            // 解析失败 ≠ 恢复失败：不该计入重试上限，否则未登录时 8 轮（约 40 分钟）后
            // 所有慢速任务都会被标成 failed——而它们其实还在慢慢下。
            // 清空采样计数 = 下一轮重新累计（相当于 10 分钟冷却），避免每轮都打一次解析请求。
            delete scanMemory.slowPolls[videoId]
            console.warn(`[iwara-assistant] ${videoId} 重新解析失败，本轮跳过恢复（旧地址换旧地址没有意义）`)
            return true
        }
    }
    if (!result) {
        scanMemory.recoverAttempts[videoId] = attempts + 1
        console.warn(`[iwara-assistant] ${videoId} 恢复失败（第 ${attempts + 1} 次），下轮再试`)
        // 返回 true：本轮不要再把它当终态上报（正在尝试修复）
        return true
    }

    // ⚠️ 恢复「成功」不等于任务活了：换地址只保证 aria2 接受了新 URI，连接本身可能仍然不通
    // （实测：5 个任务 0/0、speed 0，换完地址依旧如此）。若成功后清零计数，就会退化成
    // 「每 2 分钟解析一次 iwara + 换一次地址」的无限循环。
    // 所以这里**累加**而不是清零；只有观测到速度真的恢复（`trackSlowObservation`）才清。
    scanMemory.recoverAttempts[videoId] = attempts + 1
    delete scanMemory.slowPolls[videoId]
    // gid 可能变了（error/removed 走 addUri 重建）：不同步到队列，后续通知就全对不上
    if (queuedTask) await patchTask(queuedTask.id, { kindRef: result.gid, status: 'running' })
    else await addTask({ id: crypto.randomUUID(), videoId, kind: 'aria2', status: 'running', kindRef: result.gid })
    notifyInfo('aria2-recovered', i18n.t('notify.aria2Recovered', { id: videoId }), { kind: 'options', tab: 'tasks' })
    console.info(`[iwara-assistant] ${videoId} 已恢复下载 (${winner.status} → gid=${result.gid}，第 ${attempts + 1} 次尝试)`)
    return true
}

/**
 * 低速采样记账：把「连续第几次观察到低速」累加进 `scanMemory.slowPolls`，
 * 速度恢复或任务不在 active 就清掉。返回**含本轮**的计数。
 *
 * 单独一个函数是因为它必须**先于判定**执行（否则第一轮永远拿不到计数），
 * 而判定本身要求计数已累计——两件事写在一起很容易把顺序搅错。
 */
function trackSlowObservation(videoId: string, status: Aria2Status): number {
    const table = scanMemory.slowPolls
    const speed = Number(status.downloadSpeed)
    if (status.status === 'active' && Number.isFinite(speed) && speed > SLOW_SPEED_THRESHOLD) {
        // 速度真的恢复了：说明之前的恢复生效，才清掉尝试计数
        delete table[videoId]
        delete scanMemory.recoverAttempts[videoId]
        return 0
    }
    if (status.status !== 'active') {
        // 离开 active 不算「恢复生效」（error/removed 也不会自己变快），只清采样链
        delete table[videoId]
        return 0
    }
    const polls = (table[videoId] ?? 0) + 1
    table[videoId] = polls
    return polls
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

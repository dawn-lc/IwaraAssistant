/**
 * 列表入库与批量遍历 —— 从页面缓存与站内 API 两条路把视频记录写进本地库
 *
 * - ingestPageVideos：页面缓存列表入库（列表页上报的当前页 RAW）+ 回填列表重算
 * - startSiteSync：启动一次遍历并**立即返回**（fire-and-forget，见下文）
 * - runAllVideos：全站视频列表逐页遍历（sort=date）
 * - runSubscribed：订阅流逐页遍历，收集本月的私有/不公开视频；命中当月库内已有
 *   私有视频后提前结束（原版终止语义）
 *
 * 三条路共用 `upsertVideos`（partial 不降级 full），差异只在数据来源。
 * 与原版的差异：跨页互斥锁/心跳删除（后台是唯一执行者，用模块级 running 防重入）；
 * 进度写 storage.local（options 任务页可读），每页一次写入同时充当 SW 保活活动。
 *
 * ## 遍历为什么不能挂在消息响应里（Chrome 的 5 分钟单事件上限）
 *
 * 全站遍历是「几千页 × 0.5~1.5s 间隔」，一小时量级。Chrome 对**单个事件**有 5 分钟上限
 * （它与「30 秒空闲回收」是两条独立的终止条件：空闲回收可以被任何一次扩展 API 调用重置，
 * 5 分钟则是硬上限），到期直接终止 service worker——任务连同模块变量一起消失，
 * 而页面那边 `await send()` 的 promise 永远不会 resolve。
 *
 * 所以 `startSiteSync()` **只占位并立即返回**，遍历在后台自己跑；`SYNC_ALL_VIDEOS` /
 * `SYNC_SUBSCRIBED` 的返回值因此是 `{ started, reason? }` 而不是遍历结果。
 * 任务跑起来之后就不再受那条上限约束：每页 `report()`（扩展 API 调用）与 fetch 都重置
 * 30 秒空闲计时器，而实际间隔最长也只有失败退避的 5~6 秒。
 *
 * 代价是「进程被杀」不再由消息链路兜底（浏览器关闭 / 扩展更新 / 系统休眠都会杀），
 * 因此需要 `settleInterruptedSync()` 在下次启动时把「存储说在跑、内存没任务」判为中断。
 * 这不是可以在代码里消除的：MV3 没有常驻后台，保活（`runtime/keepAlive.ts`）只能推迟
 * 空闲回收，不能阻止终止。
 *
 * ## 断点续跑：只给「全站遍历」，只用「连续完成」的页
 *
 * 全站遍历是小时级，被杀一次就从第 0 页重来等于把几十分钟的请求全部作废（几千页 × 0.5~1.5s）。
 * 所以每成功处理一页就把**游标**写进 `storage.session`（浏览器退出即清空——跨会话的游标会
 * 指向几天前的页码，那期间的新投稿恰好落在被跳过的那段）。三条纪律：
 *
 * 1. 游标只推进到**连续完成**的位置（`advanceSyncCursor`）：某页失败后循环会 `continue`
 *    去跑下一页，按「最大已处理页 + 1」推进会把失败那页永久漏掉且用户毫无察觉。
 * 2. 游标**只在自然收尾时**按「还有没有缺页」决定删或留；被打断的那一轮必须留着——
 *    它正是下次续跑的起点。
 * 3. `restart` 在开跑前删游标，否则这一轮从第 0 页跑完、游标还指着旧位置。
 *
 * 订阅流**不给游标**：它由到达 `/videos` 自动触发、最小间隔 5 分钟、追平当月就停，
 * 接一个游标进去只会让「自动触发」与「接着上次」两套判据互相打架。
 */
import { apiUrl } from '../../shared/site'
import { i18n } from '../../shared/i18n'
import { AUTO_SYNC_AT_KEY, RATING_KEY, SYNC_CURSOR_KEY, SYNC_PROGRESS_KEY } from '../../shared/storageKeys'
import { isAutoSyncDue, shouldAutoSyncSubscribed } from '../../shared/autoSync'
import { advanceSyncCursor, IDLE_SYNC_CURSOR, IDLE_SYNC_STATE, parseSyncCursor, parseSyncState } from '../../shared/syncState'
import type { SyncCursor, SyncKind, SyncState } from '../../shared/syncState'
import { getAuth, isLoggedIn } from './auth'
import { defaultWindow, getConfig, refreshCacheInjection } from '../storage/configStore'
import { db } from '../storage/db'
import { parseCacheVideo } from '../storage/parse'

export type { SyncKind, SyncState }

/** 每页条数（源 `data/site.json` 的 `pageLimit`） */
const PAGE_LIMIT = 50
/** 订阅流最多向前找多少页（源 `maxFindPages`） */
const MAX_FIND_PAGES = 64
/** 页间隔（源 `delay(500 + Math.random() * 1000)`；失败页单独 5s 退避） */
const PAGE_INTERVAL_MS = 500
/** 失败页退避（源 `delay(5000 + Math.random() * 1000)`）：连续报错往往是被限流，快重试只会延长封禁 */
const FAILED_PAGE_BACKOFF_MS = 5000
/**
 * 订阅流连续失败多少页就中止。
 *
 * 订阅流遍历现在会被**自动触发**（到达 `/videos` 时），而它的失败原因几乎都是全局的
 * （掉登录 / 网络断 / 被限流）——这些情况下继续翻满 64 页只是把 64 个必然失败的请求打出去，
 * 既救不回数据又延长封禁。3 页已经足够区分「偶发单页抽风」和「整条链路坏了」。
 */
const MAX_CONSECUTIVE_FAILURES = 3
const MONTH_MS = 30 * 24 * 60 * 60 * 1000
/** 失败页重试轮数（源就一遍：首轮全跑完再逐页补一次，不循环重试） */
const MAX_PAGE_RETRIES = 1

/**
 * 内存里的遍历任务。**这是「是否真在跑」的唯一真相**：任务与它的运行状态死在同一个进程里
 * （SW 被回收 / 浏览器关闭），所以持久层里的 `running: true` 只可能是残骸。
 */
let running = false

/**
 * 用户对当前这一轮的控制意图（**内存态**，与任务同生共死）。
 *
 * 为什么不能只看持久层里的 paused：那是「给别人看的快照」，进程重启后它与真任务无关；
 * 而这里是循环真正读的那个变量。两者由 patchSnapshot 单向同步（内存 → 快照），
 * 永不反向读——否则一次崩溃残留的 paused: true 会让下一轮一开跑就自我暂停。
 */
let control: 'run' | 'pause' | 'stop' = 'run'

/** 暂停时用来唤醒循环的 resolver（resume 与 stop 都会调它） */
let wake: (() => void) | null = null

/**
 * 暂停期间的续命间隔。
 *
 * MV3 只会在**空闲 30 秒**后回收 SW（「单个事件 5 分钟」是另一条，管的是事件处理），
 * 而不忙任何扩展 API 的暂停恰好就是空闲。所以暂停期间每 20 秒做一次 storage.local.get：
 * 这不是「保活插件在后台赖着」，而是用户主动按了暂停、界面必须能真的停在那一页。
 * （alarms 做不到：它只会事后唤醒**一个全新的** SW，内存里的循环早没了。）
 */
const PAUSE_HEARTBEAT_MS = 20_000

/** 启动遍历的结果。**不含遍历结果**——那是快照的职责（理由见文件头）。 */
export interface SyncStartResult {
    started: boolean
    reason?: 'already-running' | 'not-logged-in'
}

/**
 * 从哪开始。
 *
 * `resume`：接着断点游标（没有游标就等于从头）——这是默认值，因为「上次跑到一半被杀」
 * 是这类小时级任务最常见的结局；`restart`：删掉游标、从第 0 页重来，供用户显式选择
 * （例如想重扫一遍前几页的遗漏，或者站点结构变了他想从头对一遍）。
 */
export type SyncFrom = 'resume' | 'restart'

/**
 * 启动一次遍历并**立即返回**（fire-and-forget）。
 *
 * `running` 必须在第一个 await 之前同步占位：连点两次按钮时第二次要能被立刻拒掉，
 * 否则两条循环同时翻页，同一页写两遍、进度还会互相覆盖。
 */
export async function startSiteSync(kind: SyncKind, from: SyncFrom = 'resume'): Promise<SyncStartResult> {
    if (running) return { started: false, reason: 'already-running' }
    running = true
    // 上一轮可能停在 pause/stop 上：新一轮必须从干净的控制态开始
    control = 'run'
    wake = null

    let loggedIn = false
    try {
        loggedIn = await isLoggedIn()
    } catch {
        loggedIn = false
    }
    if (!loggedIn) {
        running = false
        await report({ ...IDLE_SYNC_STATE, message: i18n.t('notify.notLoggedIn') })
        return { started: false, reason: 'not-logged-in' }
    }

    // 起点在**真正开跑之前**确定：`restart` 要先把游标删掉，
    // 否则这一轮从第 0 页跑、游标却还指着旧位置，下次「继续」又跳回去。
    // 订阅流不接游标（理由见 shared/syncState.ts 的 SyncCursor）。
    let startPage = 0
    if (kind === 'all') {
        if (from === 'restart') await clearSyncCursor()
        else startPage = (await readSyncCursor()).nextPage
    }

    // 不 await：见文件头的 5 分钟上限。异常只记日志——快照里已经写着停在哪一页、
    // 失败原因是什么，界面据此如实显示，比一个 reject 的消息更有用。
    void (kind === 'all' ? runAllVideos(startPage) : runSubscribed()).catch((error: unknown) => {
        console.error('[iwara-assistant] 遍历异常终止：', error instanceof Error ? error.message : error)
    })
    return { started: true }
}

/**
 * 收尾：**先把终态写进快照，再释放内存标记**。
 *
 * 顺序反了会有一个「内存已空、存储仍写 running」的窗口，下一次 boot 的残骸归一会把
 * 刚跑完的那次判成「被中断」（与 MediaCenter 同步同一条不变量）。
 */
async function settleRun(state: SyncState): Promise<void> {
    state.running = false
    state.kind = null
    delete state.paused
    await report(state)
    running = false
    // 复位控制意图：否则残留的 pause 会让下一轮一开跑就自我暂停
    control = 'run'
    wake = null
}

/**
 * 残骸归一：存储说在跑、而本进程没有任务 ⇒ 上一次遍历被进程终止打断。
 *
 * 只在 `boot()` 里调用（每次 SW 冷启动恰好一次）。判定靠**不变量**而不是心跳超时：
 * 遍历期间每页都有写入，用「N 秒没更新算死」永远分不清「在跑但页面慢」与「已经死了」。
 * 与好友审批 / MediaCenter 同一条判据，只是这里没有消息通道可问，只能靠 boot 的时机。
 */
export async function settleInterruptedSync(): Promise<void> {
    // 消息可能先于 boot 的后半段到达并已经起了一条遍历，那不是残骸
    if (running) return
    const snapshot = parseSyncState((await browser.storage.local.get(SYNC_PROGRESS_KEY))[SYNC_PROGRESS_KEY])
    if (!snapshot || !snapshot.running) return
    // 中断位置全站遍历取**游标**（连续完成到哪一页），订阅流没有游标、只能报「跑到第几页」
    const resumePage = snapshot.kind === 'all' ? (await readSyncCursor()).nextPage : snapshot.page
    await report({ ...snapshot, running: false, kind: null, message: i18n.t('notify.syncInterrupted', { page: resumePage, ok: snapshot.succeeded, failed: snapshot.failed }) })
}

async function report(state: SyncState): Promise<void> {
    await browser.storage.local.set({ [SYNC_PROGRESS_KEY]: { ...state, updatedAt: Date.now() } })
}

export type SyncControlAction = 'pause' | 'resume' | 'stop'

export interface SyncControlResult {
    applied: boolean
    reason?: 'not-running'
}

/**
 * 暂停 / 继续 / 停止当前这一轮遍历。
 *
 * 只改**意图**并立刻把状态写进快照，真正生效在页间闸门（awaitControl）上——
 * 一页的请求已经在飞，硬取消它既救不回时间，也会让游标与「已处理」集合对不上。
 * 停止与暂停的区别：停止让循环跑到闸门就收尾（保留游标，下次「继续」从断点起），
 * 暂停只是停在那里等人。
 *
 * 没有任务在跑时返回 not-running：界面上这两颗按钮只在 running 时出现，能落到这条分支的
 * 是「点下去的同时任务刚好跑完」，如实回给页面而不是假装成功。
 */
export async function controlSiteSync(action: SyncControlAction): Promise<SyncControlResult> {
    if (!running) return { applied: false, reason: 'not-running' }
    control = action === 'resume' ? 'run' : action
    wake?.()
    wake = null
    await patchSnapshot({ paused: action === 'pause' }).catch(() => undefined)
    return { applied: true }
}

/**
 * 把补丁写进当前快照（只读现有快照，不猜字段）。
 *
 * 循环里的 state 对象是闭包私有的，控制入口拿不到它；而快照里恰好有页面/计数/文案。
 * 读不到快照说明这一轮还没写过（或 storage 不可用）——那就什么都不做，绝不凭空造一份。
 */
async function patchSnapshot(patch: { paused?: boolean }): Promise<void> {
    const stored = parseSyncState((await browser.storage.local.get(SYNC_PROGRESS_KEY))[SYNC_PROGRESS_KEY])
    if (!stored) return
    const next: SyncState = { ...stored }
    if (patch.paused === true) next.paused = true
    else delete next.paused
    await report(next)
}

/**
 * 页间闸门：暂停时在这里等，用户点停止则返回 false。
 *
 * 返回 false 的调用点必须以「被用户停止」收尾：**不能**走自然结束那条路（那里会删游标），
 * 否则「停在 N 页、下次继续」这句话立刻变成假话。
 */
async function awaitControl(): Promise<boolean> {
    if (control === 'pause') {
        await patchSnapshot({ paused: true }).catch(() => undefined)
        while (control === 'pause') {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    wake = null
                    resolve()
                }, PAUSE_HEARTBEAT_MS)
                wake = () => {
                    clearTimeout(timer)
                    wake = null
                    resolve()
                }
            })
            // 超时唤醒（没人点继续）：做一次扩展 API 调用给空闲计时器续命
            if (control === 'pause') await browser.storage.local.get(SYNC_PROGRESS_KEY).catch(() => undefined)
        }
        if (control !== 'stop') await patchSnapshot({ paused: false }).catch(() => undefined)
    }
    return control !== 'stop'
}

/**
 * 读断点游标。读不到、脏值、session 存储不可用 ⇒ 从第 0 页开始。
 *
 * 这里**吞掉异常**：游标只是「少翻几页」的优化，读它的失败绝不能让一次遍历起不来。
 */
async function readSyncCursor(): Promise<SyncCursor> {
    try {
        const stored = await browser.storage.session.get(SYNC_CURSOR_KEY)
        return parseSyncCursor(stored[SYNC_CURSOR_KEY]) ?? IDLE_SYNC_CURSOR
    } catch {
        return IDLE_SYNC_CURSOR
    }
}

async function writeSyncCursor(nextPage: number): Promise<void> {
    await browser.storage.session.set({ [SYNC_CURSOR_KEY]: { nextPage, updatedAt: Date.now() } })
}

async function clearSyncCursor(): Promise<void> {
    await browser.storage.session.remove(SYNC_CURSOR_KEY)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 逐页拉取全站视频列表 */
async function fetchVideoPage(page: number): Promise<Iwara.IPage<Iwara.Video>> {
    const query = new URLSearchParams({ sort: 'date', page: String(page), limit: String(PAGE_LIMIT) })
    const response = await fetch(apiUrl('/videos', query), { headers: await getAuth() })
    if (!response.ok) throw new Error(`GET /videos failed: HTTP ${response.status}`)
    return (await response.json()) as Iwara.IPage<Iwara.Video>
}

/** 逐页拉取订阅流视频列表（带 `rating`：源 `fetchSubscribedVideos` 同样下发内容分级） */
async function fetchSubscribedVideos(page: number): Promise<Iwara.IPage<Iwara.Video>> {
    const query = new URLSearchParams({ subscribed: 'true', limit: String(PAGE_LIMIT), rating: await readRatingPref(), page: String(page) })
    const response = await fetch(apiUrl('/videos', query), { headers: await getAuth() })
    if (!response.ok) throw new Error(`GET /videos?subscribed failed: HTTP ${response.status}`)
    return (await response.json()) as Iwara.IPage<Iwara.Video>
}

/**
 * 读取用户在 iwara 站点上选的内容分级。
 *
 * 源 `context/site.ts`：`rating = () => localStorage.getItem(LS_KEY_RATING) ?? 'all'`。
 * 它读的是**页面** localStorage，后台读不到，所以由 content script 上行后存在 storage.local；
 * 上行失败时报文里的 `rating` 会缺省，这里同样回退 `'all'` —— 与源完全一致的默认值。
 */
async function readRatingPref(): Promise<string> {
    try {
        const stored = await browser.storage.local.get(RATING_KEY)
        const value = stored[RATING_KEY]
        return typeof value === 'string' && value !== '' ? value : 'all'
    } catch {
        return 'all'
    }
}

/**
 * 入库结果。
 *
 * 为什么不是一个数字：`parsed`（解析成功）与 `written`（真正落库）是两件事，
 * 只报一个总数会让排查彻底失去方向——「库里没数据」时到底是**没拦截到**、
 * **解析全失败**、还是**写入被去重跳过**，必须能一眼分开。
 */
export interface IngestResult {
    /** 真正写库的条数 */
    written: number
    /** 解析成功（Type=partial）的条数 = written + skipped */
    parsed: number
    /** 解析成功但库里已是 full、按「不降级」跳过的条数 */
    skipped: number
    /** 解析失败的条数（外链视频 / RAW 缺字段） */
    failed: number
    /** 第一条失败原因（`parseCacheVideo` 的 Msg），供页面标记与日志定位 */
    reason?: string
}

/**
 * 批量入库（保留已有 full 记录，不被 partial 降级）。
 *
 * 返回 `IngestResult`：三个数字各自代表一个环节，页面的 `data-ia-ingest`
 * 与后台日志都按它输出，排查时不用再猜。
 */
async function upsertVideos(raws: Iwara.Video[]): Promise<IngestResult> {
    const infos = raws.map((raw) => parseCacheVideo(raw))
    const parsed = infos.filter((info) => info.Type === 'partial')
    const failed = infos.filter((info) => info.Type === 'fail')
    const reason = failed[0]?.Msg

    if (parsed.length === 0) {
        return { written: 0, parsed: 0, skipped: 0, failed: failed.length, ...(reason !== undefined ? { reason } : {}) }
    }

    const existing = await db.getVideosByIds(parsed.map((info) => info.ID))
    const fullIds = new Set(existing.filter((info) => info.Type === 'full').map((info) => info.ID))
    const toPut = parsed.filter((info) => !fullIds.has(info.ID))
    if (toPut.length > 0) await db.bulkPutVideos(toPut)
    return { written: toPut.length, parsed: parsed.length, skipped: parsed.length - toPut.length, failed: failed.length, ...(reason !== undefined ? { reason } : {}) }
}

/**
 * 页面缓存列表入库（原 handleVideosResponse 的解析入库段）+ 回填列表重算。
 *
 * 与全站遍历共用 `upsertVideos`：两条路都是「列表页 RAW → partial → 不降级 full」，
 * 区别只在于数据是从页面消息来还是从站内 API 拉。
 */
export async function ingestPageVideos(payload: { videos: unknown[]; window?: { start: number; end: number } }): Promise<IngestResult> {
    const result = await upsertVideos(payload.videos as Iwara.Video[])
    console.info(`[iwara-assistant] ingest written=${result.written} parsed=${result.parsed} skipped=${result.skipped} failed=${result.failed}${payload.window ? ' (window attached)' : ''}${result.reason !== undefined ? ` reason=${result.reason}` : ''}`)

    // 回填列表重算：优先用页面随消息上报的当前页窗口；库空/无窗口则跳过
    const windowBounds = payload.window ?? (await defaultWindow())
    if (windowBounds) await refreshCacheInjection(windowBounds.start, windowBounds.end)
    return result
}

/**
 * 全站视频列表遍历（原 syncAllVideosPages）。
 * 终止：本页 page*limit >= count（原实现同）；单页失败记录后继续。
 *
 * 进入前 `running` 已由 `startSiteSync` 置位，这里只负责跑完并在 finally 里收尾。
 */
async function runAllVideos(startPage = 0): Promise<void> {
    const state: SyncState = { running: true, kind: 'all', page: startPage, succeeded: 0, failed: 0, message: i18n.t('notify.syncStart'), updatedAt: Date.now() }
    /** 首轮失败的页号（源 `retryFailed`：全文跑完再重试，避免一页抽风就永久漏数据） */
    const retryFailed: number[] = []
    /** 已经处理完的页（含补跑轮补上的）。游标只在它上面做**连续**推进 */
    const processed = new Set<number>()
    /** 游标当前指向的位置：连续完成的最后一页 + 1，理由见 `advanceSyncCursor` */
    let contiguous = startPage

    /** 用户点了「停止」：收尾时保留游标（不是自然跑完，不能删断点） */
    let stopped = false

    try {
        for (let page = startPage; page < 100_000; page++) {
            // 页间闸门：暂停停在这里等，停止则带着断点收尾
            if (!(await awaitControl())) {
                stopped = true
                state.message = i18n.t('notify.syncStopped', { page, ok: state.succeeded, failed: state.failed })
                break
            }
            state.page = page
            state.message = i18n.t('notify.syncPage', { page, ok: state.succeeded, failed: state.failed })
            await report(state)

            try {
                const data = await fetchVideoPage(page)
                await upsertVideos(data.results ?? [])
                state.succeeded++
                // 每页成功就推进游标：进程被杀时少翻几千页，就是这个写法的全部收益
                processed.add(page)
                const advanced = advanceSyncCursor(contiguous, processed)
                if (advanced !== contiguous) {
                    contiguous = advanced
                    await writeSyncCursor(contiguous)
                }
                if (data.results.length === 0 || data.page * data.limit >= data.count) {
                    state.message = i18n.t('notify.syncDone', { page: page + 1, failed: state.failed })
                    break
                }
            } catch (error) {
                state.failed++
                retryFailed.push(page)
                state.message = i18n.t('notify.syncPageFailed', { page, message: error instanceof Error ? error.message : String(error) })
                await report(state)
                // 失败退避必须比正常页间隔长（源 5s）：连着报错通常是被限流，快重试只会延长封禁
                await sleep(FAILED_PAGE_BACKOFF_MS + Math.random() * 1000)
                continue
            }

            await sleep(PAGE_INTERVAL_MS + Math.random() * 1000)
        }

        // 被用户停止：**不跑补跑轮、也不删游标**——「停在 N 页、下次继续」必须是真的
        if (stopped) {
            await writeSyncCursor(advanceSyncCursor(contiguous, processed))
            return
        }
        const unresolved = retryFailed.length > 0 ? await retryFailedPages(retryFailed, state, processed) : []
        // 补跑轮可能把中间那几个洞补上，游标因此还能再往前推一段
        contiguous = advanceSyncCursor(contiguous, processed)
        // 收尾语义分两种，不能一律删游标：
        // - 一页不缺 → 删掉，「继续」从头开始（此时没有断点可言）；
        // - 还有没补上的页 → 把游标停在最早那一页，下次「继续」正好从缺失处开始。
        //   否则「N 页失败」的提示会变成一句空话：用户再点一次又从第 0 页重翻几千页。
        if (unresolved.length === 0) await clearSyncCursor()
        else await writeSyncCursor(contiguous)
    } finally {
        await settleRun(state)
    }
}

/**
 * 重试首轮失败的页（源 `syncAllVideosPages` 末段同类逻辑）。
 *
 * 只重试真正报错的页，不做全网重跑；仍失败则记入 `state.failed` 并在最终文案里报数量。
 * 轮数上限 `MAX_PAGE_RETRIES`：后台跑在 alarm 里，不能像页面内那样为了几页卡十几分钟。
 */
async function retryFailedPages(pages: number[], state: SyncState, processed: Set<number>): Promise<number[]> {
    let pending = [...pages]
    for (let round = 0; round < MAX_PAGE_RETRIES && pending.length > 0; round++) {
        const stillFailed: number[] = []
        for (const page of pending) {
            // 暂停/停止优先于补跑：剩下的失败页留到下一轮，别让「停止」变成「再跑二十分钟」
            if (!(await awaitControl())) {
                state.message = i18n.t('notify.syncStopped', { page, ok: state.succeeded, failed: state.failed })
                return pending
            }
            state.message = i18n.t('notify.syncRetry', { page, round: round + 1, total: pending.length })
            await report(state)
            try {
                const data = await fetchVideoPage(page)
                await upsertVideos(data.results ?? [])
                state.succeeded++
                state.failed = Math.max(0, state.failed - 1)
                processed.add(page)
            } catch {
                stillFailed.push(page)
            }
            await sleep(PAGE_INTERVAL_MS + Math.random() * 500)
        }
        pending = stillFailed
    }
    if (pending.length > 0) state.message = i18n.t('notify.syncRetryFailed', { count: pending.length })
    /** 补跑轮结束后仍然失败的页：调用方据此决定游标删不删（见 runAllVideos 的收尾注释） */
    return pending
}

/**
 * 订阅页私有/不公开视频遍历（原 parseUnlistedAndPrivate）。
 * 终止：本页含私有视频且该视频在"当月库内私有视频集合"中（说明已追平），或达到页数上限。
 *
 * 进入前 `running` 已由 `startSiteSync` 置位（含登录态检查），这里只负责跑完并收尾。
 */
async function runSubscribed(): Promise<void> {
    const state: SyncState = { running: true, kind: 'subscribed', page: 0, succeeded: 0, failed: 0, message: i18n.t('notify.subscribedStart'), updatedAt: Date.now() }

    try {
        const monthAgo = Date.now() - MONTH_MS
        const monthVideos = await db.getFilteredVideos(monthAgo, Number.MAX_SAFE_INTEGER)
        const monthIds = new Set(monthVideos.map((video) => video.ID))
        const collected: Iwara.Video[] = []
        let consecutiveFailures = 0

        for (let page = 0; page < MAX_FIND_PAGES; page++) {
            if (!(await awaitControl())) {
                state.message = i18n.t('notify.syncStopped', { page, ok: state.succeeded, failed: state.failed })
                break
            }
            state.page = page
            state.message = i18n.t('notify.subscribedPage', { page, collected: collected.length })
            await report(state)

            let data: Iwara.IPage<Iwara.Video>
            try {
                data = await fetchSubscribedVideos(page)
                state.succeeded++
                consecutiveFailures = 0
            } catch (error) {
                state.failed++
                consecutiveFailures++
                state.message = i18n.t('notify.syncPageFailed', { page, message: error instanceof Error ? error.message : String(error) })
                await report(state)
                // 连续失败：退避后再试，超过上限直接收工（原因见 MAX_CONSECUTIVE_FAILURES）
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    state.message = i18n.t('notify.subscribedAborted', { count: state.failed })
                    break
                }
                await sleep(FAILED_PAGE_BACKOFF_MS)
                continue
            }

            const videos = data.results ?? []
            collected.push(...videos)

            const hitCurrentMonth = videos.some((raw) => (raw.private || raw.unlisted) && monthIds.has(raw.id))
            if (hitCurrentMonth) {
                state.message = i18n.t('notify.subscribedReached', { page })
                break
            }
            if (videos.length === 0) break

            await sleep(PAGE_INTERVAL_MS / 5)
        }

        const written = (await upsertVideos(collected)).written
        state.message = i18n.t('notify.subscribedDone', { collected: collected.length, written, ok: state.succeeded, failed: state.failed })
    } finally {
        await settleRun(state)
    }
}

/** 自动遍历被跳过的原因（供页面标记与日志定位，不面向用户） */
export type AutoSyncSkipReason = 'config' | 'running' | 'interval' | 'not-logged-in'

export interface AutoSyncResult {
    started: boolean
    reason?: AutoSyncSkipReason
}

/**
 * 自动遍历订阅流 —— 源项目 `menu.pageChange()` 的同款时机，由页面在到达 `/videos` 时上报。
 *
 * 判据全部留在这里（页面侧不复制配置语义）：
 * 1. `回填私有/不公开缓存` 开 **且** `过滤订阅页 不公开/私有` 关（源条件原样）；
 * 2. 没有正在跑的遍历（源 `parseUnlistedRunning` 的等价物）；
 * 3. 距上次尝试超过 `AUTO_SYNC_MIN_INTERVAL_MS`；
 * 4. 已登录（未登录必然空跑；源也是在锁内先 `verifyLogin()`）。
 *
 * 时间戳在**真正开跑之前**写入：失败也算一次尝试。否则掉登录/被限流时，
 * 用户每切一个列表页就会重打一轮请求，而界面没有任何反馈能让他察觉。
 */
export async function autoSyncSubscribed(): Promise<AutoSyncResult> {
    if (!shouldAutoSyncSubscribed(getConfig())) return { started: false, reason: 'config' }
    if (running) return { started: false, reason: 'running' }

    const stored = (await browser.storage.local.get(AUTO_SYNC_AT_KEY))[AUTO_SYNC_AT_KEY]
    const lastAt = typeof stored === 'number' ? stored : undefined
    if (!isAutoSyncDue(lastAt, Date.now())) return { started: false, reason: 'interval' }

    if (!(await isLoggedIn())) return { started: false, reason: 'not-logged-in' }

    await browser.storage.local.set({ [AUTO_SYNC_AT_KEY]: Date.now() })
    console.info('[iwara-assistant] 自动遍历订阅流（到达 /videos 触发）')
    // 与手动入口走**同一条** fire-and-forget 路径：页面发的这条消息本来就是
    // `void sendMessage(...).catch(...)`，等整轮跑完只会让内容脚本的消息端口
    // 挂着一个几分钟的请求（失败页退避 × 64 页足够超过 5 分钟）。
    const result = await startSiteSync('subscribed')
    return { started: result.started, reason: result.reason === 'already-running' ? 'running' : result.reason }
}

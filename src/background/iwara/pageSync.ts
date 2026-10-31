/**
 * 列表入库与批量遍历 —— 从页面缓存与站内 API 两条路把视频记录写进本地库
 *
 * - ingestPageVideos：页面缓存列表入库（列表页上报的当前页 RAW）+ 回填列表重算
 * - syncAllVideosPages：全站视频列表逐页遍历（sort=date）
 * - parseUnlistedAndPrivate：订阅流逐页遍历，收集本月的私有/不公开视频；命中当月库内已有
 *   私有视频后提前结束（原版终止语义）
 *
 * 三条路共用 `upsertVideos`（partial 不降级 full），差异只在数据来源。
 * 与原版的差异：跨页互斥锁/心跳删除（后台是唯一执行者，用模块级 running 防重入）；
 * 进度写 storage.local（options 任务页可读），每页一次写入同时充当 SW 保活活动。
 */
import { apiUrl } from '../../shared/site'
import { i18n } from '../../shared/i18n'
import { AUTO_SYNC_AT_KEY, RATING_KEY } from '../../shared/storageKeys'
import { isAutoSyncDue, shouldAutoSyncSubscribed } from '../../shared/autoSync'
import { getAuth, isLoggedIn } from './auth'
import { defaultWindow, getConfig, refreshCacheInjection } from '../storage/configStore'
import { db } from '../storage/db'
import { parseCacheVideo } from '../storage/parse'

export type SyncKind = 'all' | 'subscribed'

export interface SyncState {
    running: boolean
    kind: SyncKind | null
    page: number
    succeeded: number
    failed: number
    message: string
    updatedAt: number
}

const SYNC_STATE_KEY = 'syncProgress'
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

let running = false

const IDLE_STATE: SyncState = {
    running: false,
    kind: null,
    page: 0,
    succeeded: 0,
    failed: 0,
    message: '',
    updatedAt: 0
}

export async function readSyncState(): Promise<SyncState> {
    const stored = (await browser.storage.local.get(SYNC_STATE_KEY))[SYNC_STATE_KEY] as SyncState | undefined
    return stored ?? IDLE_STATE
}

async function report(state: SyncState): Promise<void> {
    await browser.storage.local.set({ [SYNC_STATE_KEY]: { ...state, updatedAt: Date.now() } })
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
 * 与 `syncAllVideosPages` 共用 `upsertVideos`：两条路都是「列表页 RAW → partial → 不降级 full」，
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
 */
export async function syncAllVideosPages(): Promise<SyncState> {
    if (running) return readSyncState()
    if (!(await isLoggedIn())) {
        const state: SyncState = { ...IDLE_STATE, message: i18n.t('notify.notLoggedIn') }
        await report(state)
        return state
    }

    running = true
    const state: SyncState = { running: true, kind: 'all', page: 0, succeeded: 0, failed: 0, message: i18n.t('notify.syncStart'), updatedAt: Date.now() }
    /** 首轮失败的页号（源 `retryFailed`：全文跑完再重试，避免一页抽风就永久漏数据） */
    const retryFailed: number[] = []

    try {
        for (let page = 0; page < 100_000; page++) {
            state.page = page
            state.message = i18n.t('notify.syncPage', { page, ok: state.succeeded, failed: state.failed })
            await report(state)

            try {
                const data = await fetchVideoPage(page)
                await upsertVideos(data.results ?? [])
                state.succeeded++
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

        if (retryFailed.length > 0) await retryFailedPages(retryFailed, state)
    } finally {
        state.running = false
        state.kind = null
        await report(state)
        running = false
    }
    return state
}

/**
 * 重试首轮失败的页（源 `syncAllVideosPages` 末段同类逻辑）。
 *
 * 只重试真正报错的页，不做全网重跑；仍失败则记入 `state.failed` 并在最终文案里报数量。
 * 轮数上限 `MAX_PAGE_RETRIES`：后台跑在 alarm 里，不能像页面内那样为了几页卡十几分钟。
 */
async function retryFailedPages(pages: number[], state: SyncState): Promise<void> {
    let pending = [...pages]
    for (let round = 0; round < MAX_PAGE_RETRIES && pending.length > 0; round++) {
        const stillFailed: number[] = []
        for (const page of pending) {
            state.message = i18n.t('notify.syncRetry', { page, round: round + 1, total: pending.length })
            await report(state)
            try {
                const data = await fetchVideoPage(page)
                await upsertVideos(data.results ?? [])
                state.succeeded++
                state.failed = Math.max(0, state.failed - 1)
            } catch {
                stillFailed.push(page)
            }
            await sleep(PAGE_INTERVAL_MS + Math.random() * 500)
        }
        pending = stillFailed
    }
    if (pending.length > 0) state.message = i18n.t('notify.syncRetryFailed', { count: pending.length })
}

/**
 * 订阅页私有/不公开视频遍历（原 parseUnlistedAndPrivate）。
 * 终止：本页含私有视频且该视频在"当月库内私有视频集合"中（说明已追平），或达到页数上限。
 */
export async function parseUnlistedAndPrivate(): Promise<SyncState> {
    if (running) return readSyncState()
    if (!(await isLoggedIn())) {
        const state: SyncState = { ...IDLE_STATE, message: i18n.t('notify.notLoggedIn') }
        await report(state)
        return state
    }

    running = true
    const state: SyncState = { running: true, kind: 'subscribed', page: 0, succeeded: 0, failed: 0, message: i18n.t('notify.subscribedStart'), updatedAt: Date.now() }

    try {
        const monthAgo = Date.now() - MONTH_MS
        const monthVideos = await db.getFilteredVideos(monthAgo, Number.MAX_SAFE_INTEGER)
        const monthIds = new Set(monthVideos.map((video) => video.ID))
        const collected: Iwara.Video[] = []
        let consecutiveFailures = 0

        for (let page = 0; page < MAX_FIND_PAGES; page++) {
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
        state.running = false
        state.kind = null
        await report(state)
        running = false
    }
    return state
}

/** 自动遍历被跳过的原因（供页面标记与日志定位，不面向用户） */
export type AutoSyncSkipReason = 'config' | 'running' | 'interval' | 'not-logged-in'

export interface AutoSyncResult {
    started: boolean
    reason?: AutoSyncSkipReason
    state?: SyncState
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
    // await 而不是 fire-and-forget：整轮里持续有扩展 API / fetch 调用，SW 不会被中途回收；
    // 与手动 `SYNC_SUBSCRIBED` 走同一条等待语义，两条路径不会出现「谁更容易被打断」的差异。
    return { started: true, state: await parseUnlistedAndPrivate() }
}

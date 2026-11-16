/**
 * MediaCenter 联动 —— 原 network/mediaCenter.ts + features/mediaSync.ts 的后台移植
 *
 * 流程（与原版一致）：
 * 1. createMedia（fileHash = iwara 视频 ID）→ 409 时复用 existingId
 * 2. updateMedia 写入完整元数据（标题/作者/标签/时长/sourceMeta）
 * 3. 映射写入 IndexedDB idmap（ID → mediaCenterId）
 * 4. 服务端 404 时删除本地映射，下次推送自动重建
 *
 * 与源实现的**刻意偏离**（只有一处是行为取舍，另一处是对齐）：
 * - 阶段一改为**分页拉取 + 候选索引**（源实现用 `?limit=0` 一次拉全量，14 万条 ≈ 118 MB，
 *   会把扩展进程卡死；详见 `shared/mediaCenterMatch` 与 `fetchMediaPage` 的注释）；
 * - 阶段二的并发度与源实现一致（6），但**去掉了它串行时代的 100ms delay**：
 *   并发下在 worker 里 sleep 只是空转槽位（详见 `PUSH_CONCURRENCY`）。
 *
 * 触发：aria2 通道下载完成（原版同）；批量同步由 options「高级」页手动触发。
 */
import { getConfig } from '../storage/configStore'
import { db } from '../storage/db'
import { getDownloadPath } from '../download/downloadPath'
import { parseVideoFull } from './videoApi'
import { i18n } from '../../shared/i18n'
import type { FullVideoInfo } from '../../shared/videoInfo'
import { getMoreCompleteVideoInfo } from '../../shared/videoInfo'
import { MEDIA_CENTER_TARGET, describeEndpointFailure, describeEndpointInvalid, describeEndpointRejected, hasEndpointAccess, isNetworkLevelFailure, parseEndpoint } from '../../shared/endpoint'
import { stringify } from '../../shared/strings'
import { runPool } from '../../shared/concurrency'
import { createMediaCenterMatcher, scanMediaPages, MEDIA_LIST_PAGE_SIZE, type MediaCenterListEntry, type MediaPage } from '../../shared/mediaCenterMatch'
import { IDLE_MEDIA_SYNC_PROGRESS, parseMediaSyncProgress, settleInterrupted, type MediaSyncProgress, type MediaSyncStage } from '../../shared/mediaSyncProgress'
import { MEDIA_SYNC_PROGRESS_KEY } from '../../shared/storageKeys'

function apiBase(): string {
    return getConfig().mediaCenterApi.replace(/\/+$/, '')
}

export function isMediaCenterConfigured(): boolean {
    const config = getConfig()
    return config.experimentalFeatures && config.mediaCenterApi.trim() !== '' && config.mediaCenterApiKey.trim() !== ''
}

function authHeaders(): Record<string, string> {
    return {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${getConfig().mediaCenterApiKey}`
    }
}

/**
 * 映射有效性验证缓存（源 `mediaCenterIdMapValidateCache`）。
 *
 * `recordExists` 是一次真实 HTTP 往返，而批量同步会对每条记录调一次它；
 * 缓存 6 小时后，同一批同步里重复出现的记录（以及短时间内的重复推送）不再重复验证。
 * key 带上 API 地址：换实例后缓存自动失效，不会拿旧实例的结论判断新实例。
 */
const mappingValidCache = new Map<string, { valid: boolean; checkedAt: number }>()
const MAPPING_VALIDATE_TTL_MS = 6 * 60 * 60 * 1000

async function recordExists(mediaCenterId: string): Promise<boolean> {
    const key = `${apiBase()}|${mediaCenterId}`
    const cached = mappingValidCache.get(key)
    if (cached && Date.now() - cached.checkedAt < MAPPING_VALIDATE_TTL_MS) return cached.valid
    const response = await fetch(`${apiBase()}/api/media/${mediaCenterId}`, { method: 'GET', headers: authHeaders() })
    mappingValidCache.set(key, { valid: response.ok, checkedAt: Date.now() })
    return response.ok
}

/**
 * 拉取**一页**远端列表。
 *
 * 为什么必须分页（原来用 `?limit=0`，服务端会返回全量）：实测 14 万条 ≈ **118 MB**，
 * `response.json()` 要把这 118 MB 变成一个字符串再建一棵对象树，两者同时驻留，
 * 扩展进程直接卡死。服务端对分页请求把 `limit` 硬顶到 100
 * （MediaCenter `controllers/mediaController.listMedia` 的 `Math.min(100, …)`），
 * 所以页大小就是 100，再大只会被截断。
 *
 * 只取匹配要用的三个字段（`id` / `fileHash` / `title`），
 * 其余字段（签名直链、标签、作者…）在函数返回前就随响应对象一起被回收。
 *
 * 失败抛出（调用方把它翻译成端点层面的可操作文案，而不是静默跳过）。
 */
async function fetchMediaPage(page: number): Promise<MediaPage> {
    const query = new URLSearchParams({ page: String(page), limit: String(MEDIA_LIST_PAGE_SIZE), sortBy: 'createdAt', sortOrder: 'desc' })
    const response = await fetch(`${apiBase()}/api/media?${query.toString()}`, { headers: authHeaders() })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = (await response.json()) as { items?: unknown; data?: unknown; pagination?: { total?: unknown } }
    // 兼容两种常见包裹形态：{items:[]} / {data:[]}；都不是数组时按「空列表」处理而不是崩溃
    const raw = Array.isArray(body.items) ? body.items : Array.isArray(body.data) ? body.data : []
    const items: MediaCenterListEntry[] = []
    for (const item of raw) {
        const entry = item as Partial<MediaCenterListEntry> | null | undefined
        if (typeof entry?.id !== 'string' || entry.id === '') continue
        items.push({
            id: entry.id,
            fileHash: typeof entry.fileHash === 'string' ? entry.fileHash : undefined,
            title: typeof entry.title === 'string' ? entry.title : undefined
        })
    }
    // 老版本服务端没有 pagination：按「总数未知」处理，扫描逻辑会退化成短页终止
    const total = typeof body.pagination?.total === 'number' && Number.isFinite(body.pagination.total) ? body.pagination.total : 0
    return { items, total }
}

type CreateResult = { ok: true; id: string } | { ok: false; existingId?: string; status?: number; error?: string }

async function createMedia(body: { filePath: string; fileHash: string }): Promise<CreateResult> {
    const response = await fetch(`${apiBase()}/api/media`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
    if (response.status === 409) {
        const conflict = (await response.json()) as { error?: string; existingId?: string }
        return { ok: false, existingId: conflict.existingId, error: conflict.error }
    }
    if (!response.ok) return { ok: false, status: response.status, error: await response.text() }
    const result = (await response.json()) as { error?: string; id?: string }
    if (result.error) return { ok: false, error: result.error }
    if (!result.id) return { ok: false, error: 'no id returned' }
    return { ok: true, id: result.id }
}

type UpdateResult = { ok: true } | { ok: false; status?: number; error?: string }

async function updateMedia(mediaCenterId: string, body: Record<string, unknown>): Promise<UpdateResult> {
    const response = await fetch(`${apiBase()}/api/media/${mediaCenterId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(body)
    })
    if (!response.ok) return { ok: false, status: response.status, error: await response.text() }
    const result = (await response.json()) as { error?: string; media?: unknown }
    if (result.error) return { ok: false, error: result.error }
    if (!result.media) return { ok: false, error: 'no media returned' }
    return { ok: true }
}

function buildUpdateBody(video: FullVideoInfo, filePath: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
        filePath,
        fileHash: video.ID,
        title: video.Title,
        description: video.Description ?? '',
        source: 'iwara',
        author: video.Author,
        tags: (video.Tags ?? []).map((tag) => tag.id),
        createdAt: new Date(video.UploadTime).toISOString()
    }
    if (video.Alias !== '') body['altNames'] = [video.Alias]
    const duration = video.RAW?.file?.duration
    if (typeof duration === 'number') body['duration'] = duration
    if (video.RAW) body['sourceMeta'] = JSON.stringify(video.RAW)
    return body
}

/**
 * 推送结果。返回原因而不是裸 boolean：调用方（批量同步 / 下载完成后推送）需要把
 * 「为什么失败」告诉用户，而不是只写 console——用户的反馈通道里没有控制台。
 *
 * `networkLevel` 区分两类完全不同的失败：
 * - true：请求根本没发出去/被拦下（未授权、DNS、端口）→ 去查端点与授权
 * - false：端点可达，但服务端返回 4xx/5xx 或业务错误（token 无效等）→ 保留服务端原话
 * 不区分就会把「token 无效」写成「守护进程是否已启动」。
 */
export type PushOutcome = { ok: true } | { ok: false; error: string; networkLevel: boolean }

/**
 * 推送单条视频到 MediaCenter（未配置/实验特性关闭时静默返回失败）。
 *
 * `filePath` 必须与源实现一致地取 `getDownloadPath(video).fullPath`（**目录 + 文件名**）。
 * MediaCenter 直接把它写进 `media.filePath`，并用它 probe 文件、校验文件是否存在：
 * 只传文件名（`FileName` / `fullName`）既 probe 不到文件，库里也会留下缺目录的路径。
 *
 * ### `mediaCenterIdOverride` = 「调用方刚刚从远端列表认领到的记录 id」
 *
 * 传了它就不再回查 `recordExists`：那次 GET 是**纯冗余往返**——id 就是从刚拉到的列表里
 * 拿到的，记录必然存在。批量同步对每条映射都要推一次，省掉它等于请求量减半
 * （并发 6 时仍有明显收益）。
 *
 * 不传 override 的路径（下载完成后的单条推送）完全不变：读 idmap → 验证 → 失效才重建。
 */
export async function pushToMediaCenter(video: FullVideoInfo, mediaCenterIdOverride?: string): Promise<PushOutcome> {
    if (!isMediaCenterConfigured()) return { ok: false, error: '', networkLevel: false }

    let mediaCenterId: string | undefined = mediaCenterIdOverride

    try {
        const filePath = getDownloadPath(video).fullPath
        if (!mediaCenterId) {
            const mapped = await db.getIdmap(video.ID)
            if (mapped?.href) {
                if (await recordExists(mapped.href)) {
                    mediaCenterId = mapped.href
                } else {
                    await db.deleteIdmap(video.ID)
                }
            }
        }

        if (!mediaCenterId) {
            const created = await createMedia({ filePath, fileHash: video.ID })
            if (created.ok) {
                mediaCenterId = created.id
                await db.putIdmap({ ID: video.ID, href: mediaCenterId })
            } else if (created.existingId) {
                mediaCenterId = created.existingId
                await db.putIdmap({ ID: video.ID, href: mediaCenterId })
            } else {
                const detail = `createMedia ${created.status ?? '?'}: ${created.error ?? ''}`
                console.warn('[iwara-assistant] MediaCenter createMedia failed:', detail)
                return { ok: false, error: detail, networkLevel: false }
            }
        }

        const updated = await updateMedia(mediaCenterId, buildUpdateBody(video, filePath))
        if (!updated.ok) {
            if (updated.status === 404) await db.deleteIdmap(video.ID)
            const detail = `updateMedia ${updated.status ?? '?'}: ${updated.error ?? ''}`
            console.warn('[iwara-assistant] MediaCenter updateMedia failed:', detail)
            return { ok: false, error: detail, networkLevel: false }
        }
        return { ok: true }
    } catch (error) {
        // fetch 失败（含未授权的 NetworkError）落到这里：把原文带回给调用方翻译
        const detail = error instanceof Error ? error.message : stringify(error)
        console.warn('[iwara-assistant] MediaCenter push error:', detail)
        return { ok: false, error: detail, networkLevel: isNetworkLevelFailure(detail) }
    }
}

/**
 * 下载完成后的推送入口：优先用库内 full 记录，缺失则重新解析。
 *
 * 返回**是否真的推送成功**——调用方（`mediaCenterPushQueue`）要靠它决定要不要登记重试。
 * 未配置 MediaCenter 时返回 `true`（本就无事可做，不该产生待重试记录）。
 */
export async function pushVideoIdToMediaCenter(videoId: string): Promise<boolean> {
    if (!isMediaCenterConfigured()) return true
    try {
        const [stored] = await db.getVideosByIds([videoId])
        if (stored && stored.Type === 'full') {
            const outcome = await pushToMediaCenter(stored)
            if (!outcome.ok) console.warn(`[iwara-assistant] MediaCenter push failed: ${outcome.error}`)
            return outcome.ok
        }
        const parsed = await parseVideoFull(videoId)
        const outcome = await pushToMediaCenter(parsed)
        if (!outcome.ok) console.warn(`[iwara-assistant] MediaCenter push failed: ${outcome.error}`)
        return outcome.ok
    } catch (error) {
        console.warn('[iwara-assistant] MediaCenter push skipped:', stringify(error))
        return false
    }
}
/** 单条推送的失败原因 → 用户可读文案（按「连不上」与「服务端拒绝」分流） */
async function describeMediaCenterFailure(outcome: { error: string; networkLevel: boolean }): Promise<string> {
    if (!outcome.networkLevel) return describeEndpointRejected(MEDIA_CENTER_TARGET, outcome.error)
    const endpoint = getConfig().mediaCenterApi
    return describeEndpointFailure(MEDIA_CENTER_TARGET, endpoint, outcome.error, await hasEndpointAccess(endpoint))
}

export interface MediaSyncResult {
    total: number
    pushed: number
    failed: number
    /** 全局失败原因（仅当一条都没推成功时给出；如实告知，不拿「N 条失败」糊弄） */
    reason?: string
}

/**
 * 运行中的同步进度 —— **唯一运行真相**（`null` = 没在跑）。
 *
 * 不落 `storage.local` 的理由见 `shared/mediaSyncProgress`：运行状态与任务死在
 * 同一个进程里，写进持久层只会在 SW 被回收后留下永久的「正在同步」。
 * 跨上下文走 `storage.session` 快照（内存态，浏览器退出即清）：后台写、页面订阅
 * `storage.onChanged`——**不用消息轮询**，因为长任务期间的消息往返不受我们控制。
 */
let liveProgress: MediaSyncProgress | null = null

/** 进度写入最小间隔：订阅者是即时渲染，写太频只是徒增 IPC */
const PROGRESS_INTERVAL_MS = 400
let lastProgressWriteAt = 0

/**
 * 发布进度：内存真相 + session 快照（节流写入，选 `force` 时必写）。
 *
 * 写失败只影响「别处能不能看到进度」，绝不能让同步本身失败——与 `friendApprove`
 * 的 `saveRecord` 同一取舍。
 */
function publishProgress(progress: MediaSyncProgress, force = false): void {
    liveProgress = progress
    const now = Date.now()
    if (!force && now - lastProgressWriteAt < PROGRESS_INTERVAL_MS) return
    lastProgressWriteAt = now
    void browser.storage.session.set({ [MEDIA_SYNC_PROGRESS_KEY]: progress }).catch(() => undefined)
}

/**
 * 阶段二的并发度（源 `syncCachedToMediaCenter` 的 `concurrency = 6`）。
 *
 * 为什么可以并发：每条推送只写自己那条 idmap、只碰自己那个远端记录，彼此无共享状态；
 * 而单条要 1~2 次往返（认领到的记录直接 `updateMedia`，未认领的要先 `createMedia`），
 * 串行 1 万条 = 上万次往返，分钟级起步。
 * 为什么不超过 6：目标常常是家用 NAS，并发再高只会让它排队；源项目取 6 也是同一考虑。
 * 非 full 记录会在这条通道里现解析 iwara（`parseVideoFull`），6 并发与源项目一致。
 * **串行时代那个 150ms 节流随之删除**：它本来就是「没有并发能力」时的下位替代，
 * 在并发的 worker 里 sleep 只会让槽位空转（6 个槽 × 150ms ≈ 每秒只推进 40 条）。
 */
const PUSH_CONCURRENCY = 6

/**
 * 读取同步进度（options 页挂载时取一次初值）。
 *
 * 平时页面靠 `storage.onChanged` 接收推送，这条消息只负责两件事：
 * 1. 页面刚打开时给出初值（不用等第一次写入）；
 * 2. **残骸归一**——「session 说在跑、内存里没任务」在任何时刻都只可能是
 *    上一次同步被打断，读到就顺手修掉（靠不变量判定，不靠心跳超时）。
 *
 * 归一逻辑放这里而不是 `boot()`：不依赖 SW 唤醒时机，页面何时打开都能自愈。
 */
export async function readMediaSyncProgress(): Promise<MediaSyncProgress> {
    if (liveProgress) return liveProgress
    let stored: MediaSyncProgress | null = null
    try {
        stored = parseMediaSyncProgress((await browser.storage.session.get(MEDIA_SYNC_PROGRESS_KEY))[MEDIA_SYNC_PROGRESS_KEY])
    } catch {
        // 没有 storage.session 的宿主：退化成「无快照」，不影响同步本身
        return IDLE_MEDIA_SYNC_PROGRESS
    }
    const settled = settleInterrupted(stored, false)
    if (settled) {
        await browser.storage.session.set({ [MEDIA_SYNC_PROGRESS_KEY]: settled }).catch(() => undefined)
        return settled
    }
    return stored ?? IDLE_MEDIA_SYNC_PROGRESS
}

/** 进度上报器（到达本阶段总量时强制写入，免得最后一条被节流吞掉） */
function progressReporter(stage: MediaSyncStage): (done: number, total: number) => void {
    // 阶段一的服务端总量可能未知（total=0）：此时不能把「0 >= 0」当成已完成，否则每页都强写一次
    return (done, total) => publishProgress({ running: true, stage, done, total, updatedAt: Date.now() }, total > 0 && done >= total)
}

/**
 * 批量同步：把库内视频推送到 MediaCenter。
 *
 * 与源 `syncCachedToMediaCenter` 逐段对齐，**两个阶段**：
 *
 * ### 阶段一：先在服务端「认领」已有记录（源实现的核心，之前漏掉了）
 *
 * 分页扫描 MediaCenter 列表，按 `fileHash === iwara 视频 ID` → 标题包含视频 ID
 * 两级匹配，把命中的 `(videoId → mediaCenterId)` 写进 idmap。**这一步决定「更新」还是「新建」**：
 * 不认领就会对每条已有记录重新 createMedia，只在服务端 fileHash 恰好等于视频 ID 时靠 409 兜住；
 * 一旦老记录的 fileHash 是别的值（换过工具、手改过标题），就会在服务端造出重复条目。
 *
 * ### 阶段二：逐条解析 + 推送
 *
 * 只处理**已命中映射**的条目（源实现同）：没有映射说明服务端本来就没有这条记录，
 * 批量同步的职责是「补齐已存在的记录」，不是「把整个库倒进 MediaCenter」。
 *
 * ### 性能：三处都不能按「全量 × 全量」做
 *
 * 1. 远端列表**必须分页**：`?limit=0` 一次返回 118 MB（14 万条），`response.json()` 直接卡死；
 * 2. 索引**只认候选**：只为「还没有映射」的本地视频建索引，远端记录的 hash/标题
 *    只有命中候选才被记住 —— 内存与远端目录规模无关；全部已映射时**零请求**；
 * 3. 本地库只迭代主键（`openKeyCursor`）：视频库单条记录可达数 MB，整库读进内存同样会卡死。
 *
 * 阶段二（推送）用 `PUSH_CONCURRENCY` 条并行的 worker，而不是串行 + sleep：
 * 每条推送是 2~3 次独立往返，串行一万条就是数万次往返，且 worker 里 sleep 只是空转槽位。
 */
export async function syncCachedToMediaCenter(): Promise<MediaSyncResult> {
    const result: MediaSyncResult = { total: 0, pushed: 0, failed: 0 }
    if (!isMediaCenterConfigured()) return result

    if (parseEndpoint(apiBase()) === null) {
        result.reason = describeEndpointInvalid(MEDIA_CENTER_TARGET, apiBase())
        return result
    }

    publishProgress({ running: true, stage: 'list', done: 0, total: 0, updatedAt: Date.now() }, true)
    try {
        // ── 阶段一：分页扫描远端列表 + 建立/补齐映射 ──
        const matched = await db.getAllIdmaps()

        // 只把「还没有映射」的主键收进候选：索引只保留命中候选的记录，
        // 且全部视频都已映射时一个远端请求都不用发（旧实现无论如何都会拉一遍全量）。
        const candidates: string[] = []
        for await (const batch of db.iterateVideoKeysBatched(5000)) {
            for (const videoId of batch) if (!matched.has(videoId)) candidates.push(videoId)
        }

        if (candidates.length > 0) {
            const matcher = createMediaCenterMatcher(candidates)
            const report = progressReporter('list')
            let summary: Awaited<ReturnType<typeof scanMediaPages>>
            try {
                summary = await scanMediaPages({
                    fetchPage: fetchMediaPage,
                    apply: (items) => {
                        for (const item of items) matcher.add(item)
                    },
                    // 候选全部命中后立刻停：剩下的页只可能给出不需要的映射
                    done: () => matcher.remaining() === 0,
                    onProgress: (scanned, total) => report(scanned, total)
                })
            } catch (error) {
                // 拉不到列表就无法确认哪些是「已有记录」：如实报错，不改走「全部新建」
                result.reason = describeEndpointRejected(MEDIA_CENTER_TARGET, error instanceof Error ? error.message : stringify(error))
                return result
            }
            // 页数上限只会在远端目录异常巨大（或老服务端不认分页）时触发：如实留下日志，不静默半途而废
            if (summary.truncated) console.warn(`[iwara-assistant] MediaCenter 列表扫描达到页数上限（已扫描 ${summary.scanned} 条），映射认领可能不完整`)

            const discovered: Array<{ ID: string; href: string }> = []
            for (const videoId of candidates) {
                const hit = matcher.resolve(videoId)
                if (hit === undefined) continue
                matched.set(videoId, hit)
                discovered.push({ ID: videoId, href: hit })
            }
            if (discovered.length > 0) await db.bulkPutIdmaps(discovered)
        }

        // ── 阶段二：只处理有映射的条目 ──
        result.total = matched.size
        if (matched.size === 0) {
            result.reason = i18n.t('notify.mediaNoMapping')
            return result
        }
        // **进阶段就立刻上报**：否则「全部已映射」的常见情形会一直显示上一个阶段的
        // 「正在读取列表 0 / 0」，用户看到的是「条不动」而不是「正在推送」。
        publishProgress({ running: true, stage: 'push', done: 0, total: matched.size, updatedAt: Date.now() }, true)

        const reportPush = progressReporter('push')
        let settled = 0
        // 并发下「最后一条失败」没有意义（完成顺序不定），只保留**第一个**失败：
        // 一组全失败时它最可能代表共同根因，而「一条都没成功」正是给全局文案的判据。
        let firstFailure: { error: string; networkLevel: boolean } | null = null
        await runPool(
            [...matched],
            async ([videoId, mediaCenterId]) => {
                try {
                    const [stored] = await db.getVideosByIds([videoId])
                    if (!stored) {
                        result.failed++
                        return
                    }
                    let video: FullVideoInfo
                    if (stored.Type === 'full') {
                        video = stored
                    } else {
                        // 非 full 记录（只有列表页缓存）：现解析一次；解析失败计入失败而不是静默跳过
                        try {
                            const parsed = await parseVideoFull(videoId)
                            // 择优而不是直接覆盖：解析可能只拿到 partial（限流等），
                            // 直接写回会把已有的 partial 字段打薄（源 mediaSync 同款处理）
                            const merged = getMoreCompleteVideoInfo(stored, parsed)
                            if (merged !== stored) await db.putVideo(merged)
                            video = parsed
                        } catch {
                            result.failed++
                            return
                        }
                    }
                    const outcome = await pushToMediaCenter(video, mediaCenterId)
                    if (outcome.ok) result.pushed++
                    else {
                        result.failed++
                        firstFailure ??= { error: outcome.error, networkLevel: outcome.networkLevel }
                    }
                } finally {
                    // `return` 也会走到这里：进度必须覆盖「跳过的条目」，否则条永远差最后一截
                    reportPush(++settled, matched.size)
                }
            },
            { concurrency: PUSH_CONCURRENCY }
        )
        // 一条都没成功 → 几乎必然是端点层面的问题（未授权/未启动/服务端拒绝），把真实原因交给 UI
        if (result.pushed === 0 && firstFailure !== null) result.reason = await describeMediaCenterFailure(firstFailure)
        return result
    } finally {
        // **先落终态快照，再释放内存标记**：顺序反了会有一个「内存空、存储仍写 running」
        // 的窗口，那一刻打开页面会把刚跑完的同步判成「已中断」。
        await browser.storage.session.set({ [MEDIA_SYNC_PROGRESS_KEY]: { ...IDLE_MEDIA_SYNC_PROGRESS, updatedAt: Date.now() } }).catch(() => undefined)
        liveProgress = null
    }
}

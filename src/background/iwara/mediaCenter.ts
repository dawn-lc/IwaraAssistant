/**
 * MediaCenter 联动 —— 原 network/mediaCenter.ts + features/mediaSync.ts 的后台移植
 *
 * 流程（与原版一致）：
 * 1. createMedia（fileHash = iwara 视频 ID）→ 409 时复用 existingId
 * 2. updateMedia 写入完整元数据（标题/作者/标签/时长/sourceMeta）
 * 3. 映射写入 IndexedDB idmap（ID → mediaCenterId）
 * 4. 服务端 404 时删除本地映射，下次推送自动重建
 *
 * 触发：aria2 通道下载完成（原版同）；批量同步由 options「高级」页手动触发。
 */
import { getConfig } from '../storage/configStore'
import { db } from '../storage/db'
import { parseVideoFull } from './videoApi'
import { i18n } from '../../shared/i18n'
import type { FullVideoInfo } from '../../shared/videoInfo'
import { getMoreCompleteVideoInfo } from '../../shared/videoInfo'
import { MEDIA_CENTER_TARGET, describeEndpointFailure, describeEndpointInvalid, describeEndpointRejected, hasEndpointAccess, isNetworkLevelFailure, parseEndpoint } from '../../shared/endpoint'
import { stringify } from '../../shared/strings'

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

/** MediaCenter 列表条目（列表端点返回的字段子集） */
interface MediaCenterListItem {
    id: string
    fileHash?: string
    title?: string
}

/**
 * 拉取 MediaCenter 全部记录（`limit=0` 表示全量）。
 *
 * 只用于阶段一的映射认领：需要 `fileHash` 与 `title` 两个字段做三级匹配。
 * 失败抛出（调用方把它翻译成端点层面的可操作文案，而不是静默跳过）。
 */
async function fetchMediaList(): Promise<MediaCenterListItem[]> {
    const response = await fetch(`${apiBase()}/api/media?limit=0&sortBy=createdAt&sortOrder=desc`, { headers: authHeaders() })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = (await response.json()) as { items?: MediaCenterListItem[]; data?: MediaCenterListItem[] }
    // 兼容两种常见包裹形态：{items:[]} / {data:[]}；都不是数组时按「空列表」处理而不是崩溃
    const list = Array.isArray(body.items) ? body.items : Array.isArray(body.data) ? body.data : []
    return list.filter((item): item is MediaCenterListItem => typeof item?.id === 'string' && item.id !== '')
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
 * @param fallbackPath 下载路径（aria2 完成时由任务记录提供；缺省用临时值）
 */
export async function pushToMediaCenter(video: FullVideoInfo, mediaCenterIdOverride?: string, fallbackPathOverride?: string): Promise<PushOutcome> {
    if (!isMediaCenterConfigured()) return { ok: false, error: '', networkLevel: false }

    const filePath = fallbackPathOverride ?? video.FileName ?? video.ID
    let mediaCenterId: string | undefined = mediaCenterIdOverride

    try {
        const mapped = await db.getIdmap(video.ID)
        if (mapped?.href) {
            if (await recordExists(mapped.href)) {
                mediaCenterId = mapped.href
            } else {
                await db.deleteIdmap(video.ID)
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

/** 下载完成后的推送入口：优先用库内 full 记录，缺失则重新解析（失败静默） */
export async function pushVideoIdToMediaCenter(videoId: string, filename?: string): Promise<void> {
    if (!isMediaCenterConfigured()) return
    try {
        const [stored] = await db.getVideosByIds([videoId])
        if (stored && stored.Type === 'full') {
            await pushToMediaCenter(stored, undefined, filename)
            return
        }
        const parsed = await parseVideoFull(videoId)
        await pushToMediaCenter(parsed, undefined, filename)
    } catch (error) {
        console.warn('[iwara-assistant] MediaCenter push skipped:', stringify(error))
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
 * 批量同步：把库内视频推送到 MediaCenter。
 *
 * 与源 `syncCachedToMediaCenter` 逐段对齐，**两个阶段**：
 *
 * ### 阶段一：先在服务端「认领」已有记录（源实现的核心，之前漏掉了）
 *
 * 拉一次 MediaCenter 列表，按 `fileHash === iwara 视频 ID` → 标题包含 token → 标题包含 ID
 * 三级匹配，把命中的 `(videoId → mediaCenterId)` 写进 idmap。**这一步决定「更新」还是「新建」**：
 * 不认领就会对每条已有记录重新 createMedia，只在服务端 fileHash 恰好等于视频 ID 时靠 409 兜住；
 * 一旦老记录的 fileHash 是别的值（换过工具、手改过标题），就会在服务端造出重复条目。
 *
 * ### 阶段二：逐条解析 + 推送
 *
 * 只处理**已命中映射**的条目（源实现同）：没有映射说明服务端本来就没有这条记录，
 * 批量同步的职责是「补齐已存在的记录」，不是「把整个库倒进 MediaCenter」。
 *
 * ### 性能：只迭代主键，不反序列化
 *
 * 源实现用 `iterateVideoKeysBatched`（`openKeyCursor`）。视频库单条记录可达数 MB
 * （简介 + 全部评论），`getAllVideos()` 会把整库读进内存并 structured-clone 一遍——
 * 十万条库直接卡死。这里同样只取主键。
 */
export async function syncCachedToMediaCenter(): Promise<MediaSyncResult> {
    const result: MediaSyncResult = { total: 0, pushed: 0, failed: 0 }
    if (!isMediaCenterConfigured()) return result

    if (parseEndpoint(apiBase()) === null) {
        result.reason = describeEndpointInvalid(MEDIA_CENTER_TARGET, apiBase())
        return result
    }

    // ── 阶段一：拉列表 + 建立/补齐映射 ──
    const matched = await db.getAllIdmaps()
    let listItems: MediaCenterListItem[]
    try {
        listItems = await fetchMediaList()
    } catch (error) {
        // 拉不到列表就无法确认哪些是「已有记录」：如实报错，不改走「全部新建」
        result.reason = describeEndpointRejected(MEDIA_CENTER_TARGET, error instanceof Error ? error.message : stringify(error))
        return result
    }

    // 预建索引：避免每个视频都线性扫一遍列表
    const byHash = new Map<string, string>()
    const byToken = new Map<string, string>()
    const titleIndex: Array<{ id: string; title: string }> = []
    for (const item of listItems) {
        if (item.fileHash) byHash.set(item.fileHash, item.id)
        if (item.title) {
            const lower = item.title.toLowerCase()
            titleIndex.push({ id: item.id, title: lower })
            for (const token of lower.split(/[^a-z0-9]+/).filter((part) => part.length >= 3)) {
                if (!byToken.has(token)) byToken.set(token, item.id)
            }
        }
    }

    const discovered: Array<{ ID: string; href: string }> = []
    for await (const batch of db.iterateVideoKeysBatched(5000)) {
        for (const videoId of batch) {
            if (matched.has(videoId)) continue
            const hit = byHash.get(videoId) ?? byToken.get(videoId.toLowerCase()) ?? titleIndex.find((entry) => entry.title.includes(videoId.toLowerCase()))?.id
            if (hit === undefined) continue
            matched.set(videoId, hit)
            discovered.push({ ID: videoId, href: hit })
        }
    }
    if (discovered.length > 0) await db.bulkPutIdmaps(discovered)

    // ── 阶段二：只处理有映射的条目 ──
    result.total = matched.size
    if (matched.size === 0) {
        result.reason = i18n.t('notify.mediaNoMapping')
        return result
    }

    let lastFailure: { error: string; networkLevel: boolean } | null = null
    for (const [videoId, mediaCenterId] of matched) {
        const [stored] = await db.getVideosByIds([videoId])
        if (!stored) {
            result.failed++
            continue
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
                continue
            }
        }
        const outcome = await pushToMediaCenter(video, mediaCenterId)
        if (outcome.ok) result.pushed++
        else {
            result.failed++
            lastFailure = { error: outcome.error, networkLevel: outcome.networkLevel }
        }
        // 节流：避免服务端瞬时压力
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    // 一条都没成功 → 几乎必然是端点层面的问题（未授权/未启动/服务端拒绝），把真实原因交给 UI
    if (result.pushed === 0 && lastFailure !== null) result.reason = await describeMediaCenterFailure(lastFailure)
    return result
}

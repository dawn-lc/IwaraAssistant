/**
 * aria2 任务恢复 —— **重解析并更新下载地址**（源 `aria2Track.ts` 的
 * `restartAria2Task` / `rebuildAria2Task` 完整移植）。
 *
 * ## 为什么必须有这一层
 *
 * iwara 的直链带 `expires`，几小时后失效。任务躺在 aria2 的 `waiting`/`paused`
 * 里过了这个点，或 `active` 断了一半，aria2 只会把任务标成 `error`（403）。
 * 此时**重新解析一次视频页就能拿到新链接**，任务可以原地续上——不重解析就只剩
 * 「永远 failed，用户重新勾选 → 又是新任务」这一条路，既丢进度又堆垃圾任务。
 *
 * ## 三种恢复手段，按「破坏性从小到大」排序
 *
 * 1. `changeUri` + `unpause`（`restartAria2Task`）：任务本身还在，只把地址换掉。
 *    已下载的数据块保留，**不产生新 gid**。用于 paused / 慢速。
 * 2. `restart` → `changeUri`（`rebuildAria2Task` 的 error 分支）：`error` 状态下
 *    aria2 会**静默忽略** `unpause`（不报错也不改状态），只换地址会卡在 error 形成
 *    假成功循环。所以必须先用 `aria2.restart` 原地重启拿到新 gid，再换地址。
 * 3. `addUri` 新建（最后兜底）：只有在任务已被 `removed`、或上面两步都失败时才用。
 *    会产生新 gid，所以要顺手清掉旧任务的 error/removed 结果，避免下轮扫描
 *    把旧任务当成「另一个同源任务」又拾回来（死循环）。
 *
 * ## 绝不碰用户的历史记录
 *
 * `removeDownloadResult` **只针对本次正在替换的那个旧 gid**（重建成功/冗余清理），
 * 绝不对「扫描到的已完成任务」调用。源项目曾误在去重分支清理结果，导致用户的
 * aria2 历史被脚本静默删除（其 Issue #405），这条教训必须保留。
 */
import { analyzePath } from '../../../shared/analyzePath'
import type { AnalyzedPath } from '../../../shared/analyzePath'
import type { FullVideoInfo } from '../../../shared/videoInfo'
import { i18n } from '../../../shared/i18n'
import { stringify } from '../../../shared/strings'
import { aria2API, aria2TellStatus, type Aria2Status } from './client'
import { getPageCookie } from '../../iwara/auth'
import { getDownloadPath, buildDownloadUrl } from '../../download/downloadPath'
import { aria2AddUriParams } from '../../download/downloaders'
import { parseVideoFull } from '../../iwara/videoApi'

/** 单次恢复的结果；`gid` 与原来不同时调用方必须更新队列的 `kindRef` */
export interface RecoverResult {
    gid: string
    /** 重新解析成功时带回，供调用方更新任务标题/文件名等元数据 */
    videoInfo?: FullVideoInfo
    /** 换了新地址（无论是否新 gid），用于决定要不要提示用户 */
    uriUpdated: boolean
}

/** 任务现有 URI 列表（多源下载可能不止一个） */
function uriListOf(status: Aria2Status): string[] {
    return (status.files?.[0]?.uris ?? []).map((entry) => entry.uri)
}

/** 旧任务的结果记录清理（失败不抛出：可能已被别的方式清掉） */
async function discardResult(gid: string): Promise<void> {
    try {
        await aria2API('aria2.removeDownloadResult', [gid])
    } catch {
        // 忽略
    }
}

/**
 * 重新解析视频，拿到最新下载地址。解析失败时返回 `undefined`，
 * 调用方回退用任务现有 URI（源实现同款：**绝不因解析失败而放弃恢复**）。
 */
async function reparse(videoId: string): Promise<{ videoInfo: FullVideoInfo; url: string } | undefined> {
    try {
        const videoInfo = await parseVideoFull(videoId)
        const url = buildDownloadUrl(videoInfo, getDownloadPath(videoInfo)).href
        return { videoInfo, url }
    } catch (error) {
        console.warn(`[iwara-assistant] ${videoId} 重新解析失败，回退用现有链接:`, stringify(error))
        return undefined
    }
}

/**
 * 手段 1：原地换地址 + 恢复（`paused` / `active` / `waiting` 适用）。
 *
 * **不保留旧地址**：旧链接通常已过期，留着让 aria2 反复重试无效源只会更慢
 * （源实现同一决策）。返回 `undefined` 表示需要降级到 `rebuildAria2Task`。
 */
export async function restartAria2Task(gid: string, videoId: string, status?: Aria2Status): Promise<RecoverResult | undefined> {
    const fresh = await reparse(videoId)
    if (!fresh) return undefined
    const current = status ?? (await aria2TellStatus(gid))
    if (!current) return undefined
    const oldUris = uriListOf(current)
    try {
        await aria2API('aria2.changeUri', [gid, 0, oldUris, [fresh.url]])
        await aria2API('aria2.unpause', [gid])
        return { gid, videoInfo: fresh.videoInfo, uriUpdated: true }
    } catch (error) {
        console.warn(`[iwara-assistant] ${videoId} 原地换地址失败，降级重建:`, stringify(error))
        return undefined
    }
}

/**
 * 手段 2/3：重建任务（`error` / `removed` / 换地址失败时）。
 *
 * `error` 走 `restart`（新 gid）→ `changeUri`；其余状态走 `changeUri`+`unpause`；
 * 两条都失败或被移除 → `addUri` 新建。
 */
export async function rebuildAria2Task(gid: string, videoId: string, status: Aria2Status): Promise<RecoverResult | undefined> {
    const oldUris = uriListOf(status)
    const fresh = await reparse(videoId)
    // 解析失败：回退用任务现有地址（源实现同款），不放弃恢复
    const urls = fresh ? [fresh.url] : oldUris
    if (urls.length === 0) {
        console.warn(`[iwara-assistant] ${videoId} 既无新地址也无旧地址，无法重建`)
        return undefined
    }

    // ① 任务还在（非 removed）：优先原地恢复，避免产生第二个 gid
    if (status.status !== 'removed') {
        try {
            if (status.status === 'error') {
                // error 状态下 unpause 会被 aria2 静默忽略 → 必须 restart 拿新 gid
                const restarted = await aria2API<string>('aria2.restart', [gid])
                const nextGid = restarted.result
                if (typeof nextGid === 'string' && nextGid !== '') {
                    await discardResult(gid)
                    await aria2API('aria2.changeUri', [nextGid, 0, oldUris, urls])
                    return { gid: nextGid, ...(fresh ? { videoInfo: fresh.videoInfo } : {}), uriUpdated: true }
                }
                console.warn(`[iwara-assistant] ${videoId} aria2.restart 返回空 gid，降级 addUri`)
            } else {
                await aria2API('aria2.changeUri', [gid, 0, oldUris, urls])
                await aria2API('aria2.unpause', [gid])
                return { gid, ...(fresh ? { videoInfo: fresh.videoInfo } : {}), uriUpdated: true }
            }
        } catch (error) {
            console.warn(`[iwara-assistant] ${videoId} 原地恢复失败，降级 addUri:`, stringify(error))
        }
    }

    // ② 兜底：新建任务。参数必须与首次投递同源（`aria2AddUriParams`），否则路径/代理会漂移
    try {
        const cookie = await getPageCookie()
        const localPath = fresh ? getDownloadPath(fresh.videoInfo) : pathFromStatus(status, videoId)
        const params = aria2AddUriParams(localPath, cookie)
        const added = await aria2API<string>('aria2.addUri', [urls, params])
        const nextGid = added.result
        if (typeof nextGid !== 'string' || nextGid === '') {
            console.warn(`[iwara-assistant] ${videoId} addUri 返回空 gid`)
            return undefined
        }
        // 只清本次替换掉的那个旧 gid 的结果，避免下轮扫描把它当新任务拾回来
        if (status.status === 'error' || status.status === 'removed') await discardResult(gid)
        return { gid: nextGid, ...(fresh ? { videoInfo: fresh.videoInfo } : {}), uriUpdated: true }
    } catch (error) {
        console.warn(`[iwara-assistant] ${videoId} addUri 重建失败:`, stringify(error))
        return undefined
    }
}

/** 解析不出视频信息时，从任务现有文件路径反推下载目录/文件名（返回完整 AnalyzedPath） */
function pathFromStatus(status: Aria2Status, videoId: string): AnalyzedPath {
    const raw = status.files?.[0]?.path ?? ''
    try {
        const analyzed = analyzePath(raw)
        if (analyzed.fullName !== '') return analyzed
    } catch {
        // 落到下面的兜底
    }
    return analyzePath(`[${videoId}].mp4`)
}

/** aria2 并发队列是否已满（源 `isAria2QueueFull`）：paused 重启前的守门 */
export async function isAria2QueueFull(): Promise<boolean> {
    try {
        const [stat, option] = await Promise.all([aria2API<{ numActive?: string }>('aria2.getGlobalStat', []), aria2API<Record<string, string>>('aria2.getGlobalOption', [])])
        const active = Number.parseInt(stat.result?.numActive ?? '0', 10)
        const maxConcurrent = Number.parseInt(option.result?.['max-concurrent-downloads'] ?? '5', 10)
        if (!Number.isFinite(active) || !Number.isFinite(maxConcurrent)) return false
        return active >= maxConcurrent
    } catch {
        // 查不到并发上限时**不阻塞恢复**：宁可多试一次，也不因为一个附加查询丢掉恢复机会
        return false
    }
}

/** 恢复失败后的用户可见文案（通知是唯一反馈通道，必须能操作） */
export function describeRecoverFailure(videoId: string): string {
    return i18n.t('notify.aria2RecoverFailed', { id: videoId })
}

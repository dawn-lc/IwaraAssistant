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
 * 1. `changeUri` +（仅 paused 时）`unpause`（`restartAria2Task`）：任务本身还在，只把地址换掉。
 *    已下载的数据块保留，**不产生新 gid**。用于 paused / 慢速。调用契约见 `replaceUris`。
 * 2. `changeUri`（`rebuildAria2Task` 的非 error 分支）：同上，但不重解析也必须换地址。
 * 3. `removeDownloadResult` + `addUri` 新建（`error` / `removed` 或换地址失败时）：
 *    会产生新 gid，所以要顺手清掉旧任务的 error/removed 结果，避免下轮扫描
 *    把旧任务当成「另一个同源任务」又拾回来（死循环）。
 *
 * ### ⚠️ `aria2.restart` 不是 aria2 的 RPC 方法（别再写回去）
 *
 * 源项目 `rebuildAria2Task` 的 error 分支写的是「先 `aria2.restart` 拿新 gid 再 `changeUri`」。
 * 实测对端 aria2（`system.listMethods`，该方法**不校验 token**）只有 36 个方法，清单里没有
 * `restart`；aria2 手册的方法表也没有（AddUri…SaveSession + system.*）。也就是说那次调用
 * **必然返回 `No such method`**，源项目靠外层 catch 静默降级到 `addUri`——`restart` 分支
 * 从来没有生效过，只是每次都多打一发必失败的请求。
 *
 * 所以 error 状态直接走「清结果 + addUri」：这是源项目实际执行的那条路径，行为等价、少一次
 * 注定失败的 RPC。
 *
 * ## 绝不碰用户的历史记录
 *
 * `removeDownloadResult` **只针对本次正在替换的那个旧 gid**（重建成功/冗余清理），
 * 绝不对「扫描到的已完成任务」调用。源项目曾误在去重分支清理结果，导致用户的
 * aria2 历史被脚本静默删除（其 Issue #405），这条教训必须保留。
 */
import { analyzePath } from '../../../shared/analyzePath'
import type { AnalyzedPath } from '../../../shared/analyzePath'
import { buildChangeUriParams, canRebuildFromOldUris } from '../../../shared/aria2Recover'
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

/**
 * 任务现有 URI 列表（多源下载可能不止一个）。
 *
 * 去重：aria2 对同一个 URI 的重试会在 `uris` 里留下多条记录（实测一次挂起的任务
 * 有 16 条），`changeUri` 的 `delUris` 对重复项**每次只删一条**，传去重后的列表
 * 语义更清楚（也不必给 RPC 塞 16 份同样的字符串）。
 */
function uriListOf(status: Aria2Status): string[] {
    return [...new Set((status.files?.[0]?.uris ?? []).map((entry) => entry.uri))]
}

/**
 * 换掉任务的全部下载地址（参数形状见 `buildChangeUriParams`）。
 *
 * `unpause` **只能对 `paused` 调**：实测对 `active` 任务返回
 * `GID#xxx cannot be unpaused now`（整个调用抛错，把前面的 changeUri 也一起判成失败）。
 * `waiting` 不需要 unpause——它在 aria2 的内部队列里，换完地址自然会被调度。
 */
async function replaceUris(gid: string, status: Aria2Status, oldUris: string[], urls: string[]): Promise<void> {
    await aria2API('aria2.changeUri', buildChangeUriParams(gid, oldUris, urls))
    if (status.status === 'paused') await aria2API('aria2.unpause', [gid])
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
 * 手段 1：原地换地址（`paused` / `active` / `waiting` 适用）。
 *
 * **不保留旧地址**：旧链接通常已过期，留着让 aria2 反复重试无效源只会更慢
 * （源实现同一决策）。
 *
 * 返回判别联合而不是 `undefined`：调用方需要区分「拿不到新地址」和「拿到了但换不上去」——
 * 前者重试原地换地址才有意义（降级重建只会制造重复任务，见 `canRebuildFromOldUris`），
 * 后者才值得降级重建。
 */
export type RestartOutcome = { kind: 'ok'; result: RecoverResult } | { kind: 'reparse-failed' } | { kind: 'uri-change-failed' }

export async function restartAria2Task(gid: string, videoId: string, status?: Aria2Status): Promise<RestartOutcome> {
    const fresh = await reparse(videoId)
    if (!fresh) return { kind: 'reparse-failed' }
    const current = status ?? (await aria2TellStatus(gid))
    if (!current) return { kind: 'uri-change-failed' }
    const oldUris = uriListOf(current)
    try {
        await replaceUris(gid, current, oldUris, [fresh.url])
        return { kind: 'ok', result: { gid, videoInfo: fresh.videoInfo, uriUpdated: true } }
    } catch (error) {
        console.warn(`[iwara-assistant] ${videoId} 原地换地址失败:`, stringify(error))
        return { kind: 'uri-change-failed' }
    }
}

/**
 * 手段 2/3：重建任务（`error` / `removed` / 换地址失败时）。
 *
 * `error` / `removed` 直接 `removeDownloadResult` + `addUri`（`aria2.restart` 不存在，见文件头）；
 * 其余状态先试 `changeUri` + `unpause`，失败才新建。
 */
export async function rebuildAria2Task(gid: string, videoId: string, status: Aria2Status): Promise<RecoverResult | undefined> {
    const oldUris = uriListOf(status)
    const fresh = await reparse(videoId)
    // ⚠️ 没有新地址时**不能**无条件回退用旧地址：只有已死的任务才能这么兜底，
    // 还活着的任务用同一批旧地址重建 = 制造第二个同源任务抢写同一文件 + 丢掉已下字节。
    // 这条门是 2026-10-21 事故的直接修复（87 个正在运行的任务被 addUri 复制）。
    if (!canRebuildFromOldUris(status.status, fresh !== undefined)) {
        console.warn(`[iwara-assistant] ${videoId} 重新解析失败且任务仍在 ${status.status}，放弃本轮重建（用旧地址新建只会产生重复任务）`)
        return undefined
    }
    // 解析失败（此时必然是 error/removed）：回退用任务现有地址，不放弃恢复
    const urls = fresh ? [fresh.url] : oldUris
    if (urls.length === 0) {
        console.warn(`[iwara-assistant] ${videoId} 既无新地址也无旧地址，无法重建`)
        return undefined
    }

    // ① 任务还在、且不是 error/removed：原地换地址（paused 才补 unpause），不产生第二个 gid。
    //    error 状态**不能**走这条路：`changeUri` 会接受（换地址成功）、`unpause` 对 error 任务
    //    不报错也不改状态，任务会永远停在 error 形成假成功循环。而「restart 拿新 gid」在
    //    aria2 上不存在（见文件头），所以 error 直接落到下面的 addUri。
    if (status.status !== 'removed' && status.status !== 'error') {
        try {
            await replaceUris(gid, status, oldUris, urls)
            return { gid, ...(fresh ? { videoInfo: fresh.videoInfo } : {}), uriUpdated: true }
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

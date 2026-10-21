/**
 * 「下载完成后推送到 MediaCenter」的失败重试（源 `aria2Track` 的 complete 分支）。
 *
 * 判据在 `shared/mediaCenterPush.ts`（纯函数、已单测），这里只做读写与调度。
 *
 * 调用点：
 * - `backends/aria2/tracker.ts` 的 `handleDownloadComplete`：完成时**先试一次**，
 *   失败就登记；
 * - `scanAria2TasksAndEnqueue`（5 分钟一次，与源项目的重试间隔一致）：把到期的重试掉；
 * - `boot()`：上一代进程留下的待推送（浏览器重启不丢，见 `MEDIA_CENTER_PUSH_KEY`）。
 */
import { MEDIA_CENTER_PUSH_KEY } from '../../shared/storageKeys'
import { nextPendingPush, isPushExhausted, parsePendingPushes, shouldRetryPush, type PendingMediaCenterPush, type PendingPushTable } from '../../shared/mediaCenterPush'
import { stringify } from '../../shared/strings'
import { isMediaCenterConfigured, pushVideoIdToMediaCenter } from '../iwara/mediaCenter'

/** 防重入：扫描与 boot 可能同时触发 flush，撞车只会重复推送同一条 */
let flushing = false

async function readTable(): Promise<PendingPushTable> {
    try {
        const stored = await browser.storage.local.get(MEDIA_CENTER_PUSH_KEY)
        return parsePendingPushes(stored?.[MEDIA_CENTER_PUSH_KEY])
    } catch (error) {
        console.warn('[iwara-assistant] 读取待推送表失败:', stringify(error))
        return {}
    }
}

async function writeTable(table: PendingPushTable): Promise<void> {
    try {
        await browser.storage.local.set({ [MEDIA_CENTER_PUSH_KEY]: table })
    } catch (error) {
        console.warn('[iwara-assistant] 写入待推送表失败:', stringify(error))
    }
}

/**
 * 下载完成后推送一次；失败就登记，交给后续扫描重试。
 *
 * 未配置 MediaCenter 时 `pushVideoIdToMediaCenter` 直接返回 true（无事可做），
 * 不会产生登记条目——否则每个完成的任务都会在表里留一条无意义的记录。
 */
export async function pushAfterDownload(videoId: string, filename?: string): Promise<void> {
    if (!isMediaCenterConfigured()) return
    const ok = await pushVideoIdToMediaCenter(videoId, filename)
    if (ok) {
        // 成功：顺手清掉可能存在的旧登记（例如上一次失败后又手动同步成功）
        const table = await readTable()
        if (table[videoId] !== undefined) {
            delete table[videoId]
            await writeTable(table)
        }
        return
    }
    const table = await readTable()
    table[videoId] = nextPendingPush(table[videoId], videoId, filename, Date.now())
    await writeTable(table)
    console.warn(`[iwara-assistant] MediaCenter 推送失败，已登记待重试: ${videoId}`)
}

/**
 * 把到期的待推送逐条重试（5 分钟一次）。
 *
 * 单条失败不影响其余；超过重试上限的记录直接丢弃并留日志——不能因为一个填错的
 * API Key 让扩展永远每 5 分钟打一次端点（见 `shared/mediaCenterPush.ts` 文件头）。
 */
export async function flushMediaCenterPushes(): Promise<void> {
    if (flushing) return
    if (!isMediaCenterConfigured()) return
    const table = await readTable()
    const entries = Object.values(table)
    if (entries.length === 0) return
    flushing = true
    try {
        const now = Date.now()
        let changed = false
        for (const entry of entries) {
            if (isPushExhausted(entry)) {
                console.warn(`[iwara-assistant] MediaCenter 推送放弃（已试 ${entry.attempts} 次）: ${entry.videoId}`)
                delete table[entry.videoId]
                changed = true
                continue
            }
            // 还没到重试时间：保留，不写回（表本身已经在存储里）
            if (!shouldRetryPush(entry, now)) continue
            const ok = await pushVideoIdToMediaCenter(entry.videoId, entry.filename)
            if (ok) {
                delete table[entry.videoId]
                console.info(`[iwara-assistant] MediaCenter 推送重试成功: ${entry.videoId}`)
            } else {
                table[entry.videoId] = nextPendingPush(entry, entry.videoId, entry.filename, now)
            }
            changed = true
        }
        if (changed) await writeTable(table)
    } finally {
        flushing = false
    }
}

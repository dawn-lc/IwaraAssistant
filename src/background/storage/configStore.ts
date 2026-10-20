/**
 * 配置存取 —— CONFIG 通道唯一事实源（storage.local.config）
 * 挂起重入时内存副本重建；变更经 CONFIG_SYNC 广播 + 回填列表重推（docs/04）
 */
import type { PageConfig } from '../../messaging/protocol'
import { CONFIG_KEY } from '../../shared/storageKeys'
import { changedValue } from '../../shared/storageChanges'
import type { Config } from '../../shared/configSchema'
import { configSchema, DEFAULT_CONFIG } from '../../shared/configSchema'
import { broadcastToIwaraTabs } from '../../messaging/hub'
import { db } from './db'
import { CACHE_WINDOW_PAD_MS, computeCacheList } from './cacheList'

let memConfig: Config = { ...DEFAULT_CONFIG }

export function parseStoredConfig(stored: unknown): Promise<Config> {
    const result = configSchema.safeParse(stored ?? {})
    if (result.success) return Promise.resolve(result.data)
    console.warn('[iwara-assistant] stored config invalid, fallback to defaults:', JSON.stringify(result.error.issues.slice(0, 3)))
    return Promise.resolve({ ...DEFAULT_CONFIG })
}

export const configReady: Promise<void> = (async () => {
    memConfig = await parseStoredConfig((await browser.storage.local.get(CONFIG_KEY))[CONFIG_KEY])
})()

/** 同步读配置（configReady resolve 后有效；模块顶层调用方先 await configReady） */
export function getConfig(): Config {
    return memConfig
}

/** MAIN 世界改写所需的配置子集（JSON 通道仅含布尔开关） */
export function pageConfigOf(config: Config): PageConfig {
    return {
        filterLikedVideos: config.filterLikedVideos,
        filterUnlistedAndPrivate: config.filterUnlistedAndPrivate,
        addUnlistedAndPrivate: config.addUnlistedAndPrivate
    }
}

/** 库内最新 UploadTime ± 窗宽（库空为 null）——页面窗口未知时兜底 */
export async function defaultWindow(): Promise<{ start: number; end: number } | null> {
    const latest = await db.getLatestUploadTime()
    if (latest == null) return null
    return { start: latest - CACHE_WINDOW_PAD_MS, end: latest + CACHE_WINDOW_PAD_MS }
}

export async function refreshCacheInjection(windowStart: number, windowEnd: number): Promise<void> {
    const injection = await computeCacheList(windowStart, windowEnd)
    await broadcastToIwaraTabs({ type: 'CACHE_INJECTION_LIST', payload: injection })
}

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(CONFIG_KEY in changes)) return
    void configReady.then(async () => {
        memConfig = await parseStoredConfig(changedValue(changes, CONFIG_KEY))
        await broadcastToIwaraTabs({ type: 'CONFIG_SYNC', payload: { page: pageConfigOf(memConfig) } })
        const windowBounds = await defaultWindow()
        if (windowBounds) await refreshCacheInjection(windowBounds.start, windowBounds.end)
    })
})

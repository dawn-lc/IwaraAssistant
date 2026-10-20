/**
 * 页面就绪快照（`PAGE_READY`）—— 页面引动时返回的初始数据。
 *
 * 内容只有两件：**配置快照**（页内 UI 要据此决定注入哪些控件）与**回填列表**
 * （MAIN 世界改写 `/videos` 响应时用来补全记录）。两者都不连外网，只读本地。
 *
 * 为什么要等 `configReady`：`getConfig()` 在配置读盘完成前返回 `DEFAULT_CONFIG` 副本，
 * 而 `PAGE_READY` 可能在 SW 冷启动后立刻到达——不等就会把默认配置当成用户配置发给页面
 * （表现为「刚打开页面时语言/开关是默认值，刷新一下才对」）。
 */
import type { CacheInjection, PageConfig } from '../../messaging/protocol'
import { computeCacheList } from './cacheList'
import { configReady, defaultWindow, getConfig, pageConfigOf } from './configStore'

export async function pageReadySnapshot(): Promise<{ pageConfig: PageConfig; cacheList: CacheInjection | null }> {
    await configReady
    const windowBounds = await defaultWindow()
    const cacheList = windowBounds ? await computeCacheList(windowBounds.start, windowBounds.end) : null
    return { pageConfig: pageConfigOf(getConfig()), cacheList }
}

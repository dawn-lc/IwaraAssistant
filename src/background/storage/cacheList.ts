/**
 * 缓存回填列表（CACHE_INJECTION_LIST 载荷）—— 原 handleVideosResponse 内联逻辑的拆出
 *
 * 原实现每次 /videos 响应同步查库取窗口内 private/unlisted 缓存并排序；
 * 扩展化后由后台预计算推送给 MAIN 世界做纯合并（docs/01 注入最小化：
 * MAIN 不查库、不引入 idb 依赖）。与原版的唯一偏差：列表按「页面窗口上报
 * → 后台计算 → 下行推送」异步到达，首个响应若早于推送则该页暂不回填
 * （后续同窗口响应即时生效）。
 */
import { db } from './db'
import type { CacheInjection } from '../../messaging/protocol'

export type { CacheInjection }

/** 原 handleVideosResponse 的窗宽（dayjs add/sub { hours: 4 }） */
export const CACHE_WINDOW_PAD_MS = 4 * 60 * 60 * 1000

export async function computeCacheList(windowStart: number, windowEnd: number): Promise<CacheInjection> {
    const filtered = await db.getFilteredVideos(windowStart, windowEnd)
    // 原实现：filter(partial/full) → 按 UploadTime 降序 → map RAW
    const raws = filtered
        .filter((video) => video.Type === 'partial' || video.Type === 'full')
        .sort((a, b) => b.UploadTime - a.UploadTime)
        .map((video) => video.RAW)
    return { windowStart, windowEnd, raws }
}

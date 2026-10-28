/**
 * 缓存回填列表（`GET_CACHE_INJECTION` / `CACHE_INJECTION_LIST` 载荷）—— 原 handleVideosResponse 内联逻辑的拆出
 *
 * 原实现每次 /videos 响应同步查库取窗口内 private/unlisted 缓存并排序；
 * 扩展化后 MAIN 世界不能查库，改为按当前页窗口向后台要一份即时列表
 * （docs/04 的 `GET_CACHE_INJECTION`）：查库与排序仍在后台，MAIN 只做纯合并。
 * `CACHE_INJECTION_LIST` 推送（入库/配置变更后重算）只作后台暂时不可用时的兜底——
 * 它对应的是「上一页」窗口，不能作为主路径。
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

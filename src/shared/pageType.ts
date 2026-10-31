/**
 * 页面类型识别 —— 原 core/pageType.ts 的精简版（只保留扩展页内交互需要的分类）
 *
 * 原版用路径段模式匹配 30+ 路由；扩展侧的页内控件只关心：
 * - video：视频详情页（可"下载当前视频"）
 * - videoList：视频卡片列表（可注入复选框 / 批量下载）
 * - other：其余页面（只保留手动下载入口）
 */

export type PageType = 'video' | 'videoList' | 'other'

/** 视频列表类路由（原 PageType 的 Home/Search/Profile/VideoList/Subscriptions/Playlist/Favorites/History） */
const LIST_ROUTES = new Set(['', 'videos', 'search', 'profile', 'p', 'subscriptions', 'playlist', 'favorites', 'history'])

function segmentsOf(pathname: string): string[] {
    return pathname.split('/').filter(Boolean)
}

/** 从路径取视频 ID（/video/:id 与短链 /v/:id） */
export function videoIdFromPath(pathname: string): string | null {
    const segments = segmentsOf(pathname)
    if (segments.length < 2) return null
    if (segments[0] === 'video' || segments[0] === 'v') return segments[1] ?? null
    return null
}

/** 从路径取列表页分类（列表页返回 true） */
export function isVideoListPath(pathname: string): boolean {
    const segments = segmentsOf(pathname)
    if (segments.length === 0) return true // 首页
    const head = segments[0] ?? ''
    if (!LIST_ROUTES.has(head)) return false
    // /profile/:id/... 与 /playlist/:id 也属列表页；/videos（全站列表）同理
    return true
}

/**
 * 是否落在**全站视频列表页** `/videos`（源项目 `PageType.VideoList`）。
 *
 * 与 `isVideoListPath` 刻意区分：后者覆盖首页 / 搜索 / 主页 / 播放列表等所有带卡片的路由，
 * 而订阅流自动遍历的触发页在源项目里只有 `/videos`（首页是 `PageType.Home`，不触发）。
 * 用窄判据是为了照搬源行为——否则每次刷首页都会多打一轮订阅流请求。
 */
export function isAllVideosPath(pathname: string): boolean {
    const segments = segmentsOf(pathname)
    return segments.length === 1 && segments[0] === 'videos'
}

/** 解析当前页面类型 */
export function pageTypeOf(pathname: string): PageType {
    if (videoIdFromPath(pathname) !== null) return 'video'
    if (isVideoListPath(pathname)) return 'videoList'
    return 'other'
}

/** 从视频卡片元素解析视频 ID（原 checkbox 注入逻辑：缩略图链接末段） */
export function videoIdFromCard(card: Element): string | null {
    const thumbnail = card.querySelector('a.videoTeaser__thumbnail') as HTMLAnchorElement | null
    if (!thumbnail) return null
    try {
        return videoIdFromPath(new URL(thumbnail.href).pathname)
    } catch {
        return null
    }
}

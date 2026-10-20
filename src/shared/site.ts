/**
 * 站点端点常量 —— 原 context/site.ts 的固化（扩展后台无页面 location，取官方域名白名单）
 */
export const API_ENDPOINT = 'api.iwara.tv'
export const SITE_HOST = 'www.iwara.tv'

/**
 * 官方域名（与源用户脚本 `src/data/site.json` 的 `officialDomains` 一致）。
 *
 * 注意与 `SUPPORTED` 的区别：这是「官方身份」清单，用来判定钓鱼仿冒；
 * 本扩展目前**只在 iwara.tv 上工作**（API 与 DOM 契约都只对这一个站点验证过）。
 */
export const OFFICIAL_DOMAINS = ['iwara.tv', 'iwara.zip', 'iwara.shop', 'iwara.ai'] as const

/**
 * 出现在**非官方**域名里即视为疑似仿冒的关键词（源脚本同名字段）。
 *
 * 为什么用关键词而不是黑名单：仿冒站点每天都在换域名（`iwara-video.xyz`、
 * `iwara.tv.evil.com`、`lwara-download.net` 之类），静态黑名单永远追不上；
 * 而所有仿冒站都必须蹭品牌词，才能骗到搜索与误输入的用户。
 */
export const PHISHING_KEYWORDS = ['iwara'] as const

/** 主机名分层：官方 / 疑似仿冒 / 无关站点（无关站点不做任何事） */
export type HostVerdict = 'official' | 'suspicious' | 'other'

/**
 * 判定主机名属于哪一层。
 *
 * 只在**完整标签**上匹配官方域名：`iwara.tv.evil.com` 的 `endsWith('iwara.tv')` 为假，
 * 因此它会被归入 suspicious 而不是 official——这正是最常见的仿冒构造方式。
 */
export function classifyHost(hostname: string): HostVerdict {
    const host = hostname.trim().toLowerCase().replace(/\.$/, '')
    if (host === '') return 'other'
    const official = OFFICIAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
    if (official) return 'official'
    return PHISHING_KEYWORDS.some((keyword) => host.includes(keyword)) ? 'suspicious' : 'other'
}

/** API 端点 URL（原 apiUrl：路径段拼接，query 用 URLSearchParams） */
export function apiUrl(path: string, query?: URLSearchParams): URL {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `https://${API_ENDPOINT}`)
    if (query !== undefined) url.search = query.toString()
    return url
}

/** 站点页面 URL（视频页 / 播放列表页等；后台没有 `location`，只能按官方域名拼） */
export function siteUrl(path: string): string {
    return new URL(path.startsWith('/') ? path : `/${path}`, `https://${SITE_HOST}`).toString()
}

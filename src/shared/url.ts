/**
 * URL 判据 —— fetch 入参解析 + 下载地址反查视频 ID。
 *
 * 两件事放在一起是因为它们是同一个坑的两端：**URL 没有 base 或参数没解析，就会静默失效**。
 * 前者（协议相对 URL）让整条入库链路瘫痪而页面看起来完全正常；
 * 后者（读错字段）让 iwaradl 的 `kindRef` 变成随机 uuid，永远对不上任何任务。
 */

/**
 * fetch 入参 → URL 解析（MAIN 世界拦截器的入口判断）。
 *
 * 为什么必须带 base：站点会用**协议相对 URL** 调 API，例如
 * `fetch('//api.iwara.tv/videos?rating=all')`。`new URL('//api.iwara.tv/videos')`
 * 在没有 base 时**直接抛 TypeError**，拦截器若把这种情况当成「非法 URL 放行」，
 * 就会静默漏掉全部真实 API 请求——入库、token 捕获、点赞过滤、缓存回填全部失效，
 * 且页面表现完全正常，属于最难发现的失效方式（真实站点冒烟抓到的核心缺陷）。
 *
 * 语义对齐原生 fetch：绝对 URL 原样、协议相对继承 `location.protocol`、
 * 相对路径按当前文档解析。
 */
export function resolveRequestUrl(input: unknown, base: string): URL {
    if (input instanceof URL) return new URL(input.href, base)
    if (typeof input === 'string') return new URL(input, base)
    const candidate = (input as { url?: unknown } | null | undefined)?.url
    if (typeof candidate === 'string') return new URL(candidate, base)
    throw new TypeError('unsupported fetch input')
}

/**
 * 从下载地址反查「这是哪个视频」。
 *
 * 扩展在拼下载地址时会注入 `videoid` 参数（`buildDownloadUrl`），它是**我们自己的标记**，
 * 所以既能给 aria2 任务反查视频 ID，也能把「浏览器自己下的那条」认回队列
 * （`download/adopt.ts` 的接管）。不是我们发的下载请求就不带这个参数，返回 undefined。
 */
export function videoIdOfDownloadUrl(raw: string): string | undefined {
    try {
        const videoId = new URL(raw).searchParams.get('videoid')
        return videoId === null || videoId === '' ? undefined : videoId
    } catch {
        return undefined
    }
}

/**
 * 下载地址的过期时间戳（**秒**）；URL 非法或没有 `expires` 参数时返回 `-Infinity`。
 *
 * `-Infinity` 的语义是「无法判断」，不是「已过期」：调用方必须分开处理
 * （aria2 择优时排到最后；快照复用判据则选择信任）。
 */
export function uriExpiresAt(uri: string): number {
    try {
        const expires = new URL(uri).searchParams.get('expires')
        if (expires === null) return -Infinity
        const value = Number(expires)
        return Number.isFinite(value) ? value : -Infinity
    } catch {
        return -Infinity
    }
}

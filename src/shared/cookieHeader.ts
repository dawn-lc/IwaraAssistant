/**
 * `Cookie` 请求头的拼装（纯函数）。
 *
 * 为什么不直接用页面送上来的 `document.cookie`：那份快照**看不到 HttpOnly**（`cf_clearance` 这类
 * 会话凭据恰好都是 HttpOnly），而且只在用户打开/刷新 iwara 页面时才刷新一次。
 * 扩展有 `<all_urls>` 主机权限后，`browser.cookies.getAll()` 能读到完整 cookie jar（含 HttpOnly），
 * 所以投递时现取一份、拼成头，快照只作为兜底（老版本升级上来的用户、或 cookies API 不可用时）。
 */
export interface CookieLike {
    name: string
    value: string
    /** 同名 cookie 可能按 path 分成多条；取 path 最长的那条（最具体的那一条才是浏览器实际会发的） */
    path?: string
}

export function buildCookieHeader(cookies: readonly CookieLike[]): string {
    const chosen = new Map<string, CookieLike>()
    for (const cookie of cookies) {
        if (typeof cookie.name !== 'string' || cookie.name === '') continue
        if (typeof cookie.value !== 'string') continue
        const kept = chosen.get(cookie.name)
        if (kept === undefined || (cookie.path ?? '').length > (kept.path ?? '').length) chosen.set(cookie.name, cookie)
    }
    return Array.from(chosen.values())
        .map((cookie) => cookie.name + '=' + cookie.value)
        .join('; ')
}

/**
 * aria2 / iwaradl 的 cookie 头。
 *
 * 空 cookie 时返回 `undefined`（配合 `prune` 就不会写这个键）：
 * 发一个内容为空的 `Cookie:` 头没有任何好处，某些反代会把它当成畸形请求。
 */
export function aria2CookieHeader(cookie: string): string[] | undefined {
    return cookie === '' ? undefined : ['Cookie:' + cookie]
}

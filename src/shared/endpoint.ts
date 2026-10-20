/**
 * 外部端点（aria2 / iwaradl / MediaCenter / 任意检查链接）的访问权限与失败文案。
 *
 * 为什么需要这一层：manifest 现在一次性声明 `<all_urls>`，正常情况下用户不需要
 * 做任何授权动作；但用户仍可在浏览器扩展管理页把「站点访问」收窄成「点击时」，
 * 或在 Firefox 上撤销主机权限。此时浏览器只会抛一句 `TypeError`：
 * - Firefox：`NetworkError when attempting to fetch resource.`
 * - Chrome：`Failed to fetch`
 *
 * 这句话既不说连的是哪个端点，也不说该做什么；而我们的反馈通道只有系统通知、
 * 任务面板的一行 detail、和设置页的一个徽章。所以**必须翻译**成
 * 「哪个端点 + 下一步做什么」，同时保留引擎原文作为证据。
 *
 * 一个关键事实：**「未授权」与「端点没起来」在浏览器层面是同一个 TypeError**，
 * 无法从 error 本身区分。唯一可靠的判据是 `permissions.contains()`：
 * - 未授权 → 提示去扩展管理页放开站点访问（此时说「守护进程是否已启动」是误导）
 * - 已授权 → 才可能是进程/端口/网络问题
 *
 * 文案里只报 `host`，不报完整 URL：端点常常带 token 之类的查询参数，
 * 不该被写进系统通知与日志。
 */
import { i18n } from './i18n'

/** 一个外部端点的身份：用于拼文案（`设置 → RPC` 这类路径必须与真实 UI 一致） */
export interface EndpointTarget {
    /** 用户可见的名字，如 `aria2` / `MediaCenter` */
    name: string
    /** 授权入口所在位置，如 `设置 → RPC` */
    settingsPath: string
    /**
     * 连不上时附加的排查提示（i18n key）。
     * 必须按目标类型区分：aria2/iwaradl 是本机守护进程（提示「是否已启动/端口对不对」），
     * MediaCenter 是远端服务（提示「服务是否在线/网络是否可达」）——
     * 给远端服务说「守护进程是否已启动」是误导。
     */
    hintKey: 'error.hintDaemon' | 'error.hintService'
}

export interface ParsedEndpoint {
    href: string
    /** `host:port`（不含协议与路径），用于文案 */
    host: string
    /** `permissions` 用的 origin 模式：`http://host:port/*` */
    pattern: string
}

/**
 * 解析并校验端点。只接受 http/https 的**绝对**地址：
 * `fetch('127.0.0.1:6800')` 会按相对路径解析到一个荒谬的地址，
 * 而 `file:` / `ftp:` 之类的协议根本不是 HTTP 端点。
 */
export function parseEndpoint(raw: string): ParsedEndpoint | null {
    if (typeof raw !== 'string' || raw.trim() === '') return null
    try {
        const url = new URL(raw.trim())
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        return { href: url.href, host: url.host, pattern: `${url.protocol}//${url.host}/*` }
    } catch {
        return null
    }
}

/** 该端点 origin 是否已授权（地址非法或 API 不可用时保守返回 false） */
export async function hasEndpointAccess(raw: string): Promise<boolean> {
    const endpoint = parseEndpoint(raw)
    if (endpoint === null) return false
    try {
        return await browser.permissions.contains({ origins: [endpoint.pattern] })
    } catch {
        return false
    }
}

/**
 * 端点地址本身就不合法（用户填错）：直接指出并回显他填的值。
 * 不静默回落到默认端点——那会把「填错了」变成「莫名其妙连到了别处」。
 */
export function describeEndpointInvalid(target: EndpointTarget, raw: string): string {
    return i18n.t('error.endpointInvalid', { target: target.name, endpoint: raw })
}

/**
 * 浏览器「请求被拒/没发出去」的错误原文（三宿主各不同）。
 *
 * 为什么需要识别它：**未授权不等于请求一定失败**。扩展 fetch 一个没有 host 权限的
 * 站点时，只要对方返回了宽松的 CORS 头，请求照样成功（实测 `CHECK_LINK` 对一个未授权
 * 的 HTTPS 站点返回 200）。反过来，aria2 这类本机守护进程默认不发 CORS 头，于是同一份
 * 「未授权」配置下它就会抛 NetworkError。
 *
 * 所以判断顺序必须是「先看错误是不是网络层的，再看权限」——否则 DNS 解析失败、
 * 证书错误之类的普通网络问题也会被误报成「去授权」。
 */
const NETWORK_LEVEL_FAILURE = /NetworkError|Failed to fetch|Load failed|Network request failed/i

/** 该错误原文是否属于「请求没发出去/被拦下」这一类（供调用方复用同一判据） */
export function isNetworkLevelFailure(detail: string): boolean {
    return NETWORK_LEVEL_FAILURE.test(detail)
}

/**
 * Firefox 的本地网络访问策略：**只在 MV3 上**拦「扩展页 → 局域网/私有地址的明文 http」。
 * 完整实测矩阵与源码依据见 docs/02-cross-browser.md，这里只记影响判据的三条：
 * - 回环（`localhost` / `127.x` / `::1`）豁免，靠 pref
 *   `network.lna.local-network-to-localhost.skip-checks`（默认 true）
 * - **MV2 完全豁免**（fetch / XHR / ws 打局域网均成功），所以判据必须看 manifest 版本，
 *   否则将来出 MV2 变体时会把「守护进程真没起来」误报成「浏览器拦了」
 * - 与主页权限无关，且用户侧关不掉（`network.lna.*`、`dom.security.https_first` 全试过）
 *
 * 为什么只能用启发式而不是真实错误码：拿错误码要额外申请 `webRequest` 权限订阅
 * `onErrorOccurred`，为一句提示文案不划算。
 */
function isManifestV2(): boolean {
    try {
        return typeof browser !== 'undefined' && browser.runtime.getManifest().manifest_version === 2
    } catch {
        return false
    }
}

function firefoxBlocksLanHttp(href: string): boolean {
    if (typeof navigator === 'undefined' || !navigator.userAgent.includes('Firefox')) return false
    if (isManifestV2()) return false
    try {
        const url = new URL(href)
        if (url.protocol !== 'http:') return false
        return !/^(localhost|127(\.\d+){3}|\[?::1\]?)$/i.test(url.hostname)
    } catch {
        return false
    }
}

/**
 * 调用端点失败后的提示。
 *
 * @param detail 引擎原文（`TypeError` 的 message 等），保留在末尾作为证据
 * @param authorized 该端点 origin 的 host 权限是否已授予（`hasEndpointAccess`）
 */
export function describeEndpointFailure(target: EndpointTarget, raw: string, detail: string, authorized: boolean): string {
    const endpoint = parseEndpoint(raw)
    if (endpoint === null) return describeEndpointInvalid(target, raw)
    const hint = i18n.t(target.hintKey)
    // 已授权 → 权限不是原因。但 Firefox 上「内网 http」还有一层浏览器策略（LNA），
    // 必须与进程/端口问题分开说，否则用户会去重启一个好好的守护进程
    if (authorized) {
        if (isNetworkLevelFailure(detail) && firefoxBlocksLanHttp(endpoint.href)) return i18n.t('error.endpointLanBlocked', { target: target.name, host: endpoint.host, detail })
        return i18n.t('error.endpointUnreachable', { target: target.name, host: endpoint.host, detail, hint })
    }
    // 未授权 + 网络层错误 → 最可能是权限/CORS 拦下的，指向授权入口
    if (isNetworkLevelFailure(detail)) return i18n.t('error.endpointNotAuthorized', { target: target.name, host: endpoint.host, settingsPath: target.settingsPath })
    // 未授权但不是网络层错误 → 证据不足，如实给原文而不是硬塞「去授权」
    return i18n.t('error.endpointUnreachable', { target: target.name, host: endpoint.host, detail, hint })
}

/**
 * 端点**可达但被服务端拒绝**（HTTP 4xx/5xx、业务错误）。
 *
 * 这时不能说「无法连接」——连接明明成功了；也不是权限问题，而是 token/参数/服务端状态。
 * 保留服务端原话，用户/开发者才有据可查。
 */
export function describeEndpointRejected(target: EndpointTarget, detail: string): string {
    return i18n.t('error.endpointRejected', { target: target.name, detail })
}

/**
 * 包住一次端点调用，失败时抛出可操作文案。
 *
 * 只包裹**网络调用本身**：端点返回的业务错误（token 不对、参数被拒）由调用方处理，
 * 不能被当成「连不上」掩盖掉。
 */
export async function callEndpoint<T>(target: EndpointTarget, raw: string, run: () => Promise<T>): Promise<T> {
    if (parseEndpoint(raw) === null) throw new Error(describeEndpointInvalid(target, raw))
    try {
        return await run()
    } catch (error) {
        throw new Error(describeEndpointFailure(target, raw, error instanceof Error ? error.message : String(error), await hasEndpointAccess(raw)))
    }
}

/** 常用的几个端点身份（设置页路径与文案必须与真实 UI 一致） */
export const ARIA2_TARGET: EndpointTarget = { name: 'aria2', settingsPath: '设置 → RPC', hintKey: 'error.hintDaemon' }
export const IWARADL_TARGET: EndpointTarget = { name: 'iwaradl', settingsPath: '设置 → RPC', hintKey: 'error.hintDaemon' }
export const MEDIA_CENTER_TARGET: EndpointTarget = { name: 'MediaCenter', settingsPath: '设置 → 高级', hintKey: 'error.hintService' }

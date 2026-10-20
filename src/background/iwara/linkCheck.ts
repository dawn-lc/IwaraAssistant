/**
 * 评论下载链接检测 —— 原 download/linkCheck.ts 原样移植
 *
 * 另含 CHECK_LINK 的链接可达性检查（后台 fetch，绕开页面 CORS）。
 */
import { isEmpty } from '../../shared/strings'
import { i18n } from '../../shared/i18n'
import { hasEndpointAccess, isNetworkLevelFailure } from '../../shared/endpoint'
import { matchesDownloadLink } from '../../shared/linkPatterns'
import { getConfig } from '../storage/configStore'

/** 检查简介/评论中是否包含第三方网盘链接（`checkDownloadLink` 开关控制） */
export function checkIsHaveDownloadLink(comment: string): boolean {
    if (!getConfig().checkDownloadLink || isEmpty(comment)) {
        return false
    }
    return matchesDownloadLink(comment)
}

/** CHECK_LINK 结果（status=0 表示请求未完成，reason 说明原因） */
export interface LinkCheckResult {
    status: number
    ok: boolean
    reason?: string
}

/**
 * 链接可达性检查（options 里手动验证直链/RPC 端点是否可访问）。
 *
 * - 只允许 http/https：防止被当成任意协议的探测器
 * - 先 HEAD（省流量）；部分服务器拒绝 HEAD（405/501）时回退 `Range: bytes=0-0` 的 GET
 * - 有超时，不让用户对着卡住的界面等
 */
export async function checkLinkReachable(rawUrl: string, timeoutMs = 10_000): Promise<LinkCheckResult> {
    let url: URL
    try {
        url = new URL(rawUrl.trim())
    } catch {
        return { status: 0, ok: false, reason: i18n.t('error.urlInvalid') }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { status: 0, ok: false, reason: i18n.t('error.urlProtocol') }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const head = await fetch(url.href, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
        if (head.ok || (head.status !== 405 && head.status !== 501)) {
            return head.ok ? { status: head.status, ok: true } : { status: head.status, ok: false, reason: `HTTP ${head.status}` }
        }
        // HEAD 不被支持：取 1 字节验证可达性
        const ranged = await fetch(url.href, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            redirect: 'follow',
            signal: controller.signal
        })
        return ranged.ok || ranged.status === 206 ? { status: ranged.status, ok: true } : { status: ranged.status, ok: false, reason: `HTTP ${ranged.status}` }
    } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (aborted) return { status: 0, ok: false, reason: i18n.t('error.timeout', { ms: timeoutMs }) }
        // 与端点调用同一个陷阱：没有 host 权限时浏览器给的是 `NetworkError` / `Failed to fetch`。
        // 但**不能**只凭「未授权」就断言是这个原因——对方站点若返回宽松 CORS，未授权也能通；
        // 而 DNS/证书问题同样抛网络层错误。所以只在未授权**且**错误确实是网络层时归因。
        const detail = error instanceof Error ? error.message : String(error)
        if (isNetworkLevelFailure(detail) && !(await hasEndpointAccess(url.href))) {
            return { status: 0, ok: false, reason: i18n.t('error.endpointBlocked', { host: url.host, detail }) }
        }
        return { status: 0, ok: false, reason: detail }
    } finally {
        clearTimeout(timer)
    }
}

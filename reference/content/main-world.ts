/**
 * MAIN 世界 content script 骨架（manifest: world "MAIN", run_at "document_start"）
 *
 * 职责（对齐原 network/fetchInterceptor.ts + main.ts:44）：
 *  1. 劫持 window.fetch —— 在站点应用代码运行前生效
 *  2. 上行捕获：/videos 响应体、/user/token、Authorization 刷新令牌
 *  3. 保留原"改写响应体"能力：点赞过滤 / 私有过滤 / 缓存回填
 *     —— 改写只做纯函数合并；缓存回填数据来自后台下推的 CACHE_INJECTION_LIST，
 *        本世界不解析入库、不查库、无 idb 依赖（docs/01 注入最小化原则）
 *
 * Chrome 平台上这是响应体改写的唯一非 CDP 途径（webRequest 无 body、DNR 不改 body）。
 * Firefox 可选 filterResponseData 后台通道，见 docs/02。
 *
 * 注意：此世界没有 browser.* API，全部数据经 CustomEvent(JSON) 上行。
 */
import { MAIN_CHANNEL, CONTENT_SCHEMA } from '../messaging/protocol'

const originalFetch = window.fetch

const mainFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = (input instanceof Request ? input.url : input instanceof URL ? input.href : input).toString()
    try {
        const response = await originalFetch(input, init)
        const pathname = new URL(url).pathname.toLowerCase()
        // TODO: 迁移 handleUserTokenResponse / handleVideosResponse（响应体改写在此完成）
        // 捕获结果即刻 JSON 序列化上行，不在此世界解析入库
        if (pathname === '/videos' && response.ok) {
            const body = await response.clone().json()
            postUp({ kind: 'videos', body })
        }
        return response
    } catch (error) {
        postUp({ kind: 'fetch-error', url, message: String(error) })
        throw error
    }
}

window.fetch = mainFetch

/** ISOLATED 世界可能晚于本文件注入：未就绪时缓存待发事件，HELLO 后放行 */
let isolatedReady = false
const backlog: unknown[] = []

window.addEventListener(MAIN_CHANNEL.down, (event) => {
    try {
        const msg = JSON.parse((event as CustomEvent).detail as string)
        if (msg?.type === 'HELLO' && msg.schema === CONTENT_SCHEMA) {
            isolatedReady = true
            while (backlog.length) postUp(backlog.shift())
        }
    } catch {
        // 非 JSON/不匹配：忽略
    }
})

function postUp(msg: unknown): void {
    const detail = JSON.stringify(msg) // 跨世界只传 JSON，规避 Firefox X-ray 标签差异
    if (isolatedReady) window.dispatchEvent(new CustomEvent(MAIN_CHANNEL.up, { detail }))
    else backlog.push(msg)
}

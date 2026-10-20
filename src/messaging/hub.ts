/**
 * 消息中枢 —— 唯一允许直接触碰 runtime.onMessage/sendMessage 的层
 *
 * 监听器统一使用 `return true + sendResponse` 模式：
 * Chrome 111-147 不支持 promise 型监听器；148+ 仍继续支持本模式（官方文档声明），
 * Firefox 原生支持该模式。故全平台行为一致（docs/02/04）。
 */
import type { Push, Req, Res } from './protocol'

type Handler<T extends Req> = (req: T, sender: chrome.runtime.MessageSender) => Promise<unknown>

export function onMessage<T extends Req = Req>(handler: Handler<T>): void {
    browser.runtime.onMessage.addListener((req: T, sender, sendResponse) => {
        // 定向消息（带 `target` 字段，如 offscreen 文档通道）不进业务路由，
        // 否则会被当成未知请求抛错。业务协议的消息类型里不存在 target 字段。
        if (req && typeof req === 'object' && 'target' in req) return false
        handler(req, sender).then(
            (data) => sendResponse({ ok: true, data } satisfies Res),
            (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Res)
        )
        return true // 保持通道开启直至 sendResponse
    })
}

export async function send<R = unknown>(req: Req): Promise<R> {
    const res = (await browser.runtime.sendMessage(req)) as Res
    if (!res.ok) throw new Error(res.error)
    return res.data as R
}

/** 后台 → iwara 标签页定向广播；无接收者的标签页（隐私窗、未授权）静默跳过 */
export async function broadcastToIwaraTabs(msg: Push, urlPatterns: string[] = ['*://*.iwara.tv/*']): Promise<void> {
    const tabs = await browser.tabs.query({ url: urlPatterns })
    await Promise.allSettled(tabs.filter((t) => t.id != null).map((t) => browser.tabs.sendMessage(t.id!, msg)))
}

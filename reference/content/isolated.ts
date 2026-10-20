/**
 * ISOLATED 世界 content script 骨架（manifest 默认 world，可显式声明 "ISOLATED"）
 *
 * 职责（薄桥，见 docs/01 注入最小化原则）：
 *  - MAIN ⇄ 后台 的消息桥（CustomEvent ⇄ runtime.sendMessage）
 *  - document.cookie 采集（非 HttpOnly）
 *  - 按需渲染两类转发器控件：下载按钮 / 选择条（默认零 DOM 注入）
 *
 * 不在此世界实现的：任何状态反馈（feedback 一律走后台 notifications）、
 * 配置面板 / 引导浮层（迁 options 页，页内不注入）、进度展示（侧栏/后台）。
 */
import '../browser/globals'
import { MAIN_CHANNEL, CONTENT_SCHEMA } from '../messaging/protocol'

let mainReady = false

// 1. 下行：宣告 schema（MAIN 世界门闩）
window.addEventListener(MAIN_CHANNEL.up, (event) => {
    const msg = JSON.parse((event as CustomEvent).detail as string)
    void forwardToBackground(msg)
})
window.dispatchEvent(
    new CustomEvent(MAIN_CHANNEL.down, {
        detail: JSON.stringify({ type: 'HELLO', schema: CONTENT_SCHEMA }),
    })
)

// 2. 上行：页面数据 → 后台
async function forwardToBackground(msg: { kind: string; body?: unknown }): Promise<void> {
    try {
        switch (msg.kind) {
            case 'videos':
                await browser.runtime.sendMessage({ type: 'INGEST_VIDEO_INFO', payload: { videos: msg.body, source: 'fetch-intercept' } })
                break
            case 'auth':
                await browser.runtime.sendMessage({ type: 'INGEST_AUTH', payload: { kind: 'access', token: msg.body } })
                break
            default:
                break
        }
    } catch (error) {
        // 扩展上下文失效（更新中途重载）：静默，等待自动注入
        console.debug('[iwara-assistant]', error)
    }
}

// 3. 后台下行广播（如 START_PAGE_SCAN / CONFIG_INVALIDATED）
browser.runtime.onMessage.addListener((_msg, _sender, _sendResponse) => {
    // TODO: START_PAGE_SCAN 唤醒页面扫描；CONFIG_INVALIDATED 使本地配置缓存失效
    return false
})

// 4. cookie 供后台拼 aria2/iwaradl header（HttpOnly 本就不可见，无隐私面扩大）
export function pageCookie(): string {
    return document.cookie
}

// 5. 按需 DOM（转发器控件，默认 0 注入）：下载按钮 / 卡片选择条
//    —— 仅在用户激活选择模式或开启卡片按钮时渲染；状态反馈不在此层（notifications/侧栏）

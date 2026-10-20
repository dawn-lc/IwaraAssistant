/**
 * 剪贴板写入（跨宿主）。
 *
 * 为什么不能直接调 Async Clipboard API：
 * - **Chrome MV3 后台是 service worker**，没有 DOM，`navigator.clipboard` 不存在。
 *   唯一官方途径是 offscreen document（`chrome.offscreen`，Chrome 109+），
 *   由它代写剪贴板。
 * - **Firefox MV2 后台是持久化后台页**（有 DOM），配合 manifest 里已声明的
 *   `clipboardWrite` 权限可直接 `navigator.clipboard.writeText()`。
 *
 * offscreen 生命周期：**默认用完立刻 closeDocument()**（挂起协议：不给 Chrome 留下
 * 「扩展还在干活」的理由）。唯一例外是用户开启了「保持后台活跃」——那时文档本身
 * 就是保活心跳的载体，由 `keepAlive.ts` 负责开关，这里不能顺手把它关掉。
 */
import { OFFSCREEN_TARGET } from '../../shared/constants'
import { isKeepAliveActive } from './keepAlive'

/** Chrome 是否具备 offscreen 能力（Firefox 无此 API） */
function offscreenApi(): typeof chrome.offscreen | undefined {
    const api = (globalThis as { chrome?: typeof chrome }).chrome
    const offscreen = api?.offscreen
    return typeof offscreen?.createDocument === 'function' ? offscreen : undefined
}

/**
 * 通过 offscreen 文档写剪贴板（Chrome）。
 * `createDocument` 在已存在时会抛错（"Only a single offscreen document…"），
 * 视为「已就绪」继续发送消息，而不是失败。
 */
async function writeViaOffscreen(text: string): Promise<boolean> {
    const offscreen = offscreenApi()
    if (!offscreen) return false
    try {
        await offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['CLIPBOARD'],
            // Chrome 要求声明用途（扩展审核可见）
            justification: 'Write the computed video save filename to the clipboard (autoCopySaveFileName).'
        })
    } catch {
        // 已存在（并发或上次残留）：直接复用
    }
    try {
        await browser.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: 'COPY_TEXT', text })
        return true
    } catch {
        return false
    } finally {
        // 保活运行时文档必须留着（它就是心跳载体），关掉等于把保活也停了
        if (!isKeepAliveActive()) {
            try {
                await offscreen.closeDocument()
            } catch {
                // 已关闭 / 无文档：忽略
            }
        }
    }
}

/**
 * 写文本到系统剪贴板。返回是否成功（调用方据此决定提示文案）。
 *
 * 失败不抛错：剪贴板只是便利功能，不能阻断下载主链路。
 */
export async function copyText(text: string): Promise<boolean> {
    if (text === '') return false
    // 1) 有 DOM 的扩展上下文（Firefox 事件页；Chrome 里不存在 navigator.clipboard）
    try {
        const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard
        if (clipboard?.writeText) {
            await clipboard.writeText(text)
            return true
        }
    } catch {
        // 权限拒绝 / 文档未聚焦：继续尝试 offscreen
    }
    // 2) Chrome service worker
    return writeViaOffscreen(text)
}

/**
 * 手动验收模式（`E2E_MANUAL=1`）—— 部署完就交给人
 *
 * 自动套件回答「代码是否符合预期」，手动模式回答「人用起来对不对」：
 * 真实站点上的菜单手感、通知点击、下载确认、权限弹窗，这些自动化断言覆盖不到
 * （或者覆盖成本远高于人眼看一眼）。
 *
 * 本模式只做三件事，**不做任何断言**：
 * 1. 装载扩展——走与自动套件同一条 `installExtension` 通路，避免「手动能装、自动装不上」
 * 2. 打开起始页（`E2E_MANUAL_PAGE` = `site` / `options` / `popup`，或 `E2E_MANUAL_URL` 直给）
 * 3. 阻塞轮询窗口存活，直到用户关掉浏览器或 Ctrl+C
 *
 * ## 为什么用轮询而不是 `browser.pause()` / 固定 sleep
 * - `pause(ms)` 的时长写死，而人工操作可能是 30 秒，也可能是半小时
 * - 长时间没有 WebDriver 命令时，部分驱动会按空闲超时断开会话
 * - 轮询 `getWindowHandles()` 一次拿三个信息：会话还活着 / 用户关了浏览器 / 窗口数
 *
 * ## 结束方式（三条，都是正常退出，不报失败）
 * - 关掉最后一个浏览器窗口 → 驱动报 `no such window` 或返回空句柄
 * - 终端 Ctrl+C
 * - 到达 `E2E_MANUAL_TIMEOUT`（默认 1 小时）
 */
import type { Browser } from 'webdriverio'
import { extensionPageUrl, type ExtensionSession } from './extension'
import { liveUrl } from './live'

/** 手动模式总开关（`E2E_MANUAL=1`） */
export function manualEnabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.E2E_MANUAL?.trim() ?? '')
}

/**
 * 手动模式的等待预算，默认 1 小时。
 *
 * 这是**上限**不是时长：用户关窗口就立即结束。设上限的唯一目的是避免
 * 「人走了、机器挂着」把 CI 或笔记本拖到天亮；填 0 或非法值回落默认值。
 */
export function manualTimeoutMs(): number {
    const raw = Number(process.env.E2E_MANUAL_TIMEOUT ?? 3_600_000)
    return Number.isFinite(raw) && raw > 0 ? raw : 3_600_000
}

export type ManualPage = 'site' | 'options' | 'popup'

/** 起始页类型，缺省 `site`（手动验收 90% 是看页内 UI） */
export function manualPage(): ManualPage {
    const raw = process.env.E2E_MANUAL_PAGE?.trim().toLowerCase()
    return raw === 'options' || raw === 'popup' ? raw : 'site'
}

/**
 * 起始页 URL。优先级：`E2E_MANUAL_URL`（任意绝对地址）> `E2E_MANUAL_PAGE` > 站点列表页。
 *
 * `E2E_MANUAL_PATH` 用于改站内落地页（默认 `/videos`，与 live 套件一致——
 * 列表页是卡片注入的验收面）。
 */
export function manualStartUrl(session: ExtensionSession): string {
    const explicit = process.env.E2E_MANUAL_URL?.trim()
    if (explicit) return explicit

    const page = manualPage()
    if (page === 'options') return extensionPageUrl(session, 'options/index.html')
    if (page === 'popup') return extensionPageUrl(session, 'popup/index.html')
    return liveUrl(process.env.E2E_MANUAL_PATH?.trim() || '/videos')
}

export type ManualEndReason = 'browser-closed' | 'timeout'

export interface ManualWaitOptions {
    timeoutMs: number
    /** 轮询间隔（同时也是保活心跳），默认 1s */
    pollMs?: number
}

/**
 * 阻塞到用户收工。
 *
 * 返回 `browser-closed` 或 `timeout`，**两者都不是失败**：手动模式不判断产品行为，
 * 只判断「扩展装上并且页面打开了」。因此调用方也不该因为超时把用例标红。
 */
export async function waitForManualEnd(browser: Browser, options: ManualWaitOptions): Promise<ManualEndReason> {
    const pollMs = options.pollMs ?? 1000
    const deadline = Date.now() + options.timeoutMs
    let lastUrl = ''
    let lastLogAt = Date.now()

    while (Date.now() < deadline) {
        let handles: string[]
        try {
            handles = await browser.getWindowHandles()
        } catch {
            // Chrome 关掉最后一个窗口后进程退出、Firefox 关窗后会话结束：
            // 两者都表现为驱动报错，而不是「返回 0 个窗口」
            return 'browser-closed'
        }
        if (handles.length === 0) return 'browser-closed'

        // 导航变化打一行：日志能看出用户走到哪了，也证明进程没卡死。
        // 只在变化时打，避免 1 小时里刷几千行。
        try {
            const url = await browser.getUrl()
            if (url !== lastUrl) {
                lastUrl = url
                lastLogAt = Date.now()
                console.log(`[manual] 当前页面：${url}`)
            }
        } catch {
            // 页面正在关闭中：URL 读不到不算结束，下一轮再看句柄
        }

        // 每 5 分钟报一次「还在等」，避免长时间无输出被误以为挂死
        if (Date.now() - lastLogAt >= 300_000) {
            lastLogAt = Date.now()
            console.log(`[manual] 仍在等待人工操作（剩余预算 ${formatDuration(deadline - Date.now())}；关掉浏览器窗口即可结束）`)
        }

        await sleep(pollMs)
    }

    return 'timeout'
}

/** 打印就绪清单：宿主、扩展 ID、可直接粘贴的扩展页地址、结束方式 */
export function printManualBanner(input: { browserName: string; extensionId: string; startUrl: string; session: ExtensionSession; timeoutMs: number }): void {
    console.log('')
    console.log('================ 手动验收模式 ================')
    console.log(`宿主：${input.browserName}`)
    console.log(`扩展 ID：${input.extensionId}`)
    console.log(`起始页：${input.startUrl}`)
    console.log(`配置页：${extensionPageUrl(input.session, 'options/index.html')}`)
    console.log(`弹窗页：${extensionPageUrl(input.session, 'popup/index.html')}`)
    console.log('')
    console.log('扩展已装载，接下来全部交给你。结束方式：')
    console.log('  · 关掉浏览器 → 本用例正常通过（推荐）')
    console.log(`  · 或到达 ${formatDuration(input.timeoutMs)} 预算自动结束`)
    console.log('  · Ctrl+C 会立即中断（退出码非 0，属正常中止，不要当失败看）')
    console.log('提示：新标签页里粘贴上面的「配置页」地址即可随时改配置。')
    console.log('==============================================')
    console.log('')
}

/**
 * 浏览器已被用户关掉时的收尾：**主动以 0 退出**。
 *
 * 为什么不能「正常返回」：用户关掉浏览器后 WebDriver 会话已经不存在，
 * WDIO 的 endSession 会得到 `no such session`，把本次运行标成 FAILED
 * （实测 Chrome / Firefox 都会；清 sessionId 也拦不住）。
 * 而手动模式本来就只验证「部署成功」，用户关浏览器就是「我验收完了」——
 * 那就不该报错。
 *
 * WDIO 注册了异步 exit hook，直接 `process.exit` 会打一条
 * `SYNCHRONOUS TERMINATION NOTICE`（它想收尾一个已经不在的会话），
 * 这条噪音会让人以为出错了，所以窄过滤掉它。
 */
export function exitManualSessionCleanly(): never {
    const originalError = console.error
    console.error = (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('SYNCHRONOUS TERMINATION NOTICE:')) return
        originalError(...args)
    }
    console.log('[manual] 浏览器已关闭，手动验收结束（正常退出）')
    process.exit(0)
}

/** 人类可读的时长：不足 1 分钟用秒，避免调试时显示成「0 分钟」 */
function formatDuration(ms: number): string {
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
    return `${Math.round(ms / 60_000)} 分钟`
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

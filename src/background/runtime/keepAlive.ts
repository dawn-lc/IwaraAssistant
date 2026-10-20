/**
 * Chrome MV3 后台保活（**默认关闭**，设置页「高级 → 扩展行为」可开）。
 *
 * ## 为什么需要它
 *
 * Chrome 的 service worker 在 30 秒无事件后回收。我们的实时链路（aria2 WebSocket
 * 通知 → 立即落盘 + 系统通知）一旦被回收就断：WS 断线要等 `ws-keepalive`（2 min），
 * 下载完成的通知最坏要等 `scan-aria2`（5 min）才出现。保活唯一的收益就是这段延迟。
 *
 * ## 手段（与 ScriptCat `src/app/service/offscreen/keep_alive.ts` 同构）
 *
 * ```
 * offscreen document（寿命与 SW 无关，不会被空闲回收）
 *        │  runtime.connect({ name: KEEP_ALIVE_PORT })
 *        │  每 20s  port.postMessage({ type: 'keep-alive' })
 *        ▼
 * Service Worker（只负责接住端口 + 收消息）
 * ```
 *
 * 三个必须照抄的细节：
 * 1. **发消息才算活动**。Chrome 114 起「打开端口」不再重置空闲计时器，只有持久连接上
 *    真的 `postMessage` 才续命——只挂一个空端口等于没做。
 * 2. **offscreen 里不能用 `setTimeout`**：隐藏文档的定时器会被降频到分钟级。offscreen
 *    侧改用 `scheduler.postTask(..., { priority: 'user-visible' })`（见 offscreen.ts）。
 * 3. **配置要在 offscreen 重连时重放**：offscreen 的寿命可能比 SW 长，用户关掉开关后
 *    SW 重启不一定还记得通知它。所以 SW 侧每次 boot 都无条件重发一次 START。
 *
 * ## 这**不是**官方保证的常驻
 *
 * Chrome 没有「常驻后台」这个能力，本模块只是把空闲回收往后拖。官方文档明确要求
 * 「尽可能避免让 service worker 无限期保持活跃」，因此：
 * - 默认关闭，需用户在设置页显式开启；
 * - 失败（offscreen 建不起来、权限被撤回）时静默退回原本的 alarms 兜底，不影响功能；
 * - Firefox 不需要：MV2 产物是 `persistent: true` 的后台页（manifest/variants.ts）。
 */
import { KEEP_ALIVE_HEARTBEAT_MS, KEEP_ALIVE_PORT, OFFSCREEN_TARGET } from '../../shared/constants'
import { configSchema } from '../../shared/configSchema'
import { CONFIG_KEY } from '../../shared/storageKeys'
import { getConfig } from '../storage/configStore'

const OFFSCREEN_URL = 'offscreen.html'

/** Chrome 是否具备 offscreen 能力（Firefox 无此 API） */
function offscreenApi(): typeof chrome.offscreen | undefined {
    const api = (globalThis as { chrome?: typeof chrome }).chrome
    const offscreen = api?.offscreen
    return typeof offscreen?.createDocument === 'function' ? offscreen : undefined
}

/** 保活是否正在生效（剪贴板路径据此决定是否保留 offscreen 文档） */
let active = false

export function isKeepAliveActive(): boolean {
    return active
}

/**
 * 确保 offscreen 文档存在。
 * `createDocument` 在已存在时会抛错（"Only a single offscreen document…"），
 * 视为「已就绪」而不是失败——剪贴板路径可能刚好先建过。
 */
async function ensureDocument(offscreen: typeof chrome.offscreen): Promise<boolean> {
    if (typeof offscreen.hasDocument === 'function') {
        try {
            if (await offscreen.hasDocument()) return true
        } catch {
            // 判断失败就继续走 createDocument 的 try/catch
        }
    }
    try {
        await offscreen.createDocument({
            url: OFFSCREEN_URL,
            // CLIPBOARD：该文档同时承担剪贴板写入。
            // BLOBS：Chrome 没有「保持 service worker 存活」这个理由，这是 ScriptCat 用的
            // 同一个占位 reason；仅用于让文档有合法的创建理由，文档本身不碰 Blob。
            reasons: ['CLIPBOARD', 'BLOBS'],
            justification: 'Keep the aria2 WebSocket notification channel alive while the user has enabled "keep background alive" in the options page; the same document also writes the clipboard.'
        })
        return true
    } catch (error) {
        return /single offscreen|already exists/i.test(String(error))
    }
}

/**
 * 把消息送到 offscreen 文档。文档刚创建时脚本可能还没挂上监听器，
 * `sendMessage` 会抛 "Could not establish connection"——重试几次再放弃。
 */
async function sendToOffscreen(message: unknown, attempts = 5): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await browser.runtime.sendMessage(message)
            return true
        } catch {
            if (attempt === attempts - 1) return false
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    return false
}

/** 是否已有 offscreen 文档（Chrome 116+ 有 `hasDocument()`；更早版本无法预判，按「有」处理） */
async function documentExists(offscreen: typeof chrome.offscreen): Promise<boolean> {
    if (typeof offscreen.hasDocument !== 'function') return true
    try {
        return await offscreen.hasDocument()
    } catch {
        return true // 判断失败就当有：宁可多关一次（关不掉会被 catch 忽略）
    }
}

/**
 * 上一次真正应用过的配置值。
 *
 * 两个作用：
 * 1. **配置随便改点别的不要动保活**——`storage.onChanged` 对任何配置写入都会触发，
 *    而关闭流程会 `closeDocument()`，剪贴板正好在写时把文档关掉会白丢一次复制；
 * 2. **SW 重启后必须重新对账**：模块级状态在新实例里是 `null`，所以启动后的第一次
 *    调用一定会执行——上一代 SW 创建的 offscreen 文档可能还在跑心跳，必须按当前配置收拾掉。
 */
let lastApplied: boolean | null = null

/**
 * 按配置同步保活状态。`wanted` 由调用方传入（而不是这里读 `getConfig()`）：
 * 配置变更监听器拿到的是**刚落盘的新值**，而 `configStore` 更新内存副本是异步的，
 * 在这里读会拿到上一轮的配置。
 */
export async function syncKeepAlive(wanted: boolean): Promise<void> {
    const offscreen = offscreenApi()
    if (!offscreen) return // Firefox / 不支持 offscreen 的宿主：无需保活

    const changed = lastApplied !== wanted
    lastApplied = wanted
    if (!changed) return

    if (!wanted) {
        active = false
        if (!(await documentExists(offscreen))) return
        await sendToOffscreen({ target: OFFSCREEN_TARGET, type: 'KEEP_ALIVE_STOP' }, 1)
        try {
            await offscreen.closeDocument()
        } catch {
            // 已关闭 / 无文档：忽略
        }
        return
    }

    if (!(await ensureDocument(offscreen))) {
        lastApplied = null // 建不出来（权限被撤/浏览器限制）：下次触发时重试
        return
    }
    active = true
    // 每次 boot 都重发：offscreen 可能比 SW 活得久，它的开关状态不能只靠一次通知
    const delivered = await sendToOffscreen({ target: OFFSCREEN_TARGET, type: 'KEEP_ALIVE_START', intervalMs: KEEP_ALIVE_HEARTBEAT_MS })
    if (!delivered) {
        active = false
        lastApplied = null // 文档还没挂上监听器 / 已被关闭：允许下次重试
    }
}

/**
 * SW 侧接住心跳端口。
 *
 * **收到消息本身就是活动**（Chrome 把端口消息算作事件），所以这里不需要对内容做任何处理；
 * 唯一的目的是别让端口因为没有监听器而被当成错误连接。
 */
browser.runtime.onConnect.addListener((port) => {
    if (port.name !== KEEP_ALIVE_PORT) return
    port.onMessage.addListener(() => {
        // 心跳内容无意义，收下即可
    })
})

/**
 * 开关变更即时生效：不必等下一次 SW 唤醒。
 *
 * 这里重新解析 storage 而不是读 `getConfig()`，理由同 `syncKeepAlive` 的参数——见上。
 */
browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(CONFIG_KEY in changes)) return
    void (async () => {
        const parsed = configSchema.safeParse((await browser.storage.local.get(CONFIG_KEY))[CONFIG_KEY] ?? {})
        const wanted = parsed.success ? parsed.data.keepBackgroundAlive : getConfig().keepBackgroundAlive
        await syncKeepAlive(wanted)
    })()
})

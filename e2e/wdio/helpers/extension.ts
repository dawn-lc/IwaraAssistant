/**
 * 跨浏览器扩展装载通路（WebdriverIO v10 / WebDriver BiDi）
 *
 * 两个宿主统一走 `browser.installExtension()`（BiDi 标准 `webExtension.install`）：
 * - Chromium：需以 `--enable-unsafe-extension-debugging --remote-debugging-pipe
 *   --user-data-dir=<非默认目录>` 启动（Chrome 136+ 才有 webExtension.install；
 *   品牌 Chrome 137+ 已移除 `--load-extension`，故不能再靠启动参数侧载）
 * - Firefox：geckodriver 需 `--allow-system-access` 才允许导航 `moz-extension://` 页
 *   （官方 WebDriver 安全限制，FF 138+ 默认开启；本文件在 prefs 中同时预置
 *   `extensions.webextensions.uuids`，把运行时 UUID 固定为可预测值）
 *
 * 会话注册表按 sessionId 保存装载结果；spec 的 before 钩子调用
 * `ensureExtensionSession()` 按需安装（幂等，后续 spec 复用）。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Browser } from 'webdriverio'

export type BrowserName = 'chrome' | 'firefox'

export interface ExtensionSession {
    browserName: BrowserName
    /** Chrome：32 位扩展 ID；Firefox：manifest 的 gecko id */
    extensionId: string
    /** chrome-extension://<id>/ 或 moz-extension://<uuid>/（含尾斜杠） */
    extensionBaseUrl: string
}

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

const DIST: Record<BrowserName, string> = {
    chrome: path.join(ROOT, 'dist', 'chrome'),
    firefox: path.join(ROOT, 'dist', 'firefox')
}

/**
 * 会话注册表挂在 globalThis（Symbol 键）上：WDIO 对 config / spec 的加载器
 * 可能产生不同的模块实例，普通模块级 Map 会互相看不见。
 */
function sessionRegistry(): Map<string, ExtensionSession> {
    const store = globalThis as unknown as { __iwaraExtensionSessions?: Map<string, ExtensionSession> }
    store.__iwaraExtensionSessions ??= new Map()
    return store.__iwaraExtensionSessions
}

/** 读取 Firefox manifest 的 gecko id（BiDi install 返回的也是它） */
function readGeckoId(): string {
    const manifestPath = path.join(DIST.firefox, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`未找到 Firefox 产物 ${manifestPath}，请先运行 npm run build:firefox`)
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        browser_specific_settings?: { gecko?: { id?: string } }
    }
    const id = manifest.browser_specific_settings?.gecko?.id
    if (!id) throw new Error('Firefox manifest 缺少 browser_specific_settings.gecko.id（BiDi 安装必需）')
    return id
}

/**
 * 由 gecko id 派生固定 UUID —— launcher 写 prefs 与 worker 拼 URL 必须得到同一值，
 * 因此不能使用随机 UUID（两边是不同 Node 进程）。
 */
export function firefoxExtensionUuid(): string {
    const hex = createHash('sha1').update(`iwara-assistant:${readGeckoId()}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Firefox 首启抑制 + 固定扩展 UUID + 中文界面（与 web-ext 冒烟 user.js 同套） */
export function firefoxPrefs(): Record<string, boolean | string | number> {
    return {
        'browser.aboutwelcome.enabled': false,
        'browser.startup.homepage_override.mstone': 'ignore',
        'browser.shell.checkDefaultBrowser': false,
        'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
        'datareporting.healthreport.uploadEnabled': false,
        'toolkit.telemetry.unified': false,
        'app.update.auto': false,
        'extensions.autoDisableScopes': 0,
        'extensions.enabledScopes': 15,
        // 界面语言钉到中文：用例断言中文文案，而 i18n 默认「跟随浏览器语言」。
        // locale.requested 决定 i18n.getUILanguage()，accept_languages 决定 navigator.language
        'intl.locale.requested': 'zh-CN',
        'intl.accept_languages': 'zh-CN,zh,en-US,en',
        'extensions.webextensions.uuids': JSON.stringify({ [readGeckoId()]: firefoxExtensionUuid() })
    }
}

function distOf(browserName: BrowserName): string {
    const dir = DIST[browserName]
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        throw new Error(`未找到扩展产物 ${dir}，请先运行 npm run build:${browserName}`)
    }
    return dir
}

/** 当前会话安装扩展并登记 baseURL（幂等：同一 session 只装一次） */
async function installExtensionForSession(browser: Browser): Promise<ExtensionSession> {
    const browserName = browser.capabilities.browserName as BrowserName
    if (browserName !== 'chrome' && browserName !== 'firefox') {
        throw new Error(`不支持的浏览器：${String(browserName)}（仅 chrome / firefox）`)
    }

    let extensionId: string
    if (browserName === 'firefox') {
        const installed = await browser.installExtension(distOf('firefox'))
        extensionId = readGeckoId()
        if (installed !== extensionId) {
            throw new Error(`Firefox 扩展 id 不一致：安装返回 ${installed}，manifest 为 ${extensionId}`)
        }
    } else {
        extensionId = await browser.installExtension(distOf('chrome'))
    }

    const session: ExtensionSession = {
        browserName,
        extensionId,
        extensionBaseUrl: browserName === 'firefox' ? `moz-extension://${firefoxExtensionUuid()}/` : `chrome-extension://${extensionId}/`
    }
    sessionRegistry().set(browser.sessionId, session)
    return session
}

/** spec 的 before 钩子调用：首次安装，后续 spec 复用同一会话结果 */
export async function ensureExtensionSession(browser: Browser): Promise<ExtensionSession> {
    const existing = sessionRegistry().get(browser.sessionId)
    if (existing) return existing
    return installExtensionForSession(browser)
}

/** 拼扩展自有页面 URL（传入 `options/index.html` 这类相对路径） */
export function extensionPageUrl(session: ExtensionSession, relativePath: string): string {
    return `${session.extensionBaseUrl}${relativePath.replace(/^\/+/, '')}`
}

/** 打开扩展自有页面（options / popup） */
export async function openExtensionPage(browser: Browser, session: ExtensionSession, relativePath: string): Promise<void> {
    await browser.url(extensionPageUrl(session, relativePath))
}

/** 后台活性快照（双浏览器同构：getContexts + alarms + manifest 后台形态） */
export interface BackgroundState {
    contextsSupported: boolean
    backgroundContexts: Array<{ contextType: string; documentUrl?: string }>
    alarms: string[]
    manifestBackground: { service_worker?: string; scripts?: string[] }
}

/**
 * 读取后台活性（必须在扩展自有页执行）。
 * - `runtime.getContexts()`：Chrome 的 SW 与 Firefox 的事件页都会报 BACKGROUND
 * - `alarms.getAll()`：boot() 内 setupAlarms 已落库的三个周期任务
 * - manifest 后台形态：Chrome `service_worker` / Firefox `scripts`（产物变体差异）
 */
export async function readBackgroundState(browser: Browser): Promise<BackgroundState> {
    return (await browser.execute(async () => {
        type ExtensionScope = {
            runtime?: {
                getContexts?: (filter?: unknown) => Promise<Array<{ contextType?: string; documentUrl?: string }>>
                getManifest?: () => { background?: { service_worker?: string; scripts?: string[] } }
            }
            alarms?: { getAll?: () => Promise<Array<{ name?: string }>> }
        }
        const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
        const api = scope.browser ?? scope.chrome
        if (!api?.runtime) throw new Error('当前页面不是扩展页（无 WebExtension API）')

        const contextsSupported = typeof api.runtime.getContexts === 'function'
        const contexts = contextsSupported ? await api.runtime.getContexts!({}) : []
        const alarms = api.alarms?.getAll ? (await api.alarms.getAll()).map((alarm) => alarm.name ?? '') : []
        const manifestBackground = api.runtime.getManifest?.().background ?? {}

        return {
            contextsSupported,
            backgroundContexts: contexts.filter((context) => context.contextType === 'BACKGROUND').map((context) => ({ contextType: context.contextType ?? '', documentUrl: context.documentUrl })),
            alarms,
            manifestBackground
        }
    })) as BackgroundState
}

/** 轮询等待后台 boot 完成（BACKGROUND 上下文起来 + 三个周期 alarm 已创建） */
export async function waitForBackgroundReady(browser: Browser, timeoutMs = 30_000): Promise<BackgroundState> {
    const requiredAlarms = ['ws-keepalive', 'scan-aria2', 'retry-failed']
    let state: BackgroundState | undefined
    await browser.waitUntil(
        async () => {
            state = await readBackgroundState(browser)
            return state.backgroundContexts.length > 0 && requiredAlarms.every((name) => state!.alarms.includes(name))
        },
        {
            timeout: timeoutMs,
            interval: 500,
            timeoutMsg: '后台未在超时内完成启动（BACKGROUND 上下文或周期 alarms 缺失）'
        }
    )
    return state!
}

/** hub 的消息信封（src/messaging/hub.ts 的 Res 形态） */
export interface RuntimeResponse<T = unknown> {
    ok: boolean
    data?: T
    error?: string
}

/** 在当前扩展页向后台发真实 runtime 消息 */
export async function sendRuntimeMessage<T = unknown>(browser: Browser, message: unknown): Promise<RuntimeResponse<T>> {
    return (await browser.execute(async (request) => {
        type ExtensionScope = { runtime?: { sendMessage?: (message: unknown) => Promise<unknown> } }
        const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
        const api = scope.browser ?? scope.chrome
        if (!api?.runtime?.sendMessage) throw new Error('当前页面不是扩展页（无 runtime.sendMessage）')
        return await api.runtime.sendMessage(request)
    }, message)) as RuntimeResponse<T>
}

/** 写 storage.local（用于队列种子/清空；当前页面必须是扩展页） */
export async function setLocalStorage(browser: Browser, data: Record<string, unknown>): Promise<void> {
    await browser.execute(async (payload) => {
        type ExtensionScope = { storage?: { local?: { set?: (data: unknown) => Promise<void> } } }
        const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
        const api = scope.browser ?? scope.chrome
        if (!api?.storage?.local?.set) throw new Error('当前页面不是扩展页（无 storage.local）')
        await api.storage.local.set(payload)
    }, data)
}

/** 读 storage.local 的单个键（当前页面必须是扩展页） */
export async function readLocalStorage(browser: Browser, key: string): Promise<unknown> {
    return await browser.execute(async (target) => {
        type ExtensionScope = { storage?: { local?: { get?: (keys: string) => Promise<Record<string, unknown>> } } }
        const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
        const api = scope.browser ?? scope.chrome
        if (!api?.storage?.local?.get) throw new Error('当前页面不是扩展页（无 storage.local）')
        return (await api.storage.local.get(target))[target] ?? null
    }, key)
}

/**
 * Chrome：offscreen 文档当前是否存在。
 * Firefox 没有 `chrome.offscreen`（MV2 持久后台页不需要它）→ 恒为 false。
 */
export async function hasOffscreenDocument(browser: Browser): Promise<boolean> {
    return (await browser.execute(async () => {
        type ExtensionScope = { offscreen?: { hasDocument?: () => Promise<boolean> } }
        const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
        const api = scope.browser ?? scope.chrome
        if (typeof api?.offscreen?.hasDocument !== 'function') return false
        return await api.offscreen.hasDocument()
    })) as boolean
}

/** 读 storage.local 的下载队列（storageKeys.QUEUE_KEY = downloadQueue） */
export async function readDownloadQueue(browser: Browser): Promise<Array<Record<string, unknown>>> {
    return (await browser.execute(async () => {
        type ExtensionScope = { storage?: { local?: { get?: (keys: string) => Promise<Record<string, unknown>> } } }
        const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
        const api = scope.browser ?? scope.chrome
        if (!api?.storage?.local?.get) throw new Error('当前页面不是扩展页（无 storage.local）')
        const stored = await api.storage.local.get('downloadQueue')
        const queue = stored['downloadQueue']
        return Array.isArray(queue) ? (queue as Array<Record<string, unknown>>) : []
    })) as Array<Record<string, unknown>>
}

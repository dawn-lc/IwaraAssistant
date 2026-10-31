/**
 * MAIN 世界 content script（manifest: world "MAIN", run_at "document_start"）
 *
 * 职责（对齐原 network/fetchInterceptor.ts + main.ts:44）：
 *  1. 劫持 window.fetch —— 在站点应用代码运行前生效
 *  2. 上行捕获：/videos 响应体、/user/token、Authorization 请求头
 *  3. 保留原"改写响应体"能力：点赞过滤 / 私有过滤 / 缓存回填
 *     —— 改写只做纯函数合并；缓存回填按本页窗口向后台即时查询（CACHE_INJECTION_RESULT），
 *        后台推送的 CACHE_INJECTION_LIST 仅作兜底；本世界不解析入库、不查库、无 idb 依赖（docs/01 注入最小化原则）
 *
 * Chrome 平台上这是响应体改写的唯一非 CDP 途径（webRequest 无 body、DNR 不改 body）。
 * Firefox 可选 filterResponseData 后台通道，见 docs/02（可选增强）。
 *
 * 注意：此世界没有 browser.* API，全部数据经 CustomEvent(JSON) 上行。
 * 构建时对本入口设了 `skipGlobalsShim`——**不要**把 browser shim 带进 MAIN world，
 * 否则会向页面全局写入 `window.browser = window.chrome`（污染页面 feature 检测）。
 *
 * 安全模型（改本文件前必读 docs/01 §注入时机与安全）：
 *  - MAIN world 与页面同雷亚，**任何东西都无法对页面隐藏**——包装后的
 *    `window.fetch` 可被 `fetch.toString()` 识别，页面也可重新赋值绕开。
 *  - 因此本文件绝不能持有「不该给页面看」的数据，也不能暴露控制入口。
 *    历史教训：曾把 `{ nativeFetch, queue, install }` 挂在
 *    `window.__iwaraAssistantFetchHook` 上——任何页面脚本都能在接管后调用
 *    `install()` 替换掉我们的 handler，等价于 MITM 全部页面请求，
 *    且 `queue` 里还暂存着含 `Authorization` 的 `init`。已整体删除。
 *  - 业务判定（下载/权限）以后台为准，不信任页面世界里的任何数据。
 */
import { CONTENT_SCHEMA, MAIN_CHANNEL } from '../messaging/protocol'
import type { CacheInjection, PageConfig } from '../messaging/protocol'
import { resolveRequestUrl } from '../shared/url'
import { HOOK_MARKER_ATTR, hookMarkerValue } from './markers'

console.info('[iwara-assistant] MAIN world injected — fetch hook active')

/**
 * 原生 `fetch` 引用。
 *
 * 为什么不需要「第一段注入 + 接管」：`run_at: document_start` 的平台语义就是
 * 「在任何 DOM 构建、任何页面脚本运行之前注入」（Chrome 官方文档 / MDN 同表述），
 * 而这个文件的 manifest 注入顺序里**没有任何依赖需要先加载**，所以本行执行时
 * 页面必定尚未运行任何脚本。拆出一个「更早的桩」只会多出一个跨 bundle 的控制通道，
 * 而该通道在 MAIN 世界对页面可见——属净损失（详见 docs/01 §注入时机与安全）。
 */
const originalFetch = window.fetch

// 时机证据（无敏感信息）：必须在任何耗时逻辑之前写，才代表「注入时刻」
document.documentElement?.setAttribute(HOOK_MARKER_ATTR, hookMarkerValue())

// ── 下行状态（CONFIG_SYNC / CACHE_INJECTION_LIST，经 ISOLATED 的 JSON 通道）─
// 未收到快照前的默认值与原配置默认一致：全部关闭 → 纯透传

let pageConfig: PageConfig = {
    filterLikedVideos: false,
    filterUnlistedAndPrivate: false,
    addUnlistedAndPrivate: false
}
let injectionList: CacheInjection | null = null

/**
 * 首次改写前等一次配置快照。
 *
 * 源项目的配置在 fetch 钩子安装前就已同步可读；扩展里 `CONFIG_SYNC` 要等
 * HELLO → PAGE_READY 两个往返，站点首屏的 `/videos` 可能先到。不等这一下，
 * 首屏会按默认值（全关）透传——私有回填/点赞过滤都会「第一次打开不生效」。
 * 只等一次且上限 500ms：后台真正挂掉时不能让每个响应都白白挂起。
 */
let configSynced = false
let resolveConfigSync: () => void = () => {}
const configSyncedPromise = new Promise<void>((resolve) => {
    resolveConfigSync = resolve
})
let configWaitPromise: Promise<void> | null = null

function whenPageConfigReady(): Promise<void> {
    if (configSynced) return Promise.resolve()
    configWaitPromise ??= Promise.race([configSyncedPromise, new Promise<void>((resolve) => setTimeout(resolve, 500))])
    return configWaitPromise
}

/**
 * 按当前页窗口向后台要一份**即时**回填列表（源项目在响应处理函数里同步查库的等价物）。
 *
 * `injectionList` 是「上一页入库 → 后台重算 → 广播」的异步推送，永远比当前响应慢一拍；
 * 换页后整页都会因为窗口不匹配而漏掉回填。这里用一次消息往返把窗口换成答案，
 * 推送列表只在超时/后台不可用时兜底。
 */
const pendingCacheRequests = new Map<string, (list: CacheInjection | null) => void>()
let cacheRequestSeq = 0
/** 后台无响应时的等待上限：宁可少回填一次，也不让页面请求一直挂着 */
const CACHE_REQUEST_TIMEOUT_MS = 1500

function requestCacheInjection(window: { start: number; end: number }): Promise<CacheInjection | null> {
    const requestId = `${Date.now().toString(36)}-${++cacheRequestSeq}`
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingCacheRequests.delete(requestId)
            resolve(null)
        }, CACHE_REQUEST_TIMEOUT_MS)
        pendingCacheRequests.set(requestId, (list) => {
            clearTimeout(timer)
            pendingCacheRequests.delete(requestId)
            resolve(list)
        })
        postUp({ kind: 'cache-injection', requestId, window })
    })
}

// 页面 localStorage 键（原 core/constants.ts）
const LS_KEY_TOKEN = 'token'
const LS_KEY_ACCESS_TOKEN = 'accessToken'

/** 原实现窗宽：dayjs add/sub({ hours: 4 }) */
const PAGE_WINDOW_PAD_MS = 4 * 60 * 60 * 1000

/**
 * 回填决策标记（`data-ia-cache`）。
 *
 * 为什么要这个：回填有 7 道门（开关、互斥开关、user/subscribed/sort 参数、时间窗、
 * 后台答复），任一门不过都是静默 `return`，“没回填”在页面上长得一模一样。
 * 把最后一个决策落成属性，排障时只需看一眼 DOM 就知道是哪道门关的。
 * 只写决策与条数，不含标题/作者/token 等任何内容。
 */
const CACHE_MARKER_ATTR = 'data-ia-cache'

function markCache(value: string): void {
    document.documentElement?.setAttribute(CACHE_MARKER_ATTR, value)
}

function isPageApi(url: URL): boolean {
    return url.hostname === 'apiq.iwara.tv' || url.hostname === 'api.iwara.tv'
}

/** JWT payload 解码（原 network/auth.ts getPlayload） */
function getPlayload(token: string): Record<string, unknown> {
    const segment = token.split('.')[1]
    if (!segment) throw new Error('invalid jwt payload')
    const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)))) as Record<string, unknown>
}

function extractAuthorization(init?: RequestInit): string | null {
    const headers = init?.headers
    if (!headers) return null

    let authorization: string | null = null
    if (headers instanceof Headers) {
        authorization = headers.has('Authorization') ? headers.get('Authorization') : null
    } else if (Array.isArray(headers)) {
        const index = headers.findIndex(([key]) => key.toLowerCase() === 'authorization')
        if (index >= 0) authorization = headers[index]![1]
    } else if (typeof headers === 'object') {
        for (const key in headers) {
            if (key.toLowerCase() === 'authorization') {
                authorization = (headers as Record<string, string>)[key] ?? null
                break
            }
        }
    }
    return authorization
}

/** 原 handleAuthorizationHeader：refresh_token 入页内 localStorage + 上行缓存 */
function handleAuthorizationHeader(init?: RequestInit): void {
    const authorization = extractAuthorization(init)
    if (!authorization) return

    let payload: Record<string, unknown>
    try {
        payload = getPlayload(authorization)
    } catch {
        return // 非 JWT：忽略
    }
    const token = authorization.split(' ').pop()
    if (payload['type'] === 'refresh_token' && token !== undefined) {
        window.localStorage.setItem(LS_KEY_TOKEN, token)
        postUp({ kind: 'authorization', token })
    }
}

/** 原 handleUserTokenResponse：accessToken 写回页内 localStorage 并上行缓存 */
async function handleUserTokenResponse(response: Response): Promise<void> {
    const cloneResponse = response.clone()
    if (!cloneResponse.ok) return
    const { accessToken } = (await cloneResponse.json()) as { accessToken?: string }
    if (!accessToken) return
    if (window.localStorage.getItem(LS_KEY_ACCESS_TOKEN) !== accessToken) {
        window.localStorage.setItem(LS_KEY_ACCESS_TOKEN, accessToken)
    }
    postUp({ kind: 'access-token', token: accessToken })
}

function isExternalVideo(raw: Iwara.Video): boolean {
    return raw.embedUrl != null && raw.embedUrl !== ''
}

/**
 * 本页时间窗（原实现语义）：窗口由本页结果 UploadTime min/max ± 4h 组成；
 * 外链视频在原 parse 阶段判 fail，不参与窗口，此处同规则排除
 */
function computePageWindow(raws: Iwara.Video[]): { start: number; end: number } | null {
    let minTime = Number.POSITIVE_INFINITY
    let maxTime = Number.NEGATIVE_INFINITY
    for (const raw of raws) {
        if (isExternalVideo(raw)) continue
        const uploadTime = new Date(raw.createdAt ?? 0).getTime()
        if (!Number.isFinite(uploadTime) || uploadTime === 0) continue
        if (uploadTime < minTime) minTime = uploadTime
        if (uploadTime > maxTime) maxTime = uploadTime
    }
    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) return null
    return { start: minTime - PAGE_WINDOW_PAD_MS, end: maxTime + PAGE_WINDOW_PAD_MS }
}

function cloneBodyResponse(page: Iwara.IPage<Iwara.Video>, cloneResponse: Response): Response {
    return new Response(JSON.stringify(page), {
        status: cloneResponse.status,
        statusText: cloneResponse.statusText,
        headers: Object.fromEntries(cloneResponse.headers.entries())
    })
}

function pageFixups(page: Iwara.IPage<Iwara.Video>): void {
    page.limit = page.results.length
    page.count = page.limit * (page.page + 1) + 1
}

/**
 * 原 handleVideosResponse（bug-for-bug；入库/查库改为后台消息化）
 * 三段：原始上报 → 过滤（点赞/订阅页私有）→ 缓存回填（与过滤互斥）
 */
async function handleVideosResponse(response: Response, url: URL): Promise<Response> {
    const cloneResponse = response.clone()
    if (!cloneResponse.ok) return response

    const page = (await cloneResponse.json()) as Iwara.IPage<Iwara.Video>
    const rawVideos = page.results

    // 原「解析并入库」段：MAIN 只上行原文 + 窗口，字段展开与落库均在后台
    const pageWindow = computePageWindow(rawVideos)
    postUp({ kind: 'videos', body: rawVideos, window: pageWindow })

    // 改写依赖配置快照（首屏请求可能早于 CONFIG_SYNC）
    await whenPageConfigReady()

    // 过滤已点赞视频
    if (pageConfig.filterLikedVideos) {
        page.results = rawVideos.filter((i) => !i.liked)
        pageFixups(page)
    }

    // 过滤不公开和私有视频（订阅页 /videos?subscribed=true）
    if (pageConfig.filterUnlistedAndPrivate && url.searchParams.has('subscribed')) {
        page.results = page.results.filter((i) => !i.private && !i.unlisted)
        pageFixups(page)
    }

    const preResponse = cloneBodyResponse(page, cloneResponse)

    // 添加未列出和私有视频缓存（与「过滤订阅页不公开/私有」功能互斥）
    if (!pageConfig.addUnlistedAndPrivate) {
        markCache('off')
        return preResponse
    }
    if (pageConfig.filterUnlistedAndPrivate) {
        markCache('skip:filter-exclusive')
        return preResponse
    }

    // 检查是否满足添加缓存的条件（原实现逐项 return）
    if (url.searchParams.has('user')) {
        markCache('skip:user')
        return preResponse
    }
    if (url.searchParams.has('subscribed')) {
        markCache('skip:subscribed')
        return preResponse
    }
    if (url.searchParams.has('sort') && url.searchParams.get('sort') !== 'date') {
        markCache('skip:sort')
        return preResponse
    }

    const currentWindow = pageWindow
    if (!currentWindow) {
        markCache('skip:no-window')
        return preResponse
    }

    // 即时查询当前窗口；后台不可用时退回最近一次推送（仍按本页窗口过滤，不会串页）
    const cache = (await requestCacheInjection(currentWindow)) ?? injectionList
    if (!cache) {
        markCache('skip:no-cache')
        return preResponse
    }

    // 后台已按 UploadTime 降序返回；窗口边界同原实现为开区间（background-bound exclusive）
    const cacheVideos = cache.raws
        .map((raw) => raw as Iwara.Video)
        .filter((raw) => {
            if (isExternalVideo(raw)) return false
            const uploadTime = new Date(raw.createdAt ?? 0).getTime()
            return uploadTime > currentWindow.start && uploadTime < currentWindow.end
        })

    markCache(`ok:candidates=${cache.raws.length};injected=${cacheVideos.length}`)
    page.results.push(...cacheVideos)
    pageFixups(page)

    return cloneBodyResponse(page, cloneResponse)
}

/**
 * 劫持后的 fetch（原 createInterceptedFetch 逻辑）
 *
 * ⚠️ URL 解析必须带 base：站点用**协议相对 URL**
 * （`fetch('//api.iwara.tv/videos?rating=all')`）调 API，
 * `new URL(raw)` 会抛 TypeError —— 若把它当「非法 URL 放行」，
 * 入库 / token 捕获 / 点赞过滤 / 缓存回填会全部静默失效（真实站点回归用例守护）。
 */
const mainFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: URL
    try {
        // base 用 document.baseURI（而非 location.href）：与原生 fetch 的基准 URL 语义一致
        // （原生 fetch 会把相对/协议相对 URL 按文档 base URL 解析，含 <base href>）
        url = resolveRequestUrl(input, document.baseURI)
    } catch {
        // 真正无法识别的入参：交给原始 fetch 自然报错，不拦截
        return originalFetch(input, init)
    }
    if (init && init.headers) handleAuthorizationHeader(init)
    try {
        const response = await originalFetch(input, init)
        if (isPageApi(url) && url.pathname) {
            const path = url.pathname.toLowerCase().split('/').slice(1)
            switch (path[0]) {
                case 'user':
                    if (path[1] === 'token') await handleUserTokenResponse(response)
                    break
                case 'videos':
                    return await handleVideosResponse(response, url)
                default:
                    break
            }
        }
        return response
    } catch (error) {
        postUp({ kind: 'fetch-error', url: url.href, message: String(error) })
        throw error
    }
}

/**
 * 安装拦截器。
 *
 * 安全说明：钩子只是包一层 `window.fetch`，**不向页面暴露任何控制入口**
 * （不写全局对象、不留 `install()`、不缓存请求体/头部）。
 * 任何页面脚本都可以重新赋值 `window.fetch` 来绕开我们——这是 MAIN 世界劫持
 * 的固有可见性，无法在页面同雷亚内隐藏；正确的应对是「不依赖钩子做安全判定」，
 * 业务侧（后台）不信任页面数据。
 */
window.fetch = mainFetch

/** ISOLATED 世界可能晚于本文件注册监听：未握手前缓存待发事件，HELLO 后放行 */
let isolatedReady = false
const backlog: unknown[] = []

window.addEventListener(MAIN_CHANNEL.down, (event) => {
    try {
        const msg = JSON.parse((event as CustomEvent).detail as string) as { type?: string; schema?: number; payload?: unknown }
        if (msg?.type === 'HELLO' && msg.schema === CONTENT_SCHEMA) {
            isolatedReady = true
            while (backlog.length) postUp(backlog.shift())
            postUp({ type: 'HELLO_ACK', schema: CONTENT_SCHEMA })
        } else if (msg?.type === 'CONFIG_SYNC') {
            // 配置快照（HELLO ACK 后首推 + 后台 storage 变更重推）
            pageConfig = { ...pageConfig, ...((msg.payload as { page?: PageConfig })?.page ?? {}) }
            configSynced = true
            resolveConfigSync()
            console.debug('[iwara-assistant] CONFIG_SYNC applied')
        } else if (msg?.type === 'CACHE_INJECTION_LIST' && msg.payload && typeof msg.payload === 'object') {
            injectionList = msg.payload as CacheInjection
            console.debug(`[iwara-assistant] CACHE_INJECTION_LIST applied (${injectionList.raws.length} raws)`)
        } else if (msg?.type === 'CACHE_INJECTION_RESULT' && msg.payload && typeof msg.payload === 'object') {
            const { requestId, list } = msg.payload as { requestId?: string; list?: CacheInjection | null }
            if (typeof requestId === 'string') pendingCacheRequests.get(requestId)?.(list ?? null)
        }
    } catch {
        // 非 JSON payload（他方同名事件）：忽略
    }
})

function postUp(msg: unknown): void {
    const detail = JSON.stringify(msg) // 跨世界只传 JSON，规避 Firefox X-ray 标签差异
    if (isolatedReady) window.dispatchEvent(new CustomEvent(MAIN_CHANNEL.up, { detail }))
    else backlog.push(msg)
}

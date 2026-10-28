/**
 * ISOLATED 世界 content script —— 薄桥（manifest 默认 world，document_start）
 *
 * 职责（docs/01 注入最小化原则）：
 *  - MAIN ⇄ 后台 的消息桥（CustomEvent ⇄ runtime.sendMessage）
 *  - document.cookie 采集（非 HttpOnly；aria2/iwaradl header 源）
 *  - 按需渲染两类转发器控件：下载按钮 / 选择条（默认零 DOM 注入）
 *
 * 不在此世界实现的：任何状态反馈（一律走后台 notifications）、
 * 配置面板 / 引导浮层（迁 options 页）、RPC（迁后台）。
 */
import { CONTENT_SCHEMA, MAIN_CHANNEL } from '../messaging/protocol'
import type { CacheInjection, PageReadyData, Push, Req, Res } from '../messaging/protocol'
import { send } from '../messaging/hub'
import { i18n } from '../shared/i18n'
import { EMPTY_LEGACY_COUNTS, LEGACY_DB_NAME, LEGACY_STORE_KEY_PATH, LEGACY_STORES, estimateLegacyRecordBytes, planLegacyBatches } from '../shared/legacyDb'
import type { LegacyBatchResult, LegacyCounts, LegacyImportSummary, LegacyStore } from '../shared/legacyDb'
import { LEGACY_DB_SCANNED_KEY } from '../shared/storageKeys'
import { BRIDGE_MARKER_ATTR, EARLY_MARKER_ATTR, INGEST_MARKER_ATTR } from './markers'

console.info(`[iwara-assistant] ISOLATED bridge ready (schema ${CONTENT_SCHEMA})`)

/**
 * `document-start` 时机证据（对齐 ScriptCat 的 early-start 断言方式）。
 *
 * content script 在 `run_at: document_start` 执行时，`document.head` / `document.body`
 * 都还不存在，唯一存在的节点是 `documentElement`，且其内容为空。
 * 把此刻的 DOM 原始态记进 `html[data-ia-early]`，让真实站点冒烟能客观断言
 * 「注入发生在 body 出现之前」，而不是只靠肉眼感觉。
 *
 * 格式：`body=0;head=0;elements=3`（elements = documentElement.childElementCount，
 * 含本扩展注入的 `<style>` / `#pluginMenu` / `#pluginWatermark`）。
 */
function recordEarlyTiming(): void {
    const root = document.documentElement
    if (!root) return
    const snapshot = `body=${document.body ? 1 : 0};head=${document.head ? 1 : 0};elements=${root.childElementCount}`
    root.setAttribute(EARLY_MARKER_ATTR, snapshot)
}

recordEarlyTiming()

// ── 上行：MAIN 世界数据 → 后台 ────────────────────────────────────────

window.addEventListener(MAIN_CHANNEL.up, (event) => {
    let msg: { kind?: string; type?: string; body?: unknown; window?: { start?: number; end?: number }; token?: unknown; requestId?: string }
    try {
        msg = JSON.parse((event as CustomEvent).detail as string)
    } catch {
        return // 非 JSON payload（他方同名事件）：忽略
    }
    if (msg.type === 'HELLO_ACK') {
        // 门闩确认：MAIN 监听就绪，可安全下行推送，并补拉引动数据
        mainAcked = true
        markBridge('ready')
        if (!mainBootstrapped) void bootstrapPage()
        return
    }
    void forwardToBackground(msg)
})

/** MAIN 世界捕获数据 → 后台（协议见 docs/04） */
async function forwardToBackground(msg: { kind?: string; body?: unknown; window?: { start?: number; end?: number }; token?: unknown; requestId?: string }): Promise<void> {
    try {
        switch (msg.kind) {
            case 'videos': {
                const windowBounds = msg.window && typeof msg.window.start === 'number' && typeof msg.window.end === 'number' ? { start: msg.window.start, end: msg.window.end } : undefined
                const req: Req = {
                    type: 'INGEST_VIDEO_INFO',
                    payload: {
                        videos: Array.isArray(msg.body) ? msg.body : [],
                        source: 'fetch-intercept',
                        ...(windowBounds ? { window: windowBounds } : {})
                    }
                }
                const res = (await browser.runtime.sendMessage(req)) as { ok?: boolean; data?: { ingested?: number }; error?: string }
                // 入库结果标记（无敏感信息）：真实站点冒烟靠它证明「拦截→解析→入库」链路真的通了
                document.documentElement?.setAttribute(INGEST_MARKER_ATTR, res?.ok ? `ok:${res.data?.ingested ?? '?'}:${Array.isArray(msg.body) ? msg.body.length : -1}` : `fail:${res?.error ?? 'unknown'}`)
                break
            }
            case 'cache-injection': {
                // 回填列表按需查询：后台查库后原路答复（源项目在 /videos 响应内同步查库的等价物）
                const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
                const start = msg.window?.start
                const end = msg.window?.end
                if (requestId === '' || typeof start !== 'number' || typeof end !== 'number') break
                let list: CacheInjection | null = null
                try {
                    list = await send<CacheInjection | null>({ type: 'GET_CACHE_INJECTION', payload: { start, end } })
                } catch (error) {
                    // 查询失败也回一包 null：MAIN 立即退回推送列表，不必干等超时
                    console.debug('[iwara-assistant] cache injection query failed:', error)
                }
                pushDown({ type: 'CACHE_INJECTION_RESULT', payload: { requestId, list } })
                break
            }
            case 'authorization': {
                // Authorization 头中捕获的 refresh_token（原 config.authorization 缓存路径）
                const req: Req = { type: 'INGEST_AUTH', payload: { kind: 'refresh', token: String(msg.token) } }
                await browser.runtime.sendMessage(req)
                break
            }
            case 'access-token': {
                const req: Req = { type: 'INGEST_AUTH', payload: { kind: 'access', token: String(msg.token) } }
                await browser.runtime.sendMessage(req)
                break
            }
            default:
                break
        }
    } catch (error) {
        // 扩展上下文失效（更新中途重载）：静默，等待自动注入
        console.debug('[iwara-assistant] forward failed:', error)
    }
}

// ── 门闩协商（docs/04）：ISOLATED → MAIN 宣告 schema，MAIN ACK 后即握手 OK ──
// MAIN 可能晚于本文件执行（宿主注入顺序差异），HELLO 带退避重试直至 ACK

/** 下行：ISOLATED → MAIN（JSON 通道，仅转发不解析 payload） */
function pushDown(msg: Push): void {
    window.dispatchEvent(new CustomEvent(MAIN_CHANNEL.down, { detail: JSON.stringify(msg) }))
}

// ── 页面引动（HELLO ACK 后执行）：拉取配置快照 + 回填列表推给 MAIN ──────

let mainBootstrapped = false

async function bootstrapPage(): Promise<void> {
    mainBootstrapped = true
    try {
        // cookie 上行（aria2/iwaradl 请求头源；HttpOnly 本就不可见，无隐私面扩大）
        // rating 一并上行：后台读不到页面 localStorage，而订阅流遍历需要它
        await browser.runtime.sendMessage({ type: 'INGEST_COOKIE', payload: { cookie: document.cookie, rating: readSiteRating() } })
        const ready = await send<PageReadyData>({ type: 'PAGE_READY', payload: {} })
        pushDown({ type: 'CONFIG_SYNC', payload: { page: ready.pageConfig } })
        if (ready.cacheList) pushDown({ type: 'CACHE_INJECTION_LIST', payload: ready.cacheList })
    } catch (error) {
        // 后台暂不可用（SW 冷启动竞态等）：允许下次 HELLO ACK 重试
        mainBootstrapped = false
        console.debug('[iwara-assistant] page bootstrap failed:', error)
    }
}

let mainAcked = false
let helloRetries = 0

/**
 * 握手状态落到 `<html data-ia-bridge>`。
 *
 * 为什么需要 DOM 标记：MAIN 世界的 `console.info` 只在页面 console 可见，
 * 扩展侧无法跨浏览器读取（Firefox 只能靠 pref 打到进程 stderr）。
 * 真实站点冒烟要断言「fetch 钩子确实装上了」，只能靠 ISOLATED 世界
 * （它拿到了 MAIN 的 HELLO_ACK）把结论写回 DOM。生产运行时零行为影响。
 */
type BridgeState = 'pending' | 'ready' | 'no-ack'
let bridgeState: BridgeState = 'pending'

function applyBridgeMarker(): void {
    document.documentElement?.setAttribute(BRIDGE_MARKER_ATTR, bridgeState)
}

function markBridge(state: BridgeState): void {
    bridgeState = state
    if (document.documentElement) {
        applyBridgeMarker()
    } else {
        // document_start 极早期 html 还未建立：等解析出根节点再补写
        document.addEventListener('DOMContentLoaded', applyBridgeMarker, { once: true })
    }
}

function sayHello(): void {
    window.dispatchEvent(new CustomEvent(MAIN_CHANNEL.down, { detail: JSON.stringify({ type: 'HELLO', schema: CONTENT_SCHEMA }) }))
}

markBridge('pending')
sayHello()
const helloTimer = window.setInterval(() => {
    if (mainAcked) {
        window.clearInterval(helloTimer)
        return
    }
    if (helloRetries >= 10) {
        window.clearInterval(helloTimer)
        markBridge('no-ack')
        console.warn('[iwara-assistant] MAIN world did not ack HELLO —上行事件仍照常转发')
        return
    }
    helloRetries++
    sayHello()
}, 250)

// ── 旧脚本页面数据库（IndexedDB）桥 ────────────────────────────────
//
// 旧油猴脚本把库存数据写在 **iwara.tv 页面 origin** 的 IndexedDB（库名 IwaraDownloadTool），
// 与扩展 origin 不同源：后台（SW）看不到它，只有注入在本页的 content script 能读。
// 因此数据必须先在这里读出、再分批回传后台校验入库。

/** 单页初始条数（实际会根据页体积自适应放大/缩小，见 readLegacyPage） */
const LEGACY_READ_PAGE_START = 100
/** 下限为什么是 1：若一页里有几条超大记录，「100 条 × 每条几十 MB」本身就会把页面撑爆 —— 必须能降到单条 */
const LEGACY_READ_PAGE_MIN = 1
/** 上限只挡「每条极小」的表：再多也超不过单页体积预算，且单页要整批进内存 */
const LEGACY_READ_PAGE_MAX = 2000
/** 单页体积上限：控制页面内存峰值（旧库可能有几 MB 一条的完整记录），与消息批预算同量级 */
const LEGACY_READ_PAGE_BYTES = 16 * 1024 * 1024
/** 进度上报最小间隔（条数），避免小库也刷几十次 storage */
const LEGACY_PROGRESS_STEP = 1000

function openLegacyDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = window.indexedDB.open(LEGACY_DB_NAME)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('open legacy db failed'))
        request.onblocked = () => reject(new Error('legacy db blocked by another connection'))
    })
}

/**
 * 旧库是否存在。
 * 必须先用 `indexedDB.databases()` 探测：`open(name)` 不带版本会**创建**空库，
 * 那会让每次没装旧脚本的用户凭空多出一个库。
 */
async function legacyDbExists(): Promise<boolean> {
    const databases = typeof window.indexedDB?.databases === 'function' ? await window.indexedDB.databases() : null
    return databases?.some((entry) => entry.name === LEGACY_DB_NAME) ?? false
}

function countStore(connection: IDBDatabase, store: LegacyStore): Promise<number> {
    return new Promise((resolve, reject) => {
        const request = connection.transaction(store, 'readonly').objectStore(store).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error(`count ${store} failed`))
    })
}

/**
 * 按主键分页读取一页。
 *
 * **不能用 `getAll()` 读整表**：旧库 `videos` 里可能有几 MB 一条的完整记录，
 * 整表进内存会直接把页面卡死；而且逐页发送时事务已关闭，无法用游标跨 await 读。
 */
function readLegacyPage(connection: IDBDatabase, store: LegacyStore, after: IDBValidKey | null, limit: number): Promise<{ records: unknown[]; lastKey: IDBValidKey | null }> {
    return new Promise((resolve, reject) => {
        const objectStore = connection.transaction(store, 'readonly').objectStore(store)
        const range = after === null ? null : IDBKeyRange.lowerBound(after, true)
        const request = objectStore.getAll(range, limit)
        request.onsuccess = () => {
            const records = (request.result ?? []) as unknown[]
            const keyPath = LEGACY_STORE_KEY_PATH[store]
            const last = records.length > 0 ? ((records[records.length - 1] as Record<string, unknown>)[keyPath] as IDBValidKey) : null
            resolve({ records, lastKey: last ?? null })
        }
        request.onerror = () => reject(request.error ?? new Error(`read ${store} failed`))
    })
}

/**
 * 首次进入 iwara 页时扫一遍旧库（只读计数，不搬运数据）。
 * 结果落 storage.local.legacyDb，options「迁移」页显示「检测到 N 条」。
 * 扫描只做一次：之后靠显式导入重扫（避免每次导航都去翻旧库）。
 */
async function detectLegacyDb(): Promise<void> {
    try {
        const stored = await browser.storage.local.get(LEGACY_DB_SCANNED_KEY)
        if (stored[LEGACY_DB_SCANNED_KEY] === true) return
        const found = await legacyDbExists()
        const counts: LegacyCounts = { ...EMPTY_LEGACY_COUNTS }
        if (found) {
            const connection = await openLegacyDb()
            try {
                for (const store of LEGACY_STORES) {
                    if (connection.objectStoreNames.contains(store)) counts[store] = await countStore(connection, store)
                }
            } finally {
                connection.close()
            }
        }
        await browser.runtime.sendMessage({ type: 'LEGACY_DB_SCAN', payload: { found, counts } } satisfies Req)
    } catch (error) {
        // 旧库被其它连接阻塞、版本异常等：静默（迁移页会显示「尚未检测」）
        console.debug('[iwara-assistant] legacy db detect failed:', error)
    }
}

/**
 * 发送一批旧库记录；失败时二分重试。
 *
 * 一条消息装不下的记录（极少数异常记录）单独成批后仍失败 → 计为 failed 并跳过，
 * **不能让一条坏记录卡死整个导入**。
 */
async function sendLegacyBatch(store: LegacyStore, records: unknown[], summary: LegacyImportSummary): Promise<void> {
    try {
        const response = (await browser.runtime.sendMessage({ type: 'LEGACY_DB_BATCH', payload: { store, records } } satisfies Req)) as Res
        if (!response?.ok) throw new Error(response?.error ?? i18n.t('notify.storeWriteFailed', { store }))
        const result = (response.data ?? {}) as Partial<LegacyBatchResult>
        summary[store] += result.written ?? 0
        summary.failed += result.failed ?? 0
        summary.skipped += result.invalid ?? 0
    } catch (error) {
        if (records.length === 1) {
            summary.failed += 1
            console.warn(`[iwara-assistant] 旧库 ${store} 记录传输失败（已跳过）:`, error)
            return
        }
        const mid = Math.ceil(records.length / 2)
        await sendLegacyBatch(store, records.slice(0, mid), summary)
        await sendLegacyBatch(store, records.slice(mid), summary)
    }
}

/** 上报进度（后台落盘 → 迁移页订阅 storage 展示） */
async function reportLegacyProgress(store: LegacyStore, done: number, total: number): Promise<void> {
    try {
        await browser.runtime.sendMessage({ type: 'LEGACY_DB_PROGRESS', payload: { store, done, total } } satisfies Req)
    } catch {
        // 进度上报失败不影响导入
    }
}

/**
 * 逐表分页读取并按体积分批回传，后台校验/写入后返回结果。
 *
 * 页大小自适应：小记录放大页（减少往返），大记录缩小页（控制内存）。
 */
async function pullLegacyDb(): Promise<LegacyImportSummary> {
    const summary: LegacyImportSummary = { ...EMPTY_LEGACY_COUNTS, skipped: 0, failed: 0 }
    const connection = await openLegacyDb()
    try {
        for (const store of LEGACY_STORES) {
            if (!connection.objectStoreNames.contains(store)) continue
            const total = await countStore(connection, store)
            if (total === 0) continue
            let after: IDBValidKey | null = null
            let done = 0
            let lastReported = 0
            let pageSize = LEGACY_READ_PAGE_START
            while (done < total) {
                const page = await readLegacyPage(connection, store, after, pageSize)
                if (page.records.length === 0) break
                after = page.lastKey
                done += page.records.length

                for (const batch of planLegacyBatches(page.records)) await sendLegacyBatch(store, batch, summary)

                // 页体积自适应：超过预算就缩小，远小于预算就放大
                const pageBytes = page.records.reduce<number>((sum, record) => sum + estimateLegacyRecordBytes(record), 0)
                if (pageBytes > LEGACY_READ_PAGE_BYTES) pageSize = Math.max(LEGACY_READ_PAGE_MIN, Math.floor(pageSize / 2))
                else if (pageBytes < LEGACY_READ_PAGE_BYTES / 4) pageSize = Math.min(LEGACY_READ_PAGE_MAX, pageSize * 2)

                if (done - lastReported >= LEGACY_PROGRESS_STEP || done >= total) {
                    lastReported = done
                    await reportLegacyProgress(store, done, total)
                }
                if (page.lastKey === null) break
            }
        }
    } finally {
        connection.close()
    }
    return summary
}

// ── 下行：后台广播 → 页面 ────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg: Push, _sender, sendResponse) => {
    switch (msg.type) {
        case 'CACHE_INJECTION_LIST':
        case 'CONFIG_SYNC':
        case 'CONFIG_INVALIDATED':
            // 透传给 MAIN 世界：改写逻辑纯函数消费（不在此世界解析），
            // ACK 已完成，MAIN 监听就绪，可直接推送
            pushDown(msg)
            break
        case 'LEGACY_DB_PULL':
            // 后台转发来的显式导入请求：读库是异步的，必须保持通道开启直至 sendResponse
            pullLegacyDb().then(
                (summary) => sendResponse({ ok: true, data: summary } satisfies Res),
                (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Res)
            )
            return true
        default:
            // 其余 Push（DOWNLOAD_STATE 等）由 options/popup 消费，页面侧无需处理。
            // 曾经有 START_PAGE_SCAN 在此空转发：后台的遍历/审批/同步都已在后台自己完成，
            // 页内扫描没有存在意义，已从协议删除（不留死接口）。
            break
    }
    return false // 广播类消息不期待响应，同步结束
})

// 首次进入页面时探测一次旧库（检测自动、导入必须用户在迁移页显式触发）
void detectLegacyDb()

// ── cookie（HttpOnly 本就不可见，无隐私面扩大；拼 aria2/iwaradl header） ──

function pageCookie(): string {
    return document.cookie
}
void pageCookie

/**
 * 用户在 iwara 站点上选的内容分级（源 `LS_KEY_RATING` = `'rating'`）。
 *
 * content script 与页面同源，`localStorage` 读到的是同一份存储，所以这里能直接拿到；
 * 源项目同款默认值 `'all'`（`rating = () => localStorage.getItem(LS_KEY_RATING) ?? 'all'`）。
 * 读失败不外抛——cookie 上行本身不该因为一个可选字段挂掉。
 */
function readSiteRating(): string {
    try {
        return localStorage.getItem('rating') ?? 'all'
    } catch {
        return 'all'
    }
}

// ── 按需 DOM（转发器控件，默认 0 注入）：下载按钮 / 卡片选择条 ─────────────
// 仅在用户激活选择模式或开启卡片按钮时渲染；状态反馈不在此层（notifications/options）

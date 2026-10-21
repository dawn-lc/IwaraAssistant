/**
 * aria2 WebSocket JSON-RPC —— 实时通道（用户指定方案：以 WS 为主体，替代轮询）
 *
 * 能力（与 HTTP RPC 端点完全同构，aria2 官方支持 ws:// 端点）：
 *  - 发指令：addUri / tellStatus / remove… 经 WS 发送，实时无轮询开销
 *  - 收推送：aria2.onDownloadStart/Complete/Error 等通知自动到达，完成/失败即时感知
 *  - 保活：SW/持久后台页收到 WS 帧即重置空闲计时（Chrome 116+，docs/01）
 *
 * 断线策略：指数退避自动重连（1s 起，封顶 60s，连续失败 6 次后暂停等待 keepalive alarm）；
 * ws-keepalive alarm（2 min）兜底拉起——SW 挂起重入后常规定时器不可靠，alarm 保证自愈。
 * 指令通道优先走 WS；WS 未就绪时 aria2Client 自动落到 HTTP POST（行为不中断）。
 */
import { aria2WsUrl, isAria2Configured } from './client'
import { configReady } from '../../storage/configStore'

interface PendingCall {
    resolve: (value: unknown) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
}

type NotificationHandler = (params: unknown[]) => void

/** RPC 调用超时（ms）：WS 上无响应视为故障 */
const WS_CALL_TIMEOUT_MS = 15_000
/** 重连退避基值/上限/上限次数 */
const WS_RECONNECT_BASE_MS = 1000
const WS_RECONNECT_MAX_MS = 60_000
const WS_MAX_BACKOFF_ATTEMPTS = 6

let ws: WebSocket | null = null
let nextCallId = 1
const pending = new Map<string, PendingCall>()
const notificationHandlers = new Map<string, NotificationHandler[]>()
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | undefined

export function isWsOpen(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN
}

/**
 * aria2 的 **RPC 级错误**（方法不存在 / GID 不存在 / 参数非法…）。
 *
 * 必须与传输故障（连不上、超时、socket 关闭）分开：RPC 级错误说明**服务端已经答了，只是拒绝**，
 * 把同一个请求再发一次只会拿到一模一样的拒绝，白白多一发真实网络请求（实测：
 * `aria2.restart` 在 aria2 上不存在，WS 收到 `No such method` → 被当成传输故障降级 HTTP 重发 →
 * 又一发回同样的 `No such method`）。调用方据类型决定「返回错误」而不是「换个通道重试」。
 */
export class Aria2RpcError extends Error {
    readonly rpc: unknown

    constructor(rpc: unknown) {
        super(`aria2 rpc error: ${JSON.stringify(rpc)}`)
        this.name = 'Aria2RpcError'
        this.rpc = rpc
    }
}

/** 订阅 aria2 通知（如 aria2.onDownloadComplete）；返回解绑函数 */
export function onNotification(method: string, handler: NotificationHandler): () => void {
    const list = notificationHandlers.get(method) ?? []
    list.push(handler)
    notificationHandlers.set(method, list)
    return () => {
        const current = notificationHandlers.get(method) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
    }
}

/**
 * JSON-RPC 序列化 —— **WS 与 HTTP 必须共用同一份**。
 *
 * aria2 的布尔选项（`allow-overwrite` / `force-save`…）对 JSON bool 与字符串 `"true"`
 * 都接受（内部都走 `util::parseBool`），但两条路径形态不同会让“同一份参数为什么行为不一样”
 * 变成无法解释的偶发问题。源项目对 HTTP 路径明确做了 `String(v)`，这里保持一致。
 */
export function serializeRpc(payload: unknown): string {
    return JSON.stringify(payload, (_key, value: unknown) => (typeof value === 'boolean' ? String(value) : value))
}

/** 经 WS 发送 JSON-RPC 指令（未连接时抛错，由调用方决定降级） */
export function wsCall<T = unknown>(method: string, params: unknown[]): Promise<T> {
    if (!isWsOpen() || ws === null) return Promise.reject(new Error('aria2 ws not connected'))
    const id = String(nextCallId++)
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`aria2 ws 调用超时: ${method}`))
        }, WS_CALL_TIMEOUT_MS)
        pending.set(id, {
            resolve: resolve as (value: unknown) => void,
            reject,
            timer
        })
        ws!.send(serializeRpc({ jsonrpc: '2.0', id, method, params }))
    })
}

function handlePayload(raw: string): void {
    let payload: { id?: string | number; error?: unknown; result?: unknown; method?: string; params?: unknown[] }
    try {
        payload = JSON.parse(raw)
    } catch {
        return // 非 JSON 帧（握手后首帧等）：忽略
    }
    if (payload.id !== undefined && pending.has(String(payload.id))) {
        const call = pending.get(String(payload.id))!
        pending.delete(String(payload.id))
        clearTimeout(call.timer)
        if (payload.error !== undefined) {
            call.reject(new Aria2RpcError(payload.error))
        } else {
            call.resolve({ result: payload.result } as unknown)
        }
        return
    }
    if (typeof payload.method === 'string') {
        for (const handler of [...(notificationHandlers.get(payload.method) ?? [])]) {
            try {
                handler(payload.params ?? [])
            } catch (error) {
                console.warn(`[iwara-assistant] aria2 通知处理失败 ${payload.method}:`, error)
            }
        }
    }
}

function clearSocket(): void {
    if (ws === null) return
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try {
        ws.close()
    } catch {
        // 已断开
    }
    ws = null
}

function scheduleReconnect(): void {
    if (reconnectTimer !== undefined) return
    if (reconnectAttempts >= WS_MAX_BACKOFF_ATTEMPTS) return // 暂停自动退避，等待 keepalive alarm 兜底
    const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** reconnectAttempts, WS_RECONNECT_MAX_MS)
    reconnectAttempts++
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        void connect()
    }, delay)
}

/**
 * 主动断开并清零退避计数（端点变更时用）。
 *
 * 为什么需要它：`connect()` 发现已有连接就直接返回，而改了 `aria2Path` 之后
 * 旧连接指向的是**旧端点**——不清掉就会一直用错地址，直到 ws-keepalive 发现它
 * 早已断开（最多 2 分钟），而旧端点如果还活着则永远不会发现。
 */
export function resetConnection(): void {
    reconnectAttempts = 0
    if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
    }
    clearSocket()
}

/** 建立 WS 连接（幂等：已连接/已配置否/连接中直接返回） */
export async function connect(): Promise<void> {
    await configReady
    if (!isAria2Configured()) return
    if (ws !== null && ws.readyState <= WebSocket.OPEN) return
    clearSocket()
    try {
        ws = new WebSocket(aria2WsUrl())
    } catch (error) {
        console.warn('[iwara-assistant] aria2 ws 建立失败:', error)
        scheduleReconnect()
        return
    }
    ws.onopen = () => {
        reconnectAttempts = 0
        console.info(`[iwara-assistant] aria2 ws connected (${aria2WsUrl()})`)
    }
    ws.onmessage = (event) => {
        handlePayload(String(event.data)) // 收到帧即重置 SW 空闲计时（保活副作用）
    }
    ws.onerror = () => {
        // 交给 onclose 统一重连
    }
    ws.onclose = () => {
        const wasOpen = ws !== null
        ws = null
        // 未决调用全部失败（调用方已有 HTTP 降级路径）
        for (const [id, call] of [...pending.entries()]) {
            pending.delete(id)
            clearTimeout(call.timer)
            call.reject(new Error('aria2 ws closed'))
        }
        if (wasOpen) console.info('[iwara-assistant] aria2 ws closed — 安排重连')
        scheduleReconnect()
    }
}

/** keepalive alarm 入口：已配置则确保连接（含退避次数清零后重试） */
export async function keepAliveWs(): Promise<void> {
    if (!isAria2Configured()) {
        if (ws !== null) clearSocket() // 配置被清空：主动断开
        return
    }
    if (isWsOpen()) return
    reconnectAttempts = 0 // alarm 兜底给一次全新退避周期
    await connect()
    // 退避次数上限导致暂停自动重连时，alarm 兜底补拉
    if (reconnectTimer !== undefined && reconnectAttempts >= WS_MAX_BACKOFF_ATTEMPTS) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        void connect()
    }
}

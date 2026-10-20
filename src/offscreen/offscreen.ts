/**
 * offscreen 文档脚本（Chrome 专用）—— 两件事：
 *
 * 1. **写剪贴板**：MV3 service worker 没有 DOM，`navigator.clipboard` 不可用，
 *    Chrome 官方途径就是 offscreen document（reasons: CLIPBOARD）。写完由后台关闭文档。
 * 2. **保活心跳**（仅当用户在设置页开启「保持后台活跃」）：`runtime.connect` 到 SW，
 *    每 20 秒 `postMessage` 一次。文档建起来后不会因为 SW 空闲回收而消失，
 *    所以它是唯一能稳定充当「外部闹钟」的扩展内上下文——这与 ScriptCat 的做法一致。
 *
 * 为什么不用 `setTimeout` 做心跳：隐藏文档的定时器会被浏览器降频到分钟级，
 * 20 秒的节奏根本保不住。改用调度器 API 的 `user-visible` 优先级
 * （Chrome 94+；缺失时退回 `setTimeout` 并接受降级）。
 */
import { KEEP_ALIVE_HEARTBEAT_MS, KEEP_ALIVE_PORT, OFFSCREEN_TARGET } from '../shared/constants'

interface OffscreenRequest {
    target?: string
    type?: string
    text?: string
}

// ── 保活心跳 ─────────────────────────────────────────────────────────

let wanted = false
let port: chrome.runtime.Port | null = null
let scheduled = false

type SchedulerLike = {
    postTask?: (callback: () => void, options?: { delay?: number; priority?: 'user-blocking' | 'user-visible' | 'background' }) => unknown
}

/** 延迟执行：优先用调度器（隐藏文档的 setTimeout 会被降频） */
function later(callback: () => void, delay: number): void {
    const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler
    if (typeof scheduler?.postTask === 'function') {
        scheduler.postTask(callback, { delay, priority: 'user-visible' })
        return
    }
    setTimeout(callback, delay)
}

/**
 * 申请下一拍。`scheduled` 保证同时只有一个待执行的回调：
 * 断线重连会另外申请一次，没有这个闸门就会叠出两条心跳循环。
 */
function scheduleBeat(delay = KEEP_ALIVE_HEARTBEAT_MS): void {
    if (!wanted || scheduled) return
    scheduled = true
    later(() => {
        scheduled = false
        tick()
    }, delay)
}

function tick(): void {
    if (!wanted) return
    if (port) {
        try {
            port.postMessage({ type: 'keep-alive' })
        } catch {
            port = null
        }
    } else {
        connect()
    }
    scheduleBeat()
}

function connect(): void {
    if (!wanted || port) return
    let next: chrome.runtime.Port
    try {
        next = browser.runtime.connect({ name: KEEP_ALIVE_PORT })
    } catch {
        return // SW 正在重启：下一拍再试
    }
    port = next
    next.onDisconnect.addListener(() => {
        if (port === next) port = null
        // SW 被回收时端口会断；重连这个动作本身就会把 SW 唤醒
        if (wanted) scheduleBeat(1000)
    })
    try {
        next.postMessage({ type: 'keep-alive' })
    } catch {
        port = null
    }
}

function startKeepAlive(): void {
    wanted = true
    connect()
    scheduleBeat()
}

function stopKeepAlive(): void {
    wanted = false
    const current = port
    port = null
    try {
        current?.disconnect()
    } catch {
        // 已断开：忽略
    }
}

// ── 消息路由 ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const request = message as OffscreenRequest | undefined
    if (request?.target !== OFFSCREEN_TARGET) return false

    if (request.type === 'KEEP_ALIVE_START') {
        startKeepAlive()
        sendResponse({ ok: true })
        return false
    }
    if (request.type === 'KEEP_ALIVE_STOP') {
        stopKeepAlive()
        sendResponse({ ok: true })
        return false
    }
    if (request.type !== 'COPY_TEXT') return false

    const text = typeof request.text === 'string' ? request.text : ''
    void (async () => {
        try {
            await navigator.clipboard.writeText(text)
            sendResponse({ ok: true })
        } catch (error) {
            sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
    })()
    return true
})

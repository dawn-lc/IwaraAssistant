/**
 * 调试通道（本地桥）的**纯逻辑**：命令白名单、载荷整形、脱敏。
 *
 * 为什么要有这样一个通道：MV3 的 service worker 在浏览器里跑，出问题只能「打开扩展页 → 手动点 → 看控制台」，
 * 而用户的问题经常发生在后台已经跑了几小时、日志早被回收之后。让扩展**主动**连本机的一个调试服务
 * （长轮询 http://127.0.0.1:PORT/poll），就能在不动浏览器的情况下拿到队列、扫描记忆、日志环，并下发少量安全命令。
 *
 * 安全边界（每一条都重要）：
 * 1. **默认关闭**，只有用户在「高级」页显式打开才会连；关掉即停止（不残留定时器）；
 * 2. 只连 **127.0.0.1**（本扩展不监听端口、不接受入站），端口由用户填；
 * 3. 命令**白名单**：只允许「读状态」与「对队列的显式操作」，绝不执行任意代码、绝不改配置；
 * 4. 出站载荷**脱敏**：token / 密码一律替换成 ***，避免调试数据把凭据带出去（哪怕只发到本机）。
 */
import type { QueueTask } from './task'

/** 允许下发的命令（新增命令必须同时加处理分支与单测，否则编译期报错） */
export const DEBUG_BRIDGE_COMMANDS = ['snapshot', 'scan', 'retry', 'rebuild', 'remove', 'logs'] as const
export type DebugBridgeCommandName = (typeof DEBUG_BRIDGE_COMMANDS)[number]

export interface DebugBridgeCommand {
    id: string
    command: DebugBridgeCommandName
    /** retry / rebuild / remove 需要的队列任务 id */
    taskId?: string
}

/** 脱敏后的配置 */
export type DebugBridgeConfig = Record<string, unknown>

export interface DebugLogEntry {
    at: number
    level: 'info' | 'warn' | 'error'
    text: string
}

/** 出站载荷：调试服务看到的就是这一份 */
export interface DebugBridgeSnapshot {
    /** 扩展版本（manifest 版本，用来确认用户真的装上了新构建） */
    version: string
    /** 产物线：chrome-mv3 / firefox-mv2 */
    runtime: string
    at: number
    /** 脱敏后的配置 */
    config: DebugBridgeConfig
    /** 队列（完整，含 detail/kindRef，便于复现「为什么这条是失败」） */
    tasks: QueueTask[]
    /** 队列按状态计数 */
    counts: Record<string, number>
    /** aria2 扫描记忆（退避/熔断/采样，最能解释「为什么它没动静」） */
    scanMemory: unknown
    /** 最近的后台日志（环形缓冲，见 pushDebugLog） */
    logs: DebugLogEntry[]
    /** 已注册的 alarms（判定「定时器还在不在」） */
    alarms: { name: string; period?: number; next?: number }[]
}

/** 环形缓冲上限：调试通道只发最近这么多条 */
export const DEBUG_LOG_LIMIT = 200

/** 形似凭据的键：一律脱敏（宁可多脱，也不要漏） */
const SECRET_KEY_PATTERN = /token|secret|password|passwd|authorization|cookie/i

/** 把配置里的凭据替换成 ***（纯函数，单测钉住） */
export function maskSecrets(input: Record<string, unknown>): DebugBridgeConfig {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
        if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value !== '') {
            out[key] = '***'
            continue
        }
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = maskSecrets(value as Record<string, unknown>)
            continue
        }
        out[key] = value
    }
    return out
}

/** 队列按状态计数（任务页顶部的三个数字就是它） */
export function countTaskStatus(tasks: readonly QueueTask[]): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
    return counts
}

/**
 * 解析调试服务回给我们的命令。
 *
 * 这里**必须**过滤：服务端在本机，但本机的端口也可能被别的程序占着；不认识的命令一律丢弃，
 * 而不是当成特权执行。返回值带上被拒绝的命令名，便于在日志里留痕。
 */
export function parseBridgeCommands(raw: unknown): { accepted: DebugBridgeCommand[]; rejected: string[] } {
    const accepted: DebugBridgeCommand[] = []
    const rejected: string[] = []
    const list = Array.isArray(raw) ? raw : []
    for (const item of list) {
        if (item === null || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id : ''
        const command = typeof record.command === 'string' ? record.command : ''
        if (id === '') {
            rejected.push(command === '' ? '<no-id>' : command)
            continue
        }
        if (!(DEBUG_BRIDGE_COMMANDS as readonly string[]).includes(command)) {
            rejected.push(command === '' ? '<no-command>' : command)
            continue
        }
        const taskId = typeof record.taskId === 'string' && record.taskId !== '' ? record.taskId : undefined
        accepted.push({ id, command: command as DebugBridgeCommandName, ...(taskId === undefined ? {} : { taskId }) })
    }
    return { accepted, rejected }
}

/** 需要 taskId 的命令（给错的命令不该静默变成「什么都没做」） */
export function commandNeedsTaskId(command: DebugBridgeCommandName): boolean {
    return command === 'retry' || command === 'rebuild' || command === 'remove'
}

/** 长轮询地址：用户只填端口，永远只连回环地址 */
export function bridgeEndpoint(port: number): string {
    const safe = Number.isFinite(port) ? Math.trunc(port) : 0
    return 'http://127.0.0.1:' + safe + '/poll'
}

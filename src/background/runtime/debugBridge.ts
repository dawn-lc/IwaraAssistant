/**
 * 调试通道（扩展侧）：主动连本机的调试服务，推送快照并接收白名单命令。
 *
 * 形态选的是**长轮询出站**而不是 WebSocket：
 * - 出站 http 用现成的 <all_urls> 主机权限就能连 127.0.0.1，不需要改 manifest；
 * - MV3 的 SW 随时会被杀，WS 断了还得自己重连；长轮询本来就是「每次请求独立」，被杀也无状态可丢；
 * - 服务端是本机的一个小脚本，不需要在扩展里多一套协议栈。
 *
 * 默认关闭（config.debugBridgeEnabled）。开启后每 3 秒一次；失败退回 15 秒，绝不打满 CPU。
 * 关掉或端口变化时立刻停掉旧循环——调试通道本身不该成为一个新的「神秘后台任务」。
 */
import { ARIA2_SCAN_MEMORY_KEY, CONFIG_KEY } from '../../shared/storageKeys'
import { bridgeEndpoint, commandNeedsTaskId, countTaskStatus, DEBUG_LOG_LIMIT, maskSecrets, parseBridgeCommands, type DebugBridgeCommand, type DebugBridgeSnapshot, type DebugLogEntry } from '../../shared/debugBridge'
import { getConfig } from '../storage/configStore'
import { getTasks } from '../storage/queue'
import { rebuildTaskById, removeTaskById, retryTaskById } from '../download/queueActions'
import { scanAria2TasksAndEnqueue } from '../backends/aria2/tracker'

/** 轮询间隔：正常 3 秒；失败后 15 秒（服务没起、用户还没部署时别刷屏） */
const POLL_INTERVAL_MS = 3_000
const POLL_BACKOFF_MS = 15_000

const logRing: DebugLogEntry[] = []
let logCaptureInstalled = false

/** 记一条后台日志（环形缓冲，只保留最近 DEBUG_LOG_LIMIT 条） */
export function pushDebugLog(level: DebugLogEntry['level'], text: string): void {
    logRing.push({ at: Date.now(), level, text })
    while (logRing.length > DEBUG_LOG_LIMIT) logRing.shift()
}

/** 取最近的日志（调试快照用） */
export function debugLogs(): DebugLogEntry[] {
    return [...logRing]
}

/**
 * 把 console 的 info/warn/error 抄一份进环形缓冲。
 *
 * 只包一层，幂等（SW 重启后重新安装）。**不改 console 行为**：原样转发，调试通道挂了也不影响日志。
 */
export function installDebugLogCapture(): void {
    if (logCaptureInstalled) return
    logCaptureInstalled = true
    const wrap = (level: DebugLogEntry['level'], original: (...args: unknown[]) => void) => {
        return (...args: unknown[]) => {
            try {
                pushDebugLog(level, args.map((item) => (typeof item === 'string' ? item : item instanceof Error ? item.message : safeJson(item))).join(' '))
            } catch {
                // 记录日志失败绝不影响原日志
            }
            original(...args)
        }
    }
    console.info = wrap('info', console.info.bind(console))
    console.warn = wrap('warn', console.warn.bind(console))
    console.error = wrap('error', console.error.bind(console))
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value)
    } catch {
        return String(value)
    }
}

/** 已执行命令的结果：随下一次轮询一起回给调试服务（那边按 id 对上） */
interface DebugBridgeResult {
    id: string
    ok: boolean
    error?: string
    data?: unknown
}

let pendingResults: DebugBridgeResult[] = []
let loopToken = 0
let running = false
let runningPort = 0

/** 开启调试通道（已开则不重复启动；端口变了要重启循环） */
export function startDebugBridge(port?: number): void {
    const config = getConfig()
    if (port === undefined && config.debugBridgeEnabled !== true) {
        stopDebugBridge()
        return
    }
    const target = port ?? config.debugBridgePort
    installDebugLogCapture()
    if (running && runningPort === target) return
    if (running) stopDebugBridge()
    running = true
    runningPort = target
    const token = ++loopToken
    void pollLoop(token, target)
}

/** 关掉调试通道：递增令牌让在途循环自行退出（不 await，SW 里没必要等它） */
export function stopDebugBridge(): void {
    if (!running) return
    running = false
    runningPort = 0
    loopToken++
    console.info('[iwara-assistant] 调试通道已停止')
}

/**
 * 跟着配置变化开关。
 *
 * 用户打开开关后要**立刻**生效，而不是等浏览器重启；改端口也要立刻换过去。
 * 这里刻意不读 `getConfig()`：配置写入后 `configStore` 的内存副本是异步更新的，
 * 而两个 `storage.onChanged` 监听的执行顺序没有保证——读 `newValue` 才是准的。
 */
export function watchDebugBridgeConfig(): void {
    browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !(CONFIG_KEY in changes)) return
        const next = (changes[CONFIG_KEY]?.newValue ?? {}) as Record<string, unknown>
        if (next.debugBridgeEnabled !== true) {
            stopDebugBridge()
            return
        }
        const port = Number(next.debugBridgePort ?? 0)
        startDebugBridge(Number.isFinite(port) && port > 0 ? port : 8765)
    })
}

async function pollLoop(token: number, port: number): Promise<void> {
    console.info('[iwara-assistant] 调试通道已启动：' + bridgeEndpoint(port))
    while (token === loopToken) {
        let delay = POLL_INTERVAL_MS
        try {
            const snapshot = await buildSnapshot()
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 10_000)
            const response = await fetch(bridgeEndpoint(port), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ snapshot, results: pendingResults }),
                signal: controller.signal
            }).finally(() => clearTimeout(timer))
            pendingResults = []
            const payload = (await response.json()) as { commands?: unknown }
            const { accepted, rejected } = parseBridgeCommands(payload.commands)
            if (rejected.length > 0) pushDebugLog('warn', '调试通道拒绝了未授权的命令：' + rejected.join(', '))
            for (const command of accepted) pendingResults.push(await runCommand(command))
        } catch {
            delay = POLL_BACKOFF_MS
        }
        if (token !== loopToken) return
        await new Promise((resolve) => setTimeout(resolve, delay))
    }
}

async function runCommand(command: DebugBridgeCommand): Promise<DebugBridgeResult> {
    try {
        switch (command.command) {
            case 'snapshot':
            case 'logs':
                // 快照本来就随每次轮询上行，这里只需要回执
                return { id: command.id, ok: true }
            case 'scan': {
                const outcome = await scanAria2TasksAndEnqueue()
                return { id: command.id, ok: true, data: outcome }
            }
            case 'retry':
            case 'rebuild':
            case 'remove': {
                if (command.taskId === undefined) {
                    if (!commandNeedsTaskId(command.command)) break
                    return { id: command.id, ok: false, error: '缺少 taskId' }
                }
                const data = command.command === 'retry' ? await retryTaskById(command.taskId) : command.command === 'rebuild' ? await rebuildTaskById(command.taskId) : await removeTaskById(command.taskId)
                return { id: command.id, ok: true, data }
            }
        }
        return { id: command.id, ok: false, error: '未知命令：' + command.command }
    } catch (error) {
        return { id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
}

/** 组装一份出站快照（凭据脱敏） */
async function buildSnapshot(): Promise<DebugBridgeSnapshot> {
    const manifest = browser.runtime.getManifest()
    const tasks = getTasks()
    const scanMemory = await browser.storage.session
        .get(ARIA2_SCAN_MEMORY_KEY)
        .then((value) => value[ARIA2_SCAN_MEMORY_KEY])
        .catch(() => undefined)
    const alarms = await browser.alarms
        .getAll()
        .then((items) => items.map((item) => ({ name: item.name, period: item.periodInMinutes, next: item.scheduledTime })))
        .catch(() => [] as DebugBridgeSnapshot['alarms'])
    return {
        version: manifest.version,
        runtime: manifest.manifest_version === 2 ? 'firefox-mv2' : 'chrome-mv3',
        at: Date.now(),
        config: maskSecrets(getConfig() as unknown as Record<string, unknown>),
        tasks,
        counts: countTaskStatus(tasks),
        scanMemory,
        logs: debugLogs(),
        alarms
    }
}

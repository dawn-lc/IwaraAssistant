/**
 * 网络层失败的分类与退避 —— 给「国内网络访问海外站点极差」这种环境用的。
 *
 * ## 为什么必须与「链接失效」分开
 *
 * iwara 的直链失效（403/404）与网络被阻断（DNS 污染、连接重置、IP 阻断、SNI 嗅探阻断）
 * 在我们眼里是同一件事：aria2 报了个错。但**处置完全相反**：
 *
 * | 失败原因 | 重解析有没有用 | 该做什么 |
 * | --- | --- | --- |
 * | 直链过期（403/404） | **有用**，新链接立刻能用 | 重解析 + 换地址 |
 * | 网络被阻断 | **没用**，新链接一样连不上 | 退避重试；重解析只会在同一堵墙上多撞几次 |
 * | 磁盘满 / 文件被占 | 没用，且重试一定再撞 | 直接判失败并说清原因 |
 *
 * 旧行为是「非文件冲突一律重解析 + 重建」：一个被阻断的网络里，20 个任务每轮扫描
 * 各打一次解析、各重建一次任务，8 轮之后全部标 failed —— 用户看到的是「全都失败了」，
 * 而真实原因是他的网络出不去。
 *
 * ## 两类错误都要认
 *
 * 1. aria2 的错误码（数字，见 `classifyAria2Failure`）；
 * 2. 我们自己 fetch 抛出的网络异常（`isNetworkFetchError`，浏览器不给错误码，只有文案）。
 *
 * 判据全是纯函数，单测钉住；退避与熔断状态由调用方（tracker）持久化。
 */

/** 一次失败的归因 */
export type Aria2FailureKind = 'expired' | 'network' | 'transient' | 'file-conflict' | 'permanent' | 'unknown'

/** aria2 在「网络问题」这一档上的错误码（手册 1.36 / 3.1 一致） */
const NETWORK_CODES = new Set(['2', '6', '19', '23'])
/** 磁盘/权限/目录这一档：重试必然再撞 */
const PERMANENT_CODES = new Set(['9', '10', '15', '16', '17', '18'])

/**
 * 把 aria2 的 `errorCode` + `errorMessage` 归到五档之一。
 *
 * 22（HTTP 协议错误）必须看报文里的 `status=NNN`：同一码下 403 是链接过期、503 是网关抖动。
 * 拿不到状态码时按「链接问题」处理（重解析是无害的，而把它当网络问题会让任务一直等）。
 */
export function classifyAria2Failure(errorCode: string | undefined, errorMessage: string | undefined): Aria2FailureKind {
    const code = typeof errorCode === 'string' ? errorCode.trim() : ''
    const message = typeof errorMessage === 'string' ? errorMessage : ''
    if (isFileConflictCode(code)) return 'file-conflict'
    if (NETWORK_CODES.has(code)) return 'network'
    if (PERMANENT_CODES.has(code)) return 'permanent'
    // 29 = remote server was unable to handle the request temporarily：等一会儿就好
    if (code === '29') return 'transient'
    if (code === '22' || code === '4') {
        const status = /status\s*=\s*(\d{3})/i.exec(message)?.[1]
        if (status === undefined) return 'expired'
        if (status === '401' || status === '403' || status === '404' || status === '410') return 'expired'
        return 'transient'
    }
    // 1 = unknown error：只能看报文（"Connection reset"、"Name resolution ... failed"…）
    if (looksLikeNetworkMessage(message)) return 'network'
    return 'unknown'
}

/** 与 `shared/aria2Recover.ts` 的 `isFileConflictErrorCode` 同口径（11 DUPLICATE_DOWNLOAD / 13 FILE_ALREADY_EXISTS） */
function isFileConflictCode(code: string): boolean {
    return code === '11' || code === '13'
}

/** 报文里出现这些词就当网络层问题（aria2 的 message 是英文原文） */
const NETWORK_MESSAGE_HINTS = ['connection reset', 'connection refused', 'connection timed out', 'timeout', 'timed out', 'name resolution', 'could not resolve', 'temporary failure in name resolution', 'ssl/tls handshake', 'handshake failure', 'tls', 'certificate', 'network is unreachable', 'no route to host', 'eof', 'too many redirects']

function looksLikeNetworkMessage(message: string): boolean {
    const lower = message.toLowerCase()
    return NETWORK_MESSAGE_HINTS.some((hint) => lower.includes(hint))
}

/**
 * 浏览器 fetch 的网络层异常判定（Firefox / Chrome / Safari 的文案各不相同）。
 *
 * ⚠️ 只认「传输没建立/被切断」，不认 HTTP 4xx/5xx —— 那些是拿到了响应，
 * 属于内容或服务端问题，不该走网络退避。
 */
export function isNetworkFetchError(error: unknown): boolean {
    if (error === undefined || error === null) return false
    const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : ''
    // 我们自己的超时（AbortController）也算网络层：请求没走完
    if (name === 'AbortError' || name === 'TimeoutError') return true
    if (name !== 'TypeError' && name !== 'NetworkError') return false
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    const lower = message.toLowerCase()
    if (lower === '') return name === 'TypeError'
    return lower.includes('failed to fetch') || lower.includes('network') || lower.includes('load failed') || lower.includes('connection') || lower.includes('reset') || lower.includes('timeout') || lower.includes('econn') || lower.includes('enotfound') || lower.includes('eai_again')
}

/** 某个任务的网络失败退避状态（持久化在 scanMemory 里，见 `Aria2ScanMemory`） */
export interface Aria2NetworkBackoff {
    /** 连续网络失败次数（成功后清零） */
    count: number
    /** 最近一次失败的时间戳（熔断判据用） */
    lastAt: number
    /** 下次允许重试的时间戳 */
    nextAt: number
}

/** 首次退避 1 分钟，之后翻倍 */
export const NETWORK_BACKOFF_BASE_MS = 60_000
/** 上限 30 分钟：再长的等待只会让用户以为「卡住了」 */
export const NETWORK_BACKOFF_CAP_MS = 30 * 60_000

/** 记一次网络失败：`count` 累加，`nextAt` 按指数退避推后 */
export function nextNetworkBackoff(previous: Aria2NetworkBackoff | undefined, now: number): Aria2NetworkBackoff {
    const count = (previous?.count ?? 0) + 1
    const delay = Math.min(NETWORK_BACKOFF_CAP_MS, NETWORK_BACKOFF_BASE_MS * 2 ** (count - 1))
    return { count, lastAt: now, nextAt: now + delay }
}

/** 现在该不该再试（没有记录 = 该试；退避期内 = 不该试） */
export function networkBackoffDue(previous: Aria2NetworkBackoff | undefined, now: number): boolean {
    if (!previous) return true
    return now >= previous.nextAt
}

/** 退避还剩多久（毫秒），用于告诉用户「稍后重试」到底是多久 */
export function networkBackoffRemaining(previous: Aria2NetworkBackoff | undefined, now: number): number {
    if (!previous) return 0
    return Math.max(0, previous.nextAt - now)
}

/**
 * 熔断：最近 `NETWORK_BREAKER_WINDOW_MS` 内有 `NETWORK_BREAKER_MIN_TASKS` 个以上任务
 * 因网络失败 ⇒ 判定「整个出口坏了」。
 *
 * 为什么要熔断：国内的阻断是**成片**的。20 个正在下的任务会在几秒内一起失败，
 * 逐个小步退避仍然会打出 20 次解析 + 20 次 addUri；而且这些请求本身大概率也出不去，
 * 只是在拖长失败时间。熔断后统一冷却，并只发一条通知。
 */
export const NETWORK_BREAKER_WINDOW_MS = 5 * 60_000
export const NETWORK_BREAKER_MIN_TASKS = 3
export const NETWORK_BREAKER_COOLDOWN_MS = 10 * 60_000

export function shouldOpenNetworkBreaker(failures: Record<string, Aria2NetworkBackoff>, now: number): boolean {
    let recent = 0
    for (const entry of Object.values(failures)) {
        if (now - entry.lastAt <= NETWORK_BREAKER_WINDOW_MS) recent += 1
    }
    return recent >= NETWORK_BREAKER_MIN_TASKS
}

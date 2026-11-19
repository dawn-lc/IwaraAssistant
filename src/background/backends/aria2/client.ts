/**
 * aria2 JSON-RPC 客户端 —— 自 download/downloaders.ts 抽出（WS 追踪与下载共用）
 * 类型自原 types/aria2.d.ts 精简；任务 ID 提取自原 download/aria2.ts aria2TaskExtractVideoID
 */
import { among, isEmpty, isNullOrUndefined } from '../../../shared/strings'
import { analyzePath } from '../../../shared/analyzePath'
import { aria2AuthParams } from '../../../shared/aria2Rpc'
import { isAria2GidMissingError } from '../../../shared/aria2Recover'
import { ARIA2_CAPABILITIES_UPSTREAM, parseAria2Capabilities, refineAria2Capabilities, type Aria2Capabilities, type Aria2VersionInfo } from '../../../shared/aria2Flavor'
import { ARIA2_GLOBAL_OPTIONS_DEFAULT, parseAria2GlobalOptions, type Aria2GlobalOptions } from '../../../shared/aria2Options'
import { getConfig } from '../../storage/configStore'
import { isWsOpen, serializeRpc, wsCall, Aria2RpcError } from './ws'

export interface Aria2Uri {
    uri: string
    status: 'used' | 'waiting'
}

export interface Aria2File {
    index: string
    path: string
    length: string
    completedLength: string
    selected?: string
    uris: Aria2Uri[]
}

export interface Aria2Status {
    gid: string
    status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'
    totalLength: string
    completedLength: string
    downloadSpeed: string
    errorCode?: string
    errorMessage?: string
    dir?: string
    files?: Aria2File[]
    bittorrent?: unknown
    /**
     * 媒体任务（HLS/DASH）的进度信息。
     *
     * 只有 aria2-next 3.x 会返回，而且此时 totalLength 恒为 0 —— 进度只能看
     * media.progress（见 shared/aria2Recover 的 aria2ProgressOf）。
     */
    media?: {
        progress?: string
        downloadedLength?: string
        lengthKnown?: string
        protocol?: string
        live?: string
    }
}

interface Aria2RpcResult<T> {
    id: string
    jsonrpc: string
    error?: unknown
    result?: T
}

export function isAria2Configured(): boolean {
    const path = getConfig().aria2Path
    return typeof path === 'string' && path !== ''
}

/** tellActive/tellStopped 的取值字段（扫描对账与 ID 提取共用） */
export const EXTRACT_VIDEO_ID_FIELDS = ['gid', 'status', 'files', 'bittorrent', 'errorMessage', 'errorCode']

/**
 * aria2 RPC 统一入口：指令优先经 WebSocket 实时发送（发指令+收推送同一连接），
 * WS 未就绪/传输故障时降级 HTTP POST，行为不中断。
 *
 * **RPC 级错误不降级**：那说明 aria2 已经作答（只是拒绝），换通道重发只会拿到同样的拒绝，
 * 却多一次真实请求。直接按 HTTP 路径的同构形态（`{error}`）返回，让两条传输对业务错误表现一致。
 */
export async function aria2API<T = unknown>(method: string, params: unknown[]): Promise<Aria2RpcResult<T>> {
    const config = getConfig()
    const authParams = aria2AuthParams(config.aria2Token, params)
    if (isWsOpen()) {
        try {
            const { result } = await wsCall<{ result: T }>(method, authParams)
            return { id: 'ws', jsonrpc: '2.0', result }
        } catch (error) {
            if (error instanceof Aria2RpcError) return { id: 'ws', jsonrpc: '2.0', error: error.rpc }
            console.warn(`[iwara-assistant] aria2 ws 调用降级 HTTP (${method}):`, error instanceof Error ? error.message : error)
        }
    }
    const response = await fetch(config.aria2Path, {
        headers: {
            accept: 'application/json',
            'content-type': 'application/json'
        },
        // 与 WS 路径共用 `serializeRpc`：aria2 的 bool 选项在两条路径上必须形态一致
        body: serializeRpc({ jsonrpc: '2.0', method, id: crypto.randomUUID(), params: authParams }),
        method: 'POST',
        // 指令失败时顺便踢一条重连，缩短下次 WS 可用窗口
        signal: AbortSignal.timeout(15_000)
    }).catch((error: unknown) => {
        void import('./ws').then((m) => m.connect()).catch(() => undefined)
        throw error
    })
    return (await response.json()) as Aria2RpcResult<T>
}

/**
 * 「要一份完整状态」的字段集——**唯一来源**。
 *
 * ⚠️ 这里曾经是三份手抄的字段表（本文件、`tracker` 的扫描、`tracker` 的僵尸查询），
 * 结果漂移出一个必然的 bug：`aria2TellStatus` 的列表里**没有 `errorCode`**，
 * 而 `handleDownloadError` 读它 → 失败原因永远落到「未知错误码」，
 * `isFileConflictErrorCode` 在事件路径上也永远为假。
 *
 * aria2 只返回被请求的键，漏一个键就是一条静默失效的判断，所以别再就地手写数组。
 */
export const ARIA2_STATUS_FIELDS = ['gid', 'status', 'errorCode', 'errorMessage', 'files', 'bittorrent', 'totalLength', 'completedLength', 'downloadSpeed', 'connections'] as const

// ── 活任务索引：投递前先查「同一个视频是不是已经在下了」────────────────

/** 索引的存活时间：批量投递同一批文件时只需一次查询，又要足够短以免挡住刚完成的任务 */
const LIVE_GID_TTL_MS = 5_000

let liveGidCache: { at: number; map: Map<string, string> } | undefined

/**
 * aria2 里**正在跑**的任务索引（videoId → gid），5 秒缓存。
 *
 * 投递前必须查一次：同一视频如果还有活着的 gid（用户清过队列、上一轮记录丢了、两个入口
 * 并发投递），再 `addUri` 就会撞 `belongs to another download`（errorCode 13），
 * 用户看到的是「目标文件已存在，请先确认是否已下好」这种看不懂的假失败。
 * 已有活 gid 就**接管它**——这正是「自己创建的任务不许重复」的落地点。
 */
export async function aria2LiveGidMap(): Promise<Map<string, string>> {
    if (liveGidCache !== undefined && Date.now() - liveGidCache.at < LIVE_GID_TTL_MS) return liveGidCache.map
    const map = new Map<string, string>()
    const [active, waiting] = await Promise.all([aria2API<Aria2Status[]>('aria2.tellActive', [EXTRACT_VIDEO_ID_FIELDS]).catch(() => undefined), aria2API<Aria2Status[]>('aria2.tellWaiting', [0, 500, EXTRACT_VIDEO_ID_FIELDS]).catch(() => undefined)])
    for (const task of [...(active?.result ?? []), ...(waiting?.result ?? [])]) {
        // 种子任务（bittorrent）不属于任何视频，别拿它的 gid 去接管
        if (!isNullOrUndefined(task.bittorrent)) continue
        const videoId = extractVideoIdFromTask(task)
        if (videoId !== undefined && videoId !== '' && !map.has(videoId)) map.set(videoId, task.gid)
    }
    liveGidCache = { at: Date.now(), map }
    return map
}

/** 投递成功后把 gid 记进索引：同批后续投递立刻看得见，不必等缓存过期 */
export function rememberAria2LiveGid(videoId: string, gid: string): void {
    if (liveGidCache !== undefined && Date.now() - liveGidCache.at < LIVE_GID_TTL_MS) liveGidCache.map.set(videoId, gid)
}
/** aria2 任务状态（原 aria2.tellStatus 封装） */
export async function aria2TellStatus(gid: string): Promise<Aria2Status | undefined> {
    const res = await aria2API<Aria2Status>('aria2.tellStatus', [gid, [...ARIA2_STATUS_FIELDS]])
    return res.result
}

// ── 分支能力探测（上游 aria2 / aria2-next 各版本）────────────────────

/**
 * 能力缓存。
 *
 * 探测要一次 getVersion（对自报身份的 aria2-next 再补一次 system.listMethods），
 * 不该在每个任务上重复做。10 分钟过期：换二进制重启是低频事件，过期后重探一次
 * 就能自动切过来，不需要监听什么信号。
 */
let capabilitiesCache: { at: number; value: Aria2Capabilities } | undefined
const CAPABILITIES_TTL_MS = 10 * 60 * 1000

/**
 * 探测对面是哪条分支、有哪些能力（失败返回上游默认值，绝不抛）。
 *
 * `stallsOnForbidden` 这类位决定要不要给任务加 `max-tries`，所以**拿不到就按上游**：
 * 少加一个 option 顶多是恢复变慢，加错了会让老版本行为莫名其妙地变。
 */
export async function aria2Capabilities(): Promise<Aria2Capabilities> {
    if (capabilitiesCache && Date.now() - capabilitiesCache.at < CAPABILITIES_TTL_MS) return capabilitiesCache.value
    try {
        const res = await aria2API<Aria2VersionInfo>('aria2.getVersion', [])
        let caps = parseAria2Capabilities(res.result)
        // 只有自报家门的新版 aria2-next 才值得再花一次往返确认扩展方法；
        // 老版本（2.4.9）没有 product，多问一次也只会得到「没有」。
        if (caps.flavor === 'aria2-next' && caps.selfIdentifying) {
            const methods = await aria2API<string[]>('system.listMethods', []).catch(() => undefined)
            if (methods?.result) caps = refineAria2Capabilities(caps, methods.result)
        }
        capabilitiesCache = { at: Date.now(), value: caps }
        return caps
    } catch {
        return ARIA2_CAPABILITIES_UPSTREAM
    }
}

/** 同步读缓存（已经探测过才有；用于字段表这类不该 await 的位置） */
export function aria2CachedCapabilities(): Aria2Capabilities | undefined {
    return capabilitiesCache?.value
}

/** 强制重探（例如用户改了 RPC 地址、或 aria2 重启换了二进制） */
export function resetAria2Capabilities(): void {
    capabilitiesCache = undefined
    optionsCache = undefined
    sessionInfoMethodCache = undefined
}

/**
 * 对面**正在生效**的全局配置（`aria2.getGlobalOption`）。
 *
 * 为什么必须问而不是假设：同一个参数在不同配置下含义不同，硬编等于替用户改配置。
 * 尤其 `max-tries=0`（无限重试）与 `all-proxy`（配了代理）这两项，会直接改变
 * 我们投递参数的对错（见 shared/aria2Options 的注释与实测）。
 *
 * 取不到就用上游默认值——那是最保守的一侧。
 */
let optionsCache: { at: number; value: Aria2GlobalOptions } | undefined

export async function aria2GlobalOptions(): Promise<Aria2GlobalOptions> {
    if (optionsCache && Date.now() - optionsCache.at < CAPABILITIES_TTL_MS) return optionsCache.value
    try {
        const res = await aria2API<Record<string, string>>('aria2.getGlobalOption', [])
        const value = parseAria2GlobalOptions(res.result)
        optionsCache = { at: Date.now(), value }
        return value
    } catch {
        return ARIA2_GLOBAL_OPTIONS_DEFAULT
    }
}

// ── 会话 ID：名字在两条线上不同 ──────────────────────────────────────

/**
 * getSessionInfo 的方法名**不通用**（2026-11-20 实测两台 3.1.1）：
 * - aria2-next 3.1.1：aria2.getSessionInfo 有，system.getSessionInfo → No such method；
 * - 上游 1.36.0：只有 system.getSessionInfo。
 *
 * 会话 ID 是「aria2 重启过没有」的唯一可靠信号：重启后旧 gid 全部失效，慢速/停滞采样、
 * 恢复次数、网络退避都建立在那些 gid 上，必须一起清掉。读不到就只能每轮拉全量
 * tellStopped（闲时也是每 5 分钟一页），所以两个名字都试，成功过就缓存那个名字。
 */
let sessionInfoMethodCache: string | undefined

/** 依次尝试的会话信息方法名（顺序 = 实测优先级：两台 aria2-next 都是前者） */
export const ARIA2_SESSION_INFO_METHODS = ['aria2.getSessionInfo', 'system.getSessionInfo'] as const

/** 读 aria2 的会话 ID；两个名字都失败就返回空串（调用方按「读不到」处理） */
export async function aria2SessionId(): Promise<string> {
    const ordered = sessionInfoMethodCache === undefined ? [...ARIA2_SESSION_INFO_METHODS] : [sessionInfoMethodCache, ...ARIA2_SESSION_INFO_METHODS.filter((method) => method !== sessionInfoMethodCache)]
    for (const method of ordered) {
        const res = await aria2API<{ sessionId?: string }>(method, []).catch(() => undefined)
        const sessionId = res?.result?.sessionId
        if (typeof sessionId === 'string' && sessionId !== '') {
            if (sessionInfoMethodCache !== method) sessionInfoMethodCache = method
            return sessionId
        }
    }
    return ''
}

/**
 * 清掉一条结果记录（`removeDownloadResult`），会等它真正入表。
 *
 * ## 为什么必须等
 *
 * `aria2.remove` 只置 halt 请求位，RequestGroup 的结果要等下一个事件循环才进
 * `downloadResults_`；而 `removeDownloadResult` 只查那张表，查不到就抛
 * `Could not remove download result`。旧写法是「remove 紧接着 removeDownloadResult + 空 catch」，
 * 于是清理**大概率失败且无声无息**，`removed` 记录留在 tellStopped 里，
 * 下一轮扫描按 `planResidualAdoption` 的规则把它当外部任务**收编成 failed** ——
 * 用户取消掉的任务会以「失败」的身份重新出现在任务面板里。
 *
 * 所以：结果还没入表就等一个 tick 再来，试满仍然失败就打日志（不再静默）。
 *
 * ## 「GID ... is not found」有两种含义，必须分开（真机实测）
 *
 * | 场景 | remove 后立刻 removeDownloadResult | tellStopped 里有没有记录 |
 * | --- | --- | --- |
 * | 取消 **active** 任务 | **成功** | 有，但我们当场删掉 |
 * | 取消 **waiting** 任务 | `GID ... is not found` | **从头到尾都没有** |
 *
 * 后者是「这条任务压根不会产生结果记录」，清理早就完成了；把它当失败去重试，
 * 会让每次取消排队任务白等 1 秒并打一条假警告。用 tellStatus 复查即可区分：
 * 只有它还在（`exists === true`）才说明结果尚未入表、值得再等。
 */
export async function aria2RemoveResult(gid: string, attempts = 20): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
        let removed = false
        try {
            const res = await aria2API('aria2.removeDownloadResult', [gid])
            removed = res.error === undefined
        } catch {
            removed = false
        }
        if (removed) return true
        let exists: boolean | undefined
        try {
            const probe = await aria2API<{ gid: string }>('aria2.tellStatus', [gid, ['gid']])
            exists = probe.error === undefined ? true : isAria2GidMissingError(probe.error) ? false : undefined
        } catch {
            exists = undefined
        }
        // 查不到 = gid 已经彻底不存在 = 没有记录可清 = 目标达成
        if (exists === false) return true
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    console.warn(`[iwara-assistant] aria2 结果记录清理失败 gid=${gid}（下轮扫描可能把它当残留收编）`)
    return false
}

/** http(s) rpc 地址 → ws(s) 通知地址 */
export function aria2WsUrl(): string {
    return getConfig().aria2Path.replace(/^http/, 'ws')
}

/**
 * 从 aria2 任务中提取视频 ID（原 aria2TaskExtractVideoID 逐行移植）：
 * ① 下载 URL 的 videoid 参数（buildDownloadUrl 注入的富化参数，任务反查机制基础）；
 * ② 兜底：文件路径尾段 "[ID].mp4" 反向提取
 */
export function extractVideoIdFromTask(task: Aria2Status): string | undefined {
    try {
        if (isNullOrUndefined(task.files) || task.files.length !== 1) return undefined
        const file = task.files[0]
        if (isNullOrUndefined(file)) return undefined
        if (!file.uris || file.uris.length < 1) return undefined
        const downloadUrl = new URL(file.uris[0]!.uri)
        let videoId = downloadUrl.searchParams.get('videoid')
        if (!isNullOrUndefined(videoId) && !isEmpty(videoId)) return videoId
        if (isNullOrUndefined(file.path) || isEmpty(file.path)) return undefined
        const path = analyzePath(file.path)
        if (isNullOrUndefined(path.fullName) || isEmpty(path.fullName)) return undefined
        videoId = among(path.fullName.toLowerCase(), '[', '].mp4', false, true)
        if (isEmpty(videoId)) return undefined
        return videoId
    } catch {
        return undefined
    }
}

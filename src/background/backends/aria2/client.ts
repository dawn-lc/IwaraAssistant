/**
 * aria2 JSON-RPC 客户端 —— 自 download/downloaders.ts 抽出（WS 追踪与下载共用）
 * 类型自原 types/aria2.d.ts 精简；任务 ID 提取自原 download/aria2.ts aria2TaskExtractVideoID
 */
import { among, isEmpty, isNullOrUndefined } from '../../../shared/strings'
import { analyzePath } from '../../../shared/analyzePath'
import { aria2AuthParams } from '../../../shared/aria2Rpc'
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
export const ARIA2_STATUS_FIELDS = ['gid', 'status', 'errorCode', 'errorMessage', 'files', 'bittorrent', 'totalLength', 'completedLength', 'downloadSpeed'] as const

/** aria2 任务状态（原 aria2.tellStatus 封装） */
export async function aria2TellStatus(gid: string): Promise<Aria2Status | undefined> {
    const res = await aria2API<Aria2Status>('aria2.tellStatus', [gid, [...ARIA2_STATUS_FIELDS]])
    return res.result
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
 */
export async function aria2RemoveResult(gid: string, attempts = 20): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
        const res = await aria2API('aria2.removeDownloadResult', [gid]).catch(() => undefined)
        if (res !== undefined && res.error === undefined) return true
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

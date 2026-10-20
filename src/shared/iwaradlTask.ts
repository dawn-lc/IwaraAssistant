/**
 * iwaradl 任务模型 —— 把它的 HTTP API 响应翻译成我们认得的状态。
 *
 * 纯函数、零 I/O，所以能被单测直接钉住；HTTP 客户端与轮询调度在 `background/backends/iwaradl/`。
 * 这个分层不是形式主义：把这些判定搬进 `background/` 会让单测 import 到整条后台依赖链
 * （queue → db → idb），在 Node 里直接 `indexedDB is not defined`。
 *
 * ## 能力（来自 `https://github.com/Izumiko/iwaradl/blob/master/http-api.md`）
 *
 * 任务主键是 **`vid`（视频 ID）**，不是自增 ID——所以队列里的 `kindRef` 就该存视频 ID。
 * 状态只有四个，`progress` 是 0~1 的浮点。
 */

/** iwaradl 的四个任务状态（API 文档明示，没有第五个） */
export type IwaradlStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface IwaradlTask {
    /** 视频 ID（API 的主键） */
    vid: string
    status: IwaradlStatus
    /** 0~1；脏值已被丢弃或夹取 */
    progress?: number
}

const IWARADL_STATUSES: readonly IwaradlStatus[] = ['pending', 'running', 'completed', 'failed']

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析单个任务。结构不合规返回 `undefined` 而不是抛错：
 * 这是第三方服务的响应，客户端没有资格要求它永远正确；
 * 丢掉一条坏记录远好于让整轮对账失败。
 */
export function parseIwaradlTask(raw: unknown): IwaradlTask | undefined {
    if (!isRecord(raw)) return undefined
    const vid = raw['vid']
    const status = raw['status']
    if (typeof vid !== 'string' || vid === '') return undefined
    if (typeof status !== 'string' || !IWARADL_STATUSES.includes(status as IwaradlStatus)) return undefined
    const rawProgress = raw['progress']
    const progress = typeof rawProgress === 'number' && Number.isFinite(rawProgress) ? Math.min(1, Math.max(0, rawProgress)) : undefined
    return { vid, status: status as IwaradlStatus, ...(progress === undefined ? {} : { progress }) }
}

/** 解析任务列表（POST 与 GET /api/tasks 都返回数组）；坏记录被跳过而不是丢掉整批 */
export function parseIwaradlTasks(raw: unknown): IwaradlTask[] {
    if (!Array.isArray(raw)) return []
    return raw.map(parseIwaradlTask).filter((task): task is IwaradlTask => task !== undefined)
}

/**
 * iwaradl 状态 → 队列状态。
 *
 * `pending` 映射到 `queued` 而不是 `running`：它还没开始传，界面上说「下载中」是假的。
 */
export function queueStatusOfIwaradl(status: IwaradlStatus): 'queued' | 'running' | 'complete' | 'failed' {
    switch (status) {
        case 'pending':
            return 'queued'
        case 'running':
            return 'running'
        case 'completed':
            return 'complete'
        case 'failed':
            return 'failed'
    }
}

/** 该状态是否还需要继续轮询（终态的任务不该占着 alarm） */
export function isIwaradlActive(status: IwaradlStatus): boolean {
    return status === 'pending' || status === 'running'
}

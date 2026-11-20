/**
 * MediaCenter 批量同步的进度快照（后台 → options 页的只读视图）。
 *
 * 为什么需要有进度：修掉「一次拉 118 MB」之后，阶段一变成**上千次分页请求**
 * （14 万条 ÷ 每页 100 条），在一台家用 NAS 上要几十秒到几分钟。这段时间界面上
 * 只有一颗变灰的按钮和「同步中…」，用户无法区分「在动」和「卡死」——项目里
 * 导出/导入/批量入库/好友审批都因为同一个理由配了进度条。
 *
 * ### 为什么是 `storage.session` 快照 + `onChanged` 订阅，而不是 options 轮询消息
 *
 * 最初是「options 每 1s 发 `GET_MEDIA_SYNC_STATE`」。实测两个缺点：
 * 1. 长任务期间的消息往返**不受我们控制**（宿主可能排队、可能延迟派发），
 *    一旦某次轮询被卡住，进度就停在旧值上——用户看到的正是「条不动」；
 * 2. 阶段切换不会立刻反映（最多晚一个轮询周期），而 400ms 的写入节流被 1s 的
 *    读取周期放大成「永远慢一拍」。实测阶段一全程显示「已读 0 条」就是这个原因。
 *
 * 改成后台写 session、页面订阅 `storage.onChanged` 后：写入即推送，阶段切换立刻可见。
 * 这也是 `friendApprove` 已经在用的模式（同一套「内存即真相 + 快照给别人看」的理由）。
 *
 * ### 为什么不落 `storage.local`
 *
 * `storage.session` 是**内存态**（浏览器退出即清空），与「同步只活在当前进程」一致；
 * 落 local 会在崩溃后被永久残留成「正在同步」。即便如此，SW 若真的中途被杀，
 * session 里的 `running: true` 仍会留到浏览器关闭——所以读取侧必须有
 * `settleInterrupted` 归一（见下），不能假设「session 里有 running 就一定在跑」。
 */
export type MediaSyncStage = 'list' | 'push' | 'backfill'

/**
 * 长任务的**终态结论** —— fire-and-forget 的唯一回传通道。
 *
 * 为什么结论也写进快照：`SYNC_MEDIA_CENTER` / `BACKFILL_MEDIA_CENTER` 都由后台
 * `void` 起任务、消息只回 `{ started }`。Chrome 对**单次事件**有 5 分钟硬上限，
 * 12 万条推送要十几分钟——把整轮 `await` 在消息处理器里，到期 SW 被杀，
 * 页面那边 `await send()` 的 promise 永远不 resolve（用户看到的就是「点了没反应」）。
 * 结论既然不能再靠消息返回值，就只能落在快照里让页面订阅到。
 */
/** 起一轮长任务的返回：只回「起没起来」，结论另走快照（MediaTaskResult） */
export interface MediaTaskStart {
    started: boolean
    reason?: string
}

export interface MediaTaskResult {
    kind: 'sync' | 'backfill'
    /** 本轮参与的数量（sync = 映射条数；backfill = 需要补齐的远端记录数） */
    total: number
    ok: number
    failed: number
    /** 刻意跳过（backfill：已有映射 / 提取不到视频 ID / 远端记录缺 filePath） */
    skipped: number
    /** 全局失败原因（仅当一条都没成功时给出，如实告知而不是拿「N 条失败」糊弄） */
    reason?: string
    finishedAt: number
}

export interface MediaSyncProgress {
    running: boolean
    /** 当前阶段：list = 分页扫描远端列表；push = 逐条推送映射记录；backfill = 反向补齐远端记录；null = 没在跑 */
    stage: MediaSyncStage | null
    /** 当前阶段已完成数量 */
    done: number
    /** 当前阶段总数量（列表阶段取服务端 `pagination.total`；未知时 0） */
    total: number
    /** 上次同步没有正常收尾（扩展被重载/关闭），界面据此给出「已中断」而不是永远转圈 */
    interrupted?: boolean
    /** 上一轮的终态结论（页面据此渲染结果徽章）；缺省表示这一轮还没跑过 */
    result?: MediaTaskResult
    updatedAt: number
}

export const IDLE_MEDIA_SYNC_PROGRESS: MediaSyncProgress = {
    running: false,
    stage: null,
    done: 0,
    total: 0,
    updatedAt: 0
}

/**
 * 进度条取值：0~1 为确定态，`undefined` 为不确定态。
 *
 * 三处返回 `undefined` 都是**刻意**的：
 * - 没在跑：没有进度可言，写 0 会让「刚跑完」显示成 0%；
 * - 阶段未知：同上；
 * - 总量未知（服务端没给 `total`）：不能用 0 冒充分母，否则条永远停在 0%。
 */
export function mediaSyncRatio(progress: MediaSyncProgress | null | undefined): number | undefined {
    if (!progress || !progress.running || progress.stage === null || progress.total <= 0) return undefined
    const ratio = progress.done / progress.total
    if (!Number.isFinite(ratio)) return undefined
    return Math.min(1, Math.max(0, ratio))
}

const isFiniteCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * 解析持久层里的快照。脏值返回 `null`（调用方回落到空闲态）。
 *
 * 为什么不 `as MediaSyncProgress` 了事：这份数据来自 `storage.session`，
 * 上一代代码、手工调试、扩展被降级都可能留下形状不对的值；直接信任会让
 * 「`total` 是字符串」这类脏值一路走到 `done / total` 变成 NaN。
 */
export function parseMediaSyncProgress(raw: unknown): MediaSyncProgress | null {
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as Record<string, unknown>
    if (typeof record['running'] !== 'boolean') return null
    const stage = record['stage']
    const knownStage = stage === 'list' || stage === 'push' || stage === 'backfill' ? stage : null
    // running:true 却给了未知阶段 ⇒ 不可信；running:false 的快照允许 stage 为 null
    if (record['running'] && knownStage === null) return null
    const done = isFiniteCount(record['done']) ? Math.max(0, record['done']) : 0
    const total = isFiniteCount(record['total']) ? Math.max(0, record['total']) : 0
    const updatedAt = isFiniteCount(record['updatedAt']) ? record['updatedAt'] : 0
    const interrupted = record['interrupted'] === true ? true : undefined
    const result = parseMediaTaskResult(record['result'])
    return { running: record['running'], stage: knownStage, done, total, interrupted, result, updatedAt }
}

/**
 * 解析快照里的终态结论。脏值返回 undefined（当成「没有结论」而不是渲染半截）：
 * 上一代或手工调试留下的 {kind:'sync', ok:'12'} 会让徽章显示成 NaN。
 */
export function parseMediaTaskResult(raw: unknown): MediaTaskResult | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const record = raw as Record<string, unknown>
    const kind = record['kind']
    if (kind !== 'sync' && kind !== 'backfill') return undefined
    const count = (value: unknown): number => (isFiniteCount(value) ? Math.max(0, value) : 0)
    const reason = typeof record['reason'] === 'string' && record['reason'] !== '' ? record['reason'] : undefined
    return { kind, total: count(record['total']), ok: count(record['ok']), failed: count(record['failed']), skipped: count(record['skipped']), reason, finishedAt: count(record['finishedAt']) }
}

/**
 * 残骸归一：快照说「在跑」但内存里没有任务 ⇒ 上一次同步是被中途打断的。
 *
 * 返回**需要写回的修正记录**，或 `null` 表示无需修改。与
 * `shared/approvalProgress` 的同名函数同一套理由：靠**不变量**判定，
 * 不靠心跳超时（阶段一可能几十秒才更新一次，超时判定必然误杀）。
 */
export function settleInterrupted(record: MediaSyncProgress | null, taskAlive: boolean): MediaSyncProgress | null {
    if (!record || !record.running || taskAlive) return null
    return { running: false, stage: null, done: 0, total: 0, interrupted: true, updatedAt: record.updatedAt }
}

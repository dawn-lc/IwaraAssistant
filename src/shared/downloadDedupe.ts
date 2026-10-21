/**
 * 批量下载去重 —— 决定「用户勾选的这批 ID 里，哪些其实不该再投递」。
 *
 * 两类重复，判定依据不同：
 *
 * 1. **本地队列**（`storage.local.downloadQueue`）：我们自己下过的、正在下的。
 *    这是我们比源项目多出来的一层——源项目没有持久队列，只能问 aria2；
 *    而 aria2 的 `tellStopped` 只保留最近一批记录（默认 1000 条），库大了必然漏。
 *
 * 2. **aria2 本身**：队列里没有、但 aria2 里有（外部直加的任务、清过队列之后的老任务）。
 *    判定沿用源 `downloadTaskUnique`：从下载 URL 的 `videoid` 参数或文件名的 `[ID]` 反查。
 *
 * 为什么把规则抽成纯函数：这两条判据都是「跳过还是重下」的产品决策，
 * 写错会静默吞掉用户的下载意图（漏下比重复下更糟），必须能被单测逐条钉住。
 */
import type { QueueTask } from './task'

/** 本地队列的去重结果 */
export interface QueueDedupeResult {
    /** 需要投递的 ID（保持入参顺序） */
    ids: string[]
    /** 被本地队列挡下的 ID */
    skipped: string[]
}

/**
 * 按本地队列去重。
 *
 * **以每个 videoId 的最新一条记录为准**，而不是「历史上出现过就跳过」：
 * 同一个视频可能失败过、后来重试成功（`failed` → `complete`），拿旧记录判定会误跳过。
 *
 * `failed` **不**跳过：用户重新勾选一个失败过的视频，通常正是想再试一次；
 * 真正的「我不想再要它了」是把它从队列里移除，而不是靠这里的隐式规则。
 *
 * `skipped` 同样**不**跳过——它表示「上次因为简介里有第三方网盘链接而没下」，
 * 不是「已经下过了」。把它当已完成会静默吞掉用户的下载意图：
 * 用户在列表页重新勾选它、什么都没发生，也无任何提示。
 *
 * `handed-off` 同理**不**跳过：我们只是把活交出（开标签页 / POST 给 iwaradl），
 * 结果只有对方知道；拦下来等于替外部下载器宣布成功。
 */
export function dedupeAgainstQueue(requested: string[], tasks: readonly QueueTask[]): QueueDedupeResult {
    const latest = latestTaskByVideo(tasks)
    const ids: string[] = []
    const skipped: string[] = []
    for (const id of requested) {
        const task = latest.get(id)
        // 只拦「确实下过了 / 正在下」：正向穷尽判定，新增状态时编译期会强制表态
        if (task && blocksRedownload(task.status)) skipped.push(id)
        else ids.push(id)
    }
    return { ids, skipped }
}

/**
 * 同一 videoId 的**最新**一条队列记录（按 `updatedAt ?? createdAt`）。
 *
 * 单条下载与批量下载必须共用这一份语义：两处各写一遍，迟早会在
 * 「failed 之后重试成功」「没有任何时间戳的旧记录」这类边界上分叉。
 */
function latestTaskByVideo(tasks: readonly QueueTask[]): Map<string, QueueTask> {
    const latest = new Map<string, QueueTask>()
    for (const task of tasks) {
        const previous = latest.get(task.videoId)
        // 没有时间戳的旧记录按「更早」处理，不会盖掉带时间戳的新记录
        if (!previous || (task.updatedAt ?? task.createdAt ?? 0) >= (previous.updatedAt ?? previous.createdAt ?? 0)) latest.set(task.videoId, task)
    }
    return latest
}

/**
 * 单条下载用的去重判据：队列里是否已有「下过 / 正在下」的记录。
 *
 * 批量下载有 `dedupeAgainstQueue`，但**单条入口（页内「下载此视频」、右键菜单、
 * `DOWNLOAD`）此前完全不去重**——只有一层进程内并发闸门（`pushingVideoIds`），
 * 拦不住「投递完成后再点一次」。同一个视频点两次就在 aria2 里堆两份。
 *
 * 返回那条记录（而不是 boolean）是为了让调用方直接把它当作本次结果返回：
 * 语义是「已经在队列里了，就是这一条」，用户不会看到一个新建的空任务。
 */
export function blockingTaskFor(videoId: string, tasks: readonly QueueTask[]): QueueTask | undefined {
    const task = latestTaskByVideo(tasks).get(videoId)
    return task && blocksRedownload(task.status) ? task : undefined
}

/**
 * 可以**复用**的失败记录：同一个视频失败过、用户现在又要下载。
 *
 * `failed` 不阻止重下（见 `dedupeAgainstQueue` 的说明），但「允许重下」不等于
 * 「必须新建一条记录」。不复用就会每点一次批量/单条下载都多一行失败任务，
 * 任务列表里同一个 videoId 越堆越多——这不是去重没生效，而是去重只放行了、
 * 没有把这次投递落到原来那条记录上。
 *
 * 只认 `failed`：`complete` / `running` / `queued` 由 `blockingTaskFor` 拦住，
 * `skipped` / `handed-off` 是另一种语义（没下 / 已交付），不能拿来当下载记录改。
 */
export function reusableFailedTaskFor(videoId: string, tasks: readonly QueueTask[]): QueueTask | undefined {
    const task = latestTaskByVideo(tasks).get(videoId)
    return task?.status === 'failed' ? task : undefined
}

/**
 * 该状态是否意味着「文件已经到手或正在拿」，因而不该再投递。
 *
 * 写成**正向穷尽 switch** 而不是黑名单（`!== 'failed' && !== 'skipped'`）：
 * 黑名单会把将来新增的状态默认归入「已下载」，那正是 `skipped` 曾经踩过的坑——
 * 用户重新勾选、什么都没发生、也没有任何提示。
 */
function blocksRedownload(status: QueueTask['status']): boolean {
    switch (status) {
        case 'running':
        case 'queued':
        case 'complete':
            return true
        case 'failed':
        case 'skipped':
        case 'handed-off':
            return false
    }
}

/** aria2 侧的去重结果（与本地队列同形，便于合并上报） */
export type Aria2DedupeResult = QueueDedupeResult

/**
 * 按 aria2 中已存在的任务去重。
 *
 * `existing` 由调用方从 `tellActive` + `tellStopped` 提取（`extractVideoIdFromTask`），
 * 并且已经排除了 `error` / `removed` 的任务——那两个状态说明上次没成，应该允许重下。
 */
export function dedupeAgainstAria2(requested: string[], existing: ReadonlySet<string>): Aria2DedupeResult {
    const ids: string[] = []
    const skipped: string[] = []
    for (const id of requested) {
        if (existing.has(id)) skipped.push(id)
        else ids.push(id)
    }
    return { ids, skipped }
}

// ── 队列内去重：同一视频多条「活跃」记录 ────────────────────────────────
//
// 上面两条管的是「要不要投递」；这一条管的是「队列里已经有的重复记录」。
//
// 源项目的追踪队列是按 videoId 做键的字典（`aria2TrackQueue.set(videoId, …)`），
// 所以它在结构上**不可能**出现同一视频两条活跃记录。本扩展用数组 + 每次投递新建
// 一条记录，历史上（去重修好之前）就会攒下重复；`FORCE_DOWNLOAD` 也会刻意再建一条。
//
// 两条活跃记录是真正的自相矛盾：界面上同一个视频显示两行「下载中」，
// 浏览器通道还会按记录数占并发槽位（同一文件被并行下载两次）。

/** 队列内同视频活跃记录的收敛结果 */
export interface QueueLiveDedupeResult {
    /** 每个有重复的 videoId 保留谁 */
    keep: QueueTask[]
    /** 应当丢弃的重复记录 */
    drop: QueueTask[]
    /**
     * 保留者缺失、但从被丢弃者那里继承来的 `kindRef`。
     *
     * 例：一条 `queued`（投递中、还没拿到 gid）与一条 `running`（已有 gid）撞车时，
     * 若按时间戳留了 `queued` 那条，就必须把 gid 接过来——否则追踪器再也认不出它。
     */
    inheritKindRef: Array<{ taskId: string; kindRef: string }>
}

/** 这两条记录是否属于同一份「正在进行的活」——只有它们之间才需要收敛 */
function isLiveStatus(status: QueueTask['status']): boolean {
    return status === 'running' || status === 'queued'
}

/**
 * 找出队列里同一 videoId 的多条活跃记录，决定保留哪条。
 *
 * 保留优先级：
 * 1. `kindRef` 命中 `liveGids`（调用方从 aria2 `tellActive` 取）——那条才是真正在下的；
 * 2. 有 `kindRef` 的（已绑定后端对象，追踪器认得出）；
 * 3. 更新时间更新的；
 * 4. 列表里靠前的（稳定，避免同一份数据每次算出不同结果）。
 *
 * **只动 `running` / `queued`**：`complete` 是历史、`failed` 要复用、`skipped` 是待办、
 * `handed-off` 是已交付——它们之间并存是合法的（例如一条历史完成记录 + 一条新待办）。
 */
export function planQueueLiveDuplicates(tasks: readonly QueueTask[], liveGids?: ReadonlySet<string>): QueueLiveDedupeResult {
    const groups = new Map<string, QueueTask[]>()
    for (const task of tasks) {
        if (!isLiveStatus(task.status)) continue
        const group = groups.get(task.videoId) ?? []
        group.push(task)
        groups.set(task.videoId, group)
    }

    const result: QueueLiveDedupeResult = { keep: [], drop: [], inheritKindRef: [] }
    for (const group of groups.values()) {
        if (group.length <= 1) continue
        const ranked = [...group].sort((a, b) => {
            const aLive = a.kindRef !== undefined && liveGids?.has(a.kindRef) === true
            const bLive = b.kindRef !== undefined && liveGids?.has(b.kindRef) === true
            if (aLive !== bLive) return aLive ? -1 : 1
            const aHas = a.kindRef !== undefined && a.kindRef !== ''
            const bHas = b.kindRef !== undefined && b.kindRef !== ''
            if (aHas !== bHas) return aHas ? -1 : 1
            return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)
        })
        const keeper = ranked[0]!
        result.keep.push(keeper)
        for (const extra of ranked.slice(1)) {
            result.drop.push(extra)
            if ((keeper.kindRef === undefined || keeper.kindRef === '') && extra.kindRef !== undefined && extra.kindRef !== '') {
                result.inheritKindRef.push({ taskId: keeper.id, kindRef: extra.kindRef })
            }
        }
    }
    return result
}

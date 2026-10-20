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
    const latest = new Map<string, QueueTask>()
    for (const task of tasks) {
        const previous = latest.get(task.videoId)
        if (!previous) {
            latest.set(task.videoId, task)
            continue
        }
        // 没有时间戳的旧记录按「更早」处理，不会盖掉带时间戳的新记录
        if ((task.updatedAt ?? task.createdAt ?? 0) >= (previous.updatedAt ?? previous.createdAt ?? 0)) latest.set(task.videoId, task)
    }

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

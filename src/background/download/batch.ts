/**
 * 批量下载 —— 互斥、去重、逐项投递。
 *
 * 从 `index.ts` 拆出来的理由：`index.ts` 是**装配层**（注册监听 + 路由消息），
 * 而批量下载是一段有状态的业务流程（互斥标志 + 循环 + 节流 + 汇总通知），
 * 混在路由表里会让「这条消息到底做了什么」被淹没在 200 行 switch 里。
 */
import type { Push } from '../../messaging/protocol'
import { dedupeAgainstAria2, dedupeAgainstQueue } from '../../shared/downloadDedupe'
import { i18n } from '../../shared/i18n'
import type { PageType } from '../../shared/pageType'
import { stringify } from '../../shared/strings'
import { aria2API, extractVideoIdFromTask, type Aria2Status } from '../backends/aria2/client'
import { getConfig } from '../storage/configStore'
import { runDownload } from './dispatch'
import { notifyInfo, notifyWarn } from '../runtime/notify'
import { getTasks } from '../storage/queue'

/**
 * 批量下载进行中标志（对齐源 `analyzeDownloadTaskRunning` + `ANALYZE_DOWNLOAD_LOCK`）。
 *
 * **这是重复任务的另一半根因**：`onMessage` 的 handler 是并发执行的（hub 对每条消息
 * 独立 `handler(req, sender)`），没有任何串行化。用户连点两次「下载所选」就会有
 * 两个 `BATCH_DOWNLOAD` 同时跑，而每个循环内部各自有 3000ms 节流——
 * 于是两批在同一时刻都还没 `addTask`，队列去重查不到，各自把同一批 ID 投递一次。
 *
 * 源项目靠 `analyzeDownloadTaskRunning`（单页）+ `GMLock`（跨页）挡住；
 * 本扩展只需进程内标志：后台是单实例，**进程内互斥即跨页互斥**。
 */
let batchDownloadRunning = false

/** aria2 中已存在的 videoId 集合（活跃 + 已完成；`error` / `removed` 不算，允许重下）。 */
async function existingAria2VideoIds(): Promise<Set<string>> {
    const active = await aria2API<Aria2Status[]>('aria2.tellActive', [['gid', 'status', 'files', 'bittorrent']])
    const stopped = await aria2API<Aria2Status[]>('aria2.tellStopped', [0, 4096, ['gid', 'status', 'files', 'bittorrent']])
    const existing = new Set<string>()
    for (const task of [...(active.result ?? []), ...(stopped.result ?? [])]) {
        // 对齐源 `filter(task => isNullOrUndefined(task.bittorrent))`：BT 任务的文件名与
        // 下载链接形如 `[ID].mp4` 的可能性与本项目无关，混进来会误判成同一个视频
        if (task.bittorrent !== undefined && task.bittorrent !== null) continue
        if (task.status === 'error' || task.status === 'removed') continue
        const videoId = extractVideoIdFromTask(task)
        if (videoId) existing.add(videoId)
    }
    return existing
}

/**
 * 把「已处理完」的视频 ID 通知回**发起批量下载的那个标签页**，页面据此取消勾选。
 *
 * 对齐源项目 `analyzeDownloadTask` 循环里的 `taskList.delete(id)`：活引用逐项写透，
 * 所以勾选是随处理进度一个个消失的，而不是等整批跑完才一起清。
 * 只发给发起页——选择集本身跨标签页共享（`storage.local.pageSelection`），
 * 其它标签页由 storage.onChanged 联动，避免每个标签页都写一次导致计数竞态。
 */
function notifySelectionSettled(tabId: number | undefined, videoIds: string[]): void {
    if (tabId === undefined || videoIds.length === 0) return
    void browser.tabs.sendMessage(tabId, { type: 'DOWNLOAD_TASK_SETTLED', payload: { videoIds } } satisfies Push).catch(() => {
        // 页面已关闭 / 已导航：勾选状态留在 storage 里，下次进页面仍会显示，属预期
    })
}

export interface BatchDownloadResult {
    total: number
    failed: number
    skipped: number
    skippedByLink: number
    results: Array<{ videoId: string; taskId: string; status: string }>
}

/**
 * `BATCH_DOWNLOAD` 的入口：拿互斥标志 → 跑 → 放锁。
 *
 * 抢不到锁时**必须抛错并给用户通知**：页面侧只 `catch` 后 `console.warn`，
 * 不报错就是「点了没反应」（源项目此处是 `taskConflict()`：弹一条 3s 提示后 return）。
 */
export async function startBatchDownload(rawIds: unknown[], tabId: number | undefined, pageType?: PageType): Promise<BatchDownloadResult> {
    if (batchDownloadRunning) {
        const message = i18n.t('notify.batchAlreadyRunning')
        notifyWarn('batch-conflict', message, { kind: 'options', tab: 'tasks' })
        throw new Error(message)
    }
    batchDownloadRunning = true
    try {
        return await runBatchDownload(rawIds, tabId, pageType)
    } finally {
        batchDownloadRunning = false
    }
}

/**
 * 批量下载主体：两层去重 + 逐项投递。去重判据本身是纯函数（`shared/downloadDedupe.ts`，可单测）。
 */
async function runBatchDownload(rawIds: unknown[], tabId: number | undefined, pageType?: PageType): Promise<BatchDownloadResult> {
    const requested = [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))]
    const config = getConfig()

    // ① 本地队列去重（零成本、必然可用）：重新勾选已下载/正在下载的视频时，
    //    不该在 aria2 里再堆一份。规则见 shared/downloadDedupe.ts（以最新一条记录为准，failed 允许重下）
    const byQueue = dedupeAgainstQueue(requested, getTasks())

    // ② aria2 去重：覆盖「队列里没有、aria2 里有」的外部任务与清过队列的老任务。
    //    去重分析失败时**要让用户知道**（源项目弹 duplicateTaskAnalysisError）：
    //    静默降级等于「这次没去重」却看起来一切正常，重复任务会被归咎于扩展。
    let ids = byQueue.ids
    let skippedAria2: string[] = []
    if (config.downloadType === 0) {
        try {
            const byAria2 = dedupeAgainstAria2(ids, await existingAria2VideoIds())
            ids = byAria2.ids
            skippedAria2 = byAria2.skipped
        } catch (error) {
            console.warn('[iwara-assistant] aria2 去重分析失败（本次按未去重处理）:', error)
            notifyWarn('dedupe-failed', i18n.t('notify.duplicateAnalysisFailed', { detail: stringify(error) }), { kind: 'options', tab: 'rpc' })
        }
    }

    const skippedIds = [...byQueue.skipped, ...skippedAria2]
    const skipped = skippedIds.length
    // 逐项间隔 3 秒（源 `analyzeDownloadTask` 的 `!config.enableUnsafeMode && await delay(3000)`）。
    // 这个 3 秒不是拍脑袋：每个视频要打 1 次详情 + 1 次文件源 + N 次评论分页，
    // 连成一串很容易触发站点限流；实测调小到 1 秒时批量 20 个就会出现 429。
    const throttleMs = config.enableUnsafeMode ? 0 : 3000
    // 去重命中的（队列里已下过 / aria2 里已在跑）同样要取消勾选：源项目 downloadTaskUnique
    // 也是直接 `taskList.delete(key)`，否则这批会永远停在"已选中"状态。
    notifySelectionSettled(tabId, skippedIds)

    const results: BatchDownloadResult['results'] = []
    /** 命中第三方网盘链接而刻意不下载的个数（`checkDownloadLink` 的源设计） */
    let skippedByLink = 0
    /** 投递时才发现已被别的路径下载过（`runDownload` 的第二道队列去重） */
    let skippedLate = 0
    /**
     * 本轮开始时间：用来区分「新任务」与「`runDownload` 返回的既有任务」。
     * 队列里的任务一定有更早的 `createdAt`，本轮新建的则不会早于这个时刻。
     */
    const batchStartedAt = Date.now()
    for (const [index, videoId] of ids.entries()) {
        try {
            const task = await runDownload({ videoId, pageType })
            // 命中去重（另一条路径刚把它下了）→ 不改写统计口径：
            // 否则界面会声称「新建了 N 个任务」，而 aria2 里其实一个都没多。
            if (task.createdAt !== undefined && task.createdAt < batchStartedAt) {
                skippedLate++
            } else if (task.status === 'skipped') {
                // 命中第三方网盘链接时返回的是一条 `skipped` **任务**（而不是「没投递」）：
                // 它已经进队列了，用户在任务列表里能看到并处理，所以不计入「新建下载任务」。
                skippedByLink++
            } else {
                results.push({ videoId, taskId: task.id, status: task.status })
            }
        } catch (error) {
            // 单条投递抛错（DB 写入失败、路径模板非法…）不能中断整批：
            // 后面还在等的视频同样有下载权利，而源项目的循环也不会因单条异常停下。
            // 记为 failed 而不是静默丢掉，汇总文案里能看出有几条出了问题。
            console.warn(`[iwara-assistant] 批量投递 ${videoId} 失败:`, error)
            results.push({ videoId, taskId: '', status: 'failed' })
        }
        // 逐个通知（不是整批结束才发）：任务创建成功即取消该项勾选，
        // 失败项也取消——与源项目一致（失败原因在队列/通知里可见，
        // 页面勾选不承担"待重试"语义）。命中网盘链接同样取消：源那边 `taskList.delete(id)`
        // 在 `pushDownloadTask` 返回之后无条件执行。
        notifySelectionSettled(tabId, [videoId])
        if (throttleMs > 0 && index < ids.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, throttleMs))
        }
    }

    const failed = results.filter((item) => item.status === 'failed').length
    // 汇总文案要如实区分三件事：真投递了几个、去重跳过了几个、因网盘链接刻意没下几个。
    // 把后两者混进「已投递」会让用户以为 aria2 里有他没见过的任务。
    // 「投递时才发现已下载」与「提前去重跳过」对用户是同一件事，合并计数。
    const skippedTotal = skipped + skippedLate
    let summary: string
    if (results.length === 0 && skippedByLink === 0 && skippedTotal > 0) {
        // 全被跳过时说「共 0 个」等于什么都没说，用户会以为批量失败了
        summary = i18n.t('notify.batchAllSkipped', { n: skippedTotal })
    } else if (results.length === 0 && skippedTotal === 0 && skippedByLink > 0) {
        summary = i18n.t('notify.batchAllSkippedLink', { n: skippedByLink })
    } else {
        summary = i18n.t('notify.batchQueued', { total: results.length, failed }) + (skippedTotal > 0 ? i18n.t('notify.batchQueuedSkipped', { n: skippedTotal }) : '') + (skippedByLink > 0 ? i18n.t('notify.batchSkippedLink', { n: skippedByLink }) : '')
    }
    notifyInfo('batch-queued', summary, { kind: 'options', tab: 'tasks' })
    return { total: results.length, failed, skipped: skippedTotal, skippedByLink, results }
}

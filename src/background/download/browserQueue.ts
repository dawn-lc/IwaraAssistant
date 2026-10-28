/**
 * 浏览器内建下载的启动队列 —— 「同时下载数」的执行端（判据在 `shared/browserConcurrency.ts`）。
 *
 * ## 为什么不是「等一个槽位再返回」
 *
 * 最直觉的写法是在 `browserDownload` 前面 `await` 一个信号量。但那样**消息处理器会被挂住**：
 * 批量下载第 4 个开始就要等前 3 个下完（可能是几十分钟），`BATCH_DOWNLOAD` 的响应、
 * 页面上的「批量下载中」、以及批次汇总通知全部跟着卡死。而 Chrome 对单个事件处理器还有
 * 5 分钟上限。
 *
 * 所以这里用**排队 + 泵**：槽位满了就把任务落成 `queued` 立刻返回，谁下完了谁把队列往前推。
 * 副作用是 UI 更诚实——用户看到的是「3 个下载中 + 17 个排队中」，而不是「批量下载中」转圈。
 *
 * ## 为什么用持久化队列当真相，而不是内存计数
 *
 * 「还有几个在传」只存在于浏览器里，我们唯一的证据是队列：`browser` + `running`
 * （`downloads.onChanged` 会把它收敛到终态）。内存计数会在 SW 被回收后归零，
 * 那正好是并发最容易失控的时刻。内存里只放**已解析但还没启动**的视频快照（省一次解析），
 * 丢了就重新解析（`pumpBrowserQueue` 的兜底分支），不会丢任务。
 */
import { nextQueuedBrowserTask, slotAvailable } from '../../shared/browserConcurrency'
import { i18n } from '../../shared/i18n'
import { stringify } from '../../shared/strings'
import type { FollowUpKind, QueueTask } from '../../shared/task'
import type { FullVideoInfo } from '../../shared/videoInfo'
import { VideoParseError, parseVideoFull } from '../iwara/videoApi'
import { getConfig } from '../storage/configStore'
import { getTasks, notifyTask, syncTask } from '../storage/queue'
import { browserDownload, browserDownloadErrorParse, downloadMetadata, type ChannelContext } from './downloaders'
import { describeParseFailure } from './parseFailure'

interface PendingStart {
    video: FullVideoInfo
    ctx: ChannelContext
}

/** 已解析、尚未启动的任务快照（SW 回收即丢，丢了下一次泵会重新解析） */
const pending = new Map<string, PendingStart>()

/** 泵正在跑（重入会让同一批排队任务被启动两次） */
let pumping = false

/** 队列里正在传的浏览器下载数（`others` 被接管后会变成 browser/running，同样占槽） */
export function activeBrowserDownloads(): number {
    return getTasks().filter((task) => task.kind === 'browser' && task.status === 'running').length
}

/**
 * 除自己以外还有空槽吗。
 *
 * **必须排除自己**：调用点在任务已经以 `running` 入队之后（`executeChannels`），
 * 不排除的话「限 1」时连第一个都启动不了。
 */
export function hasFreeBrowserSlot(selfId: string): boolean {
    const others = getTasks().filter((task) => task.kind === 'browser' && task.status === 'running' && task.id !== selfId).length
    return slotAvailable(others, 0, getConfig().browserConcurrentDownloads)
}

/** 把已解析好的任务排进启动队列（调用方负责先把任务写成 `queued`） */
export function deferBrowserStart(task: QueueTask, video: FullVideoInfo, ctx: ChannelContext): void {
    pending.set(task.id, { video, ctx })
    void pumpBrowserQueue()
}

/**
 * 丢弃某个任务的待启动快照（任务被移除时调用）。
 *
 * 不丢也不会错（泵只从队列里挑任务），但会留住一份视频快照（可能含几 MB 简介）
 * 直到 SW 被回收——属于「看不见的内存泄漏」，顺手清掉。
 */
export function forgetBrowserStart(taskId: string): void {
    pending.delete(taskId)
}

/**
 * 有空槽就按入队顺序启动排队中的浏览器任务。
 *
 * 幂等、可随时调用：`downloads.onChanged`（有任务结束）、移除任务、启动排队、`boot()`
 * 都走这里。没有可启动项时立刻返回。
 */
export async function pumpBrowserQueue(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
        for (;;) {
            const limit = getConfig().browserConcurrentDownloads
            if (!slotAvailable(activeBrowserDownloads(), 0, limit)) return
            const next = nextQueuedBrowserTask(getTasks())
            if (!next) return
            // 先把状态改成 running 再离开同步区：下一次循环的 activeBrowserDownloads()
            // 立刻能把它算进去，不会在同一 tick 里超额启动
            next.status = 'running'
            next.detail = undefined
            void syncTask(next)
            void launch(next)
        }
    } finally {
        pumping = false
    }
}

async function launch(task: QueueTask): Promise<void> {
    try {
        await startBrowserTask(task)
    } finally {
        // 成功（占着槽）或失败（槽位已让出）都要再推一次：可能还有排队的在等
        void pumpBrowserQueue()
    }
}

async function startBrowserTask(task: QueueTask): Promise<void> {
    const entry = pending.get(task.id)
    pending.delete(task.id)

    let video: FullVideoInfo
    if (entry) {
        video = entry.video
    } else {
        // 没有内存快照 = 上一代进程排的队（SW 回收 / 浏览器重启）。重新解析，
        // 代价是一次详情 + 一次文件源请求；跳过它则任务会永远停在「排队中」。
        try {
            video = await parseVideoFull(task.videoId)
        } catch (error) {
            const failInfo = error instanceof VideoParseError ? error.videoInfo : undefined
            const failure = await describeParseFailure(task.videoId, failInfo?.Msg ?? stringify(error), failInfo === undefined ? undefined : { username: failInfo.Author, alias: failInfo.Alias })
            await failTask(task, i18n.t('error.retryParseFailed', { message: failure.reason }), failure)
            return
        }
    }

    try {
        const ref = await browserDownload(video, entry?.ctx ?? { overwrite: true })
        task.kindRef = String(ref.downloadId)
        if (getConfig().autoDownloadMetadata) {
            await downloadMetadata(video).catch((error: unknown) => {
                console.warn('[iwara-assistant] metadata download failed:', error)
            })
        }
        await syncTask(task)
    } catch (error) {
        // 与 dispatch 的 browser 分支同一套文案：浏览器原文对用户不可读
        await failTask(task, browserDownloadErrorParse(error))
    }
}

async function failTask(task: QueueTask, detail: string, followUp?: { followUpUrl?: string; followUpKind?: FollowUpKind }): Promise<void> {
    task.status = 'failed'
    task.detail = detail
    if (followUp?.followUpUrl !== undefined) {
        task.followUpUrl = followUp.followUpUrl
        task.followUpKind = followUp.followUpKind
    }
    await syncTask(task)
    await notifyTask(task)
}

/**
 * 取消下载器里仍在跑的任务 —— 「移除」之前必须先做这一步。
 *
 * 顺序不能反：先删记录再取消，中间那一瞬 task 已经不在队列里，
 * 取消失败的记录就彻底丢了（用户以为删掉了，实际还在偷偷下）。
 *
 * 失败策略：**能取消却没取消成功时抛错** → 调用方保留记录 →
 * 用户至少还能看见它在跑（宁可不删，也不要留一个无人看管的下载）。
 *
 * 返回两种结果，调用方据此决定文案：
 * - `cancelled`：下载器确实停了（或本来就已经不在里面）
 * - `unsupported`：这个通道没有取消能力（iwaradl 只允许删 pending / others 只是开了个标签页）。
 *   记录仍可移除，但必须如实告诉用户「那边还在下」。
 */
import { i18n } from '../../shared/i18n'
import { cancelStrategyOf, type QueueTask } from '../../shared/task'
import { aria2API, aria2TellStatus, isAria2Configured } from '../backends/aria2/client'
import { iwaradlDeleteTask, isIwaradlConfigured } from '../backends/iwaradl/client'

export type CancelOutcome = 'cancelled' | 'unsupported'

/** 取消该任务对应的下载器动作 */
export async function cancelTaskDownload(task: QueueTask): Promise<CancelOutcome> {
    const strategy = cancelStrategyOf(task, { aria2Configured: isAria2Configured(), iwaradlConfigured: isIwaradlConfigured() })
    switch (strategy) {
        case 'browser-cancel':
            await cancelBrowserDownload(task.kindRef!)
            return 'cancelled'
        case 'aria2-remove':
            await removeAria2Task(task.kindRef!)
            return 'cancelled'
        case 'iwaradl-delete':
            return cancelIwaradlTask(task.kindRef!)
        case 'none':
            return 'unsupported'
    }
}

/**
 * 取消浏览器下载并**复核**。
 *
 * `downloads.cancel` 在下载已经结束时 reject（"Invalid download ID"），那种情况
 * 说明没有东西在跑，删记录安全，所以吞掉。
 * 但如果是「取消被忽略、文件还在写」，就必须让调用方知道——判据是重新查一次状态，
 * 而不是相信 cancel 的返回值（不同浏览器在这里的行为并不一致）。
 */
async function cancelBrowserDownload(kindRef: string): Promise<void> {
    const downloadId = Number(kindRef)
    await browser.downloads.cancel(downloadId).catch(() => undefined)
    const [item] = await browser.downloads.search({ id: downloadId })
    if (item?.state === 'in_progress') throw new Error(i18n.t('tasks.cancelStillRunning'))
}

/**
 * 从 aria2 移除任务并清掉结果记录。
 *
 * `removeDownloadResult` 必须调用：只 `remove` 的话任务会留在 stopped 区（状态 `removed`），
 * 5 分钟后的扫描仍能看见它，于是当成外部任务重新收编 —— 用户看到「删了又回来」。
 * 两个调用都容错（任务可能已完成/已被删除），真正的判据是最后那次 `tellStatus`。
 */
async function removeAria2Task(gid: string): Promise<void> {
    await aria2API('aria2.remove', [gid]).catch(() => undefined)
    await aria2API('aria2.removeDownloadResult', [gid]).catch(() => undefined)
    const status = await aria2TellStatus(gid).catch(() => undefined)
    if (status && (status.status === 'active' || status.status === 'waiting' || status.status === 'paused')) {
        throw new Error(i18n.t('tasks.cancelStillRunning'))
    }
}

/**
 * 删掉 iwaradl 里那条任务。
 *
 * 它的 API 只允许删除 `pending`：正在下的时候返回 **409**。
 * 这是 iwaradl 的能力边界（它没提供取消运行中任务的接口），不是我们没实现，
 * 所以如实返回 `unsupported`，由 UI 说清楚「记录已移除，但 iwaradl 还在下」。
 */
async function cancelIwaradlTask(vid: string): Promise<CancelOutcome> {
    const result = await iwaradlDeleteTask(vid)
    // deleted = 确实删了；missing = 本来就不在了（已经下完/被删）→ 两种都不再有东西在跑
    return result === 'notPending' ? 'unsupported' : 'cancelled'
}

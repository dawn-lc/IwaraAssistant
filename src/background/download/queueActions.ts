/**
 * 队列操作 —— 用户在任务页面对任务做的四件事：重试失败 / 移除 / 清理已结束 / 刷新状态。
 *
 * 从 `index.ts` 的消息 switch 里搬出来：那里原本有 `RETRY_TASK`（8 行判据）、
 * `REMOVE_TASK`（12 行「先取消再删」）、`RETRY_FAILED`、`SYNC_DOWNLOAD_TASKS` 四段内联实现，
 * 让「消息路由」同时承担了业务规则。
 *
 * ## 三条不变量（改动时别破坏）
 *
 * 1. **`skipped` 不能重试**：重试会重新解析并再过一次 `checkDownloadLink`，
 *    命中后又是 `skipped` —— 用户看到的是「点了没反应」的死循环。
 *    想下必须显式走 `FORCE_DOWNLOAD`（任务列表里那颗「强制下载」）。
 * 2. **移除 = 先取消下载器，再删记录**：只抹记录会留下一个无人看管的下载
 *    （browser 通道再也不会回传终态；aria2 通道 5 分钟后又被扫描当「外部任务」收编）。
 * 3. **能取消却没成功时抛错并保留记录**：宁可不删，也不要留个偷偷在下的。
 */
import { i18n } from '../../shared/i18n'
import { cancelStrategyOf } from '../../shared/task'
import { syncIwaradlAlarm } from '../backends/iwaradl/client'
import { syncAria2ProbeAlarm } from '../backends/aria2/tracker'
import { syncIwaradlTasks } from '../backends/iwaradl/tracker'
import { scanAria2TasksAndEnqueue } from '../backends/aria2/tracker'
import { isAria2Configured } from '../backends/aria2/client'
import { isIwaradlConfigured } from '../backends/iwaradl/client'
import { cancelTaskDownload } from './cancel'
import { retryTask } from './dispatch'
import { forgetBrowserStart, pumpBrowserQueue } from './browserQueue'
import { clearFinished, findTask, getTasks, removeTask } from '../storage/queue'
import { notifyInfo } from '../runtime/notify'

/** 单条重试（`RETRY_TASK`） */
export async function retryTaskById(taskId: string): Promise<unknown> {
    const task = findTask({ id: taskId })
    if (!task) throw new Error(i18n.t('notify.taskNotFound'))
    if (task.status === 'running') throw new Error(i18n.t('notify.taskRunningRetry'))
    if (task.status === 'skipped') throw new Error(i18n.t('notify.taskSkippedRetry'))
    // 手动重试是用户的明确意图：清零自动重试计数，不让上限拦住
    task.attempts = 0
    return retryTask(task)
}

/** 单条移除（`REMOVE_TASK`），必要时先取消下载器 */
export async function removeTaskById(taskId: string): Promise<{ removed: boolean; cancelled?: boolean; untracked?: boolean }> {
    const task = findTask({ id: taskId })
    if (!task) return { removed: false }

    /**
     * 需要先停下载器的情况。
     *
     * `running` 显然要停。**`queued` 也要**——而且这一条是读了后端真实状态之后才成立的：
     * aria2 的 `waiting` 与 iwaradl 的 `pending` 现在如实映射成 `queued`，
     * 它们确实已经在后端排队了。只删记录不取消，5 分钟后扫描会把 aria2 那条
     * 当外部任务重新收编（用户看到「删了又回来」）。
     *
     * 但 `queued` 里还有一种情况：**浏览器通道在等我们自己的并发槽位**——
     * 它连 `kindRef` 都没有，后端什么都没开始。把它也送进取消流程会得到
     * `unsupported`，界面就该说「它可能仍在下载」——那是纯粹假话。
     * 所以用 `cancelStrategyOf` 判「到底有没有东西可停」。
     */
    const cancellable = cancelStrategyOf(task, { aria2Configured: isAria2Configured(), iwaradlConfigured: isIwaradlConfigured() }) !== 'none'
    const mustStopFirst = task.status === 'running' || (task.status === 'queued' && cancellable)

    if (!mustStopFirst) {
        const removed = await removeTask(task.id)
        // 删掉一条排队任务后槽位可能有多余，统一推一次
        if (removed) {
            forgetBrowserStart(task.id)
            void pumpBrowserQueue()
        }
        return { removed }
    }

    const outcome = await cancelTaskDownload(task)
    // `unsupported` = 这个通道没有取消能力（iwaradl 只允许删 pending，且此时它不是 pending）。
    // 记录照删，但文案要如实说「那边还在下」，不能报成「已取消」。
    const removed = await removeTask(task.id, { allowRunning: true })
    // 下载器停下来了 = 可能腾出了槽位，排队中的任务可以开始了
    if (removed) void pumpBrowserQueue()
    return { removed, cancelled: outcome === 'cancelled', untracked: outcome === 'unsupported' }
}

/** 清除所有已结束的任务（`CLEAR_FINISHED`） */
export async function clearFinishedTasks(): Promise<{ removed: number }> {
    return { removed: await clearFinished() }
}

/** 重试全部失败任务（`RETRY_FAILED`） */
export async function retryAllFailed(): Promise<{ retried: number }> {
    const failed = getTasks().filter((task) => task.status === 'failed')
    let retried = 0
    for (const task of failed) {
        task.attempts = 0
        await retryTask(task)
        retried++
    }
    if (retried > 0) notifyInfo('queue-retry', i18n.t('notify.queueRetry', { n: retried }), { kind: 'options', tab: 'tasks' })
    return { retried }
}

/**
 * 刷新状态（`SYNC_DOWNLOAD_TASKS`）—— 不等 alarm，把两个可追踪后端的终态同步回队列。
 *
 * 自动对账已由各自 alarm 驱动（`scan-aria2` 5 分钟 / `scan-iwaradl` 1 分钟），
 * 这是「用户点了任务页那颗『刷新状态』」：aria2 有 WS 推送兜底，iwaradl 只能拉，所以两个都跑一遍。
 * 返回两边的结果让 UI 如实展示（哪个后端动了、动了多少），而不是只说「已刷新」。
 */
export async function syncDownloadTasks(): Promise<{ aria2: unknown; iwaradl: unknown }> {
    const aria2 = await scanAria2TasksAndEnqueue()
    const iwaradl = await syncIwaradlTasks()
    // alarm 存在性跟着队列变化：对账后可能已经没有活跃任务了
    await syncIwaradlAlarm()
    await syncAria2ProbeAlarm()
    return { aria2, iwaradl }
}

/**
 * iwaradl 任务对账（轮询型追踪）。
 *
 * iwaradl 没有事件推送，只能拉。轮询本身有代价，所以两条约束：
 * 1. **只在有活跃任务时开 alarm**（`syncIwaradlAlarm` 在同目录 `client.ts`），空闲时零请求；
 * 2. 一次 `GET /api/tasks` 处理全部任务，不做 N 次单任务查询。
 *
 * 判据分层（错一层就会出现「明明还在下却标失败」或「早就死了还转圈」）：
 * - 拉不到列表 → **不改任何状态**，但连续失败 3 次后判定守护进程不可达、如实标失败
 * - 列表里没有该 vid → iwaradl 已经忘了它（删除/重启丢任务）→ 失败
 * - 列表里有 → 用它的状态覆盖（`pending`/`running` 继续保持活跃）
 */
import { i18n } from '../../../shared/i18n'
import type { QueueTask } from '../../../shared/task'
import { activeIwaradlTasks, isIwaradlConfigured, iwaradlListTasks, queueStatusOfIwaradl, type IwaradlTask } from './client'
import { notifyTask, patchTask } from '../../storage/queue'

/**
 * 连续拉取失败次数。只在内存里：SW 被回收后重新计数是可接受的——
 * 判据本来就是「本次进程里持续连不上」，而不是「历史上曾经连不上」。
 */
let consecutiveFailures = 0

/** 达到这个次数才判定守护进程不可达（单次网络抖动不该把任务判死） */
const UNREACHABLE_AFTER_FAILURES = 3

/**
 * 进度回写的阈值：变化小于 0.5% 不落盘。
 *
 * 与 aria2 那边同值同理由：每次 `patchTask` 都落盘 + 刷 `updatedAt` + 推进排序，
 * 1 分钟一轮的轮询里为 0.1% 的差异写一次盘不值。
 */
const PROGRESS_EPSILON = 0.005

export interface IwaradlSyncResult {
    /** 状态发生变化的条数 */
    updated: number
    /** 收敛到终态（完成/失败）的条数 */
    settled: number
}

/**
 * 拉一次任务列表并对账。
 *
 * 幂等：状态没变就不写盘（`patchTask` 会刷新 `updatedAt`，那会打乱任务列表的排序）。
 */
export async function syncIwaradlTasks(): Promise<IwaradlSyncResult> {
    const active = activeIwaradlTasks()
    if (active.length === 0) return { updated: 0, settled: 0 }
    if (!isIwaradlConfigured()) return { updated: 0, settled: 0 }

    let remote: IwaradlTask[]
    try {
        remote = await iwaradlListTasks()
        consecutiveFailures = 0
    } catch (error) {
        consecutiveFailures++
        console.warn(`[iwara-assistant] iwaradl 对账失败（第 ${consecutiveFailures} 次）：`, error instanceof Error ? error.message : error)
        if (consecutiveFailures < UNREACHABLE_AFTER_FAILURES) return { updated: 0, settled: 0 }
        // 连续失败：守护进程多半已经不在了。如实标失败，否则这些任务会永远「下载中」
        // 且按 running 的规则连移除都要先取消（而取消也连不上）。
        let settled = 0
        for (const task of active) {
            await patchTask(task.id, { status: 'failed', detail: i18n.t('tasks.iwaradlUnreachable') })
            settled++
        }
        return { updated: settled, settled }
    }

    const byVid = new Map(remote.map((task) => [task.vid, task]))
    let updated = 0
    let settled = 0
    for (const task of active) {
        const found = byVid.get(task.videoId)
        if (!found) {
            // iwaradl 里没有它：可能是被删了，也可能是守护进程重启后丢了任务列表。
            // 两种都不该继续显示「下载中」。
            await patchTask(task.id, { status: 'failed', detail: i18n.t('tasks.iwaradlMissing') })
            updated++
            settled++
            continue
        }
        const next = queueStatusOfIwaradl(found.status)
        // 状态与进度分开判：进度每次轮询都可能变，状态很少变。
        // 两个都没变就不写盘——`patchTask` 会刷新 `updatedAt`，那会让任务在列表里“跳”位置
        const statusChanged = task.status !== next
        const progress = found.progress
        const progressChanged = progress !== undefined && Math.abs((task.progress ?? -1) - progress) >= PROGRESS_EPSILON
        if (!statusChanged && !progressChanged) continue
        const patched = await patchTask(task.id, {
            ...(statusChanged
                ? {
                      status: next,
                      // 终态时把旧说明（例如旧的「已交付」文案）换成真实结果，避免一行里两种说法
                      detail: next === 'failed' ? i18n.t('tasks.iwaradlFailed') : undefined
                  }
                : {}),
            ...(progressChanged ? { progress } : {})
        })
        // 只有状态真的变了才算「更新条数」；纯进度刷新不该让用户看到「更新了 N 条」
        if (statusChanged) updated++
        if (statusChanged && (next === 'complete' || next === 'failed')) {
            settled++
            if (patched) await notifyTask(patched)
        }
    }
    return { updated, settled }
}

/** 仅测试用：重置失败计数（模块级状态在同一个进程里会跨用例累积） */
export function resetIwaradlFailureCount(): void {
    consecutiveFailures = 0
}

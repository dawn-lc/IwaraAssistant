/**
 * 两个守护进程后端的「容量与占用」——一次性读回来给界面看。
 *
 * ## 为什么需要（而不是只用我们自己的队列）
 *
 * 我们的队列只知道**自己投递过什么**。aria2 里可能还有用户手动加的任务、上一代队列留下的任务，
 * 它们同样占着 aria2 的并发槽位（`max-concurrent-downloads`）。用户看到「同时下载数 3」
 * 却发现同时有好几条在下，会以为是扩展没执行设置——其实是另一个后端在跑。
 *
 * 反过来，aria2 的 `waiting` 是**排队中**：它自己的并发上限满了。把这种任务在队列里标成
 * 「下载中」也是假话。所以扫描时按 `active` / `waiting` 分开映射（见 `tracker.ts`）。
 *
 * ## 读不到就不编
 *
 * 三个后端各自可能没配置或不可达，所以每个都返回 `{configured, ok, error?}`：
 * 界面必须能区分「没配」「连不上」「空闲」三种情况，
 * 把它们都显示成 0 等于在骗人。
 */
import { i18n } from '../../shared/i18n'
import { parseAria2GlobalStat, parseAria2MaxConcurrent, summarizeIwaradl, type Aria2Stats, type IwaradlStats } from '../../shared/backendStats'
import { stringify } from '../../shared/strings'
import { aria2API, isAria2Configured } from '../backends/aria2/client'
import { iwaradlListTasks, isIwaradlConfigured } from '../backends/iwaradl/client'

/** 单个后端的读取结果：`configured=false` 表示用户没配，不该显示成错误 */
export type BackendRead<T> = { configured: false } | { configured: true; ok: true; stats: T } | { configured: true; ok: false; error: string }

export interface BackendStatsResult {
    aria2: BackendRead<Aria2Stats>
    iwaradl: BackendRead<IwaradlStats>
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : stringify(error)
}

/**
 * aria2 的容量：`getGlobalStat`（占用）+ `getGlobalOption`（上限）。
 *
 * 两个请求并行且**上限失败不算整体失败**：`getGlobalOption` 在某些受限配置下可能被拒，
 * 而「活跃/等待数」仍然有用。
 */
async function readAria2(): Promise<BackendRead<Aria2Stats>> {
    if (!isAria2Configured()) return { configured: false }
    try {
        const [statRes, optionRes] = await Promise.all([aria2API<unknown>('aria2.getGlobalStat', []), aria2API<unknown>('aria2.getGlobalOption', []).catch(() => undefined)])
        const stat = parseAria2GlobalStat(statRes.result)
        if (!stat) return { configured: true, ok: false, error: i18n.t('rpc.statsUnavailable', { detail: i18n.t('rpc.statsNotAria2') }) }
        const limits = parseAria2MaxConcurrent(optionRes?.result)
        return { configured: true, ok: true, stats: limits === undefined ? stat : { ...stat, maxConcurrent: limits } }
    } catch (error) {
        return { configured: true, ok: false, error: i18n.t('rpc.statsUnavailable', { detail: describe(error) }) }
    }
}

/** iwaradl 没有容量接口，只能统计任务列表（`GET /api/tasks`） */
async function readIwaradl(): Promise<BackendRead<IwaradlStats>> {
    if (!isIwaradlConfigured()) return { configured: false }
    try {
        return { configured: true, ok: true, stats: summarizeIwaradl(await iwaradlListTasks()) }
    } catch (error) {
        return { configured: true, ok: false, error: i18n.t('rpc.statsUnavailable', { detail: describe(error) }) }
    }
}

/** 读两个后端（并行；任一失败不影响另一个） */
export async function readBackendStats(): Promise<BackendStatsResult> {
    const [aria2, iwaradl] = await Promise.all([readAria2(), readIwaradl()])
    return { aria2, iwaradl }
}

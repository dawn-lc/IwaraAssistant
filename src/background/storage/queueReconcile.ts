/**
 * 启动对账：把上一代进程留下的「僵尸 running」收敛掉（规则见 `shared/task.ts` 的 `decideStaleRunning`）。
 *
 * 调用点是 `boot()` 里 `loadQueue()` 之后、`startAria2Tracking()` 之前：
 * 先把本地的账算清，再让 aria2 扫描去处理远端那部分。
 *
 * **不发通知**：SW 每次启动都会跑这里，一条失败通知在用户重启浏览器时重复弹出毫无意义。
 * 任务列表顶部的「需要处理」告警条已经是它的落点。
 */
import { i18n } from '../../shared/i18n'
import type { QueueTask } from '../../shared/task'
import { decideStaleRunning, type Aria2Probe, type BrowserProbe, type StaleReason } from '../../shared/task'
import { getConfig } from './configStore'
import { getTasks, patchTask } from './queue'

/** `aria2` 是否配置了端点 —— 没配就等于「永远不会有人告诉我们结果」 */
function aria2Probe(): Aria2Probe {
    const config = getConfig()
    return config.aria2Path !== '' ? { kind: 'tracked' } : { kind: 'untracked' }
}

/**
 * 查一条浏览器下载的真实状态。
 *
 * `downloads.search({ id })` 返回数组：记录被删除（用户在下载管理器里清掉）时为空。
 * 查询抛错就返回 `unknown` —— 证据不足时保持原样，绝不猜。
 */
async function browserProbe(task: QueueTask): Promise<BrowserProbe> {
    const downloadId = Number(task.kindRef)
    if (task.kindRef === undefined || !Number.isFinite(downloadId)) return { kind: 'missing' }
    try {
        const [item] = await browser.downloads.search({ id: downloadId })
        if (!item) return { kind: 'missing' }
        if (item.state === 'in_progress') return { kind: 'alive' }
        if (item.state === 'complete') return { kind: 'complete' }
        return { kind: 'interrupted', ...(item.error === undefined ? {} : { error: item.error }) }
    } catch {
        return { kind: 'unknown' }
    }
}

/** 对账原因的文案（与 `StaleReason` 一一对应，新增原因时编译期会报错） */
function staleDetail(reason: StaleReason, task: QueueTask): string | undefined {
    switch (reason) {
        case 'browserComplete':
            // 完成不需要解释
            return undefined
        case 'browserInterrupted':
            return i18n.t('tasks.staleInterrupted')
        case 'browserMissing':
            return i18n.t('tasks.staleMissing')
        case 'aria2Untracked':
            return i18n.t('tasks.staleAria2')
        case 'neverDelivered':
            return i18n.t('tasks.staleNeverDelivered')
        case 'deliveredEarlier':
            return i18n.t(task.kind === 'iwaradl' ? 'tasks.handedOffIwaradl' : 'tasks.handedOffOthers')
    }
}

export interface ReconcileResult {
    /** 收敛掉的任务数 */
    settled: number
    /** 证明确实还在跑的 */
    kept: number
}

/**
 * 扫描队列里所有 `running` 任务，按证据收敛。
 *
 * 幂等：收敛后状态不再是 `running`，下一次 boot 不会重复处理。
 */
export async function reconcileStaleRunningTasks(): Promise<ReconcileResult> {
    const running = getTasks().filter((task) => task.status === 'running')
    if (running.length === 0) return { settled: 0, kept: 0 }

    const aria2 = aria2Probe()
    let settled = 0
    let kept = 0
    for (const task of running) {
        const browserState = task.kind === 'browser' ? await browserProbe(task) : ({ kind: 'unknown' } as const)
        const decision = decideStaleRunning(task, { browser: browserState, aria2 })
        if (decision.kind === 'keep') {
            kept++
            continue
        }
        await patchTask(task.id, { status: decision.status, detail: staleDetail(decision.reason, task) })
        settled++
    }
    if (settled > 0) console.info(`[iwara-assistant] 启动对账：收敛 ${settled} 条僵尸任务，保留 ${kept} 条仍在运行的`)
    return { settled, kept }
}

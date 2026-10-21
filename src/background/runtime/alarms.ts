/**
 * alarms —— 定时任务（原 aria2Track 3 个 setInterval + 页内重试循环的平台替代，docs/01）
 *
 * | alarm          | 周期   | 动作                                            |
 * |----------------|-------|-------------------------------------------------|
 * | ws-keepalive   | 2 min | aria2 WS 探活重连（指数退避打满后由这里兜底重拉）     |
 * | probe-aria2    | 1 min | **按需创建**：只拉 tellActive，做慢速判定与进度回写   |
 * | scan-aria2     | 5 min | tellActive/tellStopped 对账（WS 通知丢失/外部任务）  |
 * | scan-iwaradl   | 1 min | **按需创建**：有活跃 iwaradl 任务时才存在（它没有推送，只能拉） |
 * | retry-failed   | 30 min| 队列 failed 任务按 attempts 上限自动重试             |
 *
 * SW 挂起：alarm 触发即唤醒后台；持久化由队列/配置模块自理（挂起协议 2）。
 * 选举/清锁类 alarm 不复存在（后台即管理器）。
 */
import { RETRY_BATCH_LIMIT, RETRY_MAX_ATTEMPTS } from '../../shared/constants'
import { keepAliveWs } from '../backends/aria2/ws'
import { retryTask } from '../download/dispatch'
import { getTasks } from '../storage/queue'
import { ARIA2_PROBE_ALARM, probeAria2SlowTasks, scanAria2TasksAndEnqueue } from '../backends/aria2/tracker'
import { syncIwaradlTasks } from '../backends/iwaradl/tracker'
import { IWARADL_SCAN_ALARM } from '../backends/iwaradl/client'

const ALARM_KEEPALIVE = 'ws-keepalive'
const ALARM_SCAN = 'scan-aria2'
const ALARM_RETRY = 'retry-failed'

const PERIOD_KEEPALIVE_MIN = 2
const PERIOD_SCAN_MIN = 5
const PERIOD_RETRY_MIN = 30

async function ensureAlarms(): Promise<void> {
    await browser.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: PERIOD_KEEPALIVE_MIN })
    await browser.alarms.create(ALARM_SCAN, { periodInMinutes: PERIOD_SCAN_MIN })
    await browser.alarms.create(ALARM_RETRY, { periodInMinutes: PERIOD_RETRY_MIN })
}

async function retryFailedTasks(): Promise<void> {
    // 快照扫描（避免遍历中变更）：failed 且未达上限的任务逐个复跑。
    //
    // 两个限制都是必需的：
    // ① `attempts` 上限 —— 同一条任务不会无限重试（收编来的历史失败初始就是满上限，
    //    要重试请用户自己点）；
    // ② **每轮条数上限** —— 一次「共同失败」（守护进程停了 / 掉登录 / 直链端点抽风）
    //    会让几十上百条任务同时变 failed，无限制就会在下一轮把它们一起打出去。
    // 按「最近更新」优先：刚失败的往往是用户此刻真正想要的。
    const candidates = getTasks()
        .filter((task) => task.status === 'failed' && (task.attempts ?? 0) < RETRY_MAX_ATTEMPTS)
        .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
        .slice(0, RETRY_BATCH_LIMIT)
    for (const task of candidates) {
        task.attempts = (task.attempts ?? 0) + 1
        await retryTask(task)
    }
    if (candidates.length > 0) console.info(`[iwara-assistant] 自动重试 ${candidates.length} 条失败任务（每轮上限 ${RETRY_BATCH_LIMIT}）`)
}

export function setupAlarms(): void {
    browser.alarms.onAlarm.addListener((alarm) => {
        switch (alarm.name) {
            case ALARM_KEEPALIVE:
                void keepAliveWs()
                break
            case ALARM_SCAN:
                void scanAria2TasksAndEnqueue()
                break
            case ARIA2_PROBE_ALARM:
                void probeAria2SlowTasks()
                break
            case IWARADL_SCAN_ALARM:
                void syncIwaradlTasks()
                break
            case ALARM_RETRY:
                void retryFailedTasks()
                break
            default:
                break
        }
    })
    void ensureAlarms()
}

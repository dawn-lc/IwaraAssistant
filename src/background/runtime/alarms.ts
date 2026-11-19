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
import { isPermanentAria2ErrorCode } from '../../shared/aria2Network'
import { RETRY_BATCH_LIMIT, RETRY_MAX_ATTEMPTS } from '../../shared/constants'
import { keepAliveWs } from '../backends/aria2/ws'
import { retryTask } from '../download/dispatch'
import { getTasks, patchTask } from '../storage/queue'
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
    // 同一视频只重试**最新**那条失败记录：旧版本会在每次失败后新建一行，
    // 逐条重试等于对同一个文件发多次 addUri，扫描再把多余副本 abort
    // （任务面板上的 “Download aborted.” 有一部分就是这么来的）。
    const seenVideos = new Set<string>()
    const candidates = getTasks()
        // ② 归因明确的失败**不自动重试**：`unrecoverable`（视频已删/仅好友可见）与
        //    `conflict`（目标文件已存在/同路径被占用）都不是重试能解决的，自动打出去只会
        //    白烧一次解析、在 aria2 里留一条新残骸。这两类留给用户：前者去加好友或移除，
        //    后者用任务页的「强制覆盖」。`aria2ErrorCode` 落在磁盘/目录/IO 那一档（9/10/15/16/17/18）同理：
        //    重试必然再撞同一面墙，用户处理好存储再说。
        .filter((task) => task.status === 'failed' && task.unrecoverable !== true && task.conflict !== true && !isPermanentAria2ErrorCode(task.aria2ErrorCode) && (task.attempts ?? 0) < RETRY_MAX_ATTEMPTS)
        .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
        .filter((task) => {
            if (seenVideos.has(task.videoId)) return false
            seenVideos.add(task.videoId)
            return true
        })
        .slice(0, RETRY_BATCH_LIMIT)
    for (const task of candidates) {
        // **先落盘再重试**，而且只在这里记账。理由是两个真事故：
        // 1. retryTask 在「正在投递 / 已有同源活跃任务 / 正在重试」三处早退，早退时
        //    内存对象上那个 +1 从来不会写回；而 Chrome MV3 的 SW 每 30 秒可能被回收
        //    ⇒ attempts 永远停在 0 ⇒ 永久失败（私有视频 / 外部 embed / errorCode 13）
        //    被每 30 分钟重打一次，永不停止，还长期霸占 RETRY_BATCH_LIMIT 的名额。
        // 2. dispatch 的失败分支也 +1 过一次，自动重试一轮就记两次 → 上限提前一半用完。
        const attempts = (task.attempts ?? 0) + 1
        await patchTask(task.id, { attempts })
        await retryTask({ ...task, attempts })
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

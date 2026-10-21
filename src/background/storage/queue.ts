/**
 * 下载队列 —— 唯一写者（docs/01）：storage 先落盘；角标计数；DOWNLOAD_STATE 推送
 * 自原 background/index.ts 内联实现抽出，供 downloads.onChanged 与 dispatch 共用
 */
import type { Push } from '../../messaging/protocol'
import { i18n } from '../../shared/i18n'
import { QUEUE_KEY } from '../../shared/storageKeys'
import type { QueueTask } from '../../shared/task'
import { taskMatchesRef } from '../../shared/task'
import { planQueueLiveDuplicates } from '../../shared/downloadDedupe'
import { isClearable } from '../../shared/taskView'
import { getConfig } from './configStore'
import { clearNotification, showNotification, type NotificationTarget } from '../runtime/notify'

/**
 * 任务通知的通知 id。
 *
 * **按视频 ID 而不是任务 ID**：任务 ID 是每次尝试新生成的 uuid，重试三次就会在通知中心
 * 留下三条同视频的通知（而且指向同一个面板）。源的 toast 是页内元素，刷新就没；
 * 系统通知会一直留在通知中心，所以必须自己收敛成「一个视频一条」。
 * 同时这也让「清空已结束任务」能反推出该关哪些通知。
 */
function taskNotificationId(videoId: string): string {
    return `task-${videoId}`
}

let memQueue: QueueTask[] = []

/**
 * 「队列已从磁盘读回」的就绪信号。
 *
 * ⚠️ 这不是锦上添花：`memQueue` 初值是 `[]`，而 `boot()` 是**异步**的
 * （`void boot()` 之后紧接着就注册了消息监听）。Chrome 的 SW 被回收后，
 * 一条 `BATCH_DOWNLOAD` / `INIT_DOWNLOAD` 完全可能**先于** `loadQueue()` 到达，
 * 那时 `getTasks()` 返回空数组，两个后果：
 *
 * 1. 队列去重静默失效 → 已下载过的视频照样重新投递（用户看到的「重复任务」）；
 * 2. `addTask` 往空数组里 push 再 `persist()` → **把磁盘上的历史队列整个覆盖掉**。
 *
 * 所以消息路由必须先等这个信号（见 `background/index.ts`）。
 */
let markQueueReady: (() => void) | undefined
const queueReadyPromise = new Promise<void>((resolve) => {
    markQueueReady = resolve
})

/** 等到队列已从磁盘读回（幂等；`loadQueue` 失败时也会放行，避免消息永久挂起） */
export function queueReady(): Promise<void> {
    return queueReadyPromise
}

/** 挂起重入恢复；浏览器重启后 SW 冷启动同样调用 */
export async function loadQueue(): Promise<void> {
    try {
        const stored = await browser.storage.local.get(QUEUE_KEY)
        const value = stored[QUEUE_KEY]
        memQueue = Array.isArray(value) ? (value as QueueTask[]) : []
    } finally {
        // 读盘失败也要放行：宁可让后续操作在空队列上跑（会如实报「任务不存在」），
        // 也不能让所有消息永久卡在这里
        markQueueReady?.()
        markQueueReady = undefined
    }
}

export async function persist(): Promise<void> {
    await browser.storage.local.set({ [QUEUE_KEY]: memQueue })
}

/**
 * 按引用查任务。
 *
 * 匹配规则在 `shared/task.ts` 的 `taskMatchesRef`（可单测，并且注释里写清了
 * 为什么按 `kindRef` 查必须同时给 `kind`——`tabId` 与 `downloadId` 会撞）。
 */
export function findTask(ref: { kindRef?: string; id?: string; kind?: QueueTask['kind'] }): QueueTask | undefined {
    return memQueue.find((task) => taskMatchesRef(task, ref))
}

/** 全量任务快照（追踪模块对账/重试扫描用） */
export function getTasks(): QueueTask[] {
    return memQueue
}

/** 就地修补任务后落盘/推送（追踪对账、重试计数） */
export async function patchTask(id: string, patch: Partial<QueueTask>): Promise<QueueTask | undefined> {
    const task = memQueue.find((item) => item.id === id)
    if (!task) return undefined
    Object.assign(task, patch, { updatedAt: Date.now() })
    await persist()
    updateBadge()
    return task
}

export async function addTask(task: QueueTask): Promise<QueueTask> {
    const now = Date.now()
    task.createdAt ??= now
    task.updatedAt = now
    memQueue.push(task)
    await persist()
    updateBadge()
    return task
}

/**
 * 从队列移除一条任务（options 任务面板手动清理用）。
 *
 * **`running` 默认拒绝**：下载器可能还在写文件，抹掉记录会让追踪器失去对账目标。
 * 这不是「不允许删」，而是「删之前必须先停下载器」——调用方（后台 `REMOVE_TASK`）
 * 先用 `cancelTaskDownload` 取消，确认停下来了才带 `allowRunning` 进来删。
 * 把「删」和「停止」拆成两步，是为了失败时不丢记录：取消失败 → 不删 → 用户还看得见。
 */
export async function removeTask(id: string, options: { allowRunning?: boolean } = {}): Promise<boolean> {
    const index = memQueue.findIndex((task) => task.id === id)
    if (index < 0) return false
    const task = memQueue[index]!
    if (task.status === 'running' && options.allowRunning !== true) return false
    memQueue.splice(index, 1)
    await persist()
    updateBadge()
    // 队列里已经没有这个视频的记录了，通知留在通知中心只会点出一个查不到的任务 → 一并关掉。
    // 必须按 videoId 查剩余记录：同一视频可能先后有多条（重新下载会新建一条），
    // 只删掉其中一条就关通知，会让还活着的那条任务点不动。
    if (!memQueue.some((item) => item.videoId === task.videoId)) void clearNotification(taskNotificationId(task.videoId))
    return true
}

/**
 * 移除某个视频的全部 `skipped` 待办记录。
 *
 * 调用时机是「这次真的开始下载了」（`runDownloadInner` 建 running 记录前）：
 * 一条视频同时存在「已跳过」与「下载中」两条记录会让任务列表自相矛盾，
 * 用户不知道该看哪一条。
 *
 * 只清 `skipped`：`failed` 靠重试复用原记录，`complete` 是历史，都不该被动。
 */
export async function removeSkippedFor(videoId: string): Promise<number> {
    const before = memQueue.length
    memQueue = memQueue.filter((task) => !(task.videoId === videoId && task.status === 'skipped'))
    const removed = before - memQueue.length
    if (removed > 0) {
        await persist()
        // 待办没了，通知中心那条也一并关掉（点它只会看到一条已经不存在的任务）
        if (!memQueue.some((task) => task.videoId === videoId)) void clearNotification(taskNotificationId(videoId))
    }
    return removed
}

/**
 * 清除已结束任务（`complete` / `failed` / `handed-off`），返回清除条数。
 *
 * **不碰 `skipped`**：它属于「待办」而不是「已结束」——
 * 清掉就等于把用户找回那个视频的唯一入口抹了。待办只能由用户单独移除，
 * 或者在他真的开始下载时由 `removeSkippedFor` 自然消失。
 *
 * 判据用 `isClearable`（与任务页的按钮可用性同源），不在两处各列一遍状态名。
 */
export async function clearFinished(): Promise<number> {
    const before = memQueue.length
    const removedTasks = memQueue.filter(isClearable)
    memQueue = memQueue.filter((task) => !isClearable(task))
    const removed = before - memQueue.length
    if (removed > 0) {
        await persist()
        updateBadge()
        // 用户明确要「清空已结束」：通知中心里的那些终态通知也该跟着消失，
        // 否则点它们只会打开一个已经没有该任务的面板。
        // 逐个 videoId 判剩余：同一视频可能还留着一条 `skipped` 待办。
        for (const videoId of new Set(removedTasks.map((task) => task.videoId))) {
            if (!memQueue.some((task) => task.videoId === videoId)) void clearNotification(taskNotificationId(videoId))
        }
    }
    return removed
}

/**
 * 收敛队列里同一 videoId 的多条**活跃**记录（只动 `running` / `queued`）。
 *
 * 判据在 `shared/downloadDedupe.ts` 的 `planQueueLiveDuplicates`（纯函数，已单测）。
 * 这里只负责落库与日志。
 *
 * `liveGids` 由调用方（aria2 扫描）从 `tellActive` 提供：它能让「真正在下的那条」
 * 优先被保留，而不是靠时间戳猜。
 *
 * @returns 丢弃的条数
 */
export async function collapseDuplicateLiveTasks(liveGids?: ReadonlySet<string>): Promise<number> {
    const plan = planQueueLiveDuplicates(memQueue, liveGids)
    if (plan.drop.length === 0) return 0
    for (const inherit of plan.inheritKindRef) {
        const keeper = memQueue.find((task) => task.id === inherit.taskId)
        if (keeper) keeper.kindRef = inherit.kindRef
    }
    const droppedIds = new Set(plan.drop.map((task) => task.id))
    memQueue = memQueue.filter((task) => !droppedIds.has(task.id))
    await persist()
    updateBadge()
    console.info(`[iwara-assistant] 队列去重：同一视频的重复活跃记录已收敛，丢弃 ${plan.drop.length} 条（${plan.drop.map((task) => `${task.videoId}:${task.status}`).join(', ')}）`)
    return plan.drop.length
}

/** 状态落盘 + 扩展页推送（popup/options 无监听时静默） */
export async function syncTask(task: QueueTask): Promise<void> {
    task.updatedAt = Date.now()
    await persist()
    updateBadge()
    pushExtensionPage({ type: 'DOWNLOAD_STATE', payload: { taskId: task.id, state: stateOf(task.status), detail: task.detail } })
}

function stateOf(status: QueueTask['status']): 'progress' | 'complete' | 'failed' | 'skipped' | 'handed-off' {
    switch (status) {
        case 'complete':
            return 'complete'
        case 'failed':
            return 'failed'
        case 'skipped':
            return 'skipped'
        case 'handed-off':
            return 'handed-off'
        case 'queued':
        case 'running':
            return 'progress'
    }
}

function pushExtensionPage(msg: Push): void {
    browser.runtime.sendMessage(msg).catch(() => {
        // 无接收方（popup/options 未开）：静默
    })
}

/**
 * 角标 API：MV3 是 `action`，MV2（Firefox 产物）是 `browserAction`。
 * 两者 `setBadgeText` 签名一致，取到哪个用哪个；都取不到时静默跳过（角标只是附加反馈）。
 */
function badgeApi(): { setBadgeText: (details: { text: string }) => Promise<void> } | undefined {
    type BadgeCapable = { setBadgeText: (details: { text: string }) => Promise<void> }
    const api = browser as unknown as { action?: BadgeCapable; browserAction?: BadgeCapable }
    return api.action ?? api.browserAction
}

export function updateBadge(): void {
    const active = memQueue.filter((task) => task.status === 'running' || task.status === 'queued').length
    void badgeApi()?.setBadgeText({ text: active > 0 ? String(active) : '' })
}

/**
 * 任务终态系统通知（docs/05：notifications 是唯一反馈通道；OS 层关闭则静默降级）。
 *
 * 生命周期对齐源项目的 toast 分级：
 * - 完成 → 源的 `Info`：无声 + 数秒后自己消失
 * - 失败 → 源的 `Error`（`duration: -1`）：有声 + 常驻，等用户去处理
 * - 跳过（`skipped`）→ 源的 `Warn`（`duration: -1`）：常驻；点击去 `followUpUrl`
 *
 * 源里那些 toast 是页面元素，页面一刷新就全没；系统通知不会，所以：
 * 1. 通知 id 按视频收敛（见 `taskNotificationId`）
 * 2. 点击目标带 `copyText`（源里那个「打开视频链接」按钮会顺手复制保存文件名）
 * 3. 跳过类通知的**持久记录在任务列表**（`options#tasks`），通知只是即时提醒
 */
export async function notifyTask(task: QueueTask): Promise<void> {
    const state = stateOf(task.status)
    // 交付型终态（iwaradl / others）不发通知：我们不知道结果，说「已完成」是撒谎，
    // 说「失败」也不对。它的记录在任务列表里，`handed-off` 一行写清了交给谁。
    if (state === 'handed-off') return

    /**
     * 通知落点：有 `followUpUrl` 时必须去那里，而不是任务列表。
     *
     * `followUpUrl` 只有两种来源，两者都是「去那里才有用」：
     * - `skipped`：跳过了，用户要去视频页看简介里的网盘链接；
     * - `failed` + 外部视频（embedUrl）：重试一万次也不会成功，原始地址是唯一信息。
     * 其余失败（解析错、网络错、下载器拒绕）才落到任务列表去重试。
     */
    const followUp = (state === 'skipped' || state === 'failed') && task.followUpUrl !== undefined
    const target: NotificationTarget = followUp
        ? {
              kind: 'url',
              url: task.followUpUrl as string,
              // 源项目点「打开视频链接」会顺手把保存文件名写进剪贴板；只有跳过场景才复制
              ...(state === 'skipped' && getConfig().autoCopySaveFileName && task.filename ? { copyText: task.filename } : {})
          }
        : { kind: 'options', tab: 'tasks' }

    const message = state === 'skipped' ? i18n.t('notify.linkFound', { id: task.videoId }) : state === 'failed' ? i18n.t('notify.taskFailed', { id: task.videoId, kind: task.kind, detail: task.detail ?? task.filename ?? i18n.t('notify.unknownReason') }) : i18n.t('notify.taskComplete', { id: task.videoId })

    await showNotification(taskNotificationId(task.videoId), {
        message,
        target,
        // 完成只是「办好了」，不需要打断用户；失败与跳过都需要他做决定
        silent: state === 'complete',
        autoCloseMs: state === 'complete' ? 5000 : undefined,
        requireInteraction: state !== 'complete'
    })
}

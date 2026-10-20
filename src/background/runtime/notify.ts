/**
 * 系统通知（docs/05：notifications 是唯一反馈通道）
 * 任务终态通知在 queue.ts（`notifyTask`）；此处为非任务类提示（链接命中 / 批量入队 / 后台作业）。
 *
 * **每条通知都必须携带点击目标**。通知是扩展里唯一的异步反馈通道，用户看到
 * 「检测到第三方下载链接」自然会去点——点了没反应等于反馈链断在半路（实测报备的缺陷）。
 *
 * 为什么目标要落 `storage.session` 而不是内存闭包：`onClicked` 可能发生在 SW 被回收之后
 * （Chrome 空闲 ~30s 就挂起），到那时创建通知时的闭包早就没了。详见 storageKeys 的注释。
 */
import { i18n } from '../../shared/i18n'
import { NOTIFICATION_TARGETS_KEY } from '../../shared/storageKeys'
import type { OptionsTabId } from '../../shared/optionsTabs'

const ICON = 'icons/icon-128.png'

/** 点击通知要去哪 */
export type NotificationTarget =
    | { kind: 'options'; tab: OptionsTabId }
    | {
          kind: 'url'
          url: string
          /**
           * 点击时要写入剪贴板的文本（目前只有「发现第三方网盘链接」用）。
           *
           * 必须挂在**点击**上而不是检测时：源项目的 `autoCopySaveFileName` 语义就是
           * 「用户点了『打开视频链接』按钮才复制」——点那一下才表示他决定改用外部下载器。
           */
          copyText?: string
      }

export interface NotifyOptions {
    message: string
    /** 点击后的去处。刻意不给默认值：让「这条通知点不点得动」在调用点就显式可见 */
    target: NotificationTarget
    /** 缺省用品牌名 */
    title?: string
    /**
     * 不要提示音。
     *
     * 源项目的 toast 是页内 DOM，本来就无声；系统通知默认有声。
     * 信息级提示（「批量入队完成」这类）跟着响一遍纯属骚扰，所以对齐源 = 静音。
     * 警告/失败**不**静音：用户在别的窗口时，声音是唯一能把他拉回来的线索（有意的平台差异）。
     */
    silent?: boolean
    /**
     * 到点主动关闭（`notifications.clear`），对齐源 `ToastType.Info` 的 `duration: 2000`。
     *
     * 浏览器通知**没有**任何「显示时长」参数（`timeoutType` 早已废除），
     * 唯一可控手段就是自己调 `clear`。代价：service worker 被挂起时 `setTimeout` 会丢，
     * 那时通知留在通知中心不动，等于退化成当前行为（无害，不是错误）。
     */
    autoCloseMs?: number
    /**
     * 常驻直到用户处理，对齐源 `Warn`/`Error` 的 `duration: -1`
     * （源里那两类 toast 必须点关闭按钮或点击主体才会消失）。
     */
    requireInteraction?: boolean
}

/** 最多保留多少条待点击目标：`getAll` 对账不可用时的兜底，防 session 存储无限增长 */
const MAX_TARGETS = 50

// 刻意**不**在 `notifications.onClosed` 里清理：点击通知本身也会触发 onClosed，
// 两个事件的先后顺序没有保证。若 onClosed 先到，刚登记的目标就被删了，
// `onClicked` 读不到 → 又变回「点了没反应」（就是本次要修的那个缺陷）。
// 关掉的条目由 `pruneClosed` 按「通知是否还存在」对账清理，见下。

type TargetMap = Record<string, NotificationTarget>

function isTarget(value: unknown): value is NotificationTarget {
    if (value === null || typeof value !== 'object') return false
    const entry = value as { kind?: unknown; tab?: unknown; url?: unknown; copyText?: unknown }
    if (entry.kind === 'options') return typeof entry.tab === 'string'
    if (entry.kind === 'url') return typeof entry.url === 'string' && (entry.copyText === undefined || typeof entry.copyText === 'string')
    return false
}

async function readTargets(): Promise<TargetMap> {
    try {
        const stored = await browser.storage.session.get(NOTIFICATION_TARGETS_KEY)
        const value: unknown = stored[NOTIFICATION_TARGETS_KEY]
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
        const map: TargetMap = {}
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (isTarget(entry)) map[key] = entry
        }
        return map
    } catch {
        // 读不到就当作「没有目标」：点击变成无操作，但不该让通知本身发不出去
        return {}
    }
}

/**
 * 删掉「目标还在、通知已经不在」的条目。
 *
 * 为什么必须有：通知可以不经我们而消失（用户划掉、系统清理、我们自己的 autoClose）。
 * 只靠 `MAX_TARGETS` 淘汰的话，一旦通知数量超过上限，**还在屏幕上的**通知也会被删目标，
 * 点它就没反应——正是这套登记表本来要修的那个缺陷的翻版。按实际存活情况对账才是正确的淘汰依据。
 *
 * `keepId`：本次即将创建的那条。`showNotification` 先登记后 `create`，此刻 `getAll` 里还没有它，
 * 不排除就会被自己删掉。
 *
 * `getAll` 取不到（老版 Chrome 只有 callback 形态）时**跳过修剪**——宁可多留，不要误删。
 */
async function pruneClosed(map: TargetMap, keepId?: string): Promise<void> {
    let alive: unknown
    try {
        alive = await browser.notifications.getAll()
    } catch {
        return
    }
    if (alive === null || typeof alive !== 'object') return
    const existing = alive as Record<string, unknown>
    for (const key of Object.keys(map)) {
        if (key === keepId) continue
        if (existing[key] !== true) delete map[key]
    }
}

/**
 * 串行化的「读-改-写」。
 *
 * 两条通知同时创建时并发的 read-modify-write 会互相覆盖——后写的那次基于旧快照，
 * 把前一条的目标写没，点它又变回没反应。用一个 promise 链排队，代价是几十微秒。
 *
 * `prune`：只有「新建通知」路径需要修剪。`consume`（点击消费）**绝不能**修剪——
 * 点击也可能先触发 onClosed，那时 `getAll` 里已经没这条通知了，修剪会把刚读到的目标删掉。
 */
let chain: Promise<unknown> = Promise.resolve()

function mutateTargets<T>(mutate: (map: TargetMap) => T, options: { keepId?: string; prune?: boolean } = {}): Promise<T | null> {
    const next = chain.then(async () => {
        const map = await readTargets()
        if (options.prune === true) await pruneClosed(map, options.keepId)
        const result = mutate(map)
        const keys = Object.keys(map)
        for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TARGETS))) delete map[key]
        await browser.storage.session.set({ [NOTIFICATION_TARGETS_KEY]: map })
        return result
    })
    // 失败不能卡死整条链（否则之后所有通知都拿不到目标）
    chain = next.then(
        () => undefined,
        () => undefined
    )
    return next.catch((error: unknown) => {
        console.warn('[iwara-assistant] 通知点击目标登记失败:', error)
        return null
    })
}

/**
 * 该平台是否接受 `silent` / `requireInteraction`。
 *
 * Firefox 的 `notifications.create()` 做 **schema 校验**：遇到它不认识的字段（`silent`）
 * 会**同步抛 TypeError**，连 `.catch()` 都拦不住——实测 MV2 产物上直接让
 * `INIT_DOWNLOAD` 整条消息变成 `ok:false`。所以这些可选字段必须「能带则带、不能带就退」。
 */
let supportsExtraOptions = true

/**
 * 创建通知：先按完整参数发，平台不支持可选字段时降级为最小字段集。
 *
 * 降级不是妥协——通知**发出去**是首要目标，提示音与常驻是次要属性。
 * 首次失败后记住结论（`supportsExtraOptions = false`），后续不再白试一次。
 */
async function createNotification(id: string, options: chrome.notifications.NotificationCreateOptions, silent: boolean, requireInteraction: boolean): Promise<void> {
    if (supportsExtraOptions) {
        try {
            await browser.notifications.create(id, { ...options, silent, requireInteraction })
            return
        } catch {
            supportsExtraOptions = false
        }
    }
    try {
        await browser.notifications.create(id, options)
    } catch {
        // 用户在 OS 层关闭了通知：静默（不回退页内 toast）
    }
}

/**
 * 发一条系统通知，并登记点击目标。
 *
 * 先写登记表再创建通知：反过来的话存在「通知已经可见、目标还没落盘」的窗口，
 * 用户手快点了就是没反应。
 */
export async function showNotification(id: string, options: NotifyOptions): Promise<void> {
    const target = options.target
    await mutateTargets(
        (map) => {
            map[id] = target
        },
        { keepId: id, prune: true }
    )
    await createNotification(
        id,
        {
            type: 'basic',
            iconUrl: browser.runtime.getURL(ICON),
            title: options.title ?? i18n.t('app.name'),
            message: options.message
        },
        options.silent === true,
        options.requireInteraction === true
    )
    if (options.autoCloseMs !== undefined && options.autoCloseMs > 0) {
        // 不 await：定时器到了才执行；SW 被挂起时定时器丢失，退化为「通知留着」
        const timer = setTimeout(() => void clearNotification(id), options.autoCloseMs)
        // node 单测环境里定时器会拖住进程退出；浏览器里 setTimeout 返回 number，没有 unref
        ;(timer as unknown as { unref?: () => void }).unref?.()
    }
}

/** 主动关闭一条通知（源项目 `toast.hide()` 的等价物）；找不到就什么都不做 */
export async function clearNotification(id: string): Promise<boolean> {
    try {
        return (await browser.notifications.clear(id)) === true
    } catch {
        return false
    }
}

/** 取出并删除某条通知的点击目标（`onClicked` 用）；取不到说明这条通知没有登记过 */
export async function consumeNotificationTarget(notificationId: string): Promise<NotificationTarget | null> {
    return mutateTargets((map) => {
        const found = map[notificationId] ?? null
        delete map[notificationId]
        return found
    })
}

/**
 * 信息提示。
 *
 * 生命周期对齐源 `ToastType.Info`：默认 2000ms 自动消失、无声。这里给 3 秒——
 * 系统通知从 `create` 到真正出现在屏幕上本身有几百毫秒延迟，照搬 2 秒会让用户只看到一闪。
 */
export function notifyInfo(id: string, message: string, target: NotificationTarget): void {
    void showNotification(`info-${id}`, { message, target, silent: true, autoCloseMs: 3000 })
}

/**
 * 警告提示。
 *
 * 生命周期对齐源 `ToastType.Warn`（`duration: -1`）：常驻，等用户处理。
 * 与源不同的一点：默认带提示音——源 toast 在页面上有视觉存在感，系统通知静音后，
 * 用户在别的窗口时就彻底错过了。
 */
export function notifyWarn(id: string, message: string, target: NotificationTarget): void {
    void showNotification(`warn-${id}`, { message, target, requireInteraction: true })
}

/**
 * storage.local 键名收敛 —— 后台/选项页/弹窗共用，避免字符串字面量散落
 */
export const CONFIG_KEY = 'config'
export const QUEUE_KEY = 'downloadQueue'

/** 旧脚本页面数据库的检测结果（LegacyDbInfo：found / counts / scannedAt / importedAt） */
export const LEGACY_DB_INFO_KEY = 'legacyDb'
/** 一次性扫描标记：content script 只在首次进入 iwara 页时扫一遍页面 IDB，之后靠显式导入重扫 */
export const LEGACY_DB_SCANNED_KEY = 'legacyDbScanned'
/**
 * 「关注扩展作者」的状态（PromoteAuthorState：`{ done?, lastAttemptAt? }`）。
 *
 * 必要性：`boot()` 在**每个** service worker 唤醒时都会跑（Chrome SW 空闲约 30s 就挂起），
 * 而该功能默认开启——不记录状态等于反复请站点 API 查自己/查作者资料。
 */
export const PROMOTE_AUTHOR_STATE_KEY = 'promoteAuthorState'

/**
 * 好友审批快照（`FriendApproveProgress`）。
 *
 * **存 `storage.session` 而不是 `.local`**：进度是会话级易失数据，不该落盘；
 * session 是内存态、跨上下文可读、浏览器退出即清空。
 * 历史上它写在 `.local` 里，导致进程被杀后 `running: true` 永久残留、界面永远转圈——
 * 完整推理见 `shared/approvalProgress.ts` 头部。
 */
export const FRIEND_APPROVE_PROGRESS_KEY = 'friendApproveProgress'

/**
 * 钓鱼防护的「已放行」记录（`Record<tabId, host>`）。
 *
 * 为什么存 `storage.session` 而不是内存：Chrome SW 空闲 ~30s 就挂起，只存内存的话
 * 用户点了「继续访问」、过一会儿刷新页面又会被拦（放行只活 30 秒）。也不用 local：
 * tabId 会跨浏览器会话重用，昨天的 tab 5 放行记录可能落到今天的新 tab 5 上。
 * session 存储随浏览器退出清空，正好。
 */
export const GUARD_RELEASED_KEY = 'guardReleased'

/**
 * 系统通知的「点击去哪」登记表（`Record<notificationId, NotificationTarget>`）。
 *
 * **存 `storage.session` 而不是内存**：`notifications.onClicked` 可能在 SW 被回收之后才触发
 * （Chrome 空闲 ~30s 就挂起），那时内存里的闭包早已不存在。session 是内存态、跨上下文可读、
 * 浏览器退出即清空，与通知自身的生命周期一致——正好不需要自己做过期清理。
 *
 * 也不能存 `storage.local`：通知不会跨浏览器会话保留，落盘的表只会越积越多。
 */
export const NOTIFICATION_TARGETS_KEY = 'notificationTargets'

/**
 * 用户在 iwara 站点上选择的内容分级（`localStorage` 的 rating 偏好，源 `LS_KEY_RATING`）。
 *
 * 后台读不到页面的 localStorage，所以由 content script 上行后存在这里，
 * 供订阅流遍历（`GET /videos?subscribed&rating=`）使用。
 * 与 cookie 一样属于「页面侧的事实」，因此落在 `storage.local` 而不是 config 里——
 * 它不是用户手填的配置项，不应该出现在选项页被当成设置项编辑。
 */
export const RATING_KEY = 'siteRating'

/**
 * 订阅流**自动**遍历的上次尝试时间（毫秒时间戳）。
 *
 * 存 `storage.local` 而不是内存：Chrome MV3 的 SW 空闲约 30 秒就回收，只存内存等于
 * 每次唤醒都当成「从没跑过」——用户连续切几个列表页就会连发多轮请求。
 * 也不放 config：它是运行记录而不是用户可编辑的设置项。
 */
export const AUTO_SYNC_AT_KEY = 'autoSyncAt'

/**
 * aria2 扫描的跨轮记忆（`Aria2ScanMemory`：慢速采样计数 + 恢复失败次数）。
 *
 * **存 `storage.session` 而不是内存 / 不是 local**：
 * - 只存内存 → Chrome MV3 的 SW 空闲约 30 秒就被回收，而扫描 5 分钟一次，
 *   每次扫描都是新实例，「连续 N 次扫描都低速」永远数不到 N（功能从未生效过）；
 * - 存 local → 上一次浏览器会话的陈旧计数会被带进新的会话，而那时任务早已不同。
 * session 是内存态、跨 SW 实例存活、浏览器退出即清空，正好是「本次会话的观察」。
 */
export const ARIA2_SCAN_MEMORY_KEY = 'aria2ScanMemory'

/**
 * 「下载完成后推送 MediaCenter」的待重试表（`PendingPushTable`）。
 *
 * **存 `storage.local` 而不是 session**：源项目把它放在 GM 存储里（持久），语义是
 * 「这件事还没做完」。推送是用户可见的结果（MediaCenter 里有没有这条记录），
 * 不该因为浏览器重启就丢掉。成功或超过重试上限即删除，不会无限增长。
 */
export const MEDIA_CENTER_PUSH_KEY = 'mediaCenterPushPending'

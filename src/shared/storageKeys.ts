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

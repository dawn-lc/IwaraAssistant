/**
 * Background —— 装配层：事件监听注册 + 启动恢复 + 消息路由。
 * Chrome: manifest.background.service_worker；Firefox: manifest.background.scripts（MV2 持久后台页）
 * 构建：单文件 IIFE；禁用常驻内存假设——状态先持久化再处理（docs/01 挂起协议）
 *
 * 本文件不 import globals shim：esbuild `inject` 已保证其最先执行。
 *
 * ## 目录约定（background 下只有本文件 + 5 个领域目录，新文件按职责归位，不要平铺）
 *
 * | 目录        | 装什么                                                     |
 * | ----------- | ---------------------------------------------------------- |
 * | `storage/`  | 本地状态唯一真源：配置、队列、IndexedDB、解析、回填列表       |
 * | `iwara/`    | 与 iwara 站点交互：身份、视频 API、评论、社交、同步、MediaCenter |
 * | `download/` | 下载编排：解析调度、四通道投递、路径模板、批量、卡片元数据     |
 * | `backends/` | 各下载后端的连接与对账（`aria2/`、`iwaradl/`）                |
 * | `runtime/`  | 扇主平台能力：alarms、通知、剪贴板、右键菜单、保活、钓鱼防护    |
 *
 * 依赖方向是「领域间受控」而不是严格分层：`runtime/notify` 是横切能力（谁都能发通知），
 * 所以允许 `iwara/` 引用 `runtime/`。但 `storage/` 不得引用其它领域——它是底座。
 */
import { onMessage } from '../messaging/hub'
import type { Req } from '../messaging/protocol'
import { siteUrl } from '../shared/site'
import { getLanguage, watchLanguage, i18n } from '../shared/i18n'
import { db, countStores, readStorePage } from './storage/db'
import { configReady, getConfig } from './storage/configStore'
import { loadQueue, findTask, notifyTask, syncTask, updateBadge } from './storage/queue'
import { pageReadySnapshot } from './storage/pageReady'
import { importLegacyDb, recordLegacyProgress, recordLegacyScan, storeLegacyBatch } from './storage/legacyImport'
import { clearFinishedTasks, removeTaskById, retryAllFailed, retryTaskById, syncDownloadTasks } from './download/queueActions'
import { readBackendStats } from './download/backendStats'
import { reconcileStaleRunningTasks } from './storage/queueReconcile'
import { runDownload } from './download/dispatch'
import { adoptHandedOffDownload } from './download/adopt'
import { syncIwaradlTasks } from './backends/iwaradl/tracker'
import { syncIwaradlAlarm } from './backends/iwaradl/client'
import { syncAria2ProbeAlarm } from './backends/aria2/tracker'
import { flushMediaCenterPushes } from './iwara/mediaCenterPushQueue'
import { downloadMetadata } from './download/downloaders'
import { onContextMenuClicked, setupContextMenus } from './runtime/contextMenus'
import { recordAuthToken, recordPageCookie } from './iwara/auth'
import { setupAlarms } from './runtime/alarms'
import { syncKeepAlive } from './runtime/keepAlive'
import { startAria2Tracking, watchAria2Endpoint } from './backends/aria2/tracker'
import { consumeNotificationTarget, notifyInfo } from './runtime/notify'
import { readFriendApproveProgress, startFriendApproval } from './iwara/friendApprove'
import { parseUnlistedAndPrivate, readSyncState, syncAllVideosPages, ingestPageVideos } from './iwara/pageSync'
import { syncCachedToMediaCenter } from './iwara/mediaCenter'
import { promoteAuthor } from './iwara/promoteAuthor'
import { removePlaylistItems } from './iwara/playlists'
import { checkLinkReachable } from './iwara/linkCheck'
import { check } from './download/envCheck'
import { copyText } from './runtime/clipboard'
import { getCardMeta } from './storage/cardMeta'
import { startBatchDownload } from './download/batch'
import { pumpBrowserQueue } from './download/browserQueue'
import { installGuardWatchers, reconcileGuardRules, releaseGuard, syncGuard } from './runtime/guardRules'
import type { GuardMode } from '../shared/guardRule'

// 队列（唯一写者，storage/queue.ts）与配置（CONFIG 通道，storage/configStore.ts）

// ── 事件驱动：browser 通道下载状态机（替代 GM_download onload/onerror）──
// notifications 是唯一反馈通道（docs/05）：完成/失败一条通知，无页内 toast

browser.downloads.onChanged.addListener((delta) => {
    void (async () => {
        if (!delta.state) return
        const task = findTask({ kindRef: String(delta.id), kind: 'browser' })
        if (!task) return
        if (delta.state.current === 'complete') task.status = 'complete'
        if (delta.state.current === 'interrupted') {
            task.status = 'failed'
            task.detail = delta.error?.current
        }
        await syncTask(task)
        if (task.status === 'complete' || task.status === 'failed') await notifyTask(task)
        // 槽位空出来了：「同时下载数」排队中的任务据此自动启动（见 download/browserQueue.ts）
        if (task.status === 'complete' || task.status === 'failed') void pumpBrowserQueue()
    })()
})

/**
 * others 通道的接管点。`others` 只是给浏览器开了个直链标签页，浏览器下载它时
 * `downloads` 里会出现一条记录（带我们注入的 `videoid`）——那就能纳回队列追踪。
 * 详见 `download/adopt.ts`（含为什么接管后 kind 改成 browser）。
 */
browser.downloads.onCreated.addListener((item) => {
    if (typeof item.url !== 'string' || item.id === undefined) return
    void adoptHandedOffDownload({ id: item.id, url: item.url }).catch((error: unknown) => {
        console.warn('[iwara-assistant] others 接管失败：', error instanceof Error ? error.message : error)
    })
})

/**
 * 点击通知 → 打开它登记过的页面，并丢掉登记项。
 *
 * 目标在创建通知时登记在 `storage.session`（见 notify.ts），所以这条链路能跨 SW 回收：
 * 不能把动作写成创建时的闭包，`onClicked` 可能发生在几十分钟之后。
 * 没登记的通知（理论上只剩旧版本残留）点击无操作，不抛错。
 */
browser.notifications.onClicked.addListener((notificationId) => {
    void (async () => {
        const target = await consumeNotificationTarget(notificationId)
        if (!target) return
        // 开了 autoCopySaveFileName 的通知（目前只有「发现第三方网盘链接」）在**点击时**复制：
        // 源项目把这个动作挂在提示的「打开视频链接」按钮上——点它才表示用户决定改用外部下载器。
        if (target.kind === 'url' && target.copyText !== undefined) await copyText(target.copyText)
        const url = target.kind === 'options' ? browser.runtime.getURL(`options/index.html#${target.tab}`) : target.url
        await browser.tabs.create({ url, active: true })
    })()
})

// ── 启动恢复（挂起重入 / 浏览器重启 onStartup）────────────────────────

async function boot(): Promise<void> {
    // 先等配置落盘读完：getConfig() 在此之前返回的是 DEFAULT_CONFIG 副本，
    // 用户把「关注扩展作者」关掉后，这里若不等待就会按默认值（true）执行一次
    await configReady
    // 语言同理：右键菜单标题在 setupContextMenus() 里就固化了，必须先拿到用户选择
    await watchLanguage()
    await loadQueue()
    updateBadge()
    // 上一代进程（SW 回收 / 浏览器崩溃）留下的 `running` 其实是僵尸：下载器早没了，
    // 但 `running` 不可移除、挡住重下。先把本地的账算清，再交给 aria2 扫描处理远端。
    await reconcileStaleRunningTasks()
    await setupContextMenus()
    watchMenuLanguage()
    setupAlarms()
    // 保活开关（默认关闭；Firefox MV2 的持久后台页不需要，syncKeepAlive 自己会跳过）
    await syncKeepAlive(getConfig().keepBackgroundAlive)
    // aria2：记住端点指纹（配置变更时由 tracker 自己比对并重连）+ 首轮对账
    watchAria2Endpoint(getConfig())
    await startAria2Tracking()
    // 慢速判定需要分钟级采样（源项目每任务 4 秒轮询）：按队列对齐轻探测 alarm
    await syncAria2ProbeAlarm()
    // 上一代进程留下的「推送 MediaCenter 失败」待重试（源项目同样不丢）
    void flushMediaCenterPushes()
    // iwaradl 只能拉：先按队列对齐 alarm 存在性（空闲时不该有这个 alarm），再跑首轮
    await syncIwaradlAlarm()
    void syncIwaradlTasks()
    // 钓鱼防护的 session 规则会跨 SW 回收存活：醒来先清掉「标签页已经不在仿冒站」的残留
    await reconcileGuardRules()
    // 上一代进程可能留在「排队中」的浏览器任务（同时下载数上限）：内存快照已丢，
    // 泵会重新解析后启动它们。不跑这一步，这些任务会永远停在排队中。
    void pumpBrowserQueue()
    console.info(`[iwara-assistant] background up (${hostLabel()})`)
    // 关注扩展作者（默认开启；内部有状态闸门，已完成/未登录时零网络请求）
    if (getConfig().promoteScriptAuthor) void promoteAuthor()
}

function hostLabel(): string {
    // Firefox 产物是 MV2 持久后台页（manifest/variants.ts），不是事件页
    return navigator.userAgent.includes('Firefox') ? 'firefox-background-page' : 'chrome-service-worker'
}

/**
 * 语言变化后重建右键菜单。
 *
 * 菜单标题在建菜单时就固化进浏览器，无法后续改名；`watchLanguage` 已在 boot 里注册，
 * 它的监听器先于这里执行，所以读到的是**已更新**的语言。
 */
let menuLanguage = ''
let menuWatchBound = false
function watchMenuLanguage(): void {
    menuLanguage = getLanguage()
    if (menuWatchBound) return
    menuWatchBound = true
    browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !('config' in changes)) return
        const next = getLanguage()
        if (next === menuLanguage) return
        menuLanguage = next
        void setupContextMenus()
    })
}

browser.runtime.onStartup.addListener(() => void boot())

browser.runtime.onInstalled.addListener((details) => {
    console.info('[iwara-assistant] onInstalled:', details.reason)
    // 首次运行浮层的替代（docs/01）：install / update 都打开使用引导，install 时聚焦
    if (details.reason === 'install' || details.reason === 'update') {
        const focus = details.reason === 'install'
        void browser.tabs.create({ url: browser.runtime.getURL('options/index.html#guide'), active: focus })
    }
})

void boot()

// ── 消息路由（hub：sendResponse 兼容模式）────────────────────────────
// 本 switch 只做派发：每个分支一行，实现体都在各领域目录里。
onMessage<Req>(async (req, sender) => {
    switch (req.type) {
        case 'INGEST_VIDEO_INFO':
            return ingestPageVideos(req.payload)
        case 'PAGE_READY':
            return pageReadySnapshot()
        case 'INGEST_AUTH':
            return recordAuthToken(req.payload.kind, req.payload.token)
        case 'INGEST_COOKIE':
            return recordPageCookie(req.payload)
        case 'GET_COOKIE':
            return null // 后台不反向询问；cookie 由 ISOLATED 主动上行
        case 'INIT_DOWNLOAD':
        case 'DOWNLOAD':
            return runDownload({
                videoId: req.type === 'INIT_DOWNLOAD' ? req.payload.videoId : req.payload.video.ID,
                kind: req.payload.kind,
                video: req.type === 'DOWNLOAD' ? req.payload.video : undefined,
                overwrite: req.payload.overwrite,
                pageType: req.payload.pageType
            })
        case 'BATCH_DOWNLOAD':
            return startBatchDownload(req.payload.videoIds, sender.tab?.id, req.payload.pageType)
        case 'FORCE_DOWNLOAD':
            // 任务列表里 `skipped` 行的「强制下载」：显式绕开「简介/评论里有第三方网盘链接」那道门。
            // 源项目不需要这条（用户在视频详情页点下载时页型是 Video，门自己就不生效），
            // 扩展的任务列表不在页面上，只能显式声明意图。
            return runDownload({ videoId: req.payload.videoId, pageType: req.payload.pageType, skipLinkCheck: true })
        case 'APPROVE_FRIEND_REQUESTS':
            return startFriendApproval()
        case 'GET_FRIEND_APPROVE_STATE':
            return readFriendApproveProgress()
        case 'SYNC_ALL_VIDEOS':
            return syncAllVideosPages()
        case 'SYNC_SUBSCRIBED':
            return parseUnlistedAndPrivate()
        case 'GET_SYNC_STATE':
            return readSyncState()
        case 'SYNC_MEDIA_CENTER':
            return syncCachedToMediaCenter()
        case 'REMOVE_PLAYLIST_ITEMS': {
            const result = await removePlaylistItems(req.payload.playlistId, req.payload.videoIds)
            if (result.error) throw new Error(result.error)
            // 点通知回到那个播放列表：用户刚删的条目就在那里，刷新一下就能核对
            notifyInfo('playlist-removed', i18n.t('notify.playlistRemoved', { n: result.removed, failed: result.failed }), { kind: 'url', url: siteUrl(`/playlist/${req.payload.playlistId}`) })
            return result
        }
        case 'DOWNLOAD_METADATA':
            await downloadMetadata(req.payload.video)
            return { downloaded: true }
        case 'GET_VIDEOS': {
            // 视频库查询：给 ids 精确取，否则按上传时间倒序取最近 N 条（options 视频库/任务面板消费）
            const ids = req.payload.ids
            if (ids && ids.length > 0) return db.getVideosByIds(ids)
            return db.getRecentVideos(Math.max(1, Math.min(req.limit ?? 50, 500)))
        }
        case 'GET_CONFIG':
            await configReady
            return getConfig()
        case 'CHECK_LINK':
            return checkLinkReachable(req.payload.url)
        case 'ENV_CHECK':
            return check()
        case 'GET_CARD_META':
            return getCardMeta(req.payload)
        case 'RETRY_TASK':
            return retryTaskById(req.payload.taskId)
        case 'REMOVE_TASK':
            return removeTaskById(req.payload.taskId)
        case 'CLEAR_FINISHED':
            return clearFinishedTasks()
        case 'RETRY_FAILED':
            return retryAllFailed()
        case 'SYNC_DOWNLOAD_TASKS':
            return syncDownloadTasks()
        case 'GET_BACKEND_STATS':
            return readBackendStats()
        // ── 旧脚本页面数据库迁移（实现见 storage/legacyImport.ts）─────────
        case 'LEGACY_DB_SCAN':
            return recordLegacyScan(req.payload)
        case 'LEGACY_DB_BATCH':
            return storeLegacyBatch(req.payload)
        case 'LEGACY_DB_PROGRESS':
            return recordLegacyProgress(req.payload)
        case 'IMPORT_LEGACY_DB':
            return importLegacyDb()
        case 'DB_EXPORT_PAGE':
            // 全量导出的分页读取：options 不得直接开扩展的 IndexedDB（视频库后台专属，docs/01）
            return readStorePage(req.payload.store, req.payload.after)
        case 'DB_STORE_COUNTS':
            return countStores()
        case 'GUARD_SYNC': {
            // 钓鱼防护：判定与封锁都在后台（页面的声称只是输入，必须复核）
            const tabId = sender.tab?.id
            const mode: GuardMode = tabId === undefined ? 'none' : await syncGuard(tabId, req.payload.host)
            return { mode }
        }
        case 'GUARD_RELEASE': {
            const tabId = sender.tab?.id
            if (tabId === undefined) return { released: false }
            await releaseGuard(tabId, req.payload.host)
            return { released: true }
        }
        default:
            throw new Error(`unknown message type: ${(req as { type?: string }).type ?? '∅'}`)
    }
})

browser.contextMenus.onClicked.addListener((info) => {
    void onContextMenuClicked(info)
})

// 钓鱼防护：标签页离开仿冒站/被关闭时撤掉网络层封锁（规则必须同步注册，事件页才能被唤醒）
installGuardWatchers()

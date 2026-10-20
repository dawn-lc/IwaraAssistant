/**
 * Background 骨架 —— 下载调度中枢
 * Chrome: manifest.background.service_worker；Firefox: manifest.background.scripts（事件页）
 * 构建：单文件 IIFE；禁用常驻内存假设——状态先持久化再处理（docs/01 挂起协议）
 */
import '../browser/globals'
import { onMessage } from '../messaging/hub'
import type { Req, DownloadKind, FullVideoInfo } from '../messaging/protocol'

// ── 队列（唯一写者）：storage 先落盘，内存副本可随时重建 ──────────────────
interface QueueTask {
    id: string
    videoId: string
    kind: DownloadKind
    status: 'queued' | 'running' | 'failed' | 'complete'
    kindRef?: string // aria2 gid / downloads.downloadId / iwaradl taskId
    filename?: string
}

const QUEUE_KEY = 'downloadQueue'
let memQueue: QueueTask[] = [] // 仅缓存；重入时从 storage 恢复

async function persist(): Promise<void> {
    await browser.storage.local.set({ [QUEUE_KEY]: memQueue })
}

async function loadQueue(): Promise<void> {
    const { [QUEUE_KEY]: stored } = await browser.storage.local.get(QUEUE_KEY)
    memQueue = Array.isArray(stored) ? stored : []
}

// ── 通道一：browser（downloads API）──────────────────────────────────
async function downloadBrowser(video: FullVideoInfo, overwrite: boolean): Promise<QueueTask> {
    const task: QueueTask = {
        id: crypto.randomUUID(),
        videoId: video.ID,
        kind: 'browser',
        status: 'running',
        // TODO: getDownloadPath 迁移 —— downloadPath 模板清洗后为相对路径
        filename: `Iwara/${video.Author}/${video.Title}[${video.ID}].mp4`.replace(/[\\:*?"<>|]/g, '_'),
    }
    void overwrite
    // blob/data/远程 URL 可直接下载；Firefox 子目录不支持（bug 1280044），
    // 上层调用者按 02 文档矩阵决定是否降级扁平文件名并提示
    browser.downloads
        .download({ url: video.DownloadUrl ?? '', filename: task.filename, conflictAction: 'uniquify' })
        .then((downloadId) => {
            task.kindRef = String(downloadId)
        })
        .catch(async (err) => {
            task.status = 'failed'
            task.filename = String(err)
            await persist()
        })
    memQueue.push(task)
    await persist()
    return task
}

// ── 通道二：aria2（RPC + WebSocket 保活）──────────────────────────────
// TODO: 迁移 aria2.ts（unlimitedFetch → 直接 fetch，无需 GM）；
//       WebSocket 通知替代轮询；sw 保活依赖 WS 帧（Chrome 116+），
//       Firefox 事件页由 WS 消息唤醒；alarm 兜底重连。

// ── 通道三：iwaradl ────────────────────────────────────────────────
// TODO: 迁移 download.ts iwaradlDownload（cookie 由页面经 INGEST 上行缓存）

// ── 事件驱动：下载状态机（替代 GM_download onload/onerror）────────────
// 通知策略（docs/03/05）：notifications 是唯一反馈通道——
//   批量入队按任务键去重聚合成单条；onClicked 打开侧栏任务面板；
//   用户 OS 层关闭通知时降级为静默 + 角标计数，不回退页内 toast
browser.downloads.onChanged.addListener(async (delta) => {
    if (delta.state) {
        const task = memQueue.find((t) => t.kindRef === String(delta.id))
        if (!task) return
        if (delta.state.current === 'complete') task.status = 'complete'
        if (delta.state.current === 'interrupted') task.status = 'failed'
        await persist()
        browser.notifications.onClicked.addListener(() => {
            window.open(browser.runtime.getURL('options/index.html#tasks'))
        })
        await browser.notifications.create(task.videoId, {
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/icon-128.png'),
            title: 'Iwara Assistant',
            message: `视频 [${task.videoId}] ${task.status === 'complete' ? '下载完成' : '下载失败'}`,
        })
        updateBadge()
    }
})

function updateBadge(): void {
    const running = memQueue.filter((t) => t.status === 'running' || t.status === 'queued').length
    browser.action.setBadgeText({ text: running > 0 ? String(running) : '' })
}

// ── alarms：替代 aria2Track 的三个 setInterval（docs/01 定时任务清单）──
async function ensureAlarms(): Promise<void> {
    await browser.alarms.create('scan-aria2', { periodInMinutes: 5 })
    await browser.alarms.create('ws-keepalive', { periodInMinutes: 2 })
}
browser.alarms.onAlarm.addListener((alarm) => {
    void (async () => {
        if (alarm.name === 'scan-aria2') await scanAria2()
        if (alarm.name === 'ws-keepalive') await keepAliveWs()
    })()
})
async function scanAria2(): Promise<void> {
    /* TODO: aria2 TellActive/TellStopped → diff 入队（原 scanAria2TasksAndEnqueue） */
}
async function keepAliveWs(): Promise<void> {
    /* TODO: WS 断开则重连（指数退避） */
}

// ── 启动恢复（含浏览器重启 onStartup）────────────────────────────────
async function boot(): Promise<void> {
    await loadQueue()
    await ensureAlarms()
    updateBadge()
}
browser.runtime.onStartup.addListener(boot)

// ── 消息路由（hub：sendResponse 兼容模式）────────────────────────────
onMessage<Req>(async (req) => {
    switch (req.type) {
        case 'INGEST_VIDEO_INFO':
            return ingestVideos(req.payload.videos)
        case 'INGEST_AUTH':
            return ingestAuth(req.payload)
        case 'GET_COOKIE':
            /* cookie 来自页面转发，后台无需读取 */ return null
        case 'DOWNLOAD':
            return downloadBrowser(req.payload.video, req.payload.overwrite ?? false)
        case 'GET_VIDEOS':
            return queryVideos(req.payload.ids ?? [])
        case 'GET_CONFIG':
            return browser.storage.local.get('config')
        case 'CHECK_LINK':
            return checkLink(req.payload.url)
        default:
            throw new Error('unknown message')
    }
})

async function ingestVideos(videos: unknown[]): Promise<unknown> {
    /* TODO: 迁移 core/db.ts + parseVideoInfo —— IndexedDB 入库 */
    return { ingested: videos.length }
}
async function ingestAuth(p: { kind: string; token: string }): Promise<unknown> {
    /* TODO: 迁移 network/auth.ts 的令牌缓存 */
    return p.kind
}
async function queryVideos(ids: string[]): Promise<unknown> {
    /* TODO: db.getVideosByIds */
    return { ids }
}
async function checkLink(url: string): Promise<unknown> {
    /* TODO: download/linkCheck.ts 迁移（fetch + HEAD） */
    return url
}

void boot()

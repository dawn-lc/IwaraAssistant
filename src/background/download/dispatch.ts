/**
 * 下载分派 —— DOWNLOAD / INIT_DOWNLOAD 的统一入口（原 downloadFlow.ts 分派段）
 *
 * 流程：full 解析（缺省时后台补齐）→ 入队 → 通道执行 → 状态推落盘+推送。
 *
 * 状态收敛（`status` 何时离开 `running`）取决于通道能不能回传结果（`channelTracksResult`）：
 * - `browser`：`downloads.onChanged` 事件驱动（index.ts）
 * - `aria2`：WS 通知 + 扫描对账（trackers/aria2）
 * - `iwaradl` / `others`：投递即终态 `handed-off` —— 它们只是把活交出去，
 *   没有任何回传通道；留在 `running` 会让任务永远「进行中」且永远不可移除。
 */
import type { DownloadKind } from '../../messaging/protocol'
import { getConfig } from '../storage/configStore'
import { i18n } from '../../shared/i18n'
import { siteUrl } from '../../shared/site'
import { addTask, getTasks, notifyTask, removeSkippedFor, syncTask } from '../storage/queue'
import type { QueueTask } from '../../shared/task'
import { channelTracksResult } from '../../shared/task'
import type { FullVideoInfo } from '../../shared/videoInfo'
import { stringify } from '../../shared/strings'
import { uriExpiresAt } from '../../shared/url'
import { VideoParseError, parseVideoFull } from '../iwara/videoApi'
import { getDownloadPath } from './downloadPath'
import { aria2Download, browserDownload, browserDownloadErrorParse, downloadMetadata, iwaradlDownload, othersDownload, type ChannelContext } from './downloaders'
import { deferBrowserStart, hasFreeBrowserSlot } from './browserQueue'
import { followUser, likeVideo } from '../iwara/interactions'
import { checkIsHaveDownloadLink } from '../iwara/linkCheck'
import { notifyWarn } from '../runtime/notify'
import { db } from '../storage/db'
import { syncIwaradlAlarm } from '../backends/iwaradl/client'
import { syncAria2ProbeAlarm } from '../backends/aria2/tracker'
import type { PageType } from '../../shared/pageType'

/** 原 DownloadType 枚举 → 协议通道名 */
export function kindFromDownloadType(): DownloadKind {
    switch (getConfig().downloadType) {
        case 0:
            return 'aria2'
        case 1:
            return 'iwaradl'
        case 2:
            return 'browser'
        default:
            return 'others'
    }
}

interface DispatchPayload {
    videoId: string
    kind?: DownloadKind
    /** 预解析捷径（ISOLATED 后续可带；contextMenus 只有 ID） */
    video?: FullVideoInfo
    overwrite?: boolean
    cookie?: string
    /**
     * 发起页面的页型（`shared/pageType.ts`）。
     *
     * 只为一件事存在：`checkDownloadLink` 在**视频详情页不检查**
     * （源 `getPageTypeProbe() !== PageType.Video`）——用户正看着简介和评论区，提示等于废话。
     * 缺省（右键菜单这类无页面上下文的入口）按源的探针默认值 `PageType.Page` 处理，
     * 即「非视频页」，照常检查。
     */
    pageType?: PageType
    /**
     * 绕过「第三方网盘链接」检查（`FORCE_DOWNLOAD` 专用）。
     *
     * 源项目里这个能力是隐式的：用户在视频详情页点「下载当前视频」时页型是 Video，
     * 门自己就不生效。扩展的任务列表不在页面上、拿不到页型上下文，
     * 所以需要一条显式标志，而不是去伪造 `pageType: 'video'`（那等于让调用方撒谎）。
     */
    skipLinkCheck?: boolean
}

/** 主动放弃下载的原因——全部是源项目「命中即不下」的刻意设计 */
/**
 * 投递结果就是一条任务记录。
 *
 * **刻意不下载也落一条 `skipped` 任务**（源项目那里连记录都不建，只弹一条 toast）：
 * 系统通知做不了「自定义按钮 + 富文本 + hover 暂停」那套交互，所以把「你去看看这个视频」
 * 的入口搬到 options 的任务列表——那里能常驻、能点开视频页、也能一键强制下载。
 * 通知只是即时提醒，任务列表才是持久记录。
 */
export type DispatchOutcome = QueueTask

/**
 * 同一视频的推送进行中集合（对齐源 `pushDownloadTask` 的 `pushingVideoIds`）。
 *
 * 为什么必须有：`runDownload` 是异步的（要先 full 解析，几百毫秒到几秒），
 * 而队列记录是**解析成功之后**才 `addTask`。这中间任何人再推一次同一 ID，
 * 队列里去重查不到它，就会建出第二条任务 → aria2 里两个同源任务。
 * 典型触发：用户连点两次「下载所选」、或批量与单条下载撞在一起。
 *
 * 源项目还有一层跨页 `GMLock`（`pushDownloadTask:<id>`）防止两个标签页同时推送。
 * 本扩展不需要：后台是单实例（同一时刻只有一个 SW 在路由消息），**进程内互斥即跨页互斥**。
 * SW 被回收时进程内集合会丢，但那时已入队的任务在 storage 里，批量去重仍能兜住。
 */
const pushingVideoIds = new Set<string>()

/** 新建任务投递（ISOLATED/contextMenus/popup 统一入口；同 ID 已推在进行中时不再投递） */
export async function runDownload(payload: DispatchPayload): Promise<DispatchOutcome> {
    if (pushingVideoIds.has(payload.videoId)) {
        // 已在投递中：返回已有的那条（还没有就合成一条 queued 占位）。
        // 不抛错——批量循环把它当「该项已处理」即可，页面照样取消勾选。
        const existing = getTasks().find((task) => task.videoId === payload.videoId && task.status !== 'failed' && task.status !== 'skipped')
        return (
            existing ?? {
                id: `inflight-${payload.videoId}`,
                videoId: payload.videoId,
                kind: payload.kind ?? kindFromDownloadType(),
                status: 'queued',
                detail: i18n.t('notify.taskInProgress')
            }
        )
    }
    pushingVideoIds.add(payload.videoId)
    try {
        return await runDownloadInner(payload)
    } finally {
        pushingVideoIds.delete(payload.videoId)
    }
}

/**
 * 自带 full 快照能否直接复用。
 *
 * 除了「字段齐全」，还要看**下载地址是否过期**：iwara 的下载 URL 带 `expires`（秒），
 * 而快照可能是页面打开很久之前拦下来的——直接拿去下只会拿到 403（源项目没有这个问题：
 * 它对 `Type === 'full'` 也会重新拉一次 `/video/:id`）。
 *
 * 没有 `expires` 参数时视为「无法判断」→ **信任快照**（宁可试一次，也不每次无谓重解析：
 * 解析要打 1 次详情 + 1 次文件源 + N 次评论分页）。
 */
const SNAPSHOT_EXPIRY_MARGIN_MS = 60_000

function snapshotReusable(provided: FullVideoInfo | undefined): provided is FullVideoInfo {
    if (provided === undefined || provided.Type !== 'full') return false
    if (provided.DownloadUrl === undefined || provided.DownloadUrl === '') return false
    const expiresAt = uriExpiresAt(provided.DownloadUrl)
    if (!Number.isFinite(expiresAt)) return true
    return expiresAt * 1000 > Date.now() + SNAPSHOT_EXPIRY_MARGIN_MS
}

/**
 * 取到可用的 full 信息（源 `parseVideoInfo` + 画质门）。
 *
 * 画质门（源 `checkPriority && DownloadQuality !== downloadPriority`）只会在
 * 「调用方自带 full 快照」时命中：快照可能是旧配置下解析的，也可能解析后设置被改过。
 * 源的处理是弹提示、用户点一下才重新解析；后台没有交互位，直接重新解析拿当前画质——
 * 意图相同（绝不按错的画质下载），少一次点击。
 *
 * 重解析本身**不会再放过画质不符**：`parseVideoFull` 内部已按 `downloadPriority` 选源，
 * 站点没有那个画质时直接抛 `No video source matches the priority`。
 */
async function resolveVideo(payload: DispatchPayload): Promise<FullVideoInfo> {
    let video = snapshotReusable(payload.video) ? payload.video : await parseVideoFull(payload.videoId)

    const config = getConfig()
    if (config.checkPriority && video.DownloadQuality !== config.downloadPriority) {
        video = await parseVideoFull(payload.videoId)
    }
    return video
}

/**
 * 解析成功后的自动化动作（源 `case 'full'` 前段）：先入库，再自动关注/点赞。
 *
 * 顺序与源一致且**全部 await**：源在两道门之前就做完了这些事，
 * 所以「因为发现网盘链接而不下载」时，视频已入库、已关注/已点赞也已经生效（不可回滚）。
 */
async function persistAndSocialActions(video: FullVideoInfo): Promise<void> {
    await db.putVideo(video)

    const config = getConfig()
    // 判据与源一致：库内关注表**或**这次解析出的 user.following 任一为假就补关注。
    // 只看 `video.Following` 会在「库里已关注、但接口返回的 user 字段陈旧」时多打一次关注接口。
    const authorInfo = await db.getFollowById(video.AuthorID)
    if (config.autoFollow && (!authorInfo?.following || !video.Following)) {
        if (await followUser(video.AuthorID)) {
            video.Following = true
            const raw = video.RAW
            if (raw?.user) {
                raw.user.following = true
                await db.putFollow(raw.user)
            }
        } else {
            // 源同样会提示（`autoFollowFailed`）：静默失败会让用户以为已经关注上了
            notifyWarn(`auto-follow-${video.ID}`, i18n.t('notify.autoFollowFailed', { alias: video.Alias }), { kind: 'url', url: siteUrl(`/profile/${video.Author}`) })
        }
    }
    if (config.autoLike && !video.Liked) {
        if (await likeVideo(video.ID)) video.Liked = true
        else notifyWarn(`auto-like-${video.ID}`, i18n.t('notify.autoLikeFailed', { alias: video.Alias }), { kind: 'url', url: siteUrl(`/video/${video.ID}`) })
    }
}

/**
 * 是否该因「简介/评论里有第三方网盘链接」而不下载。
 *
 * 源项目的刻意设计：非视频页 + 开关开启 + 命中 → **不创建下载**，只弹提示，
 * 让用户自己决定是继续用脚本下载、还是去那个第三方网盘下。
 * 视频详情页不检查：用户正看着简介和评论区，再提示他「去看简介」等于废话。
 * 这也正是任务列表里 `skipped` 行「强制下载」按钮存在的原因——
 * 那条路径显式绕门，不是靠页型偷渡。
 */
function hasDownloadLink(video: FullVideoInfo, pageType: PageType | undefined): boolean {
    // 源探针缺省是 PageType.Page（非视频页）→ 无页面上下文的入口照常检查
    if (pageType === 'video') return false
    // haystack 与源逐字一致：简介 + 空格 + 评论数组 JSON
    return checkIsHaveDownloadLink(`${video.Description ?? ''} ${video.Comments ?? ''}`)
}

async function runDownloadInner(payload: DispatchPayload): Promise<DispatchOutcome> {
    const kind = payload.kind ?? kindFromDownloadType()
    const ctx: ChannelContext = { cookie: payload.cookie, overwrite: payload.overwrite }

    // full 解析（payload 已带 full 信息则直用；原 downloadFlow 同构）
    let video: FullVideoInfo
    try {
        video = await resolveVideo(payload)
    } catch (error) {
        const failInfo = error instanceof VideoParseError ? error.videoInfo : undefined
        const detail = failInfo?.Msg ?? stringify(error)
        // 外部视频（embedUrl）：源项目在失败提示里给一个「打开视频链接」按钮——
        // 因为我们根本不会去下载它，那个链接是唯一有用的信息。
        const externalUrl = failInfo?.ExternalUrl !== undefined && failInfo.ExternalUrl !== '' ? failInfo.ExternalUrl : undefined
        const task = await addTask({
            id: crypto.randomUUID(),
            videoId: payload.videoId,
            kind,
            status: 'failed',
            detail: i18n.t('error.parseFailed', { detail }),
            ...(externalUrl === undefined ? {} : { followUpUrl: externalUrl })
        })
        await notifyTask(task)
        return task
    }

    // 源顺序：入库 + 社交动作 → 两道门 → 投递
    await persistAndSocialActions(video)

    const filename = getDownloadPath(video).fullName

    // 门 ①：第三方网盘链接（命中即不下）
    // 落一条 `skipped` 任务而不是直接返回：系统通知做不了源项目那套
    // 「按钮 + 富文本 + 常驻」交互，改成把入口搬进 options 任务列表（可点开视频页 / 可强制下载）。
    if (payload.skipLinkCheck !== true && hasDownloadLink(video, payload.pageType)) {
        const task = await addTask({
            id: crypto.randomUUID(),
            videoId: video.ID,
            kind,
            status: 'skipped',
            detail: i18n.t('tasks.skippedDetail'),
            followUpUrl: siteUrl(`/video/${video.ID}`),
            // 源项目点「打开视频链接」会顺手把保存文件名写进剪贴板；这里同样记下来，
            // 通知点击时复制（是否复制由 autoCopySaveFileName 在 notifyTask 里判断）
            filename
        })
        await notifyTask(task)
        return task
    }

    // 真的要下了：先清掉同视频的 `skipped` 待办。
    // 一条视频同时存在「已跳过」与「下载中」两条记录会让任务列表自相矛盾
    // （用户不知道该看哪条）；`failed` / `complete` 不清——前者靠重试复用、
    // 后者是历史记录。
    await removeSkippedFor(video.ID)

    const task = await addTask({
        id: crypto.randomUUID(),
        videoId: video.ID,
        kind,
        status: 'running',
        filename
    })
    return executeChannels(task, video, ctx)
}

/** 对既有队列任务重新执行（retry-failed alarm 用）：重解析（URL expires 短）后原记录复跑 */
export async function retryTask(task: QueueTask): Promise<QueueTask> {
    const ctx: ChannelContext = { overwrite: true }
    let video: FullVideoInfo
    try {
        video = await parseVideoFull(task.videoId)
    } catch (error) {
        task.attempts = (task.attempts ?? 0) + 1
        task.detail = i18n.t('error.retryParseFailed', { message: error instanceof VideoParseError ? (error.videoInfo.Msg ?? error.message) : stringify(error) })
        await syncTask(task)
        return task
    }
    task.status = 'running'
    task.kindRef = undefined
    task.detail = undefined
    // 进度属于「上一次尝试」：不清掉的话，重试后界面会从上一轮的 80% 开始显示
    task.progress = undefined
    task.filename = getDownloadPath(video).fullName
    await syncTask(task)
    return executeChannels(task, video, ctx)
}

/** 通道执行 + 元数据 + 状态推落盘/通知（runDownload 与 retryTask 共用的后半段） */
async function executeChannels(task: QueueTask, video: FullVideoInfo, ctx: ChannelContext): Promise<QueueTask> {
    /*
     * 浏览器内建下载的「同时下载数」闸门。
     *
     * 放在这里而不是 `browserDownload` 里面，是因为它必须在**投递之前**决定
     * 「现在就下」还是「排队」：`downloads.download()` 一返回，传输就在浏览器里跑起来了，
     * 事后再挡已经晚了。
     *
     * 排队**不是失败也不是丢弃**：任务落成 `queued` 入队，`browserQueue` 的泵在
     * 有槽位空出（`downloads.onChanged` 收到终态）时自动启动它。返回到调用方仍然是
     * 这条任务，批量下载因此可以立即拿到汇总并继续下一项。
     */
    if (task.kind === 'browser' && !hasFreeBrowserSlot(task.id)) {
        task.status = 'queued'
        task.detail = i18n.t('tasks.waitingSlot', { n: getConfig().browserConcurrentDownloads })
        await syncTask(task)
        deferBrowserStart(task, video, ctx)
        return task
    }
    try {
        switch (task.kind) {
            case 'aria2': {
                const ref = await aria2Download(video, ctx)
                task.kindRef = ref.gid
                // 慢速判定需要分钟级采样（源项目每任务 4 秒轮询），只拉 tellActive 的轻探测
                void syncAria2ProbeAlarm()
                break
            }
            case 'iwaradl': {
                const ref = await iwaradlDownload(video, ctx)
                task.kindRef = ref.taskId
                // iwaradl 有任务 API（GET /api/tasks）：投递后开轮询，完成后自动收敛终态。
                // 只在有活跃任务时存在，见 iwaradl.ts 的 syncIwaradlAlarm
                void syncIwaradlAlarm()
                break
            }
            case 'browser': {
                const ref = await browserDownload(video, ctx)
                task.kindRef = String(ref.downloadId)
                break
            }
            case 'others': {
                const ref = await othersDownload(video, ctx)
                task.kindRef = String(ref.tabId)
                break
            }
        }
        const cfg = getConfig()
        if (cfg.autoDownloadMetadata && (task.kind === 'browser' || task.kind === 'others')) {
            await downloadMetadata(video).catch((err) => {
                console.warn('[iwara-assistant] metadata download failed:', err)
            })
        }
        // 交付型通道（iwaradl / others）没有回传通道：投递成功就是终态。
        // 不能记 `complete`（文件可能根本没下成，且会被去重当成「已下载」而吞掉重下意图），
        // 也不能留在 `running`（永远进行中、永远不可移除）。
        if (!channelTracksResult(task.kind)) {
            task.status = 'handed-off'
            task.detail = i18n.t(task.kind === 'iwaradl' ? 'tasks.handedOffIwaradl' : 'tasks.handedOffOthers')
        }
    } catch (error) {
        task.status = 'failed'
        // browser 通道的失败原因需要翻译（源 browserDownloadErrorParse）；其他通道原始信息已可读
        task.detail = task.kind === 'browser' ? browserDownloadErrorParse(error) : stringify(error)
        await syncTask(task)
        await notifyTask(task)
        return task
    }
    await syncTask(task)
    return task
}

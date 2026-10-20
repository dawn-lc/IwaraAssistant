/**
 * 类型化消息协议 —— 后台 / content / options 共用的单一事实源
 * 详见 docs/04-messaging.md
 */

import type { FullVideoInfo as DbFullVideoInfo } from '../shared/videoInfo'
import type { LegacyCounts, LegacyImportProgress, LegacyStore } from '../shared/legacyDb'
import type { PageType } from '../shared/pageType'

/** 全量视频信息（下载负载）——直接沿用视频库全量记录形态 */
export type FullVideoInfo = DbFullVideoInfo

/** MAIN 世界改写所需的配置子集（经 CONFIG_SYNC 下行，JSON 通道可序列化） */
export interface PageConfig {
    filterLikedVideos: boolean
    filterUnlistedAndPrivate: boolean
    addUnlistedAndPrivate: boolean
}

/** 缓存回填列表载荷（后台预计算，MAIN 世界纯合并，docs/01 注入最小化） */
export interface CacheInjection {
    windowStart: number
    windowEnd: number
    raws: unknown[]
}

/** PAGE_READY 响应：页面引动所需初始数据（配置快照 + 当前回填列表） */
export interface PageReadyData {
    pageConfig: PageConfig
    cacheList: CacheInjection | null
}

/** 卡片元数据查询项（页内只需要 ID + 作者用户名，其余后台查库） */
export interface CardMetaQuery {
    id: string
    /** 作者用户名（用于 .follow 角标判定；页内从 a.username 解析） */
    author?: string
}

/** 单张卡片的补充元数据（后台本地库只读，不连外网） */
export interface CardMeta {
    id: string
    /**
     * 库里的标题/作者别名/作者用户名（Title/Alias/Author）。
     * **优先级对齐源项目 `ui/widgets/checkbox.ts`**：`hasFullInfo ? info.Title : DOM 值`
     * ——库里有记录时用库里的（更完整，含 API 原始字段），没有时页内用 DOM 可见值兑底。
     */
    name?: string
    alias?: string
    author?: string
    /** 入库记录里的绝对上传时间（源项目 videoUploadTime 属性）；库中无记录则缺省 */
    uploadTime?: number
    /** 已关注该作者 → 显示 .follow 角标 */
    following: boolean
    /** MediaCenter 已有该视频 → 显示 .downloaded 角标 */
    downloaded: boolean
}

/** GET_CARD_META 响应 */
export interface CardMetaResult {
    items: CardMeta[]
    /** 当前用户是否该播放列表所有者（决定是否渲染每卡片 .deleteButton） */
    canDeletePlaylistItem: boolean
}

export type DownloadKind = 'browser' | 'aria2' | 'iwaradl' | 'others'

/** 页面 → 后台 的请求 */
export type Req =
    | {
          type: 'INGEST_VIDEO_INFO'
          payload: {
              videos: unknown[]
              source: 'fetch-intercept'
              /** 当前页时间窗（本页非外链结果 UploadTime min/max ±4h，同原实现；后台据此预计算回填列表） */
              window?: { start: number; end: number }
          }
      }
    | { type: 'INGEST_AUTH'; payload: { kind: 'access' | 'refresh'; token: string } }
    /**
     * 页面侧事实上行（cookie + 内容分级）。
     *
     * `rating` 是源项目 `LS_KEY_RATING`：用户在本站选的分级筛选，订阅流遍历需要带上它，
     * 否则服务端会用默认分级返回用户平时看不到的内容（或漏掉他允许的内容）。
     */
    | { type: 'INGEST_COOKIE'; payload: { cookie: string; rating?: string } }
    | { type: 'GET_COOKIE'; payload: Record<string, never> }
    /** 发起下载：仅有视频 ID 时后台自动补全解析（contextMenus / 页面按钮共用）*/
    | { type: 'INIT_DOWNLOAD'; payload: { videoId: string; kind?: DownloadKind; overwrite?: boolean; pageType?: PageType } }
    | { type: 'DOWNLOAD'; payload: { kind?: DownloadKind; video: FullVideoInfo; overwrite?: boolean; pageType?: PageType } }
    | { type: 'DOWNLOAD_METADATA'; payload: { video: FullVideoInfo } }
    /** 视频库查询：给 ids 则按 ID 取，否则按 UploadTime 倒序取最近 limit 条 */
    | { type: 'GET_VIDEOS'; payload: { ids?: string[] }; limit?: number }
    | { type: 'GET_CONFIG'; payload: Record<string, never> }
    /** 页面就绪：ISOLATED 启动时请求配置快照与回填列表（HELLO 握手后首推） */
    | { type: 'PAGE_READY'; payload: Record<string, never> }
    /** 链接可达性检查（HEAD，超时 10s；仅 http/https） */
    | { type: 'CHECK_LINK'; payload: { url: string } }
    /**
     * 环境自检（源 `check()`）：路径模板 → 按当前下载通道探测端点。
     *
     * options 页加载与用户点「测试」时调用；**不在 `boot()` 里跑**：
     * service worker 约 30 秒空闲就挂起，boot 每次唤醒都会重跑，
     * 在那里面做网络探测等于每 30 秒打一次 aria2。
     */
    | { type: 'ENV_CHECK'; payload: Record<string, never> }
    /** 卡片角标/上传时间/所有者判定（页内 UI 批量查询，后台本地库只读） */
    | { type: 'GET_CARD_META'; payload: { cards: CardMetaQuery[]; playlistId?: string } }
    /** 批量下载（页内选择模式 / 手动 ID 输入）：后台串行入队，逐条返回结果 */
    | { type: 'BATCH_DOWNLOAD'; payload: { videoIds: string[]; pageType?: PageType } }
    /**
     * 好友请求一键审批（options 好友页触发）。
     *
     * 只回 `{ started, error? }`，**不返回审批结果**：耗时可能超过消息通道的
     * 单事件上限（Chrome 5 分钟），结果经 `GET_FRIEND_APPROVE_STATE` 的快照送达。
     */
    | { type: 'APPROVE_FRIEND_REQUESTS'; payload: Record<string, never> }
    /** 读取好友审批快照（options 好友页轮询；含运行进度与上次终态结果） */
    | { type: 'GET_FRIEND_APPROVE_STATE'; payload: Record<string, never> }
    /** 全站视频列表遍历入库 */
    | { type: 'SYNC_ALL_VIDEOS'; payload: Record<string, never> }
    /** 订阅页私有/不公开视频遍历入库 */
    | { type: 'SYNC_SUBSCRIBED'; payload: Record<string, never> }
    /** 读取批量遍历进度（options 任务页轮询） */
    | { type: 'GET_SYNC_STATE'; payload: Record<string, never> }
    /** MediaCenter 批量同步（库内 full 记录） */
    | { type: 'SYNC_MEDIA_CENTER'; payload: Record<string, never> }
    /** 从播放列表移除选中视频（页内菜单；仅列表所有者可执行） */
    | { type: 'REMOVE_PLAYLIST_ITEMS'; payload: { playlistId: string; videoIds: string[] } }
    /**
     * 手动重试单条任务（重置 attempts，不受 alarm 上限约束）。
     *
     * **不接受 `skipped`**：重试会重新解析并再过一次 `checkDownloadLink`，
     * 命中后又是 `skipped`——用户看到的就是「点了没反应」。跳过任务只能走 `FORCE_DOWNLOAD`。
     */
    | { type: 'RETRY_TASK'; payload: { taskId: string } }
    /**
     * 绕过「第三方网盘链接」检查直接下载（任务列表里 `skipped` 行的「强制下载」）。
     *
     * 源项目里这个能力是隐式的：用户在视频详情页直接点「下载当前视频」
     * （源 `getPageTypeProbe() === Video` → 不检查）。扩展的任务列表不在页面上，
     * 拿不到那个页型上下文，所以必须有一条**显式**的绕门入口。
     */
    | { type: 'FORCE_DOWNLOAD'; payload: { videoId: string; pageType?: PageType } }
    /** 从队列移除单条已结束任务（running 不可移除） */
    | { type: 'REMOVE_TASK'; payload: { taskId: string } }
    /** 清除全部已结束（complete / failed）任务 */
    | { type: 'CLEAR_FINISHED'; payload: Record<string, never> }
    /** 批量重试全部失败任务（重置 attempts） */
    | { type: 'RETRY_FAILED'; payload: Record<string, never> }
    /**
     * 页面 origin 旧脚本数据库的检测结果（content script 上行，一次性）。
     * 后台存 storage.local.legacyDb，options 迁移页据此展示「检测到 N 条」。
     */
    | { type: 'LEGACY_DB_SCAN'; payload: { found: boolean; counts: LegacyCounts } }
    /**
     * 旧库数据分批回传（content script → 后台）：每批由后台校验后写入自己的库。
     * 必须分批：一条消息可能几百 KB 以上，整库一次传会触发消息体积上限。
     */
    | { type: 'LEGACY_DB_BATCH'; payload: { store: LegacyStore; records: unknown[] } }
    /** 导入进度（content script 读表时上报，后台落盘供 options 展示） */
    | { type: 'LEGACY_DB_PROGRESS'; payload: LegacyImportProgress }
    /**
     * 从旧脚本页面数据库导入（options 迁移页按钮触发；后台转发给 iwara 标签页读取）。
     * 显式触发而非自动：自动导入会在用户删数据后“复活”旧记录。
     */
    | { type: 'IMPORT_LEGACY_DB'; payload: Record<string, never> }
    /**
     * 全量导出的一页（options 迁移页 → 后台）。
     *
     * options **不得**直接打开扩展的 IndexedDB（后台专属，见 docs/01）——导出四张整表
     * 也必须经后台。单条消息装不下整表，所以按主键分页：`after` 是上一页最后一条的主键，
     * 响应见 `LegacyStorePage`（`nextAfter === null` 即读完该表）。
     */
    | { type: 'DB_EXPORT_PAGE'; payload: { store: LegacyStore; after?: string } }
    /**
     * 四张表的当前条数（options 导出前预取，用于把进度条做成确定态）。
     *
     * 为什么不复用 `DB_EXPORT_PAGE`：那要先把第一页数据读出来丢弃，而一页最大 16 MiB。
     * `count()` 只走索引不反序列化记录，几万条的表也是瞬时的。
     */
    | { type: 'DB_STORE_COUNTS'; payload: Record<string, never> }
    /**
     * 立即用 aria2 的真实状态对账队列（任务页「刷新状态」）。
     *
     * 必要性：队列的终态靠 WS 通知实时落盘，WS 断开期间完成的任务只能等 5 分钟的
     * `scan-aria2` alarm——用户不能接受「下载已完成，界面还在转」。给一个不靠定时器的
     * 手动对账入口，也让 e2e 能确定性地验证这条路径。
     */
    /**
     * 手动对账（任务页「刷新状态」）：aria2 与 iwaradl 一次性拉一遍终态。
     *
     * 名字不带 `ARIA2`：两个后端都跑，只叫 aria2 会让人以为 iwaradl 靠推送。
     */
    | { type: 'SYNC_DOWNLOAD_TASKS'; payload: Record<string, never> }
    /**
     * 读取两个守护进程后端的**容量与占用**（RPC 页「后端容量」）。
     *
     * 我们自己的队列只知道投递过什么；aria2 里可能还有外部/上一代任务占着它的并发槽位。
     * 不读这两个值，用户看到「同时下载数 3 却有 5 条在下」就无从解释；
     * 也分不清 aria2 的 `waiting`（排队中）与 `active`（真在下）。
     */
    | { type: 'GET_BACKEND_STATS'; payload: Record<string, never> }
    /**
     * 钓鱼防护：页面载入时向后台同步「本页该怎么处理」。
     *
     * 判定与封锁都在后台（`background/runtime/guardRules.ts`）：页面与 ISOLATED 的声称都不可全信，
     * 而且真正能拦住 `img` / `beacon` / 表单 / 跨域 iframe 的是扩展的网络层（DNR session 规则）。
     * 响应 `{ mode: 'armed' | 'released' | 'none' }`。
     */
    | { type: 'GUARD_SYNC'; payload: { host: string } }
    /** 钓鱼防护：用户点「继续访问」，解除本标签页的封锁并在本次标签页会话内不再打扰 */
    | { type: 'GUARD_RELEASE'; payload: { host: string } }

/** 后台 → 页面/扩展页 的推送（只能由后台发出） */
export type Push =
    | { type: 'DOWNLOAD_STATE'; payload: { taskId: string; state: 'progress' | 'complete' | 'failed' | 'skipped' | 'handed-off'; detail?: string } }
    | { type: 'CONFIG_INVALIDATED'; payload: string[] }
    /** 配置快照下发（storage 配置变更后广播到 iwara 页） */
    | { type: 'CONFIG_SYNC'; payload: { page: PageConfig } }
    /** 注入最小化：缓存回填列表由后台预算推送（HELLO 后首推，入页新窗/CONFIG_INVALIDATED 后重推） */
    | { type: 'CACHE_INJECTION_LIST'; payload: CacheInjection }
    /**
     * 后台 → 发起批量下载的那个标签页：这批视频里有哪些已经处理完（任务已建或已判失败）。
     *
     * 页面据此把它们从选择集移除 —— 对齐源项目 `analyzeDownloadTask` 循环里的
     * `taskList.delete(id)`（活引用逐项写透，选择框随处理进度逐个取消勾选）。
     * **只发给发起页**：其它标签页由 `storage.local.pageSelection` 的 onChanged 联动
     * （选择集本来就是跨标签页共享的，见 content/pageUi.ts）。
     */
    | { type: 'DOWNLOAD_TASK_SETTLED'; payload: { videoIds: string[] } }
    /** 后台 → iwara 标签页：读取页面 IDB 旧库并分批回传（IMPORT_LEGACY_DB 的转发段） */
    | { type: 'LEGACY_DB_PULL'; payload: Record<string, never> }
    | { type: 'HELLO'; payload: { schema: number } }

export type Res = { ok: true; data: unknown } | { ok: false; error: string }

/** MAIN ⇄ ISOLATED 通道名（CustomEvent；跨世界只传 JSON 字符串，规避 X-ray 差异） */
export const MAIN_CHANNEL = {
    up: 'iwara-assistant:up',
    down: 'iwara-assistant:down'
} as const

/** 跨世界数据 JSON 通道 schema；不匹配时 ISOLATED 停用并提示 reload（docs/04 版本号协商） */
export const CONTENT_SCHEMA = 1

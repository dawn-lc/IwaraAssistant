/**
 * 配置 schema —— 原 core/config.ts DEFAULT_CONFIG 的骨架子集（M1：过滤开关 + 下载基础项）
 * M4 options 配置中心继续扩充/收口；这里用 zod 保证缺省字段自动补默认值、脏数据回落默认
 *
 * 注意：与原配置的偏差 ——
 * - `friendRequestApprovalConditions` 等审批类配置随 M3 功能迁移时补充
 * - `language` 原为 i18n 模块的 Language 枚举，此处先行字符串枚举
 */
import { z } from 'zod'
import { BROWSER_CONCURRENCY_DEFAULT, BROWSER_CONCURRENCY_MAX, BROWSER_CONCURRENCY_MIN } from './browserConcurrency'

/** 原核心枚举 core/enum.ts DownloadType（顺序即 API 值，勿改） */
export enum DownloadType {
    Aria2 = 0,
    Iwaradl = 1,
    Browser = 2,
    Others = 3
}

export const configSchema = z.object({
    /**
     * 界面语言 —— `auto` 跟随浏览器/扩展 UI 语言（新装默认），
     * 与源项目 Language 枚举的 `en | ja | zh` 保持一致，另加「自动」。
     */
    language: z.enum(['auto', 'en', 'ja', 'zh']).default('auto'),
    // ── 过滤与回填（M1 MAIN 世界改写行为开关）──
    filterLikedVideos: z.boolean().default(false),
    addUnlistedAndPrivate: z.boolean().default(false),
    filterUnlistedAndPrivate: z.boolean().default(false),
    // ── 下载基础（M2 三通道接线）──
    checkDownloadLink: z.boolean().default(false),
    checkPriority: z.boolean().default(true),
    downloadPriority: z.string().default('Source'),
    /**
     * 默认用浏览器内建下载（`downloads` API）。
     *
     * 源项目默认 `Others`（GM_openInTab 开直链），那是油猴环境的产物：油猴没有
     * `downloads.download`，只能把活交给浏览器标签页。扩展里有回传通道，`browser`
     * 通道能拿到真实进度/完成/失败/取消，也正是扩展相对脚本的主要优势——
     * 新装用户不该先落到一个「交付即失联」的通道上。
     */
    downloadType: z.nativeEnum(DownloadType).default(DownloadType.Browser),
    /**
     * 浏览器内建下载的同时下载数（1~10，默认 3）。
     *
     * `downloads.download()` 返回不代表下完了——传输在浏览器里继续跑，我们说什么它就同时下几个。
     * 批量投递只是每 3 秒发起一个，所以不设上限时勾 20 个就是 20 条并发传输打向同一个 CDN。
     * 超出上限的任务落 `queued` 排队，等前一个结束自动开始（见 `download/browserQueue.ts`）。
     * 只作用于 `browser` 通道：aria2 / iwaradl 的并发由它们自己控制。
     */
    browserConcurrentDownloads: z.number().int().min(BROWSER_CONCURRENCY_MIN).max(BROWSER_CONCURRENCY_MAX).default(BROWSER_CONCURRENCY_DEFAULT),
    downloadPath: z.string().default('/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4'),
    downloadProxy: z.string().default(''),
    downloadProxyUsername: z.string().default(''),
    downloadProxyPassword: z.string().default(''),
    aria2Path: z.string().default('http://127.0.0.1:6800/jsonrpc'),
    aria2Token: z.string().default(''),
    iwaradlPath: z.string().default('http://127.0.0.1:23456/api/tasks'),
    iwaradlToken: z.string().default(''),
    priority: z.record(z.string(), z.number()).default({ Source: 100, 540: 99, 360: 98, preview: 1 }),
    // ── 下载增强（M2）──
    autoCopySaveFileName: z.boolean().default(false),
    autoDownloadMetadata: z.boolean().default(false),
    // ── 社交自动化（原 autoFollow / autoLike）──
    autoFollow: z.boolean().default(false),
    autoLike: z.boolean().default(false),
    // ── 页面内交互（选择模式 / 悬浮菜单 / 批量下载）──
    autoInjectCheckbox: z.boolean().default(true),
    autoCollapseMenu: z.boolean().default(true),
    // ── 界面美化（仅 iwara 页面生效）──
    enableBeautify: z.boolean().default(false),
    enableWidescreen: z.boolean().default(false),
    // ── 高级 / 实验 ──
    experimentalFeatures: z.boolean().default(false),
    /** 调试模式（源 project：水印显示调试标记；页内水印五连击也可开启） */
    isDebug: z.boolean().default(false),
    /** 关闭批量入队间的 3s 节流（原 enableUnsafeMode，误用易触发 iwara 限流） */
    enableUnsafeMode: z.boolean().default(false),
    /**
     * 启动时关注脚本作者并加为好友（与源项目的默认值一致：默认 **开启**）。
     * 实际行为是「一次性」：完成后写标记，之后启动不再发请求（见 background/index.ts promoteAuthor）。
     */
    promoteScriptAuthor: z.boolean().default(true),
    /**
     * 保持后台活跃（**仅 Chrome MV3 有效，默认关闭**）。
     *
     * 开启后由 offscreen 文档每 20 秒向 service worker 发一次心跳，把 SW 的空闲回收
     * 往后拖——收益是 aria2 WebSocket 通知不回断，下载完成的通知是实时的而不是等
     * `scan-aria2`（5 min）。默认关闭的理由见 background/runtime/keepAlive.ts：
     * Chrome 没有官方常驻能力，官方文档明确要求避免无限期保活。
     * Firefox MV2 产物是持久化后台页，本开关对它无意义。
     */
    keepBackgroundAlive: z.boolean().default(false),
    // ── 好友请求一键审批 ──
    // 这里**故意没有**「启用一键审批」开关：审批是用户点按钮的主动动作，
    // 一个不控制任何行为的开关比没有开关更糟（曾经的 `friendRequestApprove` 就是这样的死字段：
    // 开关三态齐全，但仓库里没有任何一处读它，开与关完全一样）。
    // 将来若真要做「无人值守自动审批」，必须同时具备：条件不得只剩 always、
    // 执行频率上限、失败退避——那是新功能，不是把一个开关接上线。
    //
    // 默认**空数组**而不是 `['always']`：旧默认值等于「新装用户点一次按钮就通过所有好友请求」，
    // 一个不可撤销的社交动作不该由一个没人读过的默认值触发。空数组时后台直接报
    // `notify.noConditions`、界面把执行按钮置灰并提示先勾条件。
    friendRequestApprovalConditions: z.array(z.string()).default([]),
    friendRequestApprovalMode: z.enum(['any', 'all']).default('any'),
    friendApproveEvidenceThreadId: z.string().default(''),
    // ── MediaCenter 联动（实验性）──
    mediaCenterApi: z.string().default(''),
    mediaCenterApiKey: z.string().default(''),
    // ── 路径模板清洗（原 pathXxx 开关，M2 后台渲染消费）──
    pathNormalize: z.boolean().default(true),
    pathReplaceEmojis: z.boolean().default(true),
    pathFoldMarks: z.boolean().default(true),
    pathSanitize: z.boolean().default(true),
    pathTruncate: z.boolean().default(true),
    pathTitleMaxLength: z.number().int().min(1).default(72),
    pathAliasMaxLength: z.number().int().min(1).default(64)
})

export type Config = z.infer<typeof configSchema>

export const DEFAULT_CONFIG: Config = configSchema.parse({})

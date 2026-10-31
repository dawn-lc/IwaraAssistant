/**
 * 订阅流自动遍历的判据（纯函数，便于单测）。
 *
 * ## 源项目的「扫描时机」到底是什么
 *
 * 源脚本（`IwaraDownloadTool`）**没有定时器**。唯一触发点是 `src/ui/menu.ts` 的 `pageChange()`：
 *
 * ```ts
 * if (config.addUnlistedAndPrivate && !config.filterUnlistedAndPrivate && this.pageType === PageType.VideoList) {
 *     this.actions.parseUnlistedAndPrivate?.()
 * }
 * ```
 *
 * 而 `pageChange()` 在**首屏就绪与每次 SPA 路由变化**时都会执行（`main.ts` 的
 * `onHistoryChange(() => pageChange())` + 注入规则里的冷加载补发）。
 * 也就是说它是「每次到达 `/videos` 就试一次」，靠三件事把成本压到很低：
 * 模块级防重入、跨页 GM 锁、以及「追平当月即停」的终止条件（命中当月已入库的私有视频就 break）。
 *
 * 本扩展照搬这套时机（见 `content/pageUi.ts` 的 `reportAllVideosVisit`），
 * 并额外加一道最小间隔：源脚本里 `pageChange` 由页面自己触发，频率受渲染节奏约束；
 * 扩展里同一页可能因 SPA 连续跳转反复上报，加一道兜底比事后限流简单。
 */

/**
 * 两次自动遍历之间的最小间隔。
 *
 * 5 分钟的依据：`parseUnlistedAndPrivate` 的典型成本是 1 个请求（追平当月即停），
 * 但「刚关注一批人」时会连续翻很多页；这个间隔保证用户狂切列表页时不会把订阅流打成压测。
 * 手动按钮不受它约束——用户明确点了一次就该跑。
 */
export const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000

/** 判据所需的配置子集（与 `Config` 结构兼容，避免这里 import 整个 schema） */
export interface AutoSyncConfig {
    /** 回填私有/不公开缓存（源 `addUnlistedAndPrivate`） */
    addUnlistedAndPrivate: boolean
    /** 过滤订阅页 不公开/私有（源 `filterUnlistedAndPrivate`）；与上一项互斥 */
    filterUnlistedAndPrivate: boolean
}

/**
 * 是否该自动遍历订阅流。
 *
 * 两项都开时**不跑**：源项目里这两个功能互斥（`filterUnlistedAndPrivate` 会把订阅页的
 * 私有/不公开视频剔掉，回填再把它们从库里补回首页时间线，同时开只会自相抵消）。
 */
export function shouldAutoSyncSubscribed(config: AutoSyncConfig): boolean {
    return config.addUnlistedAndPrivate && !config.filterUnlistedAndPrivate
}

/**
 * 距离上次尝试是否已过最小间隔。
 *
 * `lastAt` 缺失/脏值一律视为「从没跑过」——宁可多跑一次，也不要因为一个写坏的时间戳
 * 让自动遍历永久失效（那会表现为「回填一直没数据」，且没有任何错误提示）。
 * `now` 非有限值时不跑（调用方传的是 `Date.now()`，出现这种值说明环境异常）。
 */
export function isAutoSyncDue(lastAt: number | undefined, now: number, minIntervalMs: number = AUTO_SYNC_MIN_INTERVAL_MS): boolean {
    if (!Number.isFinite(now)) return false
    if (lastAt === undefined || !Number.isFinite(lastAt) || lastAt <= 0) return true
    return now - lastAt >= minIntervalMs
}

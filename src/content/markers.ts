/**
 * 注入时机标记（供真实站点冒烟客观断言）
 *
 * 为什么需要：`run_at: document_start` 的语义是「在任何 DOM 构建、任何页面脚本
 * 运行前」，但这条承诺需要证据。MAIN world 的 `console` 无法跨浏览器读取，
 * 所以把此刻的文档状态写进 `html[data-ia-hook]`。
 *
 * ⚠️ 安全红线（改这里前必读）：
 * - 该属性**对页面可见、且可被页面改写**，因此只写三个无意义的时序量；
 *   严禁写入版本号、扩展 ID、用户 ID、token、邮箱等任何可识别信息。
 * - 它只是「扩展在这」的指纹，与任何 userscript 留下的痕迹同级；
 *   若将来需要更强隐蔽性，改为仅在 `enableUnsafeMode` 或 e2e 构建下写入。
 */

/** MAIN world 钩子安装时机（`readyState=...;body=...;elements=...`） */
export const HOOK_MARKER_ATTR = 'data-ia-hook'

/** ISOLATED 世界握手中继状态（`pending` / `ready` / `no-ack`） */
export const BRIDGE_MARKER_ATTR = 'data-ia-bridge'

/** ISOLATED 世界执行时机（`body=0;head=0;elements=N`） */
export const EARLY_MARKER_ATTR = 'data-ia-early'

/**
 * 入库结果（`ok:written=<落库>;parsed=<解析成功>;skipped=<已有 full 跳过>;failed=<解析失败>[;reason=<首条原因>]`
 * 或 `fail:<原因>`，由 ISOLATED 写入）。
 *
 * 三个数字分开报不是啰嗦：「库里没数据」时，`written=0;parsed=0` 说明没拦截到或字段不符，
 * `written=0;parsed=32;skipped=32` 说明是去重跳过，`fail:` 说明消息/写库报错——
 * 排查方向完全不同，只报一个总数就全糊在一起。
 */
export const INGEST_MARKER_ATTR = 'data-ia-ingest'

/** 卡片元数据链路（`ok:<返回条数>:<有 uploadTime 的条数>` 或 `fail:<原因>`，由页内 UI 写入） */
export const META_MARKER_ATTR = 'data-ia-meta'

/** 生成 MAIN 世界钩子安装时刻的状态串（无任何敏感信息） */
export function hookMarkerValue(): string {
    const root = document.documentElement
    return `readyState=${document.readyState};body=${document.body ? 1 : 0};elements=${root?.childElementCount ?? 0}`
}

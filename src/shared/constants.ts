/** 跨模块共享常量（alarms 与追踪器） */
/** aria2 终态去重记录保留天数（原 ARIA2_TRACK_DONE_RETENTION = 30d） */
export const DONE_RECORD_TTL_DAYS = 30
/** 失败任务自动重试上限（retry-failed alarm） */
export const RETRY_MAX_ATTEMPTS = 3

// ── offscreen 通道（Chrome 专用）───────────────────────────────────────
// 放在 shared/ 而不是 background/：offscreen 文档是与后台分开打包的入口，
// 常量若定义在后台模块里，导入它会把整条后台依赖链拉进 offscreen bundle。

/** offscreen 文档的定向消息名（与业务协议分离，见 hub.onMessage 的 `target` 过滤） */
export const OFFSCREEN_TARGET = 'iwara-assistant:offscreen'
/** 保活心跳的 runtime 端口名（offscreen → service worker） */
export const KEEP_ALIVE_PORT = 'iwara-assistant:keep-alive'
/**
 * 心跳间隔。Chrome 的空闲回收阈值是 30 秒，20 秒留出抖动余量；
 * 与 ScriptCat（`keep_alive.ts` 的 20s）取同一个值，便于两边行为对照。
 */
export const KEEP_ALIVE_HEARTBEAT_MS = 20_000

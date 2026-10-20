/**
 * 钓鱼防护的跨世界契约（MAIN ⇄ ISOLATED）。
 *
 * 分工：MAIN 世界负责**能力封锁**（改 `fetch` / `XMLHttpRequest` / `WebSocket`），
 * ISOLATED 世界负责**提示界面**（读 DOM、渲染警告、接按钮）。
 *
 * 跨世界只传 JSON 字符串（与本项目其它通道同一约束）：Firefox 的 X-ray 会拒绝
 * 把对象字面量从一个世界传进另一个，字符串是唯一两边都稳定的形态。
 */

/** 用户点「继续访问」时由 ISOLATED 派发，MAIN 收到后恢复原生网络 API */
export const GUARD_CONTINUE_EVENT = 'iwara-assistant:guard:continue'

/**
 * 警告层宿主元素的 id。
 * 加 `ia-guard` 前缀是为了在页面出问题时能一眼认出「这是我们干的」。
 */
export const GUARD_HOST_ID = 'iwara-assistant-guard'

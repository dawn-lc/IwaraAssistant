/**
 * env.d.ts —— browser 命名空间类型声明
 *
 * 以 @types/chrome 为基础（含省略回调即返回 Promise 的重载），
 * 将 globalThis.browser 对齐为 chrome 类型；Firefox 专属 API
 * （如 webRequest.filterResponseData）在 M5 引入时在此追加。
 * @types/chrome 已声明 globalThis.chrome，browser 的运行时载入由 shim 保证。
 */

declare global {
    var browser: typeof chrome
}

export {}

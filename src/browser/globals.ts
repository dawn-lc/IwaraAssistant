/**
 * `browser` 命名空间防护 shim（见 Chrome 官方指南：
 * developer.chrome.com/docs/extensions/develop/concepts/browser-namespace）
 *
 * - Chrome >= 148：原生 browser，本文件为空操作
 * - Chrome 111-147：browser ← chrome 别名（均为含 promise 的 API）
 * - Firefox：browser 原生（promise API），空操作
 *
 * 不在每个入口手动 import —— 由 esbuild `inject` 保证它是所有入口
 * （background / content / options / popup）第一个执行的模块（docs/02）。
 */
if (!globalThis.browser) {
    globalThis.browser = globalThis.chrome
}

export {}

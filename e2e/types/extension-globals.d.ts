/**
 * e2e 用例里 `page.evaluate()` / `browser.execute()` 的回调**运行在页面上下文**，
 * 而不是 Node 侧：那里有扩展 API 全局（Chrome/Chromium 用 `chrome`，Firefox 用 `browser`）。
 *
 * 这些名字在 e2e 工程里只作为「发进页面的脚本」的一部分出现，Node 侧从不求值，
 * 因此只补类型、不产生运行时代码。`chrome` 由 @types/chrome 提供（e2e/tsconfig 的 types 里已列），
 * `browser` 是 Firefox 的同构别名，@types/chrome 不含它，必须自己声明。
 */
declare const browser: typeof chrome

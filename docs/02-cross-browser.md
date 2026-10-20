# 02 跨浏览器策略：`browser` 命名空间

按 [Chrome 官方 browser-namespace 指南](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace)（Chrome 148 起原生提供 `browser` 命名空间，`chrome.tabs === browser.tabs`）制定本项目的写法规范。

## 采用路线（与官方指南对齐）

官方指南给出两条路：新扩展直接 `minimum_chrome_version: "148"` 无条件用 `browser`；或老扩展带运行时防护。本项目结论：

> **统一使用 `browser.*`，全上下文注入 1 行防护 shim，Chrome 最低版本声明 111**（111 是 `content_scripts[].world: "MAIN"` 的门槛建版本，详见差异矩阵）。

不选"最低 148"的理由：MAIN 世界脚本 111 即可用，shim 成本仅 1 行；不选 `webextension-polyfill` 的理由：指南指出其在 Chrome 148+ 已成 no-op，且历史上有 promise 型 `onMessage` 监听器的兼容缺口——我们自己写 1 行 shim 更可控。

### 防护 shim（每个上下文最先执行）

```ts
// src/browser/globals.ts —— must be the first import in EVERY entry
if (!globalThis.browser) {
    globalThis.browser = globalThis.chrome
}
```

esbuild 构建时以 `inject` 选项把它注入所有入口（content/SW/options/popup），保证任何 API 调用前已生效。行为语义：

- **Chrome ≥148**：原生 `browser`，shim 为空操作；
- **Chrome 111–147**：shim 把 `browser` 别名为 `chrome`（同为 callback API，但我们统一调用包装层后等价）；
- **Firefox 全版本**：`browser` 原生（promise API），shim 空操作。

### API 调用形态规范

为同时兼容两宿主，全局约定：

1. **统一 await Promise**：`await browser.storage.local.get(...)`。Chrome 111+ 的 `chrome.*` 支持 promise（回调省略即返回 Promise），Firefox 原生支持——**禁止**回调风格，禁止依赖 polyfill。
2. **`runtime.onMessage` 只用 `return true + sendResponse` 模式**（不做返回 Promise 的监听器）：Chrome 148 才加入 promise 型监听器支持，shim 不引入该缺口。桥层统一封包（见 [04-messaging.md](04-messaging.md)），业务代码无感知。
3. **`tabs.sendMessage` 的错误处理**：向可能无 content script 的标签页发消息在 Firefox 会 reject（Chrome 也会，但报错文案不同），统一 catch。

## 已核验差异矩阵

| 能力                                                     | Chrome                           | Firefox                                                                                           | 本项目策略                                                                                                                                                |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser` 命名空间                                       | 148+ 原生（此前无）              | 48+ 原生（promise API）                                                                           | `browser.*` + globals.ts shim                                                                                                                             |
| `content_scripts[].world: "MAIN"`                        | 111+                             | 128+（MDN BCD 核验）                                                                              | 原生 manifest 声明 → 两浏览器最低版本 111 / 128                                                                                                           |
| background 宿主                                          | MV3 仅 `service_worker`          | 支持 MV2 `scripts`（可 `persistent: true`）；MV3 无 SW，只能事件页（BCD `service_worker: false`） | 双 manifest：Chrome MV3 `service_worker` / **Firefox MV2 持久后台页**，同一 bundle                                                                        |
| background.type                                          | 92+                              | 112+（IIFE 单文件不需要）                                                                         | 不写                                                                                                                                                      |
| `preferred_environment`                                  | 不支持                           | 136+（Firefox 自研 SW 过渡方案）                                                                  | 不依赖，双 manifest 覆盖                                                                                                                                  |
| `runtime.onMessage` 返回 Promise                         | 148+                             | 一直支持                                                                                          | 桥层用 `sendResponse` 兼容模式                                                                                                                            |
| 响应体读取/改写                                          | 无扩展 API（仅注入 or CDP）      | 主路径外另有 `webRequest.filterResponseData`                                                      | **主路径统一页内 MAIN 注入**；Firefox 构建可选 `filterResponseData` 后台通道后置增强                                                                      |
| `downloads.download` filename 子目录                     | 支持（禁止 `..`）                | 支持（Bugzilla 1280044 已于 FF 51 FIXED；FF 158 实测自动建目录）                                  | 两宿主同构：路径模板照原样生效（`analyzePath` → `toDownloadFilename` 不再有 flatten 分支）                                                                |
| `declarativeNetRequest` session 规则（钓鱼防护）         | ✅ `updateSessionRules` 90+      | ✅ 113+                                                                                           | 按 `tabIds` 封锁单个标签页（仿冒站域名不可枚举，只能运行期判定）；Firefox 无 `getMatchedRules`，我们也不用                                                |
| `optional_host_permissions` 动态申请                     | ✅ `permissions.request()`       | ✅（MV3 host 权限默认 opt-in；MV2 则随安装授予且不可移除）                                        | **不用**：改为 manifest 一次声明 `<all_urls>`（RPC 端点地址用户自填 + 钓鱼防护需求，两者都无法枚举）；`request()` 只对 optional 权限有效,对 required 无效 |
| alarms/storage/downloads/contextMenus/notifications/i18n | ✅                               | ✅                                                                                                | `browser.*` 直用                                                                                                                                          |
| `browser.i18n.getMessage`                                | ✅ `_locales`                    | ✅                                                                                                | 只给 manifest 层（`extName`）；界面文案走 i18next（`shared/i18n.ts`，两宿主行为一致）                                                                     |
| `i18n.getUILanguage()`（语言探测）                       | ✅ 跟 `--lang`                   | ✅ 跟 `intl.locale.requested`                                                                     | 「跟随浏览器」用它；无浏览器 API 的上下文退回 `navigator.language`                                                                                        |
| `storage.local` 配额                                     | 10 MB（`unlimitedStorage` 解除） | 较宽松                                                                                            | **不加** `unlimitedStorage`；大库走 IndexedDB                                                                                                             |
| X-ray wrappers                                           | —                                | 有（ISOLATED 世界见到的页面对象被包裹）                                                           | ISOLATED 只操作注入元素自建节点；跨世界数据一律 JSON 序列化                                                                                               |

## Firefox 专项注意

1. **Firefox 产物是 MV2 持久后台页**（`background.scripts` + `persistent: true`）：页面在浏览器启动时加载并常驻，HTTP/WS 连接与内存状态不会被回收。切换到 MV2 的主要动机是 LNA（见本节第 5 条），常驻只是附带收益——**代码里仍然不能假设常驻**（Chrome 侧随时被回收），见 [01-architecture.md](01-architecture.md) 挂起协议。
2. **`webRequest.filterResponseData`（可选增强）**：Firefox 专属流式改写 API，可在后台完成响应体改写。将其做成 **Firefox 构建的可选通道**（同一套解析/入库代码，切换数据源），非本期必做。
3. **host 权限的实际授予行为（实测 Firefox 158）**：安装时 `host_permissions` 声明的主机 **已随扩展一并授予**（FF 127+ 会在安装弹窗列出 `<all_urls>`），不需要也不要可能再弹一次授权。但用户可在扩展管理页把站点访问收窄/撤销，撤销后 `permissions.contains({origins:['<all_urls>']})` 为 false，页内注入/后台 API/右键菜单全部失效——因此 options「使用引导」页只做**诊断**（如实显示「已获得 / 已被撤销」+ 恢复路径），不再尝试 `permissions.request()`。
    - Chrome 对照：`host_permissions` 被视为**必需权限**，`permissions.remove()` 直接报 `You cannot remove required permissions`，`permissions.request()` 则报 `Cannot request required permission`；用户只能在扩展详情页把「网站访问权限」改成「点击时」。两个平台都**没有**可在扩展内完成的重新授权路径。
    - **MV2 又不一样**（Firefox 158 实测）：`<all_urls>` 在 MV2 里只能写进 `permissions`，属于必需权限，`permissions.remove({origins})` **返回 true 但什么也不做**（随后 `contains()` 仍为 true）。也就是说 MV2 产物下「扩展内撤销」这条路根本不存在，只有用户在扩展管理页手动关站点访问才会真的失效。
    - 自动化边界：正因为没有「点一下就好」的按钮，WDIO 的撤销用例断言的是「界面与 `contains()` 始终一致 + 无按钮 + 撤销成功时提示文本指回扩展管理页」，并且**必须放在最后**（万一真的撤销，Firefox 本次会话内无法恢复）。
4. **下载子目录**：两宿主都支持。曾经因为 Bugzilla 1280044（2016 年提的 Firefox 缺陷）而对 Firefox 做文件名扁平化，但那条 bug 在 **Firefox 51（2017-01）就已 FIXED**；Firefox 158 实测 `filename: 'a/b/c.txt'` 会自动建出两层目录（`~/Downloads/a/b/c.txt`，`state: complete`）。现在 `toDownloadFilename` 只有一条路径，两个宿主的目录结构完全一致，不再需要提示用户切通道。
5. **Firefox 的本地网络访问策略只拦 MV3 扩展，不拦 MV2 扩展**（Firefox 158 实测；同一份代码、同一个 `_generated_background_page.html`、同一个 `moz-extension://` 源，唯一变量是 `manifest_version`）：

    | 发起上下文                                       | MV3               | MV2             |
    | ------------------------------------------------ | ----------------- | --------------- |
    | options 页面 `fetch('http://<LAN IP>')`          | ❌ `NetworkError` | ✅ 200（9 ms）  |
    | options 页面 `XHR.open('http://<LAN IP>')`       | ❌ error          | ✅ 200（9 ms）  |
    | 后台（`_generated_background_page.html`）`fetch` | ❌ `NetworkError` | ✅ 200（3 ms）  |
    | 后台 `XHR`                                       | ❌ error          | ✅ 200（54 ms） |
    | 回环 `127.0.0.1`（两宿主两种上下文）             | ✅ 200            | ✅ 200          |

    **MV2 下 `persistent: true/false` 都通过**，所以差异是 manifest 版本本身，不是持久后台页、也不是 XHR/fetch 的差别。这也解释了为什么装油猴脚本的用户（Tampermonkey/Violentmonkey/ScriptCat 的 **MV2** 构建）在 Firefox 里能直接连局域网服务，而同类扩展的 MV3 构建不能——它们并没有用什么特殊 API（ScriptCat 后台就是普通 `XMLHttpRequest`），只是没被这条策略覆盖。

    补充证据（排除其他解释）：
    - `permissions.contains('http://10.0.0.165:60050/*')` = **true** → 与主机权限无关；
    - 同一地址从普通 http 页面 `no-cors` 取 **能通** → 网络/路由/服务/防火墙都正常；
    - `https://…` 通（`nas.dawnlc.me` 这类服务正常）→ 不是端口或协议栈问题；
    - `network.lna.enabled=false`、`blocking=false`、`block_trackers=false`、`skip-domains=*`、`defer_https_check=false`、`dom.security.https_first=false` **全部在运行期读回确认生效**后 MV3 仍被拦 → 用户侧关不掉；
    - 用 `webRequest.onErrorOccurred` 看 MV3 的真实 URL 已被改写成 `https://`（`SSL_ERROR_RX_RECORD_TOO_LONG`）→ 失败发生在 LNA 的 https 探测阶段。

    机制：`moz-extension://` 页面不属于「本地/私有」地址空间，Firefox 在 `nsHttpConnection::Activate` 里对指向 Local/Private 目标的请求调用 `AllowedToConnectToIpAddressSpace`；扩展源拿不到「本地网络访问」站点权限（只对 http(s) 页面弹窗），故直接拒绝且无弹窗（失败只有 9~30 ms）。回环是例外，靠 pref `network.lna.local-network-to-localhost.skip-checks`（默认 `true`）。

    对我们的意义（**Firefox 产物已切换到 MV2**）：
    - 局域网/私有网段的明文 `http` / `ws` 端点（NAS 上的 aria2、iwaradl）**直接可用**，不再需要 https 反代或把服务摆到回环；
    - 清单形状由 `build/manifestV2.ts` 在构建期一次性改写（单测：`test/manifestV2.test.ts`），base 模板仍只有一份；
    - 能力对照（Firefox 158 实测）：

        | 能力                                                  | MV3               | MV2（现产物）                                                   |
        | ----------------------------------------------------- | ----------------- | --------------------------------------------------------------- |
        | `content_scripts.world: "MAIN"` + `document_start`    | ✅                | ✅ 实测生效（`readyState: "loading"`）                          |
        | `storage.session`（放行记录）                         | ✅                | ✅ 读写往返正常                                                 |
        | `declarativeNetRequest` session 规则（钓鱼防护第①层） | ✅                | ✅ API 可用且**规则真实拦截**                                   |
        | `webRequestBlocking`                                  | ❌                | ✅ 可 cancel（可按 initiator 实时判定）                         |
        | `browser.action`                                      | ✅                | ❌ → 改用 `browser.browserAction`（`queue.ts` 的 `badgeApi()`） |
        | 局域网明文 `http` / `ws`（非回环）                    | ❌ `NetworkError` | ✅ `fetch` / `ws://10.0.0.164:PORT` 均成功                      |
        | 后台挂起                                              | 事件页会被卸载    | ✅ `persistent: true` 常驻                                      |

        MV2 的真实成本只有清单格式 + 一处角标 API shim；**钓鱼防护与 localStorage 依赖的能力一个都不丢**。
        Chrome 已不支持 MV2，所以这只能是 Firefox 专属变体。

    - 文案仍必须把「被浏览器拦」与「守护进程没起来」分开（`shared/endpoint.ts` 的 `firefoxBlocksLanHttp`）：判据里已经要求 `manifest_version === 2` 时**不**报「浏览器拦了」，否则 MV2 下把端口填错会被误报成策略问题。这是启发式判定（UA + manifest 版本 + 地址形态），要拿真实错误码就得额外申请 `webRequest` 权限订阅 `onErrorOccurred`，为一句提示文案多要这种权限不划算。

6. **options 页样式：Firefox MV2 的 `options_ui.browser_style` 默认 `true`**（MV3 从 Firefox 115 起默认 `false`，118 起移除该键）。默认值会让 Firefox 向扩展页注入 `chrome://browser/content/extension.css`，其中 `html, body { display:flex; flex-direction:column; user-select:none; font:caption }` 等属性会实际生效——Chrome 没有这套样式表，于是同一份 `options.css` 在两宿主的布局与文本选择行为不一致。Firefox 变体现在显式写 `"browser_style": false`（`manifest/variants.ts`），只保留 `src/options/options.css`；该键不能写进 base，否则 Chrome 不认、Firefox MV3 也已废弃。

## 版本下限声明

- Chrome manifest（MV3）：`"minimum_chrome_version": "111"`
- Firefox manifest（MV2）：`browser_specific_settings.gecko.strict_min_version: "128.0"`（`world: "MAIN"` 的门槛）

> 这个下限低于 `data_collection_permissions` 的引入版本（桌面 140 / Android 142），所以 `addons-linter` 会报两条 `KEY_FIREFOX_*_UNSUPPORTED_BY_MIN_VERSION` 警告。低版本 Firefox 只是忽略该未知键（AMO 又强制要求新提交声明），属**有意保留**的取舍；清零需把最低版本提到 142，代价是放弃 128–141。详见 [store-listing.md](store-listing.md#二amofirefox-add-ons)。

> 若未来放弃 Chrome 111–147 用户，两处提升到 148 并删除 shim 调用即可（指南的"无条件采用"路线），代码零改动。

## TypeScript 类型策略

- `@types/chrome` 提供全部 API 类型；`src/browser/globals.ts` 旁的 `env.d.ts` 将 `globalThis.browser` 声明为 `typeof chrome`（`chrome` 命名空间类型已含 promise 重载写法中省略回调的声明），并在 Firefox 条件构建下追加 `filterResponseData` 等扩展方法声明。
- 自定义类型放 `src/types/`（沿用原仓库 `Iwara.*` 命名空间声明，可直接复制）。

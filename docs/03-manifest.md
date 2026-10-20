# 03 Manifest 设计

## 双 manifest 派生

构建脚本由单一源模板派生两份 manifest，差异集中、可审阅：

```
manifest/manifest.base.json       （公共骨架，MV3 形状，含 %##占位符##%）
  ├── build/index.ts 派生 → dist/chrome/manifest.json     （MV3，原样 + 少量 extra）
  └── build/index.ts 派生 → dist/firefox/manifest.json    （MV2，经 toManifestV2 改写）
```

**Firefox 为什么是 MV2**：Firefox 的本地网络访问（LNA）策略只拦 MV3 扩展——局域网/私有网段的明文 `http`/`ws` 一律 `NetworkError`（回环除外），且用户侧 pref 关不掉；MV2 完全豁免。社区同类扩展（Tampermonkey / Violentmonkey / ScriptCat 的 MV2 构建）能直连 NAS 上的 aria2 就是因为这个。实测矩阵与证据链见 [02-cross-browser.md](02-cross-browser.md#firefox-专项注意) 第 5 条。附带收益：MV2 可以 `persistent: true`，后台页常驻。

改写不是另写一份清单：`build/manifestV2.ts` 做一次性、可枚举的字段转换（`host_permissions`→`permissions`、`action`→`browser_action`、`background.service_worker`→`scripts`+`persistent`、WAR/CSP 形状），改完还有一条残留断言——MV3 专有键没转干净就**直接让构建失败**。这段逻辑有单测（`test/manifestV2.test.ts`），因为清单写错的表现极其隐蔽（装得上、但少权限/角标失效/后台变成事件页）。

### 版本号真源：`package.json`

`manifest.base.json` **不写 `version`**。构建脚本在写完所有 variant 覆盖之后，从 `package.json` 读取并注入：

```ts
manifest['version'] = await readExtensionVersion(root)
```

理由：manifest 里的版本是**产物**，不是源。两个手写真源会出现「改了 `package.json`，打出来的包还是旧版本号」的问题。

`build/version.ts` 负责校验，**失败即让构建失败，且发生在清理 dist 之前**（不留下半个产物目录）：

| 规则             | 来源           | 说明                                            |
| ---------------- | -------------- | ----------------------------------------------- |
| 1~4 段十进制整数 | Chrome / AMO   | `1`、`1.2`、`1.2.3`、`1.2.3.4`                  |
| 非零段不得前导零 | Chrome / AMO   | `2.01` 非法                                     |
| 每段 ≤ 65535     | Chrome（更严） | AMO 允许 9 位，同时上架必须取交集               |
| 不得全零         | Chrome         | `0`、`0.0.0.0` 被拒收                           |
| 不接受预发布标识 | Chrome / AMO   | `1.0.0-beta.1` 直接报错，**不静默削成** `1.0.0` |

预发布确实需要时，用第 4 段表达构建号（`1.0.0.1`），或引入 `version_name`（Chrome 显示用，Firefox 不支持）。当前项目两者都不需要。

发版流程：`npm version patch|minor|major` → 构建（`npm run build` 自动校验并注入）→ 打包上传。`test/version.test.ts` 锚定上述规则，并守卫「模板与 variant 里不得再出现 `version`」。

### manifest.base.json（核心字段）

```jsonc
{
    "manifest_version": 3,
    "name": "Iwara Assistant",
    // `version` 不在这里写：它由构建脚本从 package.json 注入（见下方「版本号真源」）
    "default_locale": "en",
    "description": "%#description#%",
    "icons": { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },

    "permissions": ["storage", "downloads", "clipboardWrite", "alarms", "contextMenus", "notifications", "declarativeNetRequest"],
    "optional_permissions": [],

    "host_permissions": ["<all_urls>"],

    "background": { "%#background_key#%": "%#background_value#%" },
    "action": { "default_popup": "popup/index.html" },
    "options_ui": { "page": "options/index.html", "open_in_tab": true },
    "content_scripts": [
        // 钓鱼防护：任意站点都注入（先于一切站点专属脚本，因为它要在页面 JS 跑之前就封住网络）
        {
            "matches": ["<all_urls>"],
            "js": ["content/guard-main.js"],
            "run_at": "document_start",
            "world": "MAIN",
            "all_frames": false
        },
        {
            "matches": ["<all_urls>"],
            "js": ["content/guard.js"],
            "run_at": "document_start",
            "all_frames": false
        },
        {
            "matches": ["*://*.iwara.tv/*"],
            "js": ["content/main-world.js"],
            "run_at": "document_start",
            "world": "MAIN",
            "all_frames": false
        },
        {
            "matches": ["*://*.iwara.tv/*"],
            "js": ["content/isolated.js"],
            "run_at": "document_start",
            "all_frames": false
        },
        {
            "matches": ["*://*.iwara.tv/*"],
            "js": ["content/page-ui.js"],
            "css": ["content/page-ui.css"],
            "run_at": "document_start",
            "all_frames": false
        }
    ]
}
```

> **样式走 `css` 字段，不走 JS。** `content_scripts[].css` 由浏览器在 `document_start` 期间、DOM 构建之前应用，且 **CSS 先于同一条目的 `js`**。源文件是 `src/content/css/*.css`（真实 `.css`，由 `index.css` `@import` 汇总），构建期 bundle 成单个 `content/page-ui.css`。

> **`options_ui.browser_style` 只在 Firefox MV2 变体里写 `false`。** 该键在 Chrome 不存在，MV3 下也已废弃（Firefox 118+ 移除）；但 Firefox MV2 的默认值是 `true`，会向 options 页注入 `chrome://browser/content/extension.css`（`body` 变 flex 列、禁用文本选择），与 Chrome 的渲染不一致。Firefox 变体单独覆盖 `options_ui` 并显式关闭它，见 `manifest/variants.ts`。

## 权限清单的取舍

| 权限                                 | 用途                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                            | 配置/队列持久化                                                                                                                                                                                                                                                                                                                 |
| `downloads`                          | 内建下载 + 元数据 JSON                                                                                                                                                                                                                                                                                                          |
| `clipboardWrite`                     | `autoCopySaveFileName` 自动复制保存文件名（由 offscreen 文档代写）；配置导出改由 options「迁移」页签生成文件                                                                                                                                                                                                                    |
| `offscreen`（**仅 Chrome**）         | 两个用途：① 写入 `autoCopySaveFileName` 的保存文件名（SW 没有 DOM，`navigator.clipboard` 不存在）；② 用户开启「保持后台活跃」时充当保活心跳的发送端。默认**用完立即 `closeDocument()`**；只有保活开启时文档才长期存在（由 `background/runtime/keepAlive.ts` 持有）。Firefox 是 MV2 持久后台页（有 DOM）且无此 API，不声明该权限 |
| `alarms`                             | 4 个定时扫描/重连                                                                                                                                                                                                                                                                                                               |
| `contextMenus`                       | 右键「下载此视频」（链接 / 视频页）                                                                                                                                                                                                                                                                                             |
| `notifications`                      | **唯一反馈通道**：成功/失败/入队提示全部走系统通知；批量入队按任务键去重聚合，防通知轰炸。点击通知打开它登记过的页面（登记表存 `storage.session`，因为 `onClicked` 可能在 SW 被回收之后才触发）                                                                                                                                 |
| `host_permissions: <all_urls>`       | 两处用途：① 后台 fetch 用户自填的 aria2/iwaradl/MediaCenter 端点；② 任意站点判断主机名，做钓鱼仿冒防护。**不是**为了读写任意站点内容（iwara 专属脚本仍只匹配 `*://*.iwara.tv/*`），见下文「全站 host 权限」                                                                                                                     |
| `declarativeNetRequest`              | 钓鱼防护的**主防线**：给「疑似仿冒」的标签页下一条 session 规则，拦住除顶层导航外的一切请求（img / font / 表单 / beacon / 跨域 iframe / Worker）。不申请 `feedback`（不需要读匹配日志），不带任何静态规则集                                                                                                                     |
| **不需要** `cookies`                 | `document.cookie`（非 HttpOnly）由 ISOLATED 采集转发                                                                                                                                                                                                                                                                            |
| **不需要** `tabs`                    | `tabs.create/sendMessage/query` 均无需 `tabs` 权限（仅读取 url/title 等敏感字段需要；本项目不需要）                                                                                                                                                                                                                             |
| **不需要** `unlimitedStorage`        | 大库走 IndexedDB                                                                                                                                                                                                                                                                                                                |
| **不需要** `scripting`               | 世界注入全部由静态 `content_scripts` 声明覆盖                                                                                                                                                                                                                                                                                   |
| **不需要** `debugger` / `webRequest` | 响应体改写走页内注入（见 01 / 05）                                                                                                                                                                                                                                                                                              |

## 全站 host 权限：一次声明，两处用途

manifest 只声明一条 host 权限（`<all_urls>`），不再有 `optional_host_permissions`。两个彼此独立的理由都指向同一个结论——**授权面无法事先枚举**：

1. **自定义 RPC 端点**：aria2/iwaradl 地址由用户自填（默认 `127.0.0.1`，也可能是 NAS、局域网、公网反代）。逐地址申请的代价是：每换一次地址就要用户点一次浏览器原生权限气泡。
2. **钓鱼仿冒防护**：`src/content/guard/isolated.ts` 需在**任意**站点判断主机名，见 [01-architecture.md](01-architecture.md#钓鱼仿冒防护)。逐站点模型下，受害者第一次点开的仿冒站恰恰不在授权清单里——防护最需要生效的时刻，它恰是失效的。

### 为什么 UI 里没有「授权」按钮了

`permissions.request()` **只能申请 optional 权限**，对 manifest 里声明的 required host 权限无效（Chrome 直接报 `Cannot request required permission`）。所以引导页的站点访问区块是纯**诊断**：读 `permissions.contains({origins:['<all_urls>']})`，如实显示「已获得 / 已被撤销」并指出恢复路径（浏览器扩展管理页把站点访问放开为「所有网站」）。

> 权限模块只保留 `ALL_SITES_PATTERN` 与 `hasAllSitesAccess()`；required host 权限无法在运行时通过 `permissions.request()` 补授，因此 UI 只做诊断，不提供授权按钮。

### 商店审核需要准备的理由

- `<all_urls>` **不是**为了读写任意网站的内容：iwara 站点专属脚本仍只 `matches: *://*.iwara.tv/*`；全站脚本只有两个用途——管主机名（钓鱼警告）与管后台端点 fetch（权限）。
- `declarativeNetRequest` **没有静态规则集**（manifest 里不写 `declarative_net_request.rule_resources`）：规则由 `background/runtime/guardRules.ts` 在命中疑似仿冒站时用 `updateSessionRules` 动态下发，一条规则只对应一个标签页（`id = tabId`），随浏览器退出或标签页离开自动清理。审核时可指出的唯一调用点是 `syncGuard` / `releaseGuard` / `reconcileGuardRules`。
- 全站 content script **不读取页面内容**，不做 DOM 观察（除监控自己插入的警告层是否被移除），不向任何第三方发送数据。

### 未授权时的真实行为（必须按这个写文案）

用户仍可在扩展管理页把站点访问收窄成「点击时」或在 Firefox 上撤销主机权限。此时判断规则不变：

**未授权 ≠ 请求一定失败**：扩展 fetch 一个没有 host 权限的站点时，只要对方返回宽松的 CORS 头，请求照样成功（实测：`CHECK_LINK` 对一个未授权的 HTTPS 站点返回 200）。反过来，aria2 这类本机守护进程默认不发 CORS 头，同一个「未授权」配置下就会失败。

失败时的错误原文是浏览器给的、且不指向任何可操作信息：

| 宿主    | 原文                                              |
| ------- | ------------------------------------------------- |
| Firefox | `NetworkError when attempting to fetch resource.` |
| Chrome  | `Failed to fetch`                                 |

因此**判断顺序必须是「先看是不是网络层错误，再看权限」**：

1. `permissions.contains()` 为 true → 权限不是原因，按「连不上」（进程/端口/网络）报，并附对应目标的排查提示；
2. `contains()` 为 false **且** 错误是网络层 → 指向恢复入口（扩展管理页的站点访问），同时指出端点地址在哪个设置页（`shared/endpoint.ts`，各目标的 `settingsPath` 必须与真实 UI 一致）；
3. `contains()` 为 false 但不是网络层错误 → 证据不足，如实给原文，不硬塞「去放权限」。

另有一条与之并列的必守规则：**端点可达但服务端返回 4xx/5xx 时不能说「无法连接」**。连接明明成功了，问题是 token/参数/服务端状态；此时保留服务端原话（`describeEndpointRejected`）。把 `createMedia 401: {"error":"auth.tokenInvalid"}` 写成「守护进程是否已启动」是纯粹的错误归因。

## CSP 与打包

- MV3 默认 CSP 足够（无 eval、无 remote code requirement；**React 19 产品构建无 eval**，options/popup 用 React 不需要放宽任何 CSP；注意 **Chrome 商店 remote-code 政策**：所有 js 均为打包本地产物，不加载远程脚本——现有实现本就没用远程代码）。
- Firefox 的 MV2 产物同理：默认 CSP（`script-src 'self'; object-src 'self'`）就够用，manifest 里**不写** `content_security_policy`。真要写时注意 MV2 是**字符串**而 MV3 是 `{ extension_pages }` 对象——`build/manifestV2.ts` 已覆盖这个形状转换。
- 图片/封面等远程资源引用是资源请求而非代码加载，不受影响。
- 打包产物：`dist/chrome.zip`（Chrome Web Store 校验 `minimum_chrome_version`）、`dist/firefox.zip`（AMO 校验 gecko id）。

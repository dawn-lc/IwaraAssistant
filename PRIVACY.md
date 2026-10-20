# Iwara Assistant — Privacy Policy / 隐私政策

**App version:** 0.1.0+ ｜ **Last updated:** 2026-10-08

## English

**TL;DR: Iwara Assistant does not collect, transmit, sell, or share any personal data. There is no developer-side server; everything stays in your browser.**

### Data collection

| Data category                                                         | Collected by the developer? | Where it lives                               |
| --------------------------------------------------------------------- | --------------------------- | -------------------------------------------- |
| Browsing history / page content                                       | **No**                      | Not stored anywhere outside your browser     |
| Download settings (mode, path template, RPC endpoints, tokens)        | **No**                      | `browser.storage.local`, on your device only |
| Video metadata cache (titles, authors, IDs, tags of pages you browse) | **No**                      | IndexedDB, on your device only               |
| iwara.tv login tokens (refresh/access)                                | **No**                      | `browser.storage.local`, on your device only |
| Download queue                                                        | **No**                      | `browser.storage.local`, on your device only |

The declared `data_collection_permissions: none` in the Firefox manifest is the accurate disclosure: **the developer does not receive, aggregate, or even see any of the above.** There is no analytics, telemetry, crash reporting, or remote logging.

### Network activity (user-initiated only)

- Requests to `api.iwara.tv` / file servers: video listing/metadata/download — same requests the website itself makes, plus authenticated file fetches you trigger by clicking download.
- Requests to **your own configured endpoints** (aria2 JSON-RPC, iwaradl): download tasks and your page cookies (needed by those local tools). These endpoints are chosen by you, stored locally, and are commonly `127.0.0.1` — traffic never goes to the developer.
- No other hosts are contacted. No remote code is loaded (MV3 compliant).

### Permissions justification

- `storage` — settings, tokens, and download queue persistence (local only).
- `downloads` — saving video files and metadata JSON (browser channel).
- `alarms` — scheduled download reconciliation, retry, WebSocket keep-alive.
- `contextMenus` — the right-click "Download this video" entry.
- `notifications` — download completion/failure notices (the only feedback channel; no in-page toasts).
- `clipboardWrite` — copy the computed save filename on your request.
- `offscreen` (**Chrome only**) — two uses. (1) Writing that clipboard text requires an offscreen document because a Manifest V3 service worker has no DOM; it is created on demand and closed immediately after the write. (2) If you explicitly enable "Keep background alive", the same document stays open and posts a heartbeat message to the service worker every 20 seconds, and is closed as soon as you turn the setting off. Nothing is read, stored or transmitted in either mode. `BLOBS` is declared alongside `CLIPBOARD` because Chrome offers no "keep the worker alive" reason; the document itself never touches Blob APIs.
- Host permission `<all_urls>` — two distinct uses, neither of which is “read any website's content”:
    1. **Your own endpoints**: aria2 / iwaradl / MediaCenter addresses are typed by you (localhost, LAN, or a reverse proxy), so they cannot be enumerated in the manifest in advance. Background `fetch` to them needs the host permission.
    2. **Phishing look-alike protection**: on every page, two small scripts compare `location.hostname` against the official iwara domain list (`iwara.tv`, `iwara.zip`, `iwara.shop`, `iwara.ai`). If the host name contains the brand but is not official, the extension shows a full-page warning and blocks the page's `fetch`/`XMLHttpRequest`/`WebSocket` until you choose to continue. This check needs the host name of _arbitrary_ sites — a per-site model would be blind exactly where it matters. Only the host name is read; **no page content is read, stored, or transmitted**, and nothing leaves your browser.
- No `optional_host_permissions`: host access is declared once at install, so there is no per-endpoint permission popup and no `permissions.request()` call anywhere in the codebase.

### Data removal

Uninstalling the extension removes all of it: `storage.local` and the extension-origin IndexedDB are deleted by the browser automatically. There is nothing on any server to delete.

### What runs inside the page (honest disclosure)

- To rewrite the video-list response the website itself receives, one content script runs in the page's **MAIN JavaScript world** (declarative `world: "MAIN"`, no remote code). It wraps `window.fetch` and is therefore **detectable by the page**, exactly like a userscript. It exposes **no globals, no control functions, and no API surface**.
- Because the original userscript shares its session across tabs via page storage, the refresh token from `/user/token` is also written to `localStorage` of `iwara.tv` — same key, same behaviour as the userscript. **Any script on iwara.tv can read its own `localStorage`.** If you consider that unacceptable, do not enable the login-dependent features.
- The extension's other content scripts (`main-world.js`, `isolated.js`, `page-ui.js`) still match **only** `*://*.iwara.tv/*`; nothing is injected into other sites' pages beyond the two guard scripts described next.
- On **every** site, two tiny guard scripts run at `document_start`, and on official iwara domains both return immediately without touching the page: one in the MAIN world (only acts when the host name looks like an iwara look-alike; it then replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, form submission and `RTCPeerConnection` with throwing stubs, and restores the originals once you choose to continue) and one in the isolated world (renders the warning inside a **closed** shadow root, re-attaches it if the page removes it, otherwise does nothing). They read `location.hostname` only.
- When a page is flagged, the background adds an in-memory `declarativeNetRequest` **session** rule for that tab: every request the page makes (images, fonts, form posts, beacons, cross-origin frames, workers) is blocked by the browser before it reaches the network. The rule is removed when you choose to continue, when the tab navigates elsewhere, when the tab closes, or when the browser exits. **No ruleset is bundled and no request data is read** — the extension only adds/removes the rule.
- Two non-sensitive timing attributes (`data-ia-hook`, `data-ia-early`, `data-ia-bridge`) may be set on `<html>`. They contain only `readyState` / `body-exists` / element counts and connection state — no version, ID, token, or user identifier. They exist so the automated end-to-end tests can prove the injection really happens before page scripts.
- The extension does **not** request `web_accessible_resources`, so page scripts cannot fetch the extension's source files.

Contact: open an issue on the project repository.

## 中文

**一句话：Iwara Assistant 不收集、不上传、不共享任何个人数据。没有开发者服务器，一切数据只留在你的浏览器里。**

- 本扩展**无任何遥测/统计/崩溃上报**；声明 `data_collection_permissions: none` 即为准确披露。
- 配置、登录令牌、下载队列存于 `browser.storage.local`（仅本机）；浏览过的视频元数据缓存于扩展 origin 的 IndexedDB（仅本机）。
- 仅两类网络请求：① iwara 官方 API/文件服务（与网页自身发出的同类请求，含你点下载时的文件拉取）；② **你自己配置的** aria2/iwaradl 端点（下载任务 + 该工具所需的页面 Cookie，通常为 127.0.0.1 本机地址，不经过开发者）。
- 站点访问权限（`<all_urls>`）：两处用途，均**不涉及读取任何网站的内容**——
    1. **你自己配置的端点**：aria2 / iwaradl / MediaCenter 地址由你填写（本机、局域网或反代），无法在清单里事先枚举；后台向它们发请求需要该权限。
    2. **钓鱼仿冒防护**：每个页面上有两个小脚本，只把 `location.hostname` 与官方域名清单（`iwara.tv` / `iwara.zip` / `iwara.shop` / `iwara.ai`）对比；若主机名包含品牌词却非官方，就显示全屏警告，并给该标签页下一条**内存中的** `declarativeNetRequest` 会话规则——该页面发出的所有请求（图片、字体、表单、beacon、跨域 iframe、Worker）都由浏览器在网络层拦下，只有跳转到其他地址不受影响。你点「继续访问」、标签页离开仿冒站或被关闭、或浏览器退出时，规则立即移除。**不打包任何规则集、不读取任何请求内容**，只做「加一条规则 / 删一条规则」。这个判断需要**任意站点**的主机名，而逐站点授权偏偏在最需要它的时刻是盲的。**只读主机名，不读取页面内容、不入库、不向外发送**，一切留在本地浏览器。
- 不再声明 `optional_host_permissions`：主机权限在安装时一次授予，因此代码里没有任何 `permissions.request()` 调用，也不会再弹逐端点权限气泡。
- 页面上还会跑两个**仅在仿冒站点生效**的防护脚本（`document_start`，任意站点）：MAIN 世界那个只负责在主机名疑似仿冒时把 `fetch`/`XMLHttpRequest.open`/`WebSocket` 换成抛错桩，监听一次「继续访问」事件后恢复原生引用；ISOLATED 世界那个只在 **closed shadow root** 里渲染警告面板，宿主被页面移除时补种，官方域名下直接 no-op。两者只读 `location.hostname`，不读取、不保存、不发送页面内容。
- `offscreen`（**仅 Chrome**）：两个用途。① 写剪贴板：MV3 service worker 没有 DOM，必须由一个按需创建的 offscreen 文档代写，**写完立即关闭**；② 你若在设置页显式开启「保持后台活跃」，同一个文档会保持打开，每 20 秒向 service worker 发一次心跳消息，关闭该开关后立即关闭。两种模式都**不读取、不保存、不发送任何数据**。用途声明里除 `CLIPBOARD` 还写了 `BLOBS`——Chrome 没有提供「保持 worker 存活」这类理由，该文档本身从不使用 Blob API。
- 无远程代码加载（符合 MV3 政策）。
- 数据清除：卸载扩展即全部删除（浏览器自动清理 storage.local 与扩展 origin IndexedDB），服务器侧无任何留存。

**页内运行的诚实披露（请知悉）**：

- 为了改写站点自身收到的视频列表响应，有 1 个 content script 在页面的 **MAIN JavaScript 世界**运行（声明式 `world: "MAIN"`，无远程代码）。它包装 `window.fetch`，因此**能被页面检测到**，与油猴脚本处境相同。它**不向页面暴露任何全局对象、控制函数或 API**。
- 因为原脚本靠页面存储跨标签页共享会话，`/user/token` 的 refresh token 也会写进 `iwara.tv` 的 `localStorage`（同键名、同行为）。**站点上任何脚本本来就能读自己的 `localStorage`**；若你不能接受这一点，请不要开启依赖登录的功能。
- `<html>` 上可能出现两个**无敏感内容**的时序属性（`data-ia-hook`、`data-ia-early`、`data-ia-bridge`），只含 `readyState` / `body` 是否存在 / 元素个数与连接状态，**不含版本号、ID、token 或任何用户标识**。它们的存在只为让自动化 e2e 能客观证明「注入确实早于页面脚本」。
- 本扩展**未申请 `web_accessible_resources`**，页面脚本无法取到扩展的源文件。

# 商店上架素材

分发路线：**AMO**（Firefox，已上架，见下文第二节）、**Firefox 自建签名自更新**（设环境变量，包内注入 `gecko.update_url`）、**Chromium 系手动加载**（Chrome Web Store 已拒绝且不再重投，见下文与 [07-install-chromium.md](07-install-chromium.md)）。

> 首轮发布建议保留旧版脚本一个发布周期，README 提供迁移指引；确认无误后用户再禁用旧脚本。发布流程见 [06-testing-and-release.md](06-testing-and-release.md)。

## 一、Chrome Web Store

> **状态：已拒绝，不再提交。** Chromium 系改为手动加载，安装流程见 [07-install-chromium.md](07-install-chromium.md)。本节以下内容仅作存档与申诉参考。

### 拒绝记录（2026-10-30）

| 字段         | 内容                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| 送审版本     | 0.1.31                                                                                                |
| 违规行为类型 | 内容政策                                                                                              |
| 参考 ID      | [`Grey Lithium`](https://developer.chrome.com/docs/webstore/troubleshooting/#pornography)（色情内容） |
| 违规发生日期 | 2026-10-30                                                                                            |
| 纠正要求     | 请移除所有与色情相关的内容/代码                                                                       |
| 政策条款     | 「我们不允许发布任何包含裸体画面、性行为图像、露骨色情内容或会将用户定向到此类内容的产品」            |
| 政策引用     | 开发者服务条款 / 计划政策 / 品牌推广指南                                                              |

判定依据是 troubleshooting 页面对 `Grey Lithium` 列出的第 4 条原因：**该扩展程序的主要目的是改进提供露骨色情内容的网站**。该条对应的处置写的是「您应取消发布该扩展程序」，属禁止项，不存在「整改后重投」的路径。

已核实、可作为申诉论据但不改变判定的事实：

- 扩展代码与商品素材中不含任何露骨内容：无成人图片/视频/文案，图标是自绘 SVG 于构建期栅格化，全部 JS 打包在包内。
- 不代理、不绕过站点访问限制，只处理用户本已登录可见的页面。
- 商品详情的「成人内容」开关**送审时已勾选**，仍按「主要用途」判定——该标记只适用于成人内容属附带功能的情形。

结论：不改产品定位、不再重投。改成「通用下载器」或抹掉站点名会另外触发欺骗行为、关键字堆砌、最低功能等条款，且站点性质不变。

### 上传包

`dist/chrome.zip`（`npm run package:chrome`；manifest.json 位于包根）

版本字段自动校验：`minimum_chrome_version: 111`。

### Basic information

| 项             | 内容                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Name           | Iwara Assistant                                                                                                              |
| Summary (≤132) | Download and manage videos from iwara.tv: browser/Aria2/iwaradl channels, list filters, metadata cache, queue notifications. |
| Category       | Tools                                                                                                                        |
| Language       | en + ja + zh_CN（商店文字素材多语言在下方；扩展 locale 码用下划线）                                                          |
| License        | Apache-2.0（与仓库根 `LICENSE` 一致）                                                                                        |

### Privacy tab（审核必填）

- **Privacy policy URL**：指向仓库 `PRIVACY.md` 的渲染页（建议 GitHub Pages 或仓库 raw 链接）。
- **Single purpose**：`Enhance iwara.tv with video download management (filters, queue, multiple download backends).`
- **Permission justifications**（逐条，供 reviewer）：
    - `storage` — Persist user settings, cached login tokens, and the download queue. Local-only.
    - `downloads` — Save video files and metadata JSON via the browser download channel.
    - `alarms` — Periodic download reconciliation / failure retry / WebSocket keep-alive for the Aria2 channel.
    - `contextMenus` — Right-click "Download this video" context menu entry.
    - `notifications` — Show download completion/failure system notifications (the extension's only feedback channel).
    - `clipboardWrite` — Copy the computed save filename to clipboard when the user invokes it.
    - `declarativeNetRequest` — Used **only** for the phishing look-alike protection described below. When a page is flagged, the background adds one in-memory **session** rule for that tab (`tabIds`), which makes the browser block every request the page makes (images, fonts, form posts, beacons, cross-origin frames, workers) except top-level navigation. The rule is removed when the user clicks “continue”, when the tab navigates elsewhere, when the tab closes, or when the browser exits. **No ruleset is bundled and no request data is read** — the extension only adds/removes the rule; it does not use `declarativeNetRequestFeedback`.
    - `host_permissions <all_urls>` — Two uses, neither is “read any site's content”. (1) Background `fetch` to **user-configured** Aria2/iwaradl/MediaCenter endpoints: the host/port are typed by the user (localhost, LAN, reverse proxy), so they cannot be enumerated in the manifest. (2) **Phishing look-alike protection**: on every page two tiny scripts compare `location.hostname` with the official iwara domain list; if the host name contains the brand but is not official, a full-page warning is shown, the page's own network APIs (`fetch`/`XHR`/`WebSocket`/`sendBeacon`/form submit/WebRTC) are stubbed out **and** the network-level rule above is applied, until the user chooses to continue. This needs the host name of arbitrary sites — a per-site model would be blind exactly where the risk is. **Only the host name is read**; no page content is read, stored, or transmitted. iwara-specific scripts still match `*://*.iwara.tv/*` only.
    - No `optional_host_permissions` — host access is declared once at install; there are **no** `permissions.request()` call sites in the codebase, and Settings → RPC has no authorization step.
- **Remote code**: None. All JS is bundled locally (React production build, no eval).
- **Data usage**: 不收集/不上传任何数据（对应 PRIVACY.md）。

## 二、AMO（Firefox Add-ons）

### 状态：已上架

产品页：<https://addons.mozilla.org/firefox/addon/iwara-assistant/>（`/zh-CN/` 等语言前缀均可访问）

| 项       | 值                                                                   |
| -------- | -------------------------------------------------------------------- |
| 上架版本 | **0.1.30**（与仓库 0.1.32 有差距，发版后走「新版本」上传）           |
| 审核结果 | 已通过审核（2026-10-29，无人工退回记录）                             |
| 包体积   | 716.03 KB                                                            |
| 许可证   | Apache License 2.0                                                   |
| 分类     | 下载管理                                                             |
| 数据收集 | 「开发者称此扩展无需收集数据」（对应 `data_collection_permissions`） |

商店页当前**待补**：描述为空、未上传图标与截图、「实验性」开关仍为勾选。三项都会直接压低曝光度（实验性会额外限流），文案已备在本文第三节。

### 上传包

`dist/firefox.zip`（`npm run package:firefox`）

自检结果：`addons-linter` **errors 0 / notices 0 / warnings 2**；manifest 含 `browser_specific_settings.gecko.id`、`strict_min_version: 128.0`、`data_collection_permissions: { required: ['none'] }`。

2 条警告都是**已知且接受**的（不阻断签名，提交时可在 reviewer 备注里说明）：

| 警告                                             | 数量 | 说明                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`         | 1    | `data_collection_permissions` 从 Firefox 140 才支持，而 `strict_min_version` 是 128（`world: "MAIN"` 的门槛）。低版本会忽略这个未知键，功能不受影响；AMO 又要求新提交必须声明，所以只能接受该警告。若要清零，最低版本需提到 142（桌面/Android 同时满足）。 |
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | 1    | 同上，Android 的引入版本是 142。本扩展是**桌面专用**（未声明 `gecko_android`），这条警告不代表实际要支持 Android。                                                                                                                                         |

> react-dom 的 4 条 `UNSAFE_VAR_ASSIGNMENT` 已由构建后处理消除：产物里 `el.innerHTML = html`（仅 `dangerouslySetInnerHTML` 分支，本项目零使用）被改写为等价的 `Reflect.set(el, "innerHTML", html)`，见 `build/innerHtmlRewrite.ts`。addons-linter 关闭了内联 `eslint-disable`，注释抑制无效。

### 路线 A：AMO 上传审核（默认）

直接用 `dist/firefox.zip` 提交 AMO（Add-ons → 提交新附加组件）。License 字段选 **Apache License 2.0**（与仓库根 `LICENSE` 一致）。审核要点：

- `<all_urls>` host 权限 + `declarativeNetRequest`（两处用途：用户自填的 RPC 端点 + 任意站点的仿冒域名判定与网络层封锁）→ 引用 `PRIVACY.md` 的权限说明同上；并说明 iwara 专属脚本仍只匹配 `*://*.iwara.tv/*`、全站脚本只读 `location.hostname`、DNR 只做「加一条/删一条 session 规则」且不读请求数据。
- 2 条警告的口径见上表：`strict_min_version: 128.0` 与 `data_collection_permissions`（Firefox 140 / Android 142 引入）的版本错配，不阻断签名。

### 路线 B：自建签名 + 自更新（可选）

```powershell
$env:IWARA_ASSISTANT_UPDATE_URL = "https://your-host/updates.json"
npm run build:firefox; npm run package:firefox
# 用 AMO 账号 API 密钥自签（生成可分发 xpi）：
npx web-ext sign --source-dir dist/firefox --api-key <JWT-issuer> --api-secret <JWT-secret> --artifacts-dir dist/signed
```

- `IWARA_ASSISTANT_UPDATE_URL` 注入 `gecko.update_url`（构建期打印警告；该包不可再走 AMO 上传通道）。
- `updates.json` 形如：
    ```json
    {
        "addons": {
            "iwara-assistant@dawnlc.me": {
                "updates": [{ "version": "0.1.0", "update_link": "https://your-host/iwara_assistant-0.1.0.xpi" }]
            }
        }
    }
    ```
- 后续发版：`npm version patch|minor|major` 改 `package.json`（唯一真源，构建期写入 manifest）→ 重建重签 → updates.json 增一行。

> 版本号规则：只有 `package.json` 的 `version` 可编辑。构建脚本（`build/version.ts`）会在**动 dist 之前**校验它：
> 必须 1~4 段十进制整数、非零段不得前导零、每段 ≤ 65535（Chrome 上限，AMO 的 9 位上限自动满足）、不得全零。
> 预发布标识（`1.0.0-beta.1`）会被直接拒绝（不静默削成 `1.0.0`）——要用构建号请写第 4 段（`1.0.0.1`）。

## 三、多语言商店文案

### English

**Summary**: Download and manage videos from iwara.tv: browser/Aria2/iwaradl channels, list filters, metadata cache, queue notifications.

**Description**:
Iwara Assistant turns IwaraDownloadTool from a userscript into a native browser extension.

- Right-click any video link → "Iwara Assistant → Download this video".
- Four download channels: browser (downloads API, **the default** — real progress/completion tracking), Aria2 (JSON-RPC over WebSocket — completions arrive instantly via push), iwaradl, or open-the-link (Others).
- Save path templates with per-segment sanitizing (NFKC, emoji folding, length caps) and live preview.
- Feed filters: hide liked videos; optionally merge private/unlisted videos you already have into the home timeline.
- Background video library (IndexedDB) with the download queue, system notifications, and a badge counter — even with no tabs open.
- Settings, RPC endpoints (host access is declared once at install; no per-origin permission prompt), migration wizard from the userscript, and a built-in guide.

No data collection. No telemetry. Everything stays in your browser.

### 日本語

**Summary**: iwara.tv の動画を一括ダウンロード：Browser/Aria2/iwaradl 対応、リストフィルタ、メタデータキャッシュ、通知つきキュー。

**Description**:
右クリックから動画をダウンロード。4 つのダウンロード経路（ブラウザ内蔵＝既定／Aria2 WebSocket リアルタイム追跡／iwaradl／直接リンク）、保存パステンプレートとファイル名サニタイズ、フィードフィルタ、バックグラウンドキューとシステム通知、ユーザースクリプトからの移行ウィザードを内蔵。データ収集なし，すべてはブラウザ内に留まります。

### 简体中文

**Summary**: 批量下载与管理 iwara.tv 视频：Browser/Aria2/iwaradl/直链四通道、列表过滤、元数据缓存、系统通知任务队列。

**Description**:
Iwara Assistant 是面向 iwara.tv 的浏览器扩展：

- 右键视频链接 → 「Iwara Assistant → 下载此视频」。
- 四条下载通道：浏览器内建（默认，进度与完成情况真实回传）、Aria2（WebSocket 实时推送，完成/失败即时通知）、iwaradl、后台标签页开直链。
- 保存路径模板（逐段清洗：NFKC / emoji 折叠 / 长度截断）+ 实时预览。
- 信息流过滤：隐藏已点赞内容；可把已收录的私有/不公开视频回填到首页时间线。
- 后台视频库 + 任务队列持久化（浏览器关掉标签页任务照跑），完成/失败走系统通知 + 角标。
- RPC 端点随安装一次授予站点访问（没有逐地址授权弹窗）、旧版数据迁移向导、内置使用引导。

不收集任何数据，无遥测；一切数据只留在你的浏览器里。

## 四、正式图标

图标源文件只有 `assets/icons/logo.svg` 一个，`npm run build` 会经 @resvg/resvg-js 栅格化成 `dist/<target>/icons/icon-{16,48,128}.png`（商店徽章取同一个 128×128 文件即可）。需要单独取用时跑 `npm run build:icons`，它会另存一份到 `assets/icons/`（该目录下的 PNG 不入库）。商店徽章另需 440×280 宣传图（需图像设计工具制作，商店侧单独上传）。

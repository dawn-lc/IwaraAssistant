# 商店上架素材（M6）

双路线：**AMO 上传审核**（默认，零配置）与 **Firefox 自建签名自更新**（设环境变量，包内注入 `gecko.update_url`）。Chrome Web Store 仅一条路线（上传审核）。

> 迁移期纪律（docs/06）：发布后**保留油猴脚本并行一个发布周期**，README 提供迁移指引；确认无误后用户再禁用旧脚本。

## 一、Chrome Web Store

### 上传包

`dist/chrome.zip`（`npm run package:chrome`；manifest.json 位于包根）

版本字段自动校验：`minimum_chrome_version: 111`。

### Basic information

| 项             | 内容                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Name           | Iwara Assistant                                                                                                              |
| Summary (≤132) | Download and manage videos from iwara.tv: browser/Aria2/iwaradl channels, list filters, metadata cache, queue notifications. |
| Category       | Tools                                                                                                                        |
| Language       | en + ja + zh-CN（商店文字素材多语言在下方）                                                                                  |
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

### 上传包

`dist/firefox.zip`（`npm run package:firefox`）

自检结果：`addons-linter` **errors 0 / notices 0 / warnings 6**；manifest 含 `browser_specific_settings.gecko.id`、`strict_min_version: 128.0`、`data_collection_permissions: { required: ['none'] }`。

6 条警告全部是**已知且接受**的（不阻断签名，提交时可在 reviewer 备注里说明）：

| 警告                                             | 数量 | 说明                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`         | 1    | `data_collection_permissions` 从 Firefox 140 才支持，而 `strict_min_version` 是 128（`world: "MAIN"` 的门槛）。低版本会忽略这个未知键，功能不受影响；AMO 又要求新提交必须声明，所以只能接受该警告。若要清零，最低版本需提到 142（桌面/Android 同时满足）。 |
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | 1    | 同上，Android 的引入版本是 142。本扩展是**桌面专用**（未声明 `gecko_android`），这条警告不代表实际要支持 Android。                                                                                                                                         |
| `UNSAFE_VAR_ASSIGNMENT`                          | 4    | 来自 react-dom 产品构建内部的 `setInnerHTML`（`dangerouslySetInnerHTML` 处理器，本项目组件零使用），不是我们的代码。                                                                                                                                       |

### 路线 A：AMO 上传审核（默认）

直接用 `dist/firefox.zip` 提交 AMO（Add-ons → 提交新附加组件）。License 字段选 **Apache License 2.0**（与仓库根 `LICENSE` 一致）。审核要点：

- `<all_urls>` host 权限 + `declarativeNetRequest`（两处用途：用户自填的 RPC 端点 + 任意站点的仿冒域名判定与网络层封锁）→ 引用 `PRIVACY.md` 的权限说明同上；并说明 iwara 专属脚本仍只匹配 `*://*.iwara.tv/*`、全站脚本只读 `location.hostname`、DNR 只做「加一条/删一条 session 规则」且不读请求数据。
- 6 条警告的口径见上表：2 条是 `strict_min_version: 128.0` 与 `data_collection_permissions`（Firefox 140 / Android 142 引入）的版本错配，4 条是 react-dom 内部实现。均不阻断签名。

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

**Summary**: 批量下载与管理 iwara.tv 视频：Browser/Aria2/iwaradl 三通道、列表过滤、元数据缓存、系统通知任务队列。

**Description**:
Iwara Assistant 是 IwaraDownloadTool 油猴脚本的扩展化版本：

- 右键视频链接 → 「Iwara Assistant → 下载此视频」。
- 四条下载通道：浏览器内建（默认，进度与完成情况真实回传）、Aria2（WebSocket 实时推送，完成/失败即时通知）、iwaradl、后台标签页开直链。
- 保存路径模板（逐段清洗：NFKC / emoji 折叠 / 长度截断）+ 实时预览。
- 信息流过滤：隐藏已点赞内容；可把已收录的私有/不公开视频回填到首页时间线。
- 后台视频库 + 任务队列持久化（浏览器关掉标签页任务照跑），完成/失败走系统通知 + 角标。
- RPC 端点随安装一次授予站点访问（没有逐地址授权弹窗）、油猴数据迁移向导、内置使用引导。

不收集任何数据，无遥测；一切数据只留在你的浏览器里。

## 四、正式图标

图标源文件只有 `assets/icons/logo.svg` 一个，`npm run build` 会经 @resvg/resvg-js 栅格化成 `dist/<target>/icons/icon-{16,48,128}.png`（商店徽章取同一个 128×128 文件即可）。需要单独取用时跑 `npm run build:icons`，它会另存一份到 `assets/icons/`（该目录下的 PNG 不入库）。商店徽章另需 440×280 宣传图（需图像设计工具制作，商店侧单独上传）。

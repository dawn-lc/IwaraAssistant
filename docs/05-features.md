# 05 功能说明

本文描述扩展当前提供的功能与行为边界。实现细节以 `src/` 为准；架构分层见 [01-architecture.md](01-architecture.md)，跨浏览器差异见 [02-cross-browser.md](02-cross-browser.md)，消息类型见 [04-messaging.md](04-messaging.md)。

## 页面内功能

页面脚本只保留**高频操作**：选择、下载、菜单与水印。配置、队列、进度、错误详情一律放在扩展自有页面，避免与站点 DOM 和样式对抗。

### 页面类型与卡片选择

- 页面类型识别（`src/shared/pageType.ts`）：视频详情页、视频列表页、其他页面。决定菜单项、链接预检与「下载当前」是否出现。
- 卡片复选框（`src/content/page/cardMeta.ts` + `src/content/css/videoCard.css`）：仅在开启卡片按钮或进入选择模式时注入，正常浏览时页面零新增节点。
    - 类名 `selectButton`，`input` 上带 `videoID` / `videoName` / `videoAlias` / `videoAuthor` 属性。
    - 尺寸 38×38，位于卡片右上角，`accent-color: var(--primary)`，`z-index: 100`。
    - 点击时 `stopImmediatePropagation`，不触发站点卡片的导航行为。
- 选择模式工具条：本页全选 / 反选 / 取消本页 / 取消全部、手动输入视频 ID、下载当前。
- 选区跨标签页共享（`storage.local.pageSelection` + `storage.onChanged`），任一标签页的全选/取消都会同步到其他标签页。
- `Space` 悬浮快捷键切换选择模式；右键菜单提供下载入口。
- 播放列表页：仅列表所有者可见每卡片的删除按钮，删除操作走后台消息，不在页面直写数据。

### 菜单、样式与水印

- 悬浮菜单（`src/content/page/menu.ts` + `src/content/css/menu.css`）：右侧中部滑出，桌面 hover 展开 / 移出 300ms 收起，触控点击切换，外部点击收起；`720px` / `480px` / `pointer: coarse` 三档响应式。
- 菜单项按页面类型门控：视频页提供「下载当前视频」，其他页面只保留选择与手动下载入口；导出/导入配置与打开设置归 options，不进入页内菜单。
- 美化与宽屏（`beautify.css` / `widescreen.css`）：规则常驻，通过 `html.ia-beautify` / `html.ia-widescreen` 类切换；CSS 由 manifest `content_scripts[].css` 声明式注入，运行时不写 `<style>`。
- 水印（`src/content/page/watermark.ts`）：右下角 `p.fixed-bottom-right`，显示应用名、版本与已选中数量；连续点击 5 次开启调试标记（写 storage 后 reload）。
- SPA 路由切换后自动重扫页面并重建控件；配置变化通过 `storage.onChanged` 热更新，无需刷新页面。

### 页面内边界

- **不提供页内 toast**：成功/失败/入队反馈统一走系统通知。
- **不提供页内进度条**：进度、队列、历史与错误详情在 options「任务」页签查看。
- **不提供页内配置面板**：全部配置在 options 中完成。
- **不在 `window` 上暴露任何控制入口**：MAIN 世界只做请求拦截与响应改写，见 [01-architecture.md](01-architecture.md#注入时机与安全)。

## 下载

### 四种通道

| 通道              | 实现                                                | 子目录             | 追踪与取消                                                       |
| ----------------- | --------------------------------------------------- | ------------------ | ---------------------------------------------------------------- |
| `browser`（内建） | `browser.downloads.download`，两宿主同构            | ✅ 两宿主一致      | ✅ `downloads.onChanged` 收敛终态；可 `downloads.cancel`         |
| `aria2`           | 后台 JSON-RPC（`127.0.0.1:6800`）+ WebSocket / 轮询 | ✅ 由 aria2 承担   | ✅ WS 通知 + 定时扫描；可 `remove` + `removeDownloadResult`      |
| `iwaradl`         | 后台 HTTP（`127.0.0.1:23456`）+ 转发 cookie         | ✅ 由 iwaradl 承担 | ✅ 轮询 `GET /api/tasks`；仅 `pending` 任务可取消                |
| `others`          | 后台标签页打开直链，交给浏览器或外部下载器          | ❌                 | ⚠️ 交付即终态；若浏览器开始下载，会按 `videoid` 接管并转为全追踪 |

### 批量去重

`src/shared/downloadDedupe.ts` 提供两层判据，避免同一视频重复入队：

| 层       | 判据                                                                                                       | 开销           | 门控                        |
| -------- | ---------------------------------------------------------------------------------------------------------- | -------------- | --------------------------- |
| 本地队列 | 同一 `videoId` 的最新记录为 `queued` / `running` / `complete` → 跳过；`failed` 不跳过（重新勾选就是重试）  | 零（内存数组） | 无                          |
| aria2    | `tellActive` + `tellStopped` 能反查该 `videoId`（`videoid` 参数或 `[ID].mp4`）且状态非 `error` / `removed` | 两次 RPC       | 仅 `downloadType === aria2` |

两层缺一不可：aria2 的 `tellStopped` 默认只保留 1000 条，库大了会漏；本地队列在「清空已结束」后也会变空。被跳过的 ID 会从页内勾选中移除，并在汇总通知中如实报出数量。

### 浏览器通道并发

`downloads.download()` 一返回，传输就由浏览器继续执行；批量投递每 3 秒发起一个，并不等待上一个完成。为避免一次勾选几十个造成 CDN 并发失控，配置项 `browserConcurrentDownloads`（1–10，默认 3）限制同时传输的数量：

- 判据在 `src/shared/browserConcurrency.ts`（`slotAvailable` / `nextQueuedBrowserTask`，含「启动中」占位与 FIFO）。
- 闸门在投递之前（`src/background/download/dispatch.ts`），不是事后补挡。
- 槽满时任务保持 `queued`，UI 显示「排队中」，不失败、不丢弃，批量调用可以继续。
- 终态、移除任务、新任务与启动恢复都会触发 `pumpBrowserQueue()` 推进队列。
- 并发真相只存在于队列：`kind === 'browser' && status === 'running'` 的数量。内存计数在 SW 回收后会归零。
- `others` 被接管成 `browser` 后同样占槽；aria2 / iwaradl 不受此上限影响。

### 进度与后端容量

扩展只读取后端真实值，不替后端决定并发：

| 数据                                                  | 来源                               | 用途                     |
| ----------------------------------------------------- | ---------------------------------- | ------------------------ |
| `active` / `waiting` / `numStopped` / `downloadSpeed` | aria2 `getGlobalStat`              | RPC 页「后端容量」       |
| `max-concurrent-downloads`                            | aria2 `getGlobalOption`            | 容量上限（未知则不显示） |
| 任务 `progress`（0–1）                                | iwaradl `GET /api/tasks`           | 任务列表进度             |
| `completedLength / totalLength`                       | aria2 `tellActive` / `tellStopped` | 任务列表进度             |

aria2 的 `waiting` / `paused` 映射为 `queued`（「排队中（aria2）」），只有 `active` 才是 `running`。浏览器通道拿不到字节数，进度字段缺失时界面不显示进度，不用 0 冒充。

### 任务状态与队列操作

任务状态：`queued`、`running`、`complete`、`failed`、`skipped`。

- **移除**：先按通道能力取消下载器，再删记录。能取消的通道（browser / aria2 / iwaradl pending）先取消；`others` 没有撤销接口，删记录但提示「可能仍在下载」；仍在传输且取消失败时抛错并保留任务。
- **清空已结束**：只清 `complete` / `failed` 等终态，不清 `skipped`（它属于待办）。
- **重试**：单条重试重置尝试次数；`skipped` 不允许重试，否则会再次命中链接预检形成死循环，只能走「强制下载」。
- **启动对账**：`boot()` 会校正持久化队列与后端真实状态，避免 SW 回收后界面永远停在 `running`。

### 链接预检与元数据

- `CHECK_LINK` 对下载地址做 HEAD 探测（10 秒超时，仅 `http/https`）。命中的任务仍会入库，状态为 `skipped`，并带上视频页地址与保存文件名，方便用户稍后处理。
- `skipped` 不算失败、不算进行中、不算已结束；任务列表提供「打开视频页」与「强制下载」。
- 「强制下载」走 `FORCE_DOWNLOAD`，不伪造页面类型，避免绕过逻辑随页面判定变化而失效。
- 元数据 JSON 通过 `DOWNLOAD_METADATA` 单独下载，文件名经过 `analyzePath` / `toDownloadFilename` 清洗。
- `autoCopySaveFileName` 开启时，检测到网盘链接会把保存文件名写入剪贴板（Chrome 经 offscreen 文档，Firefox 后台页直接写）。

## 通知与系统集成

- `browser.notifications` 是页面/后台唯一的系统级反馈通道：入队结果、下载完成/中断、重试失败、链接预检命中都走通知。
- 批量入队按任务键去重聚合成单条（「已加入 N 个下载任务」）；全部被跳过的场景使用单独文案。
- 点击通知跳到它登记过的目标：任务面板、好友审批、视频页或播放列表；目标记录在 `storage.session`，与通知生命周期一致。
- 用户关闭系统通知时降级为静默 + 角标计数，不回退页内 toast。
- 外部端点失败必须给出可操作文案：指出哪个端点、下一步做什么，只报 `host`，不把带 token 的完整 URL 写进通知或日志。
- 工具栏角标显示进行中/队列数量；右键菜单提供原生入口。
- options 内部使用 `sonner` 展示保存、队列操作与迁移反馈；该库只进入 options bundle，content script 不引入任何 React/UI 库。

## 配置与多语言

options 共 9 个页签：

| 页签     | 职责                                                   |
| -------- | ------------------------------------------------------ |
| 下载     | 下载通道、路径模板与实时预览、并发数、自动复制文件名等 |
| RPC      | aria2 / iwaradl 端点与连接测试                         |
| 过滤     | 点赞过滤、私有/未列出过滤、标签与词表过滤              |
| 清洗     | 文件名/标题清洗规则与预览                              |
| 任务     | 队列列表、进度、重试、移除、清空已结束                 |
| 好友     | 好友请求批量审批条件、进度与结果                       |
| 迁移     | 旧版数据导入、配置/完整包导入导出                      |
| 高级     | 界面语言、扩展行为、页面按钮、美容/宽屏等              |
| 使用引导 | 安装引导、站点访问权限诊断、钓鱼防护说明               |

- 配置由 `src/shared/configSchema.ts`（zod）校验：缺省字段补默认值，脏数据回退。
- 界面语言支持 `auto` / `en` / `ja` / `zh`；`auto` 跟随浏览器 UI 语言。字典在 `src/shared/locales/*.json`，由 i18next 同步初始化（`initAsync: false`），options、popup、页内菜单、右键菜单与系统通知共用同一个实例。
- React 组件使用 `react-i18next` 的 `useTranslation()`；非组件模块使用 `i18n.t()`；键名与返回类型由 `src/shared/i18next.d.ts` 在编译期校验。
- 「使用引导」页只做权限诊断，不提供授权按钮：required host 权限无法通过 `permissions.request()` 重新申请，撤销后需回到扩展管理页恢复。
- `onInstalled` 在安装与更新时打开引导页；发布说明放在商店页 / release notes，不在扩展内保留更新日志。

## 数据与迁移

### 本地存储

- `storage.local`：`config`（配置）、`downloadQueue`（任务队列）、`legacyDb`（旧库探测结果）、`promoteAuthorState`（关注作者状态）、`siteRating`（站点内容分级）等。
- `storage.session`：好友审批进度、钓鱼防护放行记录、通知点击目标。浏览器退出即清空，避免跨会话残留。
- 扩展 IndexedDB 四张表：`videos` / `follows` / `friends` / `idmap`。**只允许后台读写**；options 与其余上下文通过消息访问，不允许直接 import 后台 DB 模块。

### 从小脚本版本迁移

旧版油猴脚本把视频库、关注、好友与 ID 映射写在 `iwara.tv` 页面 origin 的 IndexedDB（库名 `IwaraDownloadTool`）。扩展库在扩展 origin，后台看不到页面 IDB，因此迁移只能经 content script：

1. 首次进入 iwara 页面时只读探测旧库存在性与各表条数（`indexedDB.databases()`，不凭空建库）。
2. 迁移页显示条数，由用户显式点击导入；自动导入会在用户删除数据后把旧记录复活。
3. content script 按主键区间分页读取（不使用 `getAll()`），按 16 MiB / 1000 条装批回传。
4. 后台逐条 sanitize 后按 32 MiB / 500 条一节建事务写入；某节失败就二分到单条，坏记录计入 `failed`，其余数据继续落库。
5. 结果如实展示 `written / invalid / failed` 计数，不用「导入成功」掩盖丢数据。

配置不在旧库中（旧脚本存在 GM 私有存储），只能通过迁移页粘贴裸配置 JSON 或导入文件；本扩展也支持导出完整迁移包文件。剪贴板导出已移除。

### 同步与 MediaCenter

- 全站投稿分页遍历入库（含 unlisted/private 解析与断点续跑）。
- 订阅流私有/未列出视频遍历入库。
- MediaCenter 批量同步：库里已有完整记录的条目推送到 MediaCenter；aria2 完成回调也可自动入库。
- 后台通过 `browser.alarms` 驱动扫描、重试与保活；Chrome 的 MV3 SW 与 Firefox 的 MV2 持久后台页共用同一 bundle。

## 社交与钓鱼防护

### 社交

- 自动关注 / 自动点赞：任务创建时触发，结果写入 IndexedDB；关注作者默认开启，未登录时不发请求。
- 好友请求批量审批：9 类条件、any/all 模式、证据采集、节流与进度快照；审批过程可能超过单条消息时限，因此只返回「已开始」，结果由轮询快照获取。

### 钓鱼仿冒防护

- 官方域名：`iwara.tv` / `iwara.zip` / `iwara.shop` / `iwara.ai`（含子域）。
- 非官方主机名只要包含品牌词，即触发全屏警告与三层封锁：
    1. 后台通过 `declarativeNetRequest` session 规则拦截该标签页除顶层导航外的一切请求；
    2. 页面 JS 层替换 `fetch` / XHR / WebSocket / EventSource / `sendBeacon` / 表单提交 / `RTCPeerConnection`；
    3. 只有用户在警告面板明确点「继续访问」才解除封锁，并在该标签页记住决定；关闭或离开即失效。
- 判定逻辑在 `src/shared/guardRule.ts`，后台状态机在 `src/background/runtime/guardRules.ts`，两者均有单元测试；真实注入与拦截由 Playwright 用例覆盖。
- 放行记录存放在 `storage.session`：既避免 SW 回收后重置，也避免 `tabId` 跨浏览器会话复用到新标签页。

## 已知取舍

- 页内不提供 toast、进度条、配置面板与好友审批面板；这些能力全部放在 options，页面只保留下载和选择动作。
- 浏览器通道无法读取字节进度，任务列表在该通道下不显示百分比。
- `others` 通道交付后即离开扩展控制；只有被浏览器接管后才恢复全追踪。
- Firefox 使用 MV2 产物以避开 MV3 的本地网络访问限制；代价是清单形状与 `browserAction` shim，详见 [02-cross-browser.md](02-cross-browser.md)。

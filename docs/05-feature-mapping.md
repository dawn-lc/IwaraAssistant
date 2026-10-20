# 05 功能映射：油猴能力 → 扩展能力

## `@grant` 逐项映射（mata.json 全部 14 项）

| 油猴授权                                              | 原用途（原代码依据）                                                 | 扩展落点                                                                                                                                                                                                                   | 所在上下文           |
| ----------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `GM_getValue/setValue/listValues/deleteValue`         | 配置与跨页队列存储（core/config.ts、gmSyncDictionary.ts）            | `browser.storage.local`；写者收敛为后台+options                                                                                                                                                                            | Background / Options |
| `GM_addValueChangeListener/removeValueChangeListener` | 跨页同步字典                                                         | `storage` 单写者 + `onChanged` 失效广播；**机制删除**                                                                                                                                                                      | —                    |
| `GM_addStyle`                                         | 注入美化/菜单 CSS                                                    | 大部分改 **manifest `content_scripts[].css` 声明式注入**（浏览器导航时自动应用，零 JS）；真正动态的样式（用户自定义皮肤值渲染）经 options 更新后由后台写入 `storage` + content 热替换 `style` 文本，不再需要运行时批量注入 | 页面 / 配置          |
| `（隐含）GM_addValueChangeListener` 式样式热更        | 皮肤/美化开关即时生效                                                | `storage.onChanged` → ISOLATED 更新单个 `<style id>` 文本                                                                                                                                                                  | 页面                 |
| `GM_setClipboard`                                     | `autoCopySaveFileName` 自动写保存文件名                              | `navigator.clipboard.writeText`（offscreen 文档代写，仅 Chrome；Firefox 持久后台页直接写）——页内「导出配置到剪贴板」已移除，配置导出统一走 options「迁移」页签的文件导出                                                   | 均可                 |
| `GM_download`                                         | 视频文件 + 元数据 JSON，子目录文件名（download.ts、db.ts blob 回退） | `browser.downloads.download({ url, filename, conflictAction })`；Firefox 子目录限制见 02                                                                                                                                   | Background           |
| `GM_xmlhttpRequest`                                   | aria2 RPC、iwaradl、Iwara 跨域                                       | **后台 `fetch`** —— host_permissions 授权后无 CORS；失败不再需要 GM 回退                                                                                                                                                   | Background           |
| `GM_openInTab`                                        | 后台标签页打开直链                                                   | `browser.tabs.create({ active: false })`                                                                                                                                                                                   | Background           |
| `GM_info`                                             | 版本号（元数据导出 MetaDataVersion）                                 | `browser.runtime.getManifest().version`                                                                                                                                                                                    | 均可                 |
| `unsafeWindow`                                        | 主世界 fetch 劫持、`navigator.locks` 探测                            | `content_scripts[].world: "MAIN"`（Chrome 111+/Firefox 128+）。原 `core/hijack.ts` 的调试钩子**不迁移**：MAIN world 里的任何 `window.*` 入口都等于把控制权交给页面（详见 01 §注入时机与安全）                              | 页面（保留）         |
| `window.close`                                        | suicide 关闭页面                                                     | **机制删除**（multiPage.ts 不再有选举/让位）                                                                                                                                                                               | —                    |
| （未列出）`GM_saveTab/GM_getTabs`                     | multiPage 在场检测                                                   | **机制删除** → `tabs.query` 现场查询                                                                                                                                                                                       | Background           |

## 被扩展架构直接消灭的功能模块

| 原功能                                           | 原实现                                                    | 扩展后的形态                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 下载管理器页面选举（tryBecomeAria2TrackManager） | GM 锁 + Web Locks 双后端 + 心跳 + 75s 租约                | Background 即管理器；**0 行锁代码**                                                                                     |
| 页面崩溃/关闭后管理权移交                        | `pagehide` 让位 + 租约过期接管 + 重试选举                 | 不存在该问题（SW 挂起有 storage 持久化队列）                                                                            |
| 跨标签页任务队列同步                             | `GM_addValueChangeListener` 监听器风暴                    | storage 单写者 + 队列消息驱动                                                                                           |
| 章鱼式注入配置面板                               | configPanel/configUi 与宿主 DOM 抢节点、body 就绪竞态     | options 独立页面，无任何注入竞态                                                                                        |
| Firefox GM blob 下载回退（db.ts `auto` 模式）    | `browser.downloads` blob URL 无此问题（原代码注释已验证） | 直调 `downloads.download({ url: blobURL })`，**回退逻辑删除**                                                           |
| `@connect *`                                     | 任意 RPC 主机                                             | manifest 一次声明 `host_permissions: <all_urls>`（同时服务钓鱼防护），不做运行时逐主机授权（03 文档「全站 host 权限」） |
| aria2 追踪的 3 个 setInterval                    | 选举/重扫/清锁                                            | 2 个 `browser.alarms` + `downloads.onChanged` 事件                                                                      |

## 批量下载去重（原 `downloadTaskUnique`）

源项目**只能**问 aria2（它没有持久队列），且把这一步放在 `experimentalFeatures` 门控后面。本扩展有两层判据（`src/shared/downloadDedupe.ts`，纯函数 + 单测）：

| 层       | 判据                                                                                                                  | 开销                                                   | 门控                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| 本地队列 | 同一 `videoId` 的**最新**一条记录为 `queued`/`running`/`complete` → 跳过；`failed` 不跳过（重新勾选就是想再试）       | 零（内存数组）                                         | 无                                                                  |
| aria2    | `tellActive` + `tellStopped` 里能反查出该 `videoId`（`videoid` 参数或 `[ID].mp4`）且状态不是 `error`/`removed` → 跳过 | 两次 RPC（端点不可达时降级为只做本地去重，不阻断批量） | 仅 `downloadType === aria2`，**不再受 `experimentalFeatures` 影响** |

为什么必须两层：aria2 的 `tellStopped` 默认只留 1000 条，库大了必然漏；而本地队列在用户「清空已结束」之后又会变空——单靠任一层都会漏判，漏判的后果是 aria2 里堆一批 0% 重复任务（用户实测报备的问题）。被跳过的 ID 同样会从页内勾选里移除（对齐源的 `taskList.delete`），并在通知里如实报出数量；全部被跳过时用单独文案，不显示「共 0 个」。

| 旧脚本页面数据库（IndexedDB） | 页面 origin 的 `IwaraDownloadTool` 库 | **跨 origin 导入**：content script 首次进 iwara 页探测（`indexedDB.databases()`，只读计数）→ 迁移页显示条数 → 用户点「导入」→ 后台转发 `LEGACY_DB_PULL` → content script 按键区间分页读库（不自 `getAll()`），按 16 MiB / 1000 条装批回传 → 后台 32 MiB / 500 条一节建事务、失败二分隔离入库。**检测自动、导入显式**（自动导入会复活已删数据）；配置不在该库（GM 私有存储），只能粘贴/文件导入（旧脚本的「导出配置」是剪贴板里的裸配置 JSON） |

## 新获得的能力（油猴不可能有的特权）

| 新能力                         | API                                                  | 用途                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统级通知（**唯一反馈通道**） | `browser.notifications`                              | 替代原 `core/notify.ts`/`ui/toastify.ts` 的全部场景：入队成功/失败提示、下载完成/中断、重试失败。批量入队按任务键去重聚合成单条（"已加入 N 个下载任务"）；点击通知打开它登记过的页面（任务 → options#tasks / 好友审批 → options#friends / 第三方链接 → 视频页 / 播放列表删除 → 该播放列表）；若用户在 OS 层关闭通知则降级为静默 + 角标计数（不回退自建 toast）。**既然它是唯一反馈通道，失败文案必须可操作**：不能把引擎原文直接丢给用户（例如 RPC 端点不可达时 Firefox 只给 `NetworkError when attempting to fetch resource.`，既不说哪个端点也不说该做什么）——外部端点失败一律翻译成「哪个端点 + 下一步」（`shared/endpoint.ts`），且只报 `host`，避免把带 token 的完整 URL 写进通知与日志 |
| 工具栏角标                     | `browser.action.setBadgeText`                        | 后台队列长度/进行中数量一目了然，无需打开页面                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 右键菜单                       | `browser.contextMenus`                               | 在视频链接/视频页上右键"下载此视频"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 键盘快捷键                     | `browser.commands`                                   | 一键切换选择模式、下载选中；原实现只能靠 UI 按钮                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 侧栏任务面板                   | Chrome `sidePanel`（114+）/ Firefox `sidebar_action` | 任务队列可视化管理面板，替代原"唯一管理器页面"承担的追踪展示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| options 页 i18n                | `browser.i18n` + `_locales/`                         | **已实现运行时多语言（i18next，与 MediaCenter 同栈）**：字典 `src/shared/locales/*.json`（zh/en/ja）+ `shared/i18n.ts`（`{name}` 插值、`getUILanguage()` 映射、`config.language` 持久化）；**无中间层**：React 组件用 `useTranslation()`（`I18nextProvider` 注入实例，`react-i18next` 只进 React 包），非组件模块用 `i18n.t()`；options/popup/页内菜单/右键菜单/系统通知共用同一个实例；`_locales` 只留 `extName`                                                                                                                                                                                                                                                                            |
| 独立进程窗口                   | 少用——侧栏已覆盖                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 通知生命周期：源 toastify vs 系统通知

源的 `ui/toastify.ts` 是**完全由脚本控制生命周期**的页内 DOM：`duration > 0` 时 `setTimeout` 自动 `hide()`，`duration: -1` 常驻，`hide()` 幂等、`mouseover` 暂停计时、进度条由 CSS animation 驱动、可挂任意按钮与富文本。系统通知只能对齐其中一部分，**对不上的部分是平台硬约束，不是没做**。

| 源 toast 能力                                   | 系统通知 | 说明                                                                                                                                       |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Info` 默认 2000ms 自动消失                     | ⚠️ 近似  | 无任何「显示时长」参数（`timeoutType` 已废弃），只能自己 `setTimeout` → `notifications.clear()`；SW 被挂起时定时器丢失，退化为「通知留着」 |
| `Warn`/`Error` 的 `duration: -1` 常驻           | ✅       | `requireInteraction: true`（`notifyWarn` 与失败的 `notifyTask` 默认开启）                                                                  |
| `hide()` / 关闭按钮                             | ✅       | `notifications.clear(id)`（导出 `clearNotification`；`removeTask` / `clearFinished` 会顺手关掉对应通知）                                   |
| 同 `id` 新建时先关旧的                          | ✅       | `create` 同 id 会先清旧通知再创建（文档明示）                                                                                              |
| 原地 `update()`（改文字）                       | ⚠️ 重建  | 只能「同 id 重建」；`notifications.update()` Firefox 不支持，因此不依赖它                                                                  |
| `onClose(reason)` 区分 `timeout`/`close-button` | ⚠️ 部分  | 只有 `onClosed(id, byUser)`，且**点击也会触发它**、顺序无保证 → 不做清理，改按 `getAll()` 对账                                             |
| 进度条 `progressRatio`                          | ❌       | 系统通知没有可靠的进度渲染（Chrome 的 `progress` 只在部分 Linux DE 生效，且要 `update()`）                                                 |
| 自定义按钮 `buttons[]`                          | ❌       | Chrome 桌面版不渲染、Firefox 不支持 → 只能「整条点击 = 1 个动作」                                                                          |
| `mouseover` 暂停计时                            | ❌       | 没有 DOM 事件                                                                                                                              |
| 富文本 / 多行 / 自定义样式与位置                | ❌       | 只有 `title` + `message` 纯文本，长度受限                                                                                                  |
| 页面刷新即消失                                  | ❌       | 系统通知进 OS 通知中心，可能跨页面、跨窗口一直留着 → 见下                                                                                  |

因为「通知会一直留在通知中心」是源项目不存在的问题，有两处必须自己收敛：

1. **任务通知 id 用视频 ID**（`task-<videoId>`）而不是任务 ID：任务 ID 是每次尝试新生成的 uuid，重试三次会在通知中心留下三条同视频通知。收敛后同一视频只有一条。
2. **登记表按 `notifications.getAll()` 对账**：只靠条数上限淘汰的话，通知一多，**还在屏幕上的**通知也会被删掉点击目标，点它就没反应；对账的判据是「通知是否真的还活着」。`MAX_TARGETS`（50）保留为 `getAll` 不可用时的兜底。

### 交互承接：任务列表 = 待办收件箱

上表里 ❌ 的三项（自定义按钮、富文本、`mouseover`）在源项目里承载了真实业务决定：toast 上「打开第三方链接 / 继续下载」两颗按钮、命中检查时附带文件名让用户判断、常驻直到用户处理。系统通知做不了这些，**这些交互不是消失了，而是迁到了 options 的任务列表**（源项目没有等价物，这是扩展端的结构补偿）。

为此任务列表的定位不是「进度表」，而是「待办收件箱」——它必须回答「这一行为什么在这里、轮到我做什么」，所以分成三层：

| 层       | 位置                    | 职责                                                                                     |
| -------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| 状态机   | `shared/task.ts`        | 只有 `queued/running/failed/complete/skipped/handed-off` 六个值，是全系统唯一事实源      |
| 视图模型 | `shared/taskView.ts`    | 纯函数：分组、主操作、次操作、排序、计数。**穷尽 switch + 判别联合**，加状态时编译期报错 |
| 渲染     | `options/tabs/TasksTab` | 只做 `switch (taskPrimaryActionOf(task).kind)`，不含任何业务判断                         |

规则表（`test/taskView.test.ts` 逐条钉住）：

| 状态         | 分组（`taskGroupOf`） | 主操作                             | 次操作   |
| ------------ | --------------------- | ---------------------------------- | -------- |
| `failed`     | `attention` 需要处理  | 有 `followUpUrl` → 打开来源页¹     | —        |
| `skipped`    | `attention` 需要处理  | 有 `followUpUrl` → 打开视频页      | 强制下载 |
| `running`    | `active` 进行中       | 重试（渲染时置灰）                 | —        |
| `queued`     | `active` 进行中       | 重试（渲染时置灰）                 | —        |
| `complete`   | `done` 已完成         | 重试                               | —        |
| `handed-off` | `done` 已交付         | 重试（外部下载器没接住时再交一次） | —        |

¹ 外部视频（`ExternalUrl`）失败时 `followUpUrl` 指向第三方页面，用户的下一步是「去那里看看为什么拿不到」。

排序主轴因此从「进行中优先」改为**「待办优先」**：`attention → active → done`，组内按 `updatedAt` 倒序。`attention` 非空时顶部出告警条并可一键筛到该分组（默认筛选仍是「全部」，不抢用户的选择权）。

`skipped` 的三条硬约束与 `FORCE_DOWNLOAD` 见 `docs/04-messaging.md`。

### 为什么会有「移不掉的任务」以及怎么修

`running` 不允许移除（下载器正在写文件，移出队列会让追踪器失去对账目标），这条规则本身是对的。
问题出在**有几类任务永远离不开 `running`**：

1. **交付型通道**（`others`）只把活交出去——开一个直链标签页——之后没有任何回传。
   旧实现照样记 `running`，于是任务永远「下载中」、永远不可移除。**旧默认下载方式就是 `Others`**，
   所以这个坑对绝大多数用户都会命中。现在投递成功即终态 `handed-off`（`channelTracksResult`）；
   浏览器真去下那个直链时会被接管回队列（见下面的通道矩阵）。
2. **进程重启留下的僵尸**：`status` 是持久化的，但「还在跑吗」只存在于内存里。SW 被回收 / 浏览器崩溃后，
   存储里仍是 `running`。`boot()` 现在会先做一次对账（`shared/taskReconcile.ts`）：
   `browser` 看 `downloads.search` 的真实状态，`aria2` 交给扫描（未配置则如实标失败），
   `iwaradl` 交给轮询（它有任务 API），`others` 按「有没有投递痕迹（`kindRef`）」区分。
   **拿不到证据就保持原样**，绝不把真在跑的任务标成失败。

`handed-off` 刻意**不**记成 `complete`：那会撒谎（文件可能根本没下成），
而且会被去重逻辑当成「已下载」而静默吞掉用户的重下意图。

### 「移除」= 先取消下载器，再删记录

`running` 的任务**可以移除**，但后台不会只抹记录：
`REMOVE_TASK` → `cancelTaskDownload`（`background/download/cancel.ts`）→ 确认停下来了 → 才 `removeTask`。

为什么必须先取消：只删记录会留下一个无人看管的下载——`browser` 通道再也不会回传终态，
而 `aria2` 里那个任务会在 5 分钟后被扫描当成「外部任务」重新收编（用户看到「删了又回来」）。

各通道能停掉什么（`shared/cancelStrategy.ts`，单测钉住）：

| 通道      | 停下它的方式                              | 备注                                          |
| --------- | ----------------------------------------- | --------------------------------------------- |
| `browser` | `downloads.cancel(id)`                    | 之后复核 `search` 确认真停了                  |
| `aria2`   | `aria2.remove` + `removeDownloadResult`   | 只 `remove` 会残留 stopped 记录，必须清结果   |
| `iwaradl` | `DELETE /api/tasks/{vid}`                 | **只能删 `pending`**，运行中返回 409          |
| `others`  | ❌ 只是打开了直链标签页，关不关是用户的事 | 只有被接管（`kind` 已改为 browser）后才能取消 |

能取消却没成功时**抛错并保留记录**：宁可不删，也不要留一个偷偷在下、界面上却消失了的任务。
「这个后端根本不能取消」（iwaradl 运行中 / others）则删除记录但如实告知「它可能仍在下载」——
情况不同，文案必须不同，否则用户会以为文件不会再来了。
UI 上第一次点击「移除」变成「确认取消？」——取消不可撤销，必须二次确认。

`silent`：信息级提示静音（对齐源 toast 无声），警告/失败保留系统提示音——这是**有意的平台差异**：源 toast 在页面上有视觉存在感，系统通知若静音，用户在看别的窗口时会彻底错过。

| 启动/安装事件 | `browser.runtime.onStartup/onInstalled` | `onStartup` 恢复追踪队列（原只能靠打开页面触发）；`onInstalled` `install` 打开 options「使用引导」页签（含 host 权限检测）、`update` 打开更新说明——替代被删除的首次运行引导浮层 |

## 页面内保留的（已论证的硬约束）

| 保留                                | 理由                                                                                                                 | 形态                                                                                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MAIN 世界 fetch 劫持改写 `/videos`  | Chrome 无等价扩展 API（webRequest 无 body、DNR 不改 body、CDP 代价不可接受）；Firefox 才有 `filterResponseData` 备选 | `world: "MAIN"` 声明式注入，[fetchInterceptor.ts] 逻辑原样迁移                                                                                                                                                                                                     |
| DOM 下载按钮/选择条（**无 toast**） | 页面内交互体验                                                                                                       | ISOLATED 世界 + 静态 CSS。**复杂度上限（设计红线）**：仅限按钮与选择条两类转发器控件；**一切反馈走 `browser.notifications`，一切进度/队列/历史/错误详情展示在扩展页**（options / side panel），`core/notify.ts`、`ui/toastify.ts`、`features/progress.ts` 均不迁移 |
| `document.cookie` 采集              | HttpOnly 之外的 cookie 在 ISOLATED 世界可读，转发给后台拼 aria2/iwaradl header                                       | 消息 `INGEST_*` 通道                                                                                                                                                                                                                                               |

### 页内卡片控件的原项目契约（已全部对齐）

| 原项目元素                                                          | 扩展实现                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input.selectButton[videoID]`                                       | 同名类 + 同名属性；38×38 右上、`accent-color: var(--primary)`（`src/content/css/videoCard.css`）                                                                               |
| `videoName` / `videoAlias` / `videoAuthor` / `videoUploadTime` 属性 | 前三项取自 DOM，`videoUploadTime` 取自后台视频库（`GET_CARD_META`；DOM 只有相对时间，不能伪造）                                                                                |
| `.follow` 角标（已关注作者）                                        | 后台 `db.getFollowByUsername()` 判定后下发                                                                                                                                     |
| `.downloaded` 角标（MediaCenter 已有）                              | 后台 `db.getIdmap()` 判定；仅在配置了 MediaCenter 时可能为 true                                                                                                                |
| 每卡片 `.deleteButton`（播放列表页、仅所有者）                      | 后台 `isPlaylistOwner()` 判定后下发；点击走 `REMOVE_PLAYLIST_ITEMS` 单条删除                                                                                                   |
| `p.fixed-bottom-right` 水印 + `isDebug` 标记 + 五连击开启调试       | 水印同构；`isDebug` 配置项已补，五连击写 storage 后 reload（与源项目同行为）                                                                                                   |
| `#pluginMenu > ul > li` / `#pluginOverlay > .main`                  | 菜单项顺序与水印、手动下载 overlay 结构同构；**导出配置 / 导入配置 / 打开设置有意不搬到页内**——低频运维与导航入口归 options「迁移」页签与工具栏弹窗，页内只留高频下载/选择动作 |

## 下载通道矩阵（四通道 × 两浏览器）

| 通道              | Chrome                                                                                  | Firefox                                                                                | 子目录             | 队列里的可追踪程度                                                             |
| ----------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `browser`（内建） | `downloads.download`，filename 支持子目录（禁 `..`，非法字符清洗沿用 analyzeLocalPath） | 同 API，**子目录同样支持**（Bugzilla 1280044 已于 FF 51 FIXED；FF 158 实测自动建目录） | ✅ 两宿主一致      | ✅ 全追踪：`downloads.onChanged` 完成/中断；可取消 `downloads.cancel`          |
| `aria2`           | 后台 fetch/WebSocket → `127.0.0.1:6800` JSON-RPC，`dir` 参数承担子目录                  | 同（主机由 `host_permissions: <all_urls>` 覆盖）                                       | ✅ 由 aria2 承担   | ✅ 全追踪：WS 通知 + 5 分钟扫描；可取消 `remove` + `removeDownloadResult`      |
| `iwaradl`         | 后台 fetch → `127.0.0.1:23456`，转发 cookie                                             | 同                                                                                     | ✅ 由 iwaradl 承担 | ✅ 状态追踪：轮询 `GET /api/tasks`（1 分钟、有活才开）；**取消仅限 `pending`** |
| `others`          | 后台标签页打开直链，交给浏览器/外部下载器                                               | 同                                                                                     | ❌                 | ⚠️ 交付即终态；浏览器真开始下时会被**接管**（`videoid` 匹配）后全追踪          |

### 「同时下载数」：浏览器通道的并发闸门

源项目没有这个设置，因为它把并发交给了环境：`GM_download` 由油猴转发，iwaradl/aria2 各有自己的并发控制。
扩展的 `browser` 通道不一样——`downloads.download()` **一返回，传输就在浏览器里继续跑**，
我们说什么它就同时下几个。批量投递只是每 3 秒发起一个、并不等上一个下完，
所以勾 20 个视频就是 20 条并发传输打向同一个 CDN。配置项 `browserConcurrentDownloads`（1~10，默认 3）补上这一层。

| 环节                             | 实现                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 判据（纯函数、可单测）           | `shared/browserConcurrency.ts`：`slotAvailable`（含「启动中」占位）、`nextQueuedBrowserTask`（FIFO，缺 `createdAt` 的排最后）、上限归一                     |
| 闸门位置                         | `download/dispatch.ts` 的 `executeChannels` **投递之前**——事后再挡已经晚了（浏览器早已开始传）                                                              |
| 槽满时的行为                     | 任务落 `queued`（UI 显示「排队中」+ `tasks.waitingSlot`），**不失败、不丢弃**，立即返回给调用方（批量可以继续）                                             |
| 队列推进                         | `download/browserQueue.ts` 的 `pumpBrowserQueue()`：`downloads.onChanged` 收到终态、移除任务、新任务排队、`boot()` 都推一次                                 |
| 为什么不是「等一个信号量再返回」 | 那会把消息处理器挂住：第 4 个就要等前 3 个下完（可能几十分钟），`BATCH_DOWNLOAD` 的响应、页面状态、汇总通知全部卡死，而 Chrome 对单事件还有 5 分钟上限      |
| 为什么真相在队列里               | 「还有几个在传」的唯一证据是 `kind === 'browser' && status === 'running'`（`onChanged` 会收敛终态）。内存计数会在 SW 回收后归零，那正是并发最容易失控的时刻 |
| 内存里放什么                     | 只有「已解析但还没启动」的视频快照（省一次解析）。SW 回收后丢失 → 泵**重新解析**后启动，任务不会丢                                                          |

`others` 被接管成 `browser` 之后同样占槽（此刻确实是浏览器在传）；aria2 / iwaradl 不受这个上限影响。

### 从后端读真实值：进度与容量

浏览器通道的并发由我们控制，两个守护进程却各自管自己的：aria2 有 `max-concurrent-downloads`，
iwaradl 只有 `GET /api/tasks`（没有配置类接口）。所以**只能读，不能替它们决定**。

| 读到什么                                              | 来源                               | 用在哪                                                   |
| ----------------------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `active` / `waiting` / `numStopped` / `downloadSpeed` | aria2 `getGlobalStat`              | RPC 页「后端容量」；`active` 与 `waiting` 的区分见下     |
| `max-concurrent-downloads`                            | aria2 `getGlobalOption`            | 同上（`undefined` 显示「未知」，不冒充默认值）           |
| 任务列表的 `progress`（0~1）                          | iwaradl `GET /api/tasks`           | 任务列表进度                                             |
| `completedLength / totalLength`                       | aria2 `tellActive` / `tellStopped` | 任务列表进度（与慢速重启判定同一个函数 `aria2Progress`） |

**两个由此修掉的「不诚实显示」**：

1. **aria2 的 `waiting` 曾被映射成 `running`**。它其实是「aria2 自己的并发上限满了，任务在它内部排队」，
   跟正在传完全不是一回事。后果是界面声称「N 条在下载」，而实际只有 `max-concurrent-downloads` 条在传；
   用户既看不出真实占用，也没法解释「我设的同时下载数为什么没生效」。
   现在 `waiting` / `paused` → `queued`（文案「排队中（aria2）」），`active` 才是 `running`。
2. **`queued` 的任务以前移除时不会通知后端**。以前 `queued` 只出现在「浏览器通道等我们自己的槽位」（那时确实没有东西可停），
   但 aria2 的 `waiting` 与 iwaradl 的 `pending` 现在也如实映射成 `queued`——它们已经**在后端排队**了。
   只删记录不取消，5 分钟后扫描会把 aria2 那条当外部任务重新收编（用户看到「删了又回来」）。
   判据用 `cancelStrategyOf`：能取消的才先取消，浏览器那种「等槽位、没有 kindRef」的直接删，
   不会误报「它可能仍在下载」。

**进度为什么不写浏览器通道**：`downloads.onChanged` 只给状态变化，拿不到字节数；为它轮询
`downloads.search` 会让 SW 常驻。`progress` 缺失时界面什么都不显示（**不用 0 冒充「刚开始」**）。

**进度写盘有阈值**（0.5%）：`patchTask` 会落盘 + 刷新 `updatedAt` + 推进任务列表排序，
5 分钟一次的对账不该为 0.1% 的差异制造一次写入。

### iwaradl 为什么从「交付型」升为「可追踪」

旧实现只看了 `POST /api/tasks` 就下了结论，而它其实有完整的任务 API
（[http-api.md](https://github.com/Izumiko/iwaradl/blob/master/http-api.md)）：

| 方法                      | 用途                       |
| ------------------------- | -------------------------- |
| `GET /api/tasks`          | 列出全部任务（一次拿全）   |
| `GET /api/tasks/{vid}`    | 取单个任务                 |
| `DELETE /api/tasks/{vid}` | 删除任务（**仅 pending**） |

主键是 **`vid`（视频 ID）**。顺带修掉一个真 bug：旧代码读 `body.id`，而 POST 返回的是**数组**，
于是永远取不到、退化成随机 uuid——那个 uuid 之后不可能与任何任务对上。

`DELETE` 对运行中的任务返回 **409**（它没提供取消接口）。这是第三方服务的能力边界，
所以「移除」在那种情况下报「记录已移除，后端可能仍在下载」，而不是假装取消成功。

### others 的接管

`others` 通道只是给浏览器开一个直链标签页；浏览器真去下这个地址时，`downloads` 里会出现一条记录，
其 URL 带我们注入的 `videoid`。命中「同视频且状态为 `handed-off`」的任务就把它**接管**过来：
绑上下载 id、`kind` 改为 `browser`（此刻确实是浏览器在下载）、状态转 `running`，
之后进度/完成/取消全部走 browser 通道那套。没被接管的任务保持原样，不会变成僵尸。

原 `DownloadType` 枚举保留，实现层换 API。**默认通道改为 `browser`**：它是唯一既有回传通道、又不依赖外部服务的选项；
源项目默认 `Others` 是油猴环境的产物（脚本没有 `downloads.download`，只能开直链），扩展沿用它就是主动放弃自己的优势。
`Others` 仍保留给「浏览器接管下载」的兼容场景。

## 下载主流程逐条对照源 `features/downloadFlow.ts`

对照口径：源 `analyzeDownloadTask` / `pushDownloadTask(Inner)` → 本项目
`download/batch.ts` → `download/dispatch.ts` → `download/downloaders.ts`。

### 顺序与门（已一致）

| 源行为                                                         | 本项目                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `analyzeDownloadTaskRunning` 进程内互斥 + `GMLock` 跨页互斥    | `batchDownloadRunning`（后台单实例 ⇒ 进程内互斥即跨页互斥）           |
| 批量去重后从 taskList 删掉命中项（页面勾选随之取消）           | `dedupeAgainstQueue` + `dedupeAgainstAria2`，`notifySelectionSettled` |
| 逐项 `delay(3000)`（`enableUnsafeMode` 关闭时）                | 同值；**最后一次不再空等**（源多等一轮）                              |
| `pushDownloadTask` 按视频 ID 防重入（`pushingVideoIds`）       | 同名集合，撞上时返回既有任务/占位而不抛错                             |
| `db.putVideo` → autoFollow → autoLike → 两道门 → 投递          | `persistAndSocialActions` → `hasDownloadLink` → 投递                  |
| autoFollow 判据 `(!库内following \|\| !video.Following)`       | 同判据（只 `followUser` 返回值决定是否提示）                          |
| `checkDownloadLink` 命中 → **不下载** + 提示                   | 落一条 `skipped` 待办 + 通知（承载在任务列表）                        |
| 视频详情页不检查（`getPageTypeProbe() === Video`）             | `pageType === 'video'` 不检查；**右键菜单现从 `pageUrl` 推页型**      |
| `checkPriority && DownloadQuality !== downloadPriority` → 不下 | 直接重解析（无交互位）；重解析仍不符 → 解析失败，绝不按错画质下       |
| `autoDownloadMetadata` 只对 Others / Browser                   | `task.kind === 'browser' \|\| 'others'`（用实际通道，不用配置值）     |
| 所有路径都 `taskList.delete(id)`（含 fail / 跳过）             | 逐项 `notifySelectionSettled`（含失败与跳过）                         |

### 对照中修掉的四处真实缺陷

| 缺陷                                                                       | 后果（用户可见）                                                                                                                                                               | 修法                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `FORCE_DOWNLOAD` 在 `protocol.ts` 声明、任务列表在发，**后台没有处理分支** | 点「跳过」行的「强制下载」→ 红字 `unknown message type: FORCE_DOWNLOAD`，跳过任务没有任何出路                                                                                  | 补 `case`（`skipLinkCheck: true`）+ 新增「协议 vs 路由」一致性单测守卫            |
| `findTask({ kindRef })` 不区分通道                                         | `others` 存 `String(tabId)`、`browser` 存 `String(downloadId)`，两者都从小整数递增 ⇒ **必然撞号**。撞上时浏览器的完成/中断事件会把一条已交付的 others 任务标成 complete/failed | 判据抽成 `shared/task.ts` 的 `taskMatchesRef`，所有按 `kindRef` 的查询都带 `kind` |
| 右键菜单调 `runDownload({ videoId })` 不带页型                             | 在**视频详情页**右键下载也被「简介有网盘链接」拦（源此时页型是 Video，门不生效）                                                                                               | 从 `info.pageUrl` 用 `pageTypeOf` 推页型                                          |
| aria2 的 WS 路径与 HTTP 路径序列化不一致（只有 HTTP 把 bool 转字符串）     | 同一份 `addUri` 参数在两条路径上形态不同；aria2 目前两者都接受，但这是**无法解释的偶发差异**温床                                                                               | 抽出 `serializeRpc`，WS 与 HTTP 共用                                              |

### 顺带加固的三处

- **快照复用加过期判据**：源对 `Type === 'full'` 也会重新拉 `/video/:id`；本项目为了省一次解析会复用页面带来的快照。现在加「`DownloadUrl` 的 `expires` 已过（含 60s 余量）就重解析」，避免拿几十分钟前的签名地址去下 403。
- **批量循环单条异常隔离**：某一条投递抛错（DB 写入失败、路径模板非法）不再中断整批——后面排队的视频同样有下载权利；该条记为 `failed` 并在汇总里如实计数。
- **外部视频失败通知的落点**：`failed` 且带 `followUpUrl`（只可能是 embedUrl 外部视频）时，点通知直接打开原始地址，而不是任务列表——那种任务重试一万次也不会成功，原始地址是唯一信息。

### 保持差异（有意，不改）

| 项目                             | 源                                                                                      | 本项目                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| aria2 去重时哪些状态算「已存在」 | 只认 `active` + `stopped.complete`（`error`/`removed` 排除）                            | 另外把 `waiting`/`paused` 也算已存在（更保守：不会因为用户暂停过就重复下一份）        |
| `others` 打开标签页的位置        | `GM_openInTab({active:false, insert:true, setParent:true})`（插在当前页后、关掉回父页） | `tabs.create({active:false})`（开在最右）。后台拿不到发起页 index，收益小于传参复杂度 |
| 元数据 JSON 通道                 | Browser 用 `GM_download`、Others 用 `<a download>` 点击                                 | 统一 `browser.downloads.download`（一个实现，两端一致）                               |
| 批量进度                         | 常驻 progress toast（`parsingProgress[i/n]` + 进度条）                                  | 逐项取消页内勾选（可见反馈）+ 结束一条汇总通知。系统通知做不了进度条                  |
| `partial` 快照入库               | `case 'partial'` fallthrough 时顺手写库（若库内非 full）                                | 不写：马上就会被 full 覆盖，且列表页本来就走 `INGEST_VIDEO_INFO`                      |

> 对照结论：**主流程的门、顺序、去重、节流语义都与源一致**；四处真实缺陷都是「协议/接口两端的契约没对齐」，属于扩展化引入的问题（源是单进程脚本，不存在这类跨上下文契约）。

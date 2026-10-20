# 06 里程碑与验收

> **状态（2026-10-18）**：M0–M6 的**代码侧全部落地**并通过双宿主回归；
> 剩下的只有商店提交类外部事项（正式商店物料、审核）——见文末「未完成事项」。

## M0 脚手架与双宿主装载（1 周）

- esbuild 多入口构建：`background.js`（IIFE）、`content/isolated.js`、`content/main-world.js`、`options/`、`popup/`
- options/popup 入口启用 `jsx: automatic`（React 19，见 01 文档 UI 技术栈分野）；content/background 保持纯 TS
- 双 manifest 派生脚本（base + chrome/firefox 差异），`npm run build:chrome` / `build:firefox`
- [globals.ts](../src/browser/globals.ts) shim 注入所有入口
- **验收**：两浏览器以"加载已解压/临时附加"装载，MAIN/ISOLATED 两个 content script 均在 iwara 页面执行（console 标记），background 各自以 SW（Chrome MV3）/持久后台页（Firefox MV2）启动

## M1 消息桥 + 采集入库（1–2 周）

- [protocol.ts](../src/messaging/protocol.ts) + hub（sendResponse 兼容模式）
- MAIN 劫持迁移（fetchInterceptor 逻辑原样），采集事件 → ISOLATED → 后台
- 后台 IndexedDB（`idb`）+ CONFIG 通道
- **验收**：打开 iwara 任意列表页，后台数据库逐步积累视频记录；刷新页面后与油猴版行为对拍一致（含点赞过滤/缓存回填改写）

## M2 下载三通道（2 周）

- 后台 downloaders：browser（子目录清洗，两宿主同构）、aria2（RPC + WebSocket 保活）、iwaradl
- cookie 转发、manifest 一次声明 `host_permissions: <all_urls>`（不做运行时逐端点申请）
- 页内按钮 → `DOWNLOAD` 消息贯通
- **验收**：三通道在 Chrome+Firefox 各完成一次端到端下载；`downloads.onChanged` 驱动 `notifications` 提示与侧栏队列状态刷新（页面内零 toast）

## M3 任务追踪替代 aria2Track（1 周）

- `alarms`（scan/retry/keepalive）+ 队列持久化 + onStartup 恢复
- 角标计数 + `notifications`
- **验收**：登录态多开 10 个 iwara 标签页，任务只在后台处理一次；关闭全部标签页后任务继续（由 alarms/events 续跑）；用 Chrome Devtools `worker.terminate()` / Firefox 后台挂起模拟崩溃后队列自愈

## M4 配置中心与迁移（1–2 周）

- options 页以 **React 19** 实现：configPanel 全部配置项（含占位符模板预览、i18n），表单校验接 zod + `shared/config-schema`；`useSyncExternalStore` 订阅 `storage.onChanged` 与 `DOWNLOAD_STATE` 推送
- **运行时多语言（i18next，与 MediaCenter 同栈）**：`src/shared/locales/{zh,en,ja}.json` 三套字典 + `src/shared/i18n.ts`（`initAsync:false` 同步初始化 / `{name}` 插值 / `getUILanguage()` 映射 / `watchLanguage()` 订阅 `config.language`）；**无中间层**——React 组件用 `useTranslation()`（`I18nextProvider` 注入实例，`react-i18next` 因此只进 React 包），非组件模块用 `i18n.t()`，键名/返回类型由 `src/shared/i18next.d.ts` 的 `CustomTypeOptions` 提供；options、popup、页内菜单、右键菜单、系统通知共用同一实例；语言选择器在「高级 → 扩展行为 → 界面语言」
- 内置「使用引导」页签（替代已删除的首次运行浮层）：安装引导 + 站点访问权限诊断（`permissions.contains({origins:['<all_urls>']})`，撤销后指回扩展管理页；**不再提供授权按钮**，因为 required 权限无法 `request`）+ 钓鱼防护说明 + 按版本分组的更新日志；`onInstalled` 按 `install`/`update` 分别打开
- 油猴数据迁移向导（两条通道）：
    1. **页面数据库直读**（首选，无需手工导出）：旧库 `IwaraDownloadTool` 在 iwara.tv origin，content script 首次进页探测并报计数；迁移页点「导入」时后台转发读取、分页读+按体积/条数分批回传、切小事务逐条校验入库（一节写失败就二分到单条，不让一条脏记录废掉整批）。**只含库存四表**（视频库/关注/好友/ID 映射），且导入必须显式触发（自动导入会复活用户已删数据）
    2. **粘贴 / 文件导入**：旧脚本菜单「导出配置」把**裸配置 JSON 复制到剪贴板**（源项目没有导出文件的功能）→ 迁移页文本框粘贴即可；也支持本扩展导出的完整迁移包文件。旧脚本的**配置**在 GM 私有存储里，页面数据库读不到，只能走这条路
- Side panel / sidebar_action 队列面板（React 同栈；可选延后）
- **验收**：迁移页检测到旧库条数 → 一键导入后扩展库与旧库四表一致；配置经粘贴/文件导入后一致；旧脚本此后不再必要

## M5 Firefox 专项（1 周）

- 事件页挂起行为长跑验证（对齐挂起协议四条纪律）
- （可选增强）`webRequest.filterResponseData` 后台拦截通道，替代 Firefox 上的 MAIN 劫持读路径
- X-ray 复核：所有跨世界数据确走 JSON 通道
- **验收**：AMO 上传 lint(`web-ext lint`) 零 error；Firefox 端三通道全通过

## M6 发布

- Chrome Web Store：隐私声明（`<all_urls>` 的两处用途：用户自填 RPC 端点 + 任意站点仿冒域名判定；iwara 专属脚本仍只匹配 `*://*.iwara.tv/*`）
- AMO：签名自更新的 gecko id + update_url；或走 AMO 审核
- 保留油猴脚本并行一个发布周期作为迁移期
- **验收**：两商店过审；README 迁移指南

## 测试策略

| 层           | 手段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元         | `npm run test:unit`（node:test + tsx，零框架依赖）：路径清洗与归一化（含 Unix 根前缀回归）、模板变量替换、配置 schema 默认值/脏数据、页面路由识别、协议常量与 RAW→partial 映射、旧库分批预算、迁移载荷形态识别、关注作者状态闸门、i18n 三语键一致性/插值/语言识别。**为什么要存在**：这些是纯函数，故障面最广，而 e2e 只能在真实浏览器里跑、覆盖不到边界                                                                                                                                                                                                                                                                                                              |
| e2e          | Playwright Chromium：`--load-extension` 真实装载，跑通采集→下载主链路（原 e2e 的 uiBehavior/smoke 思路可复用）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 跨浏览器 e2e | WebdriverIO + WebDriver BiDi：同一份 21 用例 spec 在 Chrome + Firefox 各跑一遍（含 Playwright 全部验收点 + 好友审批/高级页/导出/队列操作）；后台活性用两端一致的 `runtime.getContexts()` + `alarms.getAll()`；Chrome 走 `webExtension.install`（136+ 专用 flags），Firefox 走 geckodriver `--allow-system-access` + 固定 UUID 导航 `moz-extension://`                                                                                                                                                                                                                                                                                                                 |
| Firefox 冒烟 | `npm run test:firefox:smoke`（`web-ext run`）覆盖装载/boot/事件链                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 真实站点冒烟 | WebdriverIO live 套件（`e2e/wdio/live/site.spec.ts`，`E2E_LIVE=1` 显式开启，不进 CI，**13 用例 × 2 宿主**）：真站点验「宿主 DOM 还能被注入 + MAIN 世界握手 + 页内 UI 对油猴版契约」——注入时机标记（`data-ia-hook` / `data-ia-early` 证明早于页面脚本）、**页面全局不得出现任何 `__iwara*`/`__ia*` 控制入口**（安全回归红线）、`.selectButton`（38×38 右上/`videoID`/`accent-color:var(--primary)`）、`#pluginMenu>ul>li`（右侧中部滑出/`--body-dark`）、水印（`.fixed-bottom-right` + 版本 + 已选中数）、hover 展开接线、菜单项顺序、选择态闭环、overlay 开合、SPA 重建；单会话单标签、反指纹参数、CF 挑战即 skip、`E2E_HUMAN=1` 人工过盾；零副作用（不点下载类动作） |
| 对拍         | 保留旧油猴脚本，同一账号页面行 diff（列表过滤、缓存）；真实站点冒烟已能自动拓出注入失效类回归（已拓出复选框注入死锁、SPA pushState 不重建、高 DPI 指针坐标失效、Chrome 遮挡降级暂停过渡、**Unix 绝对路径丢失根前缀**五个真问题）                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CI           | `.github/workflows/ci.yml`：类型检查（扩展 + Playwright e2e + WDIO 三套）、单元测试、双目标构建、`web-ext lint`、Chromium e2e、zip 产物上传。**不进 CI 的**：真实站点冒烟（需要登录态与人工过盾）                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 风险清单

| 风险                                          | 缓解                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome SW 频繁挂起打崩长队列                  | 挂起协议（01 文档）+ M3 验收里的 terminate/自愈用例                                                                                                                                                                                                                                                                                                                       |
| ~~Firefox 子目录限制伤害体验~~                | **风险已消除**：Bugzilla 1280044 于 FF 51 FIXED，FF 158 实测自动建目录 → `toDownloadFilename` 不再有 flatten 分支（见 02 矩阵）                                                                                                                                                                                                                                           |
| 商店审核：optional `https://*/*` 池可能被质疑 | 说明仅为自定义 RPC 端点；可降级为仅 `http://localhost/*`、`http://127.0.0.1/*` 静态 + 提示用户迁移端点到本地反代                                                                                                                                                                                                                                                          |
| iwara 改版致 fetch 路径失效                   | 与油猴版同一层隔离（fetchInterceptor 单文件），热修发版两平台；`E2E_LIVE=1` 真实站点冒烟覆盖注入点（菜单/卡片选择器/握手标记）                                                                                                                                                                                                                                            |
| 世界注入竞态（MAIN 先于 ISOLATED 但页面更先） | `run_at: document_start` + HELLO 门闩协商（04 文档）                                                                                                                                                                                                                                                                                                                      |
| MAIN world 必须与页面同雷亚，钩子可见可绕过   | 接受为固有边界（01 §注入时机与安全）：不向页面暴露任何全局/控制入口、业务判定全在后台、无 WAR；真实站点用例反向断言无 `__iwara*` 全局。**教训**：早期为「更早注入」拆出的 `early-hook.js` 暴露了 `install()` 接管点（可被页面替换 handler → MITM 全站请求）且 `queue` 缓存了含 `Authorization` 的 `init`，已整体删除——`document_start` 本身已是平台下限，额外拆段收益为零 |
| 页面可读 `localStorage` 中的 refresh token    | 继承油猴版跨页共享会话的实现；已在 README/PRIVACY 显式披露，用户可不开登录相关功能                                                                                                                                                                                                                                                                                        |
| Chrome 剪贴板需 offscreen 文档                | `autoCopySaveFileName` 只在「检测到网盘链接」时触发；offscreen 用完即 `closeDocument()`，不留常驻文档（否则会把 SW 钉住，违反挂起协议）。唯一例外是用户开启「保持后台活跃」：那时文档由 `keepAlive.ts` 持有，关开关即关闭。Firefox 是 MV2 持久后台页，直接走 Async Clipboard                                                                                              |

## 未完成事项（代码之外）

| 事项                  | 状态      | 说明                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正式图标              | ✅ 已生成 | `assets/icons/logo.svg` 是唯一几何源；`npm run build` 自动栅格化成 16/48/128 PNG（Chrome 不支持 manifest 用 SVG）                                                                                                                                                                                                                                                     |
| 商店宣传图 440×280    | ⬜ 待设计 | 需图像设计工具，非代码可解（`docs/store-listing.md` 第四节）                                                                                                                                                                                                                                                                                                          |
| Chrome Web Store 提交 | ⬜ 待提交 | 需账号与人工审核；隐私说明（`PRIVACY.md`）与权限理由已就绪                                                                                                                                                                                                                                                                                                            |
| AMO 提交              | ⬜ 待提交 | `web-ext lint` errors 0 / notices 0，可直接上传                                                                                                                                                                                                                                                                                                                       |
| options 运行时多语言  | ✅ 已实现 | i18next（`react-i18next` 仅 React 包，实例经 `I18nextProvider` 注入）+ 字典 `src/shared/locales/{zh,en,ja}.json` + `src/shared/i18n.ts`（同步初始化 / `{name}` 插值 / 浏览器语言映射 / 三语键一致性单测）；无自研 `t()` 包装层，键名由 `CustomTypeOptions` 编译期校验；四个上下文共用同一实例；`config.language` 默认 `auto`（跟随浏览器），`_locales` 只留 `extName` |

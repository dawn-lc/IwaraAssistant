# IwaraAssistant

[English](README.en.md) ｜ [日本語](README.ja.md)

[![CI](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml/badge.svg)](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Firefox AMO](https://img.shields.io/amo/v/iwara-assistant?label=AMO&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/iwara-assistant/)
[![AMO 用户](https://img.shields.io/amo/users/iwara-assistant?label=users)](https://addons.mozilla.org/firefox/addon/iwara-assistant/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-5FA04E?logo=nodedotjs&logoColor=white)](package.json)

iwara.tv 的浏览器扩展。把视频批量下载、选择与管理搬到一个真正好用的界面里：页面上只留高频的「勾选 / 下载」动作，配置、任务队列、进度与迁移全部在扩展自己的页面完成。

- **Chrome（MV3）与 Firefox（MV2）共用同一份代码**，行为一致。
- 四种下载通道：浏览器内建下载、aria2、iwaradl、打开直链交给外部下载器。
- 系统通知是唯一的结果反馈通道，点一下就能跳到该去的地方。
- 不收集、不向开发者回传任何数据。

> [!IMPORTANT]
> **Firefox 已上架 [AMO](https://addons.mozilla.org/firefox/addon/iwara-assistant/)**（自动更新）。**Chrome 应用商店已拒绝**（内容政策判定，属禁止项，改代码解决不了），Chromium 系请手动加载——功能与商店安装完全一致，原因见[下文](#为什么不在商店里)。

> **用法查 [Wiki](https://github.com/dawn-lc/IwaraAssistant/wiki)，实现查 [docs/](docs/)。** 本文件只讲定位与安装。

## 功能

| 领域 | 能力                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 下载 | 四种通道；路径模板与实时预览；链接预检；批量去重；浏览器通道并发上限；失败重试；元数据 JSON                   |
| 页面 | 卡片复选框与跨标签页选区；全选 / 反选 / 取消；悬浮菜单；手动输入 ID；美化与宽屏；右下角水印；SPA 切页自动重扫 |
| 任务 | 队列分组（需要处理 / 进行中 / 已完成）；进度；重试；移除（先取消下载器）；清空已结束；启动对账；工具栏角标    |
| 配置 | 九个页签；即时保存；界面语言 `auto` / 中文 / English / 日本語；配置校验与默认值                               |
| 迁移 | 自动只读检测旧版油猴脚本的页面数据库，显式一键导入；配置支持粘贴裸 JSON 或导入完整迁移包                      |
| 通知 | 仅在后台发生的事件（入队、完成、失败、发现网盘链接）走系统通知，点击跳到对应位置                              |
| 安全 | 钓鱼仿冒站点防护：全屏警告 + 网络层封锁，用户明确「继续访问」后才放行                                         |
| 社交 | 自动关注 / 自动点赞；好友请求批量审批（9 类条件、any / all 模式、实时进度）                                   |
| 同步 | 全量投稿分页遍历入库（可暂停 / 继续 / 断点续跑）；订阅流同步；MediaCenter 推送与反向补齐                      |

## 安装

| 浏览器                                        | 安装方式                                                                  | 备注                         |
| --------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| **Firefox 128+**                              | [AMO 商店安装](https://addons.mozilla.org/firefox/addon/iwara-assistant/) | 审核通过，自动更新           |
| Chrome / Edge / Brave / Vivaldi / Opera / Arc | 手动加载（[教程](docs/07-install-chromium.md)）                           | 商店已拒，功能与商店安装一致 |

### Firefox（推荐）

在 [AMO 产品页](https://addons.mozilla.org/firefox/addon/iwara-assistant/) 点「添加到 Firefox」即完成安装。上架版本以产品页显示的版本号为准（徽章同源）；每次发版都要过审，商店通常比仓库最新提交晚一两天。

上架包是 **MV2**，所以局域网里的 aria2 直接用 `http://192.168.x.x:6800/jsonrpc` 就行，不受 MV3 本地网络限制。要立刻用主干代码就本地构建后临时载入：`npm install && npm run build` → `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选 `dist/firefox/manifest.json`（Firefox 退出后失效）。

### Chromium 系（Chrome / Edge / Brave / Vivaldi / Opera）

**方式一：源码构建**（需 Node ≥ 20.11）—— `git clone` 本仓库后 `npm install && npm run build:chrome`，产物在 `dist/chrome`。
**方式二：下载 CI 产物** —— 到 [Actions](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml) 选最新一次绿色运行 → Artifacts → `extension-zips` → 解压出 `chrome.zip`。

拿到目录后：打开 `chrome://extensions`（Edge 是 `edge://extensions`）→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选**直接含 `manifest.json`** 的目录 → 刷新已打开的 iwara 页面。完整步骤（含更新、回滚、数据保留与故障排查）见 [docs/07-install-chromium.md](docs/07-install-chromium.md)。

> 只从本仓库源码或本仓库 Actions 取产物。第三方转发的 zip / crx 无法与源码对照，不要用。

### 为什么不在商店里

2026-10-30 提交的版本被 **Chrome 应用商店拒绝**：违规类型「内容政策」，参考 ID `Grey Lithium`（色情内容），依据是「我们不允许发布任何……会将用户定向到此类内容的产品」，改版要求是「取消发布」而不是「改完再交」。

扩展本身不含也不展示成人内容：代码里没有露骨素材，图标是自绘 SVG，全部 JS 打包在包内，不代理也不绕过站点限制。被拒的实际原因是**服务对象**——它只对 iwara.tv 生效，而该站点是成人站点，这属于 Chrome 的禁止项而非可整改项，因此不再重投。不接受为了过审把扩展改成「通用下载器」或抹掉站点名：那会同时踩上欺骗行为与关键字堆砌条款，而站点性质不会因此改变。同一份代码在 AMO 已通过审核。完整记录见 [docs/store-listing.md](docs/store-listing.md)。

## 文档

| 入口                                                       | 内容                                                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Wiki**](https://github.com/dawn-lc/IwaraAssistant/wiki) | 面向使用者：安装与首次配置、下载通道与端点、路径可用变量、批量投递、任务队列与自动恢复、私有与不公开视频、旧库迁移、同步与 MediaCenter、调试与数据导出、常见问题 |
| [docs/10-troubleshooting.md](docs/10-troubleshooting.md)   | 故障排查：装了没反应、解析失败、aria2 连不上、任务卡住、速度慢、抓日志与导出                                                                                     |
| [docs/05-features.md](docs/05-features.md)                 | 功能与行为边界的权威清单（含「有意不做」的取舍）                                                                                                                 |
| [docs/](docs/)                                             | 技术实现：架构、跨浏览器差异、manifest、消息协议、测试与发布、aria2 流程、调试通道、AMO 上架素材                                                                 |

## 开发

```bash
npm install          # Node >= 20.11
npm run build        # 双目标编译 + 打包 → dist/chrome、dist/firefox 与对应 .zip
npm run dev:chrome   # watch 模式
npm run test:unit    # 单元测试；另有 test:e2e（Playwright）与 test:e2e:wdio（Chrome + Firefox）
```

**参与贡献**先读 [CONTRIBUTING.md](CONTRIBUTING.md)（环境、门禁、提交约定、PR 流程）；**动手改代码前必须读 [AGENTS.md](AGENTS.md)**——门禁清单、架构铁律、目录归位与一批「平台事实」，背后的实测记录在 [docs/agent-notes.md](docs/agent-notes.md)。安全漏洞请走 [SECURITY.md](SECURITY.md) 的私密渠道，不要开公开 issue。

## 依赖与许可

本项目以 [Apache-2.0](LICENSE) 开源。第三方依赖（运行时代码全部打包进扩展，不加载任何远程代码）：

| 依赖                                                          | 用途                      | 许可证 |
| ------------------------------------------------------------- | ------------------------- | ------ |
| [zod](https://github.com/colinhacks/zod)                      | 配置 schema 与脏数据回落  | MIT    |
| [idb](https://github.com/jakearchibald/idb)                   | IndexedDB 的 Promise 封装 | ISC    |
| [React](https://github.com/facebook/react) / react-dom        | 扩展页面 UI               | MIT    |
| [i18next](https://github.com/i18next/i18next) / react-i18next | 三语界面与文案校验        | MIT    |
| [sonner](https://github.com/emilkowalski/sonner)              | 页内轻提示                | MIT    |
| [dayjs](https://github.com/iamkun/dayjs)                      | 路径模板的时间格式化      | MIT    |

开发与构建工具链：TypeScript（Apache-2.0）、esbuild（MIT）、tsx（MIT）、Prettier（MIT）、Playwright（Apache-2.0）、WebdriverIO（MIT）、web-ext（MPL-2.0）、resvg（MPL-2.0）。图标是仓库内自绘 SVG 在构建期渲染的，不引用第三方素材。

## 同类项目与致谢

- [IwaraDownloadTool](https://github.com/IwaraEnhance/IwaraDownloadTool)（Apache-2.0）：本项目的功能面与一批边界行为参考了这个油猴脚本，迁移页正是为它的老用户准备。
- [iwaradl](https://github.com/Izumiko/iwaradl)（MIT）：CLI 下载器，本项目把它当作一个下载后端。
- [MediaCenter](https://github.com/dawn-lc/MediaCenter)：本地媒体库，实验性元数据推送目标。
- [aria2](https://github.com/aria2/aria2) 与 [Motrix-Next](https://github.com/AnInsomniacy/motrix-next)：推荐自建的下载器与图形界面。

感谢每一位提交 issue、提供实测日志与帮忙验证修复的人——大部分「平台事实」都是从这些反馈里纠正过来的。

## 与 Iwara 的关系与免责声明

- 本项目是独立开发的第三方工具，与 Iwara 官方**没有任何合作、授权或隶属关系**。
- 只通过站点本身公开提供的页面与 API 交互：不绕过访问控制，不破解任何付费或私有内容，不代理、不转发视频。
- 请自行确认下载行为符合所在地法律法规与 Iwara 的服务条款；开发者与贡献者不对使用后果承担责任，包括但不限于账号受限。
- 如果你喜欢站上的内容，请优先支持创作者：开通 [Iwara 高级会员](https://www.iwara.tv/page/premium) 或直接对作者打赏。
- 本项目以 [Apache-2.0](LICENSE) 开源，代码与文档按「现状」提供，不附带任何明示或默示担保。

## 隐私与许可

扩展不收集、不向开发者回传任何数据；权限的两处用途见 [Wiki 的权限说明](https://github.com/dawn-lc/IwaraAssistant/wiki/安装与首次配置#权限说明为什么需要全站访问)。隐私政策见 [PRIVACY.md](PRIVACY.md)，许可证为 [Apache-2.0](LICENSE)。

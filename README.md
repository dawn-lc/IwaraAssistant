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

> 技术实现（架构、跨浏览器差异、manifest、消息协议、测试与发布）在 [docs/](docs/) 目录，本文只讲怎么用。

> [!IMPORTANT]
> **Firefox：已上架 AMO**，[点此安装](https://addons.mozilla.org/firefox/addon/iwara-assistant/)（自动更新）。
> **Chrome 应用商店：已拒绝上架**（2026-10-30，参考 ID `Grey Lithium`：内容政策 / 色情内容）。这是产品定位层面的禁止项，无法通过修改代码整改——Chromium 系浏览器请按 [Chromium 系手动安装指南](docs/07-install-chromium.md) 手动加载，功能与商店安装完全一致。原因与取舍见 [下文](#为什么不在商店里)。

## 功能一览

| 领域 | 能力                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 下载 | 四种通道；路径模板与实时预览；链接预检；批量去重；浏览器通道并发上限；失败重试；元数据 JSON                   |
| 页面 | 卡片复选框与跨标签页选区；全选 / 反选 / 取消；悬浮菜单；手动输入 ID；美化与宽屏；右下角水印；SPA 切页自动重扫 |
| 任务 | 队列分组（需要处理 / 进行中 / 已完成）；进度；重试；移除（先取消下载器）；清空已结束；启动对账；工具栏角标    |
| 配置 | 九个页签；即时保存；界面语言 `auto` / 中文 / English / 日本語；配置校验与默认值                               |
| 迁移 | 自动只读检测旧版油猴脚本的页面数据库，显式一键导入；配置支持粘贴裸 JSON 或导入完整迁移包                      |
| 通知 | 仅在后台发生的事件（入队、完成、失败、发现网盘链接）走系统通知，点击跳到对应的视频页或任务页                  |
| 安全 | 钓鱼仿冒站点防护：全屏警告 + 网络层封锁，用户明确「继续访问」后才放行                                         |
| 社交 | 自动关注 / 自动点赞；好友请求批量审批（9 类条件、any / all 模式、实时进度）                                   |
| 同步 | 全量投稿分页遍历入库；订阅流同步；MediaCenter 推送                                                            |

功能细节与行为边界见 [docs/05-features.md](docs/05-features.md)。

## 安装

| 浏览器                                        | 安装方式                                                                  | 备注                         |
| --------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| **Firefox 128+**                              | [AMO 商店安装](https://addons.mozilla.org/firefox/addon/iwara-assistant/) | 审核通过，自动更新           |
| Chrome / Edge / Brave / Vivaldi / Opera / Arc | 手动加载（[教程](docs/07-install-chromium.md)）                           | 商店已拒，功能与商店安装一致 |

### Firefox（推荐）

在 [AMO 产品页](https://addons.mozilla.org/firefox/addon/iwara-assistant/) 点「添加到 Firefox」，确认权限即完成安装，后续随版本自动更新。

- 上架版本以 [AMO 产品页](https://addons.mozilla.org/firefox/addon/iwara-assistant/) 显示的版本号为准（徽章同源）。每次发版都要过 AMO 审核，商店版本通常比仓库最新提交晚一两天；要立刻用主干代码就走下面的临时载入。
- 最低 **Firefox 128**（`strict_min_version`），低于此版本 AMO 会拦下。
- 上架包是 **MV2**，所以局域网里的 aria2 直接用 `http://192.168.x.x:6800/jsonrpc` 就行，不受 MV3 本地网络限制。

临时载入仓库最新代码：

```bash
npm install    # Node >= 20.11
npm run build  # → dist/chrome、dist/firefox 与对应的 .zip
```

打开 `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选 `dist/firefox/manifest.json`。临时载入的扩展会在 Firefox 退出后失效，重开需重新载入。

### Chromium 系（Chrome / Edge / Brave / Vivaldi / Opera）

功能上与商店安装完全一致，只是需要手动加载一次。完整步骤（含更新、回滚、数据保留、故障排查）见 **[docs/07-install-chromium.md](docs/07-install-chromium.md)**，最短路径：

**方式一：源码构建**（需 Node ≥ 20.11）

```bash
git clone https://github.com/dawn-lc/IwaraAssistant.git
cd IwaraAssistant
npm install
npm run build:chrome   # → dist/chrome
```

**方式二：下载 CI 产物**（无需 Node，但需 GitHub 登录，产物保留 14 天）

到 [Actions](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml) 选最新一次绿色运行 → 页面底部 Artifacts → 下载 `extension-zips` → 解压出 `chrome.zip` 再解压。

拿到目录后：打开 `chrome://extensions`（Edge 是 `edge://extensions`）→ 打开「开发者模式」→「加载已解压的扩展程序」→ 选**直接含 `manifest.json`** 的那个目录。然后刷新已打开的 iwara 页面。

> 只从本仓库源码或本仓库 Actions 取产物。第三方转发的 zip / crx 无法与源码对照，不要用。

### 为什么不在商店里

2026-10-30 提交的 0.1.31 被 **Chrome 应用商店拒绝**：违规类型「内容政策」，参考 ID `Grey Lithium`（色情内容），纠正要求是「移除所有与色情相关的内容/代码」，依据「我们不允许发布任何……会将用户定向到此类内容的产品」。官方 troubleshooting 页面对应那一条写得更直白——**该扩展程序的主要目的是改进提供露骨色情内容的网站**。

扩展本身不含也不展示成人内容：代码里没有露骨素材，图标是自绘 SVG，全部 JS 打包在包内，不代理也不绕过站点的访问限制。被拒的实际原因是**服务对象**——它只对 iwara.tv 生效，而该站点是成人站点。这属于 Chrome 的禁止项而非可整改项（政策原文要求「取消发布」而不是「改完再交」），且「成人内容」开关在送审时已勾选仍照此判定，因此不再向 Chrome 应用商店提交。

不接受为了过审把扩展改成「通用下载器」或抹掉站点名——那会同时踩上欺骗行为、关键字堆砌、最低功能等条款，而站点性质不会因此改变。同样一份代码在 AMO 已通过审核：[Mozilla 的内容政策](https://extensionworkshop.com/documentation/publish/add-on-policies/)只要求不违反商标、AUP 与美国法律，没有 Chrome 那种针对「服务对象」的禁止条款。

`npm install` 会顺带启用仓库自带的 git 钩子（提交时自动格式化、校验提交消息、推送前跑本地门禁）；只安装不开发的话可以忽略，或执行 `git config --unset core.hooksPath` 关掉。

### 权限说明

扩展声明了全站访问权限（`<all_urls>`），只有两处用途：

1. 下载通道的端点地址由用户自行填写（aria2 / iwaradl / MediaCenter），无法预先把域名写进清单；
2. 钓鱼仿冒站点防护需要读取任意站点的**主机名**才能判断。

除这两点外，扩展只在 `iwara.tv` 上工作。详细理由见 [docs/03-manifest.md](docs/03-manifest.md#全站-host-权限一次声明两处用途)。

## 使用说明

### 下载单个视频

三个入口，任选其一：

| 入口         | 位置                                                     |
| ------------ | -------------------------------------------------------- |
| 页内悬浮菜单 | 视频详情页右侧边缘滑出菜单 →「下载当前视频」             |
| 右键菜单     | 视频链接或视频页上右键 →「Iwara Assistant → 下载此视频」 |
| 手动输入     | 悬浮菜单 →「手动下载」，粘贴视频 ID（多个用 `\|` 分隔）  |

视频 ID 是地址栏 `/video/<ID>` 里那一段。例如 `https://www.iwara.tv/video/AeGUIRO2D5vQ6F` 的 ID 是 `AeGUIRO2D5vQ6F`。

### 批量下载

1. 视频列表页上，悬浮菜单 →「开关选择框」（或按 `Space`）让卡片出现复选框。
2. 勾选要下载的卡片。菜单同时提供「本页全部选中」「本页反向选中」「取消本页选中」「取消所有选中」。
3. 悬浮菜单 →「下载所选」。

几点说明：

- **选区跨标签页共享**：在 A 标签页勾的，切到 B 标签页仍然算数。
- 已经下载过或正在下载的视频会被跳过，不会在下载器里堆出重复任务。
- 每个视频一旦有了结论（入队、失败、跳过）就会自动取消勾选，不用手动清空。
- 批量投递之间有 3 秒间隔，避免触发站点限流。

### 任务队列

点工具栏图标 →「任务队列」（或在扩展选项里选「任务」页签）。列表分三组，**待办永远排在最上面**：

| 分组     | 含义                  | 每行做什么                                         |
| -------- | --------------------- | -------------------------------------------------- |
| 需要处理 | 失败 / 检测到网盘链接 | 「重试」或「打开视频页」（打开后这条待办自动移除） |
| 进行中   | 排队 / 下载中         | 看进度；下载中可以「移除」，会先取消下载再删记录   |
| 已完成   | 完成 / 已交付         | 历史记录，可清空                                   |

顶部的「刷新状态」会立刻和 aria2 / iwaradl 对账，不必等定时扫描。

### 关键配置

扩展选项 →「下载」页签：

| 配置               | 默认                                      | 说明                                                              |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------- |
| 下载方式           | 浏览器内建下载                            | 另有 aria2 / iwaradl（需先配端点）/ 打开直链（交付后不再追踪）    |
| 同时下载数         | 3                                         | 只作用于浏览器通道；aria2 / iwaradl 的并发由它们自己控制          |
| 保存路径模板       | `/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4` | 变量见[路径与文件名](#路径与文件名)，输入框下方有实时预览         |
| 第三方网盘链接检查 | 关                                        | 开启后简介/评论里出现网盘链接就**不下载**，留一条待办等你自己决定 |
| 自动复制保存文件名 | 关                                        | 检测到网盘链接时，把文件名写进剪贴板                              |

其余页签：RPC（端点与环境自检）、过滤（列表改写）、清洗（文件名规则）、好友、迁移、高级（实验功能、界面语言、后台保活）、引导。

完整清单见 [docs/05-features.md](docs/05-features.md#配置与多语言)。

### 路径与文件名

路径模板在「下载」页签配置，支持以下变量（大小写敏感，`%#` 与 `#%` 之间是变量名）：

| 变量             | 含义                 | 示例输出                              |
| ---------------- | -------------------- | ------------------------------------- |
| `%#AUTHOR#%`     | 作者用户名           | `Mr.Quin`                             |
| `%#ALIAS#%`      | 作者昵称（可能为空） | `摸鱼奎恩`                            |
| `%#TITLE#%`      | 视频标题             | `【Quin】黑暗之魂3 一周目攻略 Part22` |
| `%#ID#%`         | 视频 ID              | `MrQuinWo22Ne22`                      |
| `%#QUALITY#%`    | 实际下载的画质       | `Source` / `540` / `360`              |
| `%#UploadTime#%` | 视频发布时间         | `2022-02-22`                          |
| `%#NowTime#%`    | 投递时刻的当前时间   | `2022-02-22`                          |

`%#UploadTime#%` 与 `%#NowTime#%` 可以带 [dayjs](https://day.js.org/docs/en/display/format) 格式串，每次出现的格式独立解析：`%#NowTime:YYYY-MM-DD_HH.mm.ss#%` → `2022-02-22_22.22.22`；不带格式时固定是 `YYYY-MM-DD`（不是原始时间戳）。

完整示例（Windows 盘符、Unix 绝对路径、相对路径都支持；UNC 路径 `\\server\share` 与 `..` 越界会被拒绝并提示）：

```text
D:/Iwara/%#AUTHOR#%/(%#ALIAS#%)%#UploadTime:YYYY-MM-DD#%_%#TITLE#%_%#QUALITY#%[%#ID#%].mp4
```

渲染结果：

```text
D:\Iwara\Mr.Quin\(摸鱼奎恩)2022-02-22_【Quin】黑暗之魂3 一周目攻略 Part22_Source[MrQuinWo22Ne22].mp4
```

「清洗」页签控制文件名规范化链路：NFKC 归一 → Emoji 替换 → 组合符号折叠 → Windows 非法字符替换 → 长度截断（标题默认 72、昵称默认 64）。这些规则只作用于 `%#TITLE#%` 与 `%#ALIAS#%`，其余变量原样展开。

各通道对路径的用法不同：**aria2 / iwaradl** 收到完整的目录 + 文件名（会按模板建目录）；**浏览器内建下载**只接受相对于浏览器下载目录的文件名，所以盘符与根会被去掉、子目录仍然保留（两个宿主都自动建目录）；**打开直链**只把文件名作为提示交给外部下载器。

### 通知

页面内不弹 toast、不显示进度条——所有状态反馈走系统通知。点通知会跳到对应位置：

- 任务相关 → 任务队列；
- 发现网盘链接 / 外部视频失败 → 该视频页（或外部原始地址）。

失败与「需要处理」的通知会常驻，直到你点掉或在任务队列里处理完。

### 从旧版油猴脚本迁移

在扩展选项 →「迁移」页签：

1. **自动检测**：打开任意 iwara 页面后，扩展只读探测旧脚本留在页面里的数据库并显示条数。
2. **显式导入**：回到迁移页点导入。导入期间要保持那个 iwara 标签页打开（只有页面本身能读到那份数据）。
3. **配置只能粘贴**：旧脚本的配置存在油猴管理器的私有存储里，页面读不到。请用它的「导出配置」复制文本，粘贴到迁移页的粘贴框；也支持导入本扩展导出的完整迁移包文件。

结果会如实显示「写入 / 跳过 / 失败」的条数，不会用一句「导入成功」盖掉丢数据。详见 [docs/05-features.md](docs/05-features.md#数据与迁移)。

### 钓鱼仿冒站点防护

默认开启，无需配置。命中疑似仿冒域名时：

1. 页面被替换成全屏警告，同时**在网络层封锁该标签页的所有请求**；
2. 只有点「继续访问」（真实点击，页面脚本伪造不了）才会放行，且只对当前主机名有效；
3. 离开该站点后规则自动清除，不影响后续浏览。

## 常见问题

**Chrome 应用商店里为什么搜不到？**
2026-10-30 被拒，参考 ID `Grey Lithium`（内容政策 / 色情内容），理由是扩展「主要用途是改进提供露骨色情内容的网站」。属禁止项，改代码解决不了，也不再重投。Chromium 系请手动加载，见 [Chromium 系手动安装指南](docs/07-install-chromium.md)。

**加载后浏览器提示扩展「不受信任」或不来自商店？**
非商店扩展的固定标记（浏览器对侧载的策略），无法关闭，忽略即可，不影响任何功能。

**AMO 上装的版本比仓库新提交的旧？**
正常。AMO 每次发版都要审核，商店永远不会等于刚 push 的 commit。目前上架版本与仓库版本一致（0.1.32）；要提前用主干最新代码就在本地 `npm run build` 后临时载入 `dist/firefox/manifest.json`。临时载入与商店版互不冲突，但建议只留一个，避免两个实例同时注入。

**点了下载，为什么没开始下，而是出现在「需要处理」里？**
开启了「第三方网盘链接检查」，且该视频的简介或评论里有网盘链接。这是刻意不下载：请打开视频页自己选择用网盘还是用下载器，确认要下再点「强制下载」。

**视频显示「私有视频」，重试也没用？**
这类视频仅作者的好友可见，与登录状态无关。去作者主页加为好友、对方通过后再点「重试」。

**Firefox 连不上局域网里的 aria2？**
本仓库的 Firefox 产物是 **MV2**，不受 Firefox 针对 MV3 扩展的本地网络访问限制，局域网 http 地址可以直接用。若你自己改成了 MV3 构建，则只能用 `127.0.0.1` 或 `https`（详见 [docs/02-cross-browser.md](docs/02-cross-browser.md)）。

**任务删不掉？**
正在下载的任务需要先取消下载器再删记录（点一次「移除」会变成「确认取消？」，再点一次才执行）。若状态是「已交付」（交给了外部下载器），扩展这边删记录不代表对方停止。

**为什么要全站访问权限？**
见上文「权限说明」，只有两处用途。

**扩展会不会上传我的数据？**
不会。所有数据在本地，见 [PRIVACY.md](PRIVACY.md)。

**下载很慢，或者在 aria2 里看到同一条任务反复重建？**
先看是哪条通道。aria2 侧投递时会显式补上 `max-connection-per-server` 与 `split`（默认各 4，可在「下载」页签调）——上游 aria2 这两个默认值是 **1** 与 20M，不显式给就是单连接、小文件不分段。仍然慢就查代理带宽、aria2 全局的 `max-overall-download-limit`、以及自己填的连接数。速度长期低于 64 KiB/s 的任务会被自动重启（重新解析直链后原地换地址），这是刻意行为，不是卡死。

**任务一直停在「排队」？**
浏览器通道的并发上限（默认 3）在起作用：超出的任务等前一个结束才开跑，避免几十条传输同时打向同一个 CDN。换成 aria2 / iwaradl 后，「排队」由它们自己的并发上限决定，与本扩展无关。

**解析失败 / 提示没有权限？**
常见三类：直链过期（重新点一次下载即可，扩展会重新解析；aria2 侧的 403 也会依据错误报文自动重建）、首选画质到最后一级都拿不到（在「下载」页签调低首选画质或改网络环境）、登录态失效（重新登录 iwara.tv 并刷新页面）。私有视频需要与作者互为好友，这类访问控制不在扩展能绕过的范围内。

**通知没有弹出来？**
扩展用系统通知作为唯一反馈：先确认操作系统的浏览器通知权限没关、没有开「专注模式 / 勿扰」。通知被压掉不影响任务本身，任务队列与工具栏角标仍会更新。

**升级或重装扩展之后数据还在吗？**
同一扩展 ID 升级不会丢：配置、队列、视频库都在 `browser.storage.local` 与扩展自己的 IndexedDB 里。只有你在扩展管理页「移除」扩展时，浏览器才会连同数据一起清空——想手动备份就用「迁移」页签导出完整迁移包。

**装了却没反应 / 页面上没有复选框？**
按顺序排查：① 是否刷新过 iwara 标签页（扩展安装或更新后已打开的页不会自动注入）；② 当前页是不是视频列表页或视频详情页（其他页面本就没有复选框）；③ 「下载」页签里的「自动注入复选框」是否被关掉（关掉后按 `Space` 也能手动开）；④ Chrome 系请确认加载的是直接含 `manifest.json` 的目录，不是它的上一级。更细的排查步骤见 [docs/10-troubleshooting.md](docs/10-troubleshooting.md)。

## 与 Iwara 的关系与免责声明

- 本项目是独立开发的第三方工具，与 Iwara 官方**没有任何合作、授权或隶属关系**。
- 只通过站点本身公开提供的页面与 API 交互：不绕过访问控制，不破解任何付费或私有内容，不代理、不转发视频。
- 请自行确认下载行为符合所在地法律法规与 Iwara 的服务条款；开发者与贡献者不对使用后果承担责任，包括但不限于账号受限。
- 如果你喜欢站上的内容，请优先支持创作者：开通 [Iwara 高级会员](https://www.iwara.tv/page/premium) 或直接对作者打赏。
- 本项目以 [Apache-2.0](LICENSE) 开源，代码与文档按「现状」提供，不附带任何明示或默示担保。

## 开发

技术实现细节按主题拆在 `docs/`：

| 文档                                                        | 内容                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| [01-architecture.md](docs/01-architecture.md)               | 设计原则、运行时上下文、源码目录、注入时机与安全、UI 技术栈、状态与权限 |
| [02-cross-browser.md](docs/02-cross-browser.md)             | `browser` 命名空间策略、shim、浏览器差异矩阵与 Firefox 专项             |
| [03-manifest.md](docs/03-manifest.md)                       | 双 manifest 派生、版本号真源、权限清单、CSP 与打包                      |
| [04-messaging.md](docs/04-messaging.md)                     | 消息协议、全兼容监听器、MAIN ⇄ ISOLATED 桥、后台路由                    |
| [05-features.md](docs/05-features.md)                       | 当前功能、下载通道、队列语义、通知、配置、迁移、社交与钓鱼防护          |
| [06-testing-and-release.md](docs/06-testing-and-release.md) | 开发命令、测试分层、CI、Git 钩子、发布流程与未完成事项                  |
| [07-install-chromium.md](docs/07-install-chromium.md)       | Chromium 系手动安装：获取产物、加载、更新、数据保留与故障排查           |
| [08-aria2-flow.md](docs/08-aria2-flow.md)                   | aria2 任务管理逻辑图：三条入口、扫描对账、状态映射、失败与取消时序      |
| [09-debug-bridge.md](docs/09-debug-bridge.md)               | 调试通道：扩展主动连本机调试服务，快照、日志环、白名单命令              |
| [10-troubleshooting.md](docs/10-troubleshooting.md)         | 故障排查：装了没反应、解析失败、aria2 连不上、任务卡住、抓日志与导出    |
| [store-listing.md](docs/store-listing.md)                   | AMO 上架素材与文案、Chrome Web Store 拒绝记录                           |

**参与贡献**：先读 [CONTRIBUTING.md](CONTRIBUTING.md)（环境、门禁、提交约定、PR 流程）。安全漏洞请走 [SECURITY.md](SECURITY.md) 的私密渠道，不要开公开 issue。

**参与开发前先读 [AGENTS.md](AGENTS.md)**：门禁清单、架构铁律、目录归位、代码约定，以及一批「平台事实」（Chrome 的终止条件、Firefox MV2 的能力边界、aria2 的不存在方法）。这些规则背后的事故与实测记录在 [docs/agent-notes.md](docs/agent-notes.md)——遇到「为什么不能这么写」的疑问，先在那里找答案，别按通用惯例改代码。

常用命令（完整清单与测试分层见 [docs/06](docs/06-testing-and-release.md#开发命令)）：

```bash
npm run build        # 双目标编译 + 商店包
npm run dev:chrome   # watch 模式
npm run test:unit    # 单元测试
npm run test:e2e     # Playwright e2e
```

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

## 隐私与许可

扩展不收集、不向开发者回传任何数据；详见 [PRIVACY.md](PRIVACY.md)。许可证为 [Apache-2.0](LICENSE)。

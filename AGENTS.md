# AGENTS.md

给在本仓库工作的 AI agent（以及新加入的人）的约定与事实清单。**这里的每一条都有代价作为依据**，详细的事故与根因见 [docs/agent-notes.md](docs/agent-notes.md)；产品与架构说明见 [docs/](docs/)。

优先级：本文件 > 一般惯例。若本文件与代码冲突，先确认代码是不是刚被改过，再决定改哪一边；**不要**默默按惯例改代码。

---

## 1. 门禁：提交前必须全绿

```bash
npm run type-check        # src / build / manifest / test
npm run type-check:e2e    # Playwright specs
npm run type-check:wdio   # WDIO specs
npm run test:unit         # node:test + tsx
npm run test:e2e          # Playwright，直载 dist/chrome
npm run test:e2e:wdio     # Chrome + Firefox 双宿主
npm run format:check      # prettier（printWidth 9999 / tab 4 / 无分号 / 单引号 / CRLF）
npm run build             # 双目标编译 + 商店包
npm run lint:firefox      # web-ext lint（目标 0 errors 0 notices 0 warnings）
```

- **三套 `tsc` 都要跑**：只跑 `type-check` 会漏 `e2e/` 与 `e2e/wdio/`（它们各有独立 tsconfig）。任何 `.ts` 不在某个 tsconfig 的 `include` 里都会被 VS Code 丢进 inferred project，表现为 `Cannot find name 'node:test'` 这类假错误。
- **命令输出禁止过滤**：不要 `| tail`、`Select-Object -First`、`Select-String`、`Out-Null`。失败原因经常就在被截掉的那部分。
- 失败别急着重试：先读完整输出定位真因，再改。盲跑重试会被要求停下。
- `.githooks/` 三道钩子：`pre-commit` 自动格式化暂存文件、`commit-msg` 校验 `<type>: <说明>`、`pre-push` 跑与 CI 同序的 verify（类型 → 单测 → 构建 → lint）。**慢的检查不能放 pre-commit**（一定会被 `--no-verify` 永久绕过）。

## 2. 架构铁律

1. **`options/` 不得 import `background/`**。前者会把 `idb`/`indexedDB` 拉进页面 bundle，且两个写入者会让事务语义与错误归属无法界定。需要读写视频库 → 加消息，不要 import `background/storage/db`。
2. **纯函数放 `shared/`，不要放 `background/`**。放错地方会让单测 import 整条后台链（`queue → db → idb → indexedDB is not defined`）。判据是「纯不纯」，不是「属不属于这个领域」。
3. **`storage/` 是底座，不得引用其它领域**；`runtime/notify` 是横切能力，允许被任何领域引用。
4. **后台是队列的唯一写者**。页面只能通过消息请求，绝不直写 `storage.local.downloadQueue`。
5. **消息监听只经 `messaging/hub.ts`**（`return true` + `sendResponse`；禁止 promise 式监听器）。`background/index.ts` 的 switch 只做派发：**一个 case 超过两行就是该搬到领域目录的信号**。
6. **`browser` shim 由 esbuild `inject` 注入**，入口文件不要手动 import。
7. **MAIN ⇄ ISOLATED 只走 CustomEvent + JSON 字符串**（`CONTENT_SCHEMA` 门闩）。`content/isolated.ts` 与 `content/pageUi.ts` 是**两个独立 bundle**，不共享 JS 变量。
8. **状态属于区块，不属于页面**：一个组件里塞互不相关的区块会让禁用态串台。`AdvancedTab`（遍历 / 链接检查 / MediaCenter）与 `MigrateTab`（旧库导入 / 导出 / 导入）都因此拆过。
9. **消除重复真相源**：同一个形状被后台和页面各写一份 interface 必然漂移（`SyncState` 曾手抄过）。要么放 `shared/`，要么删掉一份。
10. **同一 `videoId` 只允许一条任务**（`skipped` 待办除外）。投递前必须查 `aria2LiveGidMap()`：aria2 里已有活 gid 就**接管**，绝不 `addUri` 第二次——同一输出路径两个 gid 必被 aria2 判成 `errorCode 13`，用户看到的是「目标文件已存在」这种看不懂的假失败。扫描再用 `planQueueVideoDuplicates` 收敛「完成 + 失败」这类跨状态重复行。

### 目录归位（`src/background/` 下只有 `index.ts` + 5 个目录）

| 目录        | 装什么                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| `storage/`  | 配置、队列、IndexedDB、解析、回填列表（底座）                              |
| `iwara/`    | 与站点交互：身份、API、评论、社交、同步                                    |
| `download/` | 下载编排：解析调度、投递、路径模板、批量                                   |
| `backends/` | 各下载后端 `aria2/{client,ws,tracker,recover}`、`iwaradl/{client,tracker}` |
| `runtime/`  | 浏览器能力：alarms、通知、剪贴板、菜单、保活、防护                         |

判定顺序：某后端的连接/对账 → `backends/<后端>/`；只读写本地状态 → `storage/`；发网络请求/解读站点数据 → `iwara/`；决定「下不下、怎么下」 → `download/`；封装浏览器 API → `runtime/`；**都不是 → 先怀疑它不该存在**（转发层、只换名字的包装）。

`shared/` **保持平铺**（叶子工具之间几乎不互相引用；半吊子分组比平铺更糟）。`test/` 与被测模块**同名**，不按 `src` 的目录分组。

## 3. 代码约定

- **命名不用下划线**（用户明确厌恶）：方法/变量/类型/文件都是。测试名用 PascalCase 风格的中文描述句，不要 `snake_case`。外部契约（环境变量、7z/RAR CLI 参数、`m3u8` 之类）不受此限。
- **i18n**：React 直接用 `react-i18next` 的 `useTranslation()`；非组件模块 `i18n.t('key')`。**不要自造包装层**（`t()` 包装、`TranslationKey`、`useI18n`）。字典在 `src/shared/locales/{en,zh,ja}.json`，键名靠 `src/shared/i18next.d.ts` 的 `CustomTypeOptions` 编译期校验。
    - 模板键（`condition.${id}`）靠**字面量联合类型**通过，不用字符串拼接糊过去。
    - **带 `{placeholder}` 的文案必须传参**：i18next 对未提供的占位符**原样保留**，界面会显示字面 `{days}` / `[{id}]`。
    - 三语键必须完全一致（`test/i18n.test.ts` 守）。
- **配置**：写在 `src/shared/configSchema.ts`（zod），存储键集中在 `src/shared/storageKeys.ts`。新增字段要同时更新 schema 默认值、UI、三语文案、必要时的迁移兼容。
- **样式**：设计令牌在 `options/options.css` 的 `:root`；`input[type='text']` 与 `input[type='password']` 是**互斥枚举**，新增 type 时要同步所有宽度规则（含 `.row--stack` 覆盖与媒体查询）。
- 长文本（注释、文档、Markdown 段落）**一段写一行**，不要按 ~80 列硬换行；结构化换行（列表、表格、代码块）正常保留。

## 4. 长任务的正确形态（Chrome MV3）

Chrome 终止 service worker 有**三条相互独立**的条件：空闲 30 秒（任何扩展 API 调用 / 事件 / WS 帧重置）、**单个事件处理超过 5 分钟（不可续期）**、`fetch` 响应超过 30 秒。

所以「保活」只作用于第一条。`keepBackgroundAlive`（offscreen 每 20 秒发端口消息）**不能**让一个 20 分钟的消息响应继续活着，`alarms` 也不行（它只是事后唤醒一个全新的 SW，内存里的循环早没了）。

**任何可能超过几分钟的任务都必须 fire-and-forget**：

| 环节     | 做法                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------- |
| 启动     | 消息处理器**同步占位**（`running = true`）后立即返回 `{ started, reason? }`，`void` 起任务         |
| 运行真相 | 后台**内存**里的任务对象 —— 进程没了，任务也就没了                                                 |
| 传送     | 后台写快照（易失进度用 `storage.session`，面向用户的结论用 `storage.local`），页面订阅 `onChanged` |
| 初值     | 挂载时发一次 `GET_*_STATE`；后台在那里做**残骸归一**                                               |
| 是否在跑 | 页面 `本地 busy ∪ 快照.running`（切页签重挂载后本地 state 归零，而任务仍在跑）                     |

- **不要用轮询消息推进度**：长任务期间的消息往返不受扩展控制（宿主可能排队/延迟派发），一次被卡住条就停在旧值；而且轮询循环的 `catch` 不重建定时器 ⇒ **永久停更**，没有任何机制恢复。写入即推送则天然免疫。
- **残骸归一靠不变量，不靠心跳超时**：判定「存储说在跑、而内存里没有任务」。这些任务几分钟甚至几十分钟才写一次，用「N 秒没更新算死」必然误杀。
- **收尾顺序固定**：先 `await` 写终态快照，**再**释放内存标记。反过来会留下「内存已空、存储仍写 running」的窗口，刚跑完的那次会被下次启动判成「中断」。
- 进程被杀（关浏览器 / 扩展更新 / 休眠 / 内存压力）会中断任务，**这是 MV3 无法消除的**。别声称能修好，只能如实告知 + 提供残骸归一。

## 5. 平台事实（不要凭直觉推翻，都实测过）

- **aria2 有三条实际行为线**（上游 1.36 / aria2-next 2.x / aria2-next 3.x），差异不止版本号：`2.4.9` 没有 `product` 字段，`3.1.1` 才有 `probe`/`moveDownload`/`media`，而且 **`3.1.x` 上 403 会永远停在 `active` 不报错**（上游与 2.4.9 都会正常给 `errorCode 22`）。判据与能力表在 `src/shared/aria2Flavor.ts`，实测记录与行为分叉见 [docs/08-aria2-flow.md](docs/08-aria2-flow.md#8-分支兼容上游-aria2--aria2-next)。
- **上游 aria2 的默认值有几个坑**：`--max-connection-per-server` 默认 **1**（不显式投递就是单连接）、`--min-split-size` 默认 20M（<40MB 的文件不分段）、`--retry-wait` 默认 0（**此时 502/503 不重试**）。投递参数要显式补，且只往更并行的方向补（判据在 `shared/aria2Options.ts`）。
- **`getSessionInfo` 的方法名不通用**：`aria2-next 3.1.1` 只有 `aria2.getSessionInfo`（`system.getSessionInfo` 回 `No such method`），上游只有 `system.getSessionInfo`。`client.ts` 的 `aria2SessionId()` 两个名字都试并缓存命中项。读不到会话 ID 就会退化成「每轮全量 `tellStopped`」；第二个重启信号是 `numStoppedTotal` **倒退**（单调计数器只有重启会变小）。2026-11-20 起两台测试机都是 3.1.1，上游 1.36 的行为记录保留在 [docs/08-aria2-flow.md](docs/08-aria2-flow.md#8-分支兼容上游-aria2--aria2-next)。
- **`aria2.restart` 不存在**（1.36.0 `system.listMethods` 无此方法，调用返回 `No such method`）。源项目里那条 error 分支是死代码，照抄会让任务从队列消失。
- **`all-proxy: ''` 不是「继承」而是「不走代理」**（实测：全局代理不通时，带空串的任务照样直连成功）。没配代理就别传这个键，传空串会静默废掉 `aria2.conf` 里的代理。同理，凡是能改变语义的选项都先问 `aria2.getGlobalOption`，别硬编码。
- **aria2 的 `waiting` / `paused` 不是「正在下载」**：那是 aria2 自己的并发上限排队。映射成 `running` 会让界面谎报并发数。
- **WS 与 HTTP 必须共用同一份认证参数**（`shared/aria2Rpc.ts` 的 `aria2AuthParams`）。两条传输路径各拼一次 `token:` 时，WS 会静默 401，再被「失败降级到 HTTP」掩盖。
- **Firefox 拦内网明文 http 只针对 MV3**，MV2 扩展被豁免。本仓库的 Firefox 产物是 **MV2 + `persistent: true`**（`manifest/variants.ts`），所以局域网 aria2 可用。
- **Firefox 的 `notifications.create` 对未知字段同步抛 TypeError**（不是 rejected promise），要降级到最小字段集。
- **Firefox MV2 没有 `browser.action`**，用 `browserAction`（已有 `badgeApi()` shim）。
- **`storage.local` 别用来存运行状态**：崩溃后永久残留「正在同步/导入中」，是最难自行恢复的假状态。用 `storage.session`（浏览器退出即清空）。
- **DNR 规则按 `tabIds` 而不是域名**（仿冒域名每天换），且必须 `excludedResourceTypes: ['main_frame']`，否则用户点「离开」也被拦。
- **`permissions.request()` 只能申请 optional 权限**，对 manifest 里静态声明的 host 权限无效 → 任何「一键重新授权」按钮都是死胡同。

## 6. 测试约定

- **源级守卫的生命线是「真的会红」**：写完必须临时改坏一次确认（改完还原）。看起来对的断言可能是永真的。
    - 断言要收窄到对应段落。全局 `doesNotMatch` 会误伤合法用法（曾经因为「批量入库确实必须轮询」而红）。
    - 守卫也要防**假绿**：注释里提到旧实现会让 `match` 通过、代码被注释掉时 `doesNotMatch` 仍然通过。剥注释统一用 `test/sourceGuard.ts` 的 `readSource`（**逐行丢弃整行注释**；用正则吃 `/* … */` 会因为字符串里的 `//`、`/*` 截断后面成片的真实代码）。
- **测试不要假设库是空的**：Playwright 的 persistent profile 跨 spec 复用，前面的用例会写数据。只断言本次播种的子集，或用「自洽性质」（如分页计数之和等于读取条数）。
- **e2e 选择器**：卡片按 `h2` 标题定位（`section.card` + `hasText` 常命中多张，因为 note 里也会提到那个词）；运行中文案会变的按钮用 `data-testid`；`section.card:first-of-type` 不可靠。
- **导航后立刻验证恢复态必须轮询**（`expect.poll`）：新文档里的脚本要先完成一次消息往返才恢复。紧跟 `reload()` 的断言会抓到窗口期。
- **WDIO `browser.execute` 里不能把函数赋给变量**（`const fn = () => …`）：esbuild `keepNames` 会插入 `__name(...)`，Firefox 报 `ReferenceError: __name is not defined`。写成内联匿名函数。
- **前台断言与时间赛跑时要换驱动源**：直接用存储驱动 UI，不要在 `reload()` 之后再种数据（`boot()` 的残骸归一会先把它改掉）。
- 单测/派发一致性：`test/protocol.test.ts` 会校验「每个 `Req` 联合成员都有后台 `case`」——加协议类型必须同时加 case，`default` 兜底是察觉不到的。

## 7. 工具链踩坑

- **PowerShell 5.1 默认按系统代码页（GBK）解码**：`Get-Content -Raw` 读 UTF-8 源码会把中文变乱码，写回即不可逆。改文件用编辑工具；必须用脚本时走 .NET：`[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` + `WriteAllText`。
- **改 locale JSON 后必须跑 `test:unit` 与 `build`**：重复键只会让 esbuild 吐 `[duplicate-object-key]` **警告**（构建不失败），而 `test/i18n.test.ts` 只校验三语键集合一致，抓不到重复键。批量替换时同一 `oldString` 被重复应用是常见事故。
- **`temp/` 在 `.prettierignore` 里**：`npx prettier --write temp/x` 是空操作（验证格式差异只能直接调 prettier API）。
- **`*.json` 也在 prettier 忽略范围**，但源码里的 JSON 字面量仍受构建约束。
- **`node --import tsx/esm` 的空闲终端里不要用 `node -e` 拼带引号/美元的脚本**，容易被 PowerShell 解析破坏；要测就写成 `temp/*.mjs`（纯 mjs，不经 esbuild）跑完删。
- 一次性探针/审计脚本放 `temp/`，**查完即删**；不要留在仓库里。
- **本机 npm 有 allow-scripts 策略**：esbuild 的 postinstall 被拦（警告无害，会 fallback 到平台包内二进制）。

## 8. 改动的连带责任（改完必须同步的清单）

| 改了什么                              | 还要改                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 消息协议（`protocol.ts`）             | 后台 `case`、`test/protocol.test.ts`、`docs/04`                                                        |
| 配置字段（`configSchema.ts`）         | UI、三语文案、`test/configSchema.test.ts`、必要时的 `docs/05`                                          |
| 用户可见文案                          | `src/shared/locales/{en,zh,ja}.json` **三份**（键必须完全一致）                                        |
| 页面 UI 契约（class / testid / 结构） | Playwright 与 WDIO 里对应的选择器与断言                                                                |
| 版本号（`package.json`）              | `GuideTab` 的 `RELEASES` + 三语 `guide.changelog.vXXXX`（漏了会让「引导页」用例红）                    |
| 目录结构                              | `README` 的目录树、`docs/01` 的「源码目录结构」、9 处左右的旧路径注释                                  |
| 缓存/存储键                           | `src/shared/storageKeys.ts`（唯一来源，不要在调用点拼字符串）                                          |
| 用户可见的用法文档                    | **Wiki**（源稿 `docs/wiki/`，发布命令见该目录 README）；`docs/` 只放开发文档，别把安装/排查/FAQ 写进去 |

**重构必须清尾**：改完主路径后主动删除旧类型、旧常量、旧方法、旧选择器、旧字典键、旧测试路径。清理完跑一次死代码审计（一次性脚本，查完删），确认归零，而不是只改主路径。

## 9. 已知限制（如实告知，不要试图"修好"）

- Chrome MV3 **没有常驻后台**。`keepBackgroundAlive` 默认关闭、官方文档明确要求「避免无限期保活」，它只是把空闲回收往后拖。
- 浏览器的 `downloads` 通道**拿不到字节进度**。为它轮询 `downloads.search` 会让 SW 常驻，不做。
- 去重有两层（本地队列 / aria2 `tellStopped`），**两层证据都会被合法消耗**（用户清空队列 + aria2 记录滚出 + 我们自己的冗余清理会删 `removeDownloadResult`）。2026 年结论：不擅自加「30 天内下过就拦」的第三层，因为会剥夺用户重新下载的能力。
- 源项目与我们**有意不同**的地方（不是遗漏）：`downloadTaskUnique` 不受 `experimentalFeatures` 门控、`waiting`/`paused` 也算「队列里已有」、`others` 用后台标签页而非 `GM_openInTab`、页内没有 toast/进度条（反馈走系统通知 + 任务页）。
- 站点语义别凭直觉推断：iwara 的「私有视频」= **仅好友可见**（关注不够，要加好友且对方通过）。`follow` 与 `friend` 是两种关系。

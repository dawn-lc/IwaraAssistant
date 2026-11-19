# Agent 工作笔记：事故、根因与实测结论

本文件是 [AGENTS.md](../AGENTS.md) 的证据层。规则在那边，这里写**为什么有这条规则**——每条都来自一次真实的故障或实测，不是推演。

新条目按主题追加到对应小节，不要另起流水账；已被后续改动取代的结论要就地修正或删除，避免留下"看起来成立、实际已过时"的说法。

---

## 1. 单次全量拉取在浏览器里必然出事

**现象**：MediaCenter 批量同步点下去，扩展进程卡死。

**根因**（两处，都在阶段一）：

1. `fetchMediaList` 用 `?limit=0` 一次拉全量（照抄源项目）。14 万条 ≈ **118 MB**，`response.json()` 要先生成一个字符串再建对象树，两者同时驻留。
2. 匹配是 O(本地 × 远端)：源实现预建 `byHash`/`byToken`/`titleIndex`（`byToken` 给**每一条**远端标题分配切片字符串），再对每条未映射的本地视频线性扫一遍全部标题。

**修法**：服务端本来就支持 `?page=&limit=` 分页（`limit` 硬顶 100），只取匹配需要的三个字段；索引**只对尚未映射的候选建**（全部已映射时一个远端请求都不发）；标题匹配改成「alnum token 内按候选长度滑窗」，成本与远端规模线性相关。

**教训**：「一次拉全量」在扩展进程里是硬约束，不是性能优化项；「全量 × 全量」的匹配必须转成候选受限的索引。并发 4 够用（页码独立、乱序不影响索引），1400 页 ≈ 1.2 秒。

---

## 2. 进度不能靠轮询消息

**现象**：明明在跑，进度条停在「已读 0 条」不动；换个页签回来条还在，但不更新。

**根因**（三条，前两条是同一类）：

1. 页面 `setTimeout` 每 1~2 秒发 `GET_*_STATE`。**长任务期间的消息往返不受扩展控制**（宿主可能排队/延迟派发），一次被卡住条就停在旧值。
2. 轮询循环的 `catch` 之后没有重建定时器 ⇒ **永久停更**，没有任何机制让它恢复。
3. 运行态只存在页面 state 里。切页签 → 组件重挂载 → 本地 state 归零，按钮变回可点（再点一次就是两条并发任务）。

**修法**：后台写快照，页面订阅 `storage.onChanged`（`options/widgets.tsx` 的 `useStorageSnapshot` 是唯一实现）；`running = 本地 busy ∪ 快照.running`；挂载时发一次 `GET_*_STATE` 拿**归一后的初值**。

**教训**：这是**通道语义**问题而不是性能问题——推送是「写入即渲染」，不依赖长任务期间的消息派发。另外，「初值」这条消息必须存在：只有它能做残骸归一。

---

## 3. 运行态写进持久层 = 崩溃后永久残留

**核心洞察**：**任务与它的运行状态死在同一个进程里**。SW 被回收 / 浏览器重载时，任务和模块变量一起消失。所以「还在跑吗」的唯一正确真相是**内存里的任务对象**。

把 `running: true` 写进持久层就把两者生命周期解耦了 → 进程被杀后存储里永远留着 `running: true` → 界面永远转圈、按钮永远禁用，只能手动清存储。这不是「概率很低」，而是**每次崩溃/重载都会发生**。

**修法**（四处一致：好友审批、MediaCenter 同步、站点遍历、旧库导入）：

- 持久层只负责「把内存里的快照送到别的上下文」+「留下终态结果」。
- 读到 `running: true` 而内存里没有任务 ⇒ 一定是残骸，归一为「已中断」。
- **靠不变量判定，不靠心跳超时**：`collecting` 阶段（递归拉评论证据）可能几分钟没有任何进度变化，用「N 秒没更新算死」必然误杀真在跑的任务；把间隔压到能容忍的粒度，又等于把轮询成本还给后台。

**存储选型**：易失的运行状态用 `storage.session`（内存态、跨上下文可读、浏览器退出即清空、零磁盘 I/O）；站点遍历用 `storage.local`，因为它的 `message` 是**面向用户的最终结论**（「已遍历 N 页」），刷新后仍值得看到。

---

## 4. 「单个事件 5 分钟」与「30 秒空闲」是两条独立的终止条件

**现象**（潜在，未爆发）：全站遍历是几千页 × 0.5~1.5s ≈ 小时级，却把整轮 `await` 在消息处理器里。

**根因**：Chrome 有三条相互独立的终止条件：空闲 30 秒（任何扩展 API 调用 / 事件 / WS 帧重置）、**单个事件处理超过 5 分钟**（硬上限，无 API 可续期）、`fetch` 响应超过 30 秒。到期 SW 被终止，任务连同模块变量一起消失，页面那边 `await send()` 的 promise **永远不会 resolve**。

**修法**：`startSiteSync(kind)` 同步占位 `running` 后立即返回 `{ started, reason? }`，循环 `void` 起在后台；每页一次 `storage.set` + fetch 给空闲计时器续命（间隔最长也只有失败退避的 5~6 秒）。

**关键认识**：**保活救不了它**。`keepBackgroundAlive`（offscreen 每 20 秒发端口消息）与 `alarms` 都只作用于「空闲回收」那一条；`alarms` 更是只能事后唤醒一个**全新的 SW**，内存里的循环早没了。要「续跑」得持久化页码，那是新功能，且与自动遍历的间隔判据纠缠。

**代价**：进程被杀会中断遍历，MV3 上无法消除。只能配 `settleInterruptedSync()`（`boot()` 里把「存储说在跑、内存无任务」写成「上次遍历被中断（已跑 N 页）」）。

---

## 5. 队列里的僵尸任务

### 5.1 交付型通道永远停在 running

`others` 只是 `tabs.create` 打开直链、`iwaradl` 只 POST 一次，两者**都没有回传通道**；旧实现照样建 `status: 'running'` 的任务，之后没有任何代码收敛它，而 `removeTask` 拒绝 running → **默认配置下几乎所有任务都移不掉**。

修法：新状态 `handed-off`（已交付）是交付型通道的终态；`channelTracksResult(kind)` 判定某通道有没有回传；`boot()` 里 `reconcileStaleRunningTasks()` 按证据对账（browser 查 `downloads.search`、aria2 看有没有配置端点、交付型看有没有 `kindRef`）。**刻意不记 `complete`**——会撒谎，且被去重当成「已下载」而静默吞掉重下意图。

`iwaradl` 后来被证实有完整任务 API（`GET/DELETE /api/tasks`，主键 `vid`），于是从「交付型」改为可追踪。顺带发现旧代码 `body.id ?? randomUUID()` 永远拿不到 id（POST 返回的是**数组**），kindRef 从来没对上过任何任务。

### 5.2 gid 被 aria2 滚出后没人管

`scan-aria2` 只遍历 `tellActive` + `tellStopped` 返回的任务。gid 被 `max-download-result` 上限滚出、或 aria2 重启过之后，队列里那条 `running` 再没人管，永远停在「下载中」。

修法：扫描末尾做**反向对账**——队列里 `running`/`queued` 的 aria2 任务，gid 不在本次 `seenGids` 里就 `tellStatus` 权威确认，`doneMap` 命中收敛成 `complete`，否则 `failed` 并通知。

⚠️ `isAria2GidMissingError` 必须**只认** `/GID .* is not found/i`。把「连不上」当成「任务没了」的话，aria2 一次重启就会把所有在跑任务误判为失败。

**2026-11-21 补完最后一段**：启动对账对 aria2 通道只判「有没有配端点」就 `KEEP`，而扫描只处理「在 aria2 列表里出现」的任务——两条路径都不管「gid 已经不存在了」的那些，于是队列长期挂着幽灵 `running`：界面 115 条、aria2 `numActive` 1，抽查 20 条 gid 里 6 条 `not found`、其余是 error 13/22/2 与 complete，真在跑的是 0。修法是每轮扫描对「队列活着但三份名单都没有」的任务逐条 `tellStatus`（`pickUnseenQueueTasks`，每轮 20 条）：不存在→failed、complete→完成、error→恢复链、active→不动、传输失败→不动（证据不足不判死）。**「列表里没有」不等于「死了」，只等于「需要问一次」。**

### 5.3 完成表被误用去拦 error

**现象**：309 条 aria2 `error` 残留既不被清理也不入队，任务面板里看不到、也点不了重试；日志每轮刷几百行「30 天内已完成，跳过残留任务」。

**根因**：判据写成 `doneMap[videoId] !== undefined && status !== 'active' && status !== 'waiting'` —— 「排除少数活状态、其余全跳过」把 `error`/`removed` 也一起吃了。而完成表之所以命中 error 记录，是因为批量投递量远超 aria2 并发上限，排队到真正开跑时签名直链已过期（403），但同一视频**更早那一批里成功过**——「30 天内完成过」说的是另一次尝试。

**教训**：去重表/完成表只能用来「防重复处理」，**不能用来替用户决定某条失败可以忽略**。判据里出现「排除少数、其余全跳过」时要立刻警觉：它会把将来新增的终态默默归类。收编来的历史失败要默认耗尽 `attempts`（要重试请用户自己点），并对自动重试加每轮条数上限（共同失败会让几十上百条同时 failed）。

### 5.4 队列内同视频重复

同一 videoId 可以有多条 `running`/`queued`（界面两行「下载中」，浏览器通道还按记录数吃并发槽位）。修法：`planQueueLiveDuplicates` 只分组活记录，保留优先级「kindRef 在 aria2 活跃集内 → 有 kindRef → 更新时间新」，丢弃者若带 kindRef 要**继承**给保留者（否则追踪器再也认不出这条任务）。

**2026-11-20 补充（真机取证）**：一台机器 1218 条 stopped 记录里有 **87 组同 videoId 的重复 gid**，其中大量是「一条 `complete` + 一条 `error 13`（`belongs to another download`）」——同一个输出路径先后投递两次，后到的那条被 aria2 拒了。表现到界面上就是「已完成」与「目标文件已存在，请先确认是否已下好」两行并存。根因是队列层去重只认我们自己队列里的 `queued/running/complete`：用户清过队列、或上一轮记录丢了，`addUri` 仍会照发。现在的三层保证：① **投递前**查 `aria2LiveGidMap()`（`tellActive`+`tellWaiting`，5 秒缓存，命中再 `tellStatus` 确认还活着）→ 已有活 gid 就**接管**不重投；② **扫描**用 `planQueueVideoDuplicates` 把同视频的多条任务收敛成一条（优先级 在跑 > 完成 > 已交付 > 失败，`skipped` 是待办不参与）；③ **撞 errorCode 13** 时先看同视频是否已有 `complete`/`running` 记录，有就删掉这条重复行（`dropDuplicateConflictRow`），不报假失败。

---

## 6. aria2 的七个坑（全部实测）

1. **`aria2.restart` 不存在**。1.36.0 的 `system.listMethods` 无此方法；调用返回 `{"code":1,"message":"No such method: aria2.restart"}`（无 token 时先回 `Unauthorized`，所以**必须带 token 才能测**）。源项目那条 error 分支是死代码且有害：`aria2API` 只 `fetch().json()`（RPC 错误不抛异常）→ `restartRes.result` 是 undefined → 仍执行 `removeDownloadResult`（真删了记录）→ `changeUri(undefined,…)` 静默失败 → 任务从队列消失。正确路径是「清结果 + `addUri`」。
2. **WS 分支曾经不发 token**。`token:` 前缀只有 HTTP 拼了一处；WS 拿 `Unauthorized` → 抛异常 → 降级 HTTP（带 token）→ 看起来正常。等把「RPC 级错误不降级」改上去后，掩盖层被移除，缺陷才暴露成「环境自检 Unauthorized」。**同一个 RPC 有多条传输路径时，认证参数必须由唯一一处生成**；「失败自动降级」会静默掩盖前一条通道的毛病，降级路径必须可观测（日志计数）。
3. **`changeUri` 参数**：`fileIndex` 必须是 **1**（传 0 被拒：`must be greater than or equal to 1`）；`position: 0` 必须显式给（否则新地址只追加到 `uris` 末尾，`used` 仍是旧地址）。对 `active` 任务调 `unpause` 会抛 `cannot be unpaused now`，把同一次 try 里的 `changeUri` 一起判失败。
4. **`allow-overwrite` 救不了「File exists but a control file does not exist」**。aria2 源码里 `tryAutoFileRenaming()` 只看 `auto-file-renaming`（默认 false），而 `adjustFilename()` 在「同一文件正被另一个 RequestGroup 处理」时的分支**完全不参与 allow-overwrite**。这条错误是竞态的产物，也是**重复投递**的后遗症；根治只能靠投递前去重。
5. **事故：慢速恢复把 87 个真实任务复制了**。`rebuildAria2Task` 无条件回退旧地址（源项目同款写法），慢速分支在 `restart` 失败时降级到它 → 每个任务多出一个 0 字节副本、原任务消失。修法：只有 `error`/`removed` 才允许用旧地址兜底（`canRebuildFromOldUris`）。衍生事实：`active` 任务的重建参数里没有 `continue`，所以「重建」一定丢进度；`force-save`/`allow-overwrite: true` 会让副本从头覆盖同一文件。

6. **`all-proxy: ''` 的真实语义是「不走代理」，不是「继承」**。实测：全局代理指向一个不通的地址（`http://127.0.0.1:9`）时，不带该选项的任务继承代理、一直 `active` 连不上；带空串的任务 `getOption` 里**没有** `all-proxy` 键且**直连成功**。旧实现「用户没配代理就传空串」等于把用户 `aria2.conf` 里的代理静默关掉（两台测试机都没配代理，所以一直没暴露）。修法：没配就**别传这个键**（`shared/aria2Options.ts` 的 `aria2ProxyParams`）。凡是能改变语义的选项，先问 `aria2.getGlobalOption`。
7. **上游默认值会让「aria2 通道」看起来比浏览器还慢**：`--max-connection-per-server` 默认 **1**（每个文件一条连接）、`--min-split-size` 默认 **20M**（<40 MB 的文件不分段）、`--retry-wait` 默认 **0**（此时 502/503 根本不重试）。用户 conf 里若没写过这几项，我们就是在用单连接下载，还把一次网关抖动升级成「任务失败」。现在投递时显式补，且**只往更并行的方向补**（conf 已配更高就不覆盖）。

**慢速判定的采样必须持久化**：源项目是每任务 worker 4 秒轮询 ×16 次；我们是分钟级探测，采样计数原本只存内存 → Chrome SW 空闲 30 秒就回收，而探测 1 分钟一次 ⇒ **每次都是新实例，「连续 2 次」永远数不到 2**（自移植以来从未触发过）。现在存 `storage.session`。

---

## 7. IndexedDB 唯一索引把整个解析搞挂

**现象**：任务失败，详情「重试解析失败: A mutation operation in the transaction failed because a constraint was not satisfied.」

**根因**：`follows`/`friends` 沿用源 schema（主键 `id` + `username` **唯一索引**）。`put` 按主键替换，所以「同名但不同 id」的旧记录不会被覆盖 → 新记录必然撞唯一索引。而 `parseVideoFull` 在这一步抛错 → 包成 `VideoParseError` → **视频数据其实已完整拿到却整次作废，且重试永远复现**。

**修法**（`shared/userCache.ts` 的 `putUserCacheRecord`）：撞唯一索引 → 按 username 查旧记录 → 是过期（同名不同 id）就删再重写一次；同名同 id / 查不到 / 非冲突错误一律**不动数据**并如实失败。且 `putFollow`/`putFriend` **失败不抛出**——它们只是派生缓存，`.follow` 角标下次解析会自愈，让下载失败不可接受。

源项目同样有此 bug，所以这是**有意的偏离**，代码里已注明。

---

## 8. 大库导出/导入必须流式

`JSON.stringify(整个载荷, null, 2)` 要生成**一个**字符串，V8 单字符串上限 ≈ 512 MiB。视频库单条可达数 MB，整库文本轻易越线 → `allocation size overflow` / `Invalid string length`。

- 导出：按 `DB_EXPORT_PAGE` 一页页读、一条条序列化，攒够 1 Mi 字符产出一块并立刻 `new Blob`（原字符串随即回收），最后 `new Blob(parts)`。**输出与 `JSON.stringify(payload, null, 2)` 逐字节一致**（e2e 有契约用例）。
- 导入：字符级扫描器跨块状态机（`shared/migrationStream.ts`），只在块边界 await（每字符 await 会让几亿次微任务把大库导入拖死）；文件侧用 `file.stream().pipeThrough(new TextDecoderStream())`，**绝不 `file.text()`**（否则「自己导出的备份自己导不回来」）。
- 体积用 `Blob.size` 累加（UTF-8 真实字节），**不用字符串长度冒充**（中文 1 字符 = 3 字节，会低报 2~3 倍）。
- 进度总量用 `conn.count(store)`（只扫索引，不反序列化），**不要**「先读第一页来数条数」（一页最大 16 MiB）。

旧库导入的体积上限要按**事务**算而不是按记录：Firefox 单次 IDB 事务约 246 MiB，历史上 1.8 GB 事务直接炸（`serialized value is too large`）。现在消息 16 MiB/1000 条、写库 32 MiB/500 条，失败二分隔离到单条。

---

## 9. 平台实测（不要凭直觉推翻）

| 事实                                                                                        | 实测方式                                                             |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Chrome MV3 无常驻后台，只有三条终止条件（30s 空闲 / 5min 单事件 / 30s fetch）               | 官方文档 + 行为观察                                                  |
| Firefox **只拦 MV3 扩展**访问局域网明文 http（LNA），MV2 豁免                               | 同一份代码、同一 origin，只换 `manifest_version` 对照                |
| Firefox MV2 下 `permissions.remove({origins})` 返回 true 但**什么也不做**                   | WDIO 实测，`contains` 仍 true                                        |
| Firefox MV2 支持 `world: "MAIN"`、`storage.session`、DNR session 规则、`webRequestBlocking` | 独立 MV2 探针扩展（temp/，查完即删）                                 |
| MV2 没有 `browser.action`，必须 `browserAction`                                             | 同上                                                                 |
| Firefox `notifications.create` 对未知字段（`silent` 等）**同步抛 TypeError**                | 传 `silent` 后 `.catch()` 拦不住，整条 `INIT_DOWNLOAD` 变 `ok:false` |
| `downloads.download` 在 Firefox 会按 `filename` 里的 `/` **真实建子目录**                   | 探针实测（Bugzilla 1280044 早已 FIXED，项目曾为此扁平化 4 年）       |
| `permissions.request()` 只能申请 optional 权限                                              | 对 required host 权限 Chrome 报 `Cannot request required permission` |
| 无 `tabs` 权限时 `tabs.query` 本扩展自身页面**仍返回完整 url**                              | popup 复用已有 options 页签靠它                                      |

**站点语义**：iwara 的「私有视频」= **仅好友可见**（`GET /video/:id` 返回 `{"message":"errors.privateVideo"}`，连标题都没有）。只关注作者看不到，**必须加好友且对方通过**。`follow` 与 `friend` 是两种不同关系（`POST /user/:id/friends`）。

---

## 10. 测试方法论（踩过的坑都在这里）

**源码守卫**：

- 必须**证明会红**：写完临时改坏一次（改完还原）。曾多次写出永真断言。
- 必须**收窄段落**：全局禁 `void poll()` 会误伤「批量入库确实必须轮询」。
- 必须防**假绿**：注释里提到旧实现会让 `match` 通过；代码被注释掉时 `doesNotMatch` 仍通过（第一版守卫就是匹配到了注释）。
- 剥注释用 `test/sourceGuard.ts` 的 `readSource`：**逐行**丢弃整行注释。用正则吃 `/* … */` 会因字符串里的 `/*`（如 `'*://*.iwara.tv/*'`）截断后面成片真实代码，实测把 `await markImporting(true)` 整段吃掉，守卫于是在残缺文本上断言。
- 别用「数次数 ≥ N」这种松阈值：删掉一处仍然通过（曾把 `report` 从 4 处删到 3 处仍绿）。按**结构**断言（例如「两条循环必须各有一处 `state.page = page` → message → `await report`」）。

**e2e**：

- 不要假设库是空的（persistent profile 跨 spec 复用）。只断言本次播种的子集，或用自洽性质。
- 卡片按 `h2` 标题定位：`section.card` + `hasText` 常命中多张（note 里也会提到那个词）。
- 运行中会换文案的按钮用 `data-testid`，按文字定位会在阶段切换后失效。
- 导航后立刻验证恢复态必须 `expect.poll`，不能紧跟断言。
- 想「用存储驱动 UI」时**不要 `reload()` 之后再种数据**：`boot()` 的残骸归一（或任何启动对账）会先把它改掉。挂载后直接写盘走 `onChanged`，结果是确定的。
- 视口内的浮层（toast）会吃掉右对齐控件的点击：Firefox/geckodriver 的拦截检查比 Chromium 严格，`.ia-toast` 必须 `pointer-events: none`。
- 测量几何时先把入场动画 `getAnimations({subtree:true}).finish()` 快进到底，否则量到半路位置。

**WDIO**：

- BiDi 下 `browser.execute` 的回调**不能把函数赋给变量**（`keepNames` 注入 `__name(...)`，Firefox 报 `ReferenceError: __name is not defined`）；内联匿名函数可以。
- 每多一个 spec 文件就多一次「重装扩展 + 重启浏览器」，所以 `extension.spec.ts` 单文件共享 storage 演进；撤销权限用例必须放最后。
- `strictSelectors` 默认开启：`$` 命中多个直接抛错。
- 受控输入用原生 value setter + 单次 `input` 事件（`setValue()` 逐字符键入会被 React 覆盖）。

**单测**：

- 断言中文文案前先 `setLanguage('zh')`（Node 24 有 `navigator.language`，默认语言随系统漂移）。
- 能放 `shared/` 的纯函数一定要放，否则单测 import 到 `indexedDB is not defined`。

---

## 11. 工具链

- **PowerShell 5.1 按系统代码页（GBK）解码**：`(Get-Content -Raw) -replace ... | Set-Content -Encoding utf8` 会把 UTF-8 源码里的中文变成乱码写回，**不可逆**（非法 GBK 序列被替换成 `?`）。改文件用编辑工具；脚本必须用 .NET 的 `ReadAllText(p, UTF8)` + `WriteAllText`。
- **改 locale JSON 后必须跑单测 + 看构建警告**：重复键只让 esbuild 吐 `[duplicate-object-key]` 警告（构建不失败），而三语键一致性测试抓不到重复键（`JSON.parse` 后者覆盖前者）。批量替换时同一 `oldString` 被重复应用是常见事故；插键时漏逗号会让三个语言文件同时坏。
- `temp/` 与 `*.json` 都在 `.prettierignore` 里：`prettier --write temp/x` 是空操作。
- `node --import tsx/esm` 之外别用 `node -e` 拼带引号/美元的脚本（PowerShell 会破坏）；测逻辑就写 `temp/*.mjs`（纯 mjs、不经 esbuild），跑完删。
- 带环境变量的 npm script 一律写 `node --import tsx/esm ./build/env.ts KEY=VALUE -- <命令>`（Windows 下 `spawnSync('npm.cmd')` 必须 `shell: true`，Node 20 起禁不经 shell 启动 `.cmd`）。

---

## 12. 结构整理：判据与代价

**「乱」的标准**：不是文件多少，而是「入口层在做业务」和「同一角色的文件在不同目录里叫不同名字」。

- `background/index.ts` 从 659 行降到 ~290 行：switch 里每个 case 超过两行就搬走（`LEGACY_DB_*` 50 行 → `storage/legacyImport.ts` 等）。
- 后端目录同角色同名：`client`（门面）/ `tracker`（对账）/ `recover`（恢复）。`trackers/` 目录被删除——它只装「后端的一半」。
- `content/` 顶层只留 manifest 入口（`mainWorld` / `isolated` / `pageUi` / `markers`）+ 功能目录。
- `download/cardMeta.ts` → `storage/`（它不下东西，只读库拼视图模型，与 `cacheList` 是一对）。

**聚合 vs 保留的判据**：同一个概念被切成多个文件 → 聚合（任务语义曾散在 `task` / `taskReconcile` / `cancelStrategy` 三处）；彼此独立的叶子工具 → 平铺（`shared/` 41 个模块只有少量互相引用）。**纯/不纯的边界比领域边界更重要**：`iwaradl` 的模型必须留在 `shared/`，否则单测会 import 整条后台链。

**迁移脚本的三个坑**：解析旧 specifier 不能查 `fs.existsSync`（文件此刻已移走，要构造「旧路径集合」做字符串匹配）；正则会漏**动态导入** `import('./x')`（靠 `type-check` 抓）；文件清单必须在移动**之后**重新收集。`import.meta.dirname` 的相对深度也要跟着改，否则 e2e 会报「未找到扩展产物」。

**删文件前先看有没有同名测试**（曾把 `test/iwaradlTask.test.ts` 一起删掉，未提交、git 恢复不回来，只能重写 12 条）。

---

## 13. 有意的行为偏离（别"修正"回源项目）

- 「简介/评论里有第三方网盘链接」命中时**不下载**（落一条 `skipped` 待办），而不只是弹提示。源项目的 `return` 是**门**，不是提示——移植一条分支时必须同时看它的 `return`/`break`/`continue` 语义。
- `downloadTaskUnique` 去重**不受 `experimentalFeatures` 门控**（该开关的界面文案只承诺控制 MediaCenter）。
- `waiting`/`paused` 也算「队列里已有」（比源更保守）。
- 页内没有 toast / 进度条：反馈走系统通知，队列与历史在 options。
- `autoInjectCheckbox` 用显式的 `injectionOn` 意图开关，不用「DOM 里有没有复选框」反推（后者在真实站点会死锁）。
- `videoUploadTime` 缺省不写（源写 `0`，等于造假）。
- 进入 `/videos` 的自动遍历加了 5 分钟最小间隔（源是每次 pageChange 试一次）。
- 默认下载方式是**浏览器内建**（源默认 `Others`，那是油猴环境没有 `downloads.download` 的妥协）。`others` 对扩展来说是「交付即失联」通道。

---

## 14. 网络受限环境与「别把网络问题当链接失效」（2026-11-19 实测）

用户网络里的 DNS 污染 / 连接重置 / IP 阻断 / SNI 嗅探与「iwara 直链过期」在我们眼里都是「aria2 报了个错」，但**处置相反**：过期要重解析，网络阻断重解析毫无用处（新链接一样连不上，而且解析本身也要出网）。

- **归因表**（`shared/aria2Network.ts`，纯函数）：`22 + status=401/403/404/410`、`4` → `expired`（重解析）；`22 + status=5xx`、`29` → `transient`；`6/19/2/23`、报文含 connection reset / name resolution / TLS → `network`（退避，**不计入恢复上限**）；`11/13` → `file-conflict`；`9/10/15/16/17/18` → `permanent`（磁盘满、目录不可写，重试必然再撞）。
- **退避**：1 分钟起翻倍、封顶 30 分钟。**熔断**：最近 5 分钟 ≥3 个任务网络失败 ⇒ 冷却 10 分钟，期间一个 RPC 一个解析都不发，只发一条通知。阻断是**成片**的，逐个小步退避仍会把 20 次解析 + 20 次 addUri 打出去，而这些请求大概率也出不去。
- **手动出口**：`REBUILD_TASK`（任务页「重建」）对每条 `failed` 都给，判据只看状态不看归因；它会清掉退避/熔断/attempts 再重投递。自动路径对上述三类失败是刻意不动的，若没有人工出口，用户处理完网络后只能干等。
- **`tellStopped` 全量的真实代价**（1134 条历史）：`tellStopped(0,4096,全字段)` = **12,815,311 B / 289 ms**，`getGlobalStat` 只有 **153 B**；5 分钟一轮 ≈ **3.5 GB/天**。改为先问 `numStoppedTotal` + `sessionId`：计数没变就**一条都不拉**，涨了 N 只拉 `min(256, N+8)`，每 12 轮全量一次，`sessionId` 变化（aria2 重启）立即全量并清空采样。**`sessionId` 也是 gid 失效的唯一可靠信号**。它的方法名不通用（3.1.1 只有 `aria2.getSessionInfo`，上游只有 `system.getSessionInfo`），读不到就退化成每轮全量；第二个信号是 `numStoppedTotal` 倒退。回包大小由记录内容决定：升级重启后同一台机器 1116 条只 923 KB（旧观测 1134 条 12.2 MB），`gid` 字段单问 30 KB。
- **`attempts` 必须落盘再重试**：`retryTask` 有三处早退，早退时内存里的 `+1` 从不写回；Chrome MV3 的 SW 每 30 秒可能被回收 ⇒ 计数永远停在 0 ⇒ 永久失败（私有视频 / 外部 embed / errorCode 13）被每 30 分钟重打一次，永不停止，还占满 `RETRY_BATCH_LIMIT` 的名额。**任何跨事件保留的计数都必须先写存储。**

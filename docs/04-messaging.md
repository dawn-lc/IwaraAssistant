# 04 消息协议与跨世界桥

## 三条通道概览

| 通道                  | 场景                                            | 机制                                                                                                                          |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| MAIN ⇄ ISOLATED       | 同一页面两个世界                                | `CustomEvent`（双向均为同步派发，数据 JSON 序列化）                                                                           |
| ISOLATED ⇄ Background | 页面 → 调度中枢                                 | `browser.runtime.sendMessage`（无标签页歧义）                                                                                 |
| Background → ISOLATED | 广播/点对点（配置失效、扫描唤醒、任务状态推送） | `browser.tabs.sendMessage`（后台经 `tabs.query` 锁定 iwara 标签页）+ 可选 `browser.runtime.sendMessage`（发往 options/popup） |

## 消息协议（单一事实源）

完整类型定义以 [`src/messaging/protocol.ts`](../src/messaging/protocol.ts) 为准；这里只列分组与用途，避免文档和代码各维护一份类型。

| 分组      | 消息                                                                                                                                       | 说明                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 采集      | `INGEST_VIDEO_INFO` / `INGEST_AUTH` / `INGEST_COOKIE`                                                                                      | 页面 MAIN / ISOLATED 上行；后台负责解析、落库与 token 使用         |
| 下载      | `INIT_DOWNLOAD` / `DOWNLOAD` / `DOWNLOAD_METADATA` / `CHECK_LINK` / `BATCH_DOWNLOAD` / `FORCE_DOWNLOAD`                                    | 发起下载、链接预检、批量入队、跳过预检的显式强制下载               |
| 查询/配置 | `GET_VIDEOS` / `GET_CONFIG` / `PAGE_READY` / `ENV_CHECK` / `GET_CARD_META` / `GET_BACKEND_STATS`                                           | 视频库与配置查询、页面就绪、环境自检、卡片角标、后端容量           |
| 队列      | `RETRY_TASK` / `REMOVE_TASK` / `CLEAR_FINISHED` / `RETRY_FAILED` / `SYNC_DOWNLOAD_TASKS`                                                   | 队列操作全部由后台执行；running 任务不可直接移除                   |
| 同步      | `SYNC_ALL_VIDEOS` / `SYNC_SUBSCRIBED` / `GET_SYNC_STATE` / `SYNC_MEDIA_CENTER` / `REMOVE_PLAYLIST_ITEMS`                                   | 全量/订阅遍历、MediaCenter 推送、播放列表移除                      |
| 好友      | `APPROVE_FRIEND_REQUESTS` / `GET_FRIEND_APPROVE_STATE`                                                                                     | 审批只返回「已开始」，结果由快照轮询获取                           |
| 迁移/导出 | `LEGACY_DB_SCAN` / `IMPORT_LEGACY_DB` / `LEGACY_DB_PULL` / `LEGACY_DB_BATCH` / `LEGACY_DB_PROGRESS` / `DB_EXPORT_PAGE` / `DB_STORE_COUNTS` | 旧库检测与显式导入、四表分页导出、进度与条数                       |
| 钓鱼防护  | `GUARD_SYNC` / `GUARD_RELEASE`                                                                                                             | 页面请求后台裁决；放行决定由后台记录                               |
| 后台推送  | `DOWNLOAD_STATE` / `CONFIG_INVALIDATED` / `CONFIG_SYNC` / `CACHE_INJECTION_LIST` / `DOWNLOAD_TASK_SETTLED` / `HELLO`                       | 只能由后台发出；`DOWNLOAD_TASK_SETTLED` 只发给发起批量下载的标签页 |

响应统一为 `{ ok: true; data } | { ok: false; error }`；所有 payload 必须可 `structuredClone`，跨 MAIN 世界通道只传 JSON 字符串。

> `DOWNLOAD_TASK_SETTLED` 只发给**发起批量下载的那个标签页**（`sender.tab.id`）：
> 页内复选框据此取消勾选（逐项处理完即删，不是整批结束才清）。其它标签页靠
> `storage.local.pageSelection` 的 `onChanged` 联动——选择集本来就跨标签页共享，
> 让每个标签页都写一次反而会引入写计数竞态。

> **`pageType` 只为一件事存在**：`checkDownloadLink` 在视频详情页不检查
> （用户正看着简介和评论区，提示等于废话）。
> 缺省（右键菜单这类没有页面上下文的入口）按「非视频页」处理，照常检查。

> **`checkDownloadLink` 命中时仍然建记录，但状态是 `skipped`**：
> 把「你去看看这个视频」的入口放进 options 任务列表：`skipped` 任务带 `followUpUrl`（视频页）与 `filename`
> （`autoCopySaveFileName` 开启时点击通知复制），列表里给「打开视频页」+「强制下载」两颗按钮。
>
> 三条硬约束（每个消费点都要遵守）：
>
> - **不算失败**：不进「重试全部失败」，`RETRY_TASK` 对它会**明确报错**而不是静默重试
>   （重试会重新过一遍 `checkDownloadLink`，命中后又是 `skipped`——那是「点了没反应」的死循环）
> - **不算进行中**：不进角标计数，可以被重新勾选投递（`shared/downloadDedupe.ts` 不对它去重）
> - **不算已结束**：`CLEAR_FINISHED` 不清它，它属于待办；真的开始下载时由 `removeSkippedFor` 自然消失
>
> 想绕过那道门只有一条路：`FORCE_DOWNLOAD { videoId }`（任务列表里 `skipped` 行的「强制下载」）。
> 不去伪造 `pageType: 'video'`——那等于让调用方谎报页面上下文，且页型判定一变就会静默失效。

> **`REMOVE_TASK` 对下载中的任务会先取消下载器**，返回 `{ removed: boolean; cancelled?: boolean }`。
> 只抹记录会留下一个无人看管的下载：`browser` 通道不再回传终态，`aria2` 里的任务会在 5 分钟后
> 被扫描当「外部任务」重新收编（删了又回来）。取消没成功（还在传）时**抛错且不删**，
> 让用户还能看见它在跑。能停掉什么见 [05-features.md](05-features.md#任务状态与队列操作) 的「移除 = 先取消下载器，再删记录」。
> 注意 `CLEAR_FINISHED` 的 `removed` 是**条数**，两者形状不同，不要共用同一个类型。

命名纪律：请求动词/名词分明；`PUSH_*` 类只能由后台发出；所有 payload 可 `structuredClone`（跨 MAIN 世界通道序列化约束）。

> 页内没有扫描接口：遍历入库（`SYNC_ALL_VIDEOS`/`SYNC_SUBSCRIBED`）、MediaCenter 同步、好友审批全部由后台完成，页内扫描没有存在意义；留着只会变成「有接口无实现」的死代码。
>
> `GET_CARD_META` 是页内 UI 的补充查询：关注表 / MediaCenter 映射 / 绝对上传时间都在后台的 IndexedDB 里，页内拿不到；批量一次问完，后台**只读本地库、不连外网**。
>
> **扩展 IndexedDB 只允许后台碰**（`docs/01`）。options 与后台虽然同为扩展 origin、物理上能开库，但分层上禁止——两个写入者会让事务语义与错误归属都无法界定。导入走 `LEGACY_DB_BATCH`（后台校验 + 分块 + 二分隔离），导出走 `DB_EXPORT_PAGE`（按主键分页，因为整表装不下一条消息）。任何新功能需要读写视频库时，加消息，不要 import `background/storage/db`。

## 全兼容监听器写法（桥层唯一暴露点）

业务代码禁止直接碰 `onMessage`，统一通过桥层：

```ts
// src/messaging/hub.ts（后台/ISOLATED 各自实例化,业务只注册 handler）
const pending = new Map<string, (v: unknown) => void>()

export function onMessage<T extends Req>(handler: (req: T) => Promise<unknown>): void {
    browser.runtime.onMessage.addListener((req: T, _sender, sendResponse) => {
        handler(req).then(
            (data) => sendResponse({ ok: true, data } satisfies Res),
            (err) => sendResponse({ ok: false, error: String(err) } satisfies Res)
        )
        return true // 保持通道开启（Chrome 148 前必须；两宿主均支持）
    })
}

export async function send<T extends Req, R = unknown>(req: T): Promise<R> {
    const res = (await browser.runtime.sendMessage(req)) as Res
    if (!res.ok) throw new Error(res.error)
    return res.data as R
}
```

> 该模式在 Chrome 111–147 与 Firefox 上行为完全一致；Chrome 148 原生 promise 监听器落地后仍可运行（`return true` 模式被官方文档声明继续支持）。除非两平台最低版本都 ≥148，否则不切换到 promise-returning 监听器。

## MAIN ⇄ ISOLATED 桥

MAIN 世界无 `browser.*`，只能用页面事件。两个方向：

```ts
// MAIN 世界（src/content/mainWorld.ts 内）
const CH = { up: 'iwara-assistant:up', down: 'iwara-assistant:down' } as const
window.dispatchEvent(new CustomEvent(CH.up, { detail: JSON.stringify({...}) })) // 上行
window.addEventListener(CH.down, (e) => { /* 指令 */ })

// ISOLATED 世界（src/content/isolated.ts 内）
window.addEventListener(CH.up, (e) => {
  const msg = JSON.parse((e as CustomEvent).detail as string) // JSON 层数据可安全过 X-ray
  hub.send(msg) // → background
})
```

设计要点：

1. **payload 走 JSON 字符串**：Firefox X-ray wrappers 下，裸对象/自定义类实例跨世界引用不共享原型链；纯 JSON 最安全。
2. **`CACHE_INJECTION_LIST`（注入最小化配套）**：后台预先算好时间窗命中列表（HELLO 握手后首推、`CONFIG_INVALIDATED` 后重推），MAIN 世界改写 `/videos` 响应时只做纯合并——**页面内零查库、零业务依赖**。
3. **安装时间差兜底**：MAIN 世界 `document_start` 先于 ISOLATED 注入（manifest 数组顺序），ISOLATED 就绪前 MAIN 缓存待发事件（简单的 ready 门闩）；ISOLATED 启动时向 MAIN 发一次 `HELLO` 拉取积压。
4. **版本号协商**：两个 bundle 的 `CONTENT_SCHEMA` 常量在 HELLO 时校验，不匹配（部分更新装了半个扩展）则 ISOLATED 停用功能并提示 reload。

## Background 侧标签页定向

广播（`CONFIG_INVALIDATED`、`CONFIG_SYNC`、`CACHE_INJECTION_LIST`）定向策略：

```ts
async function broadcastToIwaraTabs(msg: Push, filter?: (tab: { id?: number; url?: string }) => boolean) {
    const tabs = await browser.tabs.query({ url: ['*://*.iwara.tv/*'] })
    await Promise.allSettled(tabs.filter(filter ?? (() => true)).map((t) => browser.tabs.sendMessage(t.id!, msg)))
}
```

- `allSettled`：无 content script 的标签页（隐私窗口未授权等）静默失败。
- 不维护自己的 tab 注册表（页面 join/leave 上报）——需要时用 `tabs.query` 现场查询，避免状态漂移。

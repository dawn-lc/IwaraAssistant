/**
 * 下载任务的**全部语义** —— 持久化形态、通道能力、重启对账、取消策略。
 *
 * 放在一个文件里是因为它们是同一个问题的四个面：一条任务「现在是什么」
 * 「还能不能追踪」「重启后还算不算在跑」「删之前要不要先停掉」。拆成多个文件时，
 * 改一处语义（例如新增一种通道）必须记得去另外三个文件补分支，而那正是出错的地方。
 *
 * 视图层（用户该怎么看、该做什么）在 `taskView.ts`，它只依赖这里的类型。
 */
import type { DownloadKind } from '../messaging/protocol'

// ── 持久化形态 ──────────────────────────────────────────────────────────

/**
 * 后续地址是什么（决定任务列表那颗按钮的文案）。
 *
 * 不能从 URL 反推：`/profile/x` 与 `/video/x` 只差一个路径段，而「打开原始地址」
 * 指的外部 embed 域名更是不可枚举。文案要靠**写入时就知道的意图**，不是事后猜。
 */
export type FollowUpKind = 'video' | 'external' | 'author'

export interface QueueTask {
    id: string
    videoId: string
    kind: DownloadKind
    /**
     * 任务状态机 —— 全系统唯一事实源（视图规则见 `shared/taskView.ts`）。
     *
     * - `queued` / `running`：**进行中**。只有这两个状态会阻止重新投递，
     *   因为下载器正在写文件，移出队列会让追踪器失去对账目标。
     * - `complete`：下载器确认收到文件。
     * - `failed`：确实失败了，可重试（重试复用同一条记录）。
     * - `skipped`：**刻意没下载**（不是失败）。目前唯一来源是 `checkDownloadLink`
     *   在简介/评论里发现第三方网盘链接。三条硬约束：
     *   ① 不算失败（不自动重试、不进「重试全部失败」）② 不算进行中（不进角标）
     *   ③ 不阻止重新下载（`shared/downloadDedupe.ts`）
     * - `handed-off`：**已交付但无法追踪**。目前只剩 `others` 通道用它：
     *   它只打开一个直链标签页，把活交给浏览器/外部下载器，之后没有任何回传。
     *   它是终态，但不是「完成」——标成 `complete` 会撒谎（文件可能根本没下成），
     *   还会被去重逻辑当成「已下载」而静默吞掉用户的重下意图。
     */
    status: 'queued' | 'running' | 'failed' | 'complete' | 'skipped' | 'handed-off'
    /** 通道内部引用：aria2 gid / downloads.downloadId / iwaradl vid */
    kindRef?: string
    filename?: string
    /**
     * 下载进度 0~1（后端上报的真实值）。
     *
     * 只有能读到进度的通道会写它：`aria2`（`completedLength / totalLength`）与
     * `iwaradl`（`progress`）。**浏览器通道不写**——`downloads.onChanged` 只给状态变化，
     * 拿不到字节数；为它轮询 `downloads.search` 会让 SW 常驻，收益不值。
     *
     * `undefined` 表示「不知道」，不要用 0 冒充「刚开始」：两者在界面上是不同的事。
     */
    progress?: number
    /** 失败原因、跳过原因等补充信息（不与 filename 混用） */
    detail?: string
    /**
     * 「下一步该去哪」的地址：任务列表里点它直接打开（打开成功即视为待办已处理，见 `taskView.followUpOpenSettles`）。
     *
     * - `skipped`（第三方网盘链接）→ 视频页，用户自己看简介/评论决定用哪个下载方式
     * - 外部嵌入视频 → 原始 embed 地址（重试永远不会成功，链接是唯一有用的信息）
     * - 私有视频（`errors.privateVideo`）→ 作者主页，加为好友（对方通过）是唯一能让解析通过的动作
     * 空值表示这个任务没有可跳转的目标（普通下载任务就没有：文件已经在本机了）。
     */
    followUpUrl?: string
    /** `followUpUrl` 的语义，决定按钮文案（旧记录没有这个字段 → 按 `video` 处理） */
    followUpKind?: FollowUpKind
    /** 自动重试已尝试次数（retry-failed alarm 用；上限见 alarms.ts） */
    attempts?: number
    /** 入队时间（ms）；旧记录可能缺失，UI 需容错 */
    createdAt?: number
    /** 最后状态变更时间（ms）；用于排序与「多久没动」判定 */
    updatedAt?: number
}

// ── 通道能力 ────────────────────────────────────────────────────────────

/**
 * 任务是否匹配一次「按引用查」。
 *
 * ⚠️ **`kindRef` 的命名空间不唯一**，这是本文件里最容易踩的坑：
 * `browser` 存 `downloadId`（数字串）、`aria2` 存 `gid`（hex）、
 * `iwaradl` 存 `vid`、`others` 存 `tabId`（数字串）。
 * 于是 `others` 的 `String(tabId)` 与 `browser` 的 `String(downloadId)`
 * **完全可能相等**（两者的 id 都从小整数开始递增）。
 *
 * 所以按 `kindRef` 查必须同时给 `kind`——否则 `downloads.onChanged` 会把一条
 * 已交付的 others 任务当成自己的下载标成完成/失败。按 `id`（uuid）查不必给。
 */
export function taskMatchesRef(task: QueueTask, ref: { id?: string; kindRef?: string; kind?: DownloadKind }): boolean {
    if (ref.kind !== undefined && task.kind !== ref.kind) return false
    if (ref.id !== undefined) return task.id === ref.id
    if (ref.kindRef !== undefined) return task.kindRef === ref.kindRef
    return false
}

/**
 * 通道是否**追踪下载结果** —— 决定任务何时能离开 `running`。
 *
 * - `browser`：`downloads.onChanged` 回传完成/中断
 * - `aria2`：WebSocket 通知 + 5 分钟扫描对账
 * - `iwaradl`：守护进程的任务 API（`GET /api/tasks`）轮询，1 分钟一次、有活才开
 * - `others`：只打开一个直链标签页，把活交给浏览器/外部下载器
 *
 * `others` **没有任何回传通道**，所以投递即终态 `handed-off`。
 * 但它有个例外：浏览器开始下这个直链时会对上（`downloads.onCreated` 的 `videoid` 参数），
 * 那种情况会被**接管**为普通 browser 下载（`download/adopt.ts`），之后就能正常追踪。
 */
export function channelTracksResult(kind: DownloadKind): boolean {
    switch (kind) {
        case 'browser':
        case 'aria2':
        case 'iwaradl':
            return true
        case 'others':
            return false
    }
}

// ── 重启后的僵尸对账 ────────────────────────────────────────────────────

/**
 * `status` 是**持久化**的，但「它还在跑吗」只存在于进程内存里。进程没了
 * （Chrome MV3 的 SW 30 秒空闲回收 / 浏览器崩溃 / 用户重启），下载器与追踪器
 * 一起消失，而存储里仍写着 `running`：界面永远转圈、挡住重新投递、还按规则不可移除。
 *
 * 这跟好友审批那个坑是同一个：**把运行态写进持久层，就把它进程的生命周期解耦了**。
 *
 * 判定原则是**证据，不是假设**：不能一律判失败（`browser` 下载可能在 SW 挂起期间继续跑，
 * `aria2` 任务可能在远端还活着）。拿不到证据一律 `keep`——宁可再显示一次「进行中」，
 * 也不能把一条其实还在下载的任务标成失败。
 */

/** `browser.downloads.search` 的结果归纳（调用方负责把原始 Item 翻成这四档） */
export type BrowserProbe =
    | { kind: 'alive' }
    | { kind: 'complete' }
    | { kind: 'interrupted'; error?: string }
    /** 下载记录已不在浏览器里（用户取消了、或浏览器重启把它丢了） */
    | { kind: 'missing' }
    /** 查询本身失败（权限/API 异常）——证据不足 */
    | { kind: 'unknown' }

/** aria2 通道的证据：已配置时交给扫描对账，未配置时永远无从追踪 */
export type Aria2Probe = { kind: 'tracked' } | { kind: 'untracked' }

export type StaleReason = 'browserComplete' | 'browserInterrupted' | 'browserMissing' | 'deliveredEarlier' | 'neverDelivered' | 'aria2Untracked'

export type StaleDecision = { kind: 'keep' } | { kind: 'settle'; status: 'complete' | 'failed' | 'handed-off'; reason: StaleReason }

const KEEP: StaleDecision = { kind: 'keep' }

/**
 * 对一条任务给出「重启后它还算不算在跑」的结论。
 *
 * 只处理 `running`：其它状态都是终态或待办，与进程生命周期无关。
 *
 * | 通道      | 证据                                                                 |
 * | --------- | -------------------------------------------------------------------- |
 * | `browser` | `downloads.search({id})` → 在传 / 已完成 / 已中断 / 记录不存在       |
 * | `aria2`   | 交给 `scanAria2TasksAndEnqueue`（远端可能还在跑）；**未配置时无法追踪** |
 * | `iwaradl` | 交给 iwaradl 轮询对账（它有任务 API）；有 `kindRef` 说明当时投递成功过     |
 * | `others`  | 没有回传通道：有 `kindRef` 说明当时交付成功过                           |
 */
export function decideStaleRunning(task: Pick<QueueTask, 'status' | 'kind' | 'kindRef'>, probes: { browser: BrowserProbe; aria2: Aria2Probe }): StaleDecision {
    if (task.status !== 'running') return KEEP

    switch (task.kind) {
        case 'browser':
            switch (probes.browser.kind) {
                case 'alive':
                    // 浏览器仍在写文件，`downloads.onChanged` 迟早会给终态
                    return KEEP
                case 'complete':
                    // 完成事件可能发生在 SW 挂起期间
                    return { kind: 'settle', status: 'complete', reason: 'browserComplete' }
                case 'interrupted':
                    return { kind: 'settle', status: 'failed', reason: 'browserInterrupted' }
                case 'missing':
                    return { kind: 'settle', status: 'failed', reason: 'browserMissing' }
                case 'unknown':
                    return KEEP
            }
        case 'aria2':
            // 远端可能还在跑：已配置时让扫描对账（它会把终态同步回来）。
            // 未配置则我们永远看不到结果，只能如实标成失败，让用户能重试/移除。
            return probes.aria2.kind === 'tracked' ? KEEP : { kind: 'settle', status: 'failed', reason: 'aria2Untracked' }
        case 'iwaradl':
            // 有 kindRef = 当时投递成功过 → 交给 iwaradl 轮询对账（boot 后会立刻跑一轮）
            return !isEmptyRef(task.kindRef) ? KEEP : { kind: 'settle', status: 'failed', reason: 'neverDelivered' }
        case 'others':
            // 没有任何回传通道：`kindRef` 存在说明当时交付成功（拿到了 tabId）。
            // 有据可依 → 交付型终态；没有任何痕迹 → 投递途中就断了，如实记失败。
            return !isEmptyRef(task.kindRef) ? { kind: 'settle', status: 'handed-off', reason: 'deliveredEarlier' } : { kind: 'settle', status: 'failed', reason: 'neverDelivered' }
    }
}

// ── 取消策略（「移除」之前要不要先停下下载器）───────────────────────────

/**
 * 只抹记录会留下一个无人看管的下载：`browser` 通道再也不会回传终态，
 * `aria2` 里那个任务会在 5 分钟后被扫描当「外部任务」重新收编（删了又回来）。
 * 所以「移除」= 先取消下载器、确认停了、再删记录。
 *
 * | 通道      | 停得掉吗                                                        |
 * | --------- | --------------------------------------------------------------- |
 * | `browser` | `downloads.cancel(id)` —— 可以                                  |
 * | `aria2`   | `aria2.remove` + `removeDownloadResult` —— 可以（需已配置端点）  |
 * | `iwaradl` | `DELETE /api/tasks/{vid}` —— **只能删 pending**，运行中返回 409  |
 * | `others`  | **不能**：只是打开了一个直链标签页，关不关是用户的事              |
 *
 * `iwaradl` 的 409 是它自己的设计限制（没有取消运行中任务的能力），不是我们少做了：
 * 那种情况会如实告诉用户「记录已移除，但 iwaradl 仍在下载」。
 */
export type CancelStrategy = 'browser-cancel' | 'aria2-remove' | 'iwaradl-delete' | 'none'

export interface CancelEnv {
    /** aria2 是否配置了端点；没配就不可能存在真正的 aria2 任务 */
    aria2Configured: boolean
    /** iwaradl 是否配置了端点（同理） */
    iwaradlConfigured: boolean
}

export function cancelStrategyOf(task: Pick<QueueTask, 'kind' | 'kindRef'>, env: CancelEnv): CancelStrategy {
    switch (task.kind) {
        case 'browser':
            // downloads.download 返回的是数字 id；脏值（缺 kindRef / 非数字）说明还在投递途中
            return isDownloadId(task.kindRef) ? 'browser-cancel' : 'none'
        case 'aria2':
            // gid 是字符串；没有端点时即使有 gid 也无从下手
            return env.aria2Configured && !isEmptyRef(task.kindRef) ? 'aria2-remove' : 'none'
        case 'iwaradl':
            // 主键是 vid；没配端点时无从下手
            return env.iwaradlConfigured && !isEmptyRef(task.kindRef) ? 'iwaradl-delete' : 'none'
        case 'others':
            return 'none'
    }
}

function isDownloadId(kindRef: string | undefined): boolean {
    if (isEmptyRef(kindRef)) return false
    return Number.isFinite(Number(kindRef))
}

function isEmptyRef(kindRef: string | undefined): boolean {
    return kindRef === undefined || kindRef.trim() === ''
}

/**
 * 站点遍历（全站投稿 / 订阅流）的进度快照 —— 后台写、options 订阅。
 *
 * 为什么从 `background/iwara/pageSync` 挪到这里：这份形状同时被**后台**（`report()` 写）
 * 与**选项页**（`AdvancedTab` 读）使用，而 options 不能 import background（分层铁律）。
 * 里外各写一份 interface 就必然漂移——`AdvancedTab` 曾经手写过一份同名字段，
 * 后台加字段时那边一点提示都没有。
 *
 * 传输方式：`storage.local` + `onChanged` 订阅（不是消息轮询）。
 * 与 MediaCenter 的 `storage.session` 不同：遍历产出的 `message` 是**面向用户的最终结论**
 * （「已遍历 N 页」「N 页失败」），刷新页面后仍值得看到；而 `ProgressBar` 只在 `running` 时渲染，
 * 所以「残留一个 running:true」不会造成永远转圈的进度条（见下）。
 */

export type SyncKind = 'all' | 'subscribed'

export interface SyncState {
    running: boolean
    kind: SyncKind | null
    page: number
    succeeded: number
    failed: number
    /**
     * 用户按下了「暂停」（循环停在页间闸门上，任务仍然活着）。
     *
     * 只有它能让界面把「暂停」按钮换成「继续」：遍历跑起来之后**没有别的信号**能区分
     * 「正在慢慢翻页」与「停在那里等人」。也刻意不落成 `running: false`——那会让按钮变回可点、
     * 用户再点一次就是第二条循环。
     */
    paused?: boolean
    /** 面向用户的进度/结论文案（后台已本地化） */
    message: string
    updatedAt: number
}

export const IDLE_SYNC_STATE: SyncState = {
    running: false,
    kind: null,
    page: 0,
    succeeded: 0,
    failed: 0,
    message: '',
    updatedAt: 0
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * 解析持久层里的快照（脏值返回 `null`）。
 *
 * `null` 的语义是「这份数据不可信」，**不要**回落到空闲态：那份快照可能是
 * 别的代码写坏的中途值，回落到空闲会让进度条闪一下再出现。
 */
export function parseSyncState(raw: unknown): SyncState | null {
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as Record<string, unknown>
    if (typeof record['running'] !== 'boolean') return null
    const kind = record['kind'] === 'all' || record['kind'] === 'subscribed' ? record['kind'] : null
    if (record['running'] && kind === null) return null
    // 只有 true 才算暂停；缺省/脏值一律按「在跑」处理（宁可多显示一颗暂停按钮，也不假装已暂停）
    const paused = record['paused'] === true ? true : undefined
    return {
        running: record['running'],
        kind,
        page: isCount(record['page']) ? Math.max(0, record['page']) : 0,
        succeeded: isCount(record['succeeded']) ? Math.max(0, record['succeeded']) : 0,
        failed: isCount(record['failed']) ? Math.max(0, record['failed']) : 0,
        ...(paused ? { paused } : {}),
        message: typeof record['message'] === 'string' ? record['message'] : '',
        updatedAt: isCount(record['updatedAt']) ? record['updatedAt'] : 0
    }
}

/**
 * 全站遍历的**断点游标**（存 `storage.session`，见 `SYNC_CURSOR_KEY`）。
 *
 * 与 `SyncState` 是两件事：那个面向用户（进度条与结论），这个只描述「从哪一页接着跑」。
 * 只有全站遍历有游标；订阅流**刻意不给**——它由到达 `/videos` 自动触发、最小间隔 5 分钟、
 * 且追平当月就停，接一个游标进去只会让「自动触发」与「接着上次」两套判据互相打架。
 */
export interface SyncCursor {
    /** 下一轮应当从这一页（0 基）开始 */
    nextPage: number
    updatedAt: number
}

/** 解析持久层里的游标（脏值返回 `null` = 「不可信」，调用方按「没有游标」处理） */
export function parseSyncCursor(raw: unknown): SyncCursor | null {
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as Record<string, unknown>
    if (!isCount(record['nextPage']) || record['nextPage'] < 0) return null
    return {
        nextPage: Math.floor(record['nextPage']),
        updatedAt: isCount(record['updatedAt']) ? record['updatedAt'] : 0
    }
}

/**
 * 推进游标：只有**从当前位置连续**处理完的页才能把游标往后推。
 *
 * 为什么不做成「最大已处理页 + 1」：全站遍历某页失败后是 continue（源实现如此，把失败页
 * 留给末尾的补跑轮），于是「第 9 页失败、第 10 页成功」时，按最大页推进会把游标推到第 11 页，
 * 而第 9 页在进程被杀时**永久漏掉**——用户看不到任何提示，库里就是少了一段。
 * 连续推进的代价只是「从最早那个失败页重新跑」，去重会把重复请求的结果吸收掉。
 */
export function advanceSyncCursor(nextPage: number, processed: ReadonlySet<number>): number {
    let next = Math.max(0, Math.floor(nextPage))
    while (processed.has(next)) next++
    return next
}

/** 没有游标时的取值：`nextPage === 0` 表示「从头开始」，与「游标存在且指回第 0 页」在行为上等价 */
export const IDLE_SYNC_CURSOR: SyncCursor = { nextPage: 0, updatedAt: 0 }

/**
 * 给 `useStorageSnapshot` 用的解析器：**永不返回 `null`**。
 *
 * 那个 hook 把 `null` 当「这份值不可信，保留上一份」，而游标**合法地可以不存在**
 * （跑完就被删掉）。用 `parseSyncCursor` 直接接进去的话，遍历跑完、游标被删除时
 * `onChanged` 会解析成 `null` 而被丢弃，界面就会一直显示「上次停在第 N 页」的过期提示。
 */
export function parseSyncCursorOrIdle(raw: unknown): SyncCursor {
    return parseSyncCursor(raw) ?? IDLE_SYNC_CURSOR
}

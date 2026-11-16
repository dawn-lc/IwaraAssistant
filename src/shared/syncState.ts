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
    return {
        running: record['running'],
        kind,
        page: isCount(record['page']) ? Math.max(0, record['page']) : 0,
        succeeded: isCount(record['succeeded']) ? Math.max(0, record['succeeded']) : 0,
        failed: isCount(record['failed']) ? Math.max(0, record['failed']) : 0,
        message: typeof record['message'] === 'string' ? record['message'] : '',
        updatedAt: isCount(record['updatedAt']) ? record['updatedAt'] : 0
    }
}

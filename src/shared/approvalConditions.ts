/**
 * 好友请求审批条件 —— 纯数据 + 无副作用谓词（原 core/approvalConditions.ts）
 *
 * 放在 `shared/` 而不是 `background/`：**两边共同消费**该表——options 渲染条件列表（只取 id，
 * 文案在字典 `condition.*`）、后台编排审批时真正执行 `test()`。
 * 放在 background 会让 options 反向依赖后台实现层，也会让「哪些条件存在」这件事
 * 在两侧各写一份。
 *
 * 组合模式 any = 任一满足即批准；all = 全部满足才批准。
 */

export interface ApprovalContext {
    /** 请求发起者的用户资料（含 followedBy / following / premium / status / seenAt / createdAt） */
    user: Iwara.User
    /** 评论证据：sourceKey（'profile' | 'forum:<id>'）→ userId → 评论文本列表 */
    commentEvidence: Map<string, Map<string, string[]>>
    /** 论坛帖证据帖 ID（为空时 commentedForumThread 恒不满足） */
    evidenceThreadId: string
}

/** 条件 id 的字面量联合：与 `shared/locales/*.json` 的 `condition.*` 键逐一对应 */
export type ApprovalConditionId = 'always' | 'followedBy' | 'following' | 'premium' | 'recentlyActive' | 'established' | 'active' | 'commentedProfile' | 'commentedForumThread'

export interface ApprovalCondition {
    /** 与 `shared/locales/*.json` 的 `condition.<id>` 对应（文案在字典里，不在这里） */
    id: ApprovalConditionId
    /** 标记需要批级抓取评论证据 */
    needsComments?: boolean
    test: (context: ApprovalContext) => boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
/** 「近期活跃」窗口（天）。文案 `condition.recentlyActive` 的 `{days}` 由它填 —— 数值只在这里写一次 */
export const ACTIVE_WINDOW_DAYS = 30
/** 「账号已建立」阈值（天）。文案 `condition.established` 的 `{days}` 由它填 */
export const ESTABLISHED_DAYS = 30

function daysSince(value: string | undefined): number {
    if (!value) return Number.POSITIVE_INFINITY
    const time = new Date(value).getTime()
    if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY
    return (Date.now() - time) / DAY_MS
}

function commentedIn(evidence: Map<string, Map<string, string[]>>, sourceKey: string, userId: string): boolean {
    const users = evidence.get(sourceKey)
    if (!users) return false
    const comments = users.get(userId)
    return Array.isArray(comments) && comments.length > 0
}

export const BUILTIN_APPROVAL_CONDITIONS: ReadonlyArray<ApprovalCondition> = [
    { id: 'always', test: () => true },
    { id: 'followedBy', test: ({ user }) => user.followedBy === true },
    { id: 'following', test: ({ user }) => user.following === true },
    { id: 'premium', test: ({ user }) => user.premium === true },
    {
        id: 'recentlyActive',
        test: ({ user }) => daysSince(user.seenAt) <= ACTIVE_WINDOW_DAYS
    },
    {
        id: 'established',
        test: ({ user }) => daysSince(user.createdAt) >= ESTABLISHED_DAYS
    },
    { id: 'active', test: ({ user }) => !user.status || user.status === 'active' },
    {
        id: 'commentedProfile',
        needsComments: true,
        test: ({ user, commentEvidence }) => commentedIn(commentEvidence, 'profile', user.id)
    },
    {
        id: 'commentedForumThread',
        needsComments: true,
        test: ({ user, commentEvidence, evidenceThreadId }) => evidenceThreadId !== '' && commentedIn(commentEvidence, `forum:${evidenceThreadId}`, user.id)
    }
]

export function getApprovalCondition(id: string): ApprovalCondition | undefined {
    return BUILTIN_APPROVAL_CONDITIONS.find((condition) => condition.id === id)
}

/**
 * 条件文案的插值参数。
 *
 * 存在的理由：`condition.recentlyActive` / `condition.established` 的文案里带 `{days}`，
 * 而 i18next 对未提供的占位符是**原样保留**的（单测有专门一条锁这个行为）。
 * 界面若只写 `t('condition.' + id)`，用户看到的就是字面的「对方 {days} 天内活跃过」。
 * 数字与判据同源：两个窗口常量就在本文件，改一处不会让文案和实际判定脱节。
 */
export function approvalConditionParams(id: string): Record<string, number> | undefined {
    switch (id) {
        case 'recentlyActive':
            return { days: ACTIVE_WINDOW_DAYS }
        case 'established':
            return { days: ESTABLISHED_DAYS }
        default:
            return undefined
    }
}

/** 是否有任一启用条件需要评论证据（决定审批批是否需要抓评论） */
export function needsCommentEvidence(ids: readonly string[]): boolean {
    return ids.some((id) => getApprovalCondition(id)?.needsComments === true)
}

/**
 * 判定一个请求是否满足启用条件。
 * - 无可用条件 → false（未配置选择时不误批）
 * - any：任一满足；all：全部满足
 */
export function checkApprovalConditions(ids: readonly string[], mode: 'any' | 'all', context: ApprovalContext): boolean {
    const conditions = ids.map((id) => getApprovalCondition(id)).filter((condition): condition is ApprovalCondition => condition !== undefined)
    if (conditions.length === 0) return false
    return mode === 'all' ? conditions.every((condition) => condition.test(context)) : conditions.some((condition) => condition.test(context))
}

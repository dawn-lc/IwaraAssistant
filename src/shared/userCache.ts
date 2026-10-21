/**
 * 关注/好友缓存的**写入判定**（纯函数，无 IDB，可单测）。
 *
 * ## 为什么需要
 *
 * `follows` / `friends` 沿用源项目的 schema：主键 `id`，并且 `username` 上有**唯一索引**。
 * 这带来一个源项目也没处理的死角：
 *
 * - 站点允许改名、也可能出现「同名不同账号」（旧账号注销后昵称被重新注册）；
 * - `put` 的替换是按**主键 `id`** 做的，所以「同名但不同 id」的旧记录不会被覆盖；
 * - 于是新记录一写入就撞唯一索引 → `ConstraintError`。
 *
 * 用户实测（Firefox）：`parseVideoFull` 里那两行关注/好友写入抛错，被外层包成
 * `VideoParseError`，任务详情显示「重试解析失败: A mutation operation in the transaction
 * failed because a constraint was not satisfied.」——**视频数据其实已经完整拿到**，
 * 却因为一张派生缓存表拒绝一行而整个下载失败，且重试永远复现。
 *
 * 判定之所以单独抽出来：能不能删旧记录，取决于「同名但不同 id」这个条件。
 * 同名同 id 还报冲突说明是别的问题，删数据只会掩盖故障。
 */

/** 同名冲突里已有的那条记录 */
export interface ExistingUsernameOwner {
    id?: unknown
}

/**
 * 库里那条同名记录是不是**过期缓存**（可以删掉让新记录写入）。
 *
 * 判据：存在、id 是非空字符串、且与传入的 id 不同。
 * 同名同 id 时返回 false —— 那是同一个用户，`put` 本该覆盖，还撞唯一索引说明有别的问题。
 */
export function isStaleUsernameOwner(existing: ExistingUsernameOwner | undefined, incomingId: string): boolean {
    if (!existing) return false
    const existingId = existing.id
    if (typeof existingId !== 'string' || existingId === '') return false
    return existingId !== incomingId
}

/**
 * 一次关注/好友缓存写入的结果。
 *
 * - `written`：正常写入
 * - `repaired`：撞了同名唯一索引，删掉过期记录后写入成功
 * - `failed`：无法自愈（调用方决定是记日志还是继续）
 */
export type UserCacheWriteOutcome = 'written' | 'repaired' | 'failed'

/** 写入时需要的存储能力（真实实现是 IndexedDB，单测用假实现） */
export interface UserCacheStore {
    put(user: Iwara.User): Promise<void>
    getByUsername(username: string): Promise<ExistingUsernameOwner | undefined>
    remove(id: string): Promise<void>
    /** 错误是否为唯一索引冲突（浏览器之间文案不同，实现方按 `error.name` 判断） */
    isConstraintViolation(error: unknown): boolean
}

/**
 * 写入一条关注/好友记录，撞同名唯一索引时**先清过期记录再重写一次**。
 *
 * 只重试一次：删完还撞说明不是「同名不同 id」这种可自愈的情况，继续重试只会空转。
 */
export async function putUserCacheRecord(store: UserCacheStore, user: Iwara.User): Promise<UserCacheWriteOutcome> {
    try {
        await store.put(user)
        return 'written'
    } catch (error) {
        if (!store.isConstraintViolation(error)) return 'failed'
        const username = user.username
        // 索引键必须是字符串；脏数据（缺失/非字符串）无法走索引查询，只能如实失败
        if (typeof username !== 'string' || username === '') return 'failed'
        const existing = await store.getByUsername(username).catch(() => undefined)
        if (!isStaleUsernameOwner(existing, user.id)) return 'failed'
        const staleId = existing?.id as string
        try {
            await store.remove(staleId)
            await store.put(user)
            return 'repaired'
        } catch {
            return 'failed'
        }
    }
}

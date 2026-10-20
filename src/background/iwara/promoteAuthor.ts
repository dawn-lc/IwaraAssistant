/**
 * 「关注扩展作者」的完整流程 —— 状态 → 判定（纯函数）→ 执行（网络）。
 *
 * 为什么判定要单独做成纯函数并上测试：该功能**默认开启**，而 `boot()` 在每次 service worker
 * 唤醒时都会执行（Chrome SW 空闲约 30 秒就挂起）。若不加闸门，每 30 秒就会请求一次站点 API。
 * 判定写错，代价是持续骚扰站点 + 用户流量。
 *
 * 执行部分用到 `browser.storage` 与 `fetch`，但**顶层无副作用**，
 * 所以单测直接 import 本文件不会触碰任何全局。
 */
import { apiUrl } from '../../shared/site'
import { PROMOTE_AUTHOR_STATE_KEY } from '../../shared/storageKeys'
import { getAuth, isLoggedIn } from './auth'
import { addFriend, followUser, getLocalUser } from './interactions'

/** 扩展作者（源项目同样写死 `dawn`）：关注谁本就由扩展自身决定，不做成配置项 */
export const PROMOTE_AUTHOR = 'dawn'

/** 失败后的重试间隔：既避免每次唤醒都重试，又不至于永远放弃 */
export const PROMOTE_RETRY_MS = 24 * 60 * 60 * 1000

/** 持久状态（storage.local，见 shared/storageKeys 的 PROMOTE_AUTHOR_STATE_KEY） */
export interface PromoteAuthorState {
    /** 已确定完成：已关注 + 已是好友（或作者本人使用） */
    done?: boolean
    /** 上次尝试的时间戳；只在失败时写，用于节流重试 */
    lastAttemptAt?: number
}

/**
 * 现在是否该尝试「关注作者」。
 *
 * - `done` 一旦为真永不再试（零网络）；
 * - 上次尝试失败不满 24 小时 → 跳过；
 * - 其余情况（首次、或距上次失败已超 24 小时）→ 尝试。
 *
 * 注意：**未登录的判定不在这里**——那需要读 storage 解 JWT（`isLoggedIn()`），
 * 属于更贵的检查，排在纯本地状态判定之后。
 */
export function shouldAttemptPromote(state: PromoteAuthorState | undefined, now: number): boolean {
    if (state?.done === true) return false
    if (typeof state?.lastAttemptAt === 'number' && now - state.lastAttemptAt < PROMOTE_RETRY_MS) return false
    return true
}

/** 合并写入的下一个状态：`done` 只增不减（已完成的人不会再触发请求） */
export function nextPromoteState(previous: PromoteAuthorState | undefined, done: boolean, now: number): PromoteAuthorState {
    return { done: previous?.done === true || done, lastAttemptAt: now }
}

// ── 执行 ────────────────────────────────────────────────────────────────

async function readState(): Promise<PromoteAuthorState | undefined> {
    return (await browser.storage.local.get(PROMOTE_AUTHOR_STATE_KEY))[PROMOTE_AUTHOR_STATE_KEY] as PromoteAuthorState | undefined
}

/** 记一次尝试的结果。**只有"确定完成"才传 true** —— 关注成功但加好友失败时明天再补 */
async function markAttempt(done: boolean): Promise<void> {
    try {
        const previous = await readState()
        await browser.storage.local.set({ [PROMOTE_AUTHOR_STATE_KEY]: nextPromoteState(previous, done, Date.now()) })
    } catch {
        // 状态写失败只意味着下次唤醒多重试一次，不影响任何功能
    }
}

/**
 * 关注/添加作者为好友（原 features/onboarding.ts promoteAuthor 语义）。
 *
 * **默认开启，所以必须做成"一次性"**：`boot()` 在每次 service worker 唤醒时都会执行，
 * 而 `getLocalUser()` / `/profile/:user` 都是真实网络请求。三层闸门，逐层变贵：
 * 1. `shouldAttemptPromote` → 已完成 / 24h 内失败过，直接返回；
 * 2. 未登录 → 不做任何请求（`isLoggedIn()` 只解本地 JWT，零网络），也不写状态；
 * 3. 只有通过了上面两层才真的打接口。
 */
export async function promoteAuthor(): Promise<void> {
    try {
        if (!shouldAttemptPromote(await readState(), Date.now())) return
        if (!(await isLoggedIn())) return // 未登录：不打接口也不写状态，登录后第一次唤醒就会尝试
        const me = await getLocalUser()
        if (!me) {
            await markAttempt(false)
            return
        }
        if (me.username === PROMOTE_AUTHOR) {
            await markAttempt(true) // 作者本人使用：无需关注自己
            return
        }
        const response = await fetch(apiUrl(`/profile/${PROMOTE_AUTHOR}`), { headers: await getAuth() })
        if (!response.ok) {
            await markAttempt(false)
            return
        }
        const profile = (await response.json()) as Iwara.Profile
        const author = profile.user
        const followed = author.following || (await followUser(author.id))
        const friended = author.friend || (await addFriend(author.id))
        await markAttempt(followed && friended)
    } catch {
        // 作者关注失败不阻塞任何流程
    }
}

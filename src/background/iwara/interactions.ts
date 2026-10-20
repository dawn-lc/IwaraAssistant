/**
 * 社交互动 API 客户端 —— 原 network/interactions.ts 的后台移植
 * 关注 / 点赞 / 好友请求（纯 HTTP；失败以 false 表达，由调用方决定提示）
 */
import { apiUrl } from '../../shared/site'
import { hasMorePages } from '../../shared/paging'
import { getAuth, isLoggedIn, verifyLogin } from './auth'

/** 关注指定用户（POST /user/:id/followers） */
export async function followUser(userId: string): Promise<boolean> {
    try {
        const response = await fetch(apiUrl(`/user/${userId}/followers`), { method: 'POST', headers: await getAuth() })
        return response.ok
    } catch {
        return false
    }
}

/** 点赞视频（POST /video/:id/like） */
export async function likeVideo(videoId: string): Promise<boolean> {
    try {
        const response = await fetch(apiUrl(`/video/${videoId}/like`), { method: 'POST', headers: await getAuth() })
        return response.ok
    } catch {
        return false
    }
}

/** 加好友（POST /user/:id/friends） */
export async function addFriend(userId: string): Promise<boolean> {
    try {
        const response = await fetch(apiUrl(`/user/${userId}/friends`), { method: 'POST', headers: await getAuth() })
        return response.ok
    } catch {
        return false
    }
}

/**
 * 好友请求列表一次最多翻多少页（每页约 20 条 → 上限约 640 条）。
 * 超出时**如实上报** `truncated`，不静默丢弃（见 fetchAllFriendRequests）。
 */
export const MAX_FRIEND_REQUEST_PAGES = 32

export interface FriendRequestsResult {
    /** 真正「收到的」请求（已剔除自己发起的那些） */
    requests: Iwara.FriendRequestEntry[]
    /** 服务端声明的总条数（未提供时为 0） */
    total: number
    /** 是否因为页数上限而没能拉全 */
    truncated: boolean
}

/**
 * 分页拉取收到的全部好友请求（原 fetchAllFriendRequests；`entry.user.id !== meId` 才是"收到的"）。
 *
 * 终止判据按可靠性排序，三条缺一不可：
 * 1. **空页** —— 最硬的证据，任何分页实现都成立；
 * 2. **短页**（条数 < `limit`）—— 标准分页约定；
 * 3. **累计条数已达 `count`** —— `limit` 缺失时的兜底。
 *
 * 旧实现只写了 2，且把 `limit` 缺失（0）当成「本页条数」处理：那时
 * `results.length < limit` 永远为假，于是一路白翻满 32 页才停。加上 1 和 3 后，
 * 即使服务端两个字段都不给，也只在真正有空页时才继续。
 */
export async function fetchAllFriendRequests(meId: string, maxPages = MAX_FRIEND_REQUEST_PAGES): Promise<FriendRequestsResult> {
    const requests: Iwara.FriendRequestEntry[] = []
    let total = 0
    let pulled = 0
    let pages = 0
    let lastPageFull = false

    for (let page = 0; page < maxPages; page++) {
        const response = await fetch(apiUrl(`/user/${meId}/friends/requests`, new URLSearchParams({ page: String(page) })), {
            method: 'GET',
            headers: await getAuth()
        })
        if (!response.ok) throw new Error(`fetchFriendRequests failed: HTTP ${response.status}`)
        const data = (await response.json()) as Iwara.FriendRequestsPage
        const results = data.results ?? []
        pages += 1
        if (Number.isFinite(data.count) && data.count >= 0) total = data.count
        pulled += results.length
        requests.push(...results.filter((entry) => entry.user.id !== meId))

        if (!hasMorePages({ length: results.length, limit: data.limit, total, pulled })) {
            lastPageFull = false
            break
        }
        lastPageFull = true
    }

    return { requests, total, truncated: lastPageFull && pages >= maxPages }
}

/**
 * 当前登录用户的 Promise 缓存（源 `network/users.ts` 的 `localUserPromise`）。
 *
 * 必要性：SW 里一次通知/一次审批可能连着调好几次 `getLocalUser()`，而每次都是真实网络往返；
 * 缓存 **Promise 本身**（不是结果）才能让并发调用共用同一个在途请求，而不是各自发一遍。
 */
let localUserPromise: Promise<Iwara.User | null> | null = null

/**
 * 获取当前登录用户（未登录/失败返回 null）。
 *
 * - 缺省：`isLoggedIn()` 快检 + 缓存复用
 * - `{ refresh: true }`：绕过缓存实时拉取并回写缓存（长作业入口用来确认在线与最新 profile）
 */
export function getLocalUser(options: { refresh?: boolean } = {}): Promise<Iwara.User | null> {
    if (options.refresh || localUserPromise === null) {
        localUserPromise = (async () => {
            try {
                if (options.refresh ? !(await verifyLogin()) : !isLoggedIn()) return null
                const response = await fetch(apiUrl('/user'), { method: 'GET', headers: await getAuth() })
                if (!response.ok) return null
                return ((await response.json()) as Iwara.LocalUser).user ?? null
            } catch {
                return null
            }
        })()
        // 失败不应把 null 永久钉在缓存里：下一次调用有机会重新探测。
        // （源项目不清理缓存，但页面生命周期短、后台 SW 会反复唤醒，这里收紧一档更安全）
        void localUserPromise.then((user) => {
            if (user === null) localUserPromise = null
        })
    }
    return localUserPromise
}

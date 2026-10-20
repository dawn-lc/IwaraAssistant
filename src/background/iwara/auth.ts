/**
 * 认证与请求头 —— 原 network/auth.ts 的后台移植
 *
 * 与原版差异（平台边界）：
 * - localStorage → storage.local 的 auth:access / auth:refresh 键（ISOLATED INGEST_AUTH 上行）
 * - document.cookie → ISOLATED INGEST_COOKIE 上行的最近快照（HttpOnly 本就不可见）
 * - Referer 为 fetch 禁改头，SW 里无法设置，省略（服务端不依赖）
 * - X-Site 固化 www.iwara.tv（无 location 上下文）
 */
import { apiUrl, SITE_HOST } from '../../shared/site'
import { isNullOrUndefined, prune } from '../../shared/strings'
import { RATING_KEY } from '../../shared/storageKeys'
import { getXVersion } from './xVersion'

const ACCESS_KEY = 'auth:access'
const REFRESH_KEY = 'auth:refresh'
const COOKIE_KEY = 'auth:pageCookie'

interface StoredToken {
    [key: string]: string | undefined
}

async function readToken(key: string): Promise<string | undefined> {
    const stored = (await browser.storage.local.get([ACCESS_KEY, REFRESH_KEY])) as StoredToken
    return stored[key]
}

async function writeToken(key: string, token: string): Promise<void> {
    await browser.storage.local.set({ [key]: token })
}

export async function setPageCookie(cookie: string): Promise<void> {
    await browser.storage.local.set({ [COOKIE_KEY]: cookie })
}

/**
 * ISOLATED 上行的 token（`INGEST_AUTH`）—— `kind` 只能是 access / refresh。
 *
 * 键名由这里决定（`auth:<kind>`），而不是调用方拼：拼错的键不会报错，
 * 只会让 `readToken` 永远读不到，表现为「明明登录了但请求全 401」。
 */
export async function recordAuthToken(kind: 'access' | 'refresh', token: string): Promise<{ saved: true }> {
    await writeToken(`auth:${kind}`, token)
    return { saved: true }
}

/**
 * ISOLATED 上行的页面 cookie 与内容分级偏好（`INGEST_COOKIE`）。
 *
 * 分级偏好**取不到就不写**：把「没读到」误记成「用户选了空」会让列表遍历少一大截。
 */
export async function recordPageCookie(payload: { cookie: string; rating?: unknown }): Promise<{ saved: true }> {
    // cookie 供 aria2/iwaradl 拼请求头（HttpOnly 本就不可见，无隐私面扩大）
    await setPageCookie(payload.cookie)
    if (typeof payload.rating === 'string' && payload.rating !== '') {
        await browser.storage.local.set({ [RATING_KEY]: payload.rating })
    }
    return { saved: true }
}

export async function getPageCookie(): Promise<string> {
    return ((await browser.storage.local.get(COOKIE_KEY))[COOKIE_KEY] as string | undefined) ?? ''
}

/** JWT payload 解码（原 getPlayload 的 base64url 兼容版） */
function decodeJwtPayload(token: string): Record<string, unknown> {
    const segment = token.split('.')[1]
    if (!segment) throw new Error('invalid jwt payload')
    const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)))) as Record<string, unknown>
}

/**
 * 是否已登录（原 isLoggedIn 语义）：refresh token 必须是未过期的 refresh_token 型 JWT
 */
export async function isLoggedIn(): Promise<boolean> {
    const refreshToken = await readToken(REFRESH_KEY)
    if (isNullOrUndefined(refreshToken) || refreshToken === '') return false
    try {
        const payload = decodeJwtPayload(refreshToken)
        if (typeof payload['type'] === 'string' && payload['type'] !== 'refresh_token') return false
        if (typeof payload['exp'] === 'number' && payload['exp'] * 1000 <= Date.now()) return false
        return true
    } catch {
        return false // 非 JWT（异常写入/损坏数据）视为未登录
    }
}

/** 远端登录校验结果缓存时长（毫秒；源 `LOGIN_VERIFY_TTL` = 60s） */
const LOGIN_VERIFY_TTL = 60 * 1000
let lastVerifyTime = 0
let lastVerifyResult = false

/**
 * 通过 API 远端校验登录态（源 `verifyLogin`）。
 *
 * 同步的 `isLoggedIn()` 只能证明本地存在未过期的 JWT，发现不了服务端吊锖/凭据轮换；
 * 这里用 `GET /user` 实测：
 * - accessToken 失效时先刷新 token 再重试一次；
 * - 最终仍失败（401）则清理本地凭据，避免后续请求反复携带失效 token；
 * - 网络异常时**不清理**凭据（无法断定失效），按未验证处理。
 *
 * 结果缓存 60 秒；`force = true` 时跳过缓存强制校验（启动/长作业入口用）。
 *
 * 与源差异：源直接读写 `localStorage` 与 `config.authorization`；
 * 扩展里 token 在 `storage.local` 的 `auth:` 键下，没有 config.authorization 这一路。
 */
export async function verifyLogin(force = false): Promise<boolean> {
    const now = Date.now()
    if (!force && now - lastVerifyTime < LOGIN_VERIFY_TTL) return lastVerifyResult

    const cache = (result: boolean): boolean => {
        lastVerifyResult = result
        lastVerifyTime = Date.now()
        return result
    }

    if (!(await isLoggedIn())) return cache(false)

    let response: Response | undefined
    try {
        response = await fetch(apiUrl('/user'), { method: 'GET', headers: await getAuth() })
        if (!response.ok) {
            // accessToken 可能已过期：刷新后重试一次
            await refreshAccessToken().catch(() => undefined)
            response = await fetch(apiUrl('/user'), { method: 'GET', headers: await getAuth() })
        }
    } catch {
        // 网络异常：无法断定凭据失效，不清本地 token，按未验证处理
        return cache(false)
    }

    if (!response.ok) {
        // 刷新后仍被拒绝：凭据已彻底失效，清理本地状态
        console.warn('[iwara-assistant] login credential rejected by server, clearing local credentials')
        await browser.storage.local.remove([ACCESS_KEY, REFRESH_KEY])
    }
    return cache(response.ok)
}

/** 刷新 accessToken（原 refreshToken 移植；失败回退旧 access token） */
export async function refreshAccessToken(): Promise<string> {
    const refreshToken = await readToken(REFRESH_KEY)
    if (isNullOrUndefined(refreshToken) || refreshToken === '') {
        throw new Error('Refresh token failed: no refresh token')
    }
    const oldAccessToken = await readToken(ACCESS_KEY)
    const res = await fetch(apiUrl('/user/token'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${refreshToken}` }
    })
    if (!res.ok) throw new Error(`Refresh token failed with status: ${res.status}`)
    const { accessToken } = (await res.json()) as { accessToken?: string }
    if (!accessToken) throw new Error('No access token in response')
    if (oldAccessToken !== accessToken) await writeToken(ACCESS_KEY, accessToken)
    return accessToken
}

async function getAccessToken(): Promise<string> {
    return (await readToken(ACCESS_KEY)) ?? (await refreshAccessToken())
}

/**
 * 请求认证头（原 getAuth 移植）。url 提供时计算 X-Version（文件请求签名）。
 * 注意：键名维持原实现的 'Cooike'（历史拼写，aria2/iwaradl 下游无影响且保持对拍一致）。
 */
export async function getAuth(url?: string): Promise<Record<string, string>> {
    return prune({
        Accept: 'application/json',
        Cooike: await getPageCookie(),
        Authorization: (await isLoggedIn()) ? `Bearer ${await getAccessToken()}` : undefined,
        'X-Version': !isNullOrUndefined(url) && url !== '' ? await getXVersion(url) : undefined,
        'X-Site': SITE_HOST
    }) as Record<string, string>
}

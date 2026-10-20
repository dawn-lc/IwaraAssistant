/**
 * 播放列表操作 —— 原 network/playlists.ts 的后台移植
 * 所有者判定 + 删除条目（DELETE /playlist/:id/:videoId）
 */
import { apiUrl } from '../../shared/site'
import { i18n } from '../../shared/i18n'
import { getAuth } from './auth'
import { getLocalUser } from './interactions'

/**
 * 播放列表所有者 ID（失败返回空串）。
 *
 * 缓存**单个** `{playlistId, promise}`（源 `playlistOwnerPromise` 同款语义）：
 * 一次批量操作会对同一列表的每个视频各问一遍所有者，缓存 Promise 让它们共用同一在途请求。
 * 只留最近一个列表是有意的——同时只有当前页面那一个列表在被批量处理，
 * 做无界 Map 只会在长开的后台里慢慢堆积过期条目。
 */
let playlistOwnerPromise: { playlistId: string; promise: Promise<string> } | null = null

export function getPlaylistOwnerId(playlistId: string): Promise<string> {
    if (playlistOwnerPromise?.playlistId !== playlistId) {
        playlistOwnerPromise = {
            playlistId,
            promise: (async () => {
                try {
                    const response = await fetch(apiUrl(`/playlist/${playlistId}`), { method: 'GET', headers: await getAuth() })
                    if (!response.ok) return ''
                    return ((await response.json()) as Iwara.Playlist).playlist?.user?.id ?? ''
                } catch {
                    return ''
                }
            })()
        }
        // 取到空串（网络失败/无权限）不应永久钉在缓存里：清掉，下次调用重新探测
        void playlistOwnerPromise.promise.then((ownerId) => {
            if (ownerId === '' && playlistOwnerPromise?.playlistId === playlistId) playlistOwnerPromise = null
        })
    }
    return playlistOwnerPromise.promise
}

/** 当前用户是否该播放列表所有者 */
export async function isPlaylistOwner(playlistId: string): Promise<boolean> {
    const [me, ownerId] = await Promise.all([getLocalUser(), getPlaylistOwnerId(playlistId)])
    return me !== null && ownerId !== '' && me.id === ownerId
}

/** 从播放列表移除单个视频 */
export async function removePlaylistVideo(playlistId: string, videoId: string): Promise<boolean> {
    try {
        const response = await fetch(apiUrl(`/playlist/${playlistId}/${videoId}`), {
            method: 'DELETE',
            headers: await getAuth()
        })
        return response.ok
    } catch {
        return false
    }
}

export interface RemovePlaylistResult {
    removed: number
    failed: number
    error?: string
}

/** 批量移除（页内菜单触发；非所有者直接拒绝） */
export async function removePlaylistItems(playlistId: string, videoIds: string[]): Promise<RemovePlaylistResult> {
    const result: RemovePlaylistResult = { removed: 0, failed: 0 }
    if (!(await isPlaylistOwner(playlistId))) {
        result.error = i18n.t('notify.notPlaylistOwner')
        return result
    }
    for (const videoId of videoIds) {
        if (await removePlaylistVideo(playlistId, videoId)) result.removed++
        else result.failed++
        await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return result
}

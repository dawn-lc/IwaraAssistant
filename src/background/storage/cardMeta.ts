/**
 * 卡片元数据 —— 页内复选框 / 角标 / 删除按钮的判定依据。**只读本地库，不连外网**。
 *
 * 与 `cacheList.ts` 是一对：都是「给页面准备的数据快照」。归在 `storage/` 而不是
 * `download/` —— 它不下任何东西，只把库里的事实拼成视图模型。
 *
 * 对齐源项目 `ui/widgets/checkbox.ts`：
 * - `.follow`：`db.getFollowByUsername(author)?.following`
 * - `.downloaded`：配置了 MediaCenter 且 `idmap` 有该视频
 * - `videoUploadTime`：库里的绝对 UploadTime（DOM 只有相对时间，不能伪造）
 * - `.deleteButton`：播放列表页 + 当前用户是所有者
 */
import type { CardMeta, CardMetaQuery, CardMetaResult } from '../../messaging/protocol'
import { isPlaylistOwner } from '../iwara/playlists'
import { getConfig } from './configStore'
import { db } from './db'

export async function getCardMeta(payload: { cards: CardMetaQuery[]; playlistId?: string }): Promise<CardMetaResult> {
    const config = getConfig()
    const mediaCenterEnabled = config.mediaCenterApi.trim() !== '' && config.mediaCenterApiKey.trim() !== ''
    const ids = payload.cards.map((card) => card.id)
    const videos = ids.length > 0 ? await db.getVideosByIds(ids) : []
    const videoById = new Map<string, (typeof videos)[number]>()
    for (const video of videos) videoById.set(video.ID, video)

    const items = await Promise.all(
        payload.cards.map(async (card): Promise<CardMeta> => {
            const [follow, idmap] = await Promise.all([card.author ? db.getFollowByUsername(card.author) : Promise.resolve(undefined), mediaCenterEnabled ? db.getIdmap(card.id) : Promise.resolve(undefined)])
            const meta: CardMeta = {
                id: card.id,
                following: follow?.following === true,
                downloaded: idmap !== undefined
            }
            const record = videoById.get(card.id)
            if (record) {
                // 对齐源 ui/widgets/checkbox.ts 的取值优先级与来源：
                // `hasFullInfo = Type === 'full' || Type === 'partial'`
                if (record.Type === 'partial' || record.Type === 'full') {
                    if (record.Title) meta.name = record.Title
                    if (record.Alias) meta.alias = record.Alias
                    if (record.Author) meta.author = record.Author
                    meta.uploadTime = record.UploadTime
                } else {
                    // 源实现：非 full/partial 时退回 `RAW.updatedAt`（没有再退 0）
                    const uploadTime = new Date(record.RAW?.updatedAt ?? 0).getTime()
                    if (Number.isFinite(uploadTime) && uploadTime > 0) meta.uploadTime = uploadTime
                }
            }
            return meta
        })
    )

    const canDeletePlaylistItem = payload.playlistId ? await isPlaylistOwner(payload.playlistId) : false
    return { items, canDeletePlaylistItem }
}

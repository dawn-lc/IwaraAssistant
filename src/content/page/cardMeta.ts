/**
 * 卡片角标 / 上传时间 / 每卡片删除按钮（对齐源 `ui/widgets/checkbox.ts`）。
 *
 * 这些信息只在后台的本地库里（关注表 / idmap / videos），页内拿不到，
 * 所以批量问一次 `GET_CARD_META`（后台只读本地库，不连外网）。
 *
 * 重试策略值得单独说明：`uploadTime` 只能来自视频库，而卡片渲染往往**早于**
 * `INGEST_VIDEO_INFO` 入库完成。所以缺 `uploadTime` 时留有限次重试（入库完成后补上），
 * 其余字段（following/downloaded）首轮就是定论，不必再查。
 */
import { i18n } from '../../shared/i18n'
import { videoIdFromCard } from '../../shared/pageType'
import type { CardMeta, CardMetaResult } from '../../messaging/protocol'
import { send } from '../../messaging/hub'
import { META_MARKER_ATTR } from '../markers'
import { CARD_SELECTOR, CHECKBOX_CLASS, CHECKBOX_ID_ATTR, authorOfCard, badge, playlistIdFromPath } from './dom'

/** 已查询过的卡片 ID（避免同一卡片重复请求） */
const metaApplied = new Set<string>()
/** 已尝试次数（uploadTime 缺失时允许重试，入库完成后再补上） */
const metaAttempts = new Map<string, number>()
/** 单卡片最多查询次数（防无上限重试；库中确实没记录时就此放弃） */
const META_MAX_ATTEMPTS = 5
let metaTimer: number | undefined
let metaRetryTimer: number | undefined

/** 路由切换后清空查询记录（角标数据属于上一页的卡片，新页面要重新拉一轮） */
export function resetCardMeta(): void {
    metaApplied.clear()
    metaAttempts.clear()
}

export function scheduleCardMeta(): void {
    if (metaTimer !== undefined) return
    metaTimer = window.setTimeout(() => {
        metaTimer = undefined
        void applyCardMeta()
    }, 200)
}

function scheduleCardMetaRetry(): void {
    if (metaRetryTimer !== undefined) return
    metaRetryTimer = window.setTimeout(() => {
        metaRetryTimer = undefined
        void applyCardMeta()
    }, 1500)
}

async function applyCardMeta(): Promise<void> {
    const pending: Array<{ id: string; author?: string }> = []
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
        const id = videoIdFromCard(card)
        if (!id || metaApplied.has(id)) continue
        const author = authorOfCard(card)
        pending.push(author ? { id, author } : { id })
    }
    if (pending.length === 0) return

    const playlistId = playlistIdFromPath(window.location.pathname)
    let result: CardMetaResult
    try {
        result = await send<CardMetaResult>({
            type: 'GET_CARD_META',
            payload: { cards: pending, ...(playlistId ? { playlistId } : {}) }
        })
    } catch (error) {
        // 后台不可用（SW 冷启动等）：不重试，下次刷新还会重开一轮
        document.documentElement?.setAttribute(META_MARKER_ATTR, `fail:${String(error)}`)
        console.debug('[iwara-assistant] card meta failed:', error)
        return
    }

    document.documentElement?.setAttribute(META_MARKER_ATTR, `ok:${result.items.length}:${result.items.filter((item) => item.uploadTime !== undefined).length}`)

    for (const item of result.items) {
        applyCardBadges(item, result.canDeletePlaylistItem)
        // uploadTime 只能来自视频库；首轮查询可能早于 INGEST 入库，留有限次重试
        // （入库完成后下一轮补上）。其余字段（following/downloaded）已是定论。
        const attempts = (metaAttempts.get(item.id) ?? 0) + 1
        metaAttempts.set(item.id, attempts)
        if (item.uploadTime !== undefined || attempts >= META_MAX_ATTEMPTS) metaApplied.add(item.id)
    }

    // 仍有卡片缺 uploadTime：入库可能还没写完，1.5s 后再补一轮（次数上限保证终止）
    if (pending.some((card) => !metaApplied.has(card.id))) scheduleCardMetaRetry()
}

/** 单张卡片的角标与属性写入（重复调用幂等） */
function applyCardBadges(meta: CardMeta, canDelete: boolean): void {
    const box = document.querySelector<HTMLInputElement>(`input.${CHECKBOX_CLASS}[${CHECKBOX_ID_ATTR}="${meta.id}"]`)
    if (!box) return
    // 对齐源 ui/widgets/checkbox.ts 的取值优先级：库里有记录用库里的，否则用注入时写的 DOM 值。
    // （源：`hasFullInfo ? info.Title : DOM 值`；本扩展的 DOM 值在 injectCheckbox 里已先行写入）
    if (meta.name) box.setAttribute('videoName', meta.name)
    if (meta.alias) box.setAttribute('videoAlias', meta.alias)
    if (meta.author) box.setAttribute('videoAuthor', meta.author)
    if (meta.uploadTime !== undefined) box.setAttribute('videoUploadTime', String(meta.uploadTime))

    const card = box.closest(CARD_SELECTOR)
    if (!card) return
    const thumbnail = card.querySelector('a.videoTeaser__thumbnail')

    // .follow：已关注作者（源项目挂在缩略图内）
    if (meta.following && thumbnail && !thumbnail.querySelector('.follow')) {
        thumbnail.appendChild(badge('follow', i18n.t('page.badge.following')))
    }
    // .downloaded：MediaCenter 已有（源项目仅在配置了 MediaCenter 时才可能为 true）
    if (meta.downloaded && thumbnail && !thumbnail.querySelector('.downloaded')) {
        thumbnail.appendChild(badge('downloaded', i18n.t('page.badge.downloaded')))
    }
    // .deleteButton：仅播放列表页且当前用户是所有者（后台已判定）
    const playlistId = playlistIdFromPath(window.location.pathname)
    if (canDelete && playlistId && !card.querySelector('.deleteButton')) {
        const button = document.createElement('button')
        button.className = 'deleteButton'
        button.setAttribute(CHECKBOX_ID_ATTR, meta.id)
        button.textContent = i18n.t('page.badge.delete')
        button.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            void deletePlaylistItem(playlistId, meta.id, button)
        })
        ;(thumbnail?.parentElement ?? card).appendChild(button)
    }
}

async function deletePlaylistItem(playlistId: string, videoId: string, button: HTMLElement): Promise<void> {
    try {
        await browser.runtime.sendMessage({ type: 'REMOVE_PLAYLIST_ITEMS', payload: { playlistId, videoIds: [videoId] } })
        button.remove()
        // 卡片本身随之失效（站点列表未刷新）：只移除删除按钮，不擅自删卡片节点
    } catch (error) {
        console.warn('[iwara-assistant] delete playlist item failed:', error)
    }
}

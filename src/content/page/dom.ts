/**
 * 页内 UI 的 DOM 基础设施 —— 常量、宿主节点、存储访问、几个纯解析函数。
 *
 * 抽出来的理由：`pageUi.ts` 曾经把「选择态 / 角标 / 菜单 / 水印 / 对话框 / 路由」六件事
 * 塞在一个文件里，而它们共用同一批选择器常量。常量散落在 900 行里意味着改一个类名
 * 要全文搜一遍；集中在这里之后，"DOM 契约"只有一个定义处。
 *
 * ## 与源项目的对齐关系（改这里会影响 e2e 与站点样式）
 * - `MENU_ID` ← 源 `ui/menu.ts` 的 `#pluginMenu`（DOM/样式/测试选择器全同构）
 * - `OVERLAY_ID` ← 源 `css/overlay.css` 的 `#pluginOverlay`
 * - `WATERMARK_ID` ← 源项目无 id（仅 class `fixed-bottom-right`）；此处加 id 便于更新选中数
 * - `CHECKBOX_CLASS` ← 源 `ui/widgets/checkbox.ts` 的 `selectButton`（其 e2e 用 `input.selectButton[videoID]` 定位）
 * - `CHECKBOX_ID_ATTR` ← 源项目用大写 ID 的 HTML attribute（不是 `data-*`）
 */

/** 菜单 id */
export const MENU_ID = 'pluginMenu'
/** 手动下载对话框 overlay id */
export const OVERLAY_ID = 'pluginOverlay'
/** 水印 id */
export const WATERMARK_ID = 'pluginWatermark'
/** 选择集在 storage.local 的键（跨标签页共享） */
export const SELECTION_KEY = 'pageSelection'
/** 视频卡片选择器（站点自身的类名，全部注入/角标逻辑都以它为边界） */
export const CARD_SELECTOR = '.videoTeaser'
/** 卡片复选框类名 */
export const CHECKBOX_CLASS = 'selectButton'
/** 复选框携带视频 ID 的属性名 */
export const CHECKBOX_ID_ATTR = 'videoID'

/**
 * UI 挂载点。
 *
 * 对齐 ScriptCat 的 document-start 语义：脚本执行时 `document.head` / `document.body`
 * 都还不存在，唯一存在的节点是 `documentElement`（`innerHTML` 为空）。
 * 先挂 documentElement 保证「最早可见」，body 一出现再迁移到 body
 * （对齐源项目 `body > #pluginMenu` 的 DOM 位置契约）。
 */
export function hostNode(): HTMLElement {
    return document.body ?? document.documentElement
}

/** body 出现后把 UI 迁到 body（固定定位元素迁不迁视觉一致，此处只为 DOM 契约） */
export function rehostToBody(): void {
    const body = document.body
    if (!body) return
    for (const id of [MENU_ID, WATERMARK_ID, OVERLAY_ID]) {
        const node = document.getElementById(id)
        if (node && node.parentElement !== body) body.appendChild(node)
    }
}

/** storage.local 的最小接口（`@types/browser` 对 get/set 的重载在这里反而碍事） */
export function storageArea(): { get(key: string): Promise<Record<string, unknown>>; set(data: Record<string, unknown>): Promise<void> } {
    return browser.storage.local as unknown as {
        get(key: string): Promise<Record<string, unknown>>
        set(data: Record<string, unknown>): Promise<void>
    }
}

/** 卡片作者用户名（`a.username` 的路径末段；源项目同款解析） */
export function authorOfCard(card: Element): string | undefined {
    const authorEl = card.querySelector<HTMLAnchorElement>('a.username')
    if (!authorEl) return undefined
    try {
        return new URL(authorEl.href, location.origin).pathname.split('/').filter(Boolean).pop()
    } catch {
        return undefined
    }
}

/** 播放列表 ID（`/playlist/:id`；其余路径返回 null） */
export function playlistIdFromPath(pathname: string): string | null {
    const segments = pathname.split('/').filter(Boolean)
    return segments[0] === 'playlist' ? (segments[1] ?? null) : null
}

/** 角标节点（源项目结构：`div.className > div.text.text--white.text--tiny.text--bold`） */
export function badge(className: string, label: string): HTMLElement {
    const node = document.createElement('div')
    node.className = className
    const inner = document.createElement('div')
    inner.className = 'text text--white text--tiny text--bold'
    inner.textContent = label
    node.appendChild(inner)
    return node
}

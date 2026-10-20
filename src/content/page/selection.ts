/**
 * 选择态 —— 内存 Set ⇄ `storage.local.pageSelection`（跨标签页共享）+ 卡片复选框。
 *
 * 三件事在这个文件里，因为它们是**同一份状态**的三个面：
 * 1. 内存里的 `selected`（唯一读写入口都在这里，外部只能通过导出的函数动它）
 * 2. storage 同步（含「自己写入触发的变更不回灌」的抑制计数）
 * 3. DOM 呈现（复选框的注入/移除/勾选同步/水印计数）
 *
 * 拆开写会立刻产生「谁在什么时候改 selected」的二义性，而那正是勾选状态错乱的老根因。
 */
import { i18n } from '../../shared/i18n'
import { changedValue } from '../../shared/storageChanges'
import { videoIdFromCard } from '../../shared/pageType'
import { CARD_SELECTOR, CHECKBOX_CLASS, CHECKBOX_ID_ATTR, SELECTION_KEY, WATERMARK_ID, authorOfCard, storageArea } from './dom'
import { scheduleCardMeta } from './cardMeta'

/** 本页选中集合（与 storage.pageSelection 双向同步；跨标签页共享） */
const selected = new Set<string>()

/** 已成功写入 storage 但还没看到 onChanged 回调的次数（用来忽略自己写入的变更） */
let selectionWrites = 0

/**
 * 复选框注入开关（用户意图）。
 *
 * ⚠️ 不能用「DOM 里有没有复选框」反推开关键：注入永远从零开始，
 * 用存在性当门就是死锁——首轮 `refreshCards()` 直接就 return，
 * 任何卡片都不会被注入（真实站点冒烟抓到的 bug）。
 */
let injectionOn = false

export function selectionSize(): number {
    return selected.size
}

export function selectedIds(): string[] {
    return [...selected]
}

export function isInjectionOn(): boolean {
    return injectionOn
}

/**
 * 只切开关，不做任何 DOM 动作。
 *
 * 副作用留给调用方显式决定：开启时要注入到哪些页（只有列表/详情页有卡片）、
 * 关闭时要移除还是保留（路由重建时是先移除再重新注入，两件事不能合并成一个函数）。
 */
export function setInjectionMode(next: boolean): void {
    injectionOn = next
}

// ── storage 同步 ──────────────────────────────────────────────────────

export async function loadSelection(): Promise<void> {
    try {
        const stored = await storageArea().get(SELECTION_KEY)
        const value = stored[SELECTION_KEY]
        selected.clear()
        if (Array.isArray(value)) {
            for (const id of value) if (typeof id === 'string') selected.add(id)
        }
    } catch {
        // 扩展上下文失效：忽略
    }
}

export function persistSelection(): void {
    selectionWrites++
    const ids = [...selected]
    void storageArea()
        .set({ [SELECTION_KEY]: ids })
        .catch(() => undefined)
}

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(SELECTION_KEY in changes)) return
    const next = changedValue(changes, SELECTION_KEY)
    if (!Array.isArray(next)) return
    // 自己写入触发的变更无需回灌（避免覆盖正在进行的本地勾选）
    if (selectionWrites > 0) {
        selectionWrites--
        return
    }
    selected.clear()
    for (const id of next) if (typeof id === 'string') selected.add(id)
    syncCheckboxes()
    updateSelectionCount()
})

/**
 * 后台 → 页面：这批视频里哪些已经处理完 → 从选择集移除（勾选框自动取消）。
 *
 * 对齐源项目 `analyzeDownloadTask` 循环里的 `taskList.delete(id)`：**每处理完一个就删一个**，
 * 所以勾选随进度逐个消失，而不是等整批跑完。失败项同样移除（源项目也是无条件删除；
 * 失败原因在队列与通知里可见，页面勾选不承担「待重试」语义）。
 *
 * 为什么监听器在本 bundle 而不是 `content/isolated.ts`：选择集是**这个 bundle 的模块状态**，
 * 两个 content script 是不同的 bundle，不能共享 JS 变量。两者都会收到这条消息，
 * `isolated.ts` 走 `default` 分支忽略。
 */
browser.runtime.onMessage.addListener((message: unknown) => {
    const push = message as { type?: string; payload?: { videoIds?: unknown } } | undefined
    if (push?.type !== 'DOWNLOAD_TASK_SETTLED') return false
    const ids = Array.isArray(push.payload?.videoIds) ? push.payload.videoIds.filter((id): id is string => typeof id === 'string') : []
    if (ids.length === 0) return false
    let changed = false
    for (const id of ids) if (selected.delete(id)) changed = true
    if (!changed) return false
    // 写 storage 顺带把其它标签页的同名勾选一起同步（选择集跨标签页共享）
    persistSelection()
    syncCheckboxes()
    updateSelectionCount()
    return false
})

// ── 选择动作（菜单里那几项）────────────────────────────────────────────

export function selectAllOnPage(): void {
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
        const id = videoIdFromCard(card)
        if (id) selected.add(id)
    }
    persistSelection()
    syncCheckboxes()
    updateSelectionCount()
}

export function invertSelectionOnPage(): void {
    const ids = new Set<string>()
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
        const id = videoIdFromCard(card)
        if (id) ids.add(id)
    }
    for (const id of ids) {
        if (selected.has(id)) selected.delete(id)
        else selected.add(id)
    }
    persistSelection()
    syncCheckboxes()
    updateSelectionCount()
}

/** 只删本页卡片对应的 ID（对齐源 `selectAll(false)`） */
export function deselectPage(): void {
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
        const id = videoIdFromCard(card)
        if (id) selected.delete(id)
    }
    persistSelection()
    syncCheckboxes()
    updateSelectionCount()
}

/** 清空全部选中（对齐源 `deselectAll`） */
export function clearSelection(): void {
    selected.clear()
    persistSelection()
    syncCheckboxes()
    updateSelectionCount()
}

// ── 复选框呈现 ────────────────────────────────────────────────────────

export function syncCheckboxes(): void {
    for (const box of document.querySelectorAll<HTMLInputElement>(`input.${CHECKBOX_CLASS}`)) {
        const id = box.getAttribute(CHECKBOX_ID_ATTR)
        if (!id) continue
        box.checked = selected.has(id)
    }
}

/**
 * 注入卡片复选框 —— 对齐源项目 `ui/widgets/checkbox.ts`：
 * - 挂到 `a.videoTeaser__thumbnail` 的 `parentElement`（= `.videoTeaser`）**末尾**，
 *   并把该容器设为 `position: relative`（源项目显式设置，防 DOM 变体）
 * - 属性用 `videoID` + 元数据 `videoName/videoAlias/videoAuthor`（源项目契约，供其他脚本/样式读取）
 * - 拦 click 时用 `stopImmediatePropagation`（源项目同款，防宿主的卡片跳转委派）
 */
function injectCheckbox(card: Element): void {
    const id = videoIdFromCard(card)
    if (!id) return
    const existing = card.querySelector<HTMLInputElement>(`input.${CHECKBOX_CLASS}`)
    if (existing) {
        existing.setAttribute(CHECKBOX_ID_ATTR, id)
        existing.checked = selected.has(id)
        return
    }

    // 源项目插入点：缩略图的父元素（真实站点上就是 .videoTeaser 自身，且已 relative）
    const thumbnail = card.querySelector('a.videoTeaser__thumbnail')
    const host = thumbnail?.parentElement ?? card
    if (host instanceof HTMLElement) host.style.setProperty('position', 'relative')

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = CHECKBOX_CLASS
    box.title = i18n.t('page.badge.checkbox')
    box.setAttribute(CHECKBOX_ID_ATTR, id)
    box.checked = selected.has(id)

    // 元数据属性（对齐源项目）：源从 DB 取，页内只能取 DOM 可见值；
    // videoUploadTime 需要库里的绝对时间 → 由 GET_CARD_META 异步补齐（applyCardMeta）。
    const titleEl = card.querySelector('.videoTeaser__title')
    const title = titleEl?.getAttribute('title') ?? titleEl?.textContent?.trim()
    if (title) box.setAttribute('videoName', title)
    const authorEl = card.querySelector<HTMLAnchorElement>('a.username')
    if (authorEl) {
        const alias = authorEl.getAttribute('title')
        if (alias) box.setAttribute('videoAlias', alias)
        const author = authorOfCard(card)
        if (author) box.setAttribute('videoAuthor', author)
    }

    box.addEventListener('click', (event) => {
        event.stopPropagation()
        event.stopImmediatePropagation()
    })
    box.addEventListener('change', () => {
        if (box.checked) selected.add(id)
        else selected.delete(id)
        persistSelection()
        updateSelectionCount()
    })
    host.appendChild(box)
}

export function removeCheckboxes(): void {
    for (const box of document.querySelectorAll(`input.${CHECKBOX_CLASS}`)) box.remove()
}

/** 全量注入（无门控；调用方负责判断时机） */
export function injectCards(): void {
    for (const card of document.querySelectorAll(CARD_SELECTOR)) injectCheckbox(card)
    // 复选框就位后补齐后台才能提供的元数据（角标 / uploadTime / 删除按钮）
    if (document.querySelector(`input.${CHECKBOX_CLASS}`)) scheduleCardMeta()
}

/** 增量刷新（只在选择模式开启时干活） */
export function refreshCards(): void {
    if (!injectionOn) return
    injectCards()
}

/**
 * 刷新选中计数——**只有右下角水印**。
 *
 * 菜单项文案是静态的（对齐源 `ui/widgets/watermark.ts` + `ui/menu.ts`：源的计数只在
 * 水印里由 `selection:changed` 订阅刷新，`下载所选` 这一项从不带数字）。
 */
export function updateSelectionCount(): void {
    const count = document.querySelector<HTMLElement>(`#${WATERMARK_ID} .ia-watermark-count`)
    if (count) count.textContent = ` ${i18n.t('page.watermark.selected', { n: selected.size })} `
}

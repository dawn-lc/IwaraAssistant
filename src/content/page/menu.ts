/**
 * 悬浮菜单（对齐源 `ui/menu.ts`：`#pluginMenu > ul > li`，右侧中部滑出）。
 *
 * 菜单项组装顺序与页面门控对齐源 `pageChange()`：
 * - Video 页：downloadThis → injectCheckbox → deselectAll → reverseSelect →
 *   selectThis → deselectThis → downloadSelected → manualDownload
 * - 列表页：去掉 downloadThis
 * - 其他页：只有 manualDownload
 *
 * 有意不移植的源项目菜单项：exportConfig / importConfig / settings ——
 * 都是低频运维/导航操作，归扩展自有页面（options 迁移页签、工具栏弹窗）。
 */
import { pageTypeOf, videoIdFromPath } from '../../shared/pageType'
import { i18n } from '../../shared/i18n'
import { MENU_ID, hostNode } from './dom'
import { clearSelection, deselectPage, injectCards, invertSelectionOnPage, isInjectionOn, refreshCards, removeCheckboxes, selectAllOnPage, selectedIds, setInjectionMode } from './selection'
import { openManualDialog } from './manualDialog'
import { sendBatch, sendOne } from './requests'
import { uiConfig } from './uiState'

let menuRoot: HTMLDivElement | null = null

/** 触控设备判定（对齐源项目 menu.ts：matchMedia coarse + maxTouchPoints 兜底） */
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints ?? 0) > 0

function menuItem(label: string, action: string): HTMLLIElement {
    const item = document.createElement('li')
    item.textContent = label
    // data-action 是本扩展为测试/样式加的标记（源项目靠 li 文本定位）
    item.dataset['action'] = action
    item.addEventListener('click', (event) => {
        event.stopPropagation()
        // 触控设备点菜单项后自动收起（对齐源 menu.ts 的 150ms 延迟）
        if (isTouchDevice && uiConfig.autoCollapseMenu !== false) {
            window.setTimeout(() => menuRoot?.classList.remove('expanded'), 150)
        }
        void runAction(action)
    })
    return item
}

/**
 * 菜单交互 —— 对齐源 `ui/menu.ts`：
 * - `autoCollapseMenu !== false` + 桌面：mouseover 展开，mouseout 300ms 后收起，点击容器切换
 * - `autoCollapseMenu !== false` + 触控：点击容器切换，点击外部收起
 * - `autoCollapseMenu === false`：常驻 `.expanded`
 */
function installMenuInteraction(root: HTMLDivElement): void {
    if (uiConfig.autoCollapseMenu === false) {
        root.classList.add('expanded')
        return
    }
    if (isTouchDevice) {
        root.addEventListener('click', (event) => {
            if (event.target === root) root.classList.toggle('expanded')
        })
        document.addEventListener(
            'click',
            (event) => {
                if (root.classList.contains('expanded') && !root.contains(event.target as Node)) {
                    root.classList.remove('expanded')
                }
            },
            true
        )
        return
    }
    let mouseoutTimer: number | null = null
    root.addEventListener('mouseover', () => {
        if (mouseoutTimer !== null) {
            window.clearTimeout(mouseoutTimer)
            mouseoutTimer = null
        }
        root.classList.add('expanded')
    })
    root.addEventListener('mouseout', (event) => {
        const relatedTarget = (event as MouseEvent).relatedTarget as Node | null
        if (relatedTarget && root.contains(relatedTarget)) return
        mouseoutTimer = window.setTimeout(() => {
            root.classList.remove('expanded')
            mouseoutTimer = null
        }, 300)
    })
    root.addEventListener('click', (event) => {
        if (event.target === root) root.classList.toggle('expanded')
    })
}

export function ensureMenu(): void {
    if (document.getElementById(MENU_ID)) return
    const pageType = pageTypeOf(window.location.pathname)
    const hasCards = pageType === 'video' || pageType === 'videoList'

    const root = document.createElement('div')
    root.id = MENU_ID

    const list = document.createElement('ul')

    if (pageType === 'video') list.appendChild(menuItem(i18n.t('page.menu.downloadThis'), 'download-current'))

    if (hasCards) {
        list.appendChild(menuItem(i18n.t('page.menu.injectCheckbox'), 'select-toggle'))
        list.appendChild(menuItem(i18n.t('page.menu.deselectAll'), 'clear-selection'))
        list.appendChild(menuItem(i18n.t('page.menu.reverseSelect'), 'invert-selection'))
        list.appendChild(menuItem(i18n.t('page.menu.selectThis'), 'select-all'))
        list.appendChild(menuItem(i18n.t('page.menu.deselectThis'), 'deselect-page'))
        list.appendChild(menuItem(i18n.t('page.menu.downloadSelected'), 'batch-download'))
    }

    list.appendChild(menuItem(i18n.t('page.menu.manualDownload'), 'manual-download'))

    root.appendChild(list)
    installMenuInteraction(root)
    hostNode().appendChild(root)
    menuRoot = root
}

/**
 * 重建菜单。
 *
 * 两处要重建：配置变化（语言/常驻展开/页面门控都可能变）与路由变化（页类型变了，
 * 菜单项集合就该不同）。标题在建菜单时固化进 DOM，无法改名，所以只能整体重建。
 */
export function rebuildMenu(): void {
    document.getElementById(MENU_ID)?.remove()
    menuRoot = null
    ensureMenu()
}

async function runAction(action: string): Promise<void> {
    switch (action) {
        case 'select-toggle': {
            // 开关选择框：对齐源 ui/setup.ts 的 toggleInjectCheckbox。
            // 取反**只能**看开关变量：注入永远从零开始，用「DOM 里有没有复选框」当门是死锁
            const next = !isInjectionOn()
            setInjectionMode(next)
            if (next) injectCards()
            else removeCheckboxes()
            break
        }
        case 'select-all':
            // 全选隐含进入选择模式：否则选中集非空但页上看不到复选框（无反馈）
            setInjectionMode(true)
            refreshCards()
            selectAllOnPage()
            break
        case 'invert-selection':
            setInjectionMode(true)
            refreshCards()
            invertSelectionOnPage()
            break
        case 'deselect-page':
            deselectPage()
            break
        case 'clear-selection':
            clearSelection()
            break
        case 'batch-download': {
            const ids = selectedIds()
            if (ids.length === 0) return
            await sendBatch(ids)
            break
        }
        case 'download-current': {
            // 单条下载走 INIT_DOWNLOAD 而不是 BATCH_DOWNLOAD：批量下载有进程内互斥
            // （对齐源 `analyzeDownloadTaskRunning`），单条下载不该被「上一批还在跑」挡住。
            // 源项目这里也是单条路径（`pushDownloadTask`），不经过批量循环。
            const id = videoIdFromPath(window.location.pathname)
            if (id) await sendOne(id)
            break
        }
        case 'manual-download':
            openManualDialog()
            break

        default:
            break
    }
}

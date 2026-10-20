/**
 * 右下角水印（对齐源 `ui/widgets/watermark.ts` + `videoCard.css` 的 `.fixed-bottom-right`）。
 *
 * `<应用名> <版本> <已选中 N> <调试模式>`，其中选中数由 `selection.ts` 的
 * `updateSelectionCount()` 单独刷新（只改 `.ia-watermark-count` 这一节，不误伤标题）。
 *
 * 顺便承担一个隐藏开关：连续点水印 5 次开启调试模式（源项目同款行为：写配置后 reload）。
 */
import { i18n } from '../../shared/i18n'
import { CONFIG_KEY } from '../../shared/storageKeys'
import { WATERMARK_ID, hostNode, storageArea } from './dom'
import { selectionSize, updateSelectionCount } from './selection'
import { uiConfig } from './uiState'

/** 五连击开启调试模式（源 watermark.ts 的 DEBUG_SWITCH_THRESHOLD） */
const DEBUG_SWITCH_THRESHOLD = 5
let debugSwitchCount = 0

export function installWatermark(): void {
    if (document.getElementById(WATERMARK_ID)) {
        updateSelectionCount()
        applyDebugFlag()
        return
    }

    const version = browser.runtime.getManifest().version
    const watermark = document.createElement('p')
    watermark.id = WATERMARK_ID
    watermark.className = 'fixed-bottom-right'

    const label = document.createElement('span')
    // 品牌名走字典（源 `ui/widgets/watermark.ts` 的 `%#appName#%`），不要在这里写死
    label.textContent = `${i18n.t('app.name')} ${version} `

    const count = document.createElement('span')
    // 专用 class：updateSelectionCount() 只改这一节，不能误伤标题 span
    count.className = 'ia-watermark-count'
    count.textContent = ` ${i18n.t('page.watermark.selected', { n: selectionSize() })} `

    const debugFlag = document.createElement('span')
    debugFlag.className = 'ia-watermark-debug'

    watermark.appendChild(label)
    watermark.appendChild(count)
    watermark.appendChild(debugFlag)
    watermark.addEventListener('click', () => {
        if (uiConfig.isDebug) return
        if (debugSwitchCount < DEBUG_SWITCH_THRESHOLD) {
            debugSwitchCount++
            return
        }
        void enableDebugMode()
    })
    hostNode().appendChild(watermark)
    applyDebugFlag()
}

/** 调试标记文案（关时清空，不隐藏节点——避免重复 append） */
export function applyDebugFlag(): void {
    const flag = document.querySelector<HTMLElement>(`#${WATERMARK_ID} .ia-watermark-debug`)
    if (flag) flag.textContent = uiConfig.isDebug ? i18n.t('page.watermark.debugMark', { label: i18n.t('page.watermark.debug') }) : ''
}

/** 五连击开启调试：写回配置后 reload（与源项目同一行为） */
async function enableDebugMode(): Promise<void> {
    try {
        const stored = await storageArea().get(CONFIG_KEY)
        const current = (stored[CONFIG_KEY] ?? {}) as Record<string, unknown>
        await storageArea().set({ config: { ...current, isDebug: true } })
        location.reload()
    } catch (error) {
        console.warn('[iwara-assistant] enable debug mode failed:', error)
    }
}

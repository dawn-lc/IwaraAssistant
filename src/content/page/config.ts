/**
 * 页内配置的应用动作 —— 把 `storage.local.config` 里与页面显示相关的子集落到 DOM。
 *
 * 与 `uiState.ts` 的分工：那边只存**值**，这边做**生效动作**（切 class、重建菜单、重装水印）。
 * 分开的原因是依赖方向：配置变化要动菜单和水印，而菜单/水印又要读配置值；
 * 合成一个模块就是循环依赖。
 */
import { setLanguagePref } from '../../shared/i18n'
import { CONFIG_KEY } from '../../shared/storageKeys'
import { MENU_ID } from './dom'
import { applyDebugFlag, installWatermark } from './watermark'
import { ensureMenu, rebuildMenu } from './menu'
import { replaceUiConfig } from './uiState'
import type { UiConfig } from './uiState'

export type { UiConfig }

/**
 * 应用配置（不写内存副本：`storage.onChanged` 才是唯一事实源）。
 * 语言不在这里存：`shared/i18n` 自己持有当前语言，这里只负责把它同步进去。
 */
export function applyUiConfig(config: UiConfig | undefined): void {
    replaceUiConfig(config)
    setLanguagePref(config?.language)
    document.documentElement.classList.toggle('ia-beautify', config?.enableBeautify === true)
    document.documentElement.classList.toggle('ia-widescreen', config?.enableWidescreen === true)
    applyDebugFlag()
    if (document.getElementById(MENU_ID)) {
        // 语言/页面门控/常驻展开可能都变了，标题与项集合都是固化的 → 只能整体重建
        rebuildMenu()
    } else {
        ensureMenu()
    }
    installWatermark()
}

export async function loadUiConfig(): Promise<void> {
    try {
        const stored = await browser.storage.local.get(CONFIG_KEY)
        applyUiConfig(stored[CONFIG_KEY] as UiConfig | undefined)
    } catch {
        applyUiConfig(undefined)
    }
}

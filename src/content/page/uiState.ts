/**
 * 页内 UI 的配置子集 —— **唯一可变对象**，各模块直接读写。
 *
 * 为什么不放到 `config.ts`：`config` 模块要依赖菜单与水印（配置变化时要重建它们），
 * 而菜单与水印又要读配置。把「配置值」和「配置生效动作」分成两个模块，
 * 依赖就变成单向的：`uiState` ←(`menu`/`watermark`) ← `config`。
 *
 * 为什么用可变对象而不是 `let` + setter：`let` 导出后无法跨模块赋值，
 * 而 setter 需要每个读取点改成函数调用（`isDebug()`），读起来比字段更难判断"这是快照还是实时值"。
 * 这里刻意保留一个**长期存活的容器**，约定是：可以改字段，但只能通过 `replaceUiConfig` 整体替换。
 */

import type { LanguagePref } from '../../shared/i18n'

/** 应用到页面的配置子集（只取页内 UI 需要的字段，不复制整份 Config） */
export interface UiConfig {
    autoInjectCheckbox?: boolean
    autoCollapseMenu?: boolean
    enableBeautify?: boolean
    enableWidescreen?: boolean
    isDebug?: boolean
    language?: LanguagePref
}

/** 当前生效的配置（始终是同一个对象引用；内容由 `replaceUiConfig` 替换） */
export const uiConfig: UiConfig = {}

/**
 * 整体替换配置内容（保留对象引用）。
 *
 * 必须先删旧键再写入：配置项被移除时要真的消失，否则 `enableBeautify` 这类
 * 布尔项会一直带着上一次的值（`undefined` 与「不存在」在 `!== false` 的判断下等价，
 * 但在 `=== true` 的判断下不同，残留旧值会让关闭动作失效）。
 */
export function replaceUiConfig(next: UiConfig | undefined): void {
    for (const key of Object.keys(uiConfig)) delete (uiConfig as Record<string, unknown>)[key]
    Object.assign(uiConfig, next ?? {})
}

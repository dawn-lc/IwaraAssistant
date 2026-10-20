/**
 * options 页签清单 —— options 导航与工具栏 popup（配置页入口）共用同一份定义。
 *
 * - `labelKey` 指向字典 `app.nav.*`，键名由 i18next 的 `CustomTypeOptions` 编译期校验；
 * - `group` 只用于视觉分组：options 导航渲染成分隔线，popup 渲染成分组间隙。
 *
 * 放 shared 而不是各写一份：popup 现在是「配置页入口」，两份页签表必然在新增页签时漂移。
 */
export const OPTIONS_TABS = [
    { id: 'download', labelKey: 'app.nav.download', group: 0 },
    { id: 'rpc', labelKey: 'app.nav.rpc', group: 0 },
    { id: 'filter', labelKey: 'app.nav.filter', group: 0 },
    { id: 'clean', labelKey: 'app.nav.clean', group: 0 },
    { id: 'tasks', labelKey: 'app.nav.tasks', group: 1 },
    { id: 'friends', labelKey: 'app.nav.friends', group: 1 },
    { id: 'migrate', labelKey: 'app.nav.migrate', group: 2 },
    { id: 'advanced', labelKey: 'app.nav.advanced', group: 2 },
    { id: 'guide', labelKey: 'app.nav.guide', group: 2 }
] as const

/** 合法的页签 id（`options/index.html#<id>` 的深链契约） */
export type OptionsTabId = (typeof OPTIONS_TABS)[number]['id']

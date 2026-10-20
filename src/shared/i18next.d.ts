/**
 * i18next 的类型增强 —— 官方推荐的 `CustomTypeOptions` 模块扩展。
 *
 * 作用（替代任何自研的键名类型）：
 * - `i18n.t('app.title')`、`useTranslation().t('tasks.retryFailed')` 的**键名**是字典叶子
 *   的联合类型，写错键直接编译失败；
 * - 返回值推导为 `string`（`returnNull: false` + 全字符串叶子），不需要 `as string`；
 * - 模板键也成立：`t(\`condition.${id}\`)` 在 `id` 是字面量联合时通过校验。
 *
 * 为什么以 **en** 为准：英文是 `fallbackLng`，也是唯一必须键齐全的基准；
 * 三种语言的键一致性由 `test/i18n.test.ts` 硬性对齐（漏翻只会在运行时静默回退，界面看不出来）。
 */
import type en from './locales/en.json'

declare module 'i18next' {
    interface CustomTypeOptions {
        defaultNS: 'translation'
        returnNull: false
        resources: {
            translation: typeof en
        }
    }
}

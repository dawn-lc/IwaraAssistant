/**
 * 运行时多语言 —— i18next（与 MediaCenter `client/src/i18n.ts` 同一套栈：i18next + react-i18next）。
 *
 * 本文件只做**三件事**，其余交给 i18next 自己：
 * 1. `i18n.init()`：字典内联为 resources，`initAsync: false` 同步就绪——
 *    content script 的 `document_start` 与 SW 冷启动都不能等 Promise 才建菜单/发通知。
 * 2. 语言来源：`storage.local.config.language`（`auto | en | ja | zh`）+ 浏览器语言探测，
 *    `watchLanguage()` 订阅它，四个上下文共用同一条变更通道。
 * 3. 语言清单（下拉框用）：i18next 不管「有哪些语言可选」，这是应用自己的事。
 *
 * **翻译本身没有包装层**：
 * - React 组件用 `useTranslation()`（react-i18next），切语言自动重渲染；实例由
 *   `options/main.tsx` / `popup/main.tsx` 的 `<I18nextProvider i18n={i18n}>` 注入；
 * - content / background / 非组件模块用 `i18n.t()`。
 * 两者都由 `./i18next.d.ts` 的 `CustomTypeOptions` 提供键名与返回值的编译期校验，
 * 所以这里不需要、也不应该再造一个 `t()` 转发函数或自研的键名类型。
 */
import i18next from 'i18next'
import en from './locales/en.json'
import ja from './locales/ja.json'
import zh from './locales/zh.json'
import { CONFIG_KEY } from './storageKeys'
import { changedValue } from './storageChanges'

export type Lang = 'en' | 'ja' | 'zh'
/** `auto` = 跟随浏览器/扩展 UI 语言；其余为显式选择 */
export type LanguagePref = 'auto' | Lang

export const SUPPORTED_LANGS: readonly Lang[] = ['en', 'ja', 'zh']

/** 兜底语言：浏览器语言不在支持列表内时使用（与 MediaCenter 的 DEFAULT_LANG 同义） */
export const DEFAULT_LANG: Lang = 'en'

interface Dict {
    language: { label: string }
}

const DICTS: Record<Lang, Dict> = { en: en as Dict, ja: ja as Dict, zh: zh as Dict }

export interface LangInfo {
    code: Lang
    /** 语言自报名（下拉框永远显示该语言自己的写法） */
    label: string
}

export const LANGUAGES: readonly LangInfo[] = SUPPORTED_LANGS.map((code) => ({ code, label: DICTS[code].language.label }))

/** 唯一的 i18next 实例（React 侧经 `I18nextProvider` 拿到的也是它） */
export const i18n = i18next

/**
 * 初始化。
 *
 * - `initAsync: false`（v26 起取代 `initImmediate`）：资源内联在包里，同步初始化。
 * - `interpolation.prefix/suffix` 改成单花括号，与 MediaCenter 的字典写法完全一致
 *   （默认的 `{{name}}` 会让两个项目的文案不能互相搬）。
 * - `escapeValue: false`：文案最终都进 `textContent`，不需要 HTML 转义；
 *   转了反而会让 `&`、`<` 这类值显示成实体。
 */
void i18n.init({
    resources: {
        en: { translation: en },
        ja: { translation: ja },
        zh: { translation: zh }
    },
    lng: DEFAULT_LANG,
    fallbackLng: DEFAULT_LANG,
    initAsync: false,
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
    returnNull: false
})

/** 浏览器/扩展 UI 语言（Chrome 取 `--lang`，Firefox 取 `intl.locale.requested`） */
function readUiLanguage(): string {
    try {
        const value = browser.i18n?.getUILanguage?.()
        if (value) return value
    } catch {
        // 某些上下文（offscreen 早期）i18n 不可用：退回 navigator
    }
    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') return navigator.language
    return ''
}

/** `zh-CN` / `zh-TW` / `zh` → `zh`；`ja-JP` → `ja`；未知语言 → `DEFAULT_LANG` */
export function mapToSupported(raw: string): Lang {
    const value = raw.trim().toLowerCase()
    if (value === '') return DEFAULT_LANG
    const exact = SUPPORTED_LANGS.find((code) => code === value)
    if (exact) return exact
    const prefix = value.split('-')[0] ?? ''
    return SUPPORTED_LANGS.find((code) => code === prefix) ?? DEFAULT_LANG
}

const isLang = (value: unknown): value is Lang => typeof value === 'string' && (SUPPORTED_LANGS as readonly string[]).includes(value)

/** 配置里的偏好 → 实际语言（`auto` 或任何脏值都按浏览器语言解析） */
export function resolveLanguage(pref: unknown): Lang {
    return isLang(pref) ? pref : mapToSupported(readUiLanguage())
}

/** 当前实际生效的语言 */
export function getLanguage(): Lang {
    return (i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LANG) as Lang
}

/**
 * 切换当前语言。
 *
 * 资源全部内联、没有 backend，所以 i18next 的 `changeLanguage` 走「无 backend」分支，
 * **同步**完成切语言并触发 `languageChanged`——这是 content script 建菜单前能立刻
 * 拿到新文案、单测能同步断言的前提。
 */
export function setLanguage(next: Lang): void {
    if (next === getLanguage()) return
    void i18n.changeLanguage(next)
}

/** 按配置偏好切换（`auto` 时重新探测浏览器语言） */
export function setLanguagePref(pref: unknown): void {
    setLanguage(resolveLanguage(pref))
}

/** 从 storage 读一次并订阅变更；各入口启动时调用一次即可（重复调用返回同一个 Promise） */
let watching = false
let ready: Promise<void> = Promise.resolve()

export function watchLanguage(): Promise<void> {
    if (watching) return ready
    watching = true
    const applyStored = (stored: unknown): void => {
        setLanguagePref((stored as { language?: unknown } | undefined)?.language)
    }
    if (typeof browser === 'undefined' || !browser.storage?.local) {
        // 无 storage 的上下文（单测）：按浏览器语言解析一次
        setLanguage(resolveLanguage(undefined))
        return ready
    }
    ready = browser.storage.local
        .get(CONFIG_KEY)
        .then((values) => applyStored(values[CONFIG_KEY]))
        .catch(() => setLanguage(resolveLanguage(undefined)))
    browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !(CONFIG_KEY in changes)) return
        applyStored(changedValue(changes, CONFIG_KEY))
    })
    return ready
}

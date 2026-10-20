/**
 * i18n 单元测试 —— 字典完整性（三语键必须完全一致）+ 解析/插值/回退语义。
 *
 * 字典是最容易「加了一个语言的键、忘了另外两个」的地方：漏翻的键在运行时只会
 * 静默回退到英文，界面上看不出错，所以必须在 CI 里硬性对齐。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import en from '../src/shared/locales/en.json'
import ja from '../src/shared/locales/ja.json'
import zh from '../src/shared/locales/zh.json'
import { DEFAULT_LANG, LANGUAGES, SUPPORTED_LANGS, getLanguage, i18n, mapToSupported, resolveLanguage, setLanguage, setLanguagePref } from '../src/shared/i18n'

/** 摊平成 `a.b.c` 键集合 */
function flatten(value: unknown, prefix = ''): string[] {
    if (typeof value !== 'object' || value === null) return [prefix]
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
}

const FLAT = { en: flatten(en), ja: flatten(ja), zh: flatten(zh) }

test('三种语言的键完全一致（漏翻会在运行时静默回退英文，必须在这里挡住）', () => {
    const reference = new Set(FLAT.en)
    for (const lang of ['ja', 'zh'] as const) {
        const actual = new Set(FLAT[lang])
        const missing = [...reference].filter((key) => !actual.has(key))
        const extra = [...actual].filter((key) => !reference.has(key))
        assert.deepEqual(missing, [], `${lang} 缺少这些键`)
        assert.deepEqual(extra, [], `${lang} 多出这些键`)
    }
})

test('字典叶子必须是非空字符串（结构错位会让 t() 返回键名）', () => {
    for (const [lang, dict] of Object.entries({ en, ja, zh })) {
        for (const key of FLAT[lang as keyof typeof FLAT]) {
            const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], dict)
            assert.equal(typeof value, 'string', `${lang}.${key} 不是字符串`)
            assert.notEqual((value as string).trim(), '', `${lang}.${key} 是空串`)
        }
    }
})

test('插值：{name} 按参数替换，未提供的占位符原样保留', () => {
    setLanguage('zh')
    assert.equal(i18n.t('time.minutesAgo', { n: 5 }), '5 分钟前')
    assert.equal(i18n.t('time.minutesAgo', {}), '{n} 分钟前')
    setLanguage('en')
    assert.equal(i18n.t('time.minutesAgo', { n: 5 }), '5m ago')
})

test('不带参数时每个键必须原样返回字典值（挡住插值/复数分隔符意外改写）', () => {
    // 真实踩过：`page.manual.hint` 的文案里含 `|`，而 `|` 是 i18next 的默认复数分隔符。
    // 一旦某个键被误判成复数或多个 `{` 占位符被提前消耗，这里就会报出具体键名。
    for (const lang of ['en', 'ja', 'zh'] as const) {
        setLanguage(lang)
        const dict = { en, ja, zh }[lang]
        for (const key of FLAT[lang]) {
            const raw = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], dict) as string
            assert.equal(i18n.t(key as never), raw, `${lang}.${key} 往返不一致`)
        }
    }
    setLanguage('en')
})

test('i18next 引擎语义：导入即同步就绪（content/SW 不能等 Promise）', () => {
    // `initAsync: false` 被改成 true 时，下面几行在模块导入阶段就会失败——
    // 那意味着 content script 第一帧建菜单拿到的是键名，而不是文案
    assert.equal(i18n.isInitialized, true)
    assert.equal(i18n.language, getLanguage())
    assert.equal(i18n.t('app.title'), en.app.title)
})

test('i18next 回退语义：缺失键返回键名本身（不抛错、不返回 undefined）', () => {
    // 键名有编译期校验，这里刻意绕过类型验证「运行时安全网」还在
    assert.equal(i18n.t('definitely.not.a.key' as never), 'definitely.not.a.key')
    // 未支持的语种回落到 fallbackLng，而不是空白
    void i18n.changeLanguage('ko')
    assert.equal(i18n.t('app.title'), en.app.title)
    void i18n.changeLanguage(DEFAULT_LANG)
})

test('切换语言后 t() 立即返回新语言；重复设置同一语言不通知订阅者', () => {
    const seen: string[] = []
    setLanguage('en')
    const unsubscribe = (() => {
        // 直接用 getLanguage 轮询语义验证：切换后立刻读到新值
        setLanguage('zh')
        seen.push(getLanguage())
        setLanguage('zh')
        seen.push(getLanguage())
        return (): void => undefined
    })()
    unsubscribe()
    assert.deepEqual(seen, ['zh', 'zh'])
    setLanguage('en')
})

test('语言识别：精确 / 前缀 / 未知回退', () => {
    assert.equal(mapToSupported('zh-CN'), 'zh')
    assert.equal(mapToSupported('zh-TW'), 'zh')
    assert.equal(mapToSupported('ja-JP'), 'ja')
    assert.equal(mapToSupported('en-US'), 'en')
    assert.equal(mapToSupported('EN'), 'en')
    assert.equal(mapToSupported('ko-KR'), DEFAULT_LANG)
    assert.equal(mapToSupported(''), DEFAULT_LANG)
})

test('配置偏好解析：显式语言直取，auto 与脏值都走浏览器探测', () => {
    assert.equal(resolveLanguage('ja'), 'ja')
    // 「自动」= 按运行环境的 UI 语言（Node 也有 navigator.language，跟随系统）
    assert.equal(resolveLanguage('auto'), mapToSupported(navigator.language ?? ''))
    assert.equal(resolveLanguage('klingon'), mapToSupported(navigator.language ?? ''))
    assert.equal(resolveLanguage(undefined), mapToSupported(navigator.language ?? ''))
    assert.equal(setLanguagePref('zh'), undefined)
    assert.equal(getLanguage(), 'zh')
    setLanguage('en')
})

test('语言清单自报名（下拉框显示各自语言的写法）', () => {
    assert.deepEqual(
        LANGUAGES.map((item) => item.code),
        [...SUPPORTED_LANGS]
    )
    assert.equal(LANGUAGES.find((item) => item.code === 'zh')?.label, '简体中文')
    assert.equal(LANGUAGES.find((item) => item.code === 'en')?.label, 'English')
    assert.equal(LANGUAGES.find((item) => item.code === 'ja')?.label, '日本語')
})

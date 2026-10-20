import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { i18n, watchLanguage } from '../shared/i18n'
import { App } from './App'

// react-i18next 需要显式拿到实例，否则 `useTranslation()` 报 NO_I18NEXT_INSTANCE、界面直接显示键名。
//
// 这里用 `I18nextProvider` 而不是 `i18n.use(initReactI18next)`：后者只有在 `i18n.init()`
// **之前**调用才有效（插件在 init 内部才会被初始化），而 `shared/i18n.ts` 是 import 即同步就绪的。
// 把 Provider 放在 React 入口，还能让 content / background 的 bundle 继续不带 react-i18next。
// 界面语言变了，`<html lang>` 也要跟着变：屏幕阅读器发音、`:lang()` 与断词规则都看它。
// 只写在扩展自有页面（options/popup），不改共享的 shared/i18n.ts——content script
// 跑在 iwara 页面上，改它的 lang 会影响宿主页面。
i18n.on('languageChanged', (lng) => {
    document.documentElement.lang = lng
})

void watchLanguage().then(() => {
    const container = document.querySelector<HTMLElement>('#root')
    if (container)
        createRoot(container).render(
            <I18nextProvider i18n={i18n}>
                <App />
            </I18nextProvider>
        )
})

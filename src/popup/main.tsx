import { Fragment } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { i18n, watchLanguage } from '../shared/i18n'
import { OPTIONS_TABS, type OptionsTabId } from '../shared/optionsTabs'

/**
 * 工具栏 popup —— **配置页入口**，不是任务面板。
 *
 * 队列/进度/历史/错误详情全部归 options「任务队列」页签：popup 空间有限，
 * 挤成两三行摘要既看不全、又不能操作（重试/移除/筛选都在 options），
 * 结果每次还是得再点一次「打开设置」。所以这里只做导航。
 *
 * 页签清单与 options 导航共用 `shared/optionsTabs.ts`——两份独立表在新增页签时必然漂移。
 * 类名 `.entry` 是 e2e 契约，勿改。
 */

/**
 * 打开 options 的指定页签。
 *
 * 已存在 options 标签页时复用它（`tabs.update` 改 hash，App 监听 `hashchange` 切页），
 * 否则新建——连点几次不该堆出几个标签页。
 *
 * `tabs.query` 的 url 过滤通常要求 tabs 权限或匹配的 host 权限，但**实测本扩展自身的
 * 页面不需要**（Chrome 155 / Firefox 158 都返回了完整 url）。catch 保留作其他宿主的降级：
 * 查不到就新建，宁可多一个标签页，也不为了复用去申请一个会出现在安装弹窗里的权限。
 */
async function openOptionsTab(id: OptionsTabId): Promise<void> {
    const url = browser.runtime.getURL(`options/index.html#${id}`)
    try {
        const [existing] = await browser.tabs.query({ url: browser.runtime.getURL('options/*') })
        if (existing && existing.id !== undefined) {
            await browser.tabs.update(existing.id, { url, active: true })
            return
        }
    } catch {
        // 无 tabs 权限时 query 会被拒：退化为新建
    }
    await browser.tabs.create({ url, active: true })
}

function Popup(): ReactElement {
    const { t } = useTranslation()
    const version = browser.runtime.getManifest().version

    return (
        <main className="popup">
            <header className="popup-header">
                <h1>{t('app.name')}</h1>
                <span className="version">v{version}</span>
            </header>
            <nav className="entries" aria-label={t('popup.hint')}>
                {OPTIONS_TABS.map((item, index) => (
                    <Fragment key={item.id}>
                        {index > 0 && OPTIONS_TABS[index - 1]?.group !== item.group ? <span className="entry-sep" aria-hidden="true" /> : null}
                        <button type="button" className="entry" onClick={() => void openOptionsTab(item.id)}>
                            {t(item.labelKey)}
                        </button>
                    </Fragment>
                ))}
            </nav>
        </main>
    )
}

// 同 options/main.tsx：`<html lang>` 跟随界面语言（仅扩展自有页面）
i18n.on('languageChanged', (lng) => {
    document.documentElement.lang = lng
})

// 先初始化语言再挂载：popup 是一次性渲染，晚一帧就是肉眼可见的语言闪烁
void watchLanguage().then(() => {
    const container = document.querySelector<HTMLElement>('#root')
    if (container)
        createRoot(container).render(
            <I18nextProvider i18n={i18n}>
                <Popup />
            </I18nextProvider>
        )
})

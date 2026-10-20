import { Fragment, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { OPTIONS_TABS, type OptionsTabId } from '../shared/optionsTabs'
import { useAppState } from './appStore'
import { OptionsToaster } from './toaster'
import { DownloadTab } from './tabs/DownloadTab'
import { RpcTab } from './tabs/RpcTab'
import { FilterTab } from './tabs/FilterTab'
import { NameCleanTab } from './tabs/NameCleanTab'
import { TasksTab } from './tabs/TasksTab'
import { MigrateTab } from './tabs/MigrateTab'
import { GuideTab } from './tabs/GuideTab'
import { FriendsTab } from './tabs/FriendsTab'
import { AdvancedTab } from './tabs/AdvancedTab'

/**
 * options 配置中心
 * 页签经 location.hash 深链（#tasks / #guide），onInstalled 由此自动打开引导
 *
 * 页签清单在 `shared/optionsTabs.ts`，与工具栏 popup（配置页入口）共用：
 * 两份表必然在新增页签时漂移。`group` 只用于视觉分组（分隔线不参与导航计数）。
 */
function initialTab(): OptionsTabId {
    const hash = window.location.hash.slice(1) as OptionsTabId
    return OPTIONS_TABS.some((tab) => tab.id === hash) ? hash : 'download'
}

export function App(): ReactElement {
    const version = browser.runtime.getManifest().version
    const { ready, config, queue } = useAppState()
    const { t } = useTranslation()
    const [tab, setTab] = useState<OptionsTabId>(initialTab)

    useEffect(() => {
        const onHashChange = (): void => setTab(initialTab())
        window.addEventListener('hashchange', onHashChange)
        return () => window.removeEventListener('hashchange', onHashChange)
    }, [])

    const select = (id: OptionsTabId): void => {
        setTab(id)
        if (window.location.hash !== `#${id}`) window.location.hash = id
    }

    return (
        <main className="page">
            <header className="app-header">
                <div>
                    <h1>{t('app.title')}</h1>
                    <p className="subtitle">{t('app.subtitle')}</p>
                </div>
                <span className="version-badge">v{version}</span>
            </header>
            <nav className="tabs">
                {OPTIONS_TABS.map((item, index) => (
                    <Fragment key={item.id}>
                        {index > 0 && OPTIONS_TABS[index - 1]?.group !== item.group ? <span className="tab-sep" aria-hidden="true" /> : null}
                        <button type="button" className={tab === item.id ? 'active' : undefined} aria-current={tab === item.id ? 'page' : undefined} onClick={() => select(item.id)}>
                            {t(item.labelKey)}
                        </button>
                    </Fragment>
                ))}
            </nav>
            {/* 全局保存/操作反馈：sonner（底部右侧，避开顶部版本角标） */}
            <OptionsToaster />
            {!ready || config === null ? (
                <section className="card">
                    <p className="note">{ready ? t('app.loadFailed') : t('app.loading')}</p>
                </section>
            ) : tab === 'download' ? (
                <DownloadTab config={config} />
            ) : tab === 'rpc' ? (
                <RpcTab config={config} />
            ) : tab === 'filter' ? (
                <FilterTab config={config} />
            ) : tab === 'clean' ? (
                <NameCleanTab config={config} />
            ) : tab === 'tasks' ? (
                <TasksTab queue={queue} />
            ) : tab === 'friends' ? (
                <FriendsTab config={config} />
            ) : tab === 'migrate' ? (
                <MigrateTab />
            ) : tab === 'advanced' ? (
                <AdvancedTab config={config} />
            ) : (
                <GuideTab />
            )}
        </main>
    )
}

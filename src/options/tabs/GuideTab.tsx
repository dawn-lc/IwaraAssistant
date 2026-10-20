/**
 * 使用引导页签 —— 替代已删除的首次运行浮层（docs/01 注入最小化）
 *
 * 内容分工：
 * - 快速上手：最短路径跑通一次下载
 * - 站点访问权限：全站权限一次声明，这里只做**状态诊断**（浏览器里仍可撤销）
 * - 钓鱼仿冒防护：说明判定规则与官方域名，用户可自行核对地址栏
 * - 关于：版本 / 数据存放位置 / 隐私
 * - 更新日志：**面向用户的变更**，按版本分组，不写里程碑编号
 *
 * 为什么这里不再有「授权 XX 访问」按钮：`permissions.request()` 只能申请 optional
 * 权限，对 manifest 里静态声明的 host 权限无效（Chrome 直接报
 * "Cannot request required permission"）。用户若在浏览器扩展页撤回了授权，
 * 正确动作只能在浏览器 UI 里改回来——扩展能做的是如实告诉他去哪开。
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { hasAllSitesAccess } from '../../shared/permissions'
import { OFFICIAL_DOMAINS } from '../../shared/site'
import { Badge, Section } from '../widgets'

/**
 * 站点访问权限状态 —— 只诊断，不申请。
 *
 * 语义边界：`已授予` 只代表权限未被撤销；Chrome 的「点击时」模式下权限仍算授予，
 * 但内容脚本要等用户点图标才注入。所以文案只承诺「已声明」，不承诺「页内功能一定正常」。
 */
function SiteAccess(): ReactElement {
    const { t } = useTranslation()
    const [granted, setGranted] = useState<boolean | null>(null)

    useEffect(() => {
        void hasAllSitesAccess().then(setGranted)
    }, [])

    return (
        <div className="status-line">
            <Badge tone={granted == null ? 'plain' : granted ? 'ok' : 'warn'}>{granted == null ? t('common.checking') : t(granted ? 'guide.accessGranted' : 'guide.accessRevoked')}</Badge>
            {granted === false ? <span className="note">{t('guide.accessHint')}</span> : null}
        </div>
    )
}

/**
 * 更新日志分组。
 *
 * 每个版本一组、组内条目按顺序编号 —— 键名必须是**字面量**，i18next 的
 * `CustomTypeOptions` 才能逐个做编译期校验（写成动态拼键会失去这层保护）。
 * 版本号留在代码里而不是字典里：它不分语言，放进三份字典只会多三个可能写错的副本。
 */
const RELEASES = [
    {
        version: '0.1.14',
        items: ['guide.changelog.v0114.item1', 'guide.changelog.v0114.item2']
    },
    {
        version: '0.1.13',
        items: ['guide.changelog.v0113.item1', 'guide.changelog.v0113.item2', 'guide.changelog.v0113.item3', 'guide.changelog.v0113.item4', 'guide.changelog.v0113.item5', 'guide.changelog.v0113.item6', 'guide.changelog.v0113.item7', 'guide.changelog.v0113.item8']
    },
    {
        version: '0.1.12',
        items: ['guide.changelog.v0112.item1', 'guide.changelog.v0112.item2', 'guide.changelog.v0112.item3']
    },
    {
        version: '0.1.11',
        items: ['guide.changelog.v0111.item1', 'guide.changelog.v0111.item2', 'guide.changelog.v0111.item3', 'guide.changelog.v0111.item4']
    },
    {
        version: '0.1.10',
        items: ['guide.changelog.v0110.item1', 'guide.changelog.v0110.item2', 'guide.changelog.v0110.item3']
    },
    {
        version: '0.1.9',
        items: ['guide.changelog.v019.item1', 'guide.changelog.v019.item2', 'guide.changelog.v019.item3']
    },
    {
        version: '0.1.8',
        items: ['guide.changelog.v018.item1', 'guide.changelog.v018.item2']
    },
    {
        version: '0.1.6',
        items: ['guide.changelog.v016.item1', 'guide.changelog.v016.item2', 'guide.changelog.v016.item3', 'guide.changelog.v016.item4']
    },
    {
        version: '0.1.0',
        items: ['guide.changelog.v010.item1', 'guide.changelog.v010.item2', 'guide.changelog.v010.item3', 'guide.changelog.v010.item4', 'guide.changelog.v010.item5', 'guide.changelog.v010.item6', 'guide.changelog.v010.item7', 'guide.changelog.v010.item8', 'guide.changelog.v010.item9']
    }
] as const

export function GuideTab(): ReactElement {
    const version = browser.runtime.getManifest().version
    const { t } = useTranslation()
    return (
        <>
            <Section title={t('guide.quickTitle')} note={t('guide.quickNote')}>
                <ol className="guide-steps">
                    <li>{t('guide.step1')}</li>
                    <li>
                        {t('guide.step2Before')} <code>{t('app.name')}</code> {t('guide.step2After')}
                    </li>
                    <li>{t('guide.step3')}</li>
                </ol>
            </Section>

            <Section title={t('guide.accessTitle')} note={t('guide.accessNote')}>
                <SiteAccess />
                <p className="note">{t('guide.accessWhy')}</p>
            </Section>

            <Section title={t('guide.phishingTitle')} note={t('guide.phishingNote')}>
                <ul className="guide-steps">
                    <li>{t('guide.phishingRule')}</li>
                    <li>{t('guide.phishingBlock')}</li>
                </ul>
                <p className="note">
                    {t('guide.phishingOfficial')}{' '}
                    {OFFICIAL_DOMAINS.map((domain, index) => (
                        <span key={domain}>
                            {index > 0 ? ' / ' : ''}
                            <code>{domain}</code>
                        </span>
                    ))}
                </p>
            </Section>

            <Section title={t('guide.aboutTitle')}>
                <dl className="about-grid">
                    <dt>{t('guide.version')}</dt>
                    <dd className="mono">{version}</dd>
                    <dt>{t('guide.site')}</dt>
                    <dd>{t('guide.siteValue')}</dd>
                    <dt>{t('guide.storage')}</dt>
                    <dd>{t('guide.storageValue')}</dd>
                    <dt>{t('guide.privacy')}</dt>
                    <dd>{t('guide.privacyValue')}</dd>
                </dl>
            </Section>

            <Section title={t('guide.changelogTitle')}>
                <div className="changelog">
                    {RELEASES.map((release) => (
                        <div key={release.version}>
                            <h3>
                                {release.version}
                                {release.version === version ? <Badge tone="plain">{t('guide.current')}</Badge> : null}
                            </h3>
                            <ul>
                                {release.items.map((item) => (
                                    <li key={item}>{t(item)}</li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </Section>
        </>
    )
}

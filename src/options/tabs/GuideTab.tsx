/**
 * 使用引导页签 —— 替代已删除的首次运行浮层（docs/01 注入最小化）
 *
 * 内容分工：
 * - 快速上手：最短路径跑通一次下载
 * - 站点访问权限：全站权限一次声明，这里只做**状态诊断**（浏览器里仍可撤销）
 * - 钓鱼仿冒防护：说明判定规则与官方域名，用户可自行核对地址栏
 * - 关于：版本 / 数据存放位置 / 隐私
 *
 * 不内置更新日志：它的维护成本随每个版本线性增长，却只覆盖「装完就不再更新」的
 * 极少场景；发布说明留在商店页与仓库 release notes，代码里不再保留第二份。
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
        </>
    )
}

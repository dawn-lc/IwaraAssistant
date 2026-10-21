/**
 * 下载页签 —— 下载模式 / 路径模板（实时预览）/ 文件源优先级 / 元数据开关
 * 模板预览复用 shared/strings 的 replaceVariable（与后台落盘同一渲染管线）
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { replaceVariable, truncate } from '../../shared/strings'
import { BROWSER_CONCURRENCY_MAX, BROWSER_CONCURRENCY_MIN } from '../../shared/browserConcurrency'
import type { Config, DownloadType } from '../../shared/configSchema'
import { Row, Section, SelectField, TextField, Toggle, NumberField, useSaver } from '../widgets'

/** 预览用的示例视频（标题走 i18n，长度按真实截断规则处理） */
function sampleVideo(t: TFunction): Record<string, unknown> {
    return {
        NowTime: new Date(),
        UploadTime: new Date(Date.now() - 36 * 60 * 60 * 1000),
        AUTHOR: 'someone',
        ID: 'aBcD1234',
        TITLE: truncate(t('download.sampleTitle'), 48),
        ALIAS: t('download.sampleAlias'),
        QUALITY: 'Source'
    }
}

/** 下载方式选项：与配置默认值顺序一致（默认项排第一，避免用户每次都要往下翻） */
const DOWNLOAD_MODES: Array<{ value: DownloadType; label: 'download.modeOthersLabel' | 'download.modeBrowserLabel' | 'download.modeAria2Label' | 'download.modeIwaradlLabel'; hint: 'download.modeOthersHint' | 'download.modeBrowserHint' | 'download.modeAria2Hint' | 'download.modeIwaradlHint' }> = [
    { value: 2, label: 'download.modeBrowserLabel', hint: 'download.modeBrowserHint' },
    { value: 3, label: 'download.modeOthersLabel', hint: 'download.modeOthersHint' },
    { value: 0, label: 'download.modeAria2Label', hint: 'download.modeAria2Hint' },
    { value: 1, label: 'download.modeIwaradlLabel', hint: 'download.modeIwaradlHint' }
]

export function DownloadTab({ config }: { config: Config }): ReactElement {
    const { save } = useSaver()
    const { t } = useTranslation()
    const [newPriorityName, setNewPriorityName] = useState('')
    const [newPriorityValue, setNewPriorityValue] = useState('0')

    const priorityEntries = Object.entries(config.priority)
    const mode = DOWNLOAD_MODES.find((item) => item.value === config.downloadType)

    return (
        <>
            <Section title={t('download.title')} note={mode ? t(mode.hint) : undefined}>
                <Row label={t('download.mode')}>
                    <SelectField value={String(config.downloadType)} options={DOWNLOAD_MODES.map((item) => ({ value: String(item.value), label: t(item.label) }))} onChange={(next) => save({ downloadType: Number(next) as DownloadType })} />
                </Row>
                {/* 只对浏览器内建通道生效：aria2 / iwaradl 的并发由守护进程自己控制 */}
                <Row label={t('download.concurrent')} hint={t('download.concurrentHint')}>
                    <NumberField value={config.browserConcurrentDownloads} min={BROWSER_CONCURRENCY_MIN} max={BROWSER_CONCURRENCY_MAX} onChange={(next) => save({ browserConcurrentDownloads: next })} />
                </Row>
                {/* 下载前检查：命中就会真的拦下这次下载（落一条 skipped 待办），属于下载行为 */}
                <Row label={t('download.linkCheck')} hint={t('download.linkCheckHint')}>
                    <Toggle label="" checked={config.checkDownloadLink} onChange={(next) => save({ checkDownloadLink: next })} />
                </Row>
                <Row label={t('download.autoMetadata')}>
                    <Toggle label="" checked={config.autoDownloadMetadata} onChange={(next) => save({ autoDownloadMetadata: next })} />
                </Row>
                <Row label={t('download.copySaveName')} hint={t('download.copySaveNameHint')}>
                    <Toggle label="" checked={config.autoCopySaveFileName} onChange={(next) => save({ autoCopySaveFileName: next })} />
                </Row>
            </Section>

            <Section title={t('download.proxyTitle')} note={t('download.proxyNote')}>
                <Row label={t('download.proxy')}>
                    <TextField value={config.downloadProxy} onChange={(next) => save({ downloadProxy: next })} mono placeholder={t('download.proxyPlaceholder')} />
                </Row>
                <Row label={t('download.proxyUser')}>
                    <TextField value={config.downloadProxyUsername} onChange={(next) => save({ downloadProxyUsername: next })} mono />
                </Row>
                <Row label={t('download.proxyPass')}>
                    <TextField value={config.downloadProxyPassword} onChange={(next) => save({ downloadProxyPassword: next })} mono type="password" />
                </Row>
            </Section>

            <Section title={t('download.pathTitle')} note={t('download.pathNote')}>
                <Row label={t('download.template')} stack hint={t('download.templateHint')}>
                    <TextField value={config.downloadPath} onChange={(next) => save({ downloadPath: next })} mono placeholder="/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4" />
                </Row>
                <Row label={t('download.preview')} stack>
                    <code className="preview">{replaceVariable(config.downloadPath.trim(), sampleVideo(t))}</code>
                </Row>
            </Section>

            <Section title={t('download.socialTitle')} note={t('download.socialNote')}>
                <Row label={t('download.autoFollow')} hint={t('download.autoFollowHint')}>
                    <Toggle label="" checked={config.autoFollow} onChange={(next) => save({ autoFollow: next })} />
                </Row>
                <Row label={t('download.autoLike')} hint={t('download.autoLikeHint')}>
                    <Toggle label="" checked={config.autoLike} onChange={(next) => save({ autoLike: next })} />
                </Row>
            </Section>

            <Section title={t('download.priorityTitle')} note={t('download.priorityNote')}>
                <Row label={t('download.checkPriority')}>
                    <Toggle label="" checked={config.checkPriority} onChange={(next) => save({ checkPriority: next })} />
                </Row>
                <Row label={t('download.preferredQuality')}>
                    <SelectField value={config.downloadPriority} options={[...new Set(['Source', ...priorityEntries.map(([name]) => name)])].map((name) => ({ value: name, label: name }))} onChange={(next) => save({ downloadPriority: next })} />
                </Row>
                <table className="data-table">
                    <thead>
                        <tr>
                            <th>{t('download.quality')}</th>
                            <th>{t('download.weight')}</th>
                            {/* 操作列表头留空（列宽 1% 由 CSS 收缩到内容宽度，见 options.css「数据表」） */}
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {priorityEntries.map(([name, value]) => (
                            <tr key={name}>
                                <td>
                                    <code>{name}</code>
                                </td>
                                <td>
                                    <NumberField value={value} onChange={(next) => save({ priority: { ...config.priority, [name]: next } })} />
                                </td>
                                <td className="actions">
                                    <button
                                        type="button"
                                        className="ghost danger"
                                        onClick={() => {
                                            const next = { ...config.priority }
                                            delete next[name]
                                            save({ priority: next })
                                        }}
                                    >
                                        {t('common.delete')}
                                    </button>
                                </td>
                            </tr>
                        ))}
                        <tr>
                            <td>
                                <input type="text" placeholder={t('download.newQuality')} value={newPriorityName} onChange={(event) => setNewPriorityName(event.target.value)} />
                            </td>
                            <td>
                                <input type="number" value={newPriorityValue} onChange={(event) => setNewPriorityValue(event.target.value)} />
                            </td>
                            <td className="actions">
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() => {
                                        const name = newPriorityName.trim()
                                        if (!name) return
                                        save({ priority: { ...config.priority, [name]: Number(newPriorityValue) || 0 } })
                                        setNewPriorityName('')
                                    }}
                                >
                                    {t('common.add')}
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </Section>
        </>
    )
}

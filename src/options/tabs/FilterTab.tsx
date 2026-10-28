/**
 * 过滤页签 —— MAIN 世界响应改写开关
 * 变更经 CONFIG_SYNC 实时下发到 iwara 页面，无需刷新
 *
 * 这一页只放「哪些视频出现在列表里」的开关。
 * 下载前检查（第三方网盘地址检测）不在这里：它会真的拦下一次下载，
 * 属于下载行为而不是列表改写——源项目也把它放在常规页的 download 分组。
 */
import type { ReactElement } from 'react'
import type { Config } from '../../shared/configSchema'
import { useTranslation } from 'react-i18next'
import { Row, Section, Toggle, useSaver } from '../widgets'

export function FilterTab({ config }: { config: Config }): ReactElement {
    const { save } = useSaver()
    const { t } = useTranslation()
    return (
        <Section title={t('filter.title')} note={t('filter.note')}>
            <Row label={t('filter.liked')} hint={t('filter.likedHint')}>
                <Toggle label="" checked={config.filterLikedVideos} onChange={(next) => save({ filterLikedVideos: next })} />
            </Row>
            <Row label={t('filter.unlistedFilter')} hint={t('filter.unlistedFilterHint')}>
                <Toggle label="" checked={config.filterUnlistedAndPrivate} onChange={(next) => save(next ? { filterUnlistedAndPrivate: true, addUnlistedAndPrivate: false } : { filterUnlistedAndPrivate: false })} />
            </Row>
            <Row label={t('filter.unlistedAdd')} hint={t('filter.unlistedAddHint')}>
                <Toggle label="" checked={config.addUnlistedAndPrivate} onChange={(next) => save(next ? { addUnlistedAndPrivate: true, filterUnlistedAndPrivate: false } : { addUnlistedAndPrivate: false })} />
            </Row>
        </Section>
    )
}

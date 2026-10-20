/**
 * 文件名清洗页签 —— sanitize 规则链开关（与后台 getDownloadPath 完全同管线）
 * NFKC → emoji → 组合变音记号折叠 → 非法字符 → 截断（TITLE/ALIAS 各自长度）
 */
import type { ReactElement } from 'react'
import type { Config } from '../../shared/configSchema'
import { useTranslation } from 'react-i18next'
import { NumberField, Row, Section, Toggle, useSaver } from '../widgets'

export function NameCleanTab({ config }: { config: Config }): ReactElement {
    const { save } = useSaver()
    const { t } = useTranslation()
    return (
        <Section title={t('clean.title')} note={t('clean.note')}>
            <Row label={t('clean.nfkc')}>
                <Toggle label="" checked={config.pathNormalize} onChange={(next) => save({ pathNormalize: next })} />
            </Row>
            <Row label={t('clean.emoji')} hint={t('clean.emojiHint')}>
                <Toggle label="" checked={config.pathReplaceEmojis} onChange={(next) => save({ pathReplaceEmojis: next })} />
            </Row>
            <Row label={t('clean.fold')} hint={t('clean.foldHint')}>
                <Toggle label="" checked={config.pathFoldMarks} onChange={(next) => save({ pathFoldMarks: next })} />
            </Row>
            <Row label={t('clean.sanitize')} hint={t('clean.sanitizeHint')}>
                <Toggle label="" checked={config.pathSanitize} onChange={(next) => save({ pathSanitize: next })} />
            </Row>
            <Row label={t('clean.truncate')}>
                <Toggle label="" checked={config.pathTruncate} onChange={(next) => save({ pathTruncate: next })} />
            </Row>
            <Row label={t('clean.titleMax')}>
                <NumberField value={config.pathTitleMaxLength} min={1} max={255} onChange={(next) => save({ pathTitleMaxLength: next || 72 })} />
            </Row>
            <Row label={t('clean.aliasMax')}>
                <NumberField value={config.pathAliasMaxLength} min={1} max={255} onChange={(next) => save({ pathAliasMaxLength: next || 64 })} />
            </Row>
        </Section>
    )
}

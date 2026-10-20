/**
 * 旧脚本**页面数据库**导入区块（迁移页签第一块）。
 *
 * 旧库（IndexedDB `IwaraDownloadTool`）在 iwara.tv origin，扩展后台看不到它；
 * 导入由后台转发给一个已打开的 iwara 标签页，由那边 content script 读取并分批回传。
 * 只能导入库存四表：旧脚本的**配置在 GM storage**（页面读不到，只能走粘贴/文件导入）。
 *
 * 状态自持：`busy` / `info` 都属于本区块，不与导出、导入共享（见 MigrateTab 的说明）。
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { EMPTY_LEGACY_COUNTS } from '../../../shared/legacyDb'
import type { LegacyDbInfo, LegacyImportSummary } from '../../../shared/legacyDb'
import { send } from '../../../messaging/hub'
import { changedValue } from '../../../shared/storageChanges'
import { LEGACY_DB_INFO_KEY } from '../../../shared/storageKeys'
import { ProgressBar, Section, relativeTime, storeLabel } from '../../widgets'

export function LegacyDbImport(): ReactElement {
    const { t: tr } = useTranslation()
    const [info, setInfo] = useState<LegacyDbInfo | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        void browser.storage.local.get(LEGACY_DB_INFO_KEY).then((stored) => {
            setInfo((stored[LEGACY_DB_INFO_KEY] as LegacyDbInfo | undefined) ?? null)
            setLoaded(true)
        })
        const onChanged = (changes: { [key: string]: unknown }, areaName: string): void => {
            if (areaName !== 'local' || !(LEGACY_DB_INFO_KEY in changes)) return
            const next = changedValue(changes, LEGACY_DB_INFO_KEY)
            setInfo((next as LegacyDbInfo | undefined) ?? null)
        }
        browser.storage.onChanged.addListener(onChanged)
        return () => browser.storage.onChanged.removeListener(onChanged)
    }, [])

    const counts = info?.counts ?? EMPTY_LEGACY_COUNTS
    const total = counts.videos + counts.follows + counts.friends + counts.idmap
    const progress = info?.progress ?? null
    /** 进度文案与进度条共用同一份：分开算两遍必然在 total=0 这类边界上漂移 */
    const progressText = busy ? (progress ? tr('migrate.legacyProgress', { store: storeLabel(progress.store, tr), done: progress.done, total: progress.total || '?' }) : tr('migrate.importing')) : null
    const progressValue = progress && progress.total > 0 ? progress.done / progress.total : undefined

    const run = async (): Promise<void> => {
        setBusy(true)
        try {
            const summary = await send<LegacyImportSummary>({ type: 'IMPORT_LEGACY_DB', payload: {} })
            // 如实汇报：结构不合规 / 写入失败都要说，不能只报成功数
            const notes: string[] = []
            if (summary.skipped > 0) notes.push(tr('migrate.skippedInvalid', { n: summary.skipped }))
            if (summary.failed > 0) notes.push(tr('migrate.unreadable', { n: summary.failed }))
            const suffix = notes.length > 0 ? tr('migrate.noteSeparator') + notes.join(tr('migrate.keySeparator')) : ''
            const message = tr('migrate.imported', { videos: summary.videos, follows: summary.follows, friends: summary.friends, idmap: summary.idmap }) + suffix
            if (summary.failed > 0) toast.warning(message, { duration: 12000 })
            else toast.success(message)
        } catch (error) {
            toast.error(tr('migrate.importFailed', { message: error instanceof Error ? error.message : String(error) }), { duration: 6000 })
        } finally {
            setBusy(false)
        }
    }

    return (
        <Section title={tr('migrate.legacyTitle')} note={tr('migrate.legacyNote')}>
            {!loaded ? (
                <p className="note">{tr('migrate.legacyLoading')}</p>
            ) : info === null ? (
                <p className="note">{tr('migrate.legacyNeverScanned')}</p>
            ) : info.found ? (
                <p className="note">
                    {tr('migrate.legacyFound', { videos: counts.videos, follows: counts.follows, friends: counts.friends, idmap: counts.idmap, scanned: relativeTime(info.scannedAt) })}
                    {info.importedAt ? tr('migrate.legacyImportedAt', { time: relativeTime(info.importedAt) }) : ''}
                </p>
            ) : (
                <p className="note">{tr('migrate.legacyNotFound')}</p>
            )}
            {/* 进度：大库分页导入可能持续数分钟，必须有可见反馈。
                首次上报前 `progress` 为 null → 不确定态；已知本表总数时走确定态。 */}
            {progressText ? (
                <>
                    <ProgressBar value={progressValue} label={progressText} testId="legacy-import-progress" />
                    <p className="note">{progressText}</p>
                </>
            ) : null}
            <div className="action-row">
                <button type="button" className="primary" disabled={busy} onClick={() => void run()}>
                    {busy ? tr('migrate.importing') : info?.found && total > 0 ? tr('migrate.importCount', { n: total }) : tr('migrate.importStart')}
                </button>
            </div>
            <p className="note">{tr('migrate.legacyFootnote')}</p>
        </Section>
    )
}

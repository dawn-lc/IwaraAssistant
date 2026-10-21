/**
 * 高级页签 —— 页面界面 / 批量入库 / 扩展行为 / 实验性功能 / 工具（链接检查、MediaCenter）
 *
 * 与旧版的界面修正：
 * - 批量入库的状态行以前会渲染成「已结束：」+ 空消息（null 与空串被当成有状态）；
 *   现在按 `running / kind / message` 组合出明确文案，初始不渲染。
 * - MediaCenter 区块以前常驻，但 note 写着「开启后才有」；现在真实按
 *   `experimentalFeatures` 门控（关闭时只留一行说明）。
 * - 链接检查原来输入框与按钮各占一行且留下大片空白；现在同一行内输入 + 按钮 + 结果徽章。
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Config } from '../../shared/configSchema'
import type { LanguagePref } from '../../shared/i18n'
import { LANGUAGES, setLanguagePref } from '../../shared/i18n'
import { send } from '../../messaging/hub'
import { Badge, ProgressBar, Row, Section, SelectField, TextField, Toggle, useSaver } from '../widgets'

interface SyncState {
    running: boolean
    kind: 'all' | 'subscribed' | null
    page: number
    succeeded: number
    failed: number
    message: string
}

interface MediaSyncResult {
    total: number
    pushed: number
    failed: number
    /** 一条都没推成功时的全局原因（未授权 / 端点不可达）；有它才能解释「N 条失败」 */
    reason?: string
}

interface LinkCheckResult {
    status: number
    ok: boolean
    reason?: string
}

export function AdvancedTab({ config }: { config: Config }): ReactElement {
    const { save } = useSaver()
    const { t } = useTranslation()
    const [sync, setSync] = useState<SyncState | null>(null)
    // 三个区块的进行中状态**各自独立**。
    // 曾经是一个 `'all' | 'subscribed' | 'media' | 'link' | null` 共用：文案没串台（每处都判自己的 id），
    // 但禁用是跨区块的——点「检查可达性」（HEAD 请求，1 秒）会连带把「遍历全站视频列表」禁掉；
    // 反过来，全站遍历跑几分钟期间也没法检查一个链接。三个动作互不竞争资源，没理由互相掣肘。
    // 区块内仍需互斥：遍历的两颗按钮共用后台同一个同步状态机，必须二选一。
    const [syncBusy, setSyncBusy] = useState<'all' | 'subscribed' | null>(null)
    const [linkBusy, setLinkBusy] = useState(false)
    const [mediaBusy, setMediaBusy] = useState(false)
    const [mediaResult, setMediaResult] = useState<MediaSyncResult | null>(null)
    const [linkInput, setLinkInput] = useState('')
    const [linkResult, setLinkResult] = useState<LinkCheckResult | null>(null)

    // 遍历进度轮询（后台写 storage.local.syncProgress；任务运行期间每 2s 拉一次）
    useEffect(() => {
        let timer: number | undefined
        const poll = async (): Promise<void> => {
            try {
                const state = await send<SyncState>({ type: 'GET_SYNC_STATE', payload: {} })
                setSync(state)
                if (state.running) timer = window.setTimeout(() => void poll(), 2000)
            } catch {
                // 后台暂不可用：停止轮询
            }
        }
        void poll()
        return () => {
            if (timer !== undefined) window.clearTimeout(timer)
        }
    }, [])

    const startSync = async (kind: 'all' | 'subscribed'): Promise<void> => {
        setSyncBusy(kind)
        try {
            const state = await send<SyncState>({
                type: kind === 'all' ? 'SYNC_ALL_VIDEOS' : 'SYNC_SUBSCRIBED',
                payload: {}
            })
            setSync(state)
        } catch (error) {
            setSync({
                running: false,
                kind: null,
                page: 0,
                succeeded: 0,
                failed: 0,
                message: t('common.failed', { message: error instanceof Error ? error.message : String(error) })
            })
        } finally {
            setSyncBusy(null)
        }
    }

    const syncMedia = async (): Promise<void> => {
        setMediaBusy(true)
        setMediaResult(null)
        try {
            setMediaResult(await send<MediaSyncResult>({ type: 'SYNC_MEDIA_CENTER', payload: {} }))
        } catch (error) {
            setMediaResult(null)
            toast.error(t('advanced.mediaSyncFailed', { message: error instanceof Error ? error.message : String(error) }), { duration: 6000 })
        } finally {
            setMediaBusy(false)
        }
    }

    const checkLink = async (): Promise<void> => {
        setLinkBusy(true)
        setLinkResult(null)
        try {
            setLinkResult(await send<LinkCheckResult>({ type: 'CHECK_LINK', payload: { url: linkInput } }))
        } catch (error) {
            setLinkResult({ status: 0, ok: false, reason: error instanceof Error ? error.message : String(error) })
        } finally {
            setLinkBusy(false)
        }
    }

    /** 后台 pageSync 写的中文进度已由后台本地化，这里只补「跑完后没有 message」的兜底文案 */
    const syncText = ((): string | null => {
        if (!sync) return null
        if (sync.running && sync.kind) {
            return t('advanced.syncRunning', { kind: t(sync.kind === 'all' ? 'advanced.syncKindAll' : 'advanced.syncKindSubscribed'), page: sync.page + 1, ok: sync.succeeded, failed: sync.failed })
        }
        if (sync.message) return sync.message
        if (sync.kind) return t('advanced.syncDone', { kind: t(sync.kind === 'all' ? 'advanced.syncKindAll' : 'advanced.syncKindSubscribed'), ok: sync.succeeded, failed: sync.failed })
        return null
    })()

    return (
        <>
            <Section title={t('advanced.pageTitle')} note={t('advanced.pageNote')}>
                <Row label={t('advanced.beautify')} hint={t('advanced.beautifyHint')}>
                    <Toggle label="" checked={config.enableBeautify} onChange={(next) => save({ enableBeautify: next })} />
                </Row>
                <Row label={t('advanced.widescreen')} hint={t('advanced.widescreenHint')}>
                    <Toggle label="" checked={config.enableWidescreen} onChange={(next) => save({ enableWidescreen: next })} />
                </Row>
                <Row label={t('advanced.injectCheckbox')} hint={t('advanced.injectCheckboxHint')}>
                    <Toggle label="" checked={config.autoInjectCheckbox} onChange={(next) => save({ autoInjectCheckbox: next })} />
                </Row>
                <Row label={t('advanced.autoCollapse')} hint={t('advanced.autoCollapseHint')}>
                    <Toggle label="" checked={config.autoCollapseMenu} onChange={(next) => save({ autoCollapseMenu: next })} />
                </Row>
            </Section>

            <Section title={t('advanced.syncTitle')} note={t('advanced.syncNote')}>
                <div className="action-row">
                    <button type="button" disabled={syncBusy !== null || sync?.running === true} onClick={() => void startSync('all')}>
                        {syncBusy === 'all' ? t('advanced.submitting') : t('advanced.syncAll')}
                    </button>
                    <button type="button" disabled={syncBusy !== null || sync?.running === true} onClick={() => void startSync('subscribed')}>
                        {syncBusy === 'subscribed' ? t('advanced.submitting') : t('advanced.syncSubscribed')}
                    </button>
                    {sync?.running ? <Badge tone="warn">{t('advanced.running')}</Badge> : null}
                </div>
                {/* 遍历只知当前页、不知总页数 → 不确定态；跑完后条消失，只留下结果文案 */}
                {sync?.running ? <ProgressBar label={syncText ?? t('advanced.running')} testId="sync-progress" /> : null}
                {syncText ? <p className="note">{syncText}</p> : null}
            </Section>

            {/* 「关注扩展作者」不是实验性功能（不受 experimentalFeatures 门控，且默认开启），
                放在「实验性功能」区块里会被 note 误导，因此单列一区 */}
            <Section title={t('advanced.behaviorTitle')} note={t('advanced.behaviorNote')}>
                <Row label={t('advanced.promote')} hint={t('advanced.promoteHint')}>
                    <Toggle label="" checked={config.promoteScriptAuthor} onChange={(next) => save({ promoteScriptAuthor: next })} />
                </Row>
                <Row label={t('advanced.keepAlive')} hint={t('advanced.keepAliveHint')}>
                    <Toggle label="" checked={config.keepBackgroundAlive} onChange={(next) => save({ keepBackgroundAlive: next })} />
                </Row>
                <Row label={t('app.language')} hint={t('app.languageHint')}>
                    <SelectField
                        testId="ui-language"
                        value={config.language}
                        options={[{ value: 'auto', label: t('app.languageAuto') }, ...LANGUAGES.map((item) => ({ value: item.code, label: item.label }))]}
                        onChange={(next) => {
                            // 先切 UI 再写配置：保存 toast 会用新语言渲染
                            setLanguagePref(next as LanguagePref)
                            save({ language: next as LanguagePref })
                        }}
                    />
                </Row>
            </Section>

            <Section title={t('advanced.experimentalTitle')} note={t('advanced.experimentalNote')}>
                <Row label={t('advanced.experimentalEnable')} hint={t('advanced.experimentalEnableHint')}>
                    <Toggle label="" checked={config.experimentalFeatures} onChange={(next) => save({ experimentalFeatures: next })} />
                </Row>
                <Row label={t('advanced.unsafe')} hint={t('advanced.unsafeHint')}>
                    <Toggle label="" checked={config.enableUnsafeMode} onChange={(next) => save({ enableUnsafeMode: next })} />
                </Row>
                <Row label={t('advanced.debug')} hint={t('advanced.debugHint')}>
                    <Toggle label="" checked={config.isDebug} onChange={(next) => save({ isDebug: next })} />
                </Row>
            </Section>

            <Section title={t('advanced.linkTitle')} note={t('advanced.linkNote')}>
                <Row label={t('advanced.link')} hint={t('advanced.linkHint')}>
                    <TextField value={linkInput} onChange={setLinkInput} mono placeholder="https://example.com/file.mp4" />
                </Row>
                <div className="action-row">
                    <button type="button" disabled={linkBusy || linkInput.trim() === ''} onClick={() => void checkLink()}>
                        {linkBusy ? t('advanced.checking') : t('advanced.check')}
                    </button>
                    {linkResult ? <Badge tone={linkResult.ok ? 'ok' : 'danger'}>{linkResult.ok ? t('advanced.reachable', { status: linkResult.status }) : t('advanced.unreachable', { reason: linkResult.reason ?? `HTTP ${linkResult.status}` })}</Badge> : null}
                </div>
            </Section>

            {/* 真实按开关门控：note 说「开启后才有」就必须真的不显示 */}
            {config.experimentalFeatures ? (
                <Section title={t('advanced.mediaTitle')} note={t('advanced.mediaNote')}>
                    <Row label={t('advanced.mediaApi')} hint={t('advanced.mediaApiHint')}>
                        <TextField value={config.mediaCenterApi} onChange={(next) => save({ mediaCenterApi: next })} mono placeholder="http://127.0.0.1:3000" />
                    </Row>
                    <Row label={t('advanced.mediaApiKey')}>
                        <TextField value={config.mediaCenterApiKey} onChange={(next) => save({ mediaCenterApiKey: next })} mono type="password" />
                    </Row>
                    <div className="action-row">
                        <button type="button" disabled={mediaBusy || config.mediaCenterApi.trim() === ''} onClick={() => void syncMedia()}>
                            {mediaBusy ? t('advanced.syncing') : t('advanced.syncRecords')}
                        </button>
                        {mediaResult ? <Badge tone={mediaResult.failed > 0 ? 'warn' : 'ok'}>{t('advanced.mediaSynced', { total: mediaResult.total, pushed: mediaResult.pushed, failed: mediaResult.failed })}</Badge> : null}
                    </div>
                    {/* 全失败时的真实原因：只说「N 条失败」等于什么都不说 */}
                    {mediaResult?.reason ? <p className="note">{mediaResult.reason}</p> : null}
                </Section>
            ) : null}
        </>
    )
}

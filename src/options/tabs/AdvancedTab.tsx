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
import { useState } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Config } from '../../shared/configSchema'
import type { LanguagePref } from '../../shared/i18n'
import { LANGUAGES, setLanguagePref } from '../../shared/i18n'
import { IDLE_MEDIA_SYNC_PROGRESS, mediaSyncRatio, parseMediaSyncProgress, type MediaSyncProgress, type MediaTaskStart } from '../../shared/mediaSyncProgress'
import { IDLE_SYNC_CURSOR, IDLE_SYNC_STATE, parseSyncCursorOrIdle, parseSyncState } from '../../shared/syncState'
import type { SyncCursor, SyncState } from '../../shared/syncState'
import { MEDIA_SYNC_PROGRESS_KEY, SYNC_CURSOR_KEY, SYNC_PROGRESS_KEY } from '../../shared/storageKeys'
import { send } from '../../messaging/hub'
import { Badge, ProgressBar, Row, Section, SelectField, TextField, Toggle, useSaver, useStorageSnapshot } from '../widgets'

interface LinkCheckResult {
    status: number
    ok: boolean
    reason?: string
}

/**
 * 启动遍历的返回。**不含遍历结果**：全站遍历是小时量级，Chrome 对单次事件有 5 分钟上限，
 * 所以后台只占位就返回，进度与结果走 `storage.local` 快照（页面订阅 onChanged）。
 */
interface SyncStartResult {
    started: boolean
    reason?: 'already-running' | 'not-logged-in'
}

export function AdvancedTab({ config }: { config: Config }): ReactElement {
    const { save } = useSaver()
    const { t } = useTranslation()
    // 三个区块的进行中状态**各自独立**。
    // 曾经是一个 `'all' | 'subscribed' | 'media' | 'link' | null` 共用：文案没串台（每处都判自己的 id），
    // 但禁用是跨区块的——点「检查可达性」（HEAD 请求，1 秒）会连带把「遍历全站视频列表」禁掉；
    // 反过来，全站遍历跑几分钟期间也没法检查一个链接。三个动作互不竞争资源，没理由互相掣肘。
    // 区块内仍需互斥：遍历的两颗按钮共用后台同一个同步状态机，必须二选一。
    const [syncBusy, setSyncBusy] = useState<'all' | 'subscribed' | null>(null)
    const [linkBusy, setLinkBusy] = useState(false)
    // null = 空闲；'sync' / 'backfill' = 本次点击起的是哪一轮（按钮文案用）
    const [mediaBusy, setMediaBusy] = useState<'sync' | 'backfill' | null>(null)
    const [linkInput, setLinkInput] = useState('')
    const [linkResult, setLinkResult] = useState<LinkCheckResult | null>(null)

    // 遍历进度：**订阅 `storage.local` 快照**（后台每页 `report()` 一次就推送过来）。
    //
    // 以前是每 2s 发 `GET_SYNC_STATE`：长任务期间的消息往返不受扩展控制，一次被卡住
    // 进度就停在旧值；而且 `catch` 之后不重建定时器 ⇒ 轮询**永久停止**（一次瞬时失败
    // 之后就再也不更新，也没有任何机制让它恢复）。快照订阅没有这两个问题。
    const sync = useStorageSnapshot<SyncState>({ area: 'local', key: SYNC_PROGRESS_KEY, parse: parseSyncState, initial: IDLE_SYNC_STATE })

    /**
     * 断点游标：全站遍历连续完成到哪一页（后台每页写一次 `storage.session`）。
     *
     * 有它，「上次遍历被中断」才不是一句空话——主按钮会变成「继续（第 N 页起）」。
     * 游标**跑完就删**，所以「有游标」⇔「上一次没跑完且至少完成过一页」。
     */
    const cursor = useStorageSnapshot<SyncCursor>({ area: 'session', key: SYNC_CURSOR_KEY, parse: parseSyncCursorOrIdle, initial: IDLE_SYNC_CURSOR })
    const hasCursor = cursor.nextPage > 0

    /**
     * 「在跑」= 本次点击 + 后台快照。加后者是因为 `syncBusy` 只是页面 state：
     * 切到别的页签再回来（组件重挂载）会丢，而遍历还在跑。
     * 与 mediaRunning / 好友审批 / 旧库导入同一条判据。
     */
    const syncRunning = syncBusy !== null || sync.running

    const startSync = async (kind: 'all' | 'subscribed', from: 'resume' | 'restart' = 'resume'): Promise<void> => {
        setSyncBusy(kind)
        try {
            // 返回值只有「起没起来」（后台 fire-and-forget）；失败原因（未登录 / 已在跑）
            // 由后台写进快照的 message，页面当普通状态行展示，不伪造一份 state。
            // 起点只说意图：游标在 storage.session、由后台读写（页面自己维护一份必然漂移）。
            if (kind === 'all') await send<SyncStartResult>({ type: 'SYNC_ALL_VIDEOS', payload: { from } })
            else await send<SyncStartResult>({ type: 'SYNC_SUBSCRIBED', payload: {} })
        } catch (error) {
            // 失败原因用 toast 告知（消息通道失败时后台的真实状态本就该继续由快照驱动）。
            toast.error(t('common.failed', { message: error instanceof Error ? error.message : String(error) }), { duration: 6000 })
        } finally {
            setSyncBusy(null)
        }
    }

    /**
     * 暂停 / 继续 / 停止当前这一轮遍历。
     *
     * 后台只改**意图**并把状态写进快照，真正生效在页间闸门（一页请求已经在飞，
     * 硬取消既救不回时间，也会让断点游标与「已处理」集合对不上）。
     */
    const controlSync = async (action: 'pause' | 'resume' | 'stop'): Promise<void> => {
        try {
            const result = await send<{ applied: boolean }>({ type: 'CONTROL_SITE_SYNC', payload: { action } })
            // 点下去的同时这一轮刚好跑完：如实说，不让按钮「点了没反应」
            if (!result.applied) toast.message(t('advanced.syncAlreadyStopped'))
        } catch (error) {
            toast.error(t('common.failed', { message: error instanceof Error ? error.message : String(error) }), { duration: 6000 })
        }
    }

    // MediaCenter 同步进度：同样订阅快照（`storage.session`）。
    // 初值走消息：后台要在那里做「残骸归一」（上次同步被中断 → running:false + interrupted）。
    const mediaProgress = useStorageSnapshot<MediaSyncProgress>({
        area: 'session',
        key: MEDIA_SYNC_PROGRESS_KEY,
        parse: parseMediaSyncProgress,
        initial: IDLE_MEDIA_SYNC_PROGRESS,
        readInitial: async () => await send<MediaSyncProgress>({ type: 'GET_MEDIA_SYNC_STATE', payload: {} })
    })

    /**
     * 「在跑」= 本次点击 + 后台快照。加后者是因为 `mediaBusy` 只是页面 state：
     * 切到别的页签再回来（组件重挂载）会丢，而同步还在跑——那正是好友审批
     * 修过的同一个 bug（按钮变回可点、进度条消失）。
     */
    const mediaRunning = mediaBusy !== null || mediaProgress?.running === true

    /**
     * 起一轮 MediaCenter 任务（同步 / 反向补齐）。
     *
     * 后台只回「起没起来」：整轮任务 fire-and-forget（Chrome 单事件 5 分钟上限，12 万条要十几分钟），
     * 进度与**结论**都从快照里读。页面不再留一份本地结果——两份结论必然漂移，
     * 而「上一轮到底成功了多少条」只有后台知道。
     */
    const startMediaTask = async (kind: 'sync' | 'backfill'): Promise<void> => {
        setMediaBusy(kind)
        try {
            const started = await send<MediaTaskStart>({ type: kind === 'backfill' ? 'BACKFILL_MEDIA_CENTER' : 'SYNC_MEDIA_CENTER', payload: {} })
            // 未配置 / 已在跑 / 端点地址非法：后台给的是可操作原因，直接展示，不静默什么都不做
            if (!started.started && started.reason) toast.error(started.reason, { duration: 6000 })
        } catch (error) {
            toast.error(t('advanced.mediaSyncFailed', { message: error instanceof Error ? error.message : String(error) }), { duration: 6000 })
        } finally {
            setMediaBusy(null)
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

    /** 同步中进度文案：阶段一（扫描远端列表）与阶段二（逐条推送）的单位与含义不同 */
    const mediaProgressText = ((): string => {
        if (mediaProgress?.stage === 'push') return t('advanced.mediaSyncPush', { done: mediaProgress.done, total: mediaProgress.total })
        if (mediaProgress?.stage === 'backfill') return t('advanced.mediaBackfillProgress', { done: mediaProgress.done, total: mediaProgress.total })
        if (mediaProgress && mediaProgress.total > 0) return t('advanced.mediaSyncScan', { done: mediaProgress.done, total: mediaProgress.total })
        return t('advanced.mediaSyncScanUnknown', { done: mediaProgress?.done ?? 0 })
    })()

    /** 后台 pageSync 写的中文进度已由后台本地化，这里只补「跑完后没有 message」的兜底文案 */
    const syncText = ((): string | null => {
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
                    {/* 有断点时主按钮就是「继续」——那是用户此刻最想要的动作；
                        「从头开始」单独一颗 ghost，避免它被顺手点掉、把手上的进度作废 */}
                    <button type="button" disabled={syncRunning} onClick={() => void startSync('all', 'resume')}>
                        {syncBusy === 'all' ? t('advanced.submitting') : hasCursor ? t('advanced.syncResume', { page: cursor.nextPage + 1 }) : t('advanced.syncAll')}
                    </button>
                    {hasCursor ? (
                        <button type="button" className="ghost" disabled={syncRunning} onClick={() => void startSync('all', 'restart')}>
                            {t('advanced.syncRestart')}
                        </button>
                    ) : null}
                    <button type="button" disabled={syncRunning} onClick={() => void startSync('subscribed')}>
                        {syncBusy === 'subscribed' ? t('advanced.submitting') : t('advanced.syncSubscribed')}
                    </button>
                    {syncRunning ? (
                        <>
                            {/* 暂停/继续共用一颗按钮：此刻最想要的动作只有一个，不用让用户在两颗之间选 */}
                            <button type="button" data-testid="sync-pause" onClick={() => void controlSync(sync.paused ? 'resume' : 'pause')}>
                                {sync.paused ? t('advanced.syncResumeRun') : t('advanced.syncPause')}
                            </button>
                            <button type="button" className="ghost" data-testid="sync-stop" onClick={() => void controlSync('stop')}>
                                {t('advanced.syncStop')}
                            </button>
                        </>
                    ) : null}
                    {syncRunning ? <Badge tone="warn">{sync.paused ? t('advanced.pausedLabel') : t('advanced.running')}</Badge> : null}
                </div>
                {sync.paused ? <p className="note">{t('advanced.syncPausedNote')}</p> : null}
                {/* 遍历只知当前页、不知总页数 → 不确定态；跑完后条消失，只留下结果文案 */}
                {syncRunning ? <ProgressBar label={syncText ?? t('advanced.running')} testId="sync-progress" /> : null}
                {syncText ? <p className="note">{syncText}</p> : null}
                {/* 断点提示：只说事实（停在第几页 + 继续不会重复写库），不承诺「一定补齐」 */}
                {hasCursor && !syncRunning ? <p className="note">{t('advanced.syncCursorNote', { page: cursor.nextPage + 1 })}</p> : null}
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

            <Section title={t('advanced.bridgeTitle')} note={t('advanced.bridgeNote')}>
                <Row label={t('advanced.bridgeEnable')} hint={t('advanced.bridgeEnableHint')}>
                    <Toggle label="" checked={config.debugBridgeEnabled} onChange={(next) => save({ debugBridgeEnabled: next })} />
                </Row>
                <Row label={t('advanced.bridgePort')} hint={t('advanced.bridgePortHint')}>
                    <TextField value={String(config.debugBridgePort)} onChange={(next) => save({ debugBridgePort: Number.parseInt(next, 10) || 8765 })} mono />
                </Row>
                <p className="note">{t('advanced.bridgeHelp')}</p>
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
                        <button type="button" disabled={mediaRunning || config.mediaCenterApi.trim() === ''} onClick={() => void startMediaTask('sync')}>
                            {mediaBusy === 'sync' ? t('advanced.syncing') : t('advanced.syncRecords')}
                        </button>
                        {/* 远端有、本地库没有的记录（扫描导入的存量）：常规同步永远碰不到，只能反向补齐 */}
                        <button type="button" className="ghost" data-testid="media-backfill" disabled={mediaRunning || config.mediaCenterApi.trim() === ''} onClick={() => void startMediaTask('backfill')}>
                            {mediaBusy === 'backfill' ? t('advanced.mediaBackfilling') : t('advanced.mediaBackfill')}
                        </button>
                        {mediaProgress?.result ? <Badge tone={mediaProgress.result.failed > 0 ? 'warn' : 'ok'}>{mediaProgress.result.kind === 'backfill' ? t('advanced.mediaBackfilled', { total: mediaProgress.result.total, ok: mediaProgress.result.ok, failed: mediaProgress.result.failed, skipped: mediaProgress.result.skipped }) : t('advanced.mediaSynced', { total: mediaProgress.result.total, pushed: mediaProgress.result.ok, failed: mediaProgress.result.failed })}</Badge> : null}
                    </div>
                    <p className="note">{t('advanced.mediaBackfillHint')}</p>
                    {/* 总量已知（服务端 `pagination.total` / 映射条数）→ 确定态；未知 → 不确定态 */}
                    {mediaRunning ? <ProgressBar value={mediaSyncRatio(mediaProgress)} label={mediaProgressText} testId="media-sync-progress" /> : null}
                    {/* 上次同步被打断（扩展重载/关闭）：明确告知，而不是让界面无声无息 */}
                    {!mediaRunning && mediaProgress?.interrupted ? <p className="note">{t('advanced.mediaSyncInterrupted')}</p> : null}
                    {/* 全失败时的真实原因：只说「N 条失败」等于什么都不说 */}
                    {mediaProgress?.result?.reason ? <p className="note">{mediaProgress.result.reason}</p> : null}
                </Section>
            ) : null}
        </>
    )
}

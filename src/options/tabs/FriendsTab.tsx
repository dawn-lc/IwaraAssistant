/**
 * 好友页签 —— 一键审批（原 features/friendRequests.ts 的 UI 侧）。
 *
 * 结构：参数 → 条件清单 → 执行与结果。
 * 条件清单用 `.check-list /.check-row`（不再是 `.kv-list`——那是「键值表」的语义，
 * 之前复用它导致复选框列表和权重表共用一套样式）。
 *
 * **整块只由一个数据源驱动**：后台的审批快照（`FriendApproveProgress`）。
 * - 启动只回 `{ started }`，所以本页**不依赖消息响应时长**（Chrome 对单个事件有 5 分钟
 *   上限，而审批可能更久）；结果也从快照里读。
 * - `running` 只在真在跑时为 true（后台以内存任务对象为唯一真相），
 *   所以不存在「切走再回来看到一个假的转圈」。
 * - 进度靠**订阅 `storage.session` 快照**（不是轮询）：后台每次写入都会推送过来，
 *   发送时机与长任务的消息往返无关，也不会因一次失败就永久停更。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { Config } from '../../shared/configSchema'
import { BUILTIN_APPROVAL_CONDITIONS, approvalConditionParams } from '../../shared/approvalConditions'
import { friendApproveView, IDLE_FRIEND_APPROVE_PROGRESS, parseFriendApproveProgress, type FriendApproveProgress } from '../../shared/approvalProgress'
import { FRIEND_APPROVE_PROGRESS_KEY } from '../../shared/storageKeys'
import { useTranslation } from 'react-i18next'
import { send } from '../../messaging/hub'
import { Badge, CheckRow, ProgressBar, Row, Section, SelectField, TextField, useSaver, useStorageSnapshot } from '../widgets'

/** 启动接口的返回。**不是**审批结果（理由见文件头） */
interface StartResult {
    started: boolean
    error?: string
}

export function FriendsTab({ config }: { config: Config }): ReactElement {
    const { save } = useSaver()
    const { t } = useTranslation()
    const [starting, setStarting] = useState(false)

    /**
     * 审批快照：**订阅 `storage.session`**（后台每次 `saveRecord` 都会推送过来）。
     *
     * 原来是每 1s 发一条 `GET_FRIEND_APPROVE_STATE`：长任务期间的消息往返不受扩展控制，
     * 一次被卡住进度就停；而且 `catch` 之后不重建定时器 ⇒ 轮询**永久停止**。
     * 初值走消息：后台在 `readFriendApproveProgress()` 里做残骸归一（进程被杀 → aborted）。
     */
    const snapshot = useStorageSnapshot<FriendApproveProgress>({
        area: 'session',
        key: FRIEND_APPROVE_PROGRESS_KEY,
        parse: parseFriendApproveProgress,
        initial: IDLE_FRIEND_APPROVE_PROGRESS,
        readInitial: async () => await send<FriendApproveProgress>({ type: 'GET_FRIEND_APPROVE_STATE', payload: {} })
    })
    /** 本地合成的「启动被拒」错误：快照属于后台，前端自己拼一份会与它打架 */
    const [localError, setLocalError] = useState<string | null>(null)

    const enabled = new Set(config.friendRequestApprovalConditions)

    const toggleCondition = (id: string, checked: boolean): void => {
        const next = checked ? [...config.friendRequestApprovalConditions, id] : config.friendRequestApprovalConditions.filter((item) => item !== id)
        save({ friendRequestApprovalConditions: next })
    }

    const runApprove = async (): Promise<void> => {
        setStarting(true)
        setLocalError(null)
        try {
            const response = await send<StartResult>({ type: 'APPROVE_FRIEND_REQUESTS', payload: {} })
            // 「已经在跑」这类拒绝直接提示，不必让用户等一拍才看到
            if (!response.started && response.error) setLocalError(response.error)
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : String(error))
        } finally {
            setStarting(false)
        }
    }

    const needsEvidence = enabled.has('commentedForumThread')
    const { running, aborted, ratio, result } = friendApproveView(snapshot)
    const progressLabel = snapshot.phase === 'deciding' ? t('friends.progressLabel', { done: snapshot.done, total: snapshot.total, approved: snapshot.approved, skipped: snapshot.skipped, failed: snapshot.failed }) : t('friends.collecting')

    return (
        <>
            <Section title={t('friends.title')} note={t('friends.note')}>
                <Row label={t('friends.mode')} hint={t('friends.modeHint')}>
                    <SelectField
                        value={config.friendRequestApprovalMode}
                        options={[
                            { value: 'any', label: t('friends.modeAny') },
                            { value: 'all', label: t('friends.modeAll') }
                        ]}
                        onChange={(next) => save({ friendRequestApprovalMode: next as 'any' | 'all' })}
                    />
                </Row>
                {/* 仅 commentedForumThread 用到证据帖：不勾选该条件时不显示，避免无用项 */}
                {needsEvidence ? (
                    <Row label={t('friends.evidence')} hint={t('friends.evidenceHint')}>
                        <TextField value={config.friendApproveEvidenceThreadId} onChange={(next) => save({ friendApproveEvidenceThreadId: next })} mono placeholder={t('friends.evidencePlaceholder')} />
                    </Row>
                ) : null}
            </Section>

            <Section title={t('friends.conditions')} note={t('friends.conditionsNote')} actions={<Badge tone="plain">{t('friends.selected', { n: enabled.size, total: BUILTIN_APPROVAL_CONDITIONS.length })}</Badge>}>
                <div className="check-list">
                    {BUILTIN_APPROVAL_CONDITIONS.map((condition) => (
                        // 第二个参数不能省：`condition.recentlyActive` / `condition.established` 的文案带 `{days}`，
                        // i18next 对未提供的占位符是原样保留的——不传就会显示字面的「对方 {days} 天内活跃过」
                        <CheckRow key={condition.id} checked={enabled.has(condition.id)} onChange={(next) => toggleCondition(condition.id, next)} label={t(`condition.${condition.id}`, approvalConditionParams(condition.id))} code={condition.id} />
                    ))}
                </div>
                {/* 空条件 = 后台会直接拒绝执行；在这里先说清楚，而不是让用户点一次按钮才看到错误 */}
                {enabled.size === 0 ? <p className="note">{t('friends.needCondition')}</p> : null}
            </Section>

            <Section title={t('friends.execute')}>
                <div className="action-row">
                    {/* `starting` 只覆盖「请求已发出、快照还没回来」的那一小段，避免连点两次 */}
                    <button type="button" className="primary" data-testid="friend-approve-run" disabled={running || starting || enabled.size === 0} onClick={() => void runApprove()}>
                        {running ? t('friends.running') : t('friends.run')}
                    </button>
                    {running ? <Badge tone="warn">{t('advanced.running')}</Badge> : null}
                </div>
                {/* 只有真的在跑才显示：collecting 阶段总量未知，画百分比就是编造（走不确定态） */}
                {running ? <ProgressBar value={ratio} label={progressLabel} testId="friend-approve-progress" /> : null}
                {running ? <p className="note">{progressLabel}</p> : null}
                {/* 上一次跑到一半进程就没了：必须说出来，否则用户会把「停在 X/Y」当成自己的错觉 */}
                {aborted ? <p className="note">{t('friends.aborted')}</p> : null}
                {/* 启动被拒（已在跑 / 未选条件）：单独一行，不与后台结果混在一起 */}
                {localError ? <p className="error-text">✗ {localError}</p> : null}
                {result ? (
                    <div className={`result-box ${result.error ? 'warn' : 'ok'}`} data-testid="friend-approve-result">
                        {result.error ? <p className="error-text">✗ {result.error}</p> : null}
                        {result.lines.map((line) => (
                            <p key={line}>{line}</p>
                        ))}
                        {!result.error ? <p className="dim">{t('friends.summary', { total: result.total, approved: result.approved, skipped: result.skipped, failed: result.failed })}</p> : null}
                    </div>
                ) : null}
            </Section>
        </>
    )
}

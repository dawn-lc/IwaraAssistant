/**
 * RPC 端点页签 —— aria2 / iwaradl 端点与令牌 + 代理。
 *
 * 这里**不再有逐站点授权按钮**：host 权限已在 manifest 里一次性声明 `<all_urls>`
 * （docs/03「权限模型」）。逐端点申请只会给用户增加 N 次原生弹窗，而失败时的正确
 * 反馈在任务详情里（`shared/endpoint.ts` 会指出是端点不可达、还是权限被撤销）。
 *
 * 环境自检（源 `check()`）放在这里：源项目在页面加载与保存配置时跑一次，
 * 但扩展的 service worker 约 30 秒空闲就挂起，`boot()` 每次唤醒都重跑——
 * 在那里面做网络探测等于每 30 秒打一次 aria2。改成「打开本页签时跑一次 + 可手动重测」，
 * 频率可控而语义不变：仍是**在真正开始下载之前**指出配置错在哪。
 *
 * 「后端容量」也在这里：它回答的是「为什么明明设了同时下载数 3，却有 5 条在下」——
 * aria2 自己也有并发上限（`max-concurrent-downloads`），而且它的队列里可能有
 * 不是本扩展投递的任务。这些值只能从 RPC/API 读，靠猜只会把用户带向错的结论。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { Config } from '../../shared/configSchema'
import { useTranslation } from 'react-i18next'
import { send } from '../../messaging/hub'
import { Badge, Row, Section, TextField, formatBytes, useSaver } from '../widgets'

/** 与后台 `CheckResult` 对齐（只在 UI 边界声明，避免把后台模块拖进 options bundle） */
interface CheckResult {
    ok: boolean
    step: 'path' | 'aria2' | 'iwaradl' | 'browser' | null
    message: string
}

/** 与后台 `BackendStatsResult` 对齐（同样只在 UI 边界声明） */
type BackendRead<T> = { configured: false } | { configured: true; ok: true; stats: T } | { configured: true; ok: false; error: string }

interface BackendStatsResult {
    aria2: BackendRead<{ active: number; waiting: number; stopped: number; downloadSpeed: number; maxConcurrent?: number }>
    iwaradl: BackendRead<{ running: number; pending: number; completed: number; failed: number }>
}

/**
 * 一行后端状态：没配 / 读失败 / 正常 三种形态。
 *
 * 三者必须分开显示：把「没配置」显示成 0 会让用户以为后端空闲，
 * 把「连不上」显示成 0 会让他以为任务都已经停了。
 */
function BackendStatsLine<T>({ backend, format }: { backend: BackendRead<T> | undefined; format: (stats: T) => string }): ReactElement {
    const { t } = useTranslation()
    if (backend === undefined) return <span className="dim">{t('rpc.statsLoading')}</span>
    if (!backend.configured) return <span className="dim">{t('rpc.statsNotConfigured')}</span>
    if (!backend.ok) return <span className="error-text">{backend.error}</span>
    return <span className="mono">{format(backend.stats)}</span>
}

export function RpcTab({ config }: { config: Config }): ReactElement {
    const { save } = useSaver()
    const { t } = useTranslation()
    const [checking, setChecking] = useState(false)
    const [result, setResult] = useState<CheckResult | null>(null)
    const [stats, setStats] = useState<BackendStatsResult | null>(null)
    const [statsLoading, setStatsLoading] = useState(false)

    const runCheck = useCallback(async (): Promise<void> => {
        setChecking(true)
        try {
            setResult(await send<CheckResult>({ type: 'ENV_CHECK', payload: {} }))
        } catch (error) {
            // 后台不可用也要给出可读结论，而不是让按钮永远转圈
            setResult({ ok: false, step: null, message: error instanceof Error ? error.message : String(error) })
        } finally {
            setChecking(false)
        }
    }, [])

    /**
     * 读两个后端的容量与占用。
     *
     * 只拉**一次**（挂载时 + 手动点刷新）：aria2 的 `getGlobalStat` 是即时的，
     * 但不是免费的（WS 断开时走 HTTP）。想常驻实时数据应该做推送，而不是在这里轮询——
     * 轮询会让扩展页自己变成后台负载，而这只是一个诊断面板。
     */
    const runStats = useCallback(async (): Promise<void> => {
        setStatsLoading(true)
        try {
            setStats(await send<BackendStatsResult>({ type: 'GET_BACKEND_STATS', payload: {} }))
        } catch (error) {
            // 后台不可用：两个后端都给同一条可读错误，不留空白
            const detail = error instanceof Error ? error.message : String(error)
            setStats({ aria2: { configured: true, ok: false, error: detail }, iwaradl: { configured: true, ok: false, error: detail } })
        } finally {
            setStatsLoading(false)
        }
    }, [])

    // 打开本页签即自检一次（源：页面加载时 check()）；只在挂载时跑，不随配置变化重跑
    useEffect(() => {
        void runCheck()
        void runStats()
    }, [runCheck, runStats])

    return (
        <>
            <Section
                title={t('rpc.checkTitle')}
                note={t('rpc.checkNote')}
                actions={
                    <div className="action-row">
                        <button type="button" className="ghost" disabled={checking} onClick={() => void runCheck()}>
                            {checking ? t('rpc.checking') : t('rpc.check')}
                        </button>
                        {result ? <Badge tone={result.ok ? 'ok' : 'danger'}>{result.ok ? t('rpc.checkOk') : result.message}</Badge> : null}
                    </div>
                }
            />
            <Section title={t('rpc.aria2Title')} note={t('rpc.aria2Note')}>
                <Row label={t('rpc.aria2Path')} hint={t('rpc.aria2PathHint')}>
                    <TextField value={config.aria2Path} onChange={(next) => save({ aria2Path: next })} mono placeholder="http://127.0.0.1:6800/jsonrpc" />
                </Row>
                <Row label={t('rpc.aria2Token')}>
                    <TextField value={config.aria2Token} onChange={(next) => save({ aria2Token: next })} mono placeholder={t('rpc.aria2TokenPlaceholder')} />
                </Row>
            </Section>

            <Section title={t('rpc.iwaradlTitle')} note={t('rpc.iwaradlNote')}>
                <Row label={t('rpc.iwaradlPath')}>
                    <TextField value={config.iwaradlPath} onChange={(next) => save({ iwaradlPath: next })} mono placeholder="http://127.0.0.1:23456/api/tasks" />
                </Row>
                <Row label={t('rpc.token')}>
                    <TextField value={config.iwaradlToken} onChange={(next) => save({ iwaradlToken: next })} mono placeholder={t('rpc.tokenPlaceholder')} />
                </Row>
            </Section>

            <Section
                title={t('rpc.statsTitle')}
                note={t('rpc.statsNote')}
                actions={
                    <div className="action-row">
                        <button type="button" className="ghost" disabled={statsLoading} onClick={() => void runStats()}>
                            {statsLoading ? t('rpc.checking') : t('rpc.statsRefresh')}
                        </button>
                    </div>
                }
            >
                <Row label={t('rpc.statsAria2Label')}>
                    <BackendStatsLine backend={stats?.aria2} format={(s) => t('rpc.statsAria2', { active: s.active, waiting: s.waiting, speed: `${formatBytes(s.downloadSpeed)}/s`, max: s.maxConcurrent ?? t('rpc.statsUnknown') })} />
                </Row>
                <Row label={t('rpc.statsIwaradlLabel')}>
                    <BackendStatsLine backend={stats?.iwaradl} format={(s) => t('rpc.statsIwaradl', { running: s.running, pending: s.pending, completed: s.completed })} />
                </Row>
            </Section>

            <Section title={t('rpc.proxyTitle')} note={t('rpc.proxyNote')}>
                <Row label={t('rpc.proxy')}>
                    <TextField value={config.downloadProxy} onChange={(next) => save({ downloadProxy: next })} mono placeholder={t('rpc.proxyPlaceholder')} />
                </Row>
                <Row label={t('rpc.proxyUser')}>
                    <TextField value={config.downloadProxyUsername} onChange={(next) => save({ downloadProxyUsername: next })} mono />
                </Row>
                <Row label={t('rpc.proxyPass')}>
                    <TextField value={config.downloadProxyPassword} onChange={(next) => save({ downloadProxyPassword: next })} mono />
                </Row>
            </Section>
        </>
    )
}

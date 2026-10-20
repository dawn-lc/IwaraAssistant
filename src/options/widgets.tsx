/**
 * options 表单基础组件 —— 帮助即保存（docs/01：options 直写 storage，无集中保存按钮）
 *
 * 文案策略：界面文案统一走 `shared/i18n` 的字典（`src/shared/locales/*.json`），
 * 与页内菜单/右键菜单/系统通知同一份来源——`browser.i18n` 只留给 manifest 层
 * （扩展名、描述这类渲染前就要确定的元数据）。
 *
 * 两个刻意的设计：
 * 1. 保存反馈是**全局**的（`saveConfig` 直接调 sonner，见 `./toast.tsx`），任何页签的保存都有提示；
 *    页签不需要自己渲染保存状态。
 * 2. 文本/数字输入**防抖**后才写 storage：先前每敲一个字符就写盘 + 触发一次
 *    CONFIG_SYNC 广播到所有 iwara 页，输入长模板时属于明显浪费。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { Config } from '../shared/configSchema'
import type { LegacyStore } from '../shared/legacyDb'
import { i18n } from '../shared/i18n'
import { saveConfig } from './appStore'

/** 输入防抖：用户停止输入 400ms 后才提交（失焦/卸载时立即提交） */
const INPUT_DEBOUNCE_MS = 400

/**
 * 库存四表的显示名。
 *
 * 迁移页签的三个区块（旧库导入 / 导出 / 导入）都要显示表名，
 * 各写一遍 `migrate.store.*` 就等于把同一个文案键抄三次。
 */
export function storeLabel(store: LegacyStore, tr: TFunction): string {
    return tr(`migrate.store.${store}`)
}

/** 键名列表（过长时省略，避免结果框刷屏） */
export function formatKeyList(keys: string[], tr: TFunction): string {
    const head = keys.slice(0, 6).join(tr('migrate.keySeparator'))
    return keys.length <= 6 ? head : tr('migrate.keyListMore', { head, n: keys.length })
}

/**
 * 相对时间 —— 任务队列与迁移页签共用一份，避免两处文案/阈值各自漂移。
 * 只用于「多久没动」的直观判断，不追求精确；`at` 缺失或非正数时给占位符。
 */
export function relativeTime(at: number | undefined, now = Date.now()): string {
    if (typeof at !== 'number' || at <= 0) return i18n.t('common.none')
    const delta = Math.max(0, now - at)
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour
    if (delta < minute) return i18n.t('time.secondsAgo', { n: Math.max(1, Math.round(delta / 1000)) })
    if (delta < hour) return i18n.t('time.minutesAgo', { n: Math.round(delta / minute) })
    if (delta < day) return i18n.t('time.hoursAgo', { n: Math.round(delta / hour) })
    return i18n.t('time.daysAgo', { n: Math.round(delta / day) })
}

/**
 * 人类可读的体积（1024 进制）——导出进度用。
 *
 * 用 `Blob.size`（真实 UTF-8 字节）作为输入，而不是字符串长度：
 * 中文在 UTF-16 里占 1 个字符、落盘要 3 字节，按字符数报体积会低报 2~3 倍。
 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KiB', 'MiB', 'GiB'] as const
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function Section({ title, note, actions, children }: { title: string; note?: string; actions?: ReactNode; children?: ReactNode }): ReactElement {
    return (
        <section className="card">
            <div className="section-head">
                <div>
                    <h2>{title}</h2>
                    {note ? <p className="note">{note}</p> : null}
                </div>
                {actions}
            </div>
            {children ? <div className="section-body">{children}</div> : null}
        </section>
    )
}

/**
 * 配置行。
 * `stack` 用于长文本控件（路径模板等）：label 在上、控件占满整行，
 * 避免被右侧固定宽度列截断（之前路径模板就是显示不全的）。
 */
export function Row({ label, hint, stack, children }: { label: string; hint?: string; stack?: boolean; children: ReactNode }): ReactElement {
    return (
        <div className={stack ? 'row row--stack' : 'row'}>
            <div className="row-label">
                <span>{label}</span>
                {hint ? <span className="row-hint">{hint}</span> : null}
            </div>
            <div className="row-control">{children}</div>
        </div>
    )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }): ReactElement {
    return (
        <label className="toggle">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
            <span>{label}</span>
        </label>
    )
}

export function TextField({ value, onChange, placeholder, mono }: { value: string; onChange: (next: string) => void; placeholder?: string; mono?: boolean }): ReactElement {
    const { draft, update, commit } = useDraft(value, onChange)
    return <input className={mono ? 'mono' : undefined} type="text" value={draft} placeholder={placeholder} onChange={(event) => update(event.target.value)} onBlur={commit} />
}

export function NumberField({ value, min, max, onChange }: { value: number; min?: number; max?: number; onChange: (next: number) => void }): ReactElement {
    const clamp = useCallback(
        (raw: string): number => {
            const parsed = Number(raw)
            if (!Number.isFinite(parsed)) return value
            if (min !== undefined && parsed < min) return min
            if (max !== undefined && parsed > max) return max
            return parsed
        },
        [value, min, max]
    )
    const { draft, update, commit } = useDraft(String(value), (next) => onChange(clamp(next)))
    return <input type="number" value={draft} min={min} max={max} onChange={(event) => update(event.target.value)} onBlur={commit} />
}

export function SelectField({ value, options, onChange, testId }: { value: string; options: Array<{ value: string; label: string }>; onChange: (next: string) => void; testId?: string }): ReactElement {
    return (
        <select value={value} data-testid={testId} onChange={(event) => onChange(event.target.value)}>
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    )
}

/** 即时保存 hook：写入 storage 后由 sonner 统一提示，页签不需要关心反馈 */
export function useSaver(): { save: (patch: Partial<Config>) => void } {
    const save = useCallback((patch: Partial<Config>) => {
        void saveConfig(patch)
    }, [])
    return { save }
}

/** 状态徽章（替代各自的 perm-badge / ok-text 拼接，统一颜色语义） */
export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'plain'; children: ReactNode }): ReactElement {
    return <span className={`badge ${tone}`}>{children}</span>
}

/**
 * 长任务进度条 —— 全站唯一形状。
 *
 * `value` 是 0~1 的完成比例；传 `undefined` 表示**总量未知**（例如按页遍历，只有跑完才知道有几页），
 * 此时走不确定态滑动动画，而不是假装停在 0%。之前两处长任务各自用 `p.note` 打一行字
 * （「正在读取 视频库：1000 / 5000」），既没有可比性也无法一眼看出快慢。
 *
 * 无障碍：不确定态**不写** `aria-valuenow`（ARIA 规定缺省即为不确定），
 * 只保留 min/max，否则读屏软件会播报一个编造的百分比。
 */
export function ProgressBar({ value, label, testId }: { value?: number; label: string; testId?: string }): ReactElement {
    const determinate = typeof value === 'number' && Number.isFinite(value)
    const percent = determinate ? Math.min(100, Math.max(0, Math.round(value * 100))) : undefined
    return (
        <div className={percent === undefined ? 'progress progress--indeterminate' : 'progress'} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(percent === undefined ? {} : { 'aria-valuenow': percent })} data-testid={testId}>
            <span className="progress-fill" style={percent === undefined ? undefined : { width: `${percent}%` }} />
        </div>
    )
}

/** 复选框行（好友审批条件这类「标签 + 技术 ID」列表用） */
export function CheckRow({ checked, onChange, label, code }: { checked: boolean; onChange: (next: boolean) => void; label: string; code?: string }): ReactElement {
    return (
        <label className="check-row">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
            <span className="check-label">{label}</span>
            {code ? <code>{code}</code> : null}
        </label>
    )
}

/** 文件选择器：隐藏 UA 原生控件（深色主题下是刺眼的白色） */
export function FilePicker({ accept, disabled, onPick, hint }: { accept?: string; disabled?: boolean; onPick: (file: File) => void; hint?: string }): ReactElement {
    const [name, setName] = useState<string | null>(null)
    return (
        <label className="file-picker" aria-disabled={disabled}>
            <input
                type="file"
                accept={accept}
                disabled={disabled}
                onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    setName(file.name)
                    onPick(file)
                }}
            />
            <span>{hint ?? i18n.t('common.chooseFile')}</span>
            <span className="file-name">{name ?? i18n.t('common.noFileChosen')}</span>
        </label>
    )
}

/**
 * 受控输入的本地草稿 + 防抖提交。
 *
 * 关键细节：
 * - 自己提交的值会先写 `lastSent`，存储回写时就不会把草稿打回去（否则光标跳位）；
 * - 外部改动（其它标签页/迁移导入）会同步进来；
 * - 卸载前把未提交的草稿立刻提交，切页签不丢输入。
 */
function useDraft(value: string, onChange: (next: string) => void): { draft: string; update: (next: string) => void; commit: () => void } {
    const [draft, setDraft] = useState(value)
    const lastSent = useRef(value)
    const timer = useRef<number | undefined>(undefined)
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    const draftRef = useRef(draft)
    draftRef.current = draft

    useEffect(() => {
        if (value === lastSent.current) return
        lastSent.current = value
        setDraft(value)
    }, [value])

    const commit = useCallback(() => {
        if (timer.current !== undefined) {
            window.clearTimeout(timer.current)
            timer.current = undefined
        }
        const next = draftRef.current
        if (next === lastSent.current) return
        lastSent.current = next
        onChangeRef.current(next)
    }, [])

    const update = useCallback((next: string) => {
        setDraft(next)
        if (timer.current !== undefined) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
            timer.current = undefined
            // 直接用最新草稿，不要捕获渲染期的旧值
            const latest = draftRef.current
            if (latest === lastSent.current) return
            lastSent.current = latest
            onChangeRef.current(latest)
        }, INPUT_DEBOUNCE_MS)
    }, [])

    useEffect(() => {
        return () => {
            // 卸载：未提交的草稿立即提交（切页签/关页签不丢输入）
            if (timer.current !== undefined) {
                window.clearTimeout(timer.current)
                timer.current = undefined
                const latest = draftRef.current
                if (latest !== lastSent.current) {
                    lastSent.current = latest
                    onChangeRef.current(latest)
                }
            }
        }
    }, [])

    return { draft, update, commit }
}

/**
 * options 全局状态桥 —— useSyncExternalStore 订阅 storage（docs/01）
 * 数据源即持久层：config / downloadQueue 的 storage.local 变更（含后台 DOWNLOAD_STATE
 * 落盘）经 storage.onChanged 全量反映，options 无私有副本。
 */
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import type { Config } from '../shared/configSchema'
import { configSchema } from '../shared/configSchema'
import { i18n } from '../shared/i18n'
import type { QueueTask } from '../shared/task'
import { CONFIG_KEY, QUEUE_KEY } from '../shared/storageKeys'
import { changedValue } from '../shared/storageChanges'

export interface AppState {
    ready: boolean
    config: Config | null
    queue: QueueTask[]
}

let state: AppState = { ready: false, config: null, queue: [] }
const listeners = new Set<() => void>()

function emit(): void {
    for (const listener of listeners) listener()
}

function set(partial: Partial<AppState>): void {
    state = { ...state, ...partial }
    emit()
}

async function refreshAll(): Promise<void> {
    const stored = await browser.storage.local.get([CONFIG_KEY, QUEUE_KEY])
    const configResult = configSchema.safeParse((stored[CONFIG_KEY] as unknown) ?? {})
    const queue = stored[QUEUE_KEY]
    set({
        ready: true,
        config: configResult.success ? configResult.data : null,
        queue: Array.isArray(queue) ? (queue as QueueTask[]) : []
    })
}

void refreshAll()

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    if (CONFIG_KEY in changes) {
        const result = configSchema.safeParse(changedValue(changes, CONFIG_KEY) ?? {})
        set({ config: result.success ? result.data : null })
    }
    if (QUEUE_KEY in changes) {
        const next = changedValue(changes, QUEUE_KEY)
        set({ queue: Array.isArray(next) ? (next as QueueTask[]) : [] })
    }
})

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function useAppState(): AppState {
    return useSyncExternalStore(subscribe, () => state)
}

/**
 * 保存类 toast 的固定选项。
 * - `id`：连续保存只留一条，后到的覆盖前一条（否则连点几个开关会堆一列「已保存」）
 * - `testId`：e2e 契约（`[data-testid="save-toast"]`），勿改
 */
const SAVE_TOAST = { id: 'config-save', testId: 'save-toast' } as const

/**
 * 只写盘、不校验不提示的配置写入。
 *
 * 给「已经自己校验过、且有独立反馈渠道」的调用方用：目前是迁移导入——它逐键 zod 救回
 * 并把结果渲染在 result-box 里，再弹一条「已保存」toast 会盖住结果框。
 *
 * 存在的意义：**`config` 存在哪个键、以什么形态写**只能有一个出口。
 * 之前迁移页自己写 `browser.storage.local.set({ [CONFIG_KEY]: next })`，
 * 任何一边改了键名或写入形态，另一边都不会报错——只会静默写到别处。
 */
export function writeConfigRaw(next: Record<string, unknown>): Promise<void> {
    return browser.storage.local.set({ [CONFIG_KEY]: next })
}

/**
 * 配置保存管线：内存合并 → zod 校验 → storage 直写（后台 CONFIG_SYNC/回填广播自动跟进）
 *
 * 反馈策略：**校验通过就立刻显示「已保存」**（乐观 UI），写入失败再覆盖成错误。
 * 理由：storage 写入虽是毫秒级，但 UI 反馈延迟到 await 之后会让「点一下没反应」；
 * 出错时同一个 toast id 会覆盖乐观提示，不会让用户误以为已保存。
 */
export async function saveConfig(patch: Partial<Config>): Promise<string | null> {
    const merged = { ...(state.config ?? {}), ...patch }
    const result = configSchema.safeParse(merged)
    if (!result.success) {
        const issue = result.error.issues[0]
        const message = `${i18n.t('error.validateFailed')}${issue?.path.length ? ` [${issue.path.join('.')}]` : ''}: ${issue?.message ?? i18n.t('error.configInvalid')}`
        toast.error(message, { ...SAVE_TOAST, duration: 6000 })
        return message
    }
    toast.success(i18n.t('common.saved'), { ...SAVE_TOAST, duration: 2000 })
    try {
        await writeConfigRaw(result.data as unknown as Record<string, unknown>)
        return null
    } catch (error) {
        const message = i18n.t('error.saveFailed', { message: error instanceof Error ? error.message : String(error) })
        toast.error(message, { ...SAVE_TOAST, duration: 6000 })
        return message
    }
}

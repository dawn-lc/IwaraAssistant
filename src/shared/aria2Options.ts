/**
 * aria2 的**运行时配置**（`aria2.getGlobalOption`）与据此做的自适应。
 *
 * 为什么需要：同一个 addUri 参数在不同配置下含义不同，硬编码等于在替用户改配置。三次真机实测得到两条硬结论：
 *
 * 1. **`all-proxy: ''` 不是「继承」，而是「强制不走代理」**。实测：全局 `all-proxy` 指向一个不通的代理时，不带该选项的任务继承代理（一直 active、连不上）；带空串的任务 `getOption` 里没有 `all-proxy` 键，**直连成功**。所以用户没在扩展里配代理时，必须**省略**这个键，绝不能传空串——否则会静默废掉 aria2.conf 里的代理。
 * 2. **`max-tries: 0` 是「无限重试」**。只有在这种配置下，aria2-next 3.x 才会把 403 卡在 active 永不报错（见 shared/aria2Flavor 的 `stallsOnForbidden`）；用户自己设了有限次数时不该再覆盖他。
 *
 * 这两个判断都是纯函数，单测直接覆盖。
 */
import type { Aria2Capabilities } from './aria2Flavor'

/** 从 `getGlobalOption` 里挑出我们真正会用的那几项（全部原样是字符串） */
export interface Aria2GlobalOptions {
    /** 0 = 无限重试（上游默认 5） */
    maxTries: number
    /** 秒；> 0 时 aria2 才会重试 502/503 */
    retryWait: number
    maxConnectionPerServer: number
    split: number
    minSplitSize: number
    /** 结果窗口上限，0 = 不限（上游默认 1000） */
    maxDownloadResult: number
    continueEnabled: boolean
    allowOverwrite: boolean
    autoFileRenaming: boolean
    /** 服务端配置的代理（空 = 没配） */
    allProxy: string
    dir: string
}

/** 上游 aria2 的默认值：探测不到配置时按这个走 */
export const ARIA2_GLOBAL_OPTIONS_DEFAULT: Aria2GlobalOptions = {
    maxTries: 5,
    retryWait: 0,
    maxConnectionPerServer: 1,
    split: 5,
    minSplitSize: 20 * 1024 * 1024,
    maxDownloadResult: 1000,
    continueEnabled: false,
    allowOverwrite: false,
    autoFileRenaming: true,
    allProxy: '',
    dir: ''
}

function num(value: string | undefined, fallback: number): number {
    if (typeof value !== 'string' || value.trim() === '') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function bool(value: string | undefined, fallback: boolean): boolean {
    if (value === 'true') return true
    if (value === 'false') return false
    return fallback
}

/** 解析 `getGlobalOption` 的结果；缺字段用上游默认值补齐 */
export function parseAria2GlobalOptions(raw: Record<string, string> | undefined): Aria2GlobalOptions {
    const d = ARIA2_GLOBAL_OPTIONS_DEFAULT
    if (!raw) return d
    return {
        maxTries: num(raw['max-tries'], d.maxTries),
        retryWait: num(raw['retry-wait'], d.retryWait),
        maxConnectionPerServer: num(raw['max-connection-per-server'], d.maxConnectionPerServer),
        split: num(raw.split, d.split),
        minSplitSize: num(raw['min-split-size'], d.minSplitSize),
        maxDownloadResult: num(raw['max-download-result'], d.maxDownloadResult),
        continueEnabled: bool(raw.continue, d.continueEnabled),
        allowOverwrite: bool(raw['allow-overwrite'], d.allowOverwrite),
        autoFileRenaming: bool(raw['auto-file-renaming'], d.autoFileRenaming),
        allProxy: typeof raw['all-proxy'] === 'string' ? raw['all-proxy'] : d.allProxy,
        dir: typeof raw.dir === 'string' ? raw.dir : d.dir
    }
}

/**
 * 要不要给任务加有限的 `max-tries`。
 *
 * 只在「这个分支的 403 会卡死」**且**「服务端本来就不设上限」时加：
 * 用户自己设了 max-tries 就说明他知道自己在做什么，不该被我们覆盖。
 */
export function shouldBoundAria2Retries(caps: Aria2Capabilities | undefined, options: Aria2GlobalOptions | undefined): boolean {
    if (caps?.stallsOnForbidden !== true) return false
    return (options ?? ARIA2_GLOBAL_OPTIONS_DEFAULT).maxTries === 0
}

/** 加上的重试上限（够大以覆盖瞬时抖动，够小以让错误在一分钟内浮出） */
export const ARIA2_BOUNDED_MAX_TRIES = 5

/** 重试相关参数：不加就不返回任何键 */
export function aria2RetryParams(caps: Aria2Capabilities | undefined, options: Aria2GlobalOptions | undefined): Record<string, unknown> {
    if (!shouldBoundAria2Retries(caps, options)) return {}
    return { 'max-tries': String(ARIA2_BOUNDED_MAX_TRIES) }
}

/**
 * 代理参数。
 *
 * `url` 为空时**返回空对象**（一个键都不给）：让 aria2 用它自己配置的代理。
 * 传空串会覆盖成「不走代理」，等于替用户关掉代理。
 */
export function aria2ProxyParams(url: string, user?: string, passwd?: string): Record<string, unknown> {
    const trimmed = typeof url === 'string' ? url.trim() : ''
    if (trimmed === '') return {}
    const params: Record<string, unknown> = { 'all-proxy': trimmed }
    if (typeof user === 'string' && user !== '') params['all-proxy-user'] = user
    if (typeof passwd === 'string' && passwd !== '') params['all-proxy-passwd'] = passwd
    return params
}

/**
 * 一轮扫描最多要多少条 `tellStopped` 记录。
 *
 * 服务端 `max-download-result` 已经限制了窗口大小，多要没用；设为 0（不限）时
 * 由我们自己封顶（一条记录约 11 KB，见提案 §9.5，4096 条 ≈ 46 MB 是现有上限）。
 */
export function aria2StoppedQueryLimit(options: Aria2GlobalOptions | undefined, hardCap = 4096): number {
    const configured = (options ?? ARIA2_GLOBAL_OPTIONS_DEFAULT).maxDownloadResult
    if (configured <= 0) return hardCap
    return Math.min(configured, hardCap)
}

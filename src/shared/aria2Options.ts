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
    /** aria2 自己的并发上限（队列满判据） */
    maxConcurrentDownloads: number
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
    maxConcurrentDownloads: 5,
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
        maxConcurrentDownloads: num(raw['max-concurrent-downloads'], d.maxConcurrentDownloads),
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

/** 502/503 这类瞬时错误只有 `retry-wait > 0` 时 aria2 才会自己重试（上游默认 0 ⇒ 根本不重试） */
export const ARIA2_RETRY_WAIT_SECONDS = 5

/** 我们希望的连接/分段数（来自扩展配置，由调用方传入） */
export interface Aria2TuningDesired {
    maxConnections: number
    split: number
}

/**
 * 计算要不要给任务补「连接数 / 分段数 / 最小分段 / 重试等待」。
 *
 * 三条判据都是**只上不下**：
 *
 * 1. 服务端已经配得更高 ⇒ 一个键都不给（用户自己在 aria2.conf 里调过，尊重他）；
 * 2. 上游默认 `-x=1 / -s=5 / -k=20M` ⇒ 不补就是**单连接**、小于 40 MB 的文件根本不分段。
 *    这是「aria2 通道为什么感觉不快」的最可能原因，与站点限速无关；
 * 3. `retry-wait=0`（上游默认）⇒ 502/503 **不重试**，一次网关抖动就升级成我们的「任务失败」。
 *
 * 值一律夹在 1..16：再高对单文件下载没有收益，却更容易被站点当成滥用。
 */
export function aria2TuningParams(options: Aria2GlobalOptions | undefined, desired: Aria2TuningDesired): Record<string, unknown> {
    const current = options ?? ARIA2_GLOBAL_OPTIONS_DEFAULT
    const params: Record<string, unknown> = {}
    const connections = clampTuning(desired.maxConnections)
    const splits = clampTuning(desired.split)
    if (current.maxConnectionPerServer < connections) params['max-connection-per-server'] = String(connections)
    if (current.split < splits) params.split = String(splits)
    // 最小分段只在真的要分段时收紧：20 MB 的默认值意味着 < 40 MB 的文件只有一条连接在干活
    // 只要抬高了连接数或分段数，就顺手把最小分段收紧：默认 20 MB 意味着小于 40 MB 的文件
    // 即使设了 4 连接也只有一条在干活（aria2 按最小分段切块，切不出来就退回单连接）。
    const raisedParallelism = params['max-connection-per-server'] !== undefined || params.split !== undefined
    if (raisedParallelism && current.minSplitSize > 2 * 1024 * 1024) params['min-split-size'] = '1M'
    if (current.retryWait === 0) params['retry-wait'] = String(ARIA2_RETRY_WAIT_SECONDS)
    return params
}

function clampTuning(value: number): number {
    if (!Number.isFinite(value)) return 1
    return Math.max(1, Math.min(16, Math.trunc(value)))
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

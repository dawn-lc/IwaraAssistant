/**
 * aria2 分支差异与能力探测。
 *
 * ## 为什么要这一层
 *
 * 同一个 RPC 方法在不同分支上的**语义**并不一样，只看版本号会踩坑（1.36.0 与 3.1.1 是两条互不相干的版本线，比大小没有意义）。三次真机实测（2026-11-18 / 11-19）：
 *
 * | 行为 | 上游 1.36.0 | aria2-next 2.4.9 | aria2-next 3.1.1 |
 * | --- | --- | --- | --- |
 * | getVersion().product | 无 | **无** | aria2-next |
 * | aria2.probe / moveDownload | 无 | 无 | **有** |
 * | HLS/DASH 媒体任务 | 不支持 | 不支持 | 支持（totalLength 恒 0，进度在 media.progress） |
 * | 403 过期直链 | error 22（5 秒内） | error 22 | **永远 active、不报错** |
 * | 我们传的 addUri 选项 | 全部接受 | 全部接受 | 全部接受 |
 *
 * ## 判据顺序
 *
 * 先看 product，再看 enabledFeatures。**2.4.9 没有 product 字段**，只能靠 ED2K（aria2-next 独有）认出来；实在认不出来就按上游处理——上游是最保守的一侧（不主动重试 403、字段表里没有 media），按它走不会做出错误动作。
 *
 * 认错方向的代价不对称：把 aria2-next 当上游 = 少用两个可选能力；把上游当 aria2-next = 往老版本要 media 字段、给 403 加奇怪的选项。所以**默认值一律取上游**。
 */

export type Aria2Flavor = 'aria2' | 'aria2-next'

/** aria2.getVersion 的返回（字段都可缺，各分支不同） */
export interface Aria2VersionInfo {
    version?: string
    product?: string
    enabledFeatures?: string[]
    mediaFeatures?: unknown
    downloadFeatures?: unknown
}

export interface Aria2Capabilities {
    flavor: Aria2Flavor
    /** 版本号原样保留（不同分支不可比，别拿它做大小判断） */
    version: string
    /** 主版本号，只用于同一分支内的粗判 */
    major: number
    /** getVersion 自带 product（2.4.9 没有，只能靠特征推断） */
    selfIdentifying: boolean
    /** 投递前可预检直链：aria2.probe */
    probe: boolean
    /** 未完成任务可整目录搬移：aria2.moveDownload */
    moveDownload: boolean
    /** HLS/DASH：totalLength 恒 0，进度只存在于 media.progress */
    media: boolean
    /** 403 会永远卡在 active 不报错——必须靠有限的 max-tries 把错误逼出来 */
    stallsOnForbidden: boolean
}

/** 探测失败时的保守默认值：一律按上游、不加任何分支特性 */
export const ARIA2_CAPABILITIES_UPSTREAM: Aria2Capabilities = {
    flavor: 'aria2',
    version: '',
    major: 0,
    // 没探测过 ≠ 自报身份：默认值必须和「空 getVersion 结果」解析出来的完全一致，
    // 否则后续判断会出现两种「上游」。
    selfIdentifying: false,
    probe: false,
    moveDownload: false,
    media: false,
    stallsOnForbidden: false
}

/** 媒体任务额外需要的状态字段（上游不认识，所以只在支持分支上请求） */
export const ARIA2_MEDIA_FIELD = 'media'

function majorOf(version: string): number {
    const match = /^(\d+)/.exec(version.trim())
    return match ? Number(match[1]) : 0
}

/** aria2-next 独有的特征（老版本没有 product，只能靠这些认） */
const ARIA2_NEXT_ONLY_FEATURES = ['ED2K', 'HLS/DASH'] as const

/**
 * 解析 getVersion 的结果 → 能力表。
 *
 * 纯函数：不做 IO；不认识就返回上游默认值（见文件头的「认错方向」说明）。
 */
export function parseAria2Capabilities(info: Aria2VersionInfo | undefined): Aria2Capabilities {
    const version = typeof info?.version === 'string' ? info.version : ''
    const major = majorOf(version)
    const features = Array.isArray(info?.enabledFeatures) ? info.enabledFeatures : []
    const product = typeof info?.product === 'string' ? info.product : ''
    const looksLikeNext = product === 'aria2-next' || ARIA2_NEXT_ONLY_FEATURES.some((feature) => features.includes(feature)) || info?.mediaFeatures !== undefined
    const flavor: Aria2Flavor = looksLikeNext ? 'aria2-next' : 'aria2'
    // 实测：probe / moveDownload / 媒体对象 / 403 停滞都只出现在 3.x 线；2.4.9 一个都没有
    const modernNext = flavor === 'aria2-next' && major >= 3
    const media = modernNext && (features.includes('HLS/DASH') || info?.mediaFeatures !== undefined)
    return {
        flavor,
        version,
        major,
        selfIdentifying: product !== '',
        probe: modernNext,
        moveDownload: modernNext,
        media,
        stallsOnForbidden: modernNext
    }
}

/**
 * 用 system.listMethods 的真实结果校正特性位。
 *
 * 版本线判断是启发式，方法表是事实：只要拿得到方法表就以它为准。
 */
export function refineAria2Capabilities(caps: Aria2Capabilities, methods: readonly string[]): Aria2Capabilities {
    if (methods.length === 0) return caps
    return { ...caps, probe: methods.includes('aria2.probe'), moveDownload: methods.includes('aria2.moveDownload') }
}

/**
 * 取状态时用的字段集：只有媒体分支才追加 media。
 *
 * 上游 1.36.0 不认识 media（返回里不会有这个键），但没必要去试探它——少要一个字段就少一分解析开销，而 tellStopped 本来就在 12 MB 量级（见提案 §9.5）。
 */
export function aria2StatusFieldsWith(base: readonly string[], caps: Aria2Capabilities | undefined): string[] {
    if (!caps?.media || base.includes(ARIA2_MEDIA_FIELD)) return [...base]
    return [...base, ARIA2_MEDIA_FIELD]
}

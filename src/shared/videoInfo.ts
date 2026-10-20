/**
 * VideoInfo 领域类型 —— 对齐原仓库 src/types/main.d.ts 的 VideoInfo 家族
 * 视频库（IndexedDB videos 表）的唯一存储形态；字段展开规则与 parseVideoInfo 一致
 */

export type VideoInfoType = 'full' | 'partial' | 'cache' | 'init' | 'fail'

export interface VideoInfoBase {
    Type: VideoInfoType
    ID: string
    RAW?: Iwara.Video
}

export interface InitVideoInfo extends VideoInfoBase {
    Type: 'init'
    UploadTime?: number
    Title?: string
    FileName?: string
    Size?: number
    Tags?: Array<Iwara.Tag>
    Liked?: boolean
    Following?: boolean
    Friend?: boolean
    Alias?: string
    Author?: string
    AuthorID?: string
    Private?: boolean
    Unlisted?: boolean
    DownloadQuality?: string
    External?: boolean
    ExternalUrl?: string
    Description?: string
    Comments?: string
    DownloadUrl?: string
    RAW?: Iwara.Video
}

export interface FullVideoInfo extends VideoInfoBase {
    Type: 'full'
    UploadTime: number
    Title: string
    FileName: string
    Size: number
    Tags: Array<Iwara.Tag>
    Liked: boolean
    Following: boolean
    Friend: boolean
    Alias: string
    Author: string
    AuthorID: string
    Private: boolean
    Unlisted: boolean
    DownloadQuality: string
    External: boolean
    ExternalUrl?: string
    Description?: string
    Comments: string
    DownloadUrl: string
    RAW: Iwara.Video
}

export interface PartialVideoInfo extends VideoInfoBase {
    Type: 'partial'
    UploadTime: number
    Title: string
    Tags: Array<Iwara.Tag>
    Liked: boolean
    Alias: string
    Author: string
    AuthorID: string
    Private: boolean
    Unlisted: boolean
    External: boolean
    ExternalUrl?: string
    RAW: Iwara.Video
}

export interface CacheVideoInfo extends VideoInfoBase {
    Type: 'cache'
    RAW: Iwara.Video
}

export interface FailVideoInfo extends VideoInfoBase {
    Type: 'fail'
    Msg?: string
    UploadTime?: number
    Title?: string
    FileName?: string
    Size?: number
    Tags?: Array<Iwara.Tag>
    Liked?: boolean
    Following?: boolean
    Friend?: boolean
    Alias?: string
    Author?: string
    AuthorID?: string
    Private?: boolean
    Unlisted?: boolean
    DownloadQuality?: string
    External?: boolean
    ExternalUrl?: string
    Description?: string
    Comments?: string
    DownloadUrl?: string
    RAW?: Iwara.Video
}

export type VideoInfo = FullVideoInfo | PartialVideoInfo | CacheVideoInfo | InitVideoInfo | FailVideoInfo

/**
 * 信息完整度分数（源 `getVideoInfoCompleteness`）：full > partial > fail > cache > init。
 *
 * 数值本身没有意义，只用于「同一个视频的两个版本取哪个」这一处比较；
 * 顺手排成单调序列，将来加类型时只需插进位置。
 */
export function getVideoInfoCompleteness(info: VideoInfo): number {
    switch (info.Type) {
        case 'full':
            return 5
        case 'partial':
            return 4
        case 'fail':
            return 3
        case 'cache':
            return 2
        case 'init':
            return 1
    }
}

/**
 * 择优取信息更完整的那个版本（源 `getMoreCompleteVideoInfo`）。
 *
 * 用在同一视频「库内缓存」与「刚解析出来」两份数据之间：
 * 解析可能只拿到 partial（比如同时段限流），直接覆盖会把已有的 full 记录降级，
 * 之后依赖 Description / Comments / DownloadUrl 的功能就全部失效。
 *
 * ID 不同直接抛错——那不是「择优」场景，是调用方把两个视频搞混了，静默取一个更难排查。
 */
export function getMoreCompleteVideoInfo(a: VideoInfo, b: VideoInfo): VideoInfo {
    if (a.ID !== b.ID) throw new Error(`VideoInfo ID mismatch: "${a.ID}" vs "${b.ID}"`)
    return getVideoInfoCompleteness(b) > getVideoInfoCompleteness(a) ? b : a
}

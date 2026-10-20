/**
 * parseVideoInfo 的 'cache' 路径迁移（原 network/video.ts）—— 纯函数
 *
 * 仅从 Iwara.Video RAW 展开字段（Type: cache → partial），不发任何网络请求；
 * 网络侧的 'full' 解析（/video/:id + 文件源 + 评论）随下载通道实现。
 * 字段集合与原 partial 返回值逐字段对齐，落库形态不变（迁移导入可直接对拍）。
 */
import { isNullOrUndefined } from '../../shared/strings'
import type { PartialVideoInfo, FailVideoInfo } from '../../shared/videoInfo'

export function parseCacheVideo(raw: Iwara.Video): PartialVideoInfo | FailVideoInfo {
    try {
        const base = {
            RAW: raw,
            ID: raw.id,
            UploadTime: new Date(raw.createdAt ?? 0).getTime(),
            Title: raw.title,
            Tags: raw.tags,
            Liked: raw.liked,
            Alias: raw.user.name,
            Author: raw.user.username,
            AuthorID: raw.user.id,
            Private: raw.private,
            Unlisted: raw.unlisted,
            External: !isNullOrUndefined(raw.embedUrl) && raw.embedUrl !== ''
        }

        // 外链视频：原实现 parse 阶段即 fail（不参与回填窗口，不入库）
        if (base.External) {
            return {
                Type: 'fail',
                ...base,
                ExternalUrl: raw.embedUrl ?? undefined,
                Msg: 'external Video'
            }
        }

        return {
            Type: 'partial',
            ...base,
            ExternalUrl: !isNullOrUndefined(raw.embedUrl) ? raw.embedUrl : undefined
        }
    } catch (error) {
        return {
            Type: 'fail',
            ID: raw?.id ?? '',
            RAW: raw,
            Msg: error instanceof Error ? error.message : String(error)
        }
    }
}

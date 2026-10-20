/**
 * Iwara API 交互 —— parseVideoInfo 'full' 路径（原 network/video.ts）+ 评论分页（原 getCommentDatas）
 *
 * unlimitedFetch（GM 跨域）→ 后台 fetch：host_permissions 授权后无 CORS，
 * 失败不再需要 GM 回退；refresh 令牌重试语义与原实现一致（403/404 不重试）
 */
import { apiUrl } from '../../shared/site'
import { isNullOrUndefined } from '../../shared/strings'
import type { FailVideoInfo, FullVideoInfo } from '../../shared/videoInfo'
import { db } from '../storage/db'
import { getAuth, refreshAccessToken } from './auth'
import { getConfig } from '../storage/configStore'

/** 解析失败（含外链）：携带已展开字段，调用方据此提示（原 FailVideoInfo 返回值语义） */
export class VideoParseError extends Error {
    readonly videoInfo: FailVideoInfo
    constructor(info: FailVideoInfo) {
        super(info.Msg ?? 'parse video failed')
        this.name = 'VideoParseError'
        this.videoInfo = info
    }
}

/** 带刷新重试的授权 GET（原 unlimitedFetch retry 语义：最多 3 次，403/404 直接放弃） */
async function fetchWithAuthRetry(url: URL | string, buildInit: () => Promise<RequestInit>): Promise<Response> {
    let response = await fetch(url, await buildInit())
    for (let attempt = 1; attempt < 3; attempt++) {
        if (response.ok) return response
        if (response.status === 403 || response.status === 404) break
        await refreshAccessToken().catch(() => undefined)
        response = await fetch(url, await buildInit())
    }
    return response
}

// ── 评论（原 getCommentData/getCommentDatas 逐行移植）──────────────────

async function getCommentData(id: string, commentID?: string, page: number = 0): Promise<Iwara.IPage<Iwara.Comment>> {
    const query = new URLSearchParams({ page: String(page) })
    if (!isNullOrUndefined(commentID) && commentID !== '') query.set('parent', commentID)
    return (await (await fetchWithAuthRetry(apiUrl(`/video/${id}/comments`, query), async (): Promise<RequestInit> => ({ headers: await getAuth() }))).json()) as Iwara.IPage<Iwara.Comment>
}

async function getCommentDatas(id: string, commentID?: string): Promise<Iwara.Comment[]> {
    const comments: Iwara.Comment[] = []
    const base = await getCommentData(id, commentID)
    comments.push(...base.results)
    for (let page = 1; page < Math.ceil(base.count / base.limit); page++) {
        comments.push(...(await getCommentData(id, commentID, page)).results)
    }
    const replies: Iwara.Comment[] = []
    for (const comment of comments) {
        if (comment.numReplies > 0) {
            replies.push(...(await getCommentDatas(id, comment.id)))
        }
    }
    comments.push(...replies)
    return comments
}

// ── full 解析（原 parseVideoInfo 'full' 分支移植）──────────────────────

function baseFieldsOf(raw: Iwara.Video) {
    return {
        RAW: raw,
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
}

/**
 * 解析完整视频信息（/video/:id + 文件源 + 全部评论）。
 * 完整失败仍返回 FailVideoInfo 字段（经 VideoParseError 抛出）。
 */
export async function parseVideoFull(videoId: string): Promise<FullVideoInfo> {
    const config = getConfig()
    try {
        let sourceResult: Iwara.Video | (Iwara.IResult & { message?: string | null })
        {
            const response = await fetchWithAuthRetry(apiUrl(`/video/${videoId}`), async (): Promise<RequestInit> => ({ headers: await getAuth() }))
            sourceResult = (await response.json()) as Iwara.Video
        }
        if (isNullOrUndefined(sourceResult.id)) {
            const msg = sourceResult.message ?? JSON.stringify(sourceResult)
            throw new VideoParseError({ Type: 'fail', ID: videoId, Msg: msg })
        }
        const RAW = sourceResult as Iwara.Video
        const base = baseFieldsOf(RAW)
        const ID = RAW.id

        if (base.External) {
            throw new VideoParseError({
                Type: 'fail',
                ...base,
                ID,
                ExternalUrl: RAW.embedUrl ?? undefined,
                Msg: 'external Video'
            })
        }

        // following/friend 关系表随解析更新（原 full 分支行为）
        if (RAW.user.following) await db.putFollow(RAW.user)
        else await db.deleteFollow(base.AuthorID)
        if (RAW.user.friend) await db.putFriend(RAW.user)
        else await db.deleteFriend(base.AuthorID)

        const FileName = RAW.file.name
        const Size = RAW.file.size
        const Description = RAW.body ?? undefined

        // 拉取文件源列表并按配置优先级降序排序（缺失优先级视作 0）
        const sourceResponse = await fetchWithAuthRetry(RAW.fileUrl, async (): Promise<RequestInit> => ({ headers: await getAuth(RAW.fileUrl) }))
        const videoFileSource = ((await sourceResponse.json()) as Iwara.Source[]).sort((a, b) => (config.priority[b.name] ?? 0) - (config.priority[a.name] ?? 0))
        if (!Array.isArray(videoFileSource) || videoFileSource.length < 1) throw new VideoParseError({ Type: 'fail', ...base, ID, Msg: 'No available video source' })
        const DownloadQuality = config.checkPriority ? config.downloadPriority : videoFileSource[0]!.name
        const fileList = videoFileSource.filter((source) => source.name === DownloadQuality)
        if (fileList.length === 0) throw new VideoParseError({ Type: 'fail', ...base, ID, Msg: 'No video source matches the priority' })

        const source = fileList[Math.floor(Math.random() * fileList.length)]!
        const downloadSrc = source.src.download
        if (isNullOrUndefined(downloadSrc) || downloadSrc === '') {
            throw new VideoParseError({ Type: 'fail', ...base, ID, Msg: 'Video source not available' })
        }
        const DownloadUrl = decodeURIComponent(`https:${downloadSrc}`)

        const Comments = JSON.stringify(await getCommentDatas(ID)).normalize('NFKC')

        return {
            Type: 'full',
            ...base,
            ID,
            ExternalUrl: !isNullOrUndefined(RAW.embedUrl) && RAW.embedUrl !== '' ? RAW.embedUrl : undefined,
            Description,
            FileName,
            DownloadQuality,
            Comments,
            DownloadUrl,
            Size,
            Following: RAW.user.following,
            Friend: RAW.user.friend
        }
    } catch (error) {
        if (error instanceof VideoParseError) throw error
        throw new VideoParseError({
            Type: 'fail',
            ID: videoId,
            Msg: error instanceof Error ? error.message : String(error)
        })
    }
}

/**
 * 通用评论拉取 —— 原 network/comments.ts 的后台移植
 * 端点：GET /{type}/{id}/comments?page=N（type 支持 video / profile / forumThread 等）
 * 递归拉取嵌套回复，扁平化返回。
 */
import { apiUrl } from '../../shared/site'
import { getAuth } from './auth'

async function fetchCommentPage(type: string, id: string, page: number, parent?: string): Promise<Iwara.IPage<Iwara.Comment>> {
    const query = new URLSearchParams({ page: String(page) })
    if (parent !== undefined) query.set('parent', parent)
    const response = await fetch(apiUrl(`/${type}/${id}/comments`, query), { headers: await getAuth() })
    if (!response.ok) throw new Error(`fetch comments failed: HTTP ${response.status}`)
    return (await response.json()) as Iwara.IPage<Iwara.Comment>
}

/** 递归拉取资源下的全部评论（含嵌套回复） */
export async function fetchAllComments(type: string, id: string, parent?: string): Promise<Iwara.Comment[]> {
    const comments: Iwara.Comment[] = []
    const base = await fetchCommentPage(type, id, 0, parent)
    comments.push(...base.results)
    for (let page = 1; page < Math.ceil(base.count / Math.max(base.limit, 1)); page++) {
        comments.push(...(await fetchCommentPage(type, id, page, parent)).results)
    }
    const replies: Iwara.Comment[] = []
    for (const comment of comments) {
        if (parent === undefined && comment.numReplies > 0) {
            replies.push(...(await fetchAllComments(type, id, comment.id)))
        }
    }
    return [...comments, ...replies]
}

/** 按用户聚合评论（userId → 评论文本列表），审批条件用 */
export async function fetchCommentsByUser(type: string, id: string): Promise<Map<string, string[]>> {
    const byUser = new Map<string, string[]>()
    for (const comment of await fetchAllComments(type, id)) {
        const userId = comment.user?.id
        if (!userId) continue
        const list = byUser.get(userId) ?? []
        list.push(comment.body ?? '')
        byUser.set(userId, list)
    }
    return byUser
}

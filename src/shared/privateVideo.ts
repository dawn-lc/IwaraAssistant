/**
 * 私有视频（`errors.privateVideo`）—— 一种**可行动**的解析失败。
 *
 * ## 为什么它值得单独建模
 *
 * iwara 的「私有」不是「不公开」，而是**仅好友可见**：作者的好友之外任何人（包括只关注了作者的人）请求
 * `GET /video/:id` 都只会得到 `{"message":"errors.privateVideo"}`，连标题都没有。于是：
 *
 * - 重试一百次结果都一样 —— 「重试」对它是无效按钮；
 * - 用户唯一能做的是**去作者主页加为好友**（对方通过后），然后再重试。
 *
 * 旧实现把 API 原文直接甩进详情（界面上就是一句 `重试解析失败: errors.privateVideo`），
 * 既没告诉用户该怎么办，也没有任何跳转入口。判据放在 shared，是因为它同时被
 * 后台（写任务的 `followUpUrl` / `detail`）与视图层使用，而且必须能被单测钉住。
 *
 * ## 作者信息从哪来
 *
 * 私有视频的详情接口什么都不返回，所以作者只能取**之前入库的列表记录**
 * （订阅流遍历 `parseUnlistedAndPrivate` 会把 private/unlisted 视频以 partial 形态入库）。
 * 查不到时如实降级：不给跳转（按钮只留「重试」），文案说明要自己去视频页加好友。
 */
import { siteUrl } from './site'

/** iwara API 对「无权访问的私有视频」返回的报文（服务端固定英文标记，不随界面语言变） */
const PRIVATE_VIDEO_MARKER = 'errors.privatevideo'

export function isPrivateVideoFailure(message: string | null | undefined): boolean {
    if (message === null || message === undefined) return false
    return message.toLowerCase().includes(PRIVATE_VIDEO_MARKER)
}

/**
 * 给人看的文案键（三种情况各有专属键，**不用可选插值**）：
 * 有作者名 → 指名道姓；只有用户名 → 通用说法；查不到作者 → 让他自己去视频页加好友。
 *
 * 为什么不用一个带 `{alias}` 的键：i18next 对**未提供的占位符会原样保留**，
 * 漏传参数时界面就会出现字面 `{alias}`（`condition.{days}` 那次已经踩过）。
 */
export type PrivateVideoDetailKey = 'tasks.privateVideoDetail' | 'tasks.privateVideoDetailNamed' | 'tasks.privateVideoDetailNoAuthor'

export interface PrivateVideoFollowUp {
    detailKey: PrivateVideoDetailKey
    /** 仅 `detailKey === 'tasks.privateVideoDetailNamed'` 时提供 */
    detailParams?: { alias: string }
    /** 作者主页；查不到作者时为 `undefined`（界面上只有「重试」） */
    profileUrl?: string
}

export function privateVideoFollowUp(author: { username?: string; alias?: string } | undefined): PrivateVideoFollowUp {
    const username = author?.username?.trim() ?? ''
    const alias = author?.alias?.trim() ?? ''
    if (username === '') return { detailKey: 'tasks.privateVideoDetailNoAuthor' }
    return {
        detailKey: alias === '' ? 'tasks.privateVideoDetail' : 'tasks.privateVideoDetailNamed',
        ...(alias === '' ? {} : { detailParams: { alias } }),
        profileUrl: siteUrl(`/profile/${encodeURIComponent(username)}`)
    }
}

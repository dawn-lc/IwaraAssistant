/**
 * 解析失败 → 任务记录该写什么（原因 + 下一步该去哪）。
 *
 * 三处失败点共用：首次投递（`dispatch.runDownloadInner`）、重试（`dispatch.retryTask`）、
 * 排队任务补解析（`browserQueue.startBrowserTask`）。分散写的结果就是「同一类失败在三个
 * 入口给出三种说法」——私有视频那次正是如此：只有原始 API 报文，没有任何可操作入口。
 *
 * 纯判据在 `shared/privateVideo.ts`；这里只负责补上「作者是谁」这一步 I/O。
 */
import { i18n } from '../../shared/i18n'
import { isPrivateVideoFailure, privateVideoFollowUp } from '../../shared/privateVideo'
import { stringify } from '../../shared/strings'
import type { FollowUpKind } from '../../shared/task'
import type { VideoInfo } from '../../shared/videoInfo'
import { db } from '../storage/db'

export interface ParseFailureOutcome {
    /** 给人看的原因（写进 `detail` 的插值位，不再是对用户无意义的 API 报文） */
    reason: string
    /** 下一步该去哪；只有「可行动」的失败才有 */
    followUpUrl?: string
    followUpKind?: FollowUpKind
}

/**
 * 把解析失败翻译成任务记录的内容。
 *
 * 私有视频是唯一一类**需要附加跳转**的解析失败：`errors.privateVideo` 说明视频存在、
 * 只是只对作者的好友开放，加为好友（对方通过）后重试即可成功。其余失败（网络、无可用画质、外部视频…）
 * 原因本身就是全部信息，原样保留。
 *
 * @param knownAuthor 解析过程里已经拿到的作者（`FailVideoInfo` 在首次请求之后失败时会带），
 *                    有就不查库；私有视频失败发生在首次请求，通常查不到，只能回落到本地库。
 */
export async function describeParseFailure(videoId: string, message: string, knownAuthor?: { username?: string; alias?: string }): Promise<ParseFailureOutcome> {
    if (!isPrivateVideoFailure(message)) return { reason: message }
    const author = knownAuthor !== undefined && (knownAuthor.username ?? '').trim() !== '' ? knownAuthor : await cachedAuthor(videoId)
    const followUp = privateVideoFollowUp(author)
    const reason = followUp.detailParams === undefined ? i18n.t(followUp.detailKey) : i18n.t(followUp.detailKey, followUp.detailParams)
    return followUp.profileUrl === undefined ? { reason } : { reason, followUpUrl: followUp.profileUrl, followUpKind: 'author' }
}

/**
 * 本地视频库里的作者。私有视频的详情接口什么都不返回，所以这是唯一来源
 * （订阅流遍历会把 private/unlisted 视频以 partial 形态入库，通常查得到）。
 *
 * 查库失败不该让「记录失败任务」这件事也跟着失败：跳转没了只是少一条入口，
 * 而抛错会让任务停在 `running`（那才是真的没法处理）。
 */
async function cachedAuthor(videoId: string): Promise<{ username?: string; alias?: string } | undefined> {
    try {
        const [record] = await db.getVideosByIds([videoId])
        return authorOfRecord(record)
    } catch (error) {
        console.warn(`[iwara-assistant] 读取 ${videoId} 的作者信息失败（私有视频跳转不可用）:`, stringify(error))
        return undefined
    }
}

/** `VideoInfo` 是联合类型，`cache` 形态没有作者字段——必须先收窄再取 */
function authorOfRecord(record: VideoInfo | undefined): { username?: string; alias?: string } | undefined {
    if (record === undefined || !('Author' in record)) return undefined
    return { username: record.Author, alias: record.Alias }
}

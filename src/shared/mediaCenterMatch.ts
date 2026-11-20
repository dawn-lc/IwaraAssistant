/**
 * MediaCenter 阶段一的**匹配索引**与**分页扫描** —— 纯逻辑，可单测。
 *
 * 为什么需要这一层（两个都实测卡死浏览器的问题）：
 *
 * 1. **一次性拉全量**。源实现（`network/mediaCenter.ts` 的 `fetchMediaList`）用
 *    `?limit=0` 把整个目录塞进一次响应：14 万条 ≈ **118 MB**。`response.json()`
 *    要把这 118 MB 变成一个字符串、再建一棵对象树，两者同时驻留 → 扩展进程直接卡死。
 *    服务端支持 `?page=&limit=`（分页请求下 `limit` 硬顶 100，见 MediaCenter
 *    `controllers/mediaController.listMedia`），所以这里按页扫描、边扫边消费。
 *
 * 2. **O(本地视频 × 远端记录) 的匹配**。源实现预建 `byHash`/`byToken`/`titleIndex`
 *    后，对**每条未映射的本地视频**线性扫一遍全部标题；同时 `byToken` 要为每一条
 *    远端记录分配标题切片的字符串（14 万条 × 每个词一份）。浏览器在第二阶段同样会卡。
 *    这里改成「只认候选」：只对**还没有映射**的本地视频建索引，远端记录的 hash/标题
 *    只有命中候选时才会被记住——内存与远端目录规模无关，成本与远端记录数线性相关。
 *
 * 3. 本地视频 ID 若不纯是字母数字（iwara 的 ID 都是），只能靠 `fileHash` 精确匹配
 *    命中，标题匹配对它无效——这是本实现的已知边界，比「静默扫出错误映射」更安全。
 */
import { runPool } from './concurrency'
import { hasMorePages } from './paging'

/** 远端列表条目（列表端点返回字段里本项目用到的子集） */
export interface MediaCenterListEntry {
    id: string
    fileHash?: string
    title?: string
}

/** 一页远端记录 */
export interface MediaPage {
    items: MediaCenterListEntry[]
    /** 服务端声明的总条数；拿不到时传 0 */
    total: number
}

/** 分页请求的页大小：服务端对分页请求把 `limit` 硬顶到 100，超过这个值只会被截断 */
export const MEDIA_LIST_PAGE_SIZE = 100

/** iwara 视频 ID 形态：纯字母数字 10~18 位（实测真实 ID 为 14 位，区间留了余量） */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9]{10,18}$/

/**
 * 从一条远端记录里**反推 iwara 视频 ID** —— 反向补齐（远端有、本地库没有）的前提。
 *
 * 优先 `fileHash`：扩展与站点下载器创建的记录把视频 ID 原样写在这里，那是最强证据；
 * 只有它不成立时才看标题里的方括号（扫描导入的文件普遍是 `标题[ID].mp4` 形态）。
 *
 * 为什么不能只靠标题：`PhoenixReffaella[ZenlessZoneZero]` 这种方括号里是**标签**，
 * 拿它去解析等于请求一个不存在的视频。形态校验（纯字母数字 + 长度区间）挡掉绝大多数噪声，
 * 剩下的按解析失败如实上报，绝不静默当成成功。
 */
export function extractVideoId(entry: MediaCenterListEntry): string | undefined {
    const hash = entry.fileHash
    if (typeof hash === 'string' && VIDEO_ID_PATTERN.test(hash)) return hash
    if (typeof entry.title !== 'string') return undefined
    const match = entry.title.match(/\[([A-Za-z0-9]{10,18})\]/)
    return match?.[1]
}

/**
 * 页数安全上限（50 万条）。
 *
 * 不是业务上限，是防呆：老版本服务端若不认 `page`，每一页都会返回同一批全量记录，
 * 没有这个上限就是无限循环。触发时结果里 `truncated` 为 true。
 */
export const MEDIA_LIST_MAX_PAGES = 5000

/**
 * 分页并发数。
 *
 * 为什么不是串行：14 万条 = 1400 次往返，串行在 100ms 往返下要两分多钟，
 * 而这条路走的是 `SYNC_MEDIA_CENTER` 的**单事件**处理器（Chrome 上限 5 分钟）。
 * 页码彼此独立、乱序到达不影响索引，所以适度并发是安全的；4 路已能把耗时压到串行的 1/4，
 * 又不会把用户的服务打成突发流量。
 */
export const MEDIA_LIST_CONCURRENCY = 4

/**
 * 匹配索引：把「本地视频 ID」映射到「远端记录 ID」。
 *
 * 匹配顺序与源实现一致：`fileHash` 精确相等 → 标题包含视频 ID。
 * 源实现的中间一层「标题 token 等于视频 ID」是「标题包含 ID」的子集
 * （ID 纯字母数字，token 由非字母数字分隔），这里由包含匹配直接覆盖。
 */
export interface MediaCenterMatcher {
    /** 收录一条远端记录（只有命中候选的部分会被记住） */
    add(entry: MediaCenterListEntry): void
    /** 解析本地视频对应的远端记录 ID；未命中返回 undefined */
    resolve(videoId: string): string | undefined
    /** 还没命中的候选数量（为 0 说明可以提前结束扫描） */
    remaining(): number
}

/**
 * 建候选索引。`videoIds` 只应包含**还没有映射**的本地视频——
 * 传得越少，远端扫描需要收集的命中就越少，也越可能提前结束。
 */
export function createMediaCenterMatcher(videoIds: Iterable<string>): MediaCenterMatcher {
    const exactIds = new Set<string>()
    const lowerIds = new Set<string>()
    const sizes: number[] = []
    for (const videoId of videoIds) {
        if (typeof videoId !== 'string' || videoId === '') continue
        exactIds.add(videoId)
        const lower = videoId.toLowerCase()
        lowerIds.add(lower)
        if (!sizes.includes(lower.length)) sizes.push(lower.length)
    }
    // 升序：滑动窗口长度只需试到 token 长度，超过即可 break（省掉全部无意义窗口）
    sizes.sort((a, b) => a - b)

    /** fileHash → 远端记录 id（键是候选原样大小写，fileHash 相等才算命中） */
    const hashHits = new Map<string, string>()
    /** 小写视频 ID → 远端记录 id（标题包含匹配命中） */
    const titleHits = new Map<string, string>()
    const resolved = new Set<string>()
    let remaining = lowerIds.size

    const settle = (key: string): void => {
        if (resolved.has(key)) return
        resolved.add(key)
        remaining--
    }

    return {
        add(entry) {
            const hash = entry.fileHash
            if (typeof hash === 'string' && hash !== '' && exactIds.has(hash) && !hashHits.has(hash)) {
                hashHits.set(hash, entry.id)
                settle(hash.toLowerCase())
            }

            const title = entry.title
            if (remaining === 0 || typeof title !== 'string' || title === '') return
            // 视频 ID 是纯字母数字 ⇒ 它若出现在标题里，必然完整落在**某个字母数字 token 内**。
            // 于是在 token 内滑动候选长度的窗口即可，等价于源实现的 `title.indexOf(videoId)`，
            // 但成本是「每条远端标题 × 词数 × 窗口数」，而不是「每条本地视频 × 全部远端标题」。
            for (const token of title.toLowerCase().split(/[^a-z0-9]+/)) {
                for (const size of sizes) {
                    if (size > token.length) break
                    for (let start = 0; start + size <= token.length; start++) {
                        const window = token.slice(start, start + size)
                        if (!lowerIds.has(window) || titleHits.has(window)) continue
                        titleHits.set(window, entry.id)
                        settle(window)
                    }
                }
                if (remaining === 0) return
            }
        },
        resolve(videoId) {
            const byHash = hashHits.get(videoId)
            if (byHash !== undefined) return byHash
            return titleHits.get(videoId.toLowerCase())
        },
        remaining: () => remaining
    }
}

/** 分页扫描的结果 */
export interface MediaScanSummary {
    /** 实际扫描到的远端记录数 */
    scanned: number
    /** 服务端声明的总条数（拿不到时为已知的最大值，可能小于 `scanned` 之外的真相） */
    total: number
    /** 实际发出的页请求数 */
    pages: number
    /** 是否因为页数上限而没扫完 */
    truncated: boolean
}

export interface MediaScanOptions {
    /** 拉取第 N 页（N 从 1 开始）；失败应抛出，由调用方翻译成端点文案 */
    fetchPage: (page: number) => Promise<MediaPage>
    /** 每页到达时喂给索引（**乱序**，并发模式下不保证按页序） */
    apply: (items: MediaCenterListEntry[]) => void
    /** 返回 true 表示已没必要继续（候选全部命中）→ 提前结束，不再发后续请求 */
    done?: () => boolean
    /** 进度回调（`scanned` 单调递增；`total` 未知时为 0） */
    onProgress?: (scanned: number, total: number) => void
    pageSize?: number
    maxPages?: number
    concurrency?: number
}

/**
 * 分页扫描远端列表。
 *
 * 三种服务端行为都要吃得下：
 * - **标准分页**（返回 `pagination.total`）：先取第 1 页拿总数，其余页并发拉取；
 * - **只有短页**（没有总数）：顺序翻页，短页/空页即停（`hasMorePages` 的唯一依据）；
 * - **不认分页**（老服务端的 `limit=0` 形态）：第 1 页就会返回超过页大小的条目，
 *   此时它就是全量，直接采用并结束——绝不再去请求第 2 页。
 *
 * 任一页失败即整体抛出：拉不全就**不能**做匹配，否则「已有记录」会被当成不存在，
 * 阶段二会往服务端造成重复条目（这是源实现就在守的语义）。
 */
export async function scanMediaPages(options: MediaScanOptions): Promise<MediaScanSummary> {
    const pageSize = Math.max(1, options.pageSize ?? MEDIA_LIST_PAGE_SIZE)
    const maxPages = Math.max(1, options.maxPages ?? MEDIA_LIST_MAX_PAGES)
    const concurrency = Math.max(1, options.concurrency ?? MEDIA_LIST_CONCURRENCY)
    const done = options.done ?? ((): boolean => false)

    const summary: MediaScanSummary = { scanned: 0, total: 0, pages: 0, truncated: false }

    const take = (items: MediaCenterListEntry[], total: number): void => {
        summary.pages++
        summary.scanned += items.length
        if (total > summary.total) summary.total = total
        options.apply(items)
        options.onProgress?.(summary.scanned, summary.total)
    }

    /** 并发拉取 `from..to`（含两端）；任一页失败后停止派发，并在全部 worker 退出后抛出 */
    const runPages = async (from: number, to: number): Promise<void> => {
        const pages = Array.from({ length: to - from + 1 }, (_value, offset) => from + offset)
        await runPool(
            pages,
            async (page) => {
                const { items, total } = await options.fetchPage(page)
                take(items, total)
            },
            // `done()` 在这里检查：候选全部命中就不必再派发后续页（已发出的会正常收下）
            { concurrency, shouldStop: done }
        )
    }

    const first = await options.fetchPage(1)
    take(first.items, first.total)

    // 服务端不认分页：一次给的比要的还多 ⇒ 这份就是全量
    if (first.items.length > pageSize) return summary
    // 只有一页（短页）或候选已经全命中
    if (first.items.length < pageSize || done()) return summary

    const totalPages = summary.total > 0 ? Math.ceil(summary.total / pageSize) : 0
    if (totalPages > 1) {
        const lastPage = Math.min(totalPages, maxPages)
        summary.truncated = lastPage < totalPages
        await runPages(2, lastPage)
        return summary
    }

    // 没有总数：只能顺序翻页，短页/空页即停（页数上限兜底）
    let page = 2
    while (page <= maxPages) {
        const { items, total } = await options.fetchPage(page)
        take(items, total)
        if (done()) return summary
        if (!hasMorePages({ length: items.length, limit: pageSize, total: 0, pulled: summary.scanned })) return summary
        page++
    }
    summary.truncated = true
    return summary
}

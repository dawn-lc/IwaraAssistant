/**
 * 分页「还有下一页吗」的纯判据 —— 抽出来的唯一理由是它曾经错得很难发现。
 *
 * 原来的写法（`friendRequests` 拉取）：
 * ```ts
 * const limit = data.limit > 0 ? data.limit : data.results.length
 * if (data.results.length < limit || data.results.length === 0) break
 * ```
 * 当服务端不返回 `limit` 时 `limit` 退化成「本页条数」，于是 `length < limit` 恒为假，
 * 只有空页能终止 —— 每次都白翻满 32 页。这类判据必须在单测里逐条钉死，
 * 不能靠「跑一次看起来没问题」来验证（真实请求够快，多翻 30 页很难被注意到）。
 */

export interface PageState {
    /** 本页返回的条数 */
    length: number
    /** 服务端声明的每页上限；拿不到时传 0 */
    limit: number
    /** 服务端声明的总条数；拿不到时传 0 */
    total: number
    /** 至今累计已经拉到的条数（含本页） */
    pulled: number
}

/**
 * 是否需要继续请求下一页。判据按可靠性排序，任意一条成立就停：
 *
 * 1. **空页** —— 最硬的证据，与 limit/count 是否正确无关；
 * 2. **短页**（`0 < length < limit`）—— 标准分页约定；
 * 3. **已拉够 `total`** —— `limit` 缺失时的兜底。
 *
 * 三条都不成立才继续。`limit` 与 `total` 都缺失时只能靠「本页非空」继续，
 * 这种情形由调用方的页数上限兜底（并把「没拉全」如实上报）。
 */
export function hasMorePages({ length, limit, total, pulled }: PageState): boolean {
    if (length === 0) return false
    if (limit > 0 && length < limit) return false
    if (total > 0 && pulled >= total) return false
    return true
}

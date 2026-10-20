/**
 * 字符串工具 —— 自原 core/env.ts 的原型扩展移植为纯函数（扩展代码不污染原型链）
 * 语义逐项对齐原实现，供路径模板渲染与参数 prune 使用
 */
import dayjs from 'dayjs'

/** emoji 正则复制自原 env.ts（emoji-regex-xs 内嵌，MIT） */
const emojiBase = String.raw`\p{Emoji}(?:\p{EMod}|[\u{E0020}-\u{E007E}]+\u{E007F}|\uFE0F?\u20E3?)`
const emojiRegex = new RegExp(String.raw`\p{RI}{2}|(?![#*\d](?!\uFE0F?\u20E3))${emojiBase}(?:\u200D${emojiBase})*`, 'gu')

export const isNullOrUndefined = (value: unknown): value is null | undefined => value === null || value === undefined

export const isEmpty = (value: string | null | undefined): boolean => value === null || value === undefined || value.length === 0

export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 原原 stringify：错误取 message，对象 JSON 化，其余 String()（语义对齐原实现） */
export function stringify(value: unknown): string {
    if (value instanceof Error) return value.message
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value)
        } catch {
            return String(value)
        }
    }
    return String(value)
}

/** 原 String.truncate */
export function truncate(source: string, maxLength: number): string {
    return source.length > maxLength ? source.substring(0, maxLength) : source
}

/**
 * 取两个标记之间的内容 —— 原 String.prototype.among 逐行移植
 * reverse=true 时反向查找（从右向左，用于文件名尾部 ID 提取，如 "[abc123].mp4"）
 */
export function among(source: string, start: string, end: string, greedy = false, reverse = false): string {
    if (source === '' || start === '' || end === '') return ''
    if (!reverse) {
        const startIndex = source.indexOf(start)
        if (startIndex === -1) return ''
        const adjustedStartIndex = startIndex + start.length
        const endIndex = greedy ? source.lastIndexOf(end) : source.indexOf(end, adjustedStartIndex)
        if (endIndex === -1 || endIndex < adjustedStartIndex) return ''
        return source.slice(adjustedStartIndex, endIndex)
    } else {
        const endIndex = source.lastIndexOf(end)
        if (endIndex === -1) return ''
        const adjustedEndIndex = endIndex - end.length
        const startIndex = greedy ? source.indexOf(start) : source.lastIndexOf(start, adjustedEndIndex)
        if (startIndex === -1 || startIndex + start.length > adjustedEndIndex) return ''
        return source.slice(startIndex + start.length, endIndex)
    }
}

/** 原 String.replaceEmojis */
export function replaceEmojis(source: string, replace?: string | null): string {
    return source.replaceAll(emojiRegex, replace ?? '')
}

function hasFormat(value: unknown): value is { format(format?: string): string } {
    return typeof value === 'object' && value !== null && typeof (value as { format?: unknown }).format === 'function'
}

/**
 * 变量占位符替换 —— 原 String.replaceVariable 的纯函数移植
 * %#KEY:format#% 语法：每次出现的 format 独立解析；值含 Date 时 format 走 dayjs；
 * 循环替换检测（seen 集合）与原实现一致
 */
export function replaceVariable(source: string, replacements: Record<string, unknown>, prefix = '%#', suffix = '#%'): string {
    const prefixRe = escapeRegex(prefix)
    const suffixRe = escapeRegex(suffix)
    const seen = new Set<string>()
    // 每个 key 一条占位符正则；捕获组捕获该次出现自身的格式参数（原实现注释同）
    const patterns = Object.keys(replacements).map((key) => ({
        value: replacements[key],
        placeholderRegex: new RegExp(`${prefixRe}${escapeRegex(key)}(?=(?::.*?${suffixRe}|${suffixRe}))(?::(?<fmt>.*?))?${suffixRe}`, 'gs')
    }))
    let current = source
    while (true) {
        if (seen.has(current)) {
            console.warn('[iwara-assistant] 检测到循环替换！终止于:', current)
            break
        }
        seen.add(current)
        let next = current
        for (const { value, placeholderRegex } of patterns) {
            next = next.replace(placeholderRegex, (match: string, fmt?: string) => {
                if (fmt !== undefined && fmt !== '' && hasFormat(value)) {
                    return dayjs(value as unknown as Date).format(fmt)
                }
                return value instanceof Date ? dayjs(value).format('YYYY-MM-DD') : stringify(value)
            })
        }
        if (current === next) break
        current = next
    }
    return current
}

/** 深度剪除 null/undefined/'' 字段（原 env.prune；对象与数组均处理） */
export function prune<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => prune(item)) as unknown as T
    if (typeof value === 'object' && value !== null) {
        const result: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (item === null || item === undefined) continue
            const pruned = prune(item)
            if (pruned === '') continue
            result[key] = pruned
        }
        return result as unknown as T
    }
    return isNullOrUndefined(value) ? (undefined as unknown as T) : value
}

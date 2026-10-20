/**
 * 类型化消息协议 —— 后台 / content / options 共用的单一事实源
 * 详见 docs/04-messaging.md
 */

export interface FullVideoInfo {
    ID: string
    Title: string
    Author: string
    /** JSON 约束：协议 payload 必须可 JSON 序列化，URL 一律存字符串（见 docs/04 设计要点 1） */
    DownloadUrl?: string
    [key: string]: unknown
}

export type DownloadKind = 'browser' | 'aria2' | 'iwaradl'

/** 页面 → 后台 的请求 */
export type Req =
    | { type: 'INGEST_VIDEO_INFO'; payload: { videos: unknown[]; source: 'fetch-intercept' } }
    | { type: 'INGEST_AUTH'; payload: { kind: 'access' | 'refresh'; token: string } }
    | { type: 'GET_COOKIE'; payload: Record<string, never> }
    | { type: 'DOWNLOAD'; payload: { kind: DownloadKind; video: FullVideoInfo; overwrite?: boolean } }
    | { type: 'DOWNLOAD_METADATA'; payload: { video: FullVideoInfo } }
    | { type: 'GET_VIDEOS'; payload: { ids?: string[] }; limit?: number }
    | { type: 'GET_CONFIG'; payload: Record<string, never> }
    | { type: 'CHECK_LINK'; payload: { url: string } }

/** 后台 → 页面/扩展页 的推送 */
export type Push =
    | { type: 'DOWNLOAD_STATE'; payload: { taskId: string; state: 'progress' | 'complete' | 'failed'; detail?: string } }
    | { type: 'CONFIG_INVALIDATED'; payload: string[] }
    /** 注入最小化：缓存回填列表由后台预算推送，MAIN 世界不查库（HELLO 后首推，CONFIG_INVALIDATED 后重推） */
    | { type: 'CACHE_INJECTION_LIST'; payload: { windowStart: number; windowEnd: number; raws: unknown[] } }
    | { type: 'START_PAGE_SCAN'; payload: { scope: 'pageSync' | 'mediaSync' | 'friendRequests' } }
    | { type: 'HELLO'; payload: { schema: number } }

export type Res = { ok: true; data: unknown } | { ok: false; error: string }

/** MAIN ⇄ ISOLATED 通道名（CustomEvent） */
export const MAIN_CHANNEL = {
    up: 'iwara-assistant:up',
    down: 'iwara-assistant:down',
} as const

/** 跨世界数据必须为 JSON 可序列化；schema 不匹配时 ISOLATED 停用并提示 reload */
export const CONTENT_SCHEMA = 1

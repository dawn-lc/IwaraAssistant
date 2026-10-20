/**
 * 真实站点结构夹具。
 *
 * `fixtures/iwara-list.html` 由 `npm run fixtures:capture` 从 iwara.tv 抓取并脱敏：
 * 保留真实 DOM 层级/类名/栅格容器，替换掉视频标题、用户名、真实 ID 与所有图片。
 * CI **不会**访问真实站点，只读这份快照。
 *
 * 为什么不再用内联 stub：手写的 `div.videoTeaser > a + a + a` 掩盖了真实层级
 * （`.videoTeaser__thumbnail` / `.videoTeaser__content` / `.avatar`）与卡片几何，
 * 曾经因此让「复选框被相邻卡片遮挡」的点击失败在 CI 上稳定复现、本地却时好时坏。
 *
 * `fixtures/api/*.json` 是同一次抓取录下来的 `api.iwara.tv` 响应（已脱敏），
 * 用来重放扩展 `mainWorld.ts` 真正解析的数据：手写 JSON 会漏字段/拼错类型，
 * 而真实响应是**数据不是代码**——可以用 `context.route` 重放，完全不执行站点 JS。
 */
import { readFileSync } from 'node:fs'
import type { BrowserContext, Route } from '@playwright/test'

const FIXTURE_PATH = new URL('../fixtures/iwara-list.html', import.meta.url)
const API_DIR = new URL('../fixtures/api/', import.meta.url)

let cached: string | null = null

/** 列表页夹具 HTML（6 张卡片，ID 为 fixtureVideo1..6） */
export function iwaraListPage(): string {
    cached ??= readFileSync(FIXTURE_PATH, 'utf8')
    return cached
}

/** `api.iwara.tv` 列表响应（`Iwara.IPage<Iwara.Video>`）的关键字段 */
export interface IwaraVideoPage {
    count: number
    limit: number
    page: number
    results: Record<string, unknown>[]
}

/**
 * 读录制好的 API 响应。每次返回**新的**对象：用例会就地改写 `results`
 * （点赞/私有标记），共享同一个对象会让用例互相污染。
 */
export function apiFixture<T>(name: string): T {
    try {
        return JSON.parse(readFileSync(new URL(`${name}.json`, API_DIR), 'utf8')) as T
    } catch {
        throw new Error(`缺少 API 夹具 fixtures/api/${name}.json，请先运行 npm run fixtures:capture`)
    }
}

/** 可选夹具：没录到返回 `null`（`/user/token` 需要登录态，未登录抓不到属正常） */
function optionalApiFixture<T>(name: string): T | null {
    try {
        return JSON.parse(readFileSync(new URL(`${name}.json`, API_DIR), 'utf8')) as T
    } catch {
        return null
    }
}

export interface IwaraApiMock {
    /** 被拦截的请求（`origin + pathname + search`，顺序即发生顺序） */
    requests: string[]
    /** 命中夹具之外的请求——测试结尾断言为空，防止漏录端点被静默放过 */
    unmatched: string[]
}

export interface IwaraApiMockOptions {
    /** 改写 `/videos` 响应（构造点赞/私有等真实抓取里不存在的分支） */
    videos?: (page: IwaraVideoPage, url: URL) => IwaraVideoPage
}

/** 跨域 JSON 响应缺 CORS 头时，浏览器会在 fetch 侧直接拒绝——必须显式给出 */
const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store'
}

/**
 * 让 `api.iwara.tv` 回放录制的真实响应。
 *
 * ⚠️ 必须在 `**\/*.iwara.tv/**` 页面路由**之后**注册：Playwright 的路由处理器
 * 后注册先匹配，而页面路由的 glob 同样能匹配到 `api.iwara.tv`。
 */
export async function mockIwaraApi(context: BrowserContext, options: IwaraApiMockOptions = {}): Promise<IwaraApiMock> {
    const mock: IwaraApiMock = { requests: [], unmatched: [] }

    const fulfillJson = (route: Route, body: unknown, status = 200): Promise<void> => route.fulfill({ status, contentType: 'application/json; charset=utf-8', headers: CORS_HEADERS, body: JSON.stringify(body) })

    await context.route('**/api.iwara.tv/**', (route) => {
        const url = new URL(route.request().url())
        mock.requests.push(`${url.origin}${url.pathname}${url.search}`)

        if (url.pathname === '/videos') {
            const base = apiFixture<IwaraVideoPage>('videos')
            return fulfillJson(route, options.videos ? options.videos(base, url) : base)
        }
        if (url.pathname === '/user/token') {
            const token = optionalApiFixture<{ accessToken: string }>('user-token')
            // 没录到（未登录抓不到）也不能当成「未匹配」：这是已知端点，回 401 更贴近真实
            return token ? fulfillJson(route, token) : fulfillJson(route, { message: 'unauthorized' }, 401)
        }
        if (route.request().method() === 'OPTIONS') return fulfillJson(route, {})

        mock.unmatched.push(url.pathname)
        return fulfillJson(route, { message: 'fixture missing' }, 502)
    })

    return mock
}

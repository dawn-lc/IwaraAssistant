/**
 * 真实站点夹具生成器（**只在本地手动跑**，CI 永不执行）。
 *
 *   npm run fixtures:capture
 *
 * 为什么需要它：手写的 stub 只有 `div.videoTeaser > a + a + a`，和真实页面差得远
 * （真实卡片是 `.videoTeaser__thumbnail` + 覆盖层 + `videoTeaser__content` + `.avatar`
 * 的多层结构，外面还有 `.page-videoList__item` 栅格）。用真实结构做夹具，注入点/几何
 * 类问题（例如复选框被相邻卡片遮挡）才会在 CI 里暴露，而不是等用户碰到。
 *
 * ## 抓取与脱敏
 *
 * 只抓**结构**：脚本、图片、视频标题、用户名、真实 ID 全部替换或移除；
 * 站点 CSS 不复制（版权 + 体积），用一个自写的最小布局样式近似卡片几何。
 * 抓取遵守站点 robots（`Allow: /`，单次请求），仅用于本项目的 UI 契约测试。
 *
 * ## 为什么要 headed
 *
 * iwara.tv 有 Cloudflare 挑战，无头 Chromium 直接 403。用本机 Chrome（headed）
 * 通过挑战后再抓 DOM；这也是它不能进 CI 的原因。
 *
 * ## 为什么还要录 API（`fixtures/api/*.json`）
 *
 * DOM 夹具只覆盖「页面长什么样」；扩展真正解析的是 `api.iwara.tv` 的 JSON
 * （`mainWorld.ts` 的 fetch 钩子：透传 / 点赞过滤 / 未列出·私有过滤 / 缓存回填）。
 * 手写 JSON 会漏字段、拼错类型，而真实响应是**数据不是代码**：脱敏后几 KB、
 * 无版权问题、完全确定，可以用 `context.route` 重放而不执行任何站点 JS。
 * 只录扩展真正消费的端点（`/videos`、`/user/token`），其余一律不落盘。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

const SITE_URL = 'https://www.iwara.tv/videos'
const MAX_CARDS = 6
const OUT_FILE = path.join(import.meta.dirname, 'iwara-list.html')
const API_DIR = path.join(import.meta.dirname, 'api')

/** 只录这两个端点：它们是 `content/mainWorld.ts` 有业务分支的全部路径 */
const API_TARGETS: Record<string, string> = { '/videos': 'videos.json', '/user/token': 'user-token.json' }

/**
 * 自写的最小布局：只重建与扩展注入相关的几何（内容列 / 卡片栅格 / 缩略图比例），
 * 不复制站点样式表。
 */
const SITE_CSS = `
body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: #141418; color: #e9e9ee; }
.page { display: flex; flex-direction: column; min-height: 100vh; }
.header { border-bottom: 1px solid #2b2b31; background: #1b1b20; }
.header__content { display: flex; align-items: center; gap: 24px; max-width: 1280px; margin: 0 auto; padding: 12px 16px; }
.header__content__items { display: flex; align-items: center; gap: 16px; flex: 1; }
.header__logo { color: #fff; font-weight: 700; text-decoration: none; }
.header__search { flex: 1; }
.header__search input { width: 100%; padding: 6px 10px; border-radius: 6px; border: 1px solid #3a3a42; background: #141418; color: #eee; }
/* 图标只剩空 <svg> 外壳：不给尺寸会按替换元素默认的 300×150 渲染，撑高整个头部 */
svg { width: 1em; height: 1em; vertical-align: -0.125em; }
.icon svg, button svg { width: 14px; height: 14px; }
/* 站点菜单默认是收起/浮层；不复制它的交互动画，直接隐藏，避免撑高页面 */
.menu, .menu__background { display: none; }
.content { flex: 1; }
.container-fluid { max-width: 1280px; margin: 0 auto; padding: 20px 16px 60px; }
.row { display: flex; flex-wrap: wrap; gap: 16px; }
.col-12 { flex: 0 0 100%; }
.col-lg-9 { flex: 3 1 720px; min-width: 0; }
.col-lg-3 { flex: 1 1 240px; min-width: 0; }
.contentBlock { margin-bottom: 16px; }
.page-videoList__item { flex: 0 0 calc(25% - 12px); min-width: 190px; }
.videoTeaser { position: relative; background: #202027; border-radius: 8px; overflow: hidden; }
.videoTeaser__thumbnail { display: block; position: relative; aspect-ratio: 16 / 9; background: #2c2c34; }
.videoTeaser__thumbnail img { display: block; width: 100%; height: 100%; object-fit: cover; }
.videoTeaser__thumbnail .views,
.videoTeaser__thumbnail .likes,
.videoTeaser__thumbnail .duration,
.videoTeaser__thumbnail .rating { position: absolute; bottom: 6px; }
.views { left: 6px; }
.likes { left: 64px; }
.duration { right: 6px; }
.rating { top: 6px; bottom: auto; left: 6px; }
.videoTeaser__content { padding: 8px 10px 10px; }
.videoTeaser__title { display: block; color: #fff; text-decoration: none; margin-bottom: 8px; }
.videoTeaser__bottom { display: flex; align-items: center; gap: 8px; }
.avatar__inner { width: 28px; height: 28px; border-radius: 50%; overflow: hidden; background: #3a3a42; }
.avatar img { width: 100%; height: 100%; }
.byline { display: flex; flex-direction: column; }
.username { color: #b9b9c3; text-decoration: none; }
.text--small { font-size: 12px; color: #8d8d98; }
.footer { border-top: 1px solid #2b2b31; padding: 20px 0; color: #7d7d88; }
`

/** 1×1 透明 GIF：替代所有图片，避免夹具携带站点素材 */
const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

interface SanitizeOptions {
    maxCards: number
    blankImage: string
    css: string
}

/** 在页面里执行：只保留结构，替换一切内容性文本/链接/图片 */
function sanitizeInPage(options: SanitizeOptions): string {
    const { maxCards, blankImage, css } = options

    document.querySelectorAll('script, noscript, iframe, link, style').forEach((node) => node.remove())
    // 图标只留外壳（Font Awesome 的 path 数据既不必要也有版权）
    document.querySelectorAll('svg').forEach((svg) => {
        while (svg.firstChild) svg.removeChild(svg.firstChild)
        svg.setAttribute('aria-hidden', 'true')
    })
    document.querySelectorAll('img').forEach((img) => {
        img.removeAttribute('srcset')
        img.setAttribute('src', blankImage)
        img.setAttribute('alt', '')
    })

    // 只留前 N 张卡片：夹具是契约样本，不是整页镜像
    const cards = Array.from(document.querySelectorAll('.videoTeaser'))
    for (const card of cards.slice(maxCards)) (card.closest('.page-videoList__item') ?? card).remove()

    Array.from(document.querySelectorAll('.videoTeaser'))
        .slice(0, maxCards)
        .forEach((card, index) => {
            const n = index + 1
            const id = `fixtureVideo${n}`
            const user = `fixture_user_${n}`
            card.querySelectorAll('a[href^="/video/"]').forEach((a) => a.setAttribute('href', `/video/${id}`))
            card.querySelectorAll('a[href^="/profile/"]').forEach((a) => a.setAttribute('href', `/profile/${user}`))

            const title = card.querySelector('.videoTeaser__title')
            if (title) {
                title.setAttribute('title', `Fixture Video ${n}`)
                const text = title.querySelector('.text') ?? title
                text.textContent = `Fixture Video ${n}`
            }
            const username = card.querySelector('.username')
            if (username) {
                username.setAttribute('title', `Fixture User ${n}`)
                const text = username.querySelector('.text') ?? username
                text.textContent = user
            }
            // 动态计数/时长固定下来，避免每次抓取产生无意义 diff。
            // ⚠️ 这里不能用嵌套函数：tsx 的 keepNames 会生成 `__name(...)`，
            // 而 page.evaluate 只序列化函数体，反序列化时没有那个辅助函数 → ReferenceError。
            card.querySelectorAll('.views .text').forEach((el) => {
                if (el.lastChild?.nodeType === Node.TEXT_NODE) el.lastChild.remove()
                el.append(String(100 * n))
            })
            card.querySelectorAll('.likes .text').forEach((el) => {
                if (el.lastChild?.nodeType === Node.TEXT_NODE) el.lastChild.remove()
                el.append(String(10 * n))
            })
            card.querySelectorAll('.duration .text').forEach((el) => {
                if (el.lastChild?.nodeType === Node.TEXT_NODE) el.lastChild.remove()
                el.append(`${n}:0${n}`)
            })
            // 站点评分标签（R-18）也换成中性值：夹具只服务 UI 契约，不携带分级内容
            card.querySelectorAll('.rating .text').forEach((el) => {
                el.textContent = 'R-15'
            })
        })

    // 相对时间“32 min. ago”之类每次都会变，统一成固定值
    document.querySelectorAll('.byline .text--small').forEach((el) => {
        if (/\bago\b|前/.test(el.textContent ?? '')) el.textContent = '1 hour ago'
    })

    // 属性白名单：去掉 style/id/data-* / 内联事件等一切非结构性信息
    const allowed = new Set(['class', 'href', 'title', 'role', 'aria-label', 'aria-hidden', 'type', 'alt', 'width', 'height', 'loading', 'src', 'lang', 'charset', 'name', 'content', 'rel'])
    document.querySelectorAll('*').forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
            if (!allowed.has(attr.name)) el.removeAttribute(attr.name)
        }
    })

    // 运行时挂载点（Toastify / masks / modal-root）不属于站点结构
    document.querySelectorAll('.Toastify, .masks, #modal-root').forEach((node) => node.remove())
    // 页脚是成百上千个站点分类标签，和扩展行为无关：保留 <footer> 外壳，清空内容
    document.querySelectorAll('footer').forEach((footer) => footer.replaceChildren())
    // 右侧栏是「排序 / 标签筛选」的长标签云（同样属于站点内容）：保留栏位，清空内容
    document.querySelectorAll('.col-lg-3').forEach((column) => column.replaceChildren())

    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)

    return `<!doctype html>\n${document.documentElement.outerHTML}\n`
}

// ── API 脱敏 ────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>

/** 固定时间戳：既让 diff 稳定，又保留「按 createdAt 排序/开窗」的真实语义 */
const fixedTime = (index: number): string => new Date(Date.UTC(2024, 0, 1 + index, 12, 0, 0)).toISOString()

/** 媒体/头像对象：保留真实键集，只把标识与文案换掉 */
function sanitizeMedia(raw: Json, index: number, kind: 'file' | 'avatar'): Json {
    const out: Json = {}
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'id') out[key] = `fixture${kind === 'file' ? 'File' : 'Avatar'}${index}`
        else if (key === 'path') out[key] = `fixture/${index}`
        else if (key === 'name') out[key] = kind === 'file' ? `fixture${index}.mp4` : `fixture${index}.png`
        else if (key === 'mime') out[key] = kind === 'file' ? 'video/mp4' : 'image/png'
        else if (key === 'createdAt' || key === 'updatedAt') out[key] = fixedTime(index)
        else out[key] = value
    }
    return out
}

function sanitizeUser(raw: Json, index: number): Json {
    const out: Json = {}
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'id') out[key] = `fixtureUser${index}`
        else if (key === 'username') out[key] = `fixture_user_${index}`
        else if (key === 'name') out[key] = `Fixture User ${index}`
        else if (key === 'locale') out[key] = 'en'
        else if (key === 'createdAt' || key === 'updatedAt' || key === 'seenAt') out[key] = fixedTime(index)
        else if (key === 'avatar') out[key] = value && typeof value === 'object' ? sanitizeMedia(value as Json, index, 'avatar') : null
        else out[key] = value
    }
    return out
}

/** `GET /videos` 的单条结果（`Iwara.Video`） */
function sanitizeVideo(raw: Json, index: number): Json {
    const out: Json = {}
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'id') out[key] = `fixtureVideo${index}`
        else if (key === 'slug') out[key] = `fixture-video-${index}`
        else if (key === 'title') out[key] = `Fixture Video ${index}`
        else if (key === 'body') out[key] = null
        else if (key === 'rating') out[key] = 'r15'
        else if (key === 'fileUrl') out[key] = `https://fixture.invalid/file/${index}`
        // 外链视频在扩展里走「非站内」分支，夹具不携带任何真实外链
        else if (key === 'embedUrl') out[key] = value ? `https://fixture.invalid/embed/${index}` : null
        else if (key === 'createdAt' || key === 'updatedAt') out[key] = fixedTime(index)
        else if (key === 'user') out[key] = sanitizeUser(value as Json, index)
        else if (key === 'file') out[key] = sanitizeMedia(value as Json, index, 'file')
        else if (key === 'customThumbnail') out[key] = null
        else if (key === 'tags') out[key] = (value as Json[]).map((tag, tagIndex) => ({ ...tag, id: `fixtureTag${index}_${tagIndex + 1}` }))
        else out[key] = value
    }
    return out
}

/** 端点级脱敏；返回 `null` 表示「不认识，不写盘」 */
function sanitizeApiBody(pathname: string, body: unknown): unknown {
    if (pathname === '/user/token') {
        const token = (body as { accessToken?: unknown }).accessToken
        return typeof token === 'string' ? { accessToken: 'fixture-access-token' } : null
    }
    const page = body as { count?: number; limit?: number; page?: number; results?: Json[] }
    if (!Array.isArray(page.results)) return null
    return {
        ...page,
        results: page.results.slice(0, MAX_CARDS).map((raw, index) => sanitizeVideo(raw, index + 1))
    }
}

const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
})
try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    console.log(`[fixtures] 打开 ${SITE_URL}（headed，过 Cloudflare）…`)

    // API 录制：站点自己会打 `//api.iwara.tv/videos?...`，直接旁路收下来
    const recorded = new Map<string, unknown>()
    page.on('response', (response) => {
        const url = new URL(response.url())
        if (!/(^|\.)api\.iwara\.tv$/.test(url.hostname)) return
        const file = API_TARGETS[url.pathname]
        if (!file || !response.ok()) return
        void response
            .json()
            .then((body) => {
                const sanitized = sanitizeApiBody(url.pathname, body)
                if (sanitized !== null && !recorded.has(file)) recorded.set(file, sanitized)
            })
            .catch(() => undefined)
    })

    const response = await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    if (!response?.ok()) throw new Error(`站点返回 ${response?.status()}`)
    await page.waitForSelector('.videoTeaser', { timeout: 60_000 })
    // 等骨架屏/首屏渲染稳定
    await page.waitForTimeout(2000)

    const html = await page.evaluate(sanitizeInPage, { maxCards: MAX_CARDS, blankImage: BLANK_IMAGE, css: SITE_CSS })
    writeFileSync(OUT_FILE, html, 'utf8')
    console.log(`[fixtures] 已写入 ${path.relative(process.cwd(), OUT_FILE)}（${(html.length / 1024).toFixed(1)} KiB，${MAX_CARDS} 张卡片）`)

    mkdirSync(API_DIR, { recursive: true })
    for (const [file, body] of recorded) {
        const target = path.join(API_DIR, file)
        const json = `${JSON.stringify(body, null, 4)}\n`
        writeFileSync(target, json, 'utf8')
        console.log(`[fixtures] 已写入 ${path.relative(process.cwd(), target)}（${(json.length / 1024).toFixed(1)} KiB）`)
    }
    const missing = Object.values(API_TARGETS).filter((file) => !recorded.has(file))
    if (missing.length > 0) console.warn(`[fixtures] 未录到：${missing.join(', ')}（登录态相关端点属正常）`)
} finally {
    await browser.close()
}

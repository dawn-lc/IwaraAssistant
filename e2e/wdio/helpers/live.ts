/**
 * 真实站点（iwara.tv）冒烟辅助层
 *
 * 策略对齐源用户脚本项目 IwaraDownloadTool 的 e2e 实践（见其
 * `e2e/playwright/specs/` 的头注与 `e2e/helpers/launchArgs.ts`）：
 *
 * 1. **显式开关**：`E2E_LIVE=1` 才跑；默认套件与 CI 完全不触发真实站点。
 * 2. **单会话 + 串行 + 单标签**：反复冷启动/反复加载首页是 Cloudflare 风控
 *    评分的最大诱因。本套件只在 `before` 里加载一次列表页，之后全程站内导航。
 * 3. **真实品牌浏览器 + 反自动化指纹**：启动参数在 `wdio.conf.ts` 按 live 追加。
 * 4. **人在回路**：`E2E_HUMAN=1` 时交互式挑战留给人工点选，预算放宽到 10 分钟；
 *    否则检测到挑战直接 skip 整套，不把风控当成产品缺陷。
 * 5. **状态驱动**：所有等待都是「DOM 达到某状态」的轮询，没有固定 sleep。
 * 6. **失败现场**：断言失败前 dump 页面快照（URL/标题/注入标记/卡片数/菜单项）。
 *
 * 与源项目的差异（扩展 vs 用户脚本）：
 * - 用户脚本靠「脚本管理器扩展 + 安装 API」装载，扩展直接 `browser.installExtension`；
 * - 用户脚本能读 `window` 上的守卫标记，扩展的 MAIN 世界标记读不到，
 *   故改用 ISOLATED 世界写回的 `<html data-ia-bridge>`（见 `src/content/isolated.ts`）。
 */
import type { Browser } from 'webdriverio'

/** 真实站点冒烟总开关 */
export function liveEnabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.E2E_LIVE?.trim() ?? '')
}

/** 人在回路模式（挑战需人工点选；单用例超时放宽） */
export function humanModeEnabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.E2E_HUMAN?.trim() ?? '')
}

/** 人在模式下的等待预算（AI/人工目视都不可控，默认 10 分钟） */
export function humanTimeoutMs(): number {
    return Number(process.env.E2E_HUMAN_TIMEOUT ?? 600_000)
}

/** 目标站点（`E2E_SITE_URL` 可覆盖，便于自建反代/镜像） */
export function liveSiteUrl(): string {
    const raw = process.env.E2E_SITE_URL?.trim()
    return (raw && raw.length > 0 ? raw : 'https://www.iwara.tv').replace(/\/+$/, '')
}

/** 拼站内绝对 URL（传入 `/videos` 这类路径） */
export function liveUrl(path = '/'): string {
    return `${liveSiteUrl()}${path.startsWith('/') ? path : `/${path}`}`
}

// ── Cloudflare / 风控挑战识别 ─────────────────────────────────────────

export type ChallengeState = 'none' | 'interactive' | 'blocked'

/** 挑战页正文特征（源项目 docs/PLAYWRIGHT-CHROMIUM-EXTENSION-LOADING.md §8） */
const CHALLENGE_TEXT_MARKERS = ['performing security verification', 'verify you are human', 'just a moment', 'checking your browser', 'enable javascript and cookies to continue', 'attention required'] as const

/** 挑战页标题特征 */
const CHALLENGE_TITLE_MARKERS = ['just a moment', 'attention required', 'security verification'] as const

export interface PageSnapshot {
    url: string
    title: string
    readyState: string
    /** ISOLATED 世界握手标记：pending / ready / no-ack（见 src/content/isolated.ts） */
    bridge: string | null
    /**
     * `data-start` 时机证据（`html[data-ia-early]`）：
     * 形如 `body=0;head=0;elements=3`，body=0 证明注入发生在 body 出现之前。
     */
    early: string | null
    /**
     * fetch 钩子安装时机证据（`html[data-ia-hook]`，由 MAIN 世界第一段注入写入）：
     * 形如 `readyState=loading;body=0;elements=0`。
     */
    hook: string | null
    /**
     * 卡片元数据链路状态（`html[data-ia-meta]`）：`ok:<返回条数>:<有 uploadTime 的条数>` 或 `fail:<原因>`。
     * 链路：页面 fetch 被拦截 → 后台入库 → GET_CARD_META → 写回 checkbox 属性。
     */
    meta: string | null
    hasMenu: boolean
    /**
     * 页内样式是否生效。
     *
     * 样式由 manifest `content_scripts[].css` **声明式注入**，不会产生 `<style>` 节点，
     * 因此不能用「DOM 里有没有 style 元素」判断（旧实现就是这么错判的）。
     * 这里直接问样式系统：菜单/水印的 computed `position` 必须为 `fixed`，
     * 该值只能来自我们的样式表（裸 div/p 默认 `static`）。
     */
    hasStyle: boolean
    cards: number
    checkboxes: number
    checked: number
    menuActions: string[]
    beautify: boolean
    widescreen: boolean
    turnstileFrames: number
    bodyText: string
}

/** 抓取一次页面快照（快照用于诊断与断言输入，不是活引用） */
export async function snapshotPage(browser: Browser): Promise<PageSnapshot> {
    return (await browser.execute(() => {
        const html = document.documentElement
        const menu = document.getElementById('pluginMenu')
        const actions = menu ? Array.from(menu.querySelectorAll<HTMLElement>('li[data-action]')).map((item) => item.dataset['action'] ?? '') : []
        const cards = document.querySelectorAll('.videoTeaser').length
        const boxes = document.querySelectorAll<HTMLInputElement>('input.selectButton')
        return {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            bridge: html?.getAttribute('data-ia-bridge') ?? null,
            early: html?.getAttribute('data-ia-early') ?? null,
            hook: html?.getAttribute('data-ia-hook') ?? null,
            meta: html?.getAttribute('data-ia-meta') ?? null,
            hasMenu: menu !== null,
            // 声明式 CSS 无 DOM 节点：用「样式是否真的生效」判定（见 PageSnapshot.hasStyle）
            hasStyle: [menu, document.getElementById('pluginWatermark')].some((node) => node !== null && getComputedStyle(node).position === 'fixed'),
            cards,
            checkboxes: boxes.length,
            checked: Array.from(boxes).filter((box) => box.checked).length,
            menuActions: actions,
            beautify: html?.classList.contains('ia-beautify') === true,
            widescreen: html?.classList.contains('ia-widescreen') === true,
            turnstileFrames: document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]').length,
            bodyText: (document.body?.innerText ?? '').slice(0, 600)
        }
    })) as PageSnapshot
}

/** 由页面快照判定挑战状态 */
export function challengeStateOf(snapshot: PageSnapshot): ChallengeState {
    const haystack = `${snapshot.title}\n${snapshot.bodyText}`.toLowerCase()
    const matched = CHALLENGE_TEXT_MARKERS.some((marker) => haystack.includes(marker)) || CHALLENGE_TITLE_MARKERS.some((marker) => haystack.includes(marker))
    if (!matched) return 'none'
    return snapshot.turnstileFrames > 0 ? 'interactive' : 'blocked'
}

// ── 卡片复选框契约（对齐源项目 css/videoCard.css + ui/widgets/checkbox.ts） ──

export interface CheckboxContract {
    cardCount: number
    checkboxCount: number
    className: string
    videoId: string | null
    videoName: string | null
    videoAlias: string | null
    videoAuthor: string | null
    /** 源项目把复选框 append 到缩略图父元素末尾（DOM 顺序最后） */
    isLastChildOfHost: boolean
    hostClass: string
    hostPosition: string
    computed: {
        position: string
        width: string
        height: string
        right: string
        top: string
        zIndex: string
        cursor: string
        accentColor: string
    }
    /** 用同一页面上下文解析 `var(--primary)`，避免硬编码主题色 */
    themePrimaryAccent: string
}

/**
 * 读取首个卡片复选框的实现契约（类名/属性/插入点/计算样式/主题色）。
 *
 * 这些断言的依据是源用户脚本项目：
 * - `src/css/videoCard.css` 的 `.selectButton{accent-color:var(--primary);position:absolute;width:38px;height:38px;right:0;cursor:pointer;z-index:100;top:22px}`
 * - `src/ui/widgets/checkbox.ts` 的 `input.selectButton[videoID][videoName][videoAlias][videoAuthor]` + append 到 `thumbnail.parentElement`
 */
export async function readCheckboxContract(browser: Browser): Promise<CheckboxContract> {
    return (await browser.execute(() => {
        const cards = document.querySelectorAll('.videoTeaser')
        const box = document.querySelector<HTMLInputElement>('input.selectButton')
        if (!box) throw new Error('页面内没有 input.selectButton')
        const style = getComputedStyle(box)
        const host = box.parentElement

        // 主题色解析：同上下文下把 var(--primary) 应用到临时元素再读计算值
        const probe = document.createElement('span')
        probe.style.accentColor = 'var(--primary)'
        document.documentElement.appendChild(probe)
        const themePrimaryAccent = getComputedStyle(probe).accentColor
        probe.remove()

        return {
            cardCount: cards.length,
            checkboxCount: document.querySelectorAll('input.selectButton').length,
            className: box.className,
            videoId: box.getAttribute('videoID'),
            videoName: box.getAttribute('videoName'),
            videoAlias: box.getAttribute('videoAlias'),
            videoAuthor: box.getAttribute('videoAuthor'),
            isLastChildOfHost: host?.lastElementChild === box,
            hostClass: host?.className ?? '',
            hostPosition: host ? getComputedStyle(host).position : '',
            computed: {
                position: style.position,
                width: style.width,
                height: style.height,
                right: style.right,
                top: style.top,
                zIndex: style.zIndex,
                cursor: style.cursor,
                accentColor: style.accentColor
            },
            themePrimaryAccent
        }
    })) as CheckboxContract
}

/**
 * 轮询直到挑战消失（或超时）。
 *
 * - 无挑战：立即返回 `none`
 * - 人在模式：持续轮询到人工点完为止（预算 `humanTimeoutMs()`）
 * - 否则：按 `timeoutMs` 短等一次（有些挑战是自动过盾，几秒即走）
 */
export async function waitForChallengeCleared(browser: Browser, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<{ state: ChallengeState; snapshot: PageSnapshot }> {
    const timeoutMs = options.timeoutMs ?? (humanModeEnabled() ? humanTimeoutMs() : 45_000)
    const intervalMs = options.intervalMs ?? 1_000
    const deadline = Date.now() + timeoutMs
    let snapshot = await snapshotPage(browser)
    let state = challengeStateOf(snapshot)

    if (state === 'none') return { state, snapshot }

    if (humanModeEnabled()) {
        console.log(`[live] 检测到挑战（${state}）——人在模式：请在浏览器窗口内完成验证，预算 ${Math.round(timeoutMs / 1000)}s`)
    } else {
        console.log(`[live] 检测到挑战（${state}）——等待自动过盾，预算 ${Math.round(timeoutMs / 1000)}s`)
    }

    while (Date.now() < deadline) {
        await browser.pause(intervalMs)
        snapshot = await snapshotPage(browser)
        state = challengeStateOf(snapshot)
        if (state === 'none') {
            console.log('[live] 挑战已通过')
            return { state, snapshot }
        }
        if (humanModeEnabled()) {
            console.log(`[live] 仍在挑战页：turnstileFrames=${snapshot.turnstileFrames} url=${snapshot.url} title=${JSON.stringify(snapshot.title)}`)
        }
    }

    return { state, snapshot }
}

// ── 注入等待 ──────────────────────────────────────────────────────────

export interface InjectionOptions {
    /** 期望出现的最少卡片数；列表页传 1，详情页传 0（只等菜单） */
    minCards?: number
    /** 期望出现的最少卡片复选框数（默认 0；注入有 300ms 防抖，不能只等卡片） */
    minCheckboxes?: number
    timeoutMs?: number
}

/**
 * 等待扩展注入完成：菜单 + 样式 + 指定卡片数/复选框数。
 *
 * 目标站点是 SPA，卡片由前端拉 API 后渲染；注入由 MutationObserver 增量补齐
 * （带 300ms 防抖），因此这里轮询具体数量而不是等一次 DOMContentLoaded。
 */
export async function waitForInjection(browser: Browser, options: InjectionOptions = {}): Promise<PageSnapshot> {
    const minCards = options.minCards ?? 0
    const minCheckboxes = options.minCheckboxes ?? 0
    const timeoutMs = options.timeoutMs ?? (humanModeEnabled() ? humanTimeoutMs() : 60_000)
    let snapshot = await snapshotPage(browser)
    try {
        await browser.waitUntil(
            async () => {
                snapshot = await snapshotPage(browser)
                return snapshot.hasMenu && snapshot.hasStyle && snapshot.cards >= minCards && snapshot.checkboxes >= minCheckboxes
            },
            {
                timeout: timeoutMs,
                interval: 500,
                timeoutMsg: `扩展未在 ${timeoutMs}ms 内完成注入（菜单/样式/卡片 ${minCards}/复选框 ${minCheckboxes}）`
            }
        )
    } catch (error) {
        await dumpSnapshot(browser, 'waitForInjection 失败')
        throw error
    }
    return snapshot
}

// ── 菜单 / 水印契约（对齐源 ui/menu.ts + css/menu.css + ui/widgets/watermark.ts） ──

export interface MenuContract {
    menuId: string
    hasList: boolean
    itemTagNames: string[]
    menu: {
        position: string
        right: string
        backgroundColor: string
        color: string
    }
    watermark: {
        className: string
        text: string
        backgroundColor: string
        color: string
    }
    version: string
    themeBodyDark: string
    themeBody: string
    themeText: string
}

/** 读取菜单与水印的实现契约（结构/定位/主题变量跟随） */
export async function readMenuContract(browser: Browser): Promise<MenuContract> {
    return (await browser.execute(() => {
        const menu = document.getElementById('pluginMenu')
        if (!menu) throw new Error('页面内没有 #pluginMenu')
        const list = menu.querySelector('ul')
        const watermark = document.getElementById('pluginWatermark') as HTMLElement | null

        const rootStyle = getComputedStyle(document.documentElement)
        const readVar = (name: string) => rootStyle.getPropertyValue(name).trim()

        // 主题变量解析成实际颜色（与站点当前主题一致）
        const probe = document.createElement('span')
        probe.style.color = 'var(--text)'
        probe.style.backgroundColor = 'var(--body)'
        const bodyDarkProbe = document.createElement('span')
        bodyDarkProbe.style.backgroundColor = 'var(--body-dark)'
        document.documentElement.appendChild(probe)
        document.documentElement.appendChild(bodyDarkProbe)
        const themeBody = getComputedStyle(probe).backgroundColor
        const themeText = getComputedStyle(probe).color
        const themeBodyDark = getComputedStyle(bodyDarkProbe).backgroundColor
        probe.remove()
        bodyDarkProbe.remove()

        const menuStyle = getComputedStyle(menu)
        const watermarkStyle = watermark ? getComputedStyle(watermark) : null

        return {
            menuId: menu.id,
            hasList: list !== null,
            itemTagNames: list ? Array.from(list.children).map((child) => child.tagName) : [],
            menu: {
                position: menuStyle.position,
                right: menuStyle.right,
                backgroundColor: menuStyle.backgroundColor,
                color: menuStyle.color
            },
            watermark: {
                className: watermark?.className ?? '',
                text: watermark?.textContent ?? '',
                backgroundColor: watermarkStyle?.backgroundColor ?? '',
                color: watermarkStyle?.color ?? ''
            },
            version: (globalThis as unknown as { browser?: { runtime?: { getManifest?: () => { version?: string } } } }).browser?.runtime?.getManifest?.().version ?? '',
            themeBodyDark,
            themeBody,
            themeText
        }
    })) as MenuContract
}

// ── 菜单交互（状态驱动，无固定 sleep） ────────────────────────────────

/**
 * 菜单是否已展开。
 */
export async function isMenuExpanded(browser: Browser): Promise<boolean> {
    return (await browser.execute(() => document.getElementById('pluginMenu')?.classList.contains('expanded') === true)) as boolean
}

/**
 * 展开悬浮菜单。
 *
 * 源 ui/menu.ts 桌面端是 mouseover 展开 / mouseout 300ms 收起，收起态
 * `transform: translate(calc(100% - 26px))` 把菜单推到只剩 26px 可见条。
 *
 * 为什么不用真实指针悬停：元素几乎全在视口外，`moveTo()` 取元素中心会落在视口外；
 * 用 `origin:'viewport'` 的绝对坐标在本机 125% 缩放下被按物理像素解释，实测鼠标
 * 停在 `HTML` 上而菜单始终不展开。**悬停接线本身**由独立用例
 * （`hover 展开接线`）用 mouseover 事件同步断言覆盖；这里负责把菜单带到
 * 「已展开」稳定态，之后的菜单项点击仍是真实点击。
 */
export async function openMenu(browser: Browser): Promise<void> {
    const root = await browser.$('#pluginMenu')
    await root.waitForDisplayed({ timeout: 30_000 })

    const translateX = async (): Promise<number | null> =>
        (await browser.execute(() => {
            const element = document.getElementById('pluginMenu')
            if (!element) return null
            const transform = getComputedStyle(element).transform
            if (transform === 'none') return 0
            return /matrix\(([^)]+)\)/.exec(transform)?.[1]?.split(',').map(Number)[4] ?? null
        })) as number | null

    // 测试侧禁用滑入过渡：transition 的时间推进受浏览器渲染调度影响
    // （窗口被遮挡时 Chrome 会暂停动画，实测 computed transform 永远停在收起值），
    // 关掉过渡能让「加 expanded → 立即到位」变成确定行为，不影响生产代码。
    await browser.execute(() => {
        const element = document.getElementById('pluginMenu')
        if (element) element.style.transition = 'none'
    })

    // 有界重试：`mouseout` 后源菜单有 300ms 收起定时器，可能与展开交叉；
    // 定时器是一次性的，下一轮重新加 expanded 必定稳定滑入。
    const samples: Array<{ at: number; exists: boolean; expanded: boolean; x: number | null; transform: string }> = []
    const started = Date.now()
    const deadline = started + 15_000
    while (Date.now() < deadline) {
        await browser.execute(() => document.getElementById('pluginMenu')?.classList.add('expanded'))
        const pollDeadline = Date.now() + 1_500
        while (Date.now() < pollDeadline) {
            const state = (await browser.execute(() => {
                const element = document.getElementById('pluginMenu')
                if (!element) return { exists: false, expanded: false, transform: '', x: null }
                const transform = getComputedStyle(element).transform
                const x = transform === 'none' ? 0 : (/matrix\(([^)]+)\)/.exec(transform)?.[1]?.split(',').map(Number)[4] ?? null)
                return {
                    exists: true,
                    expanded: element.classList.contains('expanded'),
                    transform,
                    x
                }
            })) as { exists: boolean; expanded: boolean; transform: string; x: number | null }
            samples.push({ at: Date.now() - started, ...state })
            if (state.exists && state.x !== null && Math.abs(state.x) < 1) return
            await browser.pause(100)
        }
    }
    console.log('[live-diag] openMenu 采样（末 10 条）：', JSON.stringify(samples.slice(-10), null, 2))
    throw new Error('悬浮菜单未在超时内滑入（expanded 反复被 mouseout 定时器收起）')
}

/**
 * 点击菜单项（按 data-action）。
 *
 * ⚠️ 为什么要重试：源 `ui/menu.ts` 在**触控设备**上「点完菜单项 → 150ms 后自动收起」，
 * 而 Windows 触摸屏笔记本的 `navigator.maxTouchPoints > 0` 会被判为触控（源项目同款判定）。
 * 于是「上一次点击的收起定时器」可能正好在「下一次点击前把菜单滑回视口外」，
 * WebDriver 会把菜单项判为不可交互。每一轮重新展开并重试即可稳定通过。
 */
export async function clickMenuAction(browser: Browser, action: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
        await openMenu(browser)
        const item = await browser.$(`#pluginMenu li[data-action="${action}"]`)
        try {
            await item.waitForClickable({ timeout: 3_000 })
            await item.click()
            await browser.pause(200)
            return
        } catch (error) {
            lastError = error
            if (attempt === 3) break
            // 收起定时器把菜单带走了：等它触发后重新展开再试
            await browser.pause(300)
        }
    }

    // 三轮都失败：打现场再抛（矩形 / 视口 / 中心点命中链）
    const diag = await browser.execute((targetAction) => {
        const li = document.querySelector<HTMLElement>(`#pluginMenu li[data-action="${targetAction}"]`)
        if (!li) return { found: false }
        const rect = li.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const hit = document.elementFromPoint(cx, cy)
        const menu = document.getElementById('pluginMenu') as HTMLElement | null
        const menuRect = menu?.getBoundingClientRect()
        return {
            found: true,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            menuRect: menuRect ? { left: menuRect.left, top: menuRect.top, width: menuRect.width, height: menuRect.height } : null,
            expanded: menu?.classList.contains('expanded') ?? false,
            menuTransform: menu ? getComputedStyle(menu).transform : '',
            pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
            maxTouchPoints: navigator.maxTouchPoints,
            hitTag: hit?.tagName ?? '',
            hitClass: (hit as HTMLElement | null)?.className ?? '',
            hitIsInsideMenu: menu ? menu.contains(hit) : false
        }
    }, action)
    console.log(`[live-diag] clickMenuAction(${action}) 三轮失败，现场：`, JSON.stringify(diag, null, 2))
    throw lastError
}

/** 当前页可见的菜单项（data-action 列表） */
export async function menuActions(browser: Browser): Promise<string[]> {
    return (await browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('#pluginMenu li[data-action]')).map((item) => item.dataset['action'] ?? ''))) as string[]
}

// ── 诊断输出（失败现场，全量打印不过滤） ──────────────────────────────

/** 打印完整页面快照（对齐「禁止过滤输出」的调试纪律） */
export async function dumpSnapshot(browser: Browser, label: string): Promise<void> {
    const snapshot = await snapshotPage(browser)
    console.log(`[live-diag] ${label}`)
    console.log(JSON.stringify(snapshot, null, 2))
}

/**
 * 断言前先取快照，失败时把现场一并抛出。
 * （WDIO 的 assert 错误信息只带期望/实际，DOM 现场要自己补）
 */
export async function withDiagnostics<T>(browser: Browser, label: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run()
    } catch (error) {
        await dumpSnapshot(browser, label)
        throw error
    }
}

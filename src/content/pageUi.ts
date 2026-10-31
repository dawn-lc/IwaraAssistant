/**
 * 页内交互层（ISOLATED 世界）—— 启动、路由与观察器。
 *
 * 设计红线（docs/01/05）：页面内只做「转发器控件」—— 悬浮菜单、视频卡片复选框、
 * 手动下载对话框；零状态反馈（通知走后台 notifications，队列详情在 options/popup）。
 *
 * 样式不在本文件：见 `src/content/css/*.css`，构建为 `content/page-ui.css`，
 * 由 manifest `content_scripts[].css` **声明式注入**（浏览器在 document_start
 * 期间、DOM 构建前应用），因此运行时零注入、无 `<style>` 节点、无 head 不存在问题。
 *
 * ## 文件分工（原来 900 行全在这里，改动一处要全文搜）
 *
 * | 模块              | 职责                                             |
 * | ----------------- | ------------------------------------------------ |
 * | `page/dom.ts`     | 选择器常量、宿主节点、storage 访问、纯解析函数    |
 * | `page/uiState.ts` | 配置值的唯一可变容器                             |
 * | `page/config.ts`  | 配置 → DOM 的生效动作（class/菜单/水印）         |
 * | `page/selection.ts` | 选择集（内存 ⇄ storage）+ 复选框呈现           |
 * | `page/cardMeta.ts` | 后台库提供的角标 / 上传时间 / 删除按钮          |
 * | `page/menu.ts`    | 悬浮菜单的组装与动作派发                         |
 * | `page/watermark.ts` | 右下角水印 + 五连击调试开关                     |
 * | `page/manualDialog.ts` | 手动下载对话框                              |
 * | `page/requests.ts` | 向后台发下载请求                                |
 * | **本文件**        | 启动顺序、路由重建、DOM 观察器 —— 只做编排      |
 */
import { isAllVideosPath, pageTypeOf } from '../shared/pageType'
import type { Req } from '../messaging/protocol'
import { setLanguagePref } from '../shared/i18n'
import { changedValue } from '../shared/storageChanges'
import { CONFIG_KEY } from '../shared/storageKeys'
import { CARD_SELECTOR, CHECKBOX_CLASS, rehostToBody } from './page/dom'
import { applyUiConfig, loadUiConfig } from './page/config'
import type { UiConfig } from './page/config'
import { resetCardMeta } from './page/cardMeta'
import { ensureMenu, rebuildMenu } from './page/menu'
import { installWatermark } from './page/watermark'
import { injectCards, isInjectionOn, loadSelection, refreshCards, removeCheckboxes, setInjectionMode, syncCheckboxes, updateSelectionCount } from './page/selection'
import { uiConfig } from './page/uiState'

let started = false
let observer: MutationObserver | null = null
let refreshTimer: number | undefined
let lastRouteKey = ''

/** 当前路由标识（pathname + search；hash 单独由 hashchange 处理） */
function routeKey(): string {
    return `${window.location.pathname}${window.location.search}`
}

/** 路由变化后的重建：清复选框、重建菜单（页类型可能变了）、重新注入 */
function rebuildForRoute(): void {
    lastRouteKey = routeKey()
    removeCheckboxes()
    // 角标数据属于上一页的卡片：清空已查询记录，新页面重新拉一轮
    resetCardMeta()
    rebuildMenu()
    refreshCards()
    reportAllVideosVisit()
}

/**
 * 自动遍历订阅流的触发点（与源项目同款时机）。
 *
 * 源 `ui/menu.ts` 的 `pageChange()`：落在 `PageType.VideoList`（即 `/videos`）且
 * 「回填私有/不公开缓存」开、「过滤订阅页 不公开/私有」关时，调一次 `parseUnlistedAndPrivate()`。
 * `pageChange()` 在首屏就绪与每次 SPA 路由变化时都会执行，所以它不是定时器，
 * 而是「每次到达就试一次」，靠防重入 + 跨页锁 + 「追平当月即停」把成本压到 1 个请求。
 *
 * 本文件只负责「报到达」：是否真的跑由后台按配置、最小间隔与登录态决定，
 * 页面侧不复制一份配置语义（那是两个真相源的开端）。
 */
function reportAllVideosVisit(): void {
    if (!isAllVideosPath(window.location.pathname)) return
    void browser.runtime.sendMessage({ type: 'AUTO_SYNC_SUBSCRIBED', payload: {} } satisfies Req).catch(() => {
        // 后台未就绪（SW 冷启动竞态）：不重试，下一次路由变化会再报一次
    })
}

function scheduleRefresh(): void {
    if (refreshTimer !== undefined) return
    refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        rehostToBody()
        // SPA 的 pushState 不触发 popstate/hashchange（只有后退/前进才触发），
        // 靠已有的 DOM 变更观察兜底：先比对路由，再增量注入，不额外起定时器。
        if (routeKey() !== lastRouteKey) {
            rebuildForRoute()
            return
        }
        refreshCards()
    }, 50)
}

/** 新增节点里是否含视频卡片（命中就不等 debounce，立即注入） */
function containsCard(nodes: NodeList): boolean {
    for (const node of Array.from(nodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const element = node as Element
        if (element.matches?.(CARD_SELECTOR) || element.querySelector?.(CARD_SELECTOR)) return true
    }
    return false
}

/** 悬停卡片 + Space 快捷勾选（原 installSelectionShortcuts） */
function installSpaceShortcut(): void {
    let hovered: Element | null = null
    document.addEventListener(
        'mouseover',
        (event) => {
            hovered = event.target instanceof Element ? event.target : null
        },
        true
    )
    document.addEventListener(
        'keydown',
        (event) => {
            if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return
            const card = hovered?.closest(CARD_SELECTOR)
            if (!card) return
            const box = card.querySelector<HTMLInputElement>(`input.${CHECKBOX_CLASS}`)
            if (!box) return
            // 对齐源项目 features/selection.ts：直接 .click()，由复选框自身的
            // click/change 处理器走同一条选择态更新路径（避免两套写入口）
            box.click()
            event.preventDefault()
        },
        true
    )
}

/**
 * 配置热更新：美化/宽屏/菜单语言/自动注入。
 *
 * `wasInject` 必须在 `applyUiConfig` **之前**读：它会替换 `uiConfig` 的内容，
 * 之后再读就只能看到新值，前后比较永远相等、自动注入的开关就失效了。
 */
function watchConfig(): void {
    browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !(CONFIG_KEY in changes)) return
        const wasInject = uiConfig.autoInjectCheckbox !== false
        applyUiConfig(changedValue<UiConfig>(changes, CONFIG_KEY))
        const nowInject = uiConfig.autoInjectCheckbox !== false
        if (wasInject === nowInject) return
        setInjectionMode(nowInject)
        if (!nowInject) removeCheckboxes()
        else if (pageTypeOf(window.location.pathname) === 'videoList') refreshCards()
    })
}

function start(): void {
    if (started) return
    started = true

    // 语言先用浏览器语言渲染一帧：配置要从 storage 异步读，等它回来再建 UI 会让菜单/水印
    // 晚一拍出现；反过来先建英文首帧再被覆盖，又会闪一下。`undefined` → 「跟随浏览器」。
    setLanguagePref(undefined)

    // ⚠️ 不再等 DOMContentLoaded。
    // document_start 时 head/body 都还不存在，UI 先挂 documentElement
    // （ScriptCat 的 early 注入语义），卡片由观察器后续增量注入。
    // 样式已由 manifest 声明式注入（content_scripts[].css），此处无需任何注入动作。
    ensureMenu()
    installWatermark()

    void loadUiConfig()
    void loadSelection().then(() => {
        syncCheckboxes()
        updateSelectionCount()
        // autoInjectCheckbox 开启时默认进入选择模式（与原版一致）
        if (uiConfig.autoInjectCheckbox !== false && pageTypeOf(window.location.pathname) === 'videoList') {
            setInjectionMode(true)
            injectCards()
        }
    })

    watchConfig()

    observer = new MutationObserver((records) => {
        // 卡片一插入就注入（不等 debounce）：SPA 首屏渲染的卡片通常在几百 ms 内出现，
        // 300ms 防抖会让首个复选框明显滞后于卡片。
        if (isInjectionOn()) {
            for (const record of records) {
                if (containsCard(record.addedNodes)) {
                    injectCards()
                    break
                }
            }
        }
        scheduleRefresh()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    installSpaceShortcut()

    lastRouteKey = routeKey()
    // 冷加载也算一次「到达」：源项目 `registerInjectionRule` 注入后显式补发 pageChange()
    reportAllVideosVisit()

    // 后退/前进（popstate）与锚点（hashchange）立即重建；pushState 由观察器兜底
    const onRouteChange = (): void => {
        rebuildForRoute()
    }
    window.addEventListener('popstate', onRouteChange)
    window.addEventListener('hashchange', onRouteChange)
}

// 立即启动：document_start 阶段 documentElement 已存在（head/body 可能还没有）
start()

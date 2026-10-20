/**
 * 钓鱼仿冒站点防护 —— ISOLATED world 段（界面 + 放行通道）。
 *
 * 分工：
 * - 后台 `background/runtime/guardRules.ts` 负责**判定**与**网络层封锁**（DNR session 规则，
 *   拦得住 img / beacon / 表单 / 跨域 iframe 里的原生请求）；
 * - MAIN world 的 `main.ts` 负责在页面 JS 层先一步封住 fetch/XHR/WS 等（网络层规则
 *   下发前的窗口期，以及客户端能构造的非网络能力，比如 WebRTC）；
 * - 这里负责**让用户看得见**，并把「继续访问」这个决定告诉后台（解除封锁）。
 *
 * 为什么判定要问后台而不是自己算：网络层封锁靠标签页身份，而 tabId 只有后台
 * 从 `sender.tab` 拿得到；同时「业务判定归后台」是本项目的一贯边界（docs/01）。
 *
 * 设计约束：
 * - **所有页面都会注入本脚本**（manifest `matches: <all_urls>`），因此必须极轻：
 *   不引入 i18n 字典（那会把三语词条塞进每个页面的注入包），文案走 `browser.i18n`
 *   ——manifest 的 `_locales` 本来就是「渲染前就要确定的文案」的正确位置。
 * - **官方/无关域名直接返回**：不建 DOM、不发消息、不写任何全局。
 * - 警告层用 **closed shadow root**：页面的 CSS 改不到我们，页面脚本也读不到内部结构；
 *   宿主被移除时由 MutationObserver 补回（否则仿冒站一行 `remove()` 就把警告藏了）。
 * - 文案只说事实与下一步，不吓唬人：官方域名清单直接列出来，用户可自行核对地址栏。
 */
import { GUARD_CONTINUE_EVENT, GUARD_HOST_ID } from './protocol'
import type { GuardMode } from '../../shared/guardRule'
import { OFFICIAL_DOMAINS, classifyHost } from '../../shared/site'
import { send } from '../../messaging/hub'

/** 读 manifest 文案；缺失时回落到英文（`browser.i18n` 在没有对应语言时返回空串） */
function text(key: string, fallback: string): string {
    const message = browser.i18n?.getMessage?.(key)
    return typeof message === 'string' && message !== '' ? message : fallback
}

const HOST_ID = GUARD_HOST_ID

/** 观察器只在警告层存在时启用；放行/移除后必须断开，否则会无限补种 */
let observer: MutationObserver | null = null

function buildPanel(host: string): HTMLElement {
    const hostElement = document.createElement('div')
    hostElement.id = HOST_ID
    hostElement.setAttribute('data-ia-guard', 'suspicious')
    // 内联样式而不是外部 CSS：本脚本在所有站点上运行，不能假设扩展样式已注入
    hostElement.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block')

    const shadow = hostElement.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = `
        :host { all: initial }
        .wrap {
            position: fixed; inset: 0; box-sizing: border-box;
            display: flex; align-items: center; justify-content: center;
            padding: 24px; background: #14161c; color: #e8eaf0;
            font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
        }
        .panel { width: min(560px, 100%); background: #1d212b; border: 1px solid #3a4152; border-radius: 12px; padding: 28px 28px 22px; box-shadow: 0 18px 48px rgba(0,0,0,.45) }
        .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #4a2026; color: #ff9aa5; font-size: 12px; font-weight: 600; letter-spacing: .3px }
        h1 { margin: 14px 0 10px; font-size: 20px; line-height: 1.35 }
        p { margin: 0 0 10px; color: #b8bfd0 }
        code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #12151c; border: 1px solid #333a49; border-radius: 4px; padding: 1px 6px; color: #ffd479 }
        ul { margin: 8px 0 16px; padding-left: 20px; color: #b8bfd0 }
        .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px }
        button { font: inherit; padding: 9px 18px; border-radius: 8px; cursor: pointer; border: 1px solid #3a4152; background: #262c38; color: #e8eaf0 }
        button.primary { background: #7c5cff; border-color: #7c5cff; color: #fff; font-weight: 600 }
        button:hover { filter: brightness(1.12) }
        .foot { margin-top: 14px; font-size: 12px; color: #8a93a8 }
    `

    const wrap = document.createElement('div')
    wrap.className = 'wrap'

    const panel = document.createElement('div')
    panel.className = 'panel'

    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.textContent = text('guardBadge', 'Suspicious site')

    const heading = document.createElement('h1')
    heading.textContent = text('guardTitle', 'This looks like a fake Iwara website')

    const description = document.createElement('p')
    description.textContent = text('guardDescription', 'This page is not an official Iwara site. Do not enter your account, password, or any other sensitive information.')

    const hostLine = document.createElement('p')
    const hostLabel = document.createElement('strong')
    hostLabel.textContent = text('guardHostLabel', 'Current site: ')
    const hostCode = document.createElement('code')
    hostCode.textContent = host
    hostLine.append(hostLabel, hostCode)

    const officialTitle = document.createElement('p')
    officialTitle.textContent = text('guardOfficialLabel', 'Official domains:')

    const officialList = document.createElement('ul')
    for (const domain of OFFICIAL_DOMAINS) {
        const item = document.createElement('li')
        item.textContent = domain
        officialList.append(item)
    }

    const actions = document.createElement('div')
    actions.className = 'actions'

    const leave = document.createElement('button')
    leave.type = 'button'
    leave.className = 'primary'
    leave.textContent = text('guardLeave', 'Leave this site')
    leave.addEventListener('click', () => {
        // 优先回退：没有历史时直接跳到空白页，避免「返回」把用户送到上一个仿冒站
        if (history.length > 1) history.back()
        else location.replace('about:blank')
    })

    const proceed = document.createElement('button')
    proceed.type = 'button'
    proceed.textContent = text('guardProceed', 'I understand the risk, continue')
    proceed.addEventListener('click', () => {
        // 用户的明确选择：不与其对抗。三件事必须同时做——
        // ① 解除 MAIN world 的页面级封锁；② 撤掉警告层；③ 让后台解除本标签页的网络层封锁
        //    （只做前两件的话，刷新后规则还在，页面依旧加载不出来 = 放行是假的）
        window.dispatchEvent(new CustomEvent(GUARD_CONTINUE_EVENT, { detail: '1' }))
        observer?.disconnect()
        observer = null
        hostElement.remove()
        void send({ type: 'GUARD_RELEASE', payload: { host } }).catch((error: unknown) => {
            console.warn('[iwara-assistant] 钓鱼防护：解除网络层封锁失败（刷新后可能仍被拦截）:', error)
        })
    })

    actions.append(leave, proceed)

    const foot = document.createElement('p')
    foot.className = 'foot'
    foot.textContent = text('guardFooter', 'All network requests from this page are blocked while the warning is shown.')

    panel.append(badge, heading, description, hostLine, officialTitle, officialList, actions, foot)
    wrap.append(panel)
    shadow.append(style, wrap)
    return hostElement
}

function mount(host: string): void {
    if (classifyHost(host) !== 'suspicious') return
    if (document.getElementById(HOST_ID) !== null) return
    const root = document.documentElement
    if (root === null) {
        // document_start 时 documentElement 通常已存在；极少数情况下等一下解析器
        document.addEventListener('readystatechange', () => mount(host), { once: true })
        return
    }
    root.append(buildPanel(host))
    if (observer === null) {
        observer = new MutationObserver(() => {
            // 仿冒站可能直接把警告层删掉：删了就补回来（否则整个防护只是「一行 remove()」）
            if (document.getElementById(HOST_ID) === null) mount(host)
        })
        observer.observe(document, { childList: true, subtree: true })
    }
}

/**
 * 放行（不画警告）：MAIN world 在 document_start 已经**同步**把网络 API 换成了桩，
 * 这里用同一个事件把原生实现换回去——页面照常工作，我们不留任何可见痕迹。
 */
function allowThrough(): void {
    window.dispatchEvent(new CustomEvent(GUARD_CONTINUE_EVENT, { detail: '1' }))
}

async function negotiate(host: string): Promise<void> {
    let mode: GuardMode
    try {
        mode = (await send<{ mode: GuardMode }>({ type: 'GUARD_SYNC', payload: { host } })).mode
    } catch (error) {
        // 后台不可达（或消息层故障）：宁可多警告一次。此刻页面级拦截已经装好，
        // 网络层封锁可能没生效——警告里说「请求已被拦截」对 fetch/XHR 等仍然成立。
        console.warn('[iwara-assistant] 钓鱼防护：后台未响应，按已封锁处理:', error)
        mount(host)
        return
    }
    if (mode === 'released') allowThrough()
    else mount(host)
}

const hostname = location.hostname
if (classifyHost(hostname) === 'suspicious') void negotiate(hostname)

export {}

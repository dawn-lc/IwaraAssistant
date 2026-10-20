/**
 * 钓鱼仿冒站点防护 e2e。
 *
 * 为什么需要它：`host_permissions: <all_urls>` 与两个 `matches: <all_urls>` 的
 * content script 是本项目权限面最大的改动，而它的**唯一目的**就是这个防护。
 * 光有单测（主机名分层）不够——真正要证明的是「在真实浏览器里，脚本确实注入、
 * 警告层确实出现、页面的数据确实出不去」。
 *
 * 这里的断言分两层：
 * - **页面 JS 层**（`content/guard/main.ts`）：`fetch` / `XHR` / `WebSocket` 等被换成抛错的桩，
 *   错误信息带我们的标记；
 * - **扩展网络层**（DNR session 规则）：图片 / 跨域 iframe / beacon / 表单这些
 *   根本走不到 JS 层的通道，在浏览器网络栈就被拦下——`route` 一次都没命中。
 * 另外还守两件事：页面**自己**派发「继续访问」事件不足以解封（否则仿冒站一行代码
 * 就能绕过整个防护）；离开仿冒站后遗留规则必须被清掉（否则同一标签页的正常浏览被毁）。
 */
import { test, expect } from '../helpers/fixtures'

const GUARD_SELECTOR = '#iwara-assistant-guard'
/** `content/guard/main.ts` 拦截时使用的错误文案片段（页面侧可读到，用来区分「被我们拦」与「网络真失败」） */
const BLOCK_MARKER = 'Blocked by Iwara Assistant'

const FAKE_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body><h1 id="fake-title">Iwara sign in</h1></body></html>'

/**
 * 伪造一个「不在官方清单、但主机名含 iwara」的站点，并记录每个被真正发到网络的路径。
 *
 * 为什么用命中计数当断言：DNR 在网络栈拦下的请求不会到达 Playwright 的 route 回调，
 * 所以「count === 0」就是「请求根本没离开浏览器」的直接证据。
 */
async function fakeSite(context: import('@playwright/test').BrowserContext): Promise<{ hits: string[]; pattern: string }> {
    const pattern = 'http://iwara-fake.example/**'
    const hits: string[] = []
    await context.route(pattern, (route) => {
        const path = new URL(route.request().url()).pathname
        hits.push(path)
        if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PAGE })
        return route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' })
    })
    return { hits, pattern }
}

test.describe('钓鱼仿冒站点防护', () => {
    test('仿冒域名：警告层出现，页面 fetch 被拦截', async ({ sharedSession }) => {
        const { context } = sharedSession
        const { pattern } = await fakeSite(context)

        const probe = await context.newPage()
        try {
            await probe.goto('http://iwara-fake.example/')
            // 页面自身内容照常解析（我们只加警告层，不静默吞掉页面）
            await expect(probe.locator('#fake-title')).toBeAttached()
            // 警告层存在（closed shadow root 内部不可读，宿主元素与标记可断言）
            await expect(probe.locator(GUARD_SELECTOR)).toHaveAttribute('data-ia-guard', 'suspicious')

            // 页面 JS 层：fetch 被替换成桩，页面拿到的是我们的错误文案
            const rejected = await probe.evaluate(async () => {
                try {
                    await fetch('/exfiltrate')
                    return 'resolved'
                } catch (error) {
                    return String(error)
                }
            })
            expect(rejected).toContain(BLOCK_MARKER)
        } finally {
            await probe.close()
            await context.unroute(pattern)
        }
    })

    test('网络层封锁：图片 / 跨域 iframe / beacon / 表单请求根本没发出浏览器', async ({ sharedSession }) => {
        const { context } = sharedSession
        const { hits, pattern } = await fakeSite(context)

        const probe = await context.newPage()
        try {
            await probe.goto('http://iwara-fake.example/')
            await expect(probe.locator(GUARD_SELECTOR)).toBeAttached()

            const outcome = await probe.evaluate(async () => {
                const image = new Image()
                const imageOutcome = await new Promise<string>((resolve) => {
                    image.onload = () => resolve('loaded')
                    image.onerror = () => resolve('error')
                    image.src = '/pixel.png'
                    setTimeout(() => resolve('timeout'), 3000)
                })
                const beacon = navigator.sendBeacon('/beacon', 'secret')
                let formError = ''
                try {
                    const form = document.createElement('form')
                    form.action = '/collect'
                    form.method = 'post'
                    document.body.append(form)
                    form.submit()
                } catch (error) {
                    formError = String(error)
                }
                let rtcError = ''
                try {
                    new RTCPeerConnection()
                } catch (error) {
                    rtcError = String(error)
                }
                const frame = document.createElement('iframe')
                frame.src = '/frame.html'
                document.body.append(frame)
                await new Promise((resolve) => setTimeout(resolve, 800))
                return { imageOutcome, beacon, formError, rtcError }
            })

            // 图片：被拦 = 触发 error 而不是 load
            expect(outcome.imageOutcome).toBe('error')
            // beacon：返回值是「是否已排队」，被拦时必须为 false
            expect(outcome.beacon).toBe(false)
            // 表单与 WebRTC：JS 层直接掐掉（WebRTC 不走 HTTP，DNR 管不到）
            expect(outcome.formError).toContain(BLOCK_MARKER)
            expect(outcome.rtcError).toContain(BLOCK_MARKER)

            // 决定性证据：这些路径一次都没到过网络（route 没被命中）
            expect(hits.filter((path) => path !== '/')).toEqual([])
        } finally {
            await probe.close()
            await context.unroute(pattern)
        }
    })

    test('页面自己派发「继续访问」事件不足以解封（网络层仍然拦）', async ({ sharedSession }) => {
        const { context } = sharedSession
        const { hits, pattern } = await fakeSite(context)

        const probe = await context.newPage()
        try {
            await probe.goto('http://iwara-fake.example/')
            await expect(probe.locator(GUARD_SELECTOR)).toBeAttached()

            // 模拟恶意页面自解封：MSG 只能由 ISOLATED 的真实点击发出，页面只能派发事件
            await probe.evaluate(() => window.dispatchEvent(new CustomEvent('iwara-assistant:guard:continue', { detail: '1' })))

            const outcome = await probe.evaluate(async () => {
                try {
                    const response = await fetch('/after-continue')
                    return `status:${response.status}`
                } catch (error) {
                    return String(error)
                }
            })
            // JS 层的桩确实被换回去了（错误不再是我们的文案）……
            expect(outcome).not.toContain(BLOCK_MARKER)
            // ……但请求依旧出不去：这是网络层在拦，也是本轮强化的核心
            expect(outcome).not.toContain('status:200')
            expect(hits).not.toContain('/after-continue')
        } finally {
            await probe.close()
            await context.unroute(pattern)
        }
    })

    test('用户明确点「继续访问」后真正放行（解除网络层封锁，刷新不再打扰）', async ({ sharedSession }) => {
        const { context } = sharedSession
        const { hits, pattern } = await fakeSite(context)

        const probe = await context.newPage()
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
        const blockedFor = async (tabId: number): Promise<number[]> => (await worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((rule) => rule.id))).filter((id) => id === tabId)

        try {
            await probe.goto('http://iwara-fake.example/')
            await expect(probe.locator(GUARD_SELECTOR)).toBeAttached()

            // 真实手势：警告层在 closed shadow root 里，选择器点不到，但顺序焦点导航进得去。
            // 第一个可聚焦元素是「离开此站点」，第二个是「我已了解风险，继续访问」。
            await probe.keyboard.press('Tab')
            await probe.keyboard.press('Tab')
            await probe.keyboard.press('Enter')
            await expect(probe.locator(GUARD_SELECTOR)).toHaveCount(0)

            // 网络层规则必须一起撤掉——只撤页面级桩的话，刷新后页面依旧加载不出来，
            // 用户会以为「点了继续还是坏的」
            const tabId = (await worker.evaluate(async () => (await chrome.tabs.query({ url: 'http://iwara-fake.example/*' })).map((item) => item.id ?? -1)))[0]!
            await expect.poll(() => blockedFor(tabId)).toEqual([])

            const outcome = await probe.evaluate(async () => {
                try {
                    const response = await fetch('/after-click')
                    return `status:${response.status}`
                } catch (error) {
                    return String(error)
                }
            })
            expect(outcome).toBe('status:200')

            // 刷新：放行记录要跨文档生效（否则每次刷新都重新封一遍 = 与人对抗）。
            // 轮询而不是立即断言：新文档里 `guard.ts` 要先向后台发 GUARD_SYNC、拿到
            // 「已放行」再派发 continue 事件，这段往返是异步的，紧跟导航断言会抓到窗口期。
            await probe.reload()
            await expect(probe.locator('#fake-title')).toBeAttached()
            await expect(probe.locator(GUARD_SELECTOR)).toHaveCount(0)
            await expect
                .poll(
                    async () =>
                        probe.evaluate(async () => {
                            try {
                                const response = await fetch('/after-reload')
                                return `status:${response.status}`
                            } catch (error) {
                                return String(error)
                            }
                        }),
                    { timeout: 10_000 }
                )
                .toBe('status:200')
            expect(hits).toContain('/after-click')
        } finally {
            await probe.close()
            await context.unroute(pattern)
        }
    })

    test('离开仿冒站后遗留规则被清除（不玧污同一标签页的后续浏览）', async ({ sharedSession }) => {
        const { context } = sharedSession
        const { pattern } = await fakeSite(context)
        await context.route('https://www.iwara.tv/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PAGE }))

        const probe = await context.newPage()
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
        const ruleIds = async (): Promise<number[]> => worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((rule) => rule.id))

        try {
            await probe.goto('http://iwara-fake.example/')
            await expect(probe.locator(GUARD_SELECTOR)).toBeAttached()
            expect(await ruleIds()).not.toEqual([])

            // 同一标签页导航到官方域名：tabs.onUpdated 必须撤掉封锁规则
            await probe.goto('https://www.iwara.tv/')
            await expect(probe.locator(GUARD_SELECTOR)).toHaveCount(0)
            const tab = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.iwara.tv/*' })).map((item) => item.id ?? -1))
            await expect.poll(async () => (await ruleIds()).filter((id) => tab.includes(id))).toEqual([])

            // 规则真的没了才会有这个结果：官方域名上 fetch 照常返回 200
            const outcome = await probe.evaluate(async () => {
                try {
                    const response = await fetch('/pixel.png')
                    return `status:${response.status}`
                } catch (error) {
                    return String(error)
                }
            })
            expect(outcome).toBe('status:200')
        } finally {
            await probe.close()
            await context.unroute(pattern)
            await context.unroute('https://www.iwara.tv/**')
        }
    })

    test('官方域名：不注入警告层', async ({ sharedSession }) => {
        const { context } = sharedSession
        const pattern = 'https://www.iwara.tv/**'
        await context.route(pattern, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PAGE }))

        const probe = await context.newPage()
        try {
            await probe.goto('https://www.iwara.tv/')
            await expect(probe.locator('#fake-title')).toBeAttached()
            await expect(probe.locator(GUARD_SELECTOR)).toHaveCount(0)

            // 官方站点上 fetch 不被我们替换（真实性检查：错误信息里不能出现我们的标记）
            const outcome = await probe.evaluate(async () => {
                try {
                    const response = await fetch('/anything')
                    return `status:${response.status}`
                } catch (error) {
                    return String(error)
                }
            })
            expect(outcome).not.toContain(BLOCK_MARKER)

            // 官方域名上网络层也不该有任何规则
            const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
            const tab = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.iwara.tv/*' })).map((item) => item.id ?? -1))
            const ruleIds = await worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((rule) => rule.id))
            expect(ruleIds.filter((id) => tab.includes(id))).toEqual([])
        } finally {
            await probe.close()
            await context.unroute(pattern)
        }
    })
})

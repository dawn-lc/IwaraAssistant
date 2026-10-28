/**
 * MAIN world fetch 钩子 × 真实 API 响应（e2e）。
 *
 * 为什么必须放 e2e：`content/mainWorld.ts` 的钩子跑在**页面世界**，且只有在
 * `api.iwara.tv` 真的被 `fetch` 时才生效。单测能覆盖 `resolveRequestUrl` /
 * 窗口计算等纯函数，但覆盖不了「协议相对 URL 被真正拦截」「响应体改写后仍能
 * 被页面 `response.json()` 解析」「过滤后的 `limit`/`count` 修正」这类跨世界行为。
 *
 * 数据来自 `npm run fixtures:capture` 录下的真实响应（`fixtures/api/videos.json`，
 * 已脱敏）：不手写 JSON，也不访问站点——只有形状是真的，内容全是占位符。
 */
import { test, expect, openExtensionPage } from '../helpers/fixtures'
import { apiFixture, iwaraListPage, mockIwaraApi, type IwaraVideoPage } from '../helpers/site'

test.describe.configure({ mode: 'serial' })

const PAGE_CONFIG_OFF = { filterLikedVideos: false, filterUnlistedAndPrivate: false, addUnlistedAndPrivate: false }

/** 在扩展页写配置；background 收到 storage 变更后广播 CONFIG_SYNC 到 iwara 标签页 */
async function setPageConfig(page: import('@playwright/test').Page, patch: Record<string, boolean>): Promise<void> {
    await page.evaluate(async (next) => {
        const stored = (await chrome.storage.local.get('config')).config ?? {}
        await chrome.storage.local.set({ config: { ...stored, ...next } })
    }, patch)
}

/** 在页面世界按站点的写法（协议相对 URL）取一次列表 */
async function readVideos(page: import('@playwright/test').Page, path: string): Promise<IwaraVideoPage> {
    return page.evaluate(async (url) => (await (await fetch(url)).json()) as IwaraVideoPage, path)
}

/** 把夹具前 N 条打上标记：真实抓取（未登录）不会出现这些分支 */
function markVideos(page: IwaraVideoPage, patch: Record<string, unknown>, count: number): IwaraVideoPage {
    return { ...page, results: page.results.map((video, index) => (index < count ? { ...video, ...patch } : video)) }
}

const ids = (page: IwaraVideoPage): unknown[] => page.results.map((video) => video['id'])

/**
 * 清掉本用例写进扩展库的夹具视频。
 *
 * 钩子会把 `/videos` 上行入库（这是它的职责，不是副作用 bug），而共享会话的
 * 扩展库是**同一份**——不清掉，后面断言库内条数的用例会看到凭空多出的 6 条。
 */
async function deleteFixtureVideos(page: import('@playwright/test').Page): Promise<void> {
    await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('IwaraAssistant')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        if (!db.objectStoreNames.contains('videos')) {
            db.close()
            return
        }
        const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
            const request = db.transaction('videos', 'readonly').objectStore('videos').getAllKeys()
            request.onsuccess = () => resolve(request.result as IDBValidKey[])
            request.onerror = () => reject(request.error)
        })
        const fixtureKeys = keys.filter((key) => String(key).startsWith('fixtureVideo'))
        if (fixtureKeys.length > 0) {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction('videos', 'readwrite')
                for (const key of fixtureKeys) tx.objectStore('videos').delete(key)
                tx.oncomplete = () => resolve()
                tx.onerror = () => reject(tx.error)
            })
        }
        db.close()
    })
}

test.describe('页内 fetch 钩子', () => {
    test.afterEach(async ({ sharedSession }) => {
        // 配置是共享会话的：留着开关会让后续用例的断言全歪
        await openExtensionPage(sharedSession.page, sharedSession.extensionId, 'options/index.html')
        await setPageConfig(sharedSession.page, PAGE_CONFIG_OFF)
        await deleteFixtureVideos(sharedSession.page)
        // 路由是 context 级的：不摘掉会让后续 spec 的 API 请求也落到这份夹具上
        await sharedSession.context.unroute('**/api.iwara.tv/**')
    })

    test('协议相对 URL 被拦截：真实响应原样透传', async ({ sharedSession }) => {
        const { context } = sharedSession
        await context.route('**/*.iwara.tv/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: iwaraListPage() }))
        const mock = await mockIwaraApi(context)

        const iwara = await context.newPage()
        await iwara.goto('https://www.iwara.tv/videos')
        await expect(iwara.locator('html[data-ia-hook]')).toHaveAttribute('data-ia-hook', /elements=\d+/, { timeout: 15_000 })

        // 站点真实写法。`new URL('//api.iwara.tv/…')` 会抛错：钩子若把它当
        // 「非法 URL 放行」，入库/token/过滤会 **静默全失效**
        const result = await iwara.evaluate(async () => {
            const response = await fetch('//api.iwara.tv/videos?rating=all&sort=date&page=0')
            return { status: response.status, body: (await response.json()) as unknown }
        })

        expect(result.status).toBe(200)
        // 全部开关关闭时钩子只做透传：字段一个都不能丢/改
        const fixture = apiFixture<IwaraVideoPage>('videos')
        expect(result.body).toEqual(fixture)
        // 透传之外还要「上行入库」：`data-ia-ingest` 是 MAIN→ISOLATED→后台 全链路的回执
        await expect(iwara.locator('html')).toHaveAttribute('data-ia-ingest', `ok:${fixture.results.length}:${fixture.results.length}`, { timeout: 10_000 })
        expect(mock.requests).toEqual(['https://api.iwara.tv/videos?rating=all&sort=date&page=0'])
        expect(mock.unmatched).toEqual([])
        await iwara.close()
    })

    test('点赞过滤：结果变少且 limit/count 被修正', async ({ sharedSession }) => {
        const { context, page } = sharedSession
        await context.route('**/*.iwara.tv/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: iwaraListPage() }))
        const mock = await mockIwaraApi(context, { videos: (base) => markVideos(base, { liked: true }, 2) })

        await openExtensionPage(page, sharedSession.extensionId, 'options/index.html')
        await setPageConfig(page, { filterLikedVideos: true })

        const iwara = await context.newPage()
        await iwara.goto('https://www.iwara.tv/videos')
        await expect(iwara.locator('html[data-ia-bridge]')).toHaveAttribute('data-ia-bridge', /ready|no-ack/, { timeout: 15_000 })

        const fixture = apiFixture<IwaraVideoPage>('videos')
        const remaining = fixture.results.slice(2).map((video) => video['id'])
        // CONFIG_SYNC 与首屏是异步的：轮询到开关真的生效，不用固定 sleep 赌时序
        await expect.poll(async () => ids(await readVideos(iwara, '//api.iwara.tv/videos?rating=all&page=0')).length, { timeout: 10_000 }).toBe(remaining.length)

        const body = await readVideos(iwara, '//api.iwara.tv/videos?rating=all&page=0')
        expect(ids(body)).toEqual(remaining)
        // 原实现 pageFixups：limit 跟随结果数，count = limit*(page+1)+1（bug-for-bug，勿「修正」）
        expect(body.limit).toBe(body.results.length)
        expect(body.count).toBe(body.limit * (body.page + 1) + 1)
        expect(mock.unmatched).toEqual([])
        await iwara.close()
    })

    test('订阅流过滤：私有/未列出被剔除，普通列表不受影响', async ({ sharedSession }) => {
        const { context, page } = sharedSession
        await context.route('**/*.iwara.tv/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: iwaraListPage() }))
        await mockIwaraApi(context, {
            videos: (base) => ({
                ...base,
                results: base.results.map((video, index) => (index === 0 ? { ...video, private: true } : index === 1 ? { ...video, unlisted: true } : video))
            })
        })

        await openExtensionPage(page, sharedSession.extensionId, 'options/index.html')
        await setPageConfig(page, { filterUnlistedAndPrivate: true })

        const iwara = await context.newPage()
        await iwara.goto('https://www.iwara.tv/videos')
        await expect(iwara.locator('html[data-ia-bridge]')).toHaveAttribute('data-ia-bridge', /ready|no-ack/, { timeout: 15_000 })

        const fixture = apiFixture<IwaraVideoPage>('videos')
        const visible = fixture.results.slice(2).map((video) => video['id'])
        await expect.poll(async () => ids(await readVideos(iwara, '//api.iwara.tv/videos?subscribed=true&page=0')).length, { timeout: 10_000 }).toBe(visible.length)

        const subscribed = await readVideos(iwara, '//api.iwara.tv/videos?subscribed=true&page=0')
        expect(ids(subscribed)).toEqual(visible)
        expect(subscribed.limit).toBe(subscribed.results.length)

        // 开关只作用于 subscribed 请求：普通列表仍拿到完整结果
        const plain = await readVideos(iwara, '//api.iwara.tv/videos?page=0')
        expect(plain.results).toHaveLength(fixture.results.length)
        await iwara.close()
    })

    test('回填：换页后的首个响应按当前窗口带上库内私有视频', async ({ sharedSession }) => {
        const { context, page } = sharedSession
        await context.route('**/*.iwara.tv/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: iwaraListPage() }))
        await mockIwaraApi(context, {
            videos: (base, url) => {
                // 订阅流里有一条 1 月 4 日的私有视频：它只入库，不该出现在首页原响应里
                if (url.searchParams.has('subscribed')) {
                    return { ...base, results: base.results.map((video, index) => (index === 2 ? { ...video, private: true } : video)) }
                }
                // 第 0 页把后台推送窗口顶到 1 月 10 日（与私有视频的 1 月 2-7 日不重叠）
                if (url.searchParams.get('page') === '0') {
                    return { ...base, page: 0, results: [{ ...base.results[0], id: 'fixtureVideoNew', createdAt: '2024-01-10T12:00:00.000Z' }] }
                }
                return base
            }
        })

        await openExtensionPage(page, sharedSession.extensionId, 'options/index.html')
        await setPageConfig(page, { addUnlistedAndPrivate: true })

        const iwara = await context.newPage()
        await iwara.goto('https://www.iwara.tv/videos')
        await expect(iwara.locator('html[data-ia-bridge]')).toHaveAttribute('data-ia-bridge', /ready|no-ack/, { timeout: 15_000 })

        // 1) 订阅流入库（data-ia-ingest 回执证明后台已写完，后续查询一定看得到）
        const fixture = apiFixture<IwaraVideoPage>('videos')
        await readVideos(iwara, '//api.iwara.tv/videos?subscribed=true&rating=all&page=0')
        await expect(iwara.locator('html')).toHaveAttribute('data-ia-ingest', `ok:${fixture.results.length}:${fixture.results.length}`, { timeout: 10_000 })

        // 2) 第 0 页（1 月 10 日）入库后，最后一次推送的窗口是 1 月 10 日前后
        await readVideos(iwara, '//api.iwara.tv/videos?rating=all&sort=date&page=0')

        // 3) 第 1 页（1 月 2-7 日）的**首个**响应必须按本页窗口重新查库，
        //    不能吃第 0 页推送的旧窗口（旧实现会漏掉那条 1 月 4 日的私有视频）
        const page1 = await readVideos(iwara, '//api.iwara.tv/videos?rating=all&sort=date&page=1')
        expect(page1.results).toHaveLength(fixture.results.length + 1)
        expect(page1.results).toContainEqual(expect.objectContaining({ id: 'fixtureVideo3', private: true }))
        await iwara.close()
    })
})

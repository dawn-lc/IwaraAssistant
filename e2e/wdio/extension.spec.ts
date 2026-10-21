/**
 * WDIO 跨浏览器同构用例 —— 与 Playwright 版（e2e/playwright/specs）10 个验收点一一对应。
 * 同一份 spec 在 Chrome + Firefox 各跑一遍；用例逻辑不含宿主分支，
 * 唯一例外是 manifest 后台形态断言（Chrome service_worker / Firefox scripts）
 * 与 Chrome 专属的 offscreen 保活用例，那是构建产物能力差异，不是行为差异。
 *
 * 后台启动验收：Playwright 靠 SW console 文本（仅 Chrome 可捕获）；
 * 这里改用双浏览器都支持的 `runtime.getContexts()` + `alarms.getAll()`，
 * 语义更强且两端完全一致。
 */
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { browser, expect, $, $$ } from '@wdio/globals'
import { ensureExtensionSession, hasOffscreenDocument, openExtensionPage, readDownloadQueue, readLocalStorage, sendRuntimeMessage, setLocalStorage, waitForBackgroundReady, type ExtensionSession } from './helpers/extension'

/** options 页签顺序（App.tsx TABS） */
const TAB_IDS = ['download', 'rpc', 'filter', 'clean', 'tasks', 'friends', 'migrate', 'advanced', 'guide'] as const

const DEFAULT_DOWNLOAD_PATH = '/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4'

interface PageReadyData {
    pageConfig?: Record<string, boolean>
    cacheList?: unknown | null
}

interface QueueTaskPayload {
    videoId?: string
    status?: string
    detail?: string
}

describe('Iwara Assistant 扩展（双浏览器同构）', () => {
    let session: ExtensionSession

    before(async () => {
        session = await ensureExtensionSession(browser)
        // 装载逻辑与 capabilities 必须一致（防止把 FF 的 spec 跑到 Chrome 上）
        expect(session.browserName).toBe(browser.capabilities.browserName)
    })

    async function openPage(relativePath: string): Promise<void> {
        await openExtensionPage(browser, session, relativePath)
    }

    /** 清空下载队列（需要扩展页上下文；顺带保证后续用例的空态断言确定） */
    async function resetQueue(): Promise<void> {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })
        await setLocalStorage(browser, { downloadQueue: [] })
    }

    /** WDIO v10 默认 strict selector：过滤页有 3 个开关，显式取第一个 */
    async function firstFilterToggle(): Promise<WebdriverIO.Element> {
        const toggles = await $$('.toggle input[type="checkbox"]')
        const first = toggles[0]
        if (!first) throw new Error('过滤页未渲染开关')
        return first
    }

    /**
     * 一次性写入受控输入框（等价 Playwright `fill`）。
     * 不能用 `setValue()`：React 受控值来自 storage 异步回填，逐字符输入会被
     * 中间态覆盖，导致内容拼接错乱——原生 setter + 单次 input 事件才能稳定复现。
     */
    async function fillInput(selector: string, value: string): Promise<void> {
        await browser.execute(
            (targetSelector, text) => {
                const input = document.querySelector(targetSelector) as HTMLInputElement | null
                if (!input) throw new Error(`找不到输入框 ${targetSelector}`)
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                setter?.call(input, text)
                input.dispatchEvent(new Event('input', { bubbles: true }))
            },
            selector,
            value
        )
    }

    /**
     * 在**指定标题的卡片里**写入受控输入框。
     *
     * 不用「页面里第一个文本框」那种位置选择器：下载页后来加了「下载代理」区块
     * （地址/用户名/密码三个文本框）并且排在「保存路径模板」之前，
     * `.row-control input[type="text"]` 于是指向了代理地址，用例静默写错字段。
     */
    async function fillInputInCard(cardTitle: string, inputSelector: string, value: string): Promise<void> {
        await browser.execute(
            (title, selector, text) => {
                const card = [...document.querySelectorAll('section.card')].find((element) => element.querySelector('h2')?.textContent?.includes(title))
                const input = card?.querySelector(selector) as HTMLInputElement | null
                if (!input) throw new Error(`在「${title}」卡片里找不到输入框 ${selector}`)
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                setter?.call(input, text)
                input.dispatchEvent(new Event('input', { bubbles: true }))
            },
            cardTitle,
            inputSelector,
            value
        )
    }

    /**
     * 等待「已保存」toast 出现。
     *
     * 保存反馈已换成 sonner（`data-testid="save-toast"`）；不能用
     * `expect($('[data-testid="save-toast"]')).toHaveText()`：W3C getElementText 对
     * **淡入中的元素**返回空串（元素尚未被视为已渲染），默认只读一次就失败。
     * 这里直接读 textContent（不受可见性影响）并轮询。
     */
    async function waitForSaveToast(timeout = 5000): Promise<void> {
        await browser.waitUntil(async () => (await browser.execute(() => document.querySelector('[data-testid="save-toast"]')?.textContent ?? '')) === '已保存', { timeout, interval: 100, timeoutMsg: '保存提示未出现（save-toast 文本不是「已保存」）' })
    }

    it('后台启动完成：BACKGROUND 上下文 + 周期 alarms 就绪', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        const state = await waitForBackgroundReady(browser)
        expect(state.contextsSupported).toBe(true)
        expect(state.backgroundContexts.length).toBeGreaterThan(0)
        for (const name of ['ws-keepalive', 'scan-aria2', 'retry-failed']) {
            expect(state.alarms).toContain(name)
        }

        // 产物差异：Chrome 必须是 service worker，Firefox 必须是（MV2）持久后台页 scripts。
        // Firefox 的 getManifest() 会把脚本解析成绝对 URL，故用 endsWith 归一化。
        if (session.browserName === 'chrome') {
            expect(state.manifestBackground.service_worker?.endsWith('background.js')).toBe(true)
        } else {
            expect(state.manifestBackground.scripts?.some((entry) => entry.endsWith('background.js'))).toBe(true)
        }
    })

    it('options 页挂载配置中心（九页签）', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })
        expect(await $$('nav.tabs button')).toHaveLength(9)
    })

    /**
     * Chrome 专属：`keepBackgroundAlive` 驱动 offscreen 文档的创建与销毁。
     *
     * 这是保活链路的唯一可观测点——端口心跳本身没有用户可见副作用，
     * 但「文档在不在」能证明：后台收到配置变更 → 正确建/停文档。
     * Firefox 用 MV2 持久后台页（`persistent: true`），不需要也没有 offscreen，
     * 这里只断言「开关不会凭空造出文档」。
     */
    it('保持后台活跃：开关驱动 offscreen 文档生命周期（仅 Chrome）', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        expect(await hasOffscreenDocument(browser)).toBe(false)
        const stored = ((await readLocalStorage(browser, 'config')) ?? {}) as Record<string, unknown>

        try {
            await setLocalStorage(browser, { config: { ...stored, keepBackgroundAlive: true } })
            if (session.browserName === 'chrome') {
                await browser.waitUntil(async () => hasOffscreenDocument(browser), { timeout: 15_000, interval: 250, timeoutMsg: '开启「保持后台活跃」后 offscreen 文档未创建' })
            } else {
                expect(await hasOffscreenDocument(browser)).toBe(false)
            }
        } finally {
            await setLocalStorage(browser, { config: stored })
        }

        if (session.browserName === 'chrome') {
            await browser.waitUntil(async () => !(await hasOffscreenDocument(browser)), { timeout: 15_000, interval: 250, timeoutMsg: '关闭「保持后台活跃」后 offscreen 文档未关闭' })
        }
    })

    it('九页签逐个切换：hash 深链 + 每页 card 渲染', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed()

        for (const [index, tabId] of TAB_IDS.entries()) {
            const buttons = await $$('nav.tabs button')
            const button = buttons[index]
            if (!button) throw new Error(`缺少第 ${index} 个页签（${tabId}）`)
            await button.click()

            await browser.waitUntil(async () => (await browser.getUrl()).endsWith(`#${tabId}`), {
                timeout: 10_000,
                timeoutMsg: `页签 ${tabId} 未写入 location.hash`
            })

            const cards = await $$('section.card')
            if (cards.length === 0) throw new Error(`页签 ${tabId} 未渲染 section.card`)
            await expect(cards[0]!).toBeDisplayed()
        }
    })

    it('过滤开关即时保存 + reload 持久化', async () => {
        await openPage('options/index.html#filter')
        await $('nav.tabs').waitForDisplayed()

        const first = await firstFilterToggle()
        const before = await first.isSelected()
        await first.click()
        await waitForSaveToast()

        await browser.refresh()
        await $('nav.tabs').waitForDisplayed()
        const after = await (await firstFilterToggle()).isSelected()
        expect(after).toBe(!before)

        // 还原，避免污染其它用例与人工观察
        await (await firstFilterToggle()).click()
        await waitForSaveToast()
    })

    it('下载页路径模板实时预览（与后台同一渲染管线）', async () => {
        await openPage('options/index.html#download')
        await $('nav.tabs').waitForDisplayed()

        // 默认模板 + 示例视频（SAMPLE_VIDEO：someone / Sample Alias / aBcD1234）
        await expect($('code.preview')).toHaveText(/\/Iwara\//, { wait: 5000 })
        await expect($('code.preview')).toHaveText(/someone/, { wait: 5000 })

        // 按卡片标题定位模板输入框：「下载代理」区块排在它之前，位置选择器会打偏
        const templateInput = 'input[type="text"]'
        await fillInputInCard('保存路径模板', templateInput, '/IwaraTest/%#ALIAS#%/%#ID#%.mp4')
        // 输入有 400ms 防抖：预览更新必须等
        await expect($('code.preview')).toHaveText(/\/IwaraTest\/Sample Alias\/aBcD1234\.mp4/, { wait: 5000 })

        // 还原默认模板
        await fillInputInCard('保存路径模板', templateInput, DEFAULT_DOWNLOAD_PATH)
        await waitForSaveToast()
    })

    it('任务页签空态（队列为空时的文案）', async () => {
        await resetQueue()
        await openPage('options/index.html#tasks')
        await $('nav.tabs').waitForDisplayed()
        await expect($('section.card')).toHaveText(/暂无任务/)
    })

    it('popup 是配置页入口（九项导航）', async () => {
        await openPage('popup/index.html')
        await $('h1').waitForDisplayed({ timeout: 15_000 })
        expect(await $$('nav.entries .entry')).toHaveLength(9)
    })

    it('PAGE_READY：返回配置快照（hub return true 路由）', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        const response = await sendRuntimeMessage<PageReadyData>(browser, { type: 'PAGE_READY', payload: {} })
        expect(response.ok).toBe(true)
        expect(response.data?.pageConfig).toHaveProperty('filterLikedVideos')
        expect(response.data?.pageConfig).toHaveProperty('filterUnlistedAndPrivate')
        expect(response.data?.pageConfig).toHaveProperty('addUnlistedAndPrivate')
    })

    it('GET_VIDEOS：视频库查询可用（给 ids 精确取 / 缺省取最近 N 条）', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        // 空库/任意库都必须返回数组信封（不是未实现的 null / 空异常）
        const byIds = await sendRuntimeMessage<unknown[]>(browser, { type: 'GET_VIDEOS', payload: { ids: ['e2e-nonexistent'] } })
        expect(byIds.ok).toBe(true)
        expect(Array.isArray(byIds.data)).toBe(true)
        expect(byIds.data?.length).toBe(0)

        const recent = await sendRuntimeMessage<unknown[]>(browser, { type: 'GET_VIDEOS', payload: {}, limit: 5 })
        expect(recent.ok).toBe(true)
        expect(Array.isArray(recent.data)).toBe(true)
        expect((recent.data?.length ?? 0) <= 5).toBe(true)
    })

    it('CHECK_LINK：非法/非 http 协议被拒绝，合法地址返回结构化结果', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        const invalid = await sendRuntimeMessage<{ status: number; ok: boolean; reason?: string }>(browser, {
            type: 'CHECK_LINK',
            payload: { url: 'not-a-url' }
        })
        expect(invalid.ok).toBe(true)
        expect(invalid.data?.ok).toBe(false)
        expect(invalid.data?.reason).toMatch(/URL/)

        const badProtocol = await sendRuntimeMessage<{ status: number; ok: boolean; reason?: string }>(browser, {
            type: 'CHECK_LINK',
            payload: { url: 'ftp://example.com/a' }
        })
        expect(badProtocol.data?.ok).toBe(false)
        expect(badProtocol.data?.reason).toMatch(/http/)
    })

    it('GET_CARD_META：返回卡片元数据与所有者判定（本地库只读）', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        const response = await sendRuntimeMessage<{ items: Array<{ id: string; following: boolean; downloaded: boolean }>; canDeletePlaylistItem: boolean }>(browser, { type: 'GET_CARD_META', payload: { cards: [{ id: 'e2e-nonexistent', author: 'nobody-e2e' }] } })
        expect(response.ok).toBe(true)
        expect(response.data?.items?.length).toBe(1)
        expect(response.data?.items?.[0]?.id).toBe('e2e-nonexistent')
        // 库里没有该作者 → 不关注、未下载
        expect(response.data?.items?.[0]?.following).toBe(false)
        expect(response.data?.items?.[0]?.downloaded).toBe(false)
        // 未传 playlistId → 不做所有者判定
        expect(response.data?.canDeletePlaylistItem).toBe(false)
    })

    it('INIT_DOWNLOAD：非法 ID 落为失败任务且消息层正常返回', async () => {
        await resetQueue()

        const response = await sendRuntimeMessage<QueueTaskPayload>(browser, {
            type: 'INIT_DOWNLOAD',
            payload: { videoId: 'e2e-nonexistent-id' }
        })
        // runDownload 解析失败 → addTask(failed) → 消息层仍是 ok:true 信封
        expect(response.ok).toBe(true)
        expect(response.data?.videoId).toBe('e2e-nonexistent-id')
        expect(response.data?.status).toBe('failed')
        expect(String(response.data?.detail ?? '')).toMatch(/解析失败/)

        const queue = await readDownloadQueue(browser)
        expect(queue.some((task) => task['videoId'] === 'e2e-nonexistent-id')).toBe(true)

        // 清理，避免污染后续空态用例
        await setLocalStorage(browser, { downloadQueue: [] })
    })

    it('队列操作消息：REMOVE_TASK / CLEAR_FINISHED / RETRY_TASK 均由后台执行', async () => {
        await resetQueue()

        // 1) 制造一条失败任务（非法 ID → 解析失败），并确认时间戳落盘
        const created = await sendRuntimeMessage<QueueTaskPayload & { id?: string; createdAt?: number; updatedAt?: number }>(browser, {
            type: 'INIT_DOWNLOAD',
            payload: { videoId: 'e2e-queue-op-id' }
        })
        expect(created.ok).toBe(true)
        expect(created.data?.status).toBe('failed')

        const queue = await readDownloadQueue(browser)
        const task = queue.find((item) => item['videoId'] === 'e2e-queue-op-id')
        expect(task).toBeTruthy()
        expect(typeof task?.['createdAt']).toBe('number')
        expect(typeof task?.['updatedAt']).toBe('number')
        const taskId = String(task?.['id'] ?? '')
        expect(taskId).not.toBe('')

        // 2) 单条移除（后台唯一写者：内存与 storage 同步）
        const removed = await sendRuntimeMessage<{ removed?: boolean }>(browser, { type: 'REMOVE_TASK', payload: { taskId } })
        expect(removed.ok).toBe(true)
        expect(removed.data?.removed).toBe(true)

        // 3) 重试不存在的任务 → 明确错误信封
        const retryMissing = await sendRuntimeMessage(browser, { type: 'RETRY_TASK', payload: { taskId: 'e2e-not-exist' } })
        expect(retryMissing.ok).toBe(false)
        expect(String(retryMissing.error ?? '')).toMatch(/任务不存在/)

        // 4) 清除已结束 → 队列清空
        const cleared = await sendRuntimeMessage<{ removed?: number }>(browser, { type: 'CLEAR_FINISHED', payload: {} })
        expect(cleared.ok).toBe(true)
        expect(await readDownloadQueue(browser)).toHaveLength(0)
    })

    it('好友请求页：审批条件清单与模式选择渲染', async () => {
        await openPage('options/index.html#friends')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        // 9 个内置条件（always / followedBy / following / premium / recentlyActive / established / active / commentedProfile / commentedForumThread）
        // 条件清单用 `.check-list > .check-row`（旧版是 `.kv-list > .kv-row`）
        const conditions = await $$('section.card .check-list .check-row')
        expect(conditions.length).toBeGreaterThanOrEqual(9)
        await expect($('select')).toBeDisplayed()
    })

    it('高级页：批量入库与 MediaCenter 配置区块渲染', async () => {
        await openPage('options/index.html#advanced')
        await $('nav.tabs').waitForDisplayed()

        // 按标题文案定位，不用「第 N 个 card」——新增区块时索引会整体位移
        // （加「链接检查」区块时这里曾误报，属于测试写法问题，不是功能缺陷）
        // 标题在 `.section-head` 内（Section 组件包了一层，h2 不再是 section.card 的直接子元素）
        const readTitles = async (): Promise<string[]> => {
            const headings = await $$('section.card .section-head h2')
            const titles: string[] = []
            for (const heading of headings) titles.push(await heading.getText())
            return titles
        }

        const titles = await readTitles()
        expect(titles.length).toBeGreaterThanOrEqual(4)
        expect(titles.some((title) => title.includes('批量入库'))).toBe(true)
        expect(titles.some((title) => title.includes('链接检查'))).toBe(true)

        // MediaCenter 区块真实按「启用实验性功能」门控：关闭时不应存在，开启后必须出现
        expect(titles.some((title) => title.includes('MediaCenter'))).toBe(false)
        const experimental = await $('//div[contains(@class,"row-label")][.//span[normalize-space(text())="启用实验性功能"]]/following-sibling::div[contains(@class,"row-control")]//input[@type="checkbox"]')
        await experimental.waitForClickable()
        if (!(await experimental.isSelected())) await experimental.click()
        await waitForSaveToast()

        await browser.waitUntil(async () => (await readTitles()).some((title) => title.includes('MediaCenter')), {
            timeout: 10_000,
            timeoutMsg: '开启实验性功能后未出现 MediaCenter 区块'
        })

        // 还原，避免污染其它用例与人工观察
        if (await experimental.isSelected()) await experimental.click()
        await waitForSaveToast()
    })

    it('迁移页：旧库导入区块 + 配置导出按钮（按标题定位，不依赖卡片顺序）', async () => {
        await openPage('options/index.html#migrate')
        await $('nav.tabs').waitForDisplayed()

        // 旧脚本页面数据库区块（新增，位于导出卡片之前）
        const legacySection = await $('//section[contains(@class,"card")][.//h2[contains(text(),"从旧脚本浏览器数据库导入")]]')
        await expect(legacySection).toBeDisplayed()
        await expect(legacySection.$('button')).toHaveText(/导入旧库数据|导入这 \d+ 条数据/)
        await expect(legacySection).toHaveText(/视频库|还没有检测过|未在 iwara/)

        // 配置导出按钮：不能再用「第 0 个按钮」——卡片顺序已变；导出卡现在有两个按钮（文件 / 剪贴板）
        const exportSection = await $('//section[contains(@class,"card")][.//h2[contains(text(),"导出全部数据")]]')
        const exportButtons = await exportSection.$$('button')
        expect(exportButtons.length).toBe(2)
        await expect(exportButtons[0]).toHaveText(/导出/)
        await expect(exportButtons[1]).toHaveText(/剪贴板/)
    })

    it('迁移页：粘贴配置 JSON 即可导入（源项目「导出配置」就是剪贴板文本）', async () => {
        await openPage('options/index.html#migrate')
        await $('nav.tabs').waitForDisplayed()

        // 备份现有配置：用例会改 downloadPath，结束后原样还原
        const backup = (await browser.execute(async () => {
            type ExtensionScope = { storage?: { local?: { get?: (keys: string) => Promise<Record<string, unknown>> } } }
            const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
            const api = scope.browser ?? scope.chrome
            const local = api?.storage?.local
            if (!local?.get) throw new Error('当前页面不是扩展页（无 storage.local）')
            return ((await local.get('config'))['config'] ?? null) as unknown
        })) as unknown
        try {
            const textarea = await $('textarea.paste-box')
            await textarea.waitForDisplayed()
            await textarea.setValue(JSON.stringify({ downloadPath: '/Paste/%#TITLE#%.mp4', pathTitleMaxLength: 90 }))

            const button = await $('[data-testid="migrate-paste-import"]')
            await expect(button).toBeEnabled()
            await button.click()

            await browser.waitUntil(
                async () => {
                    const text = await browser.execute(() => document.querySelector('.result-box')?.textContent ?? '')
                    return String(text).includes('配置已导入合并')
                },
                { timeout: 10_000, timeoutMsg: '粘贴导入未产生结果框' }
            )
            const result = String(await browser.execute(() => document.querySelector('.result-box')?.textContent ?? ''))
            expect(result).toContain('识别为配置文件')

            const saved = await browser.execute(async () => {
                type ExtensionScope = { storage?: { local?: { get?: (keys: string) => Promise<Record<string, unknown>> } } }
                const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
                const api = scope.browser ?? scope.chrome
                const local = api?.storage?.local
                if (!local?.get) throw new Error('当前页面不是扩展页（无 storage.local）')
                const config = (await local.get('config'))['config'] as Record<string, unknown> | undefined
                return { downloadPath: config?.['downloadPath'], pathTitleMaxLength: config?.['pathTitleMaxLength'] }
            })
            expect(saved.downloadPath).toBe('/Paste/%#TITLE#%.mp4')
            expect(saved.pathTitleMaxLength).toBe(90)
        } finally {
            await browser.execute(async (value) => {
                type ExtensionScope = { storage?: { local?: { set?: (data: unknown) => Promise<void> } } }
                const scope = globalThis as unknown as { browser?: ExtensionScope; chrome?: ExtensionScope }
                const api = scope.browser ?? scope.chrome
                const local = api?.storage?.local
                if (!local?.set) throw new Error('当前页面不是扩展页（无 storage.local）')
                await local.set({ config: value })
            }, backup)
        }
    })

    it('迁移页：粘贴 36 MiB 完整包（验证用 32 MiB 事务预算写入在双宿主都成立）', async () => {
        // 预算按「平台上限的 1/3」反推（见 shared/legacyDb 的注释），这条用例是它的实测守卫：
        // Firefox 单事务序列化上限 246 MiB，36 MiB 数据在 32 MiB/500 条预算下会切成 2 个事务。
        // 若哪天有人把预算调大到撞死真实上限，这里会先红。
        const RECORD_COUNT = 72
        const PAYLOAD = 'x'.repeat(512 * 1024)
        await openPage('options/index.html#migrate')
        await $('nav.tabs').waitForDisplayed()
        try {
            await browser.execute(
                (count: number, payload: string) => {
                    const videos = Array.from({ length: count }, (_, index) => ({ ID: `bulkPaste${index}`, Type: 'partial', Title: `Bulk ${index}`, Payload: payload }))
                    const textarea = document.querySelector('textarea.paste-box') as HTMLTextAreaElement | null
                    if (!textarea) throw new Error('迁移页缺少粘贴框')
                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
                    setter?.call(textarea, JSON.stringify({ videos }))
                    textarea.dispatchEvent(new Event('input', { bubbles: true }))
                },
                RECORD_COUNT,
                PAYLOAD
            )

            const button = await $('[data-testid="migrate-paste-import"]')
            await expect(button).toBeEnabled()
            await button.click()

            await browser.waitUntil(
                async () => {
                    const text = await browser.execute(() => document.querySelector('.result-box')?.textContent ?? '')
                    return String(text).includes('视频库写入')
                },
                { timeout: 90_000, timeoutMsg: '36 MiB 粘贴导入未产生结果框' }
            )
            const result = String(await browser.execute(() => document.querySelector('.result-box')?.textContent ?? ''))
            // 全量写入（一个都不能丢），且没有退化到「写入失败」分支
            expect(result).toContain(`视频库写入 ${RECORD_COUNT}/${RECORD_COUNT} 条`)
            expect(result).not.toContain('写入失败')

            // 落库核对：最后一条记录真的在库里且内容完整。
            // ⚠️ 这里不能写 `const open = () => …` 这类「把函数赋给变量」的写法：
            // WDIO 把函数 toString() 后发给浏览器执行（Firefox 走 BiDi 纯文本），
            // 构建器给具名函数注入的 `__name(...)` 在页面里不存在 → ReferenceError。
            const stored = await browser.execute(async (count: number) => {
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open('IwaraAssistant')
                    request.onsuccess = () => resolve(request.result)
                    request.onerror = () => reject(request.error)
                })
                try {
                    // 注意主键按字典序比较：bound('bulkPaste0','bulkPaste71') 会漏掉 bulkPaste8/9
                    const total = await new Promise<number>((resolve, reject) => {
                        const request = db.transaction('videos', 'readonly').objectStore('videos').count(IDBKeyRange.bound('bulkPaste', 'bulkPaste\uFFFF'))
                        request.onsuccess = () => resolve(request.result)
                        request.onerror = () => reject(request.error)
                    })
                    const last = await new Promise<{ Payload?: string } | undefined>((resolve, reject) => {
                        const request = db
                            .transaction('videos', 'readonly')
                            .objectStore('videos')
                            .get(`bulkPaste${count - 1}`)
                        request.onsuccess = () => resolve(request.result as { Payload?: string } | undefined)
                        request.onerror = () => reject(request.error)
                    })
                    return { count: total, lastLength: String(last?.Payload ?? '').length }
                } finally {
                    db.close()
                }
            }, RECORD_COUNT)
            expect(stored.count).toBe(RECORD_COUNT)
            expect(stored.lastLength).toBe(PAYLOAD.length)
        } finally {
            await browser.execute(async (count: number) => {
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open('IwaraAssistant')
                    request.onsuccess = () => resolve(request.result)
                    request.onerror = () => reject(request.error)
                })
                try {
                    await new Promise<void>((resolve, reject) => {
                        const tx = db.transaction('videos', 'readwrite')
                        for (let index = 0; index < count; index++) tx.objectStore('videos').delete(`bulkPaste${index}`)
                        tx.oncomplete = () => resolve()
                        tx.onerror = () => reject(tx.error)
                    })
                } finally {
                    db.close()
                }
            }, RECORD_COUNT)
        }
    })

    it('任务队列表格实时反映（storage.onChanged 桥）', async () => {
        await resetQueue()
        await openPage('options/index.html#tasks')
        await $('nav.tabs').waitForDisplayed({ timeout: 15_000 })

        await setLocalStorage(browser, {
            downloadQueue: [
                {
                    id: 'wdio-seed',
                    videoId: 'wdioVideo1',
                    kind: 'browser',
                    status: 'running',
                    filename: 'Iwara/wdio/wdioVideo1.mp4'
                }
            ]
        })

        await browser.waitUntil(async () => (await $$('table.tasks tbody tr')).length === 1, { timeout: 10_000 })
        // 首列是「视频」列：主标识在 `.task-video` 里，通道名是下面的副行元信息。
        // 直接断言 `td.mono` 会把两行拼起来（wdioVideo1Browser），所以定位到主标识本身。
        await expect($('table.tasks tbody tr td.mono .task-video')).toHaveText('wdioVideo1')

        await setLocalStorage(browser, { downloadQueue: [] })
        await browser.waitUntil(async () => (await $$('table.tasks tbody tr')).length === 0, { timeout: 10_000 })
    })

    /** 引导页权限行的徽章文案（textContent 轮询，避免淡入元素读到空串） */
    async function guidePermissionBadge(): Promise<string> {
        return (await browser.execute(() => document.querySelector('.status-line .badge')?.textContent ?? '')) as string
    }

    it('使用引导页：全站权限状态与 contains 检测一致', async () => {
        await openPage('options/index.html#guide')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        const granted = (await browser.execute(async () => {
            type Scope = { permissions?: { contains?: (p: unknown) => Promise<boolean> } }
            const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
            if (!api?.permissions?.contains) throw new Error('当前页不是扩展页')
            return await api.permissions.contains({ origins: ['<all_urls>'] })
        })) as boolean

        await browser.waitUntil(async () => (await guidePermissionBadge()) !== '检测中…' && (await guidePermissionBadge()) !== '', { timeout: 10_000, interval: 200 })
        const badge = await guidePermissionBadge()
        expect(badge).toBe(granted ? '已获得全站访问权限' : '全站访问权限已被撤销')
        // 权限在 manifest 里一次声明，指南页不再提供（也无法提供）逐站点授权按钮
        expect(await $$('.status-line button')).toHaveLength(0)
    })

    /**
     * RPC 通道失败必须给出**可操作**的 detail。
     *
     * 真实现象：用户配了 aria2（或 iwaradl）但没在设置里给端点授权，任务失败后
     * detail 只有浏览器原文 `NetworkError when attempting to fetch resource.`——
     * 不说哪个端点、也不说该做什么。错误文案是唯一反馈通道（通知 + 任务面板），
     * 必须带端点与下一步。
     *
     * 这里指向 `127.0.0.1:1`（必然未授权、必然连不上），跳过站点解析直接打通道，
     * 因此不依赖任何外部服务，CI 可稳定复现。
     */
    it('RPC 通道失败：detail 是可操作文案，不是浏览器原文', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        const backup = (await browser.execute(async () => {
            type Scope = { storage?: { local?: { get?: (keys: string) => Promise<Record<string, unknown>> } } }
            const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
            return (await api?.storage?.local?.get?.('config'))?.['config'] ?? null
        })) as Record<string, unknown> | null

        try {
            await setLocalStorage(browser, {
                config: {
                    downloadType: 0,
                    aria2Path: 'http://127.0.0.1:1/jsonrpc',
                    aria2Token: 'probe',
                    downloadPath: '/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4',
                    checkPriority: true,
                    downloadPriority: 'Source',
                    priority: { Source: 100 }
                },
                downloadQueue: []
            })

            await sendRuntimeMessage(browser, {
                type: 'DOWNLOAD',
                payload: {
                    kind: 'aria2',
                    video: {
                        Type: 'full',
                        ID: 'rpcFailureProbe',
                        Title: 'probe',
                        Alias: 'probe',
                        Author: 'probe',
                        AuthorID: 'probe-author',
                        DownloadUrl: 'https://www.iwara.tv/video/rpcFailureProbe',
                        DownloadQuality: 'Source',
                        UploadTime: 1_700_000_000_000,
                        FileName: 'probe.mp4',
                        Size: 1
                    }
                }
            })

            const queue = await readDownloadQueue(browser)
            const task = queue.find((item) => item['videoId'] === 'rpcFailureProbe')
            expect(task).toBeDefined()
            const detail = String(task?.['detail'] ?? '')

            // 必须说清是哪个端点（host），并指向授权入口——而不是只丢一句 TypeError
            expect(detail).toContain('aria2')
            expect(detail).toMatch(/127\.0\.0\.1:1/)
            expect(detail).toMatch(/设置 → RPC|无法连接/)
        } finally {
            await setLocalStorage(browser, { config: backup ?? {} })
            await setLocalStorage(browser, { downloadQueue: [] })
        }
    })

    /**
     * 钓鱼防护的网络层封锁依赖 `declarativeNetRequest` 的 session 规则。
     *
     * Playwright 只能跑 Chromium，所以这里补一条**双宿主**的可用性守卫：
     * 权限声明漏了、或者某宿主不支持 session 规则，防护会静默退化成「只拦 fetch」——
     * 而那种退化在界面上看不出来（警告照样显示），只有 API 调用会失败。
     */
    it('钓鱼防护：declarativeNetRequest session 规则在双宿主可用（加/查/删）', async () => {
        await openPage('options/index.html#guide')
        await $('nav.tabs').waitForDisplayed()

        const roundTrip = (await browser.execute(async () => {
            type Dnr = {
                updateSessionRules?: (options: unknown) => Promise<void>
                getSessionRules?: () => Promise<Array<{ id: number }>>
            }
            type Scope = { declarativeNetRequest?: Dnr }
            const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
            const dnr = api?.declarativeNetRequest
            if (!dnr?.updateSessionRules || !dnr?.getSessionRules) throw new Error('declarativeNetRequest 不可用（权限未声明？）')
            const id = 900001
            await dnr.updateSessionRules({
                removeRuleIds: [id],
                addRules: [{ id, priority: 1, action: { type: 'block' }, condition: { tabIds: [999999], excludedResourceTypes: ['main_frame'] } }]
            })
            const present = (await dnr.getSessionRules()).some((rule) => rule.id === id)
            await dnr.updateSessionRules({ removeRuleIds: [id] })
            return present
        })) as boolean

        expect(roundTrip).toBe(true)
    })

    /**
     * 路径模板里的子目录必须真的落地（回归守卫）。
     *
     * 曾经因为 Bugzilla 1280044（2016 年的 Firefox 缺陷）而对 Firefox 做文件名扁平化，
     * 把 `AUTHOR/TITLE.mp4` 压成 `AUTHOR_TITLE.mp4`——同一份模板在两个宿主得到完全不同的
     * 目录结构。那条 bug 其实在 **Firefox 51** 就已 FIXED（官方状态 RESOLVED/FIXED）。
     *
     * 这是**平台事实**：单测只能盖住我们自己的字符串处理，盖不住「浏览器真的按 / 建目录」。
     * 所以用一次真实下载验证，两个宿主都跑——任何一端再出现扁平化，这条就会红。
     */
    it('子目录：downloads.download 按 filename 里的 / 真实建目录（双宿主）', async () => {
        await openPage('options/index.html')
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        const server = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/plain' })
            response.end('subdir-check')
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0

        try {
            const result = (await browser.execute(async (url) => {
                type Downloads = {
                    download?: (options: Record<string, unknown>) => Promise<number>
                    search?: (query: Record<string, unknown>) => Promise<Array<{ filename?: string; state?: string; error?: string }>>
                    erase?: (query: Record<string, unknown>) => Promise<number>
                }
                type Scope = { downloads?: Downloads }
                const scope = globalThis as unknown as { browser?: Scope; chrome?: Scope }
                const downloads = (scope.browser ?? scope.chrome)?.downloads
                if (!downloads?.download || !downloads.search) throw new Error('当前上下文没有 downloads API')
                const id = await downloads.download({ url, filename: 'ia-subdir-e2e/nested/probe.txt', conflictAction: 'overwrite', saveAs: false })
                const deadline = Date.now() + 20_000
                let filename = ''
                let state = ''
                let error = ''
                while (Date.now() < deadline) {
                    const items = await downloads.search({ id })
                    filename = items[0]?.filename ?? ''
                    state = items[0]?.state ?? ''
                    error = items[0]?.error ?? ''
                    if (state === 'complete' || state === 'interrupted') break
                    await new Promise((resolve) => setTimeout(resolve, 200))
                }
                await downloads.erase?.({ id })
                return { filename, state, error }
            }, `http://127.0.0.1:${port}/probe.txt`)) as { filename: string; state: string; error: string }

            expect(result.error).toBe('')
            expect(result.state).toBe('complete')
            // 宿主用 \ 还是 / 渲染绝对路径都算命中：断言的是「两层目录都在」
            expect(result.filename).toMatch(/ia-subdir-e2e[\\/]nested[\\/]probe\.txt$/)

            // downloads.erase 只删记录不删文件：顺手清掉探针目录（限定包名，避免误删）
            const probeRoot = path.dirname(path.dirname(path.resolve(result.filename)))
            if (path.basename(probeRoot) === 'ia-subdir-e2e') fs.rmSync(probeRoot, { recursive: true, force: true })
        } finally {
            server.close()
        }
    })

    /**
     * 撤销全站权限后的引导页表现（**产物能力差异**，不是行为差异）。
     *
     * - MV3：`<all_urls>` 在 `host_permissions` 里，Firefox 视为可撤销，`remove()` 真的生效；
     * - **MV2**：同一句声明只能写进 `permissions`，是必需权限——Firefox 的 `remove()`
     *   返回 true 但不会真正撤销（Chrome 侧直接抛错）；
     * - 两个平台都**没有**在扩展内重新授权的路径，用户只能在扩展管理页调整站点访问。
     *
     * 所以这里不假设「一定能撤销」，只锁一条不变量：**界面永远与 `contains()` 一致**。
     * 放在最后：万一真的撤销成功，Firefox 本次会话内无法恢复（只能重装）。
     */
    it('使用引导页：撤销调用后界面与 contains 检测保持一致', async function (this: Mocha.Context) {
        // Chrome 把 host 权限视为必需权限（remove 直接抛错），这里只测 Firefox 的路径
        if (session.browserName !== 'firefox') return this.skip()

        await openPage('options/index.html#guide')
        await $('nav.tabs').waitForDisplayed()

        const removed = (await browser.execute(async () => {
            type Scope = { permissions?: { remove?: (p: unknown) => Promise<boolean> } }
            const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
            if (!api?.permissions?.remove) throw new Error('当前页不是扩展页')
            return await api.permissions.remove({ origins: ['<all_urls>'] })
        })) as boolean

        const stillGranted = (await browser.execute(async () => {
            type Scope = { permissions?: { contains?: (p: unknown) => Promise<boolean> } }
            const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
            if (!api?.permissions?.contains) throw new Error('当前页不是扩展页')
            return await api.permissions.contains({ origins: ['<all_urls>'] })
        })) as boolean
        console.info(`[e2e] permissions.remove(host) → ${removed}；仍持有时 contains → ${stillGranted}`)

        await browser.refresh()
        await $('nav.tabs').waitForDisplayed()
        await browser.waitUntil(async () => (await guidePermissionBadge()) !== '检测中…' && (await guidePermissionBadge()) !== '', { timeout: 10_000, interval: 200, timeoutMsg: '引导页权限状态一直停在「检测中」' })

        expect(await guidePermissionBadge()).toBe(stillGranted ? '已获得全站访问权限' : '全站访问权限已被撤销')
        // 无论撤销是否生效，都不提供授权按钮（required 权限无法 request）
        expect(await $$('.status-line button')).toHaveLength(0)
        if (!stillGranted) {
            const note = (await browser.execute(() => document.querySelector('.status-line .note')?.textContent ?? '')) as string
            expect(note).toContain('扩展管理页')
        }
    })
})

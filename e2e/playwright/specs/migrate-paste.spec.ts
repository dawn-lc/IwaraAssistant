/**
 * 迁移页「粘贴导入」e2e。
 *
 * 为什么必须有这条用例：旧油猴脚本的「导出配置」不是导出文件，而是
 * `GM_setClipboard(stringify(config))`（源项目 `ui/setup.ts` + `ui/configUi.ts`）——
 * 用户手里只有**剪贴板里的裸配置对象**，没有文件。
 *
 * 三个不能退让的点：
 * 1. 裸配置对象必须被识别成配置（而不是完整迁移包，否则配置被当未知字段丢掉）；
 * 2. 完整迁移包不能被当成配置（否则四张表被 zod 剥掉，用户以为导入了其实没有）；
 * 3. 无关 JSON 必须报错，绝不能落成「用默认值覆盖现有配置」。
 */
import type { Page } from '@playwright/test'
import { test, expect, openExtensionPage } from '../helpers/fixtures'

test.describe.configure({ mode: 'serial' })

const PASTE = '[data-testid="migrate-paste"]'
const RUN = '[data-testid="migrate-paste-import"]'

async function readConfig(page: Page): Promise<Record<string, unknown>> {
    return page.evaluate(async () => ((await chrome.storage.local.get('config')).config ?? {}) as Record<string, unknown>)
}

async function writeConfig(page: Page, config: Record<string, unknown>): Promise<void> {
    await page.evaluate(async (value) => {
        await chrome.storage.local.set({ config: value })
    }, config)
}

/** 直接读扩展 origin 的 IndexedDB（与后台/options 同源） */
async function readDb(page: Page): Promise<{ videos: Array<{ ID: string }>; follows: Array<{ id: string }>; idmap: Array<{ ID: string }> }> {
    return page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('IwaraAssistant')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const read = (store: string): Promise<unknown[]> =>
            new Promise((resolve, reject) => {
                const request = db.transaction(store, 'readonly').objectStore(store).getAll()
                request.onsuccess = () => resolve(request.result as unknown[])
                request.onerror = () => reject(request.error)
            })
        const result = { videos: await read('videos'), follows: await read('follows'), idmap: await read('idmap') }
        db.close()
        return result as { videos: Array<{ ID: string }>; follows: Array<{ id: string }>; idmap: Array<{ ID: string }> }
    })
}

/** 清理用例写入的记录（共享扩展会话，别污染其它 spec 的精确计数断言） */
async function deleteDbRecords(page: Page, targets: Record<string, string[]>): Promise<void> {
    await page.evaluate(async (plan) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('IwaraAssistant')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise<void>((resolve, reject) => {
            const stores = Object.keys(plan)
            const tx = db.transaction(stores, 'readwrite')
            for (const store of stores) for (const key of plan[store] ?? []) tx.objectStore(store).delete(key)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
        db.close()
    }, targets)
}

test('粘贴油猴脚本「导出配置」的裸 JSON：识别为配置并合并', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#migrate')
    await expect(page.locator('nav.tabs')).toBeVisible()
    const backup = await readConfig(page)
    try {
        // 源项目 Config 里可能有我们 schema 没有的键（authorization 等），必须如实提示而不是静默写入
        await page.locator(PASTE).fill(JSON.stringify({ downloadPath: '/Paste/%#TITLE#%.mp4', filterLikedVideos: true, promoteScriptAuthor: true, authorization: 'old-token' }))
        await page.locator(RUN).click()

        await expect(page.locator('.result-box')).toContainText('识别为配置文件')
        await expect(page.locator('.result-box')).toContainText('配置已导入合并')
        await expect(page.locator('.result-box')).toContainText('本扩展不支持')

        const config = await readConfig(page)
        expect(config.downloadPath).toBe('/Paste/%#TITLE#%.mp4')
        expect(config.filterLikedVideos).toBe(true)
        expect(config.promoteScriptAuthor).toBe(true)
        // 未知键不落盘（不会被 zod 之外的东西带进配置）
        expect(config.authorization).toBeUndefined()
    } finally {
        await writeConfig(page, backup)
    }
})

test('粘贴完整迁移包：四表写入与结构不合规如实计数', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#migrate')
    await expect(page.locator('nav.tabs')).toBeVisible()
    const backup = await readConfig(page)
    try {
        const payload = {
            config: { downloadPath: '/Paste/Package/%#TITLE#%.mp4' },
            videos: [
                { ID: 'pasteVideo1', Type: 'partial', Title: 'Pasted', Payload: 'x'.repeat(1024) },
                { ID: '', Type: 'partial' } // 结构不合规：ID 为空
            ],
            follows: [{ id: 'pasteUser1', username: 'paste_user' }],
            idmap: [{ ID: 'pasteVideo1', href: 'https://www.iwara.tv/video/pasteVideo1' }]
        }
        await page.locator(PASTE).fill(JSON.stringify(payload))
        await page.locator(RUN).click()

        await expect(page.locator('.result-box')).toContainText('识别为完整迁移包')
        await expect(page.locator('.result-box')).toContainText('视频库写入 1/2 条')
        await expect(page.locator('.result-box')).toContainText('跳过 1 条结构不合规')
        await expect(page.locator('.result-box')).toContainText('关注表写入 1/1 条')

        const config = await readConfig(page)
        expect(config.downloadPath).toBe('/Paste/Package/%#TITLE#%.mp4')

        const stored = await readDb(page)
        expect(stored.videos.some((video) => video.ID === 'pasteVideo1')).toBe(true)
        expect(stored.follows.some((user) => user.id === 'pasteUser1')).toBe(true)
        expect(stored.idmap.some((entry) => entry.ID === 'pasteVideo1')).toBe(true)
    } finally {
        await writeConfig(page, backup)
        await deleteDbRecords(page, { videos: ['pasteVideo1'], follows: ['pasteUser1'], idmap: ['pasteVideo1'] })
    }
})

test('非法 JSON / 无关 JSON：明确报错且不动现有配置', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#migrate')
    await expect(page.locator('nav.tabs')).toBeVisible()
    const before = await readConfig(page)

    await page.locator(PASTE).fill('{ not json')
    await page.locator(RUN).click()
    await expect(page.locator('.result-box.warn')).toContainText('不是合法 JSON')

    await page.locator(PASTE).fill(JSON.stringify({ hello: 'world' }))
    await page.locator(RUN).click()
    await expect(page.locator('.result-box.warn')).toContainText('无法识别的 JSON')

    expect(await readConfig(page)).toEqual(before)
})

/**
 * 回归守卫：导出 / 复制 / 导入三个动作**各有自己的进行中文案**。
 *
 * 曾经三者共用一个布尔 `busy`，而导入按钮文案写成 `busy ? '导入中…' : '导入粘贴内容'`——
 * 点「导出为 JSON 文件」时，下面的导入按钮会喊「导入中…」，而真正在跑的导出按钮只变灰、
 * 毫无反馈。用户看到的现象就是「我点的是导出，怎么导入在跑」。
 *
 * 用独立的 page + 接管 downloads/clipboard 让动作挂住 2s，稳定观察 busy 期间的文案；
 * 用完关闭页面，不污染共享会话（mock 只存在于该页面）。
 */
test('导出 / 复制时不污染导入按钮文案（各自独立的进行中文案）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    const probe = await page.context().newPage()
    await probe.goto(`chrome-extension://${extensionId}/options/index.html#migrate`)
    await expect(probe.locator('nav.tabs')).toBeVisible()

    const exportSection = probe.locator('section.card').filter({ has: probe.locator('h2', { hasText: '导出全部数据' }) })
    const exportButton = exportSection.locator('button').first()
    const copyButton = exportSection.locator('button').nth(1)
    const importButton = probe.getByTestId('migrate-paste-import')

    // 接管两个会真的产生副作用/弹窗的 API，让 busy 状态可观察
    await probe.evaluate(() => {
        const host = globalThis as unknown as { browser: { downloads: { download: unknown } }; navigator: { clipboard: { writeText: unknown } } }
        host.browser.downloads.download = () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 2000))
        host.navigator.clipboard.writeText = () => new Promise<void>((resolve) => setTimeout(() => resolve(), 2000))
    })

    await exportButton.click()
    await expect(exportButton).toHaveText('导出中…')
    // 关键断言：导入按钮只说自己的话（这里只是被禁用）
    await expect(importButton).toHaveText('导入粘贴内容')
    await expect(importButton).toBeDisabled()
    await expect(exportButton).toHaveText('导出为 JSON 文件', { timeout: 10_000 })

    await copyButton.click()
    await expect(copyButton).toHaveText('复制中…')
    await expect(importButton).toHaveText('导入粘贴内容')
    await expect(copyButton).toHaveText('复制到剪贴板', { timeout: 10_000 })

    await probe.close()
})

/**
 * 导出格式契约：增量序列化的产物必须能**逐字节**由 `JSON.stringify(payload, null, 2)` 还原。
 *
 * 这条断言与库里的数据无关，因此不受其它用例遗留数据影响；它锁的是：
 * 把「整串序列化」换成「按页增量拼接」时，格式一个字符都没变。
 * （曾经这里 `JSON.stringify` 整份载荷，大库直接抛 allocation size overflow。）
 */
test('导出为 JSON 文件：增量序列化后的格式与 JSON.stringify(…, null, 2) 完全一致', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    const probe = await page.context().newPage()
    await probe.goto(`chrome-extension://${extensionId}/options/index.html#migrate`)
    await expect(probe.locator('nav.tabs')).toBeVisible()

    // 接管下载：不落盘，直接读回 Blob URL 的文本
    await probe.evaluate(() => {
        const host = globalThis as unknown as { browser: { downloads: { download: unknown } }; __exported: string }
        host.browser.downloads.download = async (options: { url: string }) => {
            host.__exported = await (await fetch(options.url)).text()
            return 1
        }
    })

    const exportSection = probe.locator('section.card').filter({ has: probe.locator('h2', { hasText: '导出全部数据' }) })
    await exportSection.locator('button').first().click()

    await expect.poll((): Promise<number> => probe.evaluate(() => ((globalThis as unknown as { __exported?: string }).__exported ?? '').length), { timeout: 30_000 }).toBeGreaterThan(0)
    const text = await probe.evaluate(() => (globalThis as unknown as { __exported: string }).__exported)

    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['config', 'videos', 'follows', 'friends', 'idmap'])
    // 关键：重新 pretty-print 必须逐字节还原（含缩进、逗号、空表写法）
    expect(`${JSON.stringify(parsed, null, 2)}`).toBe(text)

    await probe.close()
})

/**
 * 导出必须有进度反馈。
 *
 * 1.6 GB 的库要跑几分钟（百来次分页消息），此前这段期间界面上只有一颗变灰的按钮——
 * 用户完全无法判断它在动还是卡死。这条用例锁三件事：
 * 1. 导出期间确实渲染进度条（`ProgressBar`，全站唯一形状）；
 * 2. 总量已知时是**确定态**（有 `aria-valuenow`，不是装样子的滑动动画）；
 * 3. 文案带当前表名与条数，而不只是一句「导出中…」。
 *
 * 把分页消息人为延迟，否则小库几百毫秒就跑完，进度条一闪而过抓不到。
 */
test('导出显示进度条：确定态 + 当前表与条数文案', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    const probe = await page.context().newPage()
    await probe.goto(`chrome-extension://${extensionId}/options/index.html#migrate`)
    await expect(probe.locator('nav.tabs')).toBeVisible()

    // 库里必须有记录，否则总量是 0（进度条只能是不确定态）——那测不到确定态这条断言。
    // 走 LEGACY_DB_BATCH 播种而不是直写 IndexedDB：它就是生产用的写入路径。
    const seeded = ['progressA', 'progressB', 'progressC']
    try {
        await probe.evaluate(async (ids: string[]) => {
            const host = globalThis as unknown as { browser: { runtime: { sendMessage: (req: unknown) => Promise<unknown> } } }
            await host.browser.runtime.sendMessage({ type: 'LEGACY_DB_BATCH', payload: { store: 'idmap', records: ids.map((ID) => ({ ID, href: `https://www.iwara.test/${ID}` })) } })
        }, seeded)

        // 让分页与计数消息慢下来（真实大库本来就要这么久），并接管下载避免真落盘
        await probe.evaluate(() => {
            const host = globalThis as unknown as { browser: { runtime: { sendMessage: (req: { type?: string }) => Promise<unknown> }; downloads: { download: unknown } } }
            const original = host.browser.runtime.sendMessage.bind(host.browser.runtime)
            host.browser.runtime.sendMessage = async (req: { type?: string }) => {
                if (req?.type === 'DB_STORE_COUNTS' || req?.type === 'DB_EXPORT_PAGE') await new Promise((resolve) => setTimeout(resolve, 500))
                return original(req)
            }
            host.browser.downloads.download = async () => 1
        })

        const exportSection = probe.locator('section.card').filter({ has: probe.locator('h2', { hasText: '导出全部数据' }) })
        await exportSection.locator('button').first().click()

        const bar = probe.getByTestId('export-progress')
        await expect(bar).toBeVisible()
        // 确定态：有 aria-valuenow（不确定态按 ARIA 规定不写这个属性）
        await expect(bar).toHaveAttribute('aria-valuenow', /\d+/)
        // 文案必须带当前表名与条数，而不只是一句「导出中…」
        await expect(bar).toHaveAttribute('aria-label', /正在导出 .+：\d+ \/ \d+ 条/)

        // 跑完后进度条消失（结果由 toast 汇报，界面上不留残留进度）
        await expect(bar).toBeHidden({ timeout: 60_000 })
    } finally {
        // 清理：协议里没有「删除记录」的消息（后台只增不删），测试直接读扩展 origin 的库删
        await deleteDbRecords(probe, { idmap: seeded })
        await probe.close()
    }
})

/**
 * 文件导入必须走**流式解码**（`TextDecoderStream`），不能 `file.text()`。
 *
 * 为什么非流式会炸：`Blob.text()` 会把整个文件解成**一个** JS 字符串，而视频库记录
 * 单条可达数 MB——整库导出轻易越过 V8 的字符串上限（≈512 MiB），导入端会抛
 * `allocation size overflow`。导出侧已经改成增量写，导入侧必须同样增量读，
 * 否则「自己导出的备份自己导不回来」。
 *
 * 这里造一份**跨多个解码块**的文件（约 120 KB，远大于 Blob 流的块大小），
 * 用条数断言守住「块边界不丢记录」——这是流式解析最容易出错的地方。
 */
test('选择文件导入：流式解码跨块不丢记录', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#migrate')
    await expect(page.locator('nav.tabs')).toBeVisible()
    const backup = await readConfig(page)

    const TOTAL = 600
    const ids = Array.from({ length: TOTAL }, (_, index) => `fileImport${String(index).padStart(4, '0')}`)
    const payload = JSON.stringify({
        config: { downloadPath: '/File/%#TITLE#%.mp4' },
        idmap: ids.map((ID) => ({ ID, href: `https://www.iwara.tv/video/${ID}?pad=${'x'.repeat(120)}` }))
    })

    try {
        await page.locator('input[type=file]').setInputFiles({
            name: 'IwaraAssistant-export.json',
            mimeType: 'application/json',
            buffer: Buffer.from(payload, 'utf8')
        })

        await expect(page.locator('.result-box')).toContainText('识别为完整迁移包', { timeout: 30_000 })
        await expect(page.locator('.result-box')).toContainText(`ID 映射表写入 ${TOTAL}/${TOTAL} 条`)
        await expect(page.locator('.result-box')).not.toContainText('写入失败')
        expect((await readConfig(page)).downloadPath).toBe('/File/%#TITLE#%.mp4')

        const stored = await readDb(page)
        const imported = stored.idmap.filter((entry) => entry.ID.startsWith('fileImport'))
        expect(imported.length).toBe(TOTAL)
    } finally {
        await writeConfig(page, backup)
        await deleteDbRecords(page, { idmap: ids })
    }
})

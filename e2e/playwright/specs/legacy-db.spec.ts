/**
 * 旧脚本页面数据库（IndexedDB `IwaraDownloadTool`）导入链路 e2e。
 *
 * 为什么必须放 e2e：这条路径跨了**两个 origin** ——
 * - 旧库在 `https://www.iwara.tv` 的 IndexedDB（只有注入到该页面的 content script 能读）；
 * - 扩展库在 `chrome-extension://<id>`（后台/options 能写）。
 * 单测只能覆盖校验函数，真正容易错的是「页面读 → 消息分批 → 后台入库」这段跨进程链路。
 *
 * 真实站点有 Cloudflare 风控，这里用 `context.route` 伪造 iwara 页面（零外网依赖），
 * 页面里直接建旧库，再重载触发 content script 检测。
 */
import { test, expect, openExtensionPage } from '../helpers/fixtures'
import { iwaraListPage } from '../helpers/site'

/** 旧库名与表结构（对齐 IwaraDownloadTool v22：videos / follows / friends / idmap） */
async function seedLegacyDb(): Promise<void> {
    const open = (version: number): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
            const request = indexedDB.open('IwaraDownloadTool', version)
            request.onupgradeneeded = () => {
                const db = request.result
                if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'ID' })
                if (!db.objectStoreNames.contains('follows')) db.createObjectStore('follows', { keyPath: 'id' })
                if (!db.objectStoreNames.contains('friends')) db.createObjectStore('friends', { keyPath: 'id' })
                if (!db.objectStoreNames.contains('idmap')) db.createObjectStore('idmap', { keyPath: 'ID' })
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
    const db = await open(22)
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['videos', 'follows', 'friends', 'idmap'], 'readwrite')
        const videos = tx.objectStore('videos')
        videos.put({ ID: 'legacyVideo1', Type: 'full', Title: 'Legacy One', UploadTime: 1700000000000 })
        videos.put({ ID: 'legacyVideo2', Type: 'partial', Title: 'Legacy Two' })
        videos.put({ ID: '', Type: 'full' }) // 不合规：应被丢弃
        // 大量小记录：强制多页读取 + 多条消息分批
        for (let index = 0; index < 300; index++) videos.put({ ID: `bulkVideo${index}`, Type: 'partial', Title: `Bulk ${index}`, Payload: 'x'.repeat(200) })
        // 单条 3 MB：超过消息体积预算，必须单独成批且仍能写入
        // （真实故障就是旧库里这种几 MB 一条的记录把一整批事务撑爆）
        videos.put({ ID: 'legacyVideoHuge', Type: 'full', Title: 'Legacy Huge', Payload: 'x'.repeat(3 * 1024 * 1024) })
        tx.objectStore('follows').put({ id: 'followUser1', username: 'someone' })
        tx.objectStore('friends').put({ id: 'friendUser1', username: 'friend' })
        tx.objectStore('idmap').put({ ID: 'legacyVideo1', href: 'https://www.iwara.tv/video/legacyVideo1' })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })
    db.close()
}

test.describe.configure({ mode: 'serial' })

test('旧脚本页面数据库：自动检测 → 迁移页显示条数 → 一键导入到扩展库', async ({ sharedSession }) => {
    const { context, page, extensionId } = sharedSession

    // 真实站点结构夹具（content_scripts.matches 命中 *://*.iwara.tv/*）
    await context.route('**/*.iwara.tv/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: iwaraListPage() }))

    // 导入必须在**已打开的 iwara 标签页**里执行（页面 IDB 只有那里的脚本能读），
    // 所以这里单独开一个 tab，options 页用原来的 page
    const iwara = await context.newPage()

    // 首次进入：此时还没有旧库 → content script 记下「已扫描、未找到」
    await iwara.goto('https://www.iwara.tv/videos')
    await expect(iwara.locator('html[data-ia-bridge]')).toHaveAttribute('data-ia-bridge', /ready|no-ack/, { timeout: 15_000 })

    // 模拟「旧脚本此前已经在这个浏览器里跑过」：在页面 origin 建库并写入记录
    await iwara.evaluate(seedLegacyDb)

    // 清掉一次性扫描标记，重载页面让 content script 重新检测
    await openExtensionPage(page, extensionId, 'options/index.html#migrate')
    await expect(page.locator('nav.tabs')).toBeVisible()
    await page.evaluate(async () => {
        await chrome.storage.local.remove('legacyDbScanned')
        await chrome.storage.local.remove('legacyDb')
    })

    await iwara.reload()
    await expect(iwara.locator('html[data-ia-bridge]')).toHaveAttribute('data-ia-bridge', /ready|no-ack/, { timeout: 15_000 })

    // 迁移页应展示检测结果（304 条视频记录里 1 条 ID 为空，但检测计数是「库中条数」）
    await openExtensionPage(page, extensionId, 'options/index.html#migrate')
    const legacySection = page.locator('section.card', { hasText: '从旧脚本浏览器数据库导入' })
    await expect(legacySection).toContainText('视频 304', { timeout: 15_000 })
    await expect(legacySection).toContainText('关注 1')

    // 一键导入（后台会找 iwara 标签页转发读取）
    await legacySection.locator('button.primary').click()
    // 按文案限定到导入提示：共享会话里可能还有其它 toast（保存提示等）
    const importToast = page.locator('[data-sonner-toast]', { hasText: '已导入' })
    await expect(importToast).toContainText('已导入：视频 303 / 关注 1 / 好友 1 / 映射 1', { timeout: 60_000 })
    // 结构不合规的那条要如实报告，不能只报成功数
    await expect(importToast).toContainText('跳过 1 条结构不合规')

    // 落到扩展自己的库（extension origin 的 IndexedDB）
    const stored = await page.evaluate(async () => {
        const open = (): Promise<IDBDatabase> =>
            new Promise((resolve, reject) => {
                const request = indexedDB.open('IwaraAssistant')
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
            })
        const db = await open()
        const read = (store: string): Promise<unknown[]> =>
            new Promise((resolve, reject) => {
                const request = db.transaction(store, 'readonly').objectStore(store).getAll()
                request.onsuccess = () => resolve(request.result as unknown[])
                request.onerror = () => reject(request.error)
            })
        const result = { videos: await read('videos'), follows: await read('follows'), friends: await read('friends'), idmap: await read('idmap') }
        db.close()
        return result
    })
    // 只数「本次迁移的 303 条」：共享会话里其它用例（如 api-hook 的 fetch 钩子）
    // 也会让扩展入库，用全表长度断言会被无关用例污染
    const migrated = stored.videos.filter((video) => /^(bulkVideo|legacyVideo)/.test((video as { ID: string }).ID))
    expect(migrated).toHaveLength(303)
    expect(stored.videos.some((video: unknown) => (video as { ID: string }).ID === 'legacyVideoHuge')).toBe(true)
    expect(stored.follows).toHaveLength(1)
    expect(stored.friends).toHaveLength(1)
    expect(stored.idmap).toHaveLength(1)

    // 迁移页更新为「上次导入于 …」
    await expect(legacySection).toContainText('上次导入于', { timeout: 10_000 })
})

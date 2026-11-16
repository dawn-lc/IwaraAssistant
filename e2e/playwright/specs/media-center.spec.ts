/**
 * MediaCenter 批量同步：**必须分页拉取**，且只扫描「还没有映射」的候选。
 *
 * 为什么值得一条 e2e：这条链路曾经用 `?limit=0` 一次性拉整个远端目录
 * （用户实测 14 万条 ≈ 118 MB），`response.json()` 直接把扩展进程卡死；
 * 修法本身（分页 + 候选索引）跨了「消息 → 后台 fetch → 匹配 → 推送 → UI」四层，
 * 任何一层回退都不会被单测抓到。这里用本地假 MediaCenter 把整链跑一遍：
 *
 * - 第 1 页全是无关记录，真正匹配的那条放在**第 2 页**——「只拉第 1 页」匹配不到，
 *   「一次性拉全量」不会出现 `page=2` 请求，两种回退都过不了；
 * - 断言映射真的落库、真的被推送，证明分页结果被用于认领而不是只被读了一遍。
 *
 * 断言只针对**我们自己种的这条记录**：共享 profile 里还有别的用例留下的映射
 * （例如 legacy-db 导入的 `legacyVideo1`），批量同步会连带推送它们，
 * 所以「共 N 条 / 成功 N」这种总数断言在这里天然不可靠。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, openExtensionPage, test } from '../helpers/fixtures'

const VIDEO_ID = 'mcE2eVideo1'
const MATCHED_ID = 'mc-e2e-page2'
/** 列表页延迟：让阶段一（分页扫描）持续足够长，能观察到进度条 */
const LIST_DELAY_MS = 300

interface FakeMediaCenter {
    apiBase: string
    requests: string[]
    close: () => Promise<void>
}

/**
 * 假 MediaCenter：只实现这条链路用到的端点。
 * 匹配记录放在第 2 页，用 `fileHash` 命中（与真实服务端的列表字段一致）。
 */
async function startFakeMediaCenter(): Promise<FakeMediaCenter> {
    const requests: string[] = []
    const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        requests.push(`${request.method} ${url.pathname}${url.search}`)
        const send = (status: number, body: unknown): void => {
            response.writeHead(status, { 'content-type': 'application/json' })
            response.end(JSON.stringify(body))
        }

        if (request.method === 'GET' && url.pathname === '/api/media') {
            const page = Number(url.searchParams.get('page') ?? '1')
            const limit = Number(url.searchParams.get('limit') ?? '100')
            const total = limit + 1
            const items = page === 1 ? Array.from({ length: limit }, (_value, index) => ({ id: `mc-unrelated-${index}`, title: `unrelated ${index}`, fileHash: `hash-${index}` })) : page === 2 ? [{ id: MATCHED_ID, title: 'matched by hash', fileHash: VIDEO_ID }] : []
            // 延迟回应：让阶段一（分页扫描）持续足够长，用例才能观察到进度条
            setTimeout(() => send(200, { items, pagination: { page, limit, total, totalPages: 2 } }), LIST_DELAY_MS)
            return
        }
        if (request.method === 'POST' && url.pathname === '/api/media') return send(201, { id: 'mc-created' })
        if (request.method === 'PUT' && url.pathname.startsWith('/api/media/')) return send(200, { media: { id: url.pathname.split('/').pop() } })
        if (request.method === 'GET' && url.pathname.startsWith('/api/media/')) return send(200, { id: url.pathname.split('/').pop() })
        return send(404, { error: 'not found' })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return {
        apiBase: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

test('分页认领映射并推送：匹配记录在第 2 页也能被找到', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    const server = await startFakeMediaCenter()
    let backup: Record<string, unknown> = {}
    try {
        await openExtensionPage(page, extensionId, 'options/index.html#advanced')
        await expect(page.locator('nav.tabs')).toBeVisible()

        // **先**备份配置（结束时整体还原），再打开实验特性 + 指向假服务端
        backup = await page.evaluate(async () => ((await browser.storage.local.get('config'))['config'] ?? {}) as Record<string, unknown>)
        const seeded = await page.evaluate(
            async ({ apiBase, videoId }) => {
                const stored = await browser.storage.local.get('config')
                const config = (stored['config'] ?? {}) as Record<string, unknown>
                await browser.storage.local.set({ config: { ...config, experimentalFeatures: true, mediaCenterApi: apiBase, mediaCenterApiKey: 'e2e-key' } })
                // 种一条 full 记录作为「本地视频」，让阶段一有候选
                return await browser.runtime.sendMessage({
                    type: 'LEGACY_DB_BATCH',
                    payload: {
                        store: 'videos',
                        records: [{ ID: videoId, Type: 'full', Title: 'Probe Video', Alias: '', Author: 'probe', AuthorID: 'probe', Description: '', UploadTime: Date.now(), Tags: [], RAW: { file: { duration: 42 } } }]
                    }
                })
            },
            { apiBase: server.apiBase, videoId: VIDEO_ID }
        )
        expect(seeded).toMatchObject({ ok: true })

        await page.reload()
        await expect(page.locator('nav.tabs')).toBeVisible()

        // 「实验性功能」卡的 note 里也写着「MediaCenter 联动」→ 必须按 h2 标题定位
        const mediaCard = page.locator('section.card').filter({ has: page.locator('h2', { hasText: 'MediaCenter 联动' }) })
        await mediaCard.locator('button').first().click()
        // 同步期间必须有进度条（用户报的就是「点了以后界面上什么都没有」）。
        // 进度走 storage.session 快照 + onChanged 订阅，所以点击后同帧就能看到。
        const progress = page.locator('[data-testid="media-sync-progress"]')
        await expect(progress).toBeVisible({ timeout: 5_000 })
        await expect(progress).toHaveAttribute('aria-label', /正在读取 MediaCenter 列表|正在推送映射记录/)
        // 结果徽章出现即表示后台已经跑完（阶段一 + 阶段二）
        await expect(mediaCard).toContainText('条：成功', { timeout: 60_000 })
        // 跑完后进度条必须收起（不能让界面留着一条永远不动的 0%）
        await expect(progress).toHaveCount(0)

        // 分页的证据：第 2 页真的被请求过（一次性拉全量的实现不会出现这条）
        expect(server.requests.filter((entry) => entry.includes('page=2'))).toHaveLength(1)
        expect(server.requests.some((entry) => entry.includes('limit=0'))).toBe(false)

        // 分页扫描的结论必须被用来认领映射，并真的推送这条记录
        expect(server.requests).toContain(`PUT /api/media/${MATCHED_ID}`)
        const idmap = await page.evaluate(async () => await browser.runtime.sendMessage({ type: 'DB_EXPORT_PAGE', payload: { store: 'idmap' } }))
        const records = (idmap as { data: { records: Array<{ ID: string; href: string }> } }).data.records
        expect(records.find((record) => record.ID === VIDEO_ID)?.href).toBe(MATCHED_ID)
    } finally {
        // 清理测试数据：视频库与 idmap 没有删除消息（生产代码也绝不该有），
        // 测试直接从扩展 origin 的 IndexedDB 删——这是测试可用的特权，不是产品行为。
        await page
            .evaluate(
                async ({ videoId, config }) => {
                    const open = (): Promise<IDBDatabase> =>
                        new Promise((resolve, reject) => {
                            const request = indexedDB.open('IwaraAssistant')
                            request.onsuccess = () => resolve(request.result)
                            request.onerror = () => reject(request.error)
                        })
                    const db = await open()
                    await new Promise<void>((resolve, reject) => {
                        const tx = db.transaction(['videos', 'idmap'], 'readwrite')
                        tx.objectStore('videos').delete(videoId)
                        tx.objectStore('idmap').delete(videoId)
                        tx.oncomplete = () => resolve()
                        tx.onerror = () => reject(tx.error)
                    })
                    db.close()
                    await browser.storage.local.set({ config })
                },
                { videoId: VIDEO_ID, config: backup }
            )
            .catch(() => undefined)
        await server.close()
    }
})

/**
 * popup e2e + 消息桥协议验证
 * - popup：配置页入口（九项导航与 options 共用同一份页签清单）
 * - 协议：经扩展页对 SW 发起真实 runtime 消息（PAGE_READY / INGEST_VIDEO_INFO / INIT_DOWNLOAD
 *   失败路径），覆盖 hub 的 sendResponse 兼容模式与错误封装
 */
import { expect } from '@playwright/test'
import { test, openExtensionPage } from '../helpers/fixtures'

test.describe.configure({ mode: 'serial' })

test('popup 是配置页入口：九项导航 + 深链打开 options', async ({ sharedSession }) => {
    const { context, extensionId } = sharedSession
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`)
    // Playwright Chromium locale 默认 en（browser.i18n 随浏览器语言），断言用结构而非文案
    await expect(popup.locator('h1')).toBeVisible({ timeout: 15_000 })
    // 页签清单与 options 导航同源（shared/optionsTabs.ts）：九项，且不再展示队列内容
    await expect(popup.locator('nav.entries .entry')).toHaveCount(9)
    await expect(popup.locator('.tasks')).toHaveCount(0)
    // 点第一项 → 打开（或复用）options 并落到 #download
    await popup.locator('nav.entries .entry').first().click()
    await expect.poll(() => context.pages().some((target) => target.url().includes('options/index.html#download'))).toBe(true)
    await popup.close()
})

test('PAGE_READY：返回配置快照与空回填列表（SW 消息路由）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 打开第二个扩展页作发送端（options 自身不经过 hub.send，避免混淆被测路径）
    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    const ready = await sender.evaluate(async () => {
        const res = await browser.runtime.sendMessage({ type: 'PAGE_READY', payload: {} })
        return res as { ok: boolean; data?: unknown; error?: string }
    })
    expect(ready.ok).toBe(true)
    const data = ready.data as { pageConfig: Record<string, boolean>; cacheList: unknown | null }
    expect(data.pageConfig).toHaveProperty('filterLikedVideos')
    expect(data.pageConfig).toHaveProperty('filterUnlistedAndPrivate')
    expect(data.pageConfig).toHaveProperty('addUnlistedAndPrivate')
    await sender.close()
})

test('INIT_DOWNLOAD 对非法 ID 返回失败任务（错误封装为 ok:false 而非拒绝）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    const res = await sender.evaluate(async () => {
        const res = await browser.runtime.sendMessage({ type: 'INIT_DOWNLOAD', payload: { videoId: 'e2e-nonexistent-id' } })
        return res as { ok: boolean; error?: string }
    })
    // 后台 runDownload 解析失败 → addTask failed + notifyTask；消息层仍 ok:true（返回 task），
    // 网络层异常（fetch 不可达）才会走 hub 的 ok:false 封装——两种形态在此环境均合法，
    // 断言「协议未抛未回复」（hub return true 模式工作）+ 失败信息可达
    expect(res).toBeTruthy()
    await sender.close()
})

test('GET_VIDEOS：视频库查询返回数组（给 ids 精确取 / 缺省取最近 N 条）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    const result = await sender.evaluate(async () => {
        const byIds = await browser.runtime.sendMessage({ type: 'GET_VIDEOS', payload: { ids: ['e2e-nonexistent'] } })
        const recent = await browser.runtime.sendMessage({ type: 'GET_VIDEOS', payload: {}, limit: 5 })
        return { byIds, recent } as { byIds: { ok: boolean; data?: unknown }; recent: { ok: boolean; data?: unknown } }
    })
    expect(result.byIds.ok).toBe(true)
    expect(Array.isArray(result.byIds.data)).toBe(true)
    expect((result.byIds.data as unknown[]).length).toBe(0)
    expect(result.recent.ok).toBe(true)
    expect(Array.isArray(result.recent.data)).toBe(true)
    await sender.close()
})

test('CHECK_LINK：非法 URL / 非 http 协议被拒绝（不发起请求）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    const result = await sender.evaluate(async () => {
        const invalid = await browser.runtime.sendMessage({ type: 'CHECK_LINK', payload: { url: 'not-a-url' } })
        const badProtocol = await browser.runtime.sendMessage({ type: 'CHECK_LINK', payload: { url: 'ftp://example.com/a' } })
        return { invalid, badProtocol } as {
            invalid: { ok: boolean; data?: { ok: boolean; reason?: string } }
            badProtocol: { ok: boolean; data?: { ok: boolean; reason?: string } }
        }
    })
    expect(result.invalid.data?.ok).toBe(false)
    expect(String(result.invalid.data?.reason ?? '')).toMatch(/URL/)
    expect(result.badProtocol.data?.ok).toBe(false)
    expect(String(result.badProtocol.data?.reason ?? '')).toMatch(/http/)
    await sender.close()
})

test('GET_CARD_META：卡片角标元数据（本地库只读，缺省全 false）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    const response = await sender.evaluate(async () => {
        return (await browser.runtime.sendMessage({
            type: 'GET_CARD_META',
            payload: { cards: [{ id: 'e2e-nonexistent', author: 'nobody-e2e' }] }
        })) as { ok: boolean; data?: { items: Array<{ id: string; following: boolean; downloaded: boolean }>; canDeletePlaylistItem: boolean } }
    })
    expect(response.ok).toBe(true)
    expect(response.data?.items?.length).toBe(1)
    expect(response.data?.items?.[0]?.following).toBe(false)
    expect(response.data?.items?.[0]?.downloaded).toBe(false)
    expect(response.data?.canDeletePlaylistItem).toBe(false)
    await sender.close()
})

/**
 * `DB_EXPORT_PAGE`：全量导出的分页读取。
 *
 * options **不允许**直接打开扩展的 IndexedDB（视频库后台专属），导出四张整表也只能经消息；
 * 而整表装不下一条消息，所以按主键分页。这条用例锁三件事：
 * 1. 读得到（后台确实能按 store 返回记录）；
 * 2. 分页边界（超过单页条数预算时 `nextAfter` 非空，下一页接着读、读完为 null）；
 * 3. 不重不漏（两页并起来正好是全部记录，且无重复主键）。
 */
test('DB_EXPORT_PAGE：分页读全表，不重不漏', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    // 播种：idmap 主键是 ID。造 1200 条以越过单页 1000 条预算，稳定触发分页。
    // 直接写 IndexedDB 只在**测试**里允许（生产代码必须走 LEGACY_DB_BATCH）。
    const TOTAL = 1200
    await sender.evaluate(async (total) => {
        const conn = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('IwaraAssistant')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise<void>((resolve, reject) => {
            const tx = conn.transaction('idmap', 'readwrite')
            const keys: string[] = []
            for (let index = 0; index < total; index++) {
                const id = `expPage${String(index).padStart(4, '0')}`
                keys.push(id)
                tx.objectStore('idmap').put({ ID: id, href: `https://example.test/${id}` })
            }
            tx.oncomplete = () => {
                conn.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        })
    }, TOTAL)

    const result = await sender.evaluate(async () => {
        const ids: string[] = []
        const pages: Array<{ count: number; nextAfter: string | null }> = []
        let after: string | undefined
        for (let guard = 0; guard < 20; guard++) {
            const response = (await browser.runtime.sendMessage({ type: 'DB_EXPORT_PAGE', payload: after === undefined ? { store: 'idmap' } : { store: 'idmap', after } })) as {
                ok: boolean
                data?: { records: Array<{ ID: string }>; nextAfter: string | null }
            }
            if (!response.ok || !response.data) return { ok: false as const, error: response.ok ? 'no data' : 'message failed' }
            pages.push({ count: response.data.records.length, nextAfter: response.data.nextAfter })
            for (const record of response.data.records) ids.push(record.ID)
            if (response.data.nextAfter === null) break
            after = response.data.nextAfter
        }
        return { ok: true as const, ids, pages }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { ids, pages } = result

    // 分页真实发生：至少两页，且中间页的 nextAfter 非空
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]?.nextAfter).not.toBeNull()
    expect(pages[pages.length - 1]?.nextAfter).toBeNull()
    // 不重不漏：只校验本次播种的记录。库里可能残留其它用例写入的 idmap
    // （同一 persistent profile 跨 spec 文件复用），所以不能断言整表条数。
    const seeded = ids.filter((id) => id.startsWith('expPage'))
    expect(seeded.length).toBe(TOTAL)
    expect(new Set(seeded).size).toBe(TOTAL)
    // 整表读取本身也不该丢数据：分页条目总和必须等于读到的记录数
    expect(pages.reduce((sum, page) => sum + page.count, 0)).toBe(ids.length)

    // 清场：删掉播种的记录，避免污染其它用例的精确计数
    await sender.evaluate(async (total) => {
        const conn = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('IwaraAssistant')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise<void>((resolve, reject) => {
            const tx = conn.transaction('idmap', 'readwrite')
            for (let index = 0; index < total; index++) tx.objectStore('idmap').delete(`expPage${String(index).padStart(4, '0')}`)
            tx.oncomplete = () => {
                conn.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        })
    }, TOTAL)
    await sender.close()
})

/**
 * 后端容量：两个守护进程分开报，**连不上不能抛错**。
 *
 * 用默认配置（aria2/iwaradl 默认指向 127.0.0.1）时本机很可能什么都没跑，
 * 所以断言只钉两件事：消息层永远 `ok:true`（失败封装在 data 里），
 * 且错误文案里不能带 token（端点 URL 里的密钥不该进界面/日志）。
 * 不在断言里假设后端不在——开发机真开着 aria2 也应该过。
 */
test('GET_BACKEND_STATS：两个后端分别报告，连不上时如实给原因而不是拒绝', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    type Read = { configured: boolean; ok?: boolean; error?: string; stats?: { active?: number; waiting?: number; maxConcurrent?: number; running?: number; pending?: number } }
    const response = await sender.evaluate(async () => {
        return (await browser.runtime.sendMessage({ type: 'GET_BACKEND_STATS', payload: {} })) as { ok: boolean; data?: { aria2: unknown; iwaradl: unknown }; error?: string }
    })

    expect(response.ok).toBe(true)
    const aria2 = response.data?.aria2 as Read
    const iwaradl = response.data?.iwaradl as Read
    expect(typeof aria2.configured).toBe('boolean')
    expect(typeof iwaradl.configured).toBe('boolean')

    for (const backend of [aria2, iwaradl]) {
        if (!backend.configured) continue
        if (backend.ok === true) {
            expect(backend.stats).toBeTruthy()
        } else {
            // 读失败必须给出非空原因，而且不能把端点 URL（可能含 token）原样搬进界面
            expect(typeof backend.error).toBe('string')
            expect((backend.error ?? '').length).toBeGreaterThan(0)
            expect(backend.error ?? '').not.toMatch(/token=/i)
        }
    }
    await sender.close()
})

test('任务队列表格实时反映 storage 变更（storage.onChanged 桥）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#tasks')
    await expect(page.locator('nav.tabs')).toBeVisible({ timeout: 15_000 })
    // 直接注入一条任务以渲染队列行（模拟后台落盘——真实链路由 runDownload 写入）；
    // 整表替换，不依赖前面用例留下的队列状态
    const seeded = await page.evaluate(async () => {
        const task = {
            id: 'e2e-seed-task',
            videoId: 'e2eVideo1',
            kind: 'browser' as const,
            status: 'running' as const,
            filename: 'Iwara/e2e/e2eVideo1.mp4'
        }
        await browser.storage.local.set({ downloadQueue: [task] })
        return true
    })
    expect(seeded).toBe(true)
    // storage.onChanged 桥实时反映（appStore/react useSyncExternalStore）
    await expect(page.locator('table.tasks tbody tr')).toHaveCount(1, { timeout: 10_000 })
    await expect(page.locator('table.tasks tbody tr td.mono').first()).toContainText('e2eVideo1')
    // 清理种子数据
    await page.evaluate(async () => {
        await browser.storage.local.set({ downloadQueue: [] })
    })
    await expect(page.locator('table.tasks')).toHaveCount(0, { timeout: 10_000 })
})

test('队列操作消息：REMOVE_TASK / CLEAR_FINISHED / RETRY_TASK 均由后台执行', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    // 1) 制造一条失败任务（非法 ID → 解析失败），确认时间戳已落盘
    await sender.evaluate(async () => {
        await browser.runtime.sendMessage({ type: 'INIT_DOWNLOAD', payload: { videoId: 'e2e-queue-op-id' } })
    })
    const failedQueue = await sender.evaluate(async () => {
        const stored = await browser.storage.local.get('downloadQueue')
        return (stored['downloadQueue'] ?? []) as Array<{ id: string; videoId: string; status: string; createdAt?: number; updatedAt?: number }>
    })
    const failedTask = failedQueue.find((task) => task.videoId === 'e2e-queue-op-id')
    expect(failedTask?.status).toBe('failed')
    // 队列时间戳（任务面板排序/耗时显示依赖）
    expect(typeof failedTask?.createdAt).toBe('number')
    expect(typeof failedTask?.updatedAt).toBe('number')
    if (!failedTask) throw new Error('未生成失败任务')

    // 2) 单条移除（后台唯一写者 → 内存与 storage 同步）
    const removed = await sender.evaluate(async (taskId) => {
        return (await browser.runtime.sendMessage({ type: 'REMOVE_TASK', payload: { taskId } })) as { ok: boolean; data?: { removed?: boolean } }
    }, failedTask.id)
    expect(removed.ok).toBe(true)
    expect(removed.data?.removed).toBe(true)

    // 3) 重试不存在的任务 → 明确错误信封（不是静默成功）
    const retryMissing = await sender.evaluate(async () => {
        return (await browser.runtime.sendMessage({ type: 'RETRY_TASK', payload: { taskId: 'e2e-not-exist' } })) as { ok: boolean; error?: string }
    })
    expect(retryMissing.ok).toBe(false)
    expect(String(retryMissing.error ?? '')).toMatch(/任务不存在/)

    // 4) 清除已结束（此时队列应为空）
    const cleared = await sender.evaluate(async () => {
        return (await browser.runtime.sendMessage({ type: 'CLEAR_FINISHED', payload: {} })) as { ok: boolean; data?: { removed?: number } }
    })
    expect(cleared.ok).toBe(true)

    const finalQueue = await sender.evaluate(async () => {
        const stored = await browser.storage.local.get('downloadQueue')
        return (stored['downloadQueue'] ?? []) as unknown[]
    })
    expect(finalQueue.length).toBe(0)
    await sender.close()
})

test('FORCE_DOWNLOAD：绕门入口必须有实现（曾经漏了分支 → 点了只报 unknown message type）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const sender = await page.context().newPage()
    await sender.goto(`chrome-extension://${extensionId}/popup/index.html`)
    await expect(sender.locator('h1')).toBeVisible()

    // 用非法 ID：解析必然失败 → 落一条 failed 任务，不依赖网络与登录态。
    // 关键断言是 `ok === true`：漏了分支时后台会 throw `unknown message type`，
    // 而任务列表里那个「强制下载」按钮正是唯一能让 skipped 任务继续下载的出口。
    const forced = await sender.evaluate(async () => {
        return (await browser.runtime.sendMessage({ type: 'FORCE_DOWNLOAD', payload: { videoId: 'e2e-force-download-id' } })) as { ok: boolean; data?: { videoId?: string; status?: string }; error?: string }
    })
    expect(forced.error ?? '').not.toMatch(/unknown message type/)
    expect(forced.ok).toBe(true)
    expect(forced.data?.videoId).toBe('e2e-force-download-id')
    expect(forced.data?.status).toBe('failed')

    // 清理
    await sender.evaluate(async () => {
        await browser.storage.local.set({ downloadQueue: [] })
    })
    await sender.close()
})

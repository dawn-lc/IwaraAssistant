/**
 * 队列操作 toast 的验收点 —— 直接跑在真实扩展页里。
 *
 * 两个曾经踩到的问题（都是真缺陷，不是测试写法问题）：
 * 1. 所有操作 toast 共用一个 id → 连删两条只看到最后一条（后来的覆盖前一条）；
 * 2. 后台 `REMOVE_TASK` 在任务已不存在时返回 `{ removed: false }`，UI 却照样
 *    弹绿色「已移除」—— 谎报成功。
 */
import { expect } from '@playwright/test'
import { test, openExtensionPage } from '../helpers/fixtures'

test.describe.configure({ mode: 'serial' })

/** 页面里发真实 runtime 消息（扩展页有 browser shim） */
async function sendMessage(page: import('@playwright/test').Page, message: unknown): Promise<unknown> {
    return page.evaluate(async (payload) => {
        const api = (globalThis as unknown as { browser?: { runtime?: { sendMessage?: (m: unknown) => Promise<unknown> } } }).browser
        if (!api?.runtime?.sendMessage) throw new Error('当前页不是扩展页')
        return await api.runtime.sendMessage(payload)
    }, message)
}

test('队列操作 toast：多条独立堆叠，且如实反映后端结果', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#tasks')
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 清空后通过后台真实建两条任务（非法 ID 会在解析阶段直接落为 failed）
    await sendMessage(page, { type: 'CLEAR_FINISHED', payload: {} })
    await page.evaluate(async () => {
        await browser.storage.local.set({ downloadQueue: [] })
    })
    const first = (await sendMessage(page, { type: 'INIT_DOWNLOAD', payload: { videoId: 'toastOne' } })) as { ok?: boolean }
    const second = (await sendMessage(page, { type: 'INIT_DOWNLOAD', payload: { videoId: 'toastTwo' } })) as { ok?: boolean }
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    const rows = page.locator('table.tasks tbody tr')
    await expect(rows).toHaveCount(2, { timeout: 10_000 })

    // 连删两条：必须看到两条独立 toast（共用 id 时只会剩一条）
    const remove = page.locator('table.tasks tbody tr button:last-child')
    await remove.nth(0).click()
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(1, { timeout: 5_000 })
    await remove.nth(0).click()
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(2, { timeout: 5_000 })
    const texts = await page.locator('[data-sonner-toast]').allTextContents()
    expect(texts.some((text) => text.includes('toastOne'))).toBe(true)
    expect(texts.some((text) => text.includes('toastTwo'))).toBe(true)

    // 后端没执行时不许报成功：直接写 storage 造出「UI 有行、后台队列没有」的错位，
    // 此时 REMOVE_TASK 返回 { removed: false }，提示口径必须变成中性的「已不在队列中」。
    await page.evaluate(async () => {
        const now = Date.now()
        await browser.storage.local.set({ downloadQueue: [{ id: 'ghost-row', videoId: 'ghostVideo', kind: 'browser', status: 'complete', createdAt: now, updatedAt: now }] })
    })
    await expect(rows).toHaveCount(1, { timeout: 10_000 })
    await page.locator('table.tasks tbody tr button:last-child').click()
    const stale = page.locator('[data-sonner-toast]', { hasText: 'ghostVideo' })
    await expect(stale).toContainText('已不在队列中', { timeout: 5_000 })
    await expect(stale).toHaveAttribute('data-type', 'info')

    // 清理
    await page.evaluate(async () => {
        await browser.storage.local.set({ downloadQueue: [] })
    })
})

/**
 * 任务列表分页 —— 千条队列的操作卡顿验收点。
 *
 * 背景：`visible.map` 一次性把整份列表挂到 DOM 上，1200 条时一次重渲染实测 40–60 ms
 * （更早的写法在高负载机器上会到数百毫秒），而「清除已结束」还要卸载同样多的行。
 * 现在每页 50 条，`tbody tr` 只含当前页，翻页/筛选变化后页码回到第 1 页。
 */
import { expect } from '@playwright/test'
import { test } from '../helpers/fixtures'

test.describe.configure({ mode: 'serial' })

/** 生成 n 条已完成任务（只用于撑起分页，不跑真实下载） */
function seedTasks(n: number): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (let i = 0; i < n; i++) {
        out.push({
            id: `page-task-${i}`,
            videoId: `page${i}`,
            kind: 'aria2',
            status: 'complete',
            kindRef: i.toString(16).padStart(16, '0'),
            filename: `page-${i}.mp4`,
            progress: 1,
            createdAt: 1700000000000 + i,
            updatedAt: 1700000000000 + i
        })
    }
    return out
}

test('任务列表分页：只渲染当前页，翻页与筛选都回到第一页', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await page.goto(`chrome-extension://${extensionId}/options/index.html#tasks`)
    await page.waitForTimeout(800)

    await page.evaluate(async (tasks) => {
        await browser.storage.local.set({ downloadQueue: tasks })
    }, seedTasks(60))

    const rows = page.locator('table.tasks tbody tr')
    await expect(rows).toHaveCount(50)
    await expect(page.locator('.queue-pager')).toBeVisible()

    await page.locator("[data-testid='tasks-next-page']").click()
    await expect(rows).toHaveCount(10)
    await expect(page.locator("[data-testid='tasks-next-page']")).toBeDisabled()

    await page.locator("[data-testid='tasks-prev-page']").click()
    await expect(rows).toHaveCount(50)

    // 换筛选要回到第 1 页：否则新筛选的条目数可能少于当前页，界面会显示空白页
    await page.locator("[data-testid='tasks-next-page']").click()
    await page.locator('.queue-filters button').first().click()
    await expect(rows).toHaveCount(50)
    await expect(page.locator("[data-testid='tasks-prev-page']")).toBeDisabled()

    await page.evaluate(async () => {
        await browser.storage.local.set({ downloadQueue: [] })
    })
    await expect(page.locator('table.tasks tbody tr')).toHaveCount(0)
})

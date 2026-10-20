/**
 * 冒烟：扩展装载 + SW 启动（docs/06 M0 验收的自动化版）
 * ——SW console 应出现 background up 标记（含宿主标签），且 options 页可打开
 */
import { expect } from '@playwright/test'
import { test, openExtensionPage } from '../helpers/fixtures'

test.describe.configure({ mode: 'serial' })

test('扩展装载：SW 启动且打印 background up', async ({ sharedSession }) => {
    const { extensionId, swConsole } = sharedSession
    // boot() 是异步的（loadQueue→updateBadge→contextMenus→aria2 追踪），
    // waitForEvent('serviceworker') 返回时日志可能尚未打印——轮询等待而非即时断言
    await expect.poll(() => swConsole.join('\n'), { timeout: 30_000 }).toContain('[iwara-assistant] background up')
    expect(extensionId).toMatch(/^[a-p]{32}$/)
})

test('options 页可打开并渲染配置中心（页签导航存在）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    // React 挂载（useSyncExternalStore 桥 ready）：显示页签导航
    await expect(page.locator('nav.tabs')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('nav.tabs button')).toHaveCount(9)
})

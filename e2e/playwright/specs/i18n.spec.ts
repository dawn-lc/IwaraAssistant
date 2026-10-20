/**
 * 运行时多语言 e2e —— 参考 MediaCenter 的实现（字典分文件 + 跟随浏览器语言 + 用户选择持久化）。
 *
 * 三个不能退让的点：
 * 1. 切换语言必须**立即**生效（不能等 reload），且 reload 后仍在（写入 config）；
 * 2. 语言是**同一份**配置：content script 的页内菜单必须跟着变，不能各写一套；
 * 3. 「自动」必须真的跟随浏览器语言（本套 e2e 把浏览器钉在 zh-CN）。
 *
 * 用例修改了共享会话的 config，结尾必须还原，否则后续用例的中文断言会炸。
 */
import { test, expect, openExtensionPage } from '../helpers/fixtures'
import { iwaraListPage } from '../helpers/site'

test.describe.configure({ mode: 'serial' })

test('界面语言：切换立即生效 + reload 仍在 + 页内菜单共用同一份配置', async ({ sharedSession }) => {
    const { context, page, extensionId } = sharedSession

    // 伪造站点（页内菜单需要真实注入环境）
    await context.route('**/*.iwara.tv/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: iwaraListPage() }))
    const iwara = await context.newPage()
    await iwara.goto('https://www.iwara.tv/videos')
    await expect(iwara.locator('html[data-ia-bridge]')).toHaveAttribute('data-ia-bridge', /ready|no-ack/, { timeout: 15_000 })

    await openExtensionPage(page, extensionId, 'options/index.html#advanced')
    const select = page.getByTestId('ui-language')
    // 新装默认「自动」，浏览器语言是 zh-CN → 中文界面
    await expect(select).toHaveValue('auto')
    await expect(page.locator('h1')).toHaveText('Iwara Assistant 设置')
    await expect(iwara.locator('#pluginMenu li[data-action="manual-download"]')).toHaveText('手动下载')

    // 切换到英文：options 立即换语言（不 reload）
    await select.selectOption('en')
    await expect(page.locator('h1')).toHaveText('Iwara Assistant Settings')
    await expect(page.locator('nav.tabs button').first()).toHaveText('Download')
    // `<html lang>` 跟随语言（屏幕阅读器与 :lang() 都看它，写死 en 是隐性 a11y 缺陷）
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    // 页内菜单跟随同一份 config（background 广播 CONFIG_SYNC → 菜单重建）
    await expect(iwara.locator('#pluginMenu li[data-action="manual-download"]')).toHaveText('Manual download', { timeout: 10_000 })

    // reload 后仍在（写进了 storage.local.config）
    await page.reload()
    await expect(page.locator('h1')).toHaveText('Iwara Assistant Settings')

    // 日文：验证第三种语言的字典也真的被加载（而不是只有 en/zh）
    await page.getByTestId('ui-language').selectOption('ja')
    await expect(page.locator('h1')).toHaveText('Iwara Assistant 設定')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
    await expect(iwara.locator('#pluginMenu li[data-action="manual-download"]')).toHaveText('手動ダウンロード', { timeout: 10_000 })

    // 还原「自动」：后续用例断言中文文案
    await page.getByTestId('ui-language').selectOption('auto')
    await expect(page.locator('nav.tabs button').first()).toHaveText('下载')
    await iwara.close()
    // 清场：切换语言留下了「已保存」toast，reload 把它连同 DOM 一起清掉，不影响后续用例
    await page.reload()
    await expect(page.locator('nav.tabs')).toBeVisible()
})

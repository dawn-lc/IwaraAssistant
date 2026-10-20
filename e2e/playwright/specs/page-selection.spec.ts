/**
 * 页内勾选 ⇄ 批量下载 的联动 e2e。
 *
 * 守的是一个**曾经缺失**的行为：批量下载创建成功后，页内复选框必须自动取消勾选。
 * 源项目（`IwaraDownloadTool/src/features/downloadFlow.ts`）在 `analyzeDownloadTask`
 * 的循环里逐项 `taskList.delete(id)`（活引用写透 `selectList`），所以勾选会随处理进度
 * 一个个消失；本扩展最初只把 `BATCH_DOWNLOAD` 发出去、完全不处理返回，勾选永远残留。
 *
 * 这里的失败路径正好可用：`api.iwara.tv` 被伪造成 500，`runDownload` 会落一条
 * `failed` 任务并返回（不抛错），所以批量流程照常逐项推进——**失败项也会取消勾选**，
 * 与源项目一致（失败原因在队列/通知里可见，页面勾选不承担「待重试」语义）。
 */
import { test, expect, openExtensionPage } from '../helpers/fixtures'

function stubPage(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>stub iwara</title></head>
<body><main class="container">
  <div class="videoTeaser">
    <a class="videoTeaser__thumbnail" href="/video/selVideo1"><img alt=""></a>
    <a class="videoTeaser__title" href="/video/selVideo1" title="Sel One">Sel One</a>
    <a class="username" href="/profile/someone" title="Someone">Someone</a>
  </div>
  <div class="videoTeaser">
    <a class="videoTeaser__thumbnail" href="/video/selVideo2"><img alt=""></a>
    <a class="videoTeaser__title" href="/video/selVideo2" title="Sel Two">Sel Two</a>
    <a class="username" href="/profile/someone" title="Someone">Someone</a>
  </div>
</main></body></html>`
}

test.describe.configure({ mode: 'serial' })

test('批量下载后页内勾选自动取消（对齐源项目 analyzeDownloadTask 的逐项 delete）', async ({ sharedSession }) => {
    const { context, page, extensionId } = sharedSession

    // 站点伪造 + API 直接失败：批量流程走「解析失败 → failed 任务」分支，仍然算已处理
    await context.route('**/*.iwara.tv/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: stubPage() }))
    await context.route('**/api.iwara.tv/**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"stub"}' }))

    // 先开扩展页（读 storage 用；扩展页才有 browser.* API）
    await openExtensionPage(page, extensionId, 'options/index.html#download')
    await expect(page.locator('nav.tabs')).toBeVisible()
    await page.evaluate(async () => {
        const stored = (await browser.storage.local.get('config'))['config'] ?? {}
        // 关掉 1s 节流，缩短用例时间；不开 experimentalFeatures，避免走 aria2 去重分支
        await browser.storage.local.set({ config: { ...stored, enableUnsafeMode: true, experimentalFeatures: false, downloadType: 3 } })
        await browser.storage.local.set({ pageSelection: [] })
    })

    const iwara = await context.newPage()
    await iwara.goto('https://www.iwara.tv/videos')
    await expect(iwara.locator('html[data-ia-bridge]')).toHaveAttribute('data-ia-bridge', /ready|no-ack/, { timeout: 15_000 })

    // autoInjectCheckbox 默认开启 + 列表页 → 复选框自动注入
    const boxes = iwara.locator('input.selectButton')
    await expect(boxes).toHaveCount(2, { timeout: 15_000 })

    await boxes.nth(0).click()
    await boxes.nth(1).click()
    await expect(iwara.locator('input.selectButton:checked')).toHaveCount(2)

    // 选择集确实写进了 storage（跨标签页共享的那一份）
    const storedSelection = async (): Promise<string[]> => (await page.evaluate(async () => (await browser.storage.local.get('pageSelection'))['pageSelection'])) as string[]
    await expect.poll(storedSelection).toHaveLength(2)

    // 计数只出现在右下角水印（源 `ui/widgets/watermark.ts` + `main.ts` 的 selection:changed）；
    // 菜单项文案是静态的 `%#downloadSelected#%`，带数字就是自造行为（曾经加过，已删）。
    await expect(iwara.locator('#pluginMenu li[data-action="batch-download"]')).not.toHaveText(/\d/)
    await expect(iwara.locator('#pluginWatermark .ia-watermark-count')).toHaveText(/2/)

    // 触发批量下载（直接派发 click，不依赖悬浮展开动画）
    await iwara.evaluate(() => {
        document.querySelector<HTMLElement>('#pluginMenu li[data-action="batch-download"]')?.click()
    })

    // 关键断言：勾选全部消失，且 storage 里也清空（→ 其它标签页同步取消）
    await expect(iwara.locator('input.selectButton:checked')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(storedSelection, { timeout: 30_000 }).toHaveLength(0)

    // 任务确实产生了（证明不是「消息根本没发出去」造成的假通过）
    const queue = (await page.evaluate(async () => (await browser.storage.local.get('downloadQueue'))['downloadQueue'])) as Array<Record<string, unknown>>
    expect(queue.length).toBeGreaterThanOrEqual(2)

    await iwara.close()
})

/**
 * options 配置中心 e2e —— 页签导航 / 即时保存 / storage 持久化 / 任务队列视图
 */
import { expect } from '@playwright/test'
import { test, openExtensionPage } from '../helpers/fixtures'

test.describe.configure({ mode: 'serial' })

const TAB_IDS = ['download', 'rpc', 'filter', 'clean', 'tasks', 'friends', 'migrate', 'advanced', 'guide']

test('九个页签切换渲染', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await expect(page.locator('nav.tabs')).toBeVisible()

    for (const id of TAB_IDS) {
        await page.locator(`nav.tabs button`, { hasText: new RegExp(id === 'download' ? '下载' : '') }).first()
        await page.locator(`nav.tabs button:has-text("${labelFor(id)}")`).click()
        expect(page.url()).toContain(`#${id}`)
        // 每页签至少渲染一张 card（下载页 card 内含模式选择）
        await expect(page.locator('section.card').first()).toBeVisible()
    }
})

function labelFor(id: string): string {
    switch (id) {
        case 'download':
            return '下载'
        case 'rpc':
            return 'RPC 端点'
        case 'filter':
            return '过滤'
        case 'clean':
            return '文件名清洗'
        case 'tasks':
            return '任务队列'
        case 'friends':
            return '好友请求'
        case 'migrate':
            return '迁移'
        case 'advanced':
            return '高级'
        default:
            return '使用引导'
    }
}

test('过滤开关即时保存并写入 storage（reload 后仍在）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#filter')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const toggles = page.locator('.toggle input[type="checkbox"]')
    const first = toggles.nth(0)
    const before = await first.isChecked()
    await first.click()

    // 即时保存提示（sonner toast，带 data-testid="save-toast"）
    await expect(page.locator('[data-testid="save-toast"]')).toContainText('已保存', { timeout: 5_000 })

    // reload 后取值保持（storage 持久化）
    await page.reload()
    await expect(page.locator('nav.tabs')).toBeVisible()
    const after = await toggles.nth(0).isChecked()
    expect(after).toBe(!before)

    // 还原（避免影响其它用例/人工观察）
    await toggles.nth(0).click()
    await expect(page.locator('[data-testid="save-toast"]')).toContainText('已保存', { timeout: 5_000 })
})

test('下载页签路径模板实时预览（渲染管线共享）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html')
    await page.locator('nav.tabs button:has-text("下载")').click()

    const preview = page.locator('code.preview')
    await expect(preview).toContainText('/Iwara/', { timeout: 10_000 })
    await expect(preview).toContainText('someone') // 示例视频 AUTHOR

    // 改模板 → 预览即时更新（saveConfig → 预览同管线重渲）
    const input = page.locator('section.card').filter({ hasText: '保存路径模板' }).locator('input[type="text"]').first()
    await input.fill('/IwaraTest/%#ALIAS#%/%#ID#%.mp4')
    await expect(preview).toContainText('/IwaraTest/Sample Alias/', { timeout: 10_000 })
    // 还原默认模板
    await input.fill('/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4')
    await expect(page.locator('[data-testid="save-toast"]')).toContainText('已保存', { timeout: 5_000 })
})

/**
 * 下载代理在「下载」页签可见，并且写入 storage。
 *
 * 代理只被 aria2 / iwaradl 使用；放在下载页签是为了和下载方式、路径模板一起被发现，
 * 而不是藏到 RPC 端点页底部。配置键本身仍是 `downloadProxy*`，后台无需改动。
 */
test('下载页签提供代理配置并写盘', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#download')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const section = page.locator('section.card').filter({ hasText: '下载代理' })
    await expect(section).toBeVisible()
    // 密码字段必须遮罩（与源项目 password 类型一致）
    await expect(section.locator('input').nth(2)).toHaveAttribute('type', 'password')

    const proxy = section.locator('input').first()
    await proxy.fill('http://127.0.0.1:7890')
    await expect(page.locator('[data-testid="save-toast"]')).toContainText('已保存', { timeout: 5_000 })

    const readProxy = (): Promise<unknown> => page.evaluate(async () => ((await browser.storage.local.get('config'))['config'] as Record<string, unknown> | undefined)?.['downloadProxy'])
    await expect.poll(readProxy, { timeout: 5_000 }).toBe('http://127.0.0.1:7890')

    // 还原，避免污染后续用例
    await proxy.fill('')
    await expect(page.locator('[data-testid="save-toast"]')).toContainText('已保存', { timeout: 5_000 })
})

/**
 * 默认下载方式 = 浏览器内建下载。
 *
 * 这不是美观问题：`others` 只是开一个直链标签页，交付之后没有任何回传，
 * 任务会永远停在「进行中」、也永远不可移除（详见 docs/05）。
 * 新装用户不该被送到那个通道上，所以这里从 storage 里删掉 `downloadType`
 * 再由 schema 补默认值——等价于新装，而不是读一个可能被前人改过的配置。
 */
test('默认下载方式是浏览器内建下载（新装不该落到交付型通道）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#download')
    await expect(page.locator('nav.tabs')).toBeVisible()

    await page.evaluate(async () => {
        const stored = await browser.storage.local.get('config')
        const config = { ...((stored['config'] ?? {}) as Record<string, unknown>) }
        delete config['downloadType']
        await browser.storage.local.set({ config })
    })
    await page.reload()
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 第一张 card 的第一行就是「下载方式」
    const select = page.locator('section.card').first().locator('select').first()
    await expect(select).toHaveValue('2')
    // 选项顺序：默认项排第一（不用每次往下翻）
    expect(await select.locator('option').first().getAttribute('value')).toBe('2')
    expect(await select.locator('option').count()).toBe(4)
})

/**
 * 「同时下载数」：配置项 + 输入控件是同一个数的两个面。
 *
 * 这里只验界面到 storage 的往返（后台闸门本身是纯判据，由
 * `test/browserConcurrency.test.ts` 覆盖；真下载链路需要真实站点，放不进门禁）。
 * 断言 `role=spinbutton` 上确实存在 min/max，避免把 0 或 100 存进去——
 * 0 会让所有浏览器下载都排不上队，100 等于没有上限。
 */
test('同时下载数：写盘往返 + 控件带 1~10 边界', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#download')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const input = page.locator('section.card').first().locator('input[type="number"]').first()
    await expect(input).toHaveAttribute('min', '1')
    await expect(input).toHaveAttribute('max', '10')

    await input.fill('2')
    await input.blur()
    await expect.poll(async () => await page.evaluate(async () => ((await browser.storage.local.get('config'))['config'] as { browserConcurrentDownloads?: number } | undefined)?.browserConcurrentDownloads)).toBe(2)

    // 还原默认值，避免污染后续用例的观察结果
    await input.fill('3')
    await input.blur()
    await expect.poll(async () => await page.evaluate(async () => ((await browser.storage.local.get('config'))['config'] as { browserConcurrentDownloads?: number } | undefined)?.browserConcurrentDownloads)).toBe(3)
})

/**
 * 后端容量面板：**必须能区分「没配置」「连不上」「正常」**。
 *
 * 三种情况都显示 0 是最糟的实现——用户会以为后端空闲，而实际上根本没连上。
 * 这里用默认配置（`127.0.0.1` 上大概什么都没跑）验证：面板渲染出来、
 * 两个后端各占一行、且内容是非空的可读结论（不是空白/占位符）。
 * 不假设后端一定不在（开发机真开着 aria2 也该过）。
 */
test('RPC 页：后端容量面板渲染出两个后端，且给出非空结论', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#rpc')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const card = page.locator('section.card').filter({ has: page.locator('h2', { hasText: '后端容量' }) })
    await expect(card).toBeVisible()
    const rows = card.locator('.row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Aria2')
    await expect(rows.nth(1)).toContainText('iwaradl')

    // 每行的结论不能为空：未配置 / 读取失败原因 / 真实数值，三者之一
    await expect
        .poll(
            async () => {
                const texts = await card.locator('.row-control').allInnerTexts()
                return texts.map((text) => text.trim()).join('|')
            },
            { timeout: 20_000 }
        )
        .not.toBe('|')
})

/**
 * 设置行必须**两端对齐**：标签贴内容左边界，控件贴内容右边界。
 *
 * 这是「看不见就退化」的典型：把 `.row-control` 的 `justify-content` 改回默认，
 * 开关与数字框会停在 420px 控件列的左端，右侧留 300~380px 空白——
 * 界面还能用、截图初看也没坏，只有逐行量右边缘才会发现。
 * 用几何断言把它钉住（同时锁住 `.row--stack` 的满宽行也贴齐两端）。
 */
test('设置行两端对齐：控件右边缘与卡片内容右边缘重合', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#download')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const geometry = await page.evaluate(() => {
        // 用「第一张卡片」而不是 `section.card:first-of-type`：
        // `:first-of-type` 要求它是同级里的第一个 `<section>`，而页面结构里那一条
        // 并不保证命中卡片（实测匹配到 0 个，断言变成空循环）。
        const card = document.querySelector('section.card')
        if (!card) throw new Error('找不到卡片')
        const body = card.querySelector('.section-body')
        if (!body) throw new Error('找不到卡片内容区')
        const bodyRect = body.getBoundingClientRect()
        const rows = Array.from(card.querySelectorAll('.row'))
        return {
            left: Math.round(bodyRect.left),
            right: Math.round(bodyRect.right),
            rows: rows.map((row) => {
                const label = row.querySelector('.row-label')
                const control = row.querySelector('.row-control')
                const last = control?.lastElementChild
                if (!label || !last) throw new Error('行结构不符合 .row-label + .row-control')
                const labelRect = label.getBoundingClientRect()
                const lastRect = last.getBoundingClientRect()
                return { labelLeft: Math.round(labelRect.left), lastRight: Math.round(lastRect.right) }
            })
        }
    })

    // 至少要有几行才说明这条断言有意义（防止选择器写错后「零循环 = 通过」）
    expect(geometry.rows.length).toBeGreaterThanOrEqual(3)
    for (const row of geometry.rows) {
        expect(row.labelLeft).toBe(geometry.left)
        expect(row.lastRight).toBe(geometry.right)
    }
})

/**
 * 控件列必须**按内容收缩**，不能让标签区白让出一整列。
 *
 * 旧规则是 `grid-template-columns: minmax(0, 1fr) minmax(240px, 420px)`：开关只有 38px 宽，
 * 第二列却固定吃 420px → 标签只剩 414px，「同时下载数」的 hint 被折成 3 行，
 * 右边 300px 是空的（用户原话「为什么文本还是有限制」）。
 *
 * 判据用「列宽 ≈ 内容宽」而不是「hint 少折几行」：文案会随翻译变长变短，
 * 但列有没有白占是布局本身的性质。
 */
test('控件列按内容收缩：窄控件不白占一整列，stack 行仍满宽', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#download')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const rows = await page.evaluate(() => {
        const out = []
        // 遍历**全部**卡片：stack 行（模板 / 预览）在第二张卡，
        // 只看第一张卡会让「stack 行满宽」那条断言变成空循环（第一次就写错了）。
        for (const card of Array.from(document.querySelectorAll('section.card'))) {
            const body = card.querySelector('.section-body')
            if (!body) continue
            const bodyWidth = Math.round(body.getBoundingClientRect().width)
            for (const row of Array.from(card.querySelectorAll('.row'))) {
                const label = row.querySelector('.row-label')
                const control = row.querySelector('.row-control')
                if (!label || !control) throw new Error('行结构不符合 .row-label + .row-control')
                const children = Array.from(control.children)
                const gap = parseFloat(getComputedStyle(control).columnGap) || 0
                const used = children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + gap * Math.max(0, children.length - 1)
                out.push({
                    label: (label.textContent ?? '').slice(0, 12),
                    stacked: row.classList.contains('row--stack'),
                    bodyWidth,
                    controlWidth: Math.round(control.getBoundingClientRect().width),
                    used: Math.round(used)
                })
            }
        }
        return out
    })

    // 两类行都要有样本，否则断言是空循环（stack 行只在「保存路径模板」卡里）
    const stacked = rows.filter((row) => row.stacked)
    const inline = rows.filter((row) => !row.stacked)
    expect(inline.length).toBeGreaterThanOrEqual(6)
    expect(stacked.length).toBeGreaterThanOrEqual(2)

    for (const row of stacked) {
        // 单列行必须吃满整行（模板 / 预览曾经被「宽控件 420px」带坏）
        expect(row.controlWidth, `${row.label}（stack）应占满整行`).toBe(row.bodyWidth)
    }
    for (const row of inline) {
        // 两列行：列宽就是内容宽，没有白占（gap 取整误差允许 1px）
        expect(Math.abs(row.controlWidth - row.used), `${row.label} 控件列宽 ${row.controlWidth} ≠ 内容宽 ${row.used}`).toBeLessThanOrEqual(1)
    }
})

/**
 * 通知条不能吃掉下面的控件。
 *
 * 两端对齐把开关 / 复选框推到卡片右边缘，正好落进右下角 sonner 通知区里。
 * Firefox 158 + geckodriver 的点击拦截检查当场把「启用实验性功能」判为被
 * `li.ia-toast` 遮挡（`element ... is not clickable ... obscured by li.ia-toast`），
 * 也就是用户点同样的位置会失败——纯靠人眼看不出来，只有在通知挂着的那 3 秒里点才复现。
 *
 * 所以钉两件事：通知本体对指针透明（点击能穿到下面），关闭按钮仍然能点。
 */
test('通知条不吃点击：本体透明，关闭按钮仍可用', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#filter')
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 任何一次保存都会弹通知（覆盖式 id，同一时刻只有一条保存提示）
    await page.locator('.toggle input[type="checkbox"]').first().click()
    const toast = page.locator('.ia-toast')
    await expect(toast).toBeVisible({ timeout: 5_000 })
    // sonner 的入场位移动画是 CSS 过渡（--y 从 translateY(41px) 到 0）：
    // 采样时机稍早就会测到「还在视口外」的半路位置，所以先等 mounted，
    // 再把过渡直接快进到终点，之后再量就是稳定位置。
    await expect(toast).toHaveAttribute('data-mounted', 'true')
    await page.evaluate(() => {
        for (const element of Array.from(document.querySelectorAll('.ia-toast'))) {
            for (const animation of element.getAnimations({ subtree: true })) animation.finish()
        }
    })

    const hit = await page.evaluate(() => {
        const element = document.querySelector('.ia-toast')
        if (!element) return { insideToast: null, text: 'no-toast' }
        const rect = element.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2
        const atCenter = document.elementFromPoint(centerX, centerY)
        const box = `center=${Math.round(centerX)},${Math.round(centerY)} rect=${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)} viewport=${window.innerWidth}x${window.innerHeight}`
        if (!atCenter) return { insideToast: null, text: `nothing-at-point ${box}` }
        return {
            insideToast: element.contains(atCenter),
            text: `hit=${atCenter.tagName.toLowerCase()}.${atCenter.className} ${box}`
        }
    })
    // 命中点必须解析成通知之外的元素，否则就是「通知把下面挡住了」
    expect(hit.insideToast, hit.text).toBe(false)

    // 但关闭按钮要接回来：点了它通知真的消失
    await toast.locator('[data-close-button]').click()
    await expect(toast).toHaveCount(0, { timeout: 5_000 })

    // 还原开关，避免污染后面的用例
    await page.locator('.toggle input[type="checkbox"]').first().click()
    await expect(page.locator('[data-testid="save-toast"]')).toBeVisible({ timeout: 5_000 })
})

test('任务页签空态文案（队列 storage 为空）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#tasks')
    await expect(page.locator('nav.tabs')).toBeVisible()
    await expect(page.locator('section.card')).toContainText('暂无任务', { timeout: 10_000 })
})

/**
 * 好友页两个「静默错」的守门用例。
 *
 * 1. 条件文案里的 `{days}` 必须被真实替换：i18next 对未提供的占位符**原样保留**，
 *    漏传参数时界面会显示字面的「对方 {days} 天内活跃过」——不报错，只是很怪，
 *    所以只能由 UI 断言来守。
 * 2. 默认没有任何条件时，执行按钮必须置灰并说明原因：
 *    旧默认值是 `['always']`，等于新装用户点一次就通过所有好友请求。
 */
test('好友页：条件文案插值正确 + 空条件时执行按钮置灰', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#friends')
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 先把条件清空，确保测的是默认/空态而不是上一次用例留下的配置
    await page.evaluate(async () => {
        const stored = (await browser.storage.local.get('config'))['config'] ?? {}
        await browser.storage.local.set({ config: { ...stored, friendRequestApprovalConditions: [] } })
    })
    await page.reload()
    await expect(page.locator('nav.tabs')).toBeVisible()

    const list = page.locator('.check-list')
    await expect(list).toContainText('天内活跃过')
    await expect(list).toContainText('注册满')
    // 关键断言：三语文案里的占位符不能被字面渲染出来
    await expect(list).not.toContainText('{days}')

    await expect(page.locator('.note', { hasText: '尚未勾选任何条件' })).toHaveCount(1)
    const runButton = page.locator('[data-testid="friend-approve-run"]')
    await expect(runButton).toBeDisabled()

    // 勾一个条件后必须恢复可用（证明置灰只由「条件为空」驱动）
    await list.locator('.check-row', { hasText: '对方已关注我' }).locator('input[type="checkbox"]').check()
    await expect(runButton).toBeEnabled()
})

/**
 * 好友审批的两种非运行态。
 *
 * 「运行中」这一态**无法在这里伪造**——这正是新设计的安全性：`running` 只来自后台内存里的
 * 任务对象，存储里写 `running: true` 不会让界面相信它在跑。所以：
 * 1. 进度条/百分比/中断提示的分支全部由单测覆盖（`friendApproveView`）；
 * 2. 这里只验两件端到端的事：
 *    - 空闲时**不显示**进度条且按钮可用；
 *    - 存储里留着 `running: true` 的残骸（真实场景：审批中进程被回收）时，
 *      界面必须判定为「已中断」而不是永远转圈。
 *
 * 后者是这次重构要消灭的 bug：残骸写在 `storage.local` 里时，界面会永远显示
 * 「审批中 X/Y」、按钮永远禁用，只能手动清存储才恢复。
 */
test('好友页：空闲不显示进度条；运行残骸被判为「已中断」而不是永远转圈', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#friends')
    await expect(page.locator('nav.tabs')).toBeVisible()

    const progressBar = page.locator('[data-testid="friend-approve-progress"]')
    // 按钮文案在运行中会变成「审批中…」，只能用 testid 定位
    const runButton = page.locator('[data-testid="friend-approve-run"]')
    const resultBox = page.locator('[data-testid="friend-approve-result"]')

    // 前置：保证有至少一个条件，否则按钮会因为「空条件」而置灰，测不出运行态差异
    await page.evaluate(async () => {
        const stored = (await browser.storage.local.get('config'))['config'] ?? {}
        await browser.storage.local.set({ config: { ...stored, friendRequestApprovalConditions: ['followedBy'] } })
        // 快照在 storage.session（会话级易失），先清干净
        await browser.storage.session.remove('friendApproveProgress')
    })
    await page.reload()
    await expect(page.locator('nav.tabs')).toBeVisible()
    await expect(progressBar).toHaveCount(0)
    await expect(runButton).toBeEnabled()

    // 残骸：上次跑到 37/100 就被回收了
    await page.evaluate(async () => {
        await browser.storage.session.set({
            friendApproveProgress: { running: true, phase: 'deciding', done: 37, total: 100, approved: 20, skipped: 17, failed: 0, startedAt: Date.now() - 60_000, finishedAt: 0, updatedAt: Date.now() - 5_000 }
        })
    })
    await page.reload()
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 必须收敛成「已中断」：进度条消失、按钮恢复、并把原因说清楚
    await expect(page.locator('.note', { hasText: '上次审批在运行中被中断' })).toHaveCount(1)
    await expect(progressBar).toHaveCount(0)
    await expect(runButton).toBeEnabled()
    // 中断没有结果可言，不能凭空显示一个「批准 0 / 跳过 0」
    await expect(resultBox).toHaveCount(0)

    // 界面不该因此显示任何假的百分比
    expect(await page.locator('[role="progressbar"]').count()).toBe(0)
})

test('高级页：关注扩展作者默认开启，且未登录时不写状态（零请求路径）', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#advanced')
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 默认开启（与源项目的 DEFAULT_CONFIG 一致）：开关必须在「扩展行为」区块且已勾选
    const promoteRow = page.locator('.row', { hasText: '关注扩展作者' })
    await expect(promoteRow).toHaveCount(1)
    await expect(promoteRow.locator('input[type="checkbox"]')).toBeChecked()

    // e2e profile 没有登录态：background 的 promoteAuthor 必须在**打接口之前**返回，
    // 因此不应留下任何状态（一旦这里出现 lastAttemptAt，说明闸门写错了，
    // 而未登录用户每次 SW 唤醒都会白打一次站点 API）
    const state = await page.evaluate(async () => (await browser.storage.local.get('promoteAuthorState'))['promoteAuthorState'])
    expect(state).toBeUndefined()
})

test('引导页：权限诊断（无授权按钮）+ 钓鱼防护说明', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#guide')
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 按**标题**定位区块：正文里也会提到这些词，用 hasText 过滤整张卡片会匹配到两张。
    const section = (title: string) => page.locator('section.card').filter({ has: page.locator('h2', { hasText: title }) })

    // ① 站点访问权限：只诊断。required host 权限无法 permissions.request，
    //    所以这里**不允许**出现任何按钮——出现按钮就是把用户带进死胡同。
    const accessSection = section('站点访问权限')
    await expect(accessSection).toHaveCount(1)
    await expect(accessSection.locator('.status-line .badge')).not.toHaveText('检测中', { timeout: 10_000 })
    await expect(accessSection.locator('.status-line .badge')).toHaveText(/已获得全站访问权限|全站访问权限已被撤销/)
    await expect(accessSection.locator('.status-line button')).toHaveCount(0)

    // ② 钓鱼仿冒防护：说明必须把真实域名清单列出来（不是泛泛而谈）
    const guardSection = section('钓鱼仿冒站点防护')
    await expect(guardSection).toHaveCount(1)
    for (const domain of ['iwara.tv', 'iwara.zip', 'iwara.shop', 'iwara.ai']) {
        await expect(guardSection).toContainText(domain)
    }

    // ③ 关于：版本号如实来自 manifest（页面不再内置更新日志，但版本仍要可见）
    const version = await page.evaluate(() => browser.runtime.getManifest().version)
    await expect(section('关于')).toContainText(version)

    // ④ 更新日志已从代码里移除（维护成本随版本线性增长），不应再出现该区块
    await expect(section('更新日志')).toHaveCount(0)
})

test('任务页签：待办优先排序 / 分组筛选 / 每行语义化主操作', async ({ sharedSession }) => {
    const { page, extensionId } = sharedSession
    await openExtensionPage(page, extensionId, 'options/index.html#tasks')
    await expect(page.locator('nav.tabs')).toBeVisible()

    // 直接播种（真实链路由 runDownload 写入；这里只验视图与筛选逻辑）
    const now = Date.now()
    await page.evaluate(async (ts) => {
        await browser.storage.local.set({
            downloadQueue: [
                { id: 'e2e-done', videoId: 'doneVideo', kind: 'browser', status: 'complete', createdAt: ts - 60_000, updatedAt: ts - 50_000 },
                { id: 'e2e-fail', videoId: 'failVideo', kind: 'browser', status: 'failed', detail: 'HTTP 404 Not Found', attempts: 2, createdAt: ts - 30_000, updatedAt: ts - 20_000 },
                { id: 'e2e-run', videoId: 'runVideo', kind: 'aria2', status: 'running', createdAt: ts - 10_000, updatedAt: ts - 1_000 },
                // 跳过任务：主操作必须是「打开视频页」+ 次操作「强制下载」，绝不能出现「重试」
                {
                    id: 'e2e-skip',
                    videoId: 'skipVideo',
                    kind: 'browser',
                    status: 'skipped',
                    detail: '简介/评论里有第三方网盘链接，已跳过下载',
                    followUpUrl: 'https://www.iwara.tv/video/skipVideo',
                    createdAt: ts - 8_000,
                    updatedAt: ts - 5_000
                },
                // 已交付（Others 通道）：终态但**不是**完成，可移除、可重试
                {
                    id: 'e2e-hand',
                    videoId: 'handVideo',
                    kind: 'others',
                    status: 'handed-off',
                    detail: '已交给外部下载器（后台标签页打开直链）；扩展看不到结果',
                    kindRef: '42',
                    createdAt: ts - 4_000,
                    updatedAt: ts - 2_000
                }
            ]
        })
    }, now)

    const rows = page.locator('table.tasks tbody tr')
    await expect(rows).toHaveCount(5, { timeout: 10_000 })

    // 排序主轴是分组：需要处理（跳过/失败，组内最近更新优先）→ 进行中 → 已完成
    await expect(rows.nth(0)).toContainText('skipVideo')
    await expect(rows.nth(1)).toContainText('failVideo')
    await expect(rows.nth(2)).toContainText('runVideo')
    await expect(rows.nth(3)).toContainText('handVideo')
    await expect(rows.nth(4)).toContainText('doneVideo')

    // 状态胶囊（skipped / handed-off 都有专属文案与配色，不当成失败也不当成完成）
    await expect(page.locator('.pill-skipped')).toHaveCount(1)
    await expect(page.locator('.pill-handed-off')).toHaveCount(1)
    await expect(page.locator('.pill-running')).toHaveCount(1)
    await expect(page.locator('.pill-failed')).toHaveCount(1)
    await expect(page.locator('.pill-complete')).toHaveCount(1)

    // 已交付行：必须显示「交给谁了」（否则用户会以为文件已经在本地），且可移除
    await expect(rows.nth(3)).toContainText('已交给外部下载器')
    await expect(rows.nth(3).locator('button').nth(1)).toBeEnabled()

    // 待办告警条：通知叫不住的人，打开这一页就能知道「有事等你」
    await expect(page.locator('.queue-alert')).toContainText('需要你处理')

    // 失败原因可见（默认折叠为 2 行，title 持有完整文本）
    await expect(page.locator('.error-text.clamped')).toContainText('HTTP 404')

    // 跳过行：主操作「打开视频页」+ 次操作「强制下载」+ 移除 = 3 颗，且**没有**重试
    const skipButtons = rows.nth(0).locator('button')
    await expect(skipButtons).toHaveCount(3)
    await expect(skipButtons.nth(0)).toHaveText('打开视频页')
    await expect(skipButtons.nth(1)).toHaveText('强制下载')
    await expect(skipButtons.nth(2)).toHaveText('移除')
    await expect(rows.nth(0).locator('button', { hasText: '重试' })).toHaveCount(0)

    // running 行：重试仍然置灰（正在跑，重试没有意义），但**移除可用**——
    // 后台会先取消下载器再删记录，所以按钮不能一刀切禁掉
    const runButtons = rows.nth(2).locator('button')
    await expect(runButtons.nth(0)).toBeDisabled()
    await expect(runButtons.nth(1)).toBeEnabled()
    await expect(runButtons.nth(1)).toHaveText('移除')
    // 失败行可重试；完成行可移除
    await expect(rows.nth(1).locator('button').nth(0)).toHaveText('重试')
    await expect(rows.nth(1).locator('button').nth(0)).toBeEnabled()
    await expect(rows.nth(4).locator('button').nth(1)).toBeEnabled()

    // 筛选「需要处理」= 跳过 + 失败（两件要用户决策的事）
    await page.locator('.queue-filters button:has-text("需要处理")').click()
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('skipVideo')
    await expect(rows.nth(1)).toContainText('failVideo')

    // 筛选「进行中」只剩下载中的那条
    await page.locator('.queue-filters button:has-text("进行中")').click()
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0)).toContainText('runVideo')

    // 筛选「已完成」= complete + handed-off（活已经交出去，扩展这边没有待办）
    await page.locator('.queue-filters button:has-text("已完成")').click()
    await expect(rows).toHaveCount(2)

    // 全部再回到五行
    await page.locator('.queue-filters button:has-text("全部")').click()
    await expect(rows).toHaveCount(5)

    // 下载中的任务可以移除，但要二次确认（后台会真的取消下载，不可撤销）。
    // 这里只验 UI 契约：第一次点击变确认态、**不删**。
    // 真正的删除走后台（`messaging.spec.ts` 用 INIT_DOWNLOAD 造真实任务覆盖）——
    // 本用例的队列是直接写 storage 播种的，后台内存副本里没有这些任务。
    const runningRemove = rows.nth(2).locator('button').nth(1)
    await runningRemove.click()
    await expect(runningRemove).toHaveText('确认取消？')
    await expect(rows).toHaveCount(5)

    // 清理（后台是唯一写者，这里仅在测试收尾直接清 storage）
    await page.evaluate(async () => {
        await browser.storage.local.set({ downloadQueue: [] })
    })
})

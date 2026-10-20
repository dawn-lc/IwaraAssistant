/**
 * 真实站点冒烟（iwara.tv）—— 显式开关，不进常规套件与 CI
 *
 * 运行：
 *   npm run test:e2e:wdio:live            # Chrome + Firefox
 *   npm run test:e2e:wdio:live:chrome     # 仅 Chrome
 *   npm run test:e2e:wdio:live:firefox    # 仅 Firefox
 *   E2E_HUMAN=1 npm run test:e2e:wdio:live  # 人在回路：挑战手工点选
 *
 * 环境变量：
 *   E2E_LIVE=1         总开关（由 npm script 设置）
 *   E2E_SITE_URL       目标站点（默认 https://www.iwara.tv，可指向自建反代）
 *   E2E_HUMAN=1        人在回路（挑战页等待人工点选，预算 E2E_HUMAN_TIMEOUT）
 *   E2E_HEADLESS=1     无头（真实站点不建议，风控更敏感）
 *
 * 设计约束（对齐源用户脚本项目 IwaraDownloadTool 的 e2e 策略）：
 * - **单会话 + 串行 + 单标签**：整包只在 before 里加载一次列表页，之后站内导航；
 *   反复冷启动/反复加载首页是 Cloudflare 拦截的最大诱因。
 * - **零副作用**：只做 UI 级交互（选择模式/全选/反选/清空/手动框开合），
 *   绝不点「下载选中」「下载当前」「从播放列表移除」——那些会真的发请求/建任务。
 * - **挑战不当缺陷**：检测到 Cloudflare 挑战即 skip 整套并打印原因；
 *   只有「挑战已过但注入没生效」才是真失败。
 * - **状态驱动**：所有等待都是 DOM 条件轮询，没有固定 sleep。
 *
 * 覆盖不到的（有意不测，属别的层）：
 * - 真实下载链路（需要 aria2 实例 + 账号）
 * - 自动关注/点赞/好友审批（需要登录态，且会修改账号数据）
 * - MAIN 世界对 `/videos` 响应体的改写结果（需要账号缓存窗口比对）
 *   这里只验「MAIN 已握手」的 DOM 标记，不验改写内容。
 */
import { browser, expect } from '@wdio/globals'
import { ensureExtensionSession, type ExtensionSession } from '../helpers/extension'
import { clickMenuAction, humanModeEnabled, isMenuExpanded, liveEnabled, liveUrl, menuActions, openMenu, readCheckboxContract, readMenuContract, snapshotPage, waitForChallengeCleared, waitForInjection, withDiagnostics } from '../helpers/live'

/** 列表页路径（卡片注入的验收面） */
const LIST_PATH = process.env.E2E_LIVE_LIST_PATH?.trim() || '/videos'

describe('Iwara Assistant 真实站点冒烟（iwara.tv）', () => {
    let session: ExtensionSession
    /** 首个卡片详情页 URL（从列表页 DOM 读，不硬编码视频 ID） */
    let detailUrl: string | null = null

    before(async function (this: Mocha.Context) {
        if (!liveEnabled()) {
            this.skip()
            return
        }

        session = await ensureExtensionSession(browser)
        expect(session.browserName).toBe(browser.capabilities.browserName)
        console.log(`[live] 宿主 ${session.browserName}，站点 ${liveUrl(LIST_PATH)}`)

        await browser.url(liveUrl(LIST_PATH))

        // 风控闸门：挑战未过 → 整套 skip（不把风控当产品缺陷）
        const gate = await waitForChallengeCleared(browser)
        if (gate.state !== 'none') {
            console.warn(`[live] 站点处于 Cloudflare 挑战（${gate.state}），跳过整套。` + ` 若需人工过盾请用 E2E_HUMAN=1 重跑。现场：url=${gate.snapshot.url} title=${JSON.stringify(gate.snapshot.title)}`)
            this.skip()
            return
        }

        // 首载注入：等菜单 + 至少一张卡片 + 至少一个复选框（注入有 300ms 防抖）
        const injected = await waitForInjection(browser, { minCards: 1, minCheckboxes: 1 })
        console.log(`[live] 首载注入完成：bridge=${injected.bridge} cards=${injected.cards} checkboxes=${injected.checkboxes}`)
        if (injected.bridge !== 'ready') {
            console.warn(`[live] 握手标记为 ${JSON.stringify(injected.bridge)}（期望 ready）——细节见首个用例`)
        }

        // 从卡片读取详情页链接（站点 DOM 变了就退化为「不测详情页」，不连坐列表页用例）
        detailUrl = (await browser.execute(() => {
            const link = document.querySelector<HTMLAnchorElement>('.videoTeaser a[href*="/video/"]')
            if (!link) return null
            try {
                return new URL(link.href, location.origin).href
            } catch {
                return null
            }
        })) as string | null
        console.log(`[live] 详情页样本：${detailUrl ?? '（列表页未找到卡片链接，将跳过详情页用例）'}`)
    })

    it('列表页：ISOLATED 桥与 MAIN 世界握手完成（data-ia-bridge=ready）', async () => {
        await withDiagnostics(browser, '握手标记断言', async () => {
            const snapshot = await snapshotPage(browser)
            expect(snapshot.bridge).toBe('ready')
        })
    })

    it('列表页：注入发生在 document-start（data-ia-early 证明 body 尚未存在）', async () => {
        await withDiagnostics(browser, 'document-start 时机断言', async () => {
            const snapshot = await snapshotPage(browser)
            expect(snapshot.early).toBeTruthy()

            // 形如 body=0;head=0;elements=3
            const parsed = Object.fromEntries(
                (snapshot.early ?? '').split(';').map((part) => {
                    const [key, value] = part.split('=')
                    return [key ?? '', Number(value)]
                })
            ) as Record<string, number>

            // 关键断言：content script 执行那一刻 body 还不存在 —— 这就是 document-start
            expect(parsed['body']).toBe(0)
            // 那一刻 documentElement 还是空的（真实站点实测 elements=0，说明连页面
            // 第一个节点都还没解析出来）。给一点余量：某些页面可能已插入 charset meta。
            expect(parsed['elements']).toBeLessThanOrEqual(3)
        })
    })

    it('列表页：fetch 劫持在页面任何脚本运行前安装（data-ia-hook: loading + body 不存在）', async () => {
        await withDiagnostics(browser, 'fetch 劫持时机断言', async () => {
            const snapshot = await snapshotPage(browser)
            expect(snapshot.hook).toBeTruthy()

            const parsed = Object.fromEntries(
                (snapshot.hook ?? '').split(';').map((part) => {
                    const [key, value] = part.split('=')
                    return [key ?? '', value ?? '']
                })
            ) as Record<string, string>

            // 钩子安装时文档仍在解析（页面首个 <script> 尚未执行）
            expect(parsed['readyState']).toBe('loading')
            // 且 body 还不存在（document_start 的客观标志）
            expect(parsed['body']).toBe('0')

            // 且此时页面上**不存在**任何可用于劫持我们控制流的全局入口。
            // 安全回归红线：曾把 { nativeFetch, queue, install } 挂在
            // window.__iwaraAssistantFetchHook 上，任何页面脚本都可调 install()
            // 在接管后替换掉我们的 handler（等价于 MITM 全部页面请求）。
            const globals = (await browser.execute(() => {
                const bag = window as unknown as Record<string, unknown>
                const suspicious = Object.keys(bag).filter((key) => key.startsWith('__iwara') || key.startsWith('__ia') || key === 'iwaraAssistant')
                return { suspicious, fetchIsFunction: typeof window.fetch === 'function' }
            })) as { suspicious: string[]; fetchIsFunction: boolean }
            expect(globals.suspicious).toEqual([])
            expect(globals.fetchIsFunction).toBe(true)
        })
    })

    it('列表页：菜单与样式注入，卡片复选框数量与卡片一致', async () => {
        await withDiagnostics(browser, '卡片注入断言', async () => {
            // 卡片可能随 SPA 渲染继续追加，等到「复选框数 == 卡片数」再断言
            await browser.waitUntil(
                async () => {
                    const current = await snapshotPage(browser)
                    return current.cards > 0 && current.checkboxes === current.cards
                },
                {
                    timeout: 60_000,
                    interval: 300,
                    timeoutMsg: '卡片复选框未在超时内与卡片数对齐（可能是 a.videoTeaser__thumbnail 选择器失配）'
                }
            )
            const snapshot = await snapshotPage(browser)
            expect(snapshot.hasMenu).toBe(true)
            expect(snapshot.hasStyle).toBe(true)
            expect(snapshot.cards).toBeGreaterThan(0)
            // 默认 autoInjectCheckbox=true：每张卡片一个复选框
            expect(snapshot.checkboxes).toBe(snapshot.cards)
        })
    })

    it('列表页：复选框契约对齐源项目（.selectButton / 38×38 右上 / videoID / 主题色）', async () => {
        await withDiagnostics(browser, '复选框契约断言', async () => {
            const contract = await readCheckboxContract(browser)

            // 类名与属性契约（源 ui/widgets/checkbox.ts）
            expect(contract.className).toBe('selectButton')
            expect(contract.videoId).toBeTruthy()
            expect(contract.videoName).toBeTruthy()
            expect(contract.videoAuthor).toBeTruthy()
            // 插入点：缩略图父元素（.videoTeaser）末尾，且该容器 relative
            expect(contract.isLastChildOfHost).toBe(true)
            expect(contract.hostClass).toContain('videoTeaser')
            expect(contract.hostPosition).toBe('relative')

            // 样式契约（源 css/videoCard.css 的 .selectButton）
            expect(contract.computed.position).toBe('absolute')
            expect(contract.computed.width).toBe('38px')
            expect(contract.computed.height).toBe('38px')
            expect(contract.computed.right).toBe('0px')
            expect(contract.computed.top).toBe('22px')
            expect(contract.computed.zIndex).toBe('100')
            expect(contract.computed.cursor).toBe('pointer')
            // accent-color 跟随站点主题变量，而不是硬编码色
            expect(contract.themePrimaryAccent).not.toBe('')
            expect(contract.computed.accentColor).toBe(contract.themePrimaryAccent)
        })
    })

    it('列表页：卡片元数据回填（videoUploadTime 来自后台视频库）', async () => {
        await withDiagnostics(browser, '卡片元数据断言', async () => {
            // 链路：页面 fetch 被 MAIN 拦截 → INGEST 入库（后台 IndexedDB）
            //      → 页内 GET_CARD_META 批量查询 → 写回 checkbox[videoUploadTime]。
            // 断言「至少一张卡片拿到了绝对上传时间」即可证明整条链路通了；
            // 具体数值取决于库里已有记录，不做值断言。
            let count = 0
            await browser.waitUntil(
                async () => {
                    count = (await browser.execute(() => document.querySelectorAll('input.selectButton[videoUploadTime]').length)) as number
                    return count > 0
                },
                {
                    timeout: 60_000,
                    interval: 500,
                    timeoutMsg: '没有任何卡片拿到 videoUploadTime（入库或 GET_CARD_META 链路可能断开）'
                }
            )
            expect(count).toBeGreaterThan(0)
        })
    })

    it('列表页：hover 展开接线（mouseover 加 expanded / mouseout 后收起）', async () => {
        await withDiagnostics(browser, 'hover 接线断言', async () => {
            // 整条序列在同一次执行里完成：跨 execute 派发时浏览器可能补发
            // 额外 mouseover 清掉收起定时器（Firefox 实测），那样断言不稳定。
            const result = (await browser.execute(async () => {
                const menu = document.getElementById('pluginMenu')
                if (!menu) return { missing: true }

                menu.classList.remove('expanded')
                const initial = menu.classList.contains('expanded')

                menu.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
                const afterOver = menu.classList.contains('expanded')

                menu.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
                const rightAfterOut = menu.classList.contains('expanded')

                // 源 ui/menu.ts 桌面分支：mouseout 后 300ms 移除 expanded
                await new Promise((resolve) => setTimeout(resolve, 700))
                const afterDelay = menu.classList.contains('expanded')

                return { missing: false, initial, afterOver, rightAfterOut, afterDelay }
            })) as {
                missing: boolean
                initial?: boolean
                afterOver?: boolean
                rightAfterOut?: boolean
                afterDelay?: boolean
            }

            expect(result.missing).toBe(false)
            expect(result.initial).toBe(false)
            expect(result.afterOver).toBe(true)
            // mouseout 当帧仍展开（收起是延迟的）
            expect(result.rightAfterOut).toBe(true)
            // 300ms 后收起
            expect(result.afterDelay).toBe(false)
        })
    })

    it('列表页：悬浮菜单可展开且菜单项为源项目子集（无导出/导入/设置）', async () => {
        await withDiagnostics(browser, '菜单项断言', async () => {
            await openMenu(browser)
            const actions = await menuActions(browser)
            // 源 ui/menu.ts 列表页顺序：injectCheckbox → deselectAll → reverseSelect →
            // selectThis → deselectThis → downloadSelected → manualDownload
            // （exportConfig / importConfig / settings 已从页内菜单移除：低频运维与导航入口
            //   归 options「迁移」页签与工具栏弹窗）
            expect(actions).toEqual(['select-toggle', 'clear-selection', 'invert-selection', 'select-all', 'deselect-page', 'batch-download', 'manual-download'])
        })
    })

    it('列表页：菜单与水印契约对齐源项目（#pluginMenu 右侧中部 + 主题变量 + 水印计数）', async () => {
        await withDiagnostics(browser, '菜单/水印契约断言', async () => {
            const contract = await readMenuContract(browser)

            // 菜单结构（源 ui/menu.ts：div#pluginMenu > ul > li）
            expect(contract.menuId).toBe('pluginMenu')
            expect(contract.hasList).toBe(true)
            expect(contract.itemTagNames.every((tag) => tag === 'LI')).toBe(true)
            // 定位（源 menu.css：right:0 + top:50% + translate(calc(100% - 26px))）
            expect(contract.menu.position).toBe('fixed')
            expect(contract.menu.right).toBe('0px')
            expect(contract.menu.backgroundColor).toBe(contract.themeBodyDark)
            expect(contract.menu.color).not.toBe('')

            // 水印（源 ui/widgets/watermark.ts + .fixed-bottom-right）
            expect(contract.watermark.className).toBe('fixed-bottom-right')
            expect(contract.watermark.text).toContain('Iwara Assistant')
            expect(contract.watermark.text).toContain(contract.version)
            expect(contract.watermark.text).toContain('已选中')
            // 水印主题色跟随站点变量
            expect(contract.watermark.backgroundColor).toBe(contract.themeBody)
            expect(contract.watermark.color).toBe(contract.themeText)
        })
    })

    it('列表页：全选 → 反选 → 清空的选择态闭环', async () => {
        await withDiagnostics(browser, '选择态闭环', async () => {
            await clickMenuAction(browser, 'select-all')
            await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll<HTMLInputElement>('input.selectButton:checked').length)) > 0, { timeout: 15_000, interval: 300, timeoutMsg: '全选后没有任何复选框被勾选' })
            const selectedAll = (await browser.execute(() => document.querySelectorAll<HTMLInputElement>('input.selectButton:checked').length)) as number

            await clickMenuAction(browser, 'invert-selection')
            const afterInvert = (await browser.execute(() => document.querySelectorAll<HTMLInputElement>('input.selectButton:checked').length)) as number
            // 反选后：页内卡片全被选中过，反选结果应为「卡片总数 - 已选」
            const total = (await browser.execute(() => document.querySelectorAll('.videoTeaser').length)) as number
            expect(afterInvert).toBe(total - selectedAll)

            await clickMenuAction(browser, 'clear-selection')
            await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll<HTMLInputElement>('input.selectButton:checked').length)) === 0, { timeout: 15_000, interval: 300, timeoutMsg: '清空后仍有复选框保持勾选' })
        })
    })

    it('列表页：手动下载对话框可打开并可取消关闭', async () => {
        await withDiagnostics(browser, '手动下载对话框', async () => {
            await clickMenuAction(browser, 'manual-download')
            await browser.waitUntil(async () => (await browser.execute(() => document.getElementById('pluginOverlay') !== null)) === true, { timeout: 10_000, interval: 200, timeoutMsg: '点击「手动下载」后未创建 #pluginOverlay' })
            const state = (await browser.execute(() => {
                const overlay = document.getElementById('pluginOverlay')
                if (!overlay) return null
                const style = getComputedStyle(overlay)
                const rect = overlay.getBoundingClientRect()
                return {
                    display: style.display,
                    visibility: style.visibility,
                    opacity: style.opacity,
                    width: rect.width,
                    height: rect.height,
                    hasMain: overlay.querySelector('.main') !== null,
                    hasTextarea: overlay.querySelector('.main textarea') !== null,
                    hasCancel: overlay.querySelector('.ia-actions button.ia-ghost') !== null
                }
            })) as Record<string, unknown> | null
            expect(state).not.toBeNull()
            expect(state!['hasMain']).toBe(true)
            expect(state!['hasTextarea']).toBe(true)
            expect(state!['hasCancel']).toBe(true)

            // 取消关闭（真实点击）
            const cancel = await browser.$('#pluginOverlay .ia-actions button.ia-ghost')
            await cancel.click()
            await browser.waitUntil(async () => (await browser.execute(() => document.getElementById('pluginOverlay') === null)) === true, { timeout: 10_000, interval: 200, timeoutMsg: '点击取消后 #pluginOverlay 未移除' })
        })
    })

    it('详情页：菜单出现「下载当前视频」且不含播放列表移除', async function (this: Mocha.Context) {
        if (!detailUrl) {
            this.skip()
            return
        }
        await browser.url(detailUrl)
        const gate = await waitForChallengeCleared(browser, { timeoutMs: 30_000 })
        if (gate.state !== 'none') {
            console.warn(`[live] 详情页进入挑战（${gate.state}），跳过该用例`)
            this.skip()
            return
        }

        await withDiagnostics(browser, '详情页注入断言', async () => {
            await waitForInjection(browser)
            await openMenu(browser)
            const actions = await menuActions(browser)
            expect(actions).toContain('download-current')
            expect(actions).not.toContain('remove-playlist')
            const snapshot = await snapshotPage(browser)
            expect(snapshot.bridge).toBe('ready')
        })
    })

    it('站内 SPA 导航：点卡片进入详情页后菜单重建（无整页重载）', async function (this: Mocha.Context) {
        if (!detailUrl) {
            this.skip()
            return
        }

        // 先回到列表页（完整重载一次，作为 SPA 起点）
        await browser.url(liveUrl(LIST_PATH))
        const gate = await waitForChallengeCleared(browser, { timeoutMs: 30_000 })
        if (gate.state !== 'none') {
            console.warn(`[live] 返回列表页进入挑战（${gate.state}），跳过该用例`)
            this.skip()
            return
        }
        await waitForInjection(browser, { minCards: 1, minCheckboxes: 1 })

        // 打一个窗口标记：pushState 导航不会丢掉它，整页重载会
        await browser.execute(() => {
            ;(window as unknown as Record<string, unknown>)['__iaSpaMarker'] = 'keep'
        })

        await withDiagnostics(browser, 'SPA 导航断言', async () => {
            // 每张卡片有缩略图与标题两个链接 → 严格选择器要显式取第一个
            const links = await browser.$$('.videoTeaser a[href*="/video/"]')
            const card = links[0]
            if (!card) throw new Error('列表页未找到可点击的卡片链接')
            await card.waitForClickable({ timeout: 15_000 })
            await card.click()

            await browser.waitUntil(async () => (await browser.execute(() => location.pathname.startsWith('/video/'))) === true, { timeout: 30_000, interval: 300, timeoutMsg: '点击卡片后未进入详情页（可能被新标签页打开）' })

            // 菜单由路由重建（注入有 300ms 防抖）：等到出现「下载当前视频」
            await browser.waitUntil(async () => (await menuActions(browser)).includes('download-current'), { timeout: 30_000, interval: 300, timeoutMsg: 'SPA 导航后菜单未重建为详情页形态' })
            await openMenu(browser)
            const actions = await menuActions(browser)
            expect(actions).toContain('download-current')
            expect(actions).not.toContain('remove-playlist')

            // 无整页重载：窗口标记仍在，且握手标记无需重建即就绪
            const marker = await browser.execute(() => (window as unknown as Record<string, unknown>)['__iaSpaMarker'] ?? null)
            expect(marker).toBe('keep')
            const snapshot = await snapshotPage(browser)
            expect(snapshot.bridge).toBe('ready')
        })
    })

    afterEach(async function (this: Mocha.Context) {
        // 失败时补一份现场（成功用例不打印，避免噪声）
        if (this.currentTest?.state === 'failed') {
            await withDiagnostics(browser, `用例失败：${this.currentTest.title}`, async () => undefined)
        }
        if (humanModeEnabled()) {
            const seconds = Number(process.env.E2E_HUMAN_PAUSE ?? 3)
            console.log(`[live] 人在模式：暂停 ${seconds}s 供目视检查`)
            await browser.pause(seconds * 1000)
        }
    })
})

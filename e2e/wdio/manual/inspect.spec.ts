/**
 * 手动验收模式（`E2E_MANUAL=1`）—— 一条命令部署好，然后交给人
 *
 * 运行：
 *   npm run test:e2e:manual            # Chrome（默认）
 *   npm run test:e2e:manual:firefox    # Firefox
 *
 * 它**不做任何断言**：唯一目的是把扩展装进真实浏览器、打开起始页，然后就等着。
 * 用例永远通过（除非扩展装不上或页面打不开——那说明部署本身坏了，值得红）。
 *
 * 与自动套件的分工：
 * - 自动套件回答「代码是否符合预期」→ 断言
 * - 手动模式回答「人用起来对不对」→ 不设预期，交给人看
 *
 * 为什么需要它：系统通知的点击行为、真实账号下的下载/关注、Cloudflare 过盾、
 * 扩展权限被撤销后的界面表现——这些要么自动化成本极高，要么只能人眼验收。
 * 之前每次手动验收都要自己启动浏览器 + 侧载 dist，既慢又容易忘构建。
 */
import { browser } from '@wdio/globals'
import { ensureExtensionSession } from '../helpers/extension'
import { exitManualSessionCleanly, manualEnabled, manualStartUrl, manualTimeoutMs, printManualBanner, waitForManualEnd } from '../helpers/manual'

describe('手动验收模式', () => {
    it('部署扩展并等待人工操作', async function (this: Mocha.Context) {
        // 常规套件与 CI 不会收集本文件（wdio.conf.ts 按 E2E_MANUAL 切 specs 目录），
        // 这里的 skip 只是防止有人手工指定 spec 路径时误跑
        if (!manualEnabled()) {
            this.skip()
            return
        }

        // mocha 自己的超时要覆盖配置值：用户可能改 E2E_MANUAL_TIMEOUT 而不重跑配置
        this.timeout(manualTimeoutMs() + 120_000)

        const session = await ensureExtensionSession(browser)
        const startUrl = manualStartUrl(session)

        // 先导航再报「就绪」：报完 banner 就一定是页面已经在那里了
        await browser.url(startUrl)
        printManualBanner({ browserName: session.browserName, extensionId: session.extensionId, startUrl, session, timeoutMs: manualTimeoutMs() })

        const reason = await waitForManualEnd(browser, { timeoutMs: manualTimeoutMs() })
        // 用户关浏览器 = 验收结束。会话已经不在了，直接正常退出（详见 helper 注释）
        if (reason === 'browser-closed') exitManualSessionCleanly()
        console.log('[manual] 到达时间预算，自动结束')
    })
})

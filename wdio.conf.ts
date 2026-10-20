/**
 * WebdriverIO 配置 —— 跨浏览器扩展 e2e（Chrome + Firefox 同构用例）
 *
 * 与 Playwright 侧分工：
 * - Playwright（playwright.config.ts）：Chromium 操作级 e2e（甜点区，10 用例）
 * - WDIO（本配置）：同一份 spec 在 Chrome + Firefox 各跑一遍，补齐 Firefox
 *   UI 自动化盲区（GeckoDriver/WebDriver BiDi 可安装扩展并导航 moz-extension 页）
 *
 * 装载通路（详见 e2e/wdio/helpers/extension.ts）：
 * - Chrome 136+：`webExtension.install` 需
 *   `--enable-unsafe-extension-debugging --remote-debugging-pipe --user-data-dir=...`
 *   （品牌 Chrome 137+ 已移除 `--load-extension`，不能再靠启动参数侧载）
 * - Firefox：BiDi `installExtension` + geckodriver `--allow-system-access`
 *   （FF 138+ 导航 moz-extension 页必需）+ 预置固定 UUID pref
 *
 * 环境变量：
 * - `E2E_HEADLESS=1`  无头（Chrome `--headless=new` / Firefox `-headless`）
 * - `WDIO_BROWSER=chrome|firefox`  只跑单一宿主（npm scripts 已封装）
 * - `E2E_LIVE=1`  改跑真实站点冒烟（`e2e/wdio/live/`），并追加反自动化指纹参数
 * - `E2E_HUMAN=1`  人在回路（仅 live 生效；挑战页留给人工点选，超时放宽）
 * - `E2E_MANUAL=1`  手动验收（只收集 `e2e/wdio/manual/`）：装好扩展就等人，无断言；
 *   优先级高于 `E2E_LIVE`，且**忽略 `E2E_HEADLESS`**（无头没法人工操作）
 * - `E2E_SITE_URL` 目标站点（默认 https://www.iwara.tv）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@wdio/types'
import { firefoxPrefs } from './e2e/wdio/helpers/extension'
import { manualTimeoutMs } from './e2e/wdio/helpers/manual'

/** 手动验收：不做断言，只负责把扩展部署好并停在起始页 */
const manual = /^(1|true|yes)$/i.test(process.env.E2E_MANUAL?.trim() ?? '')

const headlessRequested = /^(1|true|yes)$/i.test(process.env.E2E_HEADLESS?.trim() ?? '')
// 手动模式永远有头：无头下用户看不到浏览器，也就无从「操作」
const headless = manual ? false : headlessRequested
const only = process.env.WDIO_BROWSER?.trim().toLowerCase()
const includeChrome = !only || only === 'chrome'
const includeFirefox = !only || only === 'firefox'

if (manual && headlessRequested) {
    console.warn('[manual] 手动模式忽略 E2E_HEADLESS=1：人工操作需要可见窗口')
}

/**
 * 真实站点模式（参照源用户脚本项目 IwaraDownloadTool 的 e2e 策略）：
 * - spec 只收集 `e2e/wdio/live/`，常规套件与 CI 不受影响
 * - 追加反自动化指纹参数（Cloudflare 对 `navigator.webdriver` 最敏感）
 * - 超时放宽：真实站点受网络与风控影响，且有「人工过盾」路径
 */
const live = /^(1|true|yes)$/i.test(process.env.E2E_LIVE?.trim() ?? '')
const human = live && /^(1|true|yes)$/i.test(process.env.E2E_HUMAN?.trim() ?? '')
const humanTimeoutMs = Number(process.env.E2E_HUMAN_TIMEOUT ?? 600_000)

/** 反自动化指纹参数：live / manual 追加，常规套件保持原样（便于复现问题） */
const stealth = manual || live
const LIVE_CHROME_ARGS = ['--disable-blink-features=AutomationControlled'] as const
const LIVE_FIREFOX_PREFS: Record<string, boolean | string | number> = {
    // navigator.webdriver 置 false（Firefox 靠此 pref 而非启动参数）
    'dom.webdriver.enabled': false,
    // 页面 console 打到进程 stdout：live 失败时能直接看到 MAIN 世界注入日志
    'devtools.console.stdout.content': true
}

const capabilities: WebdriverIO.Capabilities[] = []

if (includeChrome) {
    /**
     * Chrome 136+ 的 webExtension.install 要求 remote-debugging-pipe + 非默认 user-data-dir。
     *
     * 手动模式改用**固定目录**而不是 mkdtemp：登录态、站点授权、扩展配置都能跨次保留，
     * 否则每次验收都要重新登录 iwara，手动验收也就失去了意义。
     * 目录在 temp/ 下（已 gitignore），Ctrl+C 退出也不会被清理。
     * 如果提示目录被占用，说明上次的 Chrome 没退干净：删掉 `temp/manual-profile` 即可。
     */
    const chromeProfileDir = manual ? path.resolve(import.meta.dirname, process.env.E2E_MANUAL_PROFILE?.trim() || 'temp/manual-profile/chrome') : fs.mkdtempSync(path.join(os.tmpdir(), 'iwara-wdio-chrome-'))
    if (manual) fs.mkdirSync(chromeProfileDir, { recursive: true })
    capabilities.push({
        browserName: 'chrome',
        'goog:chromeOptions': {
            args: [
                '--enable-unsafe-extension-debugging',
                '--remote-debugging-pipe',
                `--user-data-dir=${chromeProfileDir}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                // 窗口被其他窗口遮挡时 Chrome 会暂停 CSS 过渡/动画（occlusion 降级），
                // 会让依赖 transition 的菜单滑入断言等到永远——测试环境必须关掉
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=CalculateNativeWinOcclusion',
                // 界面语言钉到中文：用例断言中文文案，而 i18n 默认「跟随浏览器语言」
                '--lang=zh-CN',
                ...(stealth ? [...LIVE_CHROME_ARGS] : []),
                ...(headless ? ['--headless=new'] : [])
            ]
        },
        acceptInsecureCerts: true
    })
}

if (includeFirefox) {
    capabilities.push({
        browserName: 'firefox',
        'moz:firefoxOptions': {
            prefs: { ...firefoxPrefs(), ...(stealth ? LIVE_FIREFOX_PREFS : {}) },
            ...(headless ? { args: ['-headless'] } : {})
        },
        // FF 138+ 导航 moz-extension:// 必需（WebDriver 安全限制）
        'wdio:geckodriverOptions': { allowSystemAccess: true },
        acceptInsecureCerts: true
    })
}

export const config: WebdriverIO.Config = {
    runner: 'local',
    // 三种模式互斥：手动验收 / 真实站点 / 常规扩展页，各自一套 spec 目录（互不污染）
    specs: manual ? ['./e2e/wdio/manual/**/*.spec.ts'] : live ? ['./e2e/wdio/live/**/*.spec.ts'] : ['./e2e/wdio/*.spec.ts'],
    maxInstances: 1,

    capabilities,

    logLevel: (process.env.WDIO_LOGLEVEL as Options.WebdriverIO['logLevel']) ?? 'warn',
    bail: 0,
    // 真实站点受网络与风控影响：等待窗口放宽；不设重试（重复冷启动反而加重风控）
    waitforTimeout: live || manual ? 60_000 : 15_000,
    connectionRetryTimeout: live || manual ? 180_000 : 120_000,
    connectionRetryCount: 2,
    framework: 'mocha',
    mochaOpts: {
        ui: 'bdd',
        // 手动验收：预算即「上限」，用户关窗就结束；必须大于等待预算，否则用例先被 mocha 掐掉
        // 真实下载经代理可能十几分钟（实测 102 MiB / ~300 KB·s⁻¹）：live 预算必须足够宽
        timeout: manual ? manualTimeoutMs() + 120_000 : human ? Math.max(humanTimeoutMs, 120_000) : live ? 1_800_000 : 120_000
    },
    reporters: ['spec'],
    outputDir: 'temp/wdio-results',

    /** 清理本次运行的临时 Chrome profile（Windows 句柄延迟，失败不阻塞） */
    onComplete: () => {
        for (const entry of fs.readdirSync(os.tmpdir())) {
            if (entry.startsWith('iwara-wdio-chrome-')) {
                fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true })
            }
        }
    }
}

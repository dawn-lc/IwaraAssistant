/**
 * MV3 扩展装载 fixture —— Playwright 官方 chrome-extensions 方案
 * （参照原仓库 IwaraDownloadTool e2e/helpers/fixtures.ts 的两阶段形态， simplified：
 * 本扩展无需脚本管理器/userScripts 安装步骤，直接 --load-extension 侧载产物目录）
 *
 * - dist/chrome 必须已构建（npm run build:chrome）
 * - 默认有头；E2E_HEADLESS=1 时用 --headless=new + headless: true（一致下发，缺一即失效）
 * - worker 级单会话：一次启动装载扩展，全部用例复用（SW 启动只等一次）
 * - 全程捕获 SW console（onInstalled/boot 日志验收 + 失败时输出便于排障）
 *
 * 显示模式考据同原仓：launchPersistentContext headless 缺省 true 是隐藏根因；
 * 「headless:true + --headless=new」「headless:false + 无参数」必须成对出现。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'

export interface SharedSession {
    context: BrowserContext
    page: Page
    /** 扩展 ID（自 SW URL 解析） */
    extensionId: string
    /** SW console 全量记录（断言与排障用） */
    swConsole: string[]
}

/** 测试用例侧可见的 fixture（当前为空：全部共用项都在 worker 级） */
export interface TestOptions {}

/**
 * worker 级 fixture：整个 worker 只启动一次浏览器 + 装载扩展，全部用例复用。
 *
 * ⚠️ 必须放在 `extend` 的**第二个泛型参数**里：Playwright 把第一个泛型当「测试级」使用，
 * 在那里写 `{ scope: 'worker' }` 会报 `Type '"worker"' is not assignable to type '"test"'`。
 * worker 级 fixture 仍然能在用例参数里解构到。
 */
export interface WorkerOptions {
    sharedSession: SharedSession
}

const HEADLESS = /^(1|true|yes)$/i.test(process.env.E2E_HEADLESS?.trim() ?? '')

export const test = base.extend<TestOptions, WorkerOptions>({
    sharedSession: [
        async ({}, use: (value: SharedSession) => Promise<void>): Promise<void> => {
            const dist = path.resolve(import.meta.dirname, '../../../dist/chrome')
            if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
                throw new Error(`未找到扩展产物 ${dist}，请先 npm run build:chrome`)
            }

            const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwara-assistant-e2e-'))
            const swConsole: string[] = []

            // ⚠️ headless 与 --headless=new 必须一致下发（launchArgs.ts 考据）
            const context = await chromium.launchPersistentContext(userDataDir, {
                channel: 'chromium', // 品牌 Chrome 137+ 禁 --load-extension，固定开源 Chromium
                headless: HEADLESS,
                // 界面文案走自建 i18n，默认「跟随浏览器语言」：用例断言的是中文文案，
                // 必须把浏览器语言钉到 zh-CN（locale 影响 navigator.language，--lang 影响 i18n.getUILanguage）
                locale: 'zh-CN',
                ...(HEADLESS ? { args: ['--headless=new'] } : {}),
                args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--disable-gpu', '--lang=zh-CN'],
                ignoreDefaultArgs: ['--enable-automation'],
                timeout: 60_000,
                chromiumSandbox: false,
                ...(HEADLESS ? {} : { viewport: { width: 1440, height: 900 }, reuseExistingPage: true })
            })

            const serviceWorker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }))
            const extensionId = serviceWorker.url().split('/')[2]!
            const onConsole = (msg: import('@playwright/test').ConsoleMessage): void => {
                swConsole.push(`[${msg.type()}] ${msg.text()}`)
            }
            serviceWorker.on('console', onConsole)

            // 工作页：about:blank 初始页直接用；SW 挂起由扩展自然处理
            const page = context.pages()[0] ?? (await context.newPage())

            await use({ context, page, extensionId, swConsole })

            serviceWorker.off('console', onConsole)
            await context.close().catch(() => undefined)
            // 临时 profile 清理（Windows 句柄延迟，失败不阻塞）
            fs.rmSync(userDataDir, { recursive: true, force: true })
        },
        // `as const` 必需：元组第二项否则被推成 string，报 scope 不兼容
        { scope: 'worker' } as const
    ]
})

export { expect }

/** 打开扩展自有页面（options/popup 的 e2e 用） */
export async function openExtensionPage(page: Page, extensionId: string, path: string): Promise<void> {
    await page.goto(`chrome-extension://${extensionId}/${path}`)
    await page.waitForLoadState('domcontentloaded')
}

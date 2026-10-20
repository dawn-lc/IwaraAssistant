import { defineConfig } from '@playwright/test'

/**
 * MV3 扩展 e2e —— Playwright 官方 chrome-extensions 方案
 * （launchPersistentContext + --load-extension；chromium 通道品牌 Chrome 137+ 已禁用
 * flags 侧载，见原仓库 IwaraDownloadTool e2e/helpers/launchArgs.ts 源码级考据，
 * 故固定 chromium 通道）。有头调试可旁观；E2E_HEADLESS=1 切无头（新无头支持扩展）。
 */
export default defineConfig({
    testDir: './e2e/playwright/specs',
    testMatch: ['**/*.spec.ts'],
    timeout: 120_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: 'list',
    outputDir: 'temp/e2e-results'
})

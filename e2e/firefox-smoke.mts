/**
 * Firefox 运行时冒烟（node --import tsx/esm ./e2e/firefox-smoke.mts）
 *
 * 为什么不是 Playwright spec：Playwright 的扩展直载（--load-extension +
 * serviceWorkers 事件）只在 Chromium 通道实现；Firefox 走 Juggler，不暴露扩展
 * 安装通道——docs/06 测试策略表据此把 Firefox 定为「web-ext run 冒烟级」。
 *
 * 方案：web-ext run 拉起真 Firefox 155 装载 dist/firefox；
 * - **默认有头窗口**（可旁观装载过程）；E2E_HEADLESS=1 才切无头（CI 用）
 * - 首启干扰（欢迎向导/默认浏览器问询/上报政策页）经**预创建 profile 的
 *   user.js** 消除——web-ext `--pref` 是默认值级别，首启流程会重新覆写；
 *   user.js 是锁定级别，首启也强制生效（Selenium/Playwright-FF CI 通用做法）
 * - 事件页 console 经 devtools.console.stdout.content=true 同步打到进程 stderr，
 *   脚本监听 [iwara-assistant] background up 判定 PASS
 * - web-ext 无 --headless 选项：无头以 Firefox 原生参数 --args=-headless 透传
 *   （等号形式；空格形式会让 yargs 把后续选项吃进 --args 导致打印帮助退出）
 */
import { spawn } from 'node:child_process'
import { promises as fs, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HEADLESS = /^(1|true|yes)$/i.test(process.env.E2E_HEADLESS?.trim() ?? '')

const root = path.resolve(import.meta.dirname, '..')
const distFirefox = path.join(root, 'dist', 'firefox')
const logFile = path.join(root, 'temp', 'firefox-e2e.log')

if (!existsSync(path.join(distFirefox, 'manifest.json'))) {
    console.error('[smoke] 未找到 dist/firefox/manifest.json —— 先 npm run build:firefox')
    process.exit(2)
}

/**
 * 首启干扰抑制 pref（user.js 锁定级别）：欢迎向导 / 默认浏览器问询 /
 * 数据上报政策页 / 新标签 onboarding / Nimbus 实验 / 遥测。
 * 注：dataSubmissionPolicyBypassNotification=true + firstRunURL="" 是数据上报弹层的
 * 关闭组合；browser.aboutwelcome.enabled=false 关 about:welcome 向导；
 * mstone=ignore 关升级欢迎页。
 */
const SUPPRESSION_PREFS: Record<string, string | boolean | number> = {
    'browser.aboutwelcome.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.startup.page': 0,
    'browser.startup.firstrunSkipsHomepage': true,
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
    'datareporting.policy.dataSubmissionPolicyAcceptedVersion': 100,
    'datareporting.policy.firstRunURL': '',
    'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.unified': false,
    'app.update.auto': false,
    'messaging-system.rsexperimentloader.enabled': false,
    'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features': false,
    'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons': false,
    'extensions.experiments.enabled': true,
    // 事件页 console → 进程 stderr（脚本断言通道）
    'devtools.console.stdout.content': true
}

function userJsContent(): string {
    const lines = Object.entries(SUPPRESSION_PREFS).map(([key, value]) => {
        const literal = typeof value === 'string' ? JSON.stringify(value) : String(value)
        return `user_pref(${JSON.stringify(key)}, ${literal});`
    })
    return lines.join('\n')
}

/** 预创建 profile（含 user.js）：锁定级 pref，web-ext --firefox-profile 拷贝使用 */
async function createFirefoxProfile(): Promise<string> {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iwara-assistant-ff-'))
    await fs.writeFile(path.join(profileDir, 'user.js'), userJsContent(), 'utf8')
    return profileDir
}

// web-ext 在 devDependencies 里：Windows 下 bin 是 .cmd shim，Node spawn 不能直执 shell 脚本
// → 统一用 node 跑其 JS 入口（node_modules/web-ext/bin/web-ext.js，package.json bin 声明）
const webExtEntry = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js')
if (!existsSync(webExtEntry)) {
    console.error('[smoke] 未找到 node_modules/web-ext —— 先 npm install')
    process.exit(2)
}

const profileDir = await createFirefoxProfile()
const args = [
    webExtEntry,
    'run',
    '--source-dir',
    distFirefox,
    '--firefox',
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    // user.js 锁定级首启抑制（欢迎向导/默认问询/上报政策）——见 SUPPRESSION_PREFS
    '--firefox-profile',
    profileDir,
    // 有头：不传任何无头参数（窗口可见，可旁观装载）；E2E_HEADLESS=1 时才透传 -headless
    ...(HEADLESS ? ['--args=-headless'] : []),
    // Firefox stdout/stderr 全走 web-ext 的 log.debug——不加 --verbose 会被吞
    // （lib/firefox/index.js:91 实证），扩展事件页 console 由此可达脚本断言
    '--verbose',
    '--no-reload'
]

await fs.mkdir(path.dirname(logFile), { recursive: true })
rmSync(logFile, { force: true })

console.log(`[smoke] 启动 web-ext run（${HEADLESS ? '无头' : '有头窗口——浏览器窗口将弹出，可旁观装载过程'}）…`)
const child = spawn(process.execPath, args, {
    cwd: root,
    // stdin 必须给常开管道（不能 'ignore'）：web-ext 的按键监听（R 重载/Q 退出）在
    // stdin 立即 EOF 时会把「读完结尾」当作用户退出请求 → run 秒退 code=0。
    // 管道永不写入即永不 EOF；进程收尾由 taskkill 强杀。
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
})
// 保持 stdin 打开（web-ext 的 readline 持续等待而不会触发退出分支）
child.stdin?.on('error', () => undefined)

const chunks: Buffer[] = []
let settled = false
const timer = setTimeout(() => finish(new Error('120s 内未在事件页 console 观察到装载标记')), 120_000)

function cleanup(): void {
    if (child.pid) {
        try {
            // web-ext run 自身进程树
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
            child.kill()
        }
    }
    // ⚠️ Firefox 不是 web-ext 的子进程（launch 后仅持有 RDP 连接，taskkill /T 杀不到），
    // 上轮实测关闭终端后 Firefox 存活。按命令行特征补杀：本冒烟的临时 profile 目录名
    // 固定含 'iwara-assistant-ff-'（web-ext 会拷贝为 Temp\copy-*，但 -profile 参数原文
    // 仍指拷贝源；两个特征都扫），命中即为本冒烟拉起的 firefox.exe——特征唯一，不误伤日常浏览器
    const wmi = spawn('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" | Where-Object { $_.CommandLine -match 'iwara-assistant-ff-|copy-\\w+' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { stdio: 'ignore' })
    wmi.on('error', () => undefined)
    // 临时 profile 清理（Windows 句柄延迟，失败不阻塞）
    setTimeout(() => rmSync(profileDir, { recursive: true, force: true }), 5_000)
}

function finish(err?: Error): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    void fs.appendFile(logFile, Buffer.concat(chunks)).catch(() => undefined)
    if (err) {
        console.error(`[smoke] FAIL: ${err.message}`)
        console.error(`[smoke] 完整日志: ${logFile}`)
        process.exitCode = 1
    } else {
        console.log('[smoke] PASS: Firefox 事件页装载并完成 background boot')
        if (HEADLESS) {
            // 无头（CI）：立即收尾
            cleanup()
        } else {
            // 有头：保留 Firefox 窗口 30s 供旁观（options 页签 / 通知 / 控制台），再收尾
            console.log('[smoke] 保留 Firefox 窗口 30s 供观察（可打开 about:debugging 查看扩展）…')
            setTimeout(cleanup, 30_000)
        }
    }
}

child.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    const text = chunk.toString()
    process.stdout.write(text)
    if (text.includes('[iwara-assistant] background up')) {
        finish()
    }
})
child.stderr.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    process.stderr.write(chunk)
})
child.on('error', (err) => finish(new Error(`web-ext 启动失败: ${err.message}`)))
child.on('exit', (code) => {
    if (!settled) finish(new Error(`web-ext 过早退出（code=${code}）`))
})

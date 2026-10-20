/**
 * esbuild 多入口构建（node --import tsx/esm ./build/index.ts [chrome|firefox] [--watch]）
 *
 * 产物（dist/<target>/）：
 *   background.js            —— 单文件 IIFE，Chrome SW / Firefox 事件页共用
 *   content/main-world.js    —— IIFE，world:MAIN，document_start
 *   content/isolated.js      —— IIFE，ISOLATED，document_start
 *   content/page-ui.js       —— IIFE，ISOLATED，document_start
 *   content/page-ui.css      —— 声明式注入（manifest content_scripts[].css）
 *   options/index.{html,css,js}
 *   popup/index.{html,css,js}
 *   manifest.json            —— manifest.base.json + variants 派生
 *   icons/icon-{16,48,128}.png —— 由唯一源文件 assets/icons/logo.svg 经 @resvg/resvg-js 栅格化
 *   _locales/**              —— 静态 i18n 文案（browser.i18n 消费）
 *
 * 关键点：
 *  - browser 命名空间 shim 经 esbuild `inject` 成为每个 bundle 的第一个模块（docs/02）
 *  - options/popup 入口启用 jsx: automatic（React 19）；content/background 保持纯 TS（docs/01）
 *  - define 注入 process.env.NODE_ENV=production，保证 React 走产品构建（MV3 CSP 无 eval）
 */
import { build, context, type BuildOptions, type Plugin } from 'esbuild'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { chromeVariant, firefoxVariant, type ManifestVariant } from '../manifest/variants'
import { renderIconPng } from './iconRenderer'
import { rewriteInnerHtmlAssignments } from './innerHtmlRewrite'
import { toManifestV2 } from './manifestV2'
import { readExtensionVersion } from './version'

const root = path.resolve(import.meta.dirname, '..')
const srcDir = path.join(root, 'src')
const destRoot = path.join(root, 'dist')

type Target = 'chrome' | 'firefox'
const args = process.argv.slice(2)
const target: Target = args.includes('firefox') ? 'firefox' : args.includes('chrome') ? 'chrome' : 'chrome'
const watch = args.includes('--watch')
const dest = path.join(destRoot, target)

const variant: ManifestVariant = target === 'chrome' ? chromeVariant : firefoxVariant

interface EntryDef {
    entry: string
    outfile: string
    jsx?: boolean
    /**
     * 跳过 browser 命名空间 shim。
     * 用于 **MAIN world** 入口（`content/main-world.js`）：
     * 该世界不使用任何 browser API，注入 shim 会向页面全局写入
     * `window.browser = window.chrome`（页面 feature-detect 会误判，
     * 在 Firefox 上更是把 `browser` 定义成 undefined）。
     */
    skipGlobalsShim?: boolean
    /**
     * CSS 入口（产物为 `.css`，由 manifest `content_scripts[].css` 声明式注入）。
     * 只需 `bundle` 解析 `@import`，不能套用任何 JS 选项（target / platform / inject）。
     */
    css?: boolean
    /** 仅 Chrome 产物（offscreen 文档：Firefox 事件页有 DOM，无需且无此 API） */
    chromeOnly?: boolean
}

const ENTRIES: EntryDef[] = [
    { entry: 'src/background/index.ts', outfile: 'background.js' },
    // ── 钓鱼防护（所有站点，document_start）──
    // MAIN：封锁 fetch/XHR/WebSocket（只有 MAIN 世界改得到页面自己的 API）
    { entry: 'src/content/guard/main.ts', outfile: 'content/guard-main.js', skipGlobalsShim: true },
    // ISOLATED：全屏警告界面（走 browser.i18n 取文案，绝不把三语字典带进每个页面）
    { entry: 'src/content/guard/isolated.ts', outfile: 'content/guard.js' },
    // ── MAIN world：劫持与改写（document_start 保证先于页面任何脚本）──
    // skipGlobalsShim：MAIN 世界不使用任何 browser API，
    // 注入 shim 会向页面全局写入 `window.browser = window.chrome`（污染页面特征检测）
    { entry: 'src/content/mainWorld.ts', outfile: 'content/main-world.js', skipGlobalsShim: true },
    // ── ISOLATED world：桥接与 UI 拆开，避免握手被 UI 体积拖慢 ──
    { entry: 'src/content/isolated.ts', outfile: 'content/isolated.js' },
    // 页内 UI：`pageUi.ts` 本身就是一个纯副作用入口（末尾 `start()`），不需要再套一层转发文件
    { entry: 'src/content/pageUi.ts', outfile: 'content/page-ui.js' },
    // 页内 UI 样式：独立 CSS 产物，manifest 声明式注入（document_start，早于任何脚本）
    { entry: 'src/content/css/index.css', outfile: 'content/page-ui.css', css: true },
    { entry: 'src/options/main.tsx', outfile: 'options/options.js', jsx: true },
    { entry: 'src/popup/main.tsx', outfile: 'popup/popup.js', jsx: true },
    // Chrome 专用：offscreen 文档（SW 无 DOM，剪贴板只能由它代写）
    { entry: 'src/offscreen/offscreen.ts', outfile: 'offscreen.js', chromeOnly: true }
]

/** 静态资产：源路径（相对 root）→ 产物路径（相对 dist/<target>） */
const STATIC_FILES: Array<[string, string]> = [
    ['src/options/options.html', 'options/index.html'],
    ['src/options/options.css', 'options/options.css'],
    ['src/popup/popup.html', 'popup/index.html'],
    ['src/popup/popup.css', 'popup/popup.css'],
    ['src/offscreen/offscreen.html', 'offscreen.html'],
    // Apache-2.0 第 4 条要求随分发附带许可证副本；商店上传的是 zip，所以把 LICENSE 放进产物根目录
    ['LICENSE', 'LICENSE']
]

/** 仅 Chrome 的静态资产（与 `EntryDef.chromeOnly` 配套，避免 Firefox 包携带死文件） */
const CHROME_ONLY_STATIC = new Set(['offscreen.html'])

/** 按目标筛选入口（chromeOnly 只在 chrome 产物中构建） */
function entriesForTarget(): EntryDef[] {
    return ENTRIES.filter((entry) => !entry.chromeOnly || target === 'chrome')
}

/** 按目标筛选静态资产 */
function staticFilesForTarget(): Array<[string, string]> {
    return target === 'chrome' ? STATIC_FILES : STATIC_FILES.filter(([, to]) => !CHROME_ONLY_STATIC.has(to))
}

/**
 * 是否压缩。
 *
 * 发布/CI 构建必须压缩：引入 i18next 后，不压缩会让每个 bundle 多带走 ~86 KiB 的
 * 库代码（content script 跑在每个 iwara 页面上，解析成本是真金白银）。
 * `dev:*`（`--watch`）保持可读，堆栈与断点才有意义。
 */
const MINIFY = !watch

/**
 * 消除 addons-linter 对 react-dom 的 `UNSAFE_VAR_ASSIGNMENT` 误报：
 * 产物写完后把 `el.innerHTML = html` 改写为等价的 `Reflect.set(...)`。
 * 细节与安全性论证见 `build/innerHtmlRewrite.ts`。
 */
function innerHtmlRewritePlugin(outfile: string): Plugin {
    return {
        name: 'inner-html-rewrite',
        setup(pluginBuild) {
            pluginBuild.onEnd(async (result) => {
                if (result.errors.length > 0) return
                const code = await fs.readFile(outfile, 'utf8')
                const { code: next, count } = rewriteInnerHtmlAssignments(code)
                if (count > 0) {
                    await fs.writeFile(outfile, next)
                    console.log(`[build] ${path.relative(root, outfile)}：innerHTML 赋值改写 ${count} 处（消除 linter 误报）`)
                } else if (code.includes('__html')) {
                    console.warn(`[build] ${path.relative(root, outfile)}：含 dangerouslySetInnerHTML 实现但未匹配 innerHTML 赋值，react-dom 形态可能变了，请更新 build/innerHtmlRewrite.ts`)
                }
            })
        }
    }
}

function makeBuildOptions(entry: EntryDef): BuildOptions {
    const outfile = path.join(dest, entry.outfile)
    const common: BuildOptions = {
        entryPoints: [path.join(root, entry.entry)],
        outfile,
        bundle: true,
        sourcemap: false,
        minify: MINIFY,
        logLevel: 'warning'
    }
    // CSS 入口：esbuild 按扩展名选 loader，只需 bundle 把 @import 展开成单文件
    if (entry.css) return common
    return {
        ...common,
        plugins: [innerHtmlRewritePlugin(outfile)],
        format: 'iife',
        target: ['es2022'],
        platform: 'browser',
        // globals shim 必须先于任何业务模块求值（docs/02 防护 shim）
        inject: entry.skipGlobalsShim ? [] : [path.join(srcDir, 'browser', 'globals.ts')],
        define: { 'process.env.NODE_ENV': '"production"' },
        ...(entry.jsx ? { jsx: 'automatic' as const } : {})
    }
}

// ── manifest 派生：占位符替换（含键名替换）+ variant.extra 顶层合并 ───────

/**
 * 递归替换占位符。
 *
 * `ownerKey` 是当前对象所属的**顶层**字段名，用来判断「未定义的占位符键」能不能安全丢弃：
 * - 该顶层字段已由 `variant.extra` 整体覆盖（如 Firefox 的 `background`）→ 设计如此，静默丢弃；
 * - 没有覆盖 → 字段会从 manifest 里静默消失，属配置错误，必须告警。
 */
function applyTemplate(node: unknown, targetVariant: ManifestVariant, ownerKey?: string): unknown {
    if (typeof node === 'string') {
        let out = node
        for (const [k, v] of Object.entries(targetVariant.placeholder)) out = out.split(`%#${k}#%`).join(v)
        return out
    }
    if (Array.isArray(node)) return node.map((child) => applyTemplate(child, targetVariant, ownerKey))
    if (node && typeof node === 'object') {
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(node)) {
            if (/^%#.+?#%$/.test(key)) {
                const resolved = targetVariant.placeholder[key.slice(2, -2)]
                if (resolved === undefined) {
                    const covered = ownerKey !== undefined && ownerKey in targetVariant.extra
                    if (!covered) {
                        console.warn(`[build] 占位符键未在 variant 中定义且无 extra 兜底，已丢弃：${key}` + `（字段 "${ownerKey ?? '<root>'}" 将不会出现在 manifest，请检查 manifest/variants.ts）`)
                    }
                } else {
                    result[resolved] = applyTemplate(value, targetVariant, ownerKey)
                }
            } else {
                result[key] = applyTemplate(value, targetVariant, ownerKey ?? key)
            }
        }
        return result
    }
    return node
}

/**
 * MV3 形状 → MV2 形状：实现与单测见 `build/manifestV2.ts` / `test/manifestV2.test.ts`。
 * base 模板永远按 MV3 写（Chrome 是主产物），MV2 的差异在那里做一次性、可枚举的改写。
 */

async function writeManifest(version: string): Promise<void> {
    const base = JSON.parse(await fs.readFile(path.join(root, 'manifest', 'manifest.base.json'), 'utf8')) as Record<string, unknown>
    const manifest = { ...(applyTemplate(base, variant) as Record<string, unknown>), ...variant.extra }

    // MV2 变体（Firefox）先做形状改写，再补版本号与追加权限：
    // 改写涉及 `permissions` 合并，必须在 extraPermissions 之前完成，
    // 否则 MV2 专有的权限追加会落进已被搬到 `permissions` 的旧数组里。
    if (variant.manifestVersion === 2) toManifestV2(manifest)

    // 版本号在**所有覆盖之后**写入：package.json 是唯一真源，
    // 任何 variant（含 extra 里的手写字段）都不应该能改它。
    manifest['version'] = version

    // 变体专属权限（如 Chrome 的 `offscreen`）追加到 base 列表，避免整表复制粘贴造成漂移
    const extraPermissions = variant.extraPermissions ?? []
    if (extraPermissions.length > 0) {
        const current = Array.isArray(manifest['permissions']) ? (manifest['permissions'] as string[]) : []
        manifest['permissions'] = [...current, ...extraPermissions.filter((permission) => !current.includes(permission))]
    }

    // Firefox 自更新发版路线（M6 可选）：设 IWARA_ASSISTANT_UPDATE_URL 环境变量时注入 gecko.update_url，
    // 签名用 AMO 账号密钥自签（web-ext sign --api-key …）。注意该键与 AMO 上传审核互斥（AMO 会剥离校验）；
    // 默认不设 → 走 AMO 上传审核路线，无 update_url。
    if (target === 'firefox') {
        const updateUrl = process.env['IWARA_ASSISTANT_UPDATE_URL']
        if (updateUrl) {
            const settings = manifest['browser_specific_settings'] as { gecko?: Record<string, unknown> } | undefined
            if (settings?.gecko) settings.gecko['update_url'] = updateUrl
            console.warn(`[build] firefox 自更新已启用: ${updateUrl}（此包不可上传 AMO 审核通道）`)
        }
    }

    await fs.writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 4))
}

// ── 图标：由唯一源文件 assets/icons/logo.svg 经 resvg 栅格化（Chrome 不支持 manifest 用 SVG）────

async function writeIcons(): Promise<void> {
    await fs.mkdir(path.join(dest, 'icons'), { recursive: true })
    for (const size of [16, 48, 128]) {
        await fs.writeFile(path.join(dest, 'icons', `icon-${size}.png`), renderIconPng(size))
    }
}

async function writeStatic(version: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true })
    for (const [from, to] of staticFilesForTarget()) {
        const out = path.join(dest, to)
        await fs.mkdir(path.dirname(out), { recursive: true })
        await fs.copyFile(path.join(root, from), out)
    }
    await fs.cp(path.join(root, 'manifest', '_locales'), path.join(dest, '_locales'), { recursive: true })
    await writeIcons()
    await writeManifest(version)
}

// ── 执行 ─────────────────────────────────────────────────────────────

// 版本号先读先校验：不合法就在动文件系统**之前**失败，不留下半个产物目录。
// （曾经把校验放在 writeManifest 里：构建已清空 dist、写完静态文件才报错，
//   留下没有 manifest.json 的残缺目录，package.ts 随后报的错完全不指向真因。）
const version = await readExtensionVersion(root)

/**
 * 清空 dist/<target>。
 * 不做这一步的话，删除/重命名入口后旧产物会一直留在 dist 里，
 * 被打包进 zip（曾经 `content/early-hook.js` 在入口删除后仍残留在包里）。
 * watch 模式本身不重建静态资源，为保持增量一致也不清空。
 */
if (!watch && existsSync(dest)) await fs.rm(dest, { recursive: true, force: true })

await writeStatic(version)

if (watch) {
    const contexts = await Promise.all(entriesForTarget().map((entry) => context(makeBuildOptions(entry))))
    await Promise.all(contexts.map((c) => c.watch()))
    console.log(`[build] dist/${target} watching  v${version} — 注意：html/css/manifest/icons 刮静态产物如需更新请重跑构建`)
} else {
    await Promise.all(entriesForTarget().map((entry) => build(makeBuildOptions(entry))))
    console.log(`[build] dist/${target} ready  v${version}`)
}

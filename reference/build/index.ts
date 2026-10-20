/**
 * esbuild 多目标构建骨架（node --import tsx/esm ./build/index.ts [chrome|firefox]）
 *
 * 产物：
 *   dist/<target>/background.js            —— 单文件 IIFE，Chrome SW / Firefox 事件页共用
 *   dist/<target>/content/isolated.js      —— IIFE，document_start
 *   dist/<target>/content/main-world.js    —— IIFE，document_start
 *   dist/<target>/options/options.{html,js}
 *   dist/<target>/manifest.json            —— base + variants 派生
 *
 * 关键点：browser 命名空间 shim 经 esbuild `inject` 成为每个 bundle 的第一个模块，
 * 保证任何 API 调用前已生效（docs/02）。
 */
import esbuild from 'esbuild'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const reference = path.join(root, 'reference')
const destRoot = path.join(root, 'dist')

type Target = 'chrome' | 'firefox'
const target: Target = process.argv[2] === 'firefox' ? 'firefox' : 'chrome'
const dest = path.join(destRoot, target)

const common: esbuild.BuildOptions = {
    bundle: true,
    target: ['es2022'],
    format: 'iife',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
}

const injectGlobals = path.join(reference, 'browser', 'globals.ts')

async function bundle(entry: string, outfile: string): Promise<void> {
    await esbuild.build({ ...common, entryPoints: [entry], outfile, inject: [injectGlobals] })
}

async function deriveManifest(): Promise<void> {
    const base = JSON.parse(await fs.readFile(path.join(reference, 'manifest.base.json'), 'utf8'))
    const { chromeVariant, firefoxVariant } = await import(path.join(reference, 'manifest.variants.ts'))
    const variant = target === 'chrome' ? chromeVariant : firefoxVariant

    const apply = (node: unknown): unknown => {
        if (typeof node === 'string') {
            let out = node
            for (const [k, v] of Object.entries(variant.placeholder)) out = out.split(`%#${k}#%`).join(v)
            return out
        }
        if (Array.isArray(node)) return node.map(apply)
        if (node && typeof node === 'object') {
            return Object.fromEntries(
                Object.entries(node).map(([k, v]) => [k.startsWith('%#') ? variant.placeholder[k.slice(2, -2)] : k, apply(v)])
            )
        }
        return node
    }

    const manifest = { ...apply(base), ...variant.extra }
    if (target === 'firefox') {
        // base 里 min_version 占位键已在 apply 中替换为 browser_specific_settings；防重复，以 extra 为准
        delete (manifest as Record<string, unknown>)['minimum_chrome_version']
    }
    await fs.mkdir(dest, { recursive: true })
    await fs.writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 4))
}

for (const entry of ['background/index.ts', 'content/isolated.ts', 'content/main-world.ts']) {
    const outfile = entry === 'background/index.ts' ? path.join(dest, 'background.js') : path.join(dest, 'content', entry.split('/')[1]!.replace(/\.ts$/, '.js'))
    await bundle(path.join(reference, entry), outfile)
}
await fs.mkdir(path.join(dest, 'options'), { recursive: true })
await bundle(path.join(reference, 'options', 'options.ts'), path.join(dest, 'options', 'options.js'))
await fs.copyFile(path.join(reference, 'options', 'options.html'), path.join(dest, 'options', 'options.html'))
await deriveManifest()
console.log(`[build] dist/${target} ready`)

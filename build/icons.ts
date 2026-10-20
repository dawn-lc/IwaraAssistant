/**
 * 图标 CLI（`npm run build:icons`）。
 *
 * 唯一设计源是 `assets/icons/logo.svg`，栅格化在 `build/iconRenderer.ts`
 * （构建也直接用它，底层是 @resvg/resvg-js）。本脚本**不参与** `npm run build`，
 * 只做两件辅助的事：
 *
 * - 默认：把 16/48/128 写进 `assets/icons/`（本地查看 / 上传商店取用；`.gitignore` 已忽略）
 * - `--size=N`：只输出一张到 `temp/icons/`，检查几何与缩放效果
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LOGO_SVG_PATH, renderIconPng } from './iconRenderer'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'assets', 'icons')

const previewSize = Number(/--size=(\d+)/.exec(process.argv.join(' '))?.[1] ?? Number.NaN)
if (Number.isInteger(previewSize) && previewSize > 0 && previewSize <= 2048) {
    const previewDir = path.join(root, 'temp', 'icons')
    await fs.mkdir(previewDir, { recursive: true })
    const file = path.join(previewDir, `icon-${previewSize}.png`)
    await fs.writeFile(file, renderIconPng(previewSize))
    console.log(`[icons] ${path.relative(root, file)}（预览，assets 未改动）`)
} else {
    await fs.mkdir(outDir, { recursive: true })
    console.log(`[icons] 源：${path.relative(root, LOGO_SVG_PATH)}`)
    for (const size of [16, 48, 128]) {
        const file = path.join(outDir, `icon-${size}.png`)
        await fs.writeFile(file, renderIconPng(size))
        console.log(`[icons] ${path.relative(root, file)}`)
    }
}

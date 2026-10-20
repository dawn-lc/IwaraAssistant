/**
 * 图标栅格化：`assets/icons/logo.svg` → PNG。
 *
 * 仓库只维护**一个** SVG（完整图标：底板 + 渐变 + 字形都由设计工具直接画好），
 * 这里只调用 @resvg/resvg-js 按目标宽度渲染，不拼几何、不近似填充。
 * 16px 也走同一份源文件，因此不存在「改一处漏一处」的按尺寸分叉；
 * 小尺寸的可读性由 SVG 设计本身保证（线条够粗、细节不小于 1px）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = path.resolve(import.meta.dirname, '..')

/** 唯一图标源文件 */
export const LOGO_SVG_PATH = path.join(root, 'assets', 'icons', 'logo.svg')

let cachedSvg: Buffer | null = null

function loadSvg(): Buffer {
    cachedSvg ??= readFileSync(LOGO_SVG_PATH)
    return cachedSvg
}

/**
 * 生成指定边长的 PNG（manifest 图标就靠它）。
 */
export function renderIconPng(size: number): Buffer {
    if (!Number.isInteger(size) || size <= 0 || size > 2048) throw new Error(`图标尺寸非法：${size}`)
    try {
        return Buffer.from(new Resvg(loadSvg(), { fitTo: { mode: 'width', value: size } }).render().asPng())
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`图标渲染失败：${path.relative(root, LOGO_SVG_PATH)}（size=${size}）：${detail}`)
    }
}

/**
 * 图标渲染回归：SVG → PNG。
 *
 * 仓库只维护一个 `assets/icons/logo.svg`，所有尺寸都由它渲染。这里锚定三件事：
 * - 输出是合法 PNG，宽高等于请求尺寸（manifest 的 icons 靠它）；
 * - 每个尺寸都来自同一份源文件，与独立渲染结果一致（没有按尺寸分叉的第二份 SVG）；
 * - 非法尺寸直接报错，不产出坏图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { LOGO_SVG_PATH, renderIconPng } from '../build/iconRenderer'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngSize(png: Buffer): { width: number; height: number } {
    assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), '不是 PNG 签名')
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR', '第一个 chunk 应是 IHDR')
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** 测试内的独立渲染：用来确认 renderIconPng 选对了源文件 */
function renderSvg(file: string, size: number): Buffer {
    return Buffer.from(new Resvg(readFileSync(file), { fitTo: { mode: 'width', value: size } }).render().asPng())
}

test('renderIconPng 输出合法 PNG，尺寸与请求一致', () => {
    for (const size of [16, 48, 128]) {
        const png = renderIconPng(size)
        assert.deepEqual(pngSize(png), { width: size, height: size }, `${size}px 图标尺寸不对`)
        assert.ok(png.length > 100, `${size}px 图标内容为空`)
    }
})

test('所有尺寸都由同一份 logo.svg 渲染（不按尺寸分叉）', () => {
    for (const size of [16, 48, 128, 512]) {
        assert.deepEqual(renderIconPng(size), renderSvg(LOGO_SVG_PATH, size), `${size}px 应直接由 logo.svg 渲染`)
    }
})

test('非法尺寸直接报错，不产出坏图', () => {
    for (const size of [0, -1, 1.5, 2049]) assert.throws(() => renderIconPng(size), /图标尺寸非法/)
})

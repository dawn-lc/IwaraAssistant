/**
 * URL 判据（`shared/url.ts`）—— 真实站点回归的核心防线。
 *
 * 两组用例守的都是**静默失效**：
 * - 解析：站点用协议相对 URL 调 API，早期实现 `new URL(input)`（无 base）直接抛错，
 *   拦截器当成「非法 URL 放行」，于是入库/token/过滤/回填全部静默失效
 * - 反查：下载地址里的 `videoid` 读不到，就永远认不出那条任务属于哪个视频
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveRequestUrl, videoIdOfDownloadUrl } from '../src/shared/url'

const BASE = 'https://www.iwara.tv/videos'

// ── fetch 入参解析 ──────────────────────────────────────────────────────

test('绝对 URL 原样解析', () => {
    assert.equal(resolveRequestUrl('https://api.iwara.tv/videos?rating=all', BASE).href, 'https://api.iwara.tv/videos?rating=all')
})

test('协议相对 URL 继承文档协议（真实站点形态）', () => {
    const url = resolveRequestUrl('//api.iwara.tv/videos?rating=all&sort=date', BASE)
    assert.equal(url.protocol, 'https:')
    assert.equal(url.hostname, 'api.iwara.tv')
    assert.equal(url.pathname, '/videos')
    assert.equal(url.searchParams.get('rating'), 'all')
})

test('站内相对路径按文档解析', () => {
    const url = resolveRequestUrl('/videos?rating=all', BASE)
    assert.equal(url.hostname, 'www.iwara.tv')
    assert.equal(url.pathname, '/videos')
})

test('URL 实例入参', () => {
    const url = resolveRequestUrl(new URL('//api.iwara.tv/user/token', BASE), BASE)
    assert.equal(url.href, 'https://api.iwara.tv/user/token')
})

test('Request 形态入参（取 url 字段）', () => {
    const fakeRequest = { url: '//api.iwara.tv/videos' }
    assert.equal(resolveRequestUrl(fakeRequest, BASE).href, 'https://api.iwara.tv/videos')
})

test('无法识别的入参抛错（由调用方决定放行）', () => {
    assert.throws(() => resolveRequestUrl(undefined, BASE), /unsupported/)
    assert.throws(() => resolveRequestUrl({}, BASE), /unsupported/)
})

// ── 下载地址反查视频 ID ─────────────────────────────────────────────────

test('认扩展注入的 videoid（buildDownloadUrl 统一加的标记）', () => {
    assert.equal(videoIdOfDownloadUrl('https://www.iwara.tv/video/x/download?videoid=aBcD1234&quality=Source'), 'aBcD1234')
})

test('没有 videoid → 不是我们发的下载，不接管', () => {
    assert.equal(videoIdOfDownloadUrl('https://example.com/file.mp4'), undefined)
    assert.equal(videoIdOfDownloadUrl('https://example.com/file.mp4?videoid='), undefined)
})

test('非法 URL 不抛错（下载项来自浏览器，不能假设它一定合法）', () => {
    assert.equal(videoIdOfDownloadUrl('not a url'), undefined)
    assert.equal(videoIdOfDownloadUrl(''), undefined)
})

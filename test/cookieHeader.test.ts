/**
 * `Cookie` 头拼装 + 「现取 cookie」链路的单测。
 *
 * 背景：页面快照（`document.cookie`）看不到 HttpOnly，所以投递时改成 `browser.cookies.getAll()` 现取；
 * 这里的纯函数负责把 cookie 数组拼成请求头，接线守卫负责证明四个通道都用上了现取。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { aria2CookieHeader, buildCookieHeader } from '../src/shared/cookieHeader'
import { readSource } from './sourceGuard'

test('拼装：name=value 用分号空格连接', () => {
    assert.equal(
        buildCookieHeader([
            { name: 'a', value: '1' },
            { name: 'b', value: '2' }
        ]),
        'a=1; b=2'
    )
    assert.equal(buildCookieHeader([]), '')
})

test('拼装：空名/空数组/非字符串值一律跳过，不产出畸形头', () => {
    assert.equal(
        buildCookieHeader([
            { name: '', value: 'x' },
            { name: 'ok', value: '1' }
        ]),
        'ok=1'
    )
    assert.equal(buildCookieHeader([{ name: 'weird', value: undefined as unknown as string }]), '')
})

test('拼装：同名多条取 path 最长的那条（浏览器实际会发的那一条）', () => {
    const cookies = [
        { name: 'sid', value: 'generic', path: '/' },
        { name: 'sid', value: 'specific', path: '/video' },
        { name: 'keep', value: 'x', path: '/' }
    ]
    assert.equal(buildCookieHeader(cookies), 'sid=specific; keep=x')
    // 顺序反过来也要取最长，而不是「先到先得」
    assert.equal(
        buildCookieHeader([
            { name: 'sid', value: 'specific', path: '/video' },
            { name: 'sid', value: 'generic', path: '/' }
        ]),
        'sid=specific'
    )
})

test('aria2 header：空 cookie 不生成 Cookie 头', () => {
    // 空字符串头会被 prune 丢掉，这里只要确认约定：不返回任何行
    assert.equal(aria2CookieHeader(''), undefined)
    assert.deepEqual(aria2CookieHeader('a=1'), ['Cookie:a=1'])
})

test('接线：manifest 必须有 cookies 权限（否则 browser.cookies 读不到 HttpOnly）', () => {
    const manifest = JSON.parse(readFileSync('manifest/manifest.base.json', 'utf8')) as { permissions: string[] }
    assert.ok(manifest.permissions.includes('cookies'), 'cookies 权限是「读 HttpOnly 会话 cookie」的唯一途径')
})

test('接线：现取 cookie 要退回快照，不能因为读不到就让下载失败', () => {
    const auth = readSource('src/background/iwara/auth.ts')
    const start = auth.indexOf('export async function getLiveCookieHeader')
    assert.ok(start > 0, '要有现取的入口')
    const body = auth.slice(start, start + 900)
    assert.match(body, /browser\.cookies\.getAll\(/, '现取必须走 cookies API')
    assert.match(body, /return getPageCookie\(\)/, '读不到要退回页面快照')
    assert.match(body, /catch/, '异常也要退回，不能把下载带崩')
})

test('接线：aria2 / iwaradl / 重建三条投递路径都用现取，而不是快照', () => {
    const downloaders = readSource('src/background/download/downloaders.ts')
    assert.match(downloaders, /getLiveCookieHeader\(downloadUrl\.href\)/, 'aria2 要按下载地址现取（文件域名与站点域名不同）')
    assert.match(downloaders, /getLiveCookieHeader\(siteUrl\('\/video\/' \+ videoInfo\.ID\)\)/, 'iwaradl 要按视频页地址现取')
    assert.doesNotMatch(downloaders, /getPageCookie/, '通道里不该再有直接读快照的调用（快照只作兜底，活在 auth 里）')
    const recover = readSource('src/background/backends/aria2/recover.ts')
    assert.match(recover, /getLiveCookieHeader\(urls\[0\]\)/, '重建也要现取，否则「重建后还是 403」无法归因')
})

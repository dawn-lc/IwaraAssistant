/**
 * 第三方网盘链接判据（`shared/linkPatterns.ts`）。
 *
 * 这条判据决定「**要不要下载这个视频**」：命中时源项目会直接放弃下载
 * （`downloadFlow.ts` 的 `pushDownloadTaskInner` 在 `checkDownloadLink` 命中后 `return`），
 * 只弹一条提示让用户自己去视频页看简介/评论区决定。
 * 所以两个方向都要有守卫：该命中的必须命中（否则用户永远看不到提示），
 * 不该命中的不能命中（否则视频根本不会下载，而用户完全不知道为什么）。
 *
 * 判据本身与源 `checkIsHaveDownloadLink` 逐字一致：**朴素子串、忽略大小写**，
 * 不解析 URL、不用正则。特征表按 `data/downloadLinks.json` 原样保留。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DOWNLOAD_LINK_PATTERNS, matchesDownloadLink } from '../src/shared/linkPatterns'

test('常见网盘地址都能命中（大小写不敏感）', () => {
    const cases = ['https://mega.nz/file/abcdef', 'https://pan.baidu.com/s/1abcdef', 'https://www.mediafire.com/file/xyz', 'https://drive.google.com/file/d/xyz', 'https://gofile.io/d/xyz', 'https://1drv.ms/u/s!xyz', 'HTTPS://MEGA.NZ/FILE/ABCDEF']
    for (const text of cases) assert.equal(matchesDownloadLink(text), true, `应当命中：${text}`)
})

test('空文本不命中（`checks empty` 的短路）', () => {
    assert.equal(matchesDownloadLink(''), false)
})

test('普通评论不命中（避免「什么都没写也要拦下载」）', () => {
    const cases = ['谢谢分享', 'great work, thanks!', '这个模型的姿势很棒', '', 'a'.repeat(1000)]
    for (const text of cases) assert.equal(matchesDownloadLink(text), false, `不该命中：${text}`)
})

test('命中判据是子串而不是整串相等：夹在长文本中间也算', () => {
    const text = `作者说明……下载地址：https://mega.nz/file/abc……解压密码：1234`
    assert.equal(matchesDownloadLink(text), true)
})

test('特征表保持源项目的 30 条（少一条就是漏检，多一条就是误拦）', () => {
    assert.equal(DOWNLOAD_LINK_PATTERNS.length, 30)
})

/**
 * 私有视频失败（`errors.privateVideo`）的判据与后续地址。
 *
 * 这类失败有个危险性质：判错**不会报错**。
 * - 误判成普通失败 → 用户看到一个永远无效的「重试」（旧实现就是这样，详情还是 API 原文）；
 * - 判成私有视频但没有作者 → 「打开作者主页」会指向一个拼错的地址。
 * 所以每条判据都要被单测钉住，包括「不该命中」的那一半。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { isPrivateVideoFailure, privateVideoFollowUp } from '../src/shared/privateVideo'

test('识别私有视频报文：大小写不敏感，可出现在更长的消息里', () => {
    assert.equal(isPrivateVideoFailure('errors.privateVideo'), true)
    assert.equal(isPrivateVideoFailure('ERRORS.PRIVATEVIDEO'), true)
    assert.equal(isPrivateVideoFailure('Request failed: errors.privateVideo'), true)
})

test('其它失败不被误判（误判会把普通失败引到作者主页）', () => {
    for (const message of ['No available video source', 'external Video', 'errors.unauthorized', '', undefined, null]) {
        assert.equal(isPrivateVideoFailure(message), false, `${String(message)} 不该判成私有视频`)
    }
})

test('有作者显示名：指名道姓 + 作者主页', () => {
    const followUp = privateVideoFollowUp({ username: 'alice', alias: 'Alice' })
    assert.equal(followUp.detailKey, 'tasks.privateVideoDetailNamed')
    assert.deepEqual(followUp.detailParams, { alias: 'Alice' })
    assert.equal(followUp.profileUrl, 'https://www.iwara.tv/profile/alice')
})

test('只有用户名：用不带插值的通用文案（漏传 alias 会让界面出现字面 {alias}）', () => {
    const followUp = privateVideoFollowUp({ username: 'alice', alias: '   ' })
    assert.equal(followUp.detailKey, 'tasks.privateVideoDetail')
    assert.equal(followUp.detailParams, undefined)
    assert.equal(followUp.profileUrl, 'https://www.iwara.tv/profile/alice')
})

test('查不到作者：不给跳转（界面上只剩「重试」），文案让他自己去视频页加好友', () => {
    for (const author of [undefined, {}, { username: '  ' }]) {
        const followUp = privateVideoFollowUp(author)
        assert.equal(followUp.detailKey, 'tasks.privateVideoDetailNoAuthor')
        assert.equal(followUp.profileUrl, undefined)
    }
})

test('用户名进 URL 前必须编码（脏数据不能把地址拼坏）', () => {
    assert.equal(privateVideoFollowUp({ username: 'a b/c' }).profileUrl, 'https://www.iwara.tv/profile/a%20b%2Fc')
})

test('接线：三处解析失败都走 describeParseFailure（否则某个入口会退回 API 原文、没有跳转）', () => {
    const dispatch = readFileSync('src/background/download/dispatch.ts', 'utf8')
    const browserQueue = readFileSync('src/background/download/browserQueue.ts', 'utf8')
    assert.equal(dispatch.match(/await describeParseFailure\(/g)?.length, 2, '首次投递与重试各一处')
    assert.equal(browserQueue.match(/await describeParseFailure\(/g)?.length, 1, '排队补解析一处')
    // 'author' 这个意图只能由 parseFailure.ts 决定，调用点不许自己拼作者主页地址
    assert.match(readFileSync('src/background/download/parseFailure.ts', 'utf8'), /followUpKind: 'author'/)
})

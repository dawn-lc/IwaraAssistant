/**
 * aria2 恢复判据（`shared/aria2Recover.ts`）。
 *
 * 这些判据决定「要不要动用户的下载任务」——重建/换地址/重启都会打断正在跑的下载。
 * 判错的两个方向都很难看：过松 → 反复重启，白丢已下好的进度；过紧 → 死了的任务永远不救。
 * 所以每条规则都单钉用例，尤其是「98% 豁免」与「速度 0 不豁免」这两个反直觉分支。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_RECOVER_ATTEMPTS, SLOW_SPEED_THRESHOLD, aria2Progress, compareForKeep, gidPriority, recoverExhausted, shouldRestartForSlowSpeed, taskLatestExpiry } from '../src/shared/aria2Recover'
import { uriExpiresAt } from '../src/shared/url'

const now = 1_700_000_000_000
const GRACE = 10 * 60 * 1000

function active(completed: number, total: number, speed: number) {
    return { status: 'active' as const, totalLength: String(total), completedLength: String(completed), downloadSpeed: String(speed) }
}

test('进度：totalLength 为 0 或缺失时返回 0（不做除零）', () => {
    assert.equal(aria2Progress({ totalLength: '0', completedLength: '100' }), 0)
    assert.equal(aria2Progress({ completedLength: '100' }), 0)
    assert.equal(aria2Progress({ totalLength: 'abc', completedLength: '100' }), 0)
})

test('进度：超过总量时钳到 1（服务端偶发 completedLength > totalLength）', () => {
    assert.equal(aria2Progress({ totalLength: '100', completedLength: '150' }), 1)
    assert.equal(aria2Progress({ totalLength: '100', completedLength: '50' }), 0.5)
})

test('过期时间：没有 expires 参数或 URL 非法时视为 -Infinity', () => {
    assert.equal(uriExpiresAt('https://example.com/a.mp4'), -Infinity)
    assert.equal(uriExpiresAt('not a url'), -Infinity)
    assert.equal(uriExpiresAt('https://example.com/a.mp4?expires=1700000000'), 1_700_000_000)
})

test('任务过期时间：多 URL 取最晚的那个（说明任务还能撑更久）', () => {
    const status = { files: [{ uris: [{ uri: 'https://e.com/a?expires=100' }, { uri: 'https://e.com/b?expires=300' }] }, { uris: [{ uri: 'https://e.com/c?expires=200' }] }] }
    assert.equal(taskLatestExpiry(status), 300)
})

test('任务过期时间：没有任何可用 URL 时返回 -Infinity', () => {
    assert.equal(taskLatestExpiry({}), -Infinity)
    assert.equal(taskLatestExpiry({ files: [{ uris: [] }] }), -Infinity)
})

test('gid 优先级：active > waiting > paused/complete > 其他', () => {
    assert.ok(gidPriority('active') > gidPriority('waiting'))
    assert.ok(gidPriority('waiting') > gidPriority('paused'))
    assert.equal(gidPriority('paused'), gidPriority('complete'))
    assert.ok(gidPriority('complete') > gidPriority('error'))
})

test('择优：过期时间晚的胜出，即便对方状态更活跃', () => {
    const alive = { gid: 'g1', status: 'waiting' as const, files: [{ uris: [{ uri: 'https://e.com/a?expires=200' }] }] }
    const expiring = { gid: 'g2', status: 'active' as const, files: [{ uris: [{ uri: 'https://e.com/b?expires=100' }] }] }
    assert.ok(compareForKeep(alive, expiring) < 0, '过期晚的应排在前')
    assert.ok(compareForKeep(expiring, alive) > 0)
})

test('择优：过期时间相同才比活跃度', () => {
    const waiting = { gid: 'g1', status: 'waiting' as const, files: [{ uris: [{ uri: 'https://e.com/a?expires=100' }] }] }
    const activeTask = { gid: 'g2', status: 'active' as const, files: [{ uris: [{ uri: 'https://e.com/b?expires=100' }] }] }
    assert.ok(compareForKeep(activeTask, waiting) < 0)
})

test('择优：都相同时优先保留队列正在跟踪的那个 gid', () => {
    const a = { gid: 'g1', status: 'active' as const, files: [] }
    const b = { gid: 'g2', status: 'active' as const, files: [] }
    assert.ok(compareForKeep(a, b, 'g2') > 0)
    assert.ok(compareForKeep(a, b, 'g1') < 0)
    assert.equal(compareForKeep(a, b), 0)
})

test('慢速重启：首次观察只记录，不重启', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), undefined, now, GRACE), false)
})

test('慢速重启：未跨过观察窗口不重启', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), now - 1000, now, GRACE), false)
})

test('慢速重启：跨过窗口仍低速则重启', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), now - GRACE - 1, now, GRACE), true)
})

test('慢速重启：速度高于阈值的活跃任务不动', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, SLOW_SPEED_THRESHOLD + 1), now - GRACE - 1, now, GRACE), false)
})

test('慢速重启：非 active 状态不走慢速判定', () => {
    const paused = { ...active(1000, 10_000, 0), status: 'paused' as const }
    assert.equal(shouldRestartForSlowSpeed(paused, now - GRACE - 1, now, GRACE), false)
})

test('慢速重启：进度 ≥98% 且速度非 0 时豁免（别把快下完的任务重启掉）', () => {
    assert.equal(shouldRestartForSlowSpeed(active(99, 100, 1024), now - GRACE - 1, now, GRACE), false)
})

test('慢速重启：速度为 0 时不豁免 98%（连接已死，等下去没有意义）', () => {
    assert.equal(shouldRestartForSlowSpeed(active(99, 100, 0), now - GRACE - 1, now, GRACE), true)
})

test('重试上限：达到 MAX_RECOVER_ATTEMPTS 即用尽', () => {
    assert.equal(recoverExhausted(MAX_RECOVER_ATTEMPTS - 1), false)
    assert.equal(recoverExhausted(MAX_RECOVER_ATTEMPTS), true)
})

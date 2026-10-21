/**
 * aria2 恢复判据（`shared/aria2Recover.ts`）。
 *
 * 这些判据决定「要不要动用户的下载任务」——重建/换地址/重启都会打断正在跑的下载。
 * 判错的两个方向都很难看：过松 → 反复重启，白丢已下好的进度；过紧 → 死了的任务永远不救。
 * 所以每条规则都单钉用例，尤其是「98% 豁免」与「速度 0 不豁免」这两个反直觉分支。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_RECOVER_ATTEMPTS, MIN_SLOW_POLLS, SLOW_SPEED_THRESHOLD, aria2Progress, buildChangeUriParams, canRebuildFromOldUris, compareForKeep, emptyScanMemory, gidPriority, parseScanMemory, recoverExhausted, shouldRestartForSlowSpeed, taskLatestExpiry } from '../src/shared/aria2Recover'
import { uriExpiresAt } from '../src/shared/url'

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
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), undefined), false)
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), MIN_SLOW_POLLS - 1), false)
})

test('慢速重启：达到采样次数阈值则重启（第 2 次扫描动手）', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), MIN_SLOW_POLLS), true)
})

test('慢速重启：速度高于阈值的活跃任务不动', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, SLOW_SPEED_THRESHOLD + 1), MIN_SLOW_POLLS), false)
})

test('慢速重启：非 active 状态不走慢速判定', () => {
    const paused = { ...active(1000, 10_000, 0), status: 'paused' as const }
    assert.equal(shouldRestartForSlowSpeed(paused, MIN_SLOW_POLLS), false)
})

test('慢速重启：进度 ≥98% 且速度非 0 时豁免（别把快下完的任务重启掉）', () => {
    assert.equal(shouldRestartForSlowSpeed(active(99, 100, 1024), MIN_SLOW_POLLS), false)
})

test('慢速重启：速度为 0 时不豁免 98%（连接已死，等下去没有意义）', () => {
    assert.equal(shouldRestartForSlowSpeed(active(99, 100, 0), MIN_SLOW_POLLS), true)
})

test('扫描记忆：缺失或非对象时返回空表', () => {
    assert.deepEqual(parseScanMemory(undefined), emptyScanMemory())
    assert.deepEqual(parseScanMemory(null), emptyScanMemory())
    assert.deepEqual(parseScanMemory('broken'), emptyScanMemory())
    assert.deepEqual(parseScanMemory({ slowPolls: 'x', recoverAttempts: 3 }), emptyScanMemory())
})

test('扫描记忆：丢弃脏计数（否则写坏的值会让任务无限重启或永不重启）', () => {
    const parsed = parseScanMemory({
        slowPolls: { good: 2, zero: 0, negative: -1, nan: Number.NaN, text: '3', huge: 99_999 },
        recoverAttempts: { ok: 1 }
    })
    assert.deepEqual(parsed.slowPolls, { good: 2 })
    assert.deepEqual(parsed.recoverAttempts, { ok: 1 })
})

test('扫描记忆：正常值原样保留（跨 SW 回收后「连续 N 次」才能接着数）', () => {
    const parsed = parseScanMemory({ slowPolls: { videoA: 1 }, recoverAttempts: { videoB: 7 } })
    assert.equal(parsed.slowPolls['videoA'], 1)
    assert.equal(parsed.recoverAttempts['videoB'], 7)
})

test('重试上限：达到 MAX_RECOVER_ATTEMPTS 即用尽', () => {
    assert.equal(recoverExhausted(MAX_RECOVER_ATTEMPTS - 1), false)
    assert.equal(recoverExhausted(MAX_RECOVER_ATTEMPTS), true)
})

test('重建兜底：有新鲜地址时任何状态都能重建', () => {
    for (const status of ['active', 'waiting', 'paused', 'error', 'removed']) {
        assert.equal(canRebuildFromOldUris(status, true), true, status)
    }
})

test('重建兜底：没有新鲜地址时只允许对已死的任务用旧地址', () => {
    assert.equal(canRebuildFromOldUris('error', false), true)
    assert.equal(canRebuildFromOldUris('removed', false), true)
})

test('重建兜底：活着的任务不得用旧地址重建（这是 87 个真实任务被复制的根因）', () => {
    for (const status of ['active', 'waiting', 'paused']) {
        assert.equal(canRebuildFromOldUris(status, false), false, status)
    }
})

test('changeUri 参数：fileIndex 必须是 1（传 0 被 aria2 拒绝）', () => {
    const params = buildChangeUriParams('gid1', ['old'], ['new'])
    assert.deepEqual(params, ['gid1', 1, ['old'], ['new'], 0])
    assert.ok((params[1] as number) >= 1, 'aria2: the value must be greater than or equal to 1')
})

test('changeUri 参数：position 必须显式给 0（否则新地址只追加到队尾，旧地址仍被使用）', () => {
    const params = buildChangeUriParams('gid1', ['old'], ['new'])
    assert.equal(params.length, 5, '缺 position 时 aria2 会把新 URI 追加到末尾')
    assert.equal(params[4], 0)
})

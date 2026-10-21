/**
 * 「下载完成后推送 MediaCenter」的待重试判据（`shared/mediaCenterPush.ts`）。
 *
 * 这组判据决定「要不要再打一次用户的服务」——判错的代价不是崩溃，而是
 * 要么一次失败就永久丢弃（用户的服务里缺一条记录，且界面上看不出来），
 * 要么永远每 5 分钟打一次填错的端点。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_PUSH_ATTEMPTS, PUSH_RETRY_INTERVAL_MS, isPushExhausted, nextPendingPush, parsePendingPushes, shouldRetryPush, type PendingMediaCenterPush } from '../src/shared/mediaCenterPush'

const now = 1_700_000_000_000

function entry(overrides: Partial<PendingMediaCenterPush> = {}): PendingMediaCenterPush {
    return { videoId: 'v1', lastAttemptAt: now, attempts: 1, ...overrides }
}

test('重试间隔取自源实现（5 分钟）', () => {
    assert.equal(PUSH_RETRY_INTERVAL_MS, 5 * 60 * 1000)
})

test('刚试过：不到间隔不重试', () => {
    assert.equal(shouldRetryPush(entry({ lastAttemptAt: now }), now), false)
    assert.equal(shouldRetryPush(entry({ lastAttemptAt: now - PUSH_RETRY_INTERVAL_MS + 1 }), now), false)
})

test('跨过间隔：重试', () => {
    assert.equal(shouldRetryPush(entry({ lastAttemptAt: now - PUSH_RETRY_INTERVAL_MS }), now), true)
    assert.equal(shouldRetryPush(entry({ lastAttemptAt: now - 60 * 60 * 1000 }), now), true)
})

test('超过重试上限：不再重试（源项目无上限，这里是为了不永远打端点）', () => {
    const exhausted = entry({ lastAttemptAt: now - 60 * 60 * 1000, attempts: MAX_PUSH_ATTEMPTS })
    assert.equal(isPushExhausted(exhausted), true)
    assert.equal(shouldRetryPush(exhausted, now), false)
    assert.equal(isPushExhausted(entry({ attempts: MAX_PUSH_ATTEMPTS - 1 })), false)
})

test('脏时间戳不重试（否则写坏的值会让任务永远卡在待推送表里）', () => {
    assert.equal(shouldRetryPush(entry({ lastAttemptAt: Number.NaN }), now), false)
    assert.equal(shouldRetryPush(entry({ lastAttemptAt: Number.POSITIVE_INFINITY }), now), false)
})

test('登记：首次 attempts = 1（调用方已经试过一次才登记）', () => {
    const first = nextPendingPush(undefined, 'v1', 'a.mp4', now)
    assert.equal(first.attempts, 1)
    assert.equal(first.filename, 'a.mp4')
    assert.equal(first.lastAttemptAt, now)
})

test('登记：已有记录时累加 attempts 并刷新时间戳', () => {
    const second = nextPendingPush(entry({ attempts: 3 }), 'v1', undefined, now + 1)
    assert.equal(second.attempts, 4)
    assert.equal(second.lastAttemptAt, now + 1)
    assert.equal(second.filename, undefined)
})

test('登记：新的 filename 覆盖旧的（文件名只在完成时才知道）', () => {
    const next = nextPendingPush(entry({ filename: 'old.mp4' }), 'v1', 'new.mp4', now)
    assert.equal(next.filename, 'new.mp4')
})

test('解析：非对象/空值返回空表', () => {
    assert.deepEqual(parsePendingPushes(undefined), {})
    assert.deepEqual(parsePendingPushes(null), {})
    assert.deepEqual(parsePendingPushes('x'), {})
    assert.deepEqual(parsePendingPushes(42), {})
})

test('解析：逐条丢弃脏记录，不影响其余（一条写坏不该让机制停摆）', () => {
    const parsed = parsePendingPushes({
        good: { videoId: 'good', lastAttemptAt: now, attempts: 2, filename: 'a.mp4' },
        noId: { lastAttemptAt: now, attempts: 1 },
        noTime: { videoId: 'x', attempts: 1 },
        badTime: { videoId: 'y', lastAttemptAt: 'soon', attempts: 1 },
        noAttempts: { videoId: 'z', lastAttemptAt: now },
        notObject: 'oops'
    })
    assert.deepEqual(Object.keys(parsed), ['good'])
    assert.deepEqual(parsed['good'], { videoId: 'good', lastAttemptAt: now, attempts: 2, filename: 'a.mp4' })
})

test('解析：可重试的记录读回后仍可重试（跨浏览器重启不丢）', () => {
    const raw = { v1: { videoId: 'v1', lastAttemptAt: now - PUSH_RETRY_INTERVAL_MS - 1, attempts: 2 } }
    const parsed = parsePendingPushes(raw)
    assert.equal(shouldRetryPush(parsed['v1']!, now), true)
})

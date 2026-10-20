/**
 * 「关注扩展作者」的状态闸门 —— 纯函数单测。
 *
 * 为什么值得单测：该功能**默认开启**，而 `boot()` 在每次 service worker 唤醒时都会跑
 * （Chrome SW 空闲约 30 秒挂起）。闸门写错 = 每 30 秒请求一次站点 API，
 * 用户看不到任何报错，只会觉得"扩展有点耗流量"。这类回归必须由测试挡住。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { nextPromoteState, PROMOTE_RETRY_MS, shouldAttemptPromote } from '../src/background/iwara/promoteAuthor'

const NOW = 1_700_000_000_000

test('首次运行（无状态）应当尝试', () => {
    assert.equal(shouldAttemptPromote(undefined, NOW), true)
    assert.equal(shouldAttemptPromote({}, NOW), true)
})

test('已完成之后永远不再尝试（零网络）', () => {
    assert.equal(shouldAttemptPromote({ done: true }, NOW), false)
    assert.equal(shouldAttemptPromote({ done: true, lastAttemptAt: NOW - PROMOTE_RETRY_MS * 10 }, NOW), false)
})

test('失败后 24 小时内不重试，超过后再试', () => {
    const failedState = { done: false, lastAttemptAt: NOW - 1000 }
    assert.equal(shouldAttemptPromote(failedState, NOW), false)
    // 差 1ms 到 24h：仍然不试
    assert.equal(shouldAttemptPromote({ lastAttemptAt: NOW - PROMOTE_RETRY_MS + 1 }, NOW), false)
    // 刚好到 24h：允许重试
    assert.equal(shouldAttemptPromote({ lastAttemptAt: NOW - PROMOTE_RETRY_MS }, NOW), true)
})

test('nextPromoteState：done 只增不减，lastAttemptAt 每次刷新', () => {
    assert.deepEqual(nextPromoteState(undefined, false, NOW), { done: false, lastAttemptAt: NOW })
    assert.deepEqual(nextPromoteState({ done: true, lastAttemptAt: NOW - 5 }, false, NOW), { done: true, lastAttemptAt: NOW })
    assert.deepEqual(nextPromoteState({ done: false, lastAttemptAt: NOW - 5 }, true, NOW), { done: true, lastAttemptAt: NOW })
})

/**
 * 后端容量/状态解析（`shared/backendStats.ts`）。
 *
 * 这些判据错了不会报错，只会「界面看起来很合理但说的是假话」：
 * 把 `waiting` 当 `active` → 用户以为带宽被占满；把脏值当 0 → 界面显示「空闲」而实际在下。
 * 所以每个边界都钉一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBackendQueuedStatus, parseAria2GlobalStat, parseAria2MaxConcurrent, summarizeIwaradl } from '../src/shared/backendStats'

test('getGlobalStat：字符串数字被解析成整数', () => {
    assert.deepEqual(parseAria2GlobalStat({ numActive: '2', numWaiting: '3', numStopped: '10', downloadSpeed: '1048576' }), { active: 2, waiting: 3, stopped: 10, downloadSpeed: 1048576 })
})

test('getGlobalStat：缺字段当 0，但形状明显不对时返回 undefined', () => {
    // 只有 numActive：其余字段缺失是合法情况（老版本 aria2 也有这些字段，但不必假设）
    assert.deepEqual(parseAria2GlobalStat({ numActive: '1' }), { active: 1, waiting: 0, stopped: 0, downloadSpeed: 0 })
    // 完全不是 aria2 的响应 → 调用方据此提示端点配错，而不是显示「空闲」
    assert.equal(parseAria2GlobalStat(null), undefined)
    assert.equal(parseAria2GlobalStat([]), undefined)
    assert.equal(parseAria2GlobalStat('OK'), undefined)
    assert.equal(parseAria2GlobalStat({ unrelated: 1 }), undefined)
})

test('getGlobalStat：脏数字不会感染成 NaN', () => {
    assert.deepEqual(parseAria2GlobalStat({ numActive: 'abc', numWaiting: '-4', numStopped: '1.9', downloadSpeed: null }), { active: 0, waiting: 0, stopped: 1, downloadSpeed: 0 })
})

test('max-concurrent-downloads：字符串数字转正整数，非法值返回 undefined（不冒充默认值）', () => {
    assert.equal(parseAria2MaxConcurrent({ 'max-concurrent-downloads': '5' }), 5)
    assert.equal(parseAria2MaxConcurrent({ 'max-concurrent-downloads': 8 }), 8)
    assert.equal(parseAria2MaxConcurrent({ 'max-concurrent-downloads': '0' }), undefined)
    assert.equal(parseAria2MaxConcurrent({ 'max-concurrent-downloads': 'abc' }), undefined)
    assert.equal(parseAria2MaxConcurrent({}), undefined)
    assert.equal(parseAria2MaxConcurrent(undefined), undefined)
})

test('iwaradl 统计：四种状态各归其位', () => {
    const stats = summarizeIwaradl([{ status: 'running' }, { status: 'running' }, { status: 'pending' }, { status: 'completed' }, { status: 'failed' }])
    assert.deepEqual(stats, { running: 2, pending: 1, completed: 1, failed: 1 })
})

test('iwaradl 统计：空列表是合法的（队列里没有任务）', () => {
    assert.deepEqual(summarizeIwaradl([]), { running: 0, pending: 0, completed: 0, failed: 0 })
})

test('排队状态判定：waiting / paused / pending 都不是「正在下载」', () => {
    assert.equal(isBackendQueuedStatus('waiting'), true)
    assert.equal(isBackendQueuedStatus('paused'), true)
    assert.equal(isBackendQueuedStatus('pending'), true)
    assert.equal(isBackendQueuedStatus('active'), false)
    assert.equal(isBackendQueuedStatus('running'), false)
})

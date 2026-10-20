/**
 * 浏览器内建下载的「同时下载数」判据（`shared/browserConcurrency.ts`）。
 *
 * 这两条判据错了不会报错，只会「看起来在跑」：
 * - 槽位判定算错 → 要么把上限当摆设（并发失控），要么一个都启动不了（死等）；
 * - 排队挑选算错 → 后入队的先下（用户会觉得「按了没反应」），或者挑到非浏览器任务。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_CONCURRENCY_DEFAULT, BROWSER_CONCURRENCY_MAX, BROWSER_CONCURRENCY_MIN, browserConcurrencyLimit, nextQueuedBrowserTask, slotAvailable } from '../src/shared/browserConcurrency'
import type { QueueTask } from '../src/shared/task'

function task(overrides: Partial<QueueTask> = {}): QueueTask {
    return { id: overrides.id ?? 't1', videoId: 'v1', kind: 'browser', status: 'queued', ...overrides }
}

test('槽位判定：空队列 + 上限 3 → 有空位', () => {
    assert.equal(slotAvailable(0, 0, 3), true)
    assert.equal(slotAvailable(2, 0, 3), true)
})

test('槽位判定：达到上限就没有空位（等于也不行，上限是「最多同时 N 个」）', () => {
    assert.equal(slotAvailable(3, 0, 3), false)
    assert.equal(slotAvailable(10, 0, 3), false)
})

test('槽位判定：启动中的任务也要占位（否则同一 tick 里会超额启动）', () => {
    assert.equal(slotAvailable(1, 2, 3), false)
    assert.equal(slotAvailable(0, 3, 3), false)
})

test('上限归一：脏值不外溢，夹到 1~10 并取整', () => {
    assert.equal(browserConcurrencyLimit(0), BROWSER_CONCURRENCY_MIN)
    assert.equal(browserConcurrencyLimit(-5), BROWSER_CONCURRENCY_MIN)
    assert.equal(browserConcurrencyLimit(999), BROWSER_CONCURRENCY_MAX)
    assert.equal(browserConcurrencyLimit(2.9), 2)
    assert.equal(browserConcurrencyLimit(Number.NaN), BROWSER_CONCURRENCY_DEFAULT)
    assert.equal(browserConcurrencyLimit(Number.POSITIVE_INFINITY), BROWSER_CONCURRENCY_DEFAULT)
})

test('排队挑选：只认 browser + queued（运行中/已完成/其它通道都不算候选）', () => {
    const tasks = [task({ id: 'running', status: 'running', createdAt: 1 }), task({ id: 'aria2', kind: 'aria2', createdAt: 2 }), task({ id: 'done', status: 'complete', createdAt: 3 })]
    assert.equal(nextQueuedBrowserTask(tasks), undefined)
    assert.equal(nextQueuedBrowserTask([...tasks, task({ id: 'q', createdAt: 4 })])?.id, 'q')
})

test('排队挑选：先进先出（按入队时间，不是数组顺序）', () => {
    const tasks = [task({ id: 'late', createdAt: 300 }), task({ id: 'early', createdAt: 100 }), task({ id: 'middle', createdAt: 200 })]
    assert.equal(nextQueuedBrowserTask(tasks)?.id, 'early')
})

test('排队挑选：缺 createdAt 的记录排最后（不能因为缺字段就插队）', () => {
    const tasks = [task({ id: 'legacy' }), task({ id: 'normal', createdAt: 500 })]
    assert.equal(nextQueuedBrowserTask(tasks)?.id, 'normal')
    // 只有缺时间戳的记录时仍然要能挑出来，否则它们永远启动不了
    assert.equal(nextQueuedBrowserTask([task({ id: 'legacy' })])?.id, 'legacy')
})

/**
 * 受限并发池（`shared/concurrency`）。
 *
 * 这组判据错得越离谱越难发现：并发度写错可能只是慢一点；「失败后仍在派发」
 * 会让调用方以为只提交了 N 个任务，实际却打出了 N+ 个；「少派发」则会静默漏数据
 * （分页扫描少扫一页 = 映射认领不完整 = 阶段二往服务端造重复条目）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConcurrency, runPool } from '../src/shared/concurrency'

test('并发度归一：脏值一律夹到 1 以上', () => {
    assert.equal(normalizeConcurrency(undefined), 1)
    assert.equal(normalizeConcurrency(0), 1)
    assert.equal(normalizeConcurrency(-3), 1)
    assert.equal(normalizeConcurrency(Number.NaN), 1)
    assert.equal(normalizeConcurrency(Number.POSITIVE_INFINITY), 1)
    assert.equal(normalizeConcurrency(4.9), 4)
    assert.equal(normalizeConcurrency(6), 6)
})

test('空数组立即返回：不创建 worker、不抛错', async () => {
    let calls = 0
    await runPool([], async () => {
        calls++
    })
    assert.equal(calls, 0)
})

test('每个条目恰好执行一次，index 与条目对应', async () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    const seen: Array<[string, number]> = []
    await runPool(
        items,
        async (item, index) => {
            seen.push([item, index])
        },
        { concurrency: 3 }
    )
    assert.equal(seen.length, items.length)
    for (const [item, index] of seen) assert.equal(items[index], item)
    assert.deepEqual([...seen].map(([item]) => item).sort(), [...items].sort())
})

test('并发峰值不超过上限', async () => {
    let inFlight = 0
    let peak = 0
    await runPool(
        Array.from({ length: 40 }, (_value, index) => index),
        async () => {
            inFlight++
            peak = Math.max(peak, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 2))
            inFlight--
        },
        { concurrency: 5 }
    )
    assert.equal(peak, 5)
})

test('上限大于条目数时不空转：worker 数按条目数收敛', async () => {
    let calls = 0
    await runPool(
        [1, 2],
        async () => {
            calls++
        },
        { concurrency: 10 }
    )
    assert.equal(calls, 2)
})

test('worker 抛错：停止派发新条目，等已开始的收尾，然后抛出第一个错误', async () => {
    const started: number[] = []
    const finished: number[] = []
    const error = new Error('boom')
    await assert.rejects(
        () =>
            runPool(
                Array.from({ length: 20 }, (_value, index) => index),
                async (index) => {
                    started.push(index)
                    if (index === 2) throw error
                    await new Promise((resolve) => setTimeout(resolve, 10))
                    finished.push(index)
                },
                { concurrency: 3 }
            ),
        /boom/
    )
    // 失败那条之后不许再派发（并发的 3 个可能在失败瞬间都已派发，所以允许到 3）
    assert.ok(started.length <= 6, `失败后仍在派发：started=${started.length}`)
    // 抛错必须发生在「已开始的都收尾」之后，不能与仍在进行的写操作交错
    assert.equal(finished.length, started.length - 1)
})

test('shouldStop 提前结束：不抛错、不再派发剩余条目', async () => {
    const done: number[] = []
    let stop = false
    await runPool(
        Array.from({ length: 20 }, (_value, index) => index),
        async (index) => {
            done.push(index)
            stop = true
        },
        { concurrency: 1, shouldStop: () => stop }
    )
    assert.deepEqual(done, [0])
})

test('shouldStop 一旦为真就不再派发（并发模式下也不超过已在飞的条目数）', async () => {
    let allow = true
    const started: number[] = []
    await runPool(
        Array.from({ length: 20 }, (_value, index) => index),
        async (index) => {
            started.push(index)
            await new Promise((resolve) => setTimeout(resolve, 1))
            allow = false
        },
        { concurrency: 2, shouldStop: () => !allow }
    )
    assert.ok(started.length <= 4, `shouldStop 后仍在派发：started=${started.length}`)
})

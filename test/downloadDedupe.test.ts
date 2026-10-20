/**
 * 批量下载去重规则（`shared/downloadDedupe.ts`）。
 *
 * 这两条判据都是**会静默吞掉用户下载意图**的决策：判错的方向是「该下的没下」，
 * 用户看不到任何报错，只会以为扩展坏了。所以每条规则单独钉一个用例。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { dedupeAgainstAria2, dedupeAgainstQueue } from '../src/shared/downloadDedupe'
import type { QueueTask } from '../src/shared/task'

function task(videoId: string, status: QueueTask['status'], updatedAt?: number): QueueTask {
    return {
        id: `task-${videoId}-${status}`,
        videoId,
        kind: 'aria2',
        status,
        ...(updatedAt === undefined ? {} : { updatedAt })
    }
}

test('本地队列：已完成的跳过（重新勾选最近下载过的不会重复投递）', () => {
    const result = dedupeAgainstQueue(['a', 'b', 'c'], [task('a', 'complete'), task('b', 'running')])
    assert.deepEqual(result.ids, ['c'])
    assert.deepEqual(result.skipped, ['a', 'b'])
})

test('本地队列：排队中/进行中也跳过（同一视频不并行下两份）', () => {
    const result = dedupeAgainstQueue(['a', 'b'], [task('a', 'queued'), task('b', 'running')])
    assert.deepEqual(result.ids, [])
    assert.deepEqual(result.skipped, ['a', 'b'])
})

test('本地队列：失败的不跳过（用户重新勾选就是想再试一次）', () => {
    const result = dedupeAgainstQueue(['a'], [task('a', 'failed')])
    assert.deepEqual(result.ids, ['a'])
    assert.deepEqual(result.skipped, [])
})

test('本地队列：以最新一条记录为准（失败过、后来重试成功 → 跳过）', () => {
    const result = dedupeAgainstQueue(['a'], [task('a', 'failed', 1000), task('a', 'complete', 2000)])
    assert.deepEqual(result.skipped, ['a'])
})

test('本地队列：最新一条是失败时允许重下（成功过、后来重试失败 → 不跳过）', () => {
    const result = dedupeAgainstQueue(['a'], [task('a', 'complete', 1000), task('a', 'failed', 2000)])
    assert.deepEqual(result.ids, ['a'])
})

test('本地队列：没有时间戳的旧记录不会盖掉带时间戳的新记录', () => {
    const result = dedupeAgainstQueue(['a'], [task('a', 'complete', 2000), task('a', 'failed')])
    assert.deepEqual(result.skipped, ['a'])
})

test('本地队列：保持入参顺序（入队节流按这个顺序跑，顺序变了用户看到的完成次序会乱）', () => {
    const result = dedupeAgainstQueue(['c', 'a', 'b'], [])
    assert.deepEqual(result.ids, ['c', 'a', 'b'])
})

test('本地队列：队列里有别的视频不影响本次（不是「队列非空就全跳过」）', () => {
    const result = dedupeAgainstQueue(['x'], [task('a', 'complete'), task('b', 'complete')])
    assert.deepEqual(result.ids, ['x'])
})

test('aria2：已存在（活跃/等待/已完成）的跳过', () => {
    const result = dedupeAgainstAria2(['a', 'b', 'c'], new Set(['a', 'c']))
    assert.deepEqual(result.ids, ['b'])
    assert.deepEqual(result.skipped, ['a', 'c'])
})

test('本地队列：跳过（第三方网盘链接）的不算已下载，必须允许重新投递', () => {
    // 「跳过」是「上次没下」，不是「下过了」。把它当已完成会静默吞掉用户的下载意图：
    // 用户在列表页重新勾选它、什么都没发生，也无任何提示。
    const result = dedupeAgainstQueue(['a'], [task('a', 'skipped')])
    assert.deepEqual(result.ids, ['a'])
    assert.deepEqual(result.skipped, [])
})

test('本地队列：已交付（外部下载器/iwaradl）不拦重新投递 —— 我们并不知道对方成没成', () => {
    // 拦下来等于替外部下载器宣布成功：用户再勾一次、什么都没发生、也没有任何提示。
    const result = dedupeAgainstQueue(['a'], [task('a', 'handed-off')])
    assert.deepEqual(result.ids, ['a'])
    assert.deepEqual(result.skipped, [])
})

test('aria2：集合为空时原样返回（aria2 里确实没有这些任务）', () => {
    const result = dedupeAgainstAria2(['a', 'b'], new Set())
    assert.deepEqual(result.ids, ['a', 'b'])
    assert.deepEqual(result.skipped, [])
})

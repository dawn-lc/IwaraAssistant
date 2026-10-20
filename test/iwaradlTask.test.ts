/**
 * iwaradl 任务模型（`shared/iwaradlTask.ts`）——第三方响应的容错边界。
 *
 * 守的是两类**静默失效**：
 * - 解析：文档说 `POST /api/tasks` 返回**数组**，旧代码当对象读 `body.id`，
 *   于是永远拿到 undefined、退化成随机 uuid，任务从此不可能被追踪
 * - 映射：`pending` 若被当成 `running`，界面上就会一直说「下载中」而其实还没开始传
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { isIwaradlActive, parseIwaradlTask, parseIwaradlTasks, queueStatusOfIwaradl } from '../src/shared/iwaradlTask'

// ── 单条解析 ────────────────────────────────────────────────────────────

test('正常任务原样解析', () => {
    assert.deepEqual(parseIwaradlTask({ vid: 'abc123', status: 'running', progress: 0.42 }), { vid: 'abc123', status: 'running', progress: 0.42 })
})

test('没有 progress 时不编造字段（结果里就没有这个键）', () => {
    const task = parseIwaradlTask({ vid: 'abc123', status: 'completed' })
    assert.deepEqual(task, { vid: 'abc123', status: 'completed' })
    assert.equal(task !== undefined && 'progress' in task, false)
})

test('超范围进度被夹取，NaN/字符串被丢弃', () => {
    assert.equal(parseIwaradlTask({ vid: 'v', status: 'running', progress: 3 })?.progress, 1)
    assert.equal(parseIwaradlTask({ vid: 'v', status: 'running', progress: -2 })?.progress, 0)
    assert.equal(parseIwaradlTask({ vid: 'v', status: 'running', progress: Number.NaN })?.progress, undefined)
    assert.equal(parseIwaradlTask({ vid: 'v', status: 'running', progress: '0.5' })?.progress, undefined)
})

test('未知状态直接丢弃（宁可少一条，也不要把没见过的值塞进队列）', () => {
    assert.equal(parseIwaradlTask({ vid: 'abc123', status: 'paused' }), undefined)
    assert.equal(parseIwaradlTask({ vid: 'abc123', status: '' }), undefined)
    assert.equal(parseIwaradlTask({ vid: 'abc123' }), undefined)
})

test('缺 vid 或 vid 为空丢弃（主键不可用就等于没有这条记录）', () => {
    assert.equal(parseIwaradlTask({ status: 'running' }), undefined)
    assert.equal(parseIwaradlTask({ vid: '', status: 'running' }), undefined)
    assert.equal(parseIwaradlTask({ vid: 123, status: 'running' }), undefined)
})

test('非对象输入不抛错', () => {
    assert.equal(parseIwaradlTask(null), undefined)
    assert.equal(parseIwaradlTask(undefined), undefined)
    assert.equal(parseIwaradlTask('abc123'), undefined)
    assert.equal(parseIwaradlTask([]), undefined)
})

// ── 列表解析 ────────────────────────────────────────────────────────────

test('列表里坏记录被跳过，其余照常返回', () => {
    const tasks = parseIwaradlTasks([{ vid: 'a', status: 'running', progress: 0.1 }, { vid: 'b', status: 'nonsense' }, { status: 'pending' }, { vid: 'c', status: 'pending' }])
    assert.deepEqual(
        tasks.map((task) => task.vid),
        ['a', 'c']
    )
})

test('响应不是数组 → 空列表（说明对端不是 iwaradl，调用方据此判不可达）', () => {
    assert.deepEqual(parseIwaradlTasks({ vid: 'a', status: 'running' }), [])
    assert.deepEqual(parseIwaradlTasks(null), [])
    assert.deepEqual(parseIwaradlTasks('[]'), [])
})

test('空数组合法（队列里没有任务也是正常状态）', () => {
    assert.deepEqual(parseIwaradlTasks([]), [])
})

// ── 状态映射 ────────────────────────────────────────────────────────────

test('四个状态各归其位', () => {
    assert.equal(queueStatusOfIwaradl('pending'), 'queued')
    assert.equal(queueStatusOfIwaradl('running'), 'running')
    assert.equal(queueStatusOfIwaradl('completed'), 'complete')
    assert.equal(queueStatusOfIwaradl('failed'), 'failed')
})

test('pending 不算活跃下载，但仍需继续轮询', () => {
    assert.equal(isIwaradlActive('pending'), true)
    assert.equal(isIwaradlActive('running'), true)
    assert.equal(isIwaradlActive('completed'), false)
    assert.equal(isIwaradlActive('failed'), false)
})

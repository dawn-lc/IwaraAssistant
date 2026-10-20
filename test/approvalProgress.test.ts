/**
 * 审批进度判据的单元测试。
 *
 * 关键不变量：**不确定态不能被画成 0%**。`collecting` 阶段后台在递归拉评论证据，
 * 请求总数根本无法预知；此时若返回 0，进度条会停在那里假装「刚开始」，
 * 用户会以为卡住了——比不显示进度条更糟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDLE_FRIEND_APPROVE_PROGRESS, friendApproveRatio, friendApproveView, settleInterrupted, type FriendApproveProgress } from '../src/shared/approvalProgress'

function progress(overrides: Partial<FriendApproveProgress>): FriendApproveProgress {
    return { ...IDLE_FRIEND_APPROVE_PROGRESS, running: true, phase: 'deciding', total: 10, ...overrides }
}

const SAMPLE_RESULT = { total: 3, approved: 2, skipped: 1, failed: 0, lines: ['已批准 a(u1)'] }

test('未运行 / 无进度记录：不给比例（调用方据此隐藏进度条）', () => {
    assert.equal(friendApproveRatio(null), undefined)
    assert.equal(friendApproveRatio(undefined), undefined)
    assert.equal(friendApproveRatio(IDLE_FRIEND_APPROVE_PROGRESS), undefined)
    assert.equal(friendApproveRatio(progress({ running: false })), undefined)
})

test('collecting 阶段是不确定态，而不是 0%', () => {
    assert.equal(friendApproveRatio(progress({ phase: 'collecting', done: 0, total: 0 })), undefined)
    // 即使 total 已经拿到（列表拉完、正在抓评论证据），也不该给百分比
    assert.equal(friendApproveRatio(progress({ phase: 'collecting', done: 0, total: 42 })), undefined)
})

test('deciding 阶段按 done / total 给确定态比例', () => {
    assert.equal(friendApproveRatio(progress({ done: 0, total: 10 })), 0)
    assert.equal(friendApproveRatio(progress({ done: 5, total: 10 })), 0.5)
    assert.equal(friendApproveRatio(progress({ done: 10, total: 10 })), 1)
})

test('total 未知（0）时仍是确定态缺失，不能除零得到 NaN/Infinity', () => {
    const ratio = friendApproveRatio(progress({ done: 3, total: 0 }))
    assert.equal(ratio, undefined)
})

test('比例被夹在 0~1（脏数据不能把进度条画到容器外）', () => {
    assert.equal(friendApproveRatio(progress({ done: 20, total: 10 })), 1)
    assert.equal(friendApproveRatio(progress({ done: -5, total: 10 })), 0)
})

/**
 * 崩溃残骸的归一。
 *
 * 这是本模块存在的核心理由：`running` 的真相在内存（任务对象），持久层里的
 * `running: true` 只可能是上一个进程留下的。**判定依据是不变量，不是心跳超时**——
 * `collecting` 阶段可能几分钟不更新进度，用超时必然误杀。
 */
test('残骸：存储说在跑、内存没任务 → 判定为已中断（而不是永远转圈）', () => {
    const stale = progress({ running: true, done: 37, total: 100, updatedAt: 1_700_000_000_000 })
    const settled = settleInterrupted(stale, false)
    assert.ok(settled, '必须给出修正后的记录')
    assert.equal(settled.running, false)
    assert.equal(settled.aborted, true)
    // 中断时间用最后一次写入时间：那是我们能确定的最后活着的时刻
    assert.equal(settled.finishedAt, 1_700_000_000_000)
    // 进度本身保留，界面可以说明「停在 37/100」
    assert.equal(settled.done, 37)
    assert.equal(settled.total, 100)
    // 纯函数：不改入参
    assert.equal(stale.running, true)
})

test('残骸：任务确实还活着时一个字都不改', () => {
    const live = progress({ running: true })
    assert.equal(settleInterrupted(live, true), null)
})

test('残骸：本来就没在跑（终态 / 无记录）不需要修', () => {
    assert.equal(settleInterrupted(null, false), null)
    assert.equal(settleInterrupted(IDLE_FRIEND_APPROVE_PROGRESS, false), null)
    assert.equal(settleInterrupted(progress({ running: false, result: SAMPLE_RESULT }), false), null)
})

test('残骸：updatedAt 缺失时退回当前时间，不产生 0 或 NaN', () => {
    const settled = settleInterrupted(progress({ running: true, updatedAt: 0 }), false)
    assert.ok(settled)
    assert.ok(settled.finishedAt > 0)
})

test('界面派生：运行中 → 显示进度、不显示上次结果', () => {
    const view = friendApproveView(progress({ running: true, done: 5, total: 10, result: SAMPLE_RESULT }))
    assert.equal(view.running, true)
    assert.equal(view.aborted, false)
    assert.equal(view.ratio, 0.5)
    // 旧的逐条结果不能和新的进度条同时出现
    assert.equal(view.result, undefined)
})

test('界面派生：collecting → 进度条走不确定态', () => {
    const view = friendApproveView(progress({ running: true, phase: 'collecting', total: 0 }))
    assert.equal(view.running, true)
    assert.equal(view.ratio, undefined)
})

test('界面派生：已中断 → 不显示进度条，给出中断说明，也不显示结果', () => {
    const view = friendApproveView({ ...progress({ running: false }), aborted: true, finishedAt: 1 })
    assert.equal(view.running, false)
    assert.equal(view.aborted, true)
    assert.equal(view.ratio, undefined)
    assert.equal(view.result, undefined)
})

test('界面派生：正常结束 → 显示终态结果', () => {
    const view = friendApproveView(progress({ running: false, done: 3, total: 3, result: SAMPLE_RESULT }))
    assert.equal(view.running, false)
    assert.equal(view.aborted, false)
    assert.equal(view.result, SAMPLE_RESULT)
})

test('界面派生：无快照（后台还没响应）= 什么都不显示，而不是空转', () => {
    const view = friendApproveView(null)
    assert.deepEqual(view, { running: false, aborted: false, ratio: undefined, result: undefined })
})

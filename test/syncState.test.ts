/**
 * 站点遍历快照的解析与不变量。
 *
 * 这份形状从 `background/iwara/pageSync` 挪到 `shared/` 的唯一理由是：
 * 后台写它、options 读它，而 options 不能 import background。挪出来之后
 * 「脏值怎么办」就必须有明确答案——这份数据是 `storage.local`，
 * 上一代字段、手工调试、扩展降级都会留下形状不对的值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceSyncCursor, IDLE_SYNC_CURSOR, IDLE_SYNC_STATE, parseSyncCursor, parseSyncCursorOrIdle, parseSyncState, type SyncState } from '../src/shared/syncState'

function state(overrides: Partial<SyncState>): SyncState {
    return { ...IDLE_SYNC_STATE, running: true, kind: 'all', updatedAt: 1_700_000_000_000, ...overrides }
}

test('非对象 / 缺 running 一律不可信（返回 null，让调用方保留上一份快照）', () => {
    assert.equal(parseSyncState(undefined), null)
    assert.equal(parseSyncState(null), null)
    assert.equal(parseSyncState('running'), null)
    assert.equal(parseSyncState(0), null)
    assert.equal(parseSyncState({ kind: 'all', page: 3 }), null)
})

test('running:true 却没有 kind = 自相矛盾（进度条会渲染成「未知遍历」）', () => {
    assert.equal(parseSyncState(state({ running: true, kind: null })), null)
    // 反过来是合法的：已结束的遍历不必记住它是哪一次
    assert.equal(parseSyncState({ ...state({}), running: false, kind: null })?.kind, null)
})

test('未知 kind 在已结束时回落为 null，而不是原样带出来', () => {
    const parsed = parseSyncState({ ...state({}), running: false, kind: 'media' })
    assert.ok(parsed)
    assert.equal(parsed.kind, null)
})

test('脏计数回 0、负数夹 0（进度条不能画到容器外）', () => {
    const parsed = parseSyncState({ ...state({}), page: 'x', succeeded: -2, failed: NaN, updatedAt: Infinity })
    assert.ok(parsed)
    assert.deepEqual({ page: parsed.page, succeeded: parsed.succeeded, failed: parsed.failed, updatedAt: parsed.updatedAt }, { page: 0, succeeded: 0, failed: 0, updatedAt: 0 })
})

test('message 不是字符串时回落空串（界面按空值隐藏状态行）', () => {
    assert.equal(parseSyncState({ ...state({}), message: { text: 'x' } })?.message, '')
    assert.equal(parseSyncState(state({ message: '已遍历 3 页' }))?.message, '已遍历 3 页')
})

test('正常值原样通过（含运行中与终态）', () => {
    assert.deepEqual(parseSyncState(state({ page: 3, succeeded: 42, failed: 1, message: '已遍历 3 页' })), {
        running: true,
        kind: 'all',
        page: 3,
        succeeded: 42,
        failed: 1,
        message: '已遍历 3 页',
        updatedAt: 1_700_000_000_000
    })
    const done = parseSyncState({ ...state({}), running: false, kind: 'subscribed', page: 7, failed: 2 })
    assert.ok(done)
    assert.equal(done.running, false)
    assert.equal(done.kind, 'subscribed')
    assert.equal(done.page, 7)
    assert.equal(done.failed, 2)
})

test('空闲常量本身可被解析回同一个值（首屏与脏值回落都用它）', () => {
    assert.deepEqual(parseSyncState(IDLE_SYNC_STATE), IDLE_SYNC_STATE)
})

// ── 断点游标（全站遍历续跑）────────────────────────────────────────────

test('游标：非对象 / 缺页码 / 负数页码一律不可信（按「没有游标」处理）', () => {
    assert.equal(parseSyncCursor(undefined), null)
    assert.equal(parseSyncCursor(null), null)
    assert.equal(parseSyncCursor({ updatedAt: 1 }), null)
    assert.equal(parseSyncCursor({ nextPage: -1 }), null)
    assert.equal(parseSyncCursor({ nextPage: NaN }), null)
    assert.equal(parseSyncCursor({ nextPage: '3' }), null)
})

test('游标：合法值原样通过，时间戳坏了只影响「多旧」不影响「从哪开始」', () => {
    assert.deepEqual(parseSyncCursor({ nextPage: 0, updatedAt: 5 }), { nextPage: 0, updatedAt: 5 })
    assert.deepEqual(parseSyncCursor({ nextPage: 12, updatedAt: 'x' }), { nextPage: 12, updatedAt: 0 })
    // 小数页码向下取整：游标只可能是整数页
    assert.equal(parseSyncCursor({ nextPage: 3.9, updatedAt: 0 })?.nextPage, 3)
})

test('游标解析器永不返回 null：游标「合法地可以不存在」（跑完就删）', () => {
    // 直接用 parseSyncCursor 接 useStorageSnapshot 的话，跑完删键时 onChanged 解析成 null
    // 会被 hook 当成「不可信、保留上一份」——界面于是永远显示「上次停在第 N 页」。
    assert.deepEqual(parseSyncCursorOrIdle(undefined), IDLE_SYNC_CURSOR)
    assert.deepEqual(parseSyncCursorOrIdle({ nextPage: 7, updatedAt: 1 }), { nextPage: 7, updatedAt: 1 })
})

test('游标只做连续推进：中间有洞就停在洞那里（按最大页推进会永久漏页）', () => {
    // 第 3 页失败、4/5 页成功：游标必须停在 3，否则进程被杀后第 3 页永远补不回来
    assert.equal(advanceSyncCursor(0, new Set([0, 1, 2, 4, 5])), 3)
    // 洞被补上之后可以继续往前
    assert.equal(advanceSyncCursor(3, new Set([0, 1, 2, 3, 4, 5])), 6)
    // 一页都没成功：停在起点
    assert.equal(advanceSyncCursor(0, new Set()), 0)
    // 从断点起跑时同理
    assert.equal(advanceSyncCursor(10, new Set([10, 11, 13])), 12)
    // 脏起点（负数）回 0，不能把页码算到库外
    assert.equal(advanceSyncCursor(-5, new Set([0])), 1)
})

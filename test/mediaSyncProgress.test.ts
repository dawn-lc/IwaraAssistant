/**
 * MediaCenter 同步进度的**展示判据**（`shared/mediaSyncProgress`）。
 *
 * 三组判据都属于「不能拿 0 冒充」：把「刚跑完」或「总量未知」画成 0% 会让进度条
 * 永远停在起点，用户看到的是「没动」，比不显示更糟；而把「上一代残留的 running」
 * 当真，按钮就会永久置灰。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { IDLE_MEDIA_SYNC_PROGRESS, mediaSyncRatio, parseMediaSyncProgress, settleInterrupted, type MediaSyncProgress } from '../src/shared/mediaSyncProgress'

function progress(overrides: Partial<MediaSyncProgress> = {}): MediaSyncProgress {
    return { running: true, stage: 'list', done: 0, total: 0, updatedAt: 1, ...overrides }
}

test('空闲时不显示比例（刚跑完不能画成 0%）', () => {
    assert.equal(mediaSyncRatio(IDLE_MEDIA_SYNC_PROGRESS), undefined)
    assert.equal(mediaSyncRatio(null), undefined)
    assert.equal(mediaSyncRatio(progress({ running: false, done: 10, total: 10 })), undefined)
})

test('总量未知时返回 undefined（不确定态，不用 0 冒充分母）', () => {
    assert.equal(mediaSyncRatio(progress({ done: 120, total: 0 })), undefined)
    assert.equal(mediaSyncRatio(progress({ stage: null, done: 1, total: 10 })), undefined)
})

test('正常进度按比例返回，并夹取到 0~1', () => {
    assert.equal(mediaSyncRatio(progress({ done: 25, total: 100 })), 0.25)
    assert.equal(mediaSyncRatio(progress({ done: 0, total: 100 })), 0)
    assert.equal(mediaSyncRatio(progress({ done: 100, total: 100 })), 1)
    // 远端在扫描期间被删除/新增时会略微越界，进度条不该因此断裂
    assert.equal(mediaSyncRatio(progress({ done: 120, total: 100 })), 1)
    assert.equal(mediaSyncRatio(progress({ done: -5, total: 100 })), 0)
})

// ── 解析（session 快照可能带上一代/手工调试留下的脏值）────────────────

test('解析：非对象 / 缺 running 一律不可信', () => {
    assert.equal(parseMediaSyncProgress(undefined), null)
    assert.equal(parseMediaSyncProgress(null), null)
    assert.equal(parseMediaSyncProgress('running'), null)
    assert.equal(parseMediaSyncProgress({ stage: 'list', done: 1, total: 2 }), null)
})

test('解析：running 却是未知阶段 ⇒ 不可信（否则界面会永远转圈）', () => {
    assert.equal(parseMediaSyncProgress({ running: true, stage: 'upload', done: 1, total: 2 }), null)
    assert.equal(parseMediaSyncProgress({ running: true, done: 1, total: 2 }), null)
})

test('解析：终态快照允许 stage 为 null', () => {
    const parsed = parseMediaSyncProgress({ running: false, stage: null, done: 0, total: 0, updatedAt: 5 })
    assert.deepEqual(parsed, { running: false, stage: null, done: 0, total: 0, interrupted: undefined, updatedAt: 5 })
})

test('解析：脏计数回落到 0（否则 done / total 会变成 NaN）', () => {
    const parsed = parseMediaSyncProgress({ running: true, stage: 'push', done: '37', total: null, updatedAt: 'now' })
    assert.deepEqual(parsed, { running: true, stage: 'push', done: 0, total: 0, interrupted: undefined, updatedAt: 0 })
})

test('解析：负数计数夹到 0，interrupted 只认 true', () => {
    assert.equal(parseMediaSyncProgress({ running: true, stage: 'push', done: -3, total: -1 })?.done, 0)
    assert.equal(parseMediaSyncProgress({ running: false, stage: null, interrupted: 'yes' })?.interrupted, undefined)
    assert.equal(parseMediaSyncProgress({ running: false, stage: null, interrupted: true })?.interrupted, true)
})

// ── 残骸归一（不变量判定，不靠心跳超时）──────────────────────────

test('残骸：快照说在跑、内存没任务 ⇒ 判为中断，并且不再声称在跑', () => {
    const settled = settleInterrupted(progress({ stage: 'list', done: 30, total: 100, updatedAt: 42 }), false)
    assert.deepEqual(settled, { running: false, stage: null, done: 0, total: 0, interrupted: true, updatedAt: 42 })
    // 归一的记录不能再算「在跑」——否则界面永远转圈
    assert.equal(mediaSyncRatio(settled), undefined)
})

test('残骸：任务确实还活着时一个字都不改', () => {
    assert.equal(settleInterrupted(progress(), true), null)
})

test('残骸：本来就是终态 / 没有快照，不需要修', () => {
    assert.equal(settleInterrupted(progress({ running: false, stage: null }), false), null)
    assert.equal(settleInterrupted(IDLE_MEDIA_SYNC_PROGRESS, false), null)
    assert.equal(settleInterrupted(null, false), null)
})

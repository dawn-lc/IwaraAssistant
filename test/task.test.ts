/**
 * 任务语义（`shared/task.ts`）—— 通道能力、重启对账、取消策略。
 *
 * 这三组判定的失败方向都是**静默**的，所以每条规则单独钉一个用例：
 * - 通道能力判错 → 任务永远停在「下载中」且按规则不可移除
 * - 对账判错 → 真在下的被标失败，或者早就死了的一直转圈
 * - 取消策略判错 → 记录删了、下载还在偷偷跑（或反过来干脆不给删）
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelStrategyOf, channelTracksResult, decideStaleRunning, taskMatchesRef, type Aria2Probe, type BrowserProbe, type CancelEnv } from '../src/shared/task'
import type { QueueTask } from '../src/shared/task'

/** 最小任务（只填匹配判据用得上的字段） */
function task(overrides: Partial<QueueTask> & Pick<QueueTask, 'id' | 'kind'>): QueueTask {
    return { videoId: 'vid', status: 'running', ...overrides }
}

// ── 按引用查任务（kindRef 命名空间不唯一）──────────────────────────────

// 这一节守的是一个真实撞车：`downloads.onChanged` 用 `String(downloadId)` 查任务，
// 而 others 通道的 kindRef 是 `String(tabId)`。两个 id 都从小整数开始递增，
// 所以第一个 tab（tabId=1）与第一次下载（downloadId=1）必然相等。
// 不带 kind 查询时，一条已交付的 others 任务会被浏览器的完成事件标成 complete。

test('引用匹配：others 的 tabId 与 browser 的 downloadId 撞号时不会串（带 kind）', () => {
    const othersTask = task({ id: 'a', kind: 'others', kindRef: '1', status: 'handed-off' })
    assert.equal(taskMatchesRef(othersTask, { kindRef: '1', kind: 'browser' }), false)
    assert.equal(taskMatchesRef(othersTask, { kindRef: '1', kind: 'others' }), true)
})

test('引用匹配：不带 kind 时按 kindRef 仍能命中（兼容旧调用点，但不推荐）', () => {
    const aria2Task = task({ id: 'b', kind: 'aria2', kindRef: '2089b05ecca3d829' })
    assert.equal(taskMatchesRef(aria2Task, { kindRef: '2089b05ecca3d829' }), true)
})

test('引用匹配：按 id 查不需要 kind（uuid 全局唯一）', () => {
    const browserTask = task({ id: 'uuid-1', kind: 'browser' })
    assert.equal(taskMatchesRef(browserTask, { id: 'uuid-1' }), true)
    assert.equal(taskMatchesRef(browserTask, { id: 'uuid-2' }), false)
})

test('引用匹配：空引用不命中任何任务（不能默默返回第一条）', () => {
    const anyTask = task({ id: 'c', kind: 'browser', kindRef: '7' })
    assert.equal(taskMatchesRef(anyTask, {}), false)
})

// ── 通道能力 ────────────────────────────────────────────────────────────

test('会回传结果的通道：browser（downloads.onChanged）、aria2（WS + 扫描对账）、iwaradl（任务 API 轮询）', () => {
    assert.equal(channelTracksResult('browser'), true)
    assert.equal(channelTracksResult('aria2'), true)
    // 旧结论把 iwaradl 当交付型通道，那是只看了 POST。它有 GET /api/tasks，
    // 状态和进度都拿得到，所以它属于可追踪通道。
    assert.equal(channelTracksResult('iwaradl'), true)
})

test('交付型通道：others 没有回传通道，投递成功即终态（后续可能被浏览器下载事件接管）', () => {
    assert.equal(channelTracksResult('others'), false)
})

// ── 重启对账 ────────────────────────────────────────────────────────────

const TRACKED: Aria2Probe = { kind: 'tracked' }
const UNTRACKED: Aria2Probe = { kind: 'untracked' }

function decide(kind: QueueTask['kind'], probe: BrowserProbe, extra: { kindRef?: string; aria2?: Aria2Probe } = {}) {
    return decideStaleRunning({ status: 'running', kind, ...(extra.kindRef === undefined ? {} : { kindRef: extra.kindRef }) }, { browser: probe, aria2: extra.aria2 ?? TRACKED })
}

test('browser：下载还在传 → 保持不变（不能把真在跑的标成失败）', () => {
    assert.deepEqual(decide('browser', { kind: 'alive' }), { kind: 'keep' })
})

test('browser：已完成（完成事件落在 SW 挂起期间）→ 收敛为完成', () => {
    assert.deepEqual(decide('browser', { kind: 'complete' }), { kind: 'settle', status: 'complete', reason: 'browserComplete' })
})

test('browser：已中断 → 失败（可重试）', () => {
    assert.deepEqual(decide('browser', { kind: 'interrupted', error: 'NETWORK_FAILED' }), { kind: 'settle', status: 'failed', reason: 'browserInterrupted' })
})

test('browser：下载记录已不在 → 失败（用户取消或浏览器丢了这个条目）', () => {
    assert.deepEqual(decide('browser', { kind: 'missing' }), { kind: 'settle', status: 'failed', reason: 'browserMissing' })
})

test('browser：查询本身失败 → 保持不变（证据不足时不许猜）', () => {
    assert.deepEqual(decide('browser', { kind: 'unknown' }), { kind: 'keep' })
})

test('aria2：已配置 → 保持不变（扫描对账会把终态同步回来）', () => {
    assert.deepEqual(decide('aria2', { kind: 'unknown' }, { aria2: TRACKED }), { kind: 'keep' })
})

test('aria2：未配置 → 失败（永远看不到结果，否则这条任务永远移不掉）', () => {
    assert.deepEqual(decide('aria2', { kind: 'unknown' }, { aria2: UNTRACKED }), { kind: 'settle', status: 'failed', reason: 'aria2Untracked' })
})

test('others：有标签页 id（交付成功过）→ 交付型终态，不是「完成」', () => {
    assert.deepEqual(decide('others', { kind: 'unknown' }, { kindRef: '42' }), { kind: 'settle', status: 'handed-off', reason: 'deliveredEarlier' })
})

test('iwaradl：有投递痕迹 → 交给轮询对账（它确实有任务 API，不是交付型通道）', () => {
    // 旧结论把 iwaradl 当交付型通道，那是只看了 POST。它有 GET /api/tasks，
    // 所以有 vid 就该交给轮询把终态拉回来，而不是提前标成 handed-off。
    assert.deepEqual(decide('iwaradl', { kind: 'unknown' }, { kindRef: 'cgcW74i2Ga4a9w' }), { kind: 'keep' })
})

test('iwaradl：没有投递痕迹（投递途中就重启了）→ 失败，让用户能看见并重试', () => {
    assert.deepEqual(decide('iwaradl', { kind: 'unknown' }, { kindRef: '' }), { kind: 'settle', status: 'failed', reason: 'neverDelivered' })
})

test('others：没有投递痕迹 → 失败', () => {
    assert.deepEqual(decide('others', { kind: 'unknown' }), { kind: 'settle', status: 'failed', reason: 'neverDelivered' })
})

test('非 running 状态一律不动（终态与待办跟进程生命周期无关）', () => {
    for (const status of ['complete', 'failed', 'skipped', 'handed-off', 'queued'] as const) {
        assert.deepEqual(decideStaleRunning({ status, kind: 'browser', kindRef: '1' }, { browser: { kind: 'missing' }, aria2: UNTRACKED }), { kind: 'keep' }, `${status} 不该被对账改动`)
    }
})

// ── 取消策略 ────────────────────────────────────────────────────────────

const BOTH: CancelEnv = { aria2Configured: true, iwaradlConfigured: true }
const NONE: CancelEnv = { aria2Configured: false, iwaradlConfigured: false }
const NO_ARIA2: CancelEnv = { aria2Configured: false, iwaradlConfigured: true }
const NO_IWARADL: CancelEnv = { aria2Configured: true, iwaradlConfigured: false }

test('取消 browser：有数字 downloadId → 可以 downloads.cancel', () => {
    assert.equal(cancelStrategyOf({ kind: 'browser', kindRef: '42' }, BOTH), 'browser-cancel')
})

test('取消 browser：还在投递途中（没有 kindRef）→ 没有可取消的东西', () => {
    assert.equal(cancelStrategyOf({ kind: 'browser' }, BOTH), 'none')
    assert.equal(cancelStrategyOf({ kind: 'browser', kindRef: '' }, BOTH), 'none')
    assert.equal(cancelStrategyOf({ kind: 'browser', kindRef: 'not-a-number' }, BOTH), 'none')
})

test('取消 aria2：已配置端点且有 gid → 可以 remove', () => {
    assert.equal(cancelStrategyOf({ kind: 'aria2', kindRef: 'f00d' }, BOTH), 'aria2-remove')
})

test('取消 aria2：没配置端点时 gid 也没用（无从下手，但删记录是安全的）', () => {
    assert.equal(cancelStrategyOf({ kind: 'aria2', kindRef: 'f00d' }, NO_ARIA2), 'none')
})

test('取消 aria2：没有 gid → 仍在投递中，没有可取消的东西', () => {
    assert.equal(cancelStrategyOf({ kind: 'aria2' }, BOTH), 'none')
    assert.equal(cancelStrategyOf({ kind: 'aria2', kindRef: '   ' }, BOTH), 'none')
})

test('取消 iwaradl：已配置端点且有 vid → 可以 DELETE（只能删 pending，运行中由调用方处理 409）', () => {
    assert.equal(cancelStrategyOf({ kind: 'iwaradl', kindRef: 'cgcW74i2Ga4a9w' }, BOTH), 'iwaradl-delete')
})

test('取消 iwaradl：没配端点或没有 vid → 无从下手', () => {
    assert.equal(cancelStrategyOf({ kind: 'iwaradl', kindRef: 'cgcW74i2Ga4a9w' }, NO_IWARADL), 'none')
    assert.equal(cancelStrategyOf({ kind: 'iwaradl' }, BOTH), 'none')
})

test('取消 others：只是打开了一个标签页，没有撤销接口', () => {
    assert.equal(cancelStrategyOf({ kind: 'others', kindRef: '7' }, BOTH), 'none')
    assert.equal(cancelStrategyOf({ kind: 'others' }, NONE), 'none')
})

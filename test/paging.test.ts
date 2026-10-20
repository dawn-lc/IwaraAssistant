/**
 * 分页判据与审批条件文案参数的单元测试。
 *
 * 两个都是「错了也不报错、只是表现很怪」的那类问题：
 * - 分页判据错了 → 每次都多发 30 个请求，没人会注意到；
 * - `{days}` 没插值 → 界面上显示字面的花括号，只有在人工看页面时才发现。
 * 所以必须在这里逐条钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasMorePages } from '../src/shared/paging'
import { BUILTIN_APPROVAL_CONDITIONS, ACTIVE_WINDOW_DAYS, ESTABLISHED_DAYS, approvalConditionParams, checkApprovalConditions } from '../src/shared/approvalConditions'

test('分页：空页一定停（与 limit / count 是否正确无关）', () => {
    assert.equal(hasMorePages({ length: 0, limit: 20, total: 100, pulled: 20 }), false)
    assert.equal(hasMorePages({ length: 0, limit: 0, total: 0, pulled: 0 }), false)
    assert.equal(hasMorePages({ length: 0, limit: 0, total: 100, pulled: 20 }), false)
})

test('分页：短页说明是最后一页', () => {
    assert.equal(hasMorePages({ length: 7, limit: 20, total: 0, pulled: 7 }), false)
})

test('分页：满页且未到 count 时继续', () => {
    assert.equal(hasMorePages({ length: 20, limit: 20, total: 100, pulled: 20 }), true)
    assert.equal(hasMorePages({ length: 20, limit: 20, total: 0, pulled: 20 }), true)
})

test('分页：已拉够 total 就停（limit 缺失时的兜底）', () => {
    assert.equal(hasMorePages({ length: 20, limit: 0, total: 40, pulled: 40 }), false)
    assert.equal(hasMorePages({ length: 20, limit: 0, total: 40, pulled: 20 }), true)
})

test('分页：服务端两个字段都不给时保守继续，靠调用方的页数上限兜底', () => {
    // 旧实现的 bug 就在这里：limit 为 0 时把它当成「本页条数」，
    // `length < limit` 恒为假，于是永远不停、白翻满 32 页。
    assert.equal(hasMorePages({ length: 20, limit: 0, total: 0, pulled: 20 }), true)
    // 但一旦真的出现空页，仍然会停 —— 不会无限翻
    assert.equal(hasMorePages({ length: 0, limit: 0, total: 0, pulled: 20 }), false)
})

test('审批条件文案：带 {days} 的条件必须给出参数，其余不给', () => {
    assert.deepEqual(approvalConditionParams('recentlyActive'), { days: ACTIVE_WINDOW_DAYS })
    assert.deepEqual(approvalConditionParams('established'), { days: ESTABLISHED_DAYS })
    for (const id of ['always', 'followedBy', 'following', 'premium', 'active', 'commentedProfile', 'commentedForumThread']) {
        assert.equal(approvalConditionParams(id), undefined, `${id} 不该有插值参数`)
    }
})

test('审批条件文案：每个内置条件都能拿到文案键（id 与 condition.* 一一对应）', () => {
    const ids = BUILTIN_APPROVAL_CONDITIONS.map((condition) => condition.id)
    assert.deepEqual(ids, ['always', 'followedBy', 'following', 'premium', 'recentlyActive', 'established', 'active', 'commentedProfile', 'commentedForumThread'])
})

test('审批判定：无可用条件时恒 false（不能误批）', () => {
    const context = {
        user: { id: 'u1', username: 'u1' } as Iwara.User,
        commentEvidence: new Map<string, Map<string, string[]>>(),
        evidenceThreadId: ''
    }
    // 空列表是默认配置（`friendRequestApprovalConditions` 默认 `[]`）：
    // 必须一条都不批，而不是把「没条件」当成「无条件通过」
    assert.equal(checkApprovalConditions([], 'any', context), false)
    assert.equal(checkApprovalConditions([], 'all', context), false)
    // 全是无法识别的 id 也一样（配置被别处写脏时不能放开）
    assert.equal(checkApprovalConditions(['nope', 'nonsense'], 'any', context), false)
    // `always` 是显式选择，此时才应该批
    assert.equal(checkApprovalConditions(['always'], 'all', context), true)
})

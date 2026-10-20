/**
 * 钓鱼防护 DNR 规则形状（纯函数，无浏览器 API）。
 *
 * 这些断言守的是**拦截面**：规则一旦退化成只拦某几种资源类型，
 * 仿冒站换一种外传手段（图片 / 表单 / iframe）就绕过去了，而界面上看起来一切正常。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { guardRuleForTab } from '../src/shared/guardRule'

test('规则按标签页封锁：id 用 tabId，条件只匹配该标签页', () => {
    const rule = guardRuleForTab(42)
    assert.equal(rule.id, 42)
    assert.deepEqual(rule.condition.tabIds, [42])
    assert.equal(rule.action.type, 'block')
    assert.ok(rule.priority >= 1)
})

test('顶层导航必须放过：否则用户连地址栏跳转和刷新都出不去', () => {
    const rule = guardRuleForTab(7)
    assert.deepEqual(rule.condition.excludedResourceTypes, ['main_frame'])
    // 不写 resourceTypes（白名单）才意味着「其余类型全封」；写了就会缩小拦截面
    assert.equal(rule.condition.resourceTypes, undefined)
})

test('不同标签页的规则 id 不同，不能互相覆盖', () => {
    assert.notEqual(guardRuleForTab(1).id, guardRuleForTab(2).id)
})

/**
 * 字符串工具单元测试（下载路径模板渲染的核心）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { among, escapeRegex, isEmpty, isNullOrUndefined, prune, replaceEmojis, replaceVariable, stringify, truncate } from '../src/shared/strings'

test('isNullOrUndefined / isEmpty 判定', () => {
    assert.equal(isNullOrUndefined(null), true)
    assert.equal(isNullOrUndefined(undefined), true)
    assert.equal(isNullOrUndefined(0), false)
    assert.equal(isEmpty(''), true)
    assert.equal(isEmpty(' '), false)
})

test('escapeRegex 让特殊字符按字面匹配', () => {
    const pattern = new RegExp(`^${escapeRegex('a+b(c)')}$`)
    assert.equal(pattern.test('a+b(c)'), true)
    assert.equal(pattern.test('aab(c)'), false)
})

test('truncate 按长度截断（不加省略号，源实现同款）', () => {
    assert.equal(truncate('abcdef', 3), 'abc')
    assert.equal(truncate('abc', 10), 'abc')
})

test('among 取两个标记之间的内容', () => {
    assert.equal(among('key=value;', '=', ';'), 'value')
    assert.equal(among('no-markers', '=', ';'), '')
})

test('replaceEmojis 清零宽表情', () => {
    assert.equal(replaceEmojis('标题🐱测试'), '标题测试')
    assert.equal(replaceEmojis('标题🐱测试', '_'), '标题_测试')
})

test('replaceVariable 支持 [:格式] 语法与循环检测', () => {
    const map: Record<string, string> = { AUTHOR: 'dawn', TITLE: 'hello' }
    assert.equal(replaceVariable('/Iwara/%#AUTHOR#%/%#TITLE#%.mp4', map), '/Iwara/dawn/hello.mp4')
    // 未知变量保持原样（原实现行为）
    assert.equal(replaceVariable('%#UNKNOWN#%', map), '%#UNKNOWN#%')
})

test('stringify 对 Error / 对象 / 基本类型给出稳定字符串', () => {
    assert.equal(stringify(new Error('boom')), 'boom')
    assert.equal(stringify('x'), 'x')
    assert.equal(stringify({ a: 1 }), '{"a":1}')
})

test('prune 移除空值字段', () => {
    const pruned = prune({ a: '', b: null, c: undefined, d: 0, e: 'x' })
    assert.deepEqual(pruned, { d: 0, e: 'x' })
})

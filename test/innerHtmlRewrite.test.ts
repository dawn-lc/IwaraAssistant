/**
 * `innerHTML` 后处理单测。
 *
 * 它存在的唯一目的是消除 addons-linter 对 react-dom `dangerouslySetInnerHTML`
 * 实现的误报，因此必须证明三件事：只改「标识符 = 标识符」这一形态、字符串字面量
 * 与属性读取不被碰、重复执行不会二次改写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteInnerHtmlAssignments } from '../build/innerHtmlRewrite'

test('标识符赋值改写为 Reflect.set，并统计处数', () => {
    const { code, count } = rewriteInnerHtmlAssignments('a?.__html!==n&&(e.innerHTML=n)}}')
    assert.equal(count, 1)
    assert.equal(code, 'a?.__html!==n&&(Reflect.set(e,"innerHTML",n))}}')
})

test('等号两侧的空白不影响到改写', () => {
    const { code, count } = rewriteInnerHtmlAssignments('node.innerHTML = value;')
    assert.equal(count, 1)
    assert.equal(code, 'Reflect.set(node,"innerHTML",value);')
})

test('字符串字面量赋值保持原样（React 里的 <script> 探测代码）', () => {
    const source = 'i=u.createElement("div"),i.innerHTML="<script><\\/script>",i=i.removeChild(i)'
    const { code, count } = rewriteInnerHtmlAssignments(source)
    assert.equal(count, 0)
    assert.equal(code, source)
})

test('属性读取与 case 字符串不受影响', () => {
    const source = 'if(e.innerHTML===x)break;case"innerHTML":case"ref":break;'
    const { code, count } = rewriteInnerHtmlAssignments(source)
    assert.equal(count, 0)
    assert.equal(code, source)
})

test('重复执行不会二次改写（幂等）', () => {
    const first = rewriteInnerHtmlAssignments('e.innerHTML=a')
    const second = rewriteInnerHtmlAssignments(first.code)
    assert.equal(second.count, 0)
    assert.equal(second.code, first.code)
})

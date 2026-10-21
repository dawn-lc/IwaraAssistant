/**
 * aria2 RPC 认证参数（`background/backends/aria2/client.ts` 的 `aria2AuthParams`）。
 *
 * 这不是「顺手单测一个拼接函数」——这是踩过的真实回归：
 * 同一个 `aria2.getVersion`，HTTP 分支自己拼了 `token:`，WS 分支发的是裸 params，
 * 于是**走 WS 一律 Unauthorized、走 HTTP 就成功**。旧实现恰好因为「WS 报错一律降级
 * HTTP」而看不出问题；把「RPC 级错误不降级」改上去后，环境自检立刻报
 * `{"code":1,"message":"Unauthorized"}`。
 *
 * 对真实 aria2 1.36.0 的探针实测（WS 长连接、同一 token）：
 *   无 token => {"error":{"code":1,"message":"Unauthorized"}}
 *   带 token => {"result":{"version":"1.36.0", ...}}
 *
 * 所以这里的断言不是形式主义：token 必须出现在参数第 0 位，且两条传输必须取同一份
 * 参数。后半句用「源码里只有一个拼 token 的地方」来守。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { aria2AuthParams } from '../src/shared/aria2Rpc'

const TOKEN = 'secret-token'

test('token 拼在参数第 0 位（aria2 只认第 0 个参数的 token: 前缀）', () => {
    assert.deepEqual(aria2AuthParams(TOKEN, ['gid-1', ['status']]), [`token:${TOKEN}`, 'gid-1', ['status']])
})

test('不丢原参数、不改原数组（调用方可能复用 params）', () => {
    const params = ['gid-1']
    const authParams = aria2AuthParams(TOKEN, params)
    assert.equal(params.length, 1)
    assert.notEqual(authParams, params)
    assert.equal(authParams.length, 2)
    assert.equal(authParams[1], 'gid-1')
})

test('空参数也要带 token（getVersion / getGlobalStat 这类无参指令最容易被漏掉）', () => {
    assert.deepEqual(aria2AuthParams(TOKEN, []), [`token:${TOKEN}`])
})

test('空 token 仍保留前缀（与 aria2 配置无密钥时的 HTTP 行为一致，不特殊处理）', () => {
    assert.deepEqual(aria2AuthParams('', ['a']), ['token:', 'a'])
})

test('WS 与 HTTP 共用同一份认证参数：源码里只允许一处拼 token', () => {
    const clientSource = readFileSync('src/background/backends/aria2/client.ts', 'utf8')
    const sharedSource = readFileSync('src/shared/aria2Rpc.ts', 'utf8')
    const tokenLiteral = /`token:\$\{/g
    assert.equal(sharedSource.match(tokenLiteral)?.length ?? 0, 1, '`token:${...}` 应只在 aria2AuthParams 内部出现一次')
    assert.equal(clientSource.match(tokenLiteral)?.length ?? 0, 0, '传输层不得自己拼 token；出现就说明某条路径又绕过 aria2AuthParams 了')
    assert.match(clientSource, /wsCall<[^>]*>\(method, authParams\)/, 'WS 路径必须以 authParams 调用，不能传裸 params')
    assert.match(clientSource, /params: authParams/, 'HTTP 路径必须复用同一份 authParams')
})

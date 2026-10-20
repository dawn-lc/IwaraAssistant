/**
 * 协议与解析的单元测试
 *
 * - 跨世界 schema 版本必须稳定（MAIN/ISOLATED 靠它协商，改错会导致握手静默失败）
 * - parseCacheVideo 是入库第一道关，字段映射错会让过滤/回填全错
 * - **协议与后台路由必须一一对应**：声明了但没实现的消息，UI 点击只会拿到
 *   `unknown message type`（已经真实发生过：`FORCE_DOWNLOAD`）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CONTENT_SCHEMA, MAIN_CHANNEL } from '../src/messaging/protocol'
import { parseCacheVideo } from '../src/background/storage/parse'

const root = path.resolve(import.meta.dirname, '..')

test('协议里每个 Req 类型都有后台处理分支（防止「点了没反应」）', () => {
    const protocol = fs.readFileSync(path.join(root, 'src/messaging/protocol.ts'), 'utf8')
    const router = fs.readFileSync(path.join(root, 'src/background/index.ts'), 'utf8')

    // 只取 Req 段：Push 段里的类型是后台往页面推的，不该出现在 switch 里
    const reqSection = protocol.slice(protocol.indexOf('export type Req'), protocol.indexOf('export type Push'))
    const declared = [...new Set([...reqSection.matchAll(/type:\s*'([A-Z_]+)'/g)].map((match) => match[1]))]
    const handled = new Set([...router.matchAll(/case\s+'([A-Z_]+)'/g)].map((match) => match[1]))

    // 先确认解析本身没失效：一个都认不出来时，永远为空的 diff 会让用例假绿
    assert.ok(declared.length > 20, `协议 Req 解析异常：只认到 ${declared.length} 个类型`)

    const missing = declared.filter((type) => !handled.has(type))
    assert.deepEqual(missing, [], `以下消息在 protocol.ts 里声明了但没有处理分支：${missing.join(', ')}`)
})

test('后台不会处理协议里没声明的消息类型', () => {
    const protocol = fs.readFileSync(path.join(root, 'src/messaging/protocol.ts'), 'utf8')
    const router = fs.readFileSync(path.join(root, 'src/background/index.ts'), 'utf8')
    const reqSection = protocol.slice(protocol.indexOf('export type Req'), protocol.indexOf('export type Push'))
    const declared = new Set([...reqSection.matchAll(/type:\s*'([A-Z_]+)'/g)].map((match) => match[1]))
    const handled = [...new Set([...router.matchAll(/case\s+'([A-Z_]+)'/g)].map((match) => match[1]))]
    const extra = handled.filter((type) => !declared.has(type))
    assert.deepEqual(extra, [], `后台处理了协议里不存在的消息：${extra.join(', ')}`)
})

test('跨世界通道名与 schema 版本是稳定契约', () => {
    // 这两个值同时被 MAIN world 与 ISOLATED world 使用；
    // 任意改动都会让已注入的旧 bundle 与新 bundle 无法握手（必须同步发版）
    assert.equal(MAIN_CHANNEL.up, 'iwara-assistant:up')
    assert.equal(MAIN_CHANNEL.down, 'iwara-assistant:down')
    assert.equal(CONTENT_SCHEMA, 1)
})

test('parseCacheVideo 映射列表页 RAW → partial', () => {
    const raw = {
        id: 'abc123',
        title: '标题',
        createdAt: '2026-01-02T03:04:05.000Z',
        tags: [{ id: 't1', name: 'tag' }],
        liked: true,
        private: false,
        unlisted: true,
        user: { id: 'u1', username: 'dawn', name: 'Dawn' }
    } as unknown as Iwara.Video

    const parsed = parseCacheVideo(raw)
    assert.equal(parsed.Type, 'partial')
    assert.equal(parsed.ID, 'abc123')
    assert.equal(parsed.Title, '标题')
    assert.equal(parsed.Author, 'dawn')
    assert.equal(parsed.AuthorID, 'u1')
    assert.equal(parsed.Alias, 'Dawn')
    assert.equal(parsed.Liked, true)
    assert.equal(parsed.Unlisted, true)
    assert.equal(parsed.Private, false)
    assert.equal(parsed.External, false)
    assert.equal(parsed.UploadTime, new Date('2026-01-02T03:04:05.000Z').getTime())
    // RAW 原样保留（回填/迁移依赖它）
    assert.equal(parsed.RAW, raw)
})

test('parseCacheVideo 对残缺对象返回 Fail 而不是抛错', () => {
    const parsed = parseCacheVideo({ id: 'x' } as unknown as Iwara.Video)
    // user 缺失 ⇒ 内部取值抛错 ⇒ 走失败分支
    assert.equal(parsed.Type, 'fail')
})

test('embedUrl 存在时标记为 External', () => {
    const raw = {
        id: 'e1',
        title: 't',
        createdAt: '2026-01-01T00:00:00.000Z',
        tags: [],
        user: { id: 'u', username: 'u', name: 'n' },
        embedUrl: 'https://example.com/embed'
    } as unknown as Iwara.Video
    assert.equal(parseCacheVideo(raw).External, true)
})

/**
 * MediaCenter 阶段一：候选索引 + 分页扫描。
 *
 * 这两块是「修掉 118 MB 卡死」的核心，判错的代价都不对称：
 * - 匹配漏了 / 多认 → 服务端被造重复条目，或把别人的记录当成本地视频（用户可见的脏数据）；
 * - 分页判错 → 要么对端点死循环，要么只扫了第一页却当成全量（静默漏认领，
 *   表现是「明明库里有，同步完却多出一条」）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { MEDIA_LIST_CONCURRENCY, createMediaCenterMatcher, extractVideoId, scanMediaPages, type MediaCenterListEntry, type MediaPage } from '../src/shared/mediaCenterMatch'

function entry(id: string, overrides: Partial<MediaCenterListEntry> = {}): MediaCenterListEntry {
    return { id, ...overrides }
}

// ── 候选索引 ──────────────────────────────────────────────

test('fileHash 与视频 ID 精确相等即命中（大小写敏感）', () => {
    const matcher = createMediaCenterMatcher(['vhgZWCBx8X3lxT'])
    matcher.add(entry('mc-1', { fileHash: 'vhgZWCBx8X3lxT' }))
    assert.equal(matcher.resolve('vhgZWCBx8X3lxT'), 'mc-1')
    assert.equal(matcher.remaining(), 0)
})

test('fileHash 大小写不同不算命中（ID 是大小写敏感的外部契约）', () => {
    const matcher = createMediaCenterMatcher(['vhgZWCBx8X3lxT'])
    matcher.add(entry('mc-1', { fileHash: 'vhgzwcbx8x3lxt' }))
    assert.equal(matcher.resolve('vhgZWCBx8X3lxT'), undefined)
    assert.equal(matcher.remaining(), 1)
})

test('标题包含视频 ID 即命中（方括号包裹是站点下载器的常见形态）', () => {
    const matcher = createMediaCenterMatcher(['vhgZWCBx8X3lxT'])
    matcher.add(entry('mc-1', { title: 'Ramiel - Who is she[vhgZWCBx8X3lxT].mp4' }))
    assert.equal(matcher.resolve('vhgZWCBx8X3lxT'), 'mc-1')
})

test('标题匹配大小写不敏感，且能命中嵌在长 token 里的 ID', () => {
    const matcher = createMediaCenterMatcher(['vhgZWCBx8X3lxT'])
    matcher.add(entry('mc-1', { title: 'prefixvhgzwcbx8x3lxtsuffix' }))
    assert.equal(matcher.resolve('vhgZWCBx8X3lxT'), 'mc-1')
})

test('标题只是「片段相似」不算命中（只认完整 ID）', () => {
    const matcher = createMediaCenterMatcher(['vhgZWCBx8X3lxT'])
    matcher.add(entry('mc-1', { title: 'vhgZWCBx8X3lxT-remake' }))
    // 标题里是 vhgZWCBx8X3lxT-remake：ID 完整出现在 '-' 之前 ⇒ 仍然是命中
    assert.equal(matcher.resolve('vhgZWCBx8X3lxT'), 'mc-1')

    const other = createMediaCenterMatcher(['vhgZWCBx8X3lxT'])
    other.add(entry('mc-2', { title: 'vhgZWCBx8X3lx' }))
    assert.equal(other.resolve('vhgZWCBx8X3lxT'), undefined)
})

// ── 反向补齐：从远端记录反推视频 ID ──────────────────────

test('反向补齐：fileHash 优先于标题（标签型方括号因此不会被采用）', () => {
    // 真实记录：标题方括号里是标签，fileHash 才是视频 ID。只靠标题会去解析一个不存在的视频
    assert.equal(extractVideoId(entry('mc-1', { fileHash: 'ByANiHdCm9g8e6', title: 'PhoenixReffaella[ZenlessZoneZero]' })), 'ByANiHdCm9g8e6')
})

test('反向补齐：没有可用 fileHash 时取标题方括号里的 ID（扫描导入的命名形态）', () => {
    assert.equal(extractVideoId(entry('mc-1', { title: '能代 Sunny Side Up [dSl2ZwZVGXxOLq]' })), 'dSl2ZwZVGXxOLq')
    assert.equal(extractVideoId(entry('mc-2', { fileHash: '', title: 'Ramiel - Who is she[vhgZWCBx8X3lxT].mp4' })), 'vhgZWCBx8X3lxT')
})

test('反向补齐：形态不像视频 ID 的方括号一律不取（宁可跳过也不发错请求）', () => {
    // 太短 / 带下划线 / 带空格：都不是 iwara 视频 ID
    assert.equal(extractVideoId(entry('mc-1', { title: 'clip[1080p60].mp4' })), undefined)
    assert.equal(extractVideoId(entry('mc-2', { title: 'clip[my_final_cut]' })), undefined)
    assert.equal(extractVideoId(entry('mc-3', { title: 'no brackets here' })), undefined)
    assert.equal(extractVideoId(entry('mc-4')), undefined)
})

test('fileHash 命中优先于标题命中（即使标题记录先到）', () => {
    const matcher = createMediaCenterMatcher(['abc123'])
    matcher.add(entry('by-title', { title: 'abc123 video' }))
    matcher.add(entry('by-hash', { fileHash: 'abc123' }))
    assert.equal(matcher.resolve('abc123'), 'by-hash')
})

test('同一条候选被多条远端记录命中时 remaining 只递减一次', () => {
    const matcher = createMediaCenterMatcher(['abc123', 'def456'])
    assert.equal(matcher.remaining(), 2)
    matcher.add(entry('mc-1', { fileHash: 'abc123' }))
    matcher.add(entry('mc-2', { title: 'abc123 duplicate' }))
    assert.equal(matcher.remaining(), 1)
    matcher.add(entry('mc-3', { title: 'def456' }))
    assert.equal(matcher.remaining(), 0)
})

test('非候选记录一个都不留（内存不随远端目录规模增长）', () => {
    const matcher = createMediaCenterMatcher(['abc123'])
    for (let index = 0; index < 1000; index++) {
        matcher.add(entry(`remote-${index}`, { fileHash: `hash-${index}`, title: `unrelated title ${index}` }))
    }
    assert.equal(matcher.remaining(), 1)
    assert.equal(matcher.resolve('abc123'), undefined)
})

test('候选里的空值与脏值不炸，也不会被当成可命中的候选', () => {
    const matcher = createMediaCenterMatcher(['', 'abc123'])
    matcher.add(entry('mc-1', { title: '' }))
    matcher.add(entry('mc-2', {}))
    assert.equal(matcher.resolve(''), undefined)
    assert.equal(matcher.remaining(), 1)
})

// ── 分页扫描 ──────────────────────────────────────────────

interface FakeServer {
    calls: number[]
    fetchPage: (page: number) => Promise<MediaPage>
}

/** 按页号返回预置数据；请求页号超出预置范围视为测试写错 */
function makeServer(pages: MediaPage[], failOn?: number): FakeServer {
    const calls: number[] = []
    return {
        calls,
        fetchPage: (page) => {
            calls.push(page)
            if (failOn !== undefined && page === failOn) return Promise.reject(new Error(`page ${page} failed`))
            const data = pages[page - 1]
            if (data === undefined) return Promise.reject(new Error(`unexpected page ${page}`))
            return Promise.resolve(data)
        }
    }
}

function items(count: number, offset = 0): MediaCenterListEntry[] {
    return Array.from({ length: count }, (_value, index) => entry(`mc-${offset + index}`))
}

test('分页扫描：只剩一页（短页）时只请求一次', async () => {
    const server = makeServer([{ items: items(3), total: 3 }])
    const collected: MediaCenterListEntry[] = []
    const summary = await scanMediaPages({ pageSize: 10, fetchPage: server.fetchPage, apply: (page) => collected.push(...page) })
    assert.deepEqual(server.calls, [1])
    assert.equal(summary.pages, 1)
    assert.equal(summary.scanned, 3)
    assert.equal(summary.truncated, false)
    assert.equal(collected.length, 3)
})

test('分页扫描：按 total 拉满所有页，每页只消费一次', async () => {
    const server = makeServer([
        { items: items(10, 0), total: 25 },
        { items: items(10, 10), total: 25 },
        { items: items(5, 20), total: 25 }
    ])
    const collected: string[] = []
    const summary = await scanMediaPages({ pageSize: 10, concurrency: 1, fetchPage: server.fetchPage, apply: (page) => collected.push(...page.map((item) => item.id)) })
    assert.deepEqual(server.calls, [1, 2, 3])
    assert.equal(summary.scanned, 25)
    assert.equal(summary.total, 25)
    assert.equal(new Set(collected).size, 25)
})

test('分页扫描：服务端不认分页（一页返回超量）时直接采用，不再请求第 2 页', async () => {
    const server = makeServer([{ items: items(25), total: 0 }])
    const summary = await scanMediaPages({ pageSize: 10, fetchPage: server.fetchPage, apply: () => {} })
    assert.deepEqual(server.calls, [1])
    assert.equal(summary.scanned, 25)
})

test('分页扫描：服务端不给 total 时按短页终止（不发多余请求）', async () => {
    const server = makeServer([
        { items: items(10, 0), total: 0 },
        { items: items(10, 10), total: 0 },
        { items: items(4, 20), total: 0 }
    ])
    const summary = await scanMediaPages({ pageSize: 10, concurrency: 1, fetchPage: server.fetchPage, apply: () => {} })
    assert.deepEqual(server.calls, [1, 2, 3])
    assert.equal(summary.scanned, 24)
    assert.equal(summary.total, 0)
})

test('分页扫描：候选全部命中后立刻停（不再打剩下的页）', async () => {
    let remaining = 1
    const server = makeServer([
        { items: items(10, 0), total: 10_000 },
        { items: items(10, 10), total: 10_000 }
    ])
    const summary = await scanMediaPages({
        pageSize: 10,
        concurrency: 1,
        fetchPage: server.fetchPage,
        apply: () => {
            remaining = 0
        },
        done: () => remaining === 0
    })
    assert.deepEqual(server.calls, [1])
    assert.equal(summary.pages, 1)
})

test('分页扫描：任一页失败即整体抛出（拉不全就不能做匹配）', async () => {
    const server = makeServer(
        [
            { items: items(10, 0), total: 30 },
            { items: items(10, 10), total: 30 },
            { items: items(10, 20), total: 30 }
        ],
        2
    )
    await assert.rejects(() => scanMediaPages({ pageSize: 10, concurrency: 1, fetchPage: server.fetchPage, apply: () => {} }), /page 2 failed/)
    // 失败后不许再派发后续页：第 3 页一次都不该被请求（并发池的「停止派发」语义）
    assert.deepEqual(server.calls, [1, 2])
})

test('分页扫描：页数上限截断时如实标记 truncated', async () => {
    const server = makeServer([1, 2, 3, 4, 5, 6].map((page) => ({ items: items(10, (page - 1) * 10), total: 60 })))
    const summary = await scanMediaPages({ pageSize: 10, maxPages: 3, concurrency: 1, fetchPage: server.fetchPage, apply: () => {} })
    assert.deepEqual(server.calls, [1, 2, 3])
    assert.equal(summary.truncated, true)
    assert.equal(summary.scanned, 30)
})

test('分页扫描：并发不超过声明上限，且页号不重复', async () => {
    const calls: number[] = []
    let inFlight = 0
    let peak = 0
    const fetchPage = async (page: number): Promise<MediaPage> => {
        calls.push(page)
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        return { items: items(10, (page - 1) * 10), total: 80 }
    }
    const summary = await scanMediaPages({ pageSize: 10, fetchPage, apply: () => {} })
    assert.equal(summary.pages, 8)
    assert.equal(calls.length, 8)
    assert.equal(new Set(calls).size, 8)
    assert.ok(peak <= MEDIA_LIST_CONCURRENCY, `并发峰值 ${peak} 超过上限 ${MEDIA_LIST_CONCURRENCY}`)
})

test('分页扫描：进度单调递增且最终等于扫描总量', async () => {
    const server = makeServer([
        { items: items(10, 0), total: 20 },
        { items: items(10, 10), total: 20 }
    ])
    const snapshots: Array<{ scanned: number; total: number }> = []
    const summary = await scanMediaPages({
        pageSize: 10,
        concurrency: 1,
        fetchPage: server.fetchPage,
        apply: () => {},
        onProgress: (scanned, total) => snapshots.push({ scanned, total })
    })
    assert.deepEqual(snapshots, [
        { scanned: 10, total: 20 },
        { scanned: 20, total: 20 }
    ])
    assert.equal(summary.scanned, 20)
})

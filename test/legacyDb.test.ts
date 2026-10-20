/**
 * 旧脚本数据库导入的校验规则 —— 页面 IDB 是页面可写的，属于不可信输入，
 * 入库前必须逐条过滤（与文件迁移共用同一套 sanitize）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateLegacyRecordBytes, LEGACY_MAX_MESSAGE_RECORDS, planLegacyBatches, sanitizeLegacyIdmap, sanitizeLegacyUsers, sanitizeLegacyVideos } from '../src/shared/legacyDb'

test('视频记录：要求非空字符串 ID 与 Type', () => {
    const input = [{ ID: 'abc123', Type: 'full', Title: 'ok' }, { ID: '', Type: 'full' }, { ID: 'noType' }, { ID: 42, Type: 'full' }, null, 'string', { ID: 'partial', Type: 'partial', Unlisted: true }]
    const valid = sanitizeLegacyVideos(input)
    assert.deepEqual(
        valid.map((video) => video.ID),
        ['abc123', 'partial']
    )
    // 字段原样保留（旧库存的就是它自己的形态）
    assert.equal((valid[0] as unknown as Record<string, unknown>)['Title'], 'ok')
})

test('关注/好友记录：要求非空字符串 id', () => {
    const input = [{ id: 'u1', username: 'a' }, { id: '' }, { username: 'noid' }, { id: 'u2' }, 7, null]
    assert.deepEqual(
        sanitizeLegacyUsers(input).map((user) => user.id),
        ['u1', 'u2']
    )
})

test('ID 映射：href 缺失补空串，ID 为空则丢弃', () => {
    const input = [{ ID: 'v1', href: 'https://x/1' }, { ID: 'v2' }, { ID: '' }, { href: 'no-id' }, null]
    assert.deepEqual(sanitizeLegacyIdmap(input), [
        { ID: 'v1', href: 'https://x/1' },
        { ID: 'v2', href: '' }
    ])
})

test('非数组/异常值不抛错（页面数据不可信）', () => {
    assert.deepEqual(sanitizeLegacyVideos([]), [])
    assert.deepEqual(sanitizeLegacyUsers([]), [])
    assert.deepEqual(sanitizeLegacyIdmap([]), [])
})

// ── 分批（回归：旧库整表一次传输/写一个事务，撞上浏览器体积上限）──────

test('estimateLegacyRecordBytes 估算 JSON 体积，无法序列化时返回 0', () => {
    assert.equal(estimateLegacyRecordBytes({ ID: 'a' }), JSON.stringify({ ID: 'a' }).length)
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    assert.equal(estimateLegacyRecordBytes(cyclic), 0)
})

test('planLegacyBatches 按条数上限切批', () => {
    const records = Array.from({ length: 7 }, (_, index) => ({ ID: `v${index}` }))
    const batches = planLegacyBatches(records, Number.MAX_SAFE_INTEGER, 3)
    assert.deepEqual(
        batches.map((batch) => batch.length),
        [3, 3, 1]
    )
    assert.equal(batches.flat().length, records.length)
})

test('planLegacyBatches 按体积上限切批（不丢数据）', () => {
    // 每条约 100 字节；预算 250 → 每批最多 2 条
    const records = Array.from({ length: 5 }, (_, index) => ({ ID: `v${index}`, payload: 'x'.repeat(80) }))
    const size = estimateLegacyRecordBytes(records[0])
    const batches = planLegacyBatches(records, size * 2 + 1, 100)
    assert.ok(batches.length >= 3)
    assert.equal(batches.flat().length, records.length)
    for (const batch of batches) {
        const bytes = batch.reduce<number>((sum, record) => sum + estimateLegacyRecordBytes(record), 0)
        assert.ok(bytes <= size * 2 + 1 || batch.length === 1, `批超预算：${bytes}`)
    }
})

test('planLegacyBatches 单条超大记录单独成批（不丢弃，交给失败隔离处理）', () => {
    const records = [{ ID: 'small' }, { ID: 'huge', payload: 'x'.repeat(4096) }, { ID: 'small2' }]
    const batches = planLegacyBatches(records, 512, 100)
    const hugeBatch = batches.find((batch) => batch.some((record) => (record as { ID: string }).ID === 'huge'))
    assert.ok(hugeBatch)
    assert.equal(hugeBatch!.length, 1)
    assert.equal(batches.flat().length, records.length)
})

test('默认预算不允许退化成「越小越安全」：5000 条小记录只切成个位数批', () => {
    // 预算是按平台上限反推的（消息 16 MiB / 1000 条）：若有人把它调回 1 MiB / 200 条，
    // 一次 10 万条的旧库导入会退化成几千次跨进程往返 + 几千个事务。
    const records = Array.from({ length: 5000 }, (_, index) => ({ ID: `legacy${index}`, Type: 'partial', Title: `T${index}`, Payload: 'x'.repeat(60) }))
    const batches = planLegacyBatches(records)
    assert.ok(batches.length <= 5, `期望 ≤5 批，实际 ${batches.length} 批`)
    assert.equal(batches.flat().length, records.length)
    // 每批仍受条数上限约束（体积远未到预算时靠条数封顶）
    assert.ok(batches.every((batch) => batch.length <= LEGACY_MAX_MESSAGE_RECORDS))
})

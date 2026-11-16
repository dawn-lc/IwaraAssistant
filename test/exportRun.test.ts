/**
 * 导出运行快照的解析与派生。
 *
 * 这份形状存在的理由（见 `src/options/exportRun.ts` 头部）：导出**只能在文档里生成**，
 * 生产者因此是选项页；而选项页切页签会让 `ExportSection` 卸载，本地 state 归零，
 * 用户再点一次就是第二轮全表遍历 + 第二份文件。快照把「这一轮跑到哪」搬出组件，
 * 于是「脏值怎么办」「空库怎么算比例」「成功之后写什么」都必须有明确答案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { exportRunRatio, IDLE_EXPORT_RUN, parseExportRun, type ExportRun } from '../src/options/exportRun'

function run(overrides: Partial<ExportRun>): ExportRun {
    return { ...IDLE_EXPORT_RUN, status: 'running', target: 'file', store: 'videos', done: 3, total: 10, bytes: 1024, updatedAt: 1_700_000_000_000, ...overrides }
}

test('未知 status / 未知表名一律不可信（返回 null，调用方保留上一份）', () => {
    assert.equal(parseExportRun(undefined), null)
    assert.equal(parseExportRun(null), null)
    assert.equal(parseExportRun({ ...run({}), status: 'done' }), null)
    assert.equal(parseExportRun({ ...run({}), store: 'playlists' }), null)
    assert.equal(parseExportRun({ ...run({}), target: 'gist' })?.target, 'file')
})

test('三个合法状态与四张表都能往返（idle 是终态，不是「解析失败」）', () => {
    for (const status of ['idle', 'running', 'interrupted'] as const) {
        assert.equal(parseExportRun(run({ status }))?.status, status)
    }
    for (const store of ['videos', 'follows', 'friends', 'idmap'] as const) {
        assert.equal(parseExportRun(run({ store }))?.store, store)
    }
    assert.equal(parseExportRun(run({ target: 'clipboard' }))?.target, 'clipboard')
})

test('脏计数回 0、负数夹 0（进度条不能画到容器外）', () => {
    const parsed = parseExportRun({ ...run({}), done: 'x', total: -5, bytes: NaN, updatedAt: Infinity })
    assert.ok(parsed)
    assert.deepEqual({ done: parsed.done, total: parsed.total, bytes: parsed.bytes, updatedAt: parsed.updatedAt }, { done: 0, total: 0, bytes: 0, updatedAt: 0 })
})

test('比例：总量未知时返回 undefined（不用 0 冒充分母）', () => {
    assert.equal(exportRunRatio(null), undefined)
    assert.equal(exportRunRatio(run({ total: 0, done: 0 })), undefined)
})

test('比例：正常换算并夹取到 0~1（脏数据不能把条画到容器外）', () => {
    assert.equal(exportRunRatio(run({ done: 5, total: 10 })), 0.5)
    assert.equal(exportRunRatio(run({ done: 99, total: 10 })), 1)
    assert.equal(exportRunRatio(run({ done: 0, total: 10 })), 0)
})

test('终态必须可解析：成功写回 idle 而不是删键', () => {
    // `useStorageSnapshot` 把「解析不出来」当成「这份值不可信，保留上一份」，
    // 所以成功之后删键会让界面一直停在最后那个 running 上（进度条永不消失）。
    assert.deepEqual(parseExportRun({ ...IDLE_EXPORT_RUN, status: 'idle' }), IDLE_EXPORT_RUN)
})

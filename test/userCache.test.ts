/**
 * 关注/好友缓存写入判定（`shared/userCache.ts`）。
 *
 * 这组用例锁的是「撞唯一索引之后能不能删旧记录」——判错就会删掉别人的数据。
 * 用户实测的原始故障：视频数据已完整拿到，`putFollow` 撞 `username` 唯一索引抛
 * ConstraintError，被包成 VideoParseError，任务永远显示「重试解析失败」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { isStaleUsernameOwner, putUserCacheRecord } from '../src/shared/userCache'
import type { UserCacheStore } from '../src/shared/userCache'

const user = (id: string, username: string): Iwara.User => ({ id, username }) as Iwara.User

/** 假 store：可注入「按 username 查到的旧记录」与「是否抛冲突」 */
function makeStore(options: { existing?: { id?: unknown; username?: string }; conflictTimes?: number }): UserCacheStore & { records: Map<string, { id?: unknown; username?: string }>; removed: string[]; puts: number } {
    const records = new Map<string, { id?: unknown; username?: string }>()
    if (options.existing) records.set(String(options.existing.id), options.existing)
    let remainingConflicts = options.conflictTimes ?? 0
    const removed: string[] = []
    let puts = 0
    return {
        records,
        removed,
        get puts() {
            return puts
        },
        async put(record) {
            puts += 1
            if (remainingConflicts > 0) {
                remainingConflicts -= 1
                const error = new Error('constraint')
                error.name = 'ConstraintError'
                throw error
            }
            records.set(record.id, record)
        },
        async getByUsername(username) {
            return [...records.values()].find((record) => (record as { username?: string }).username === username)
        },
        async remove(id) {
            removed.push(id)
            records.delete(id)
        },
        isConstraintViolation(error) {
            return error instanceof Error && error.name === 'ConstraintError'
        }
    }
}

test('过期判定：同名不同 id 才算过期（可以删）', () => {
    assert.equal(isStaleUsernameOwner({ id: 'old' }, 'new'), true)
})

test('过期判定：同名同 id 不算过期（put 本该覆盖，还冲突说明另有问题）', () => {
    assert.equal(isStaleUsernameOwner({ id: 'same' }, 'same'), false)
})

test('过期判定：查不到记录 / id 缺失或非字符串时都不动数据', () => {
    assert.equal(isStaleUsernameOwner(undefined, 'new'), false)
    assert.equal(isStaleUsernameOwner({}, 'new'), false)
    assert.equal(isStaleUsernameOwner({ id: '' }, 'new'), false)
    assert.equal(isStaleUsernameOwner({ id: 42 }, 'new'), false)
})

test('写入正常：不查索引、不删任何记录', async () => {
    const store = makeStore({})
    assert.equal(await putUserCacheRecord(store, user('u1', 'alice')), 'written')
    assert.deepEqual(store.removed, [])
    assert.equal(store.records.get('u1')?.['id'], 'u1')
})

test('同名冲突且旧记录 id 不同：删掉旧记录并重写一次', async () => {
    const store = makeStore({ existing: { id: 'stale-id', username: 'alice' }, conflictTimes: 1 })
    assert.equal(await putUserCacheRecord(store, user('fresh-id', 'alice')), 'repaired')
    assert.deepEqual(store.removed, ['stale-id'])
    assert.equal(store.records.has('stale-id'), false)
    assert.equal(store.records.get('fresh-id')?.['id'], 'fresh-id')
})

test('同名冲突但旧记录 id 相同：不删数据，如实失败', async () => {
    const store = makeStore({ existing: { id: 'same-id', username: 'alice' }, conflictTimes: 1 })
    assert.equal(await putUserCacheRecord(store, user('same-id', 'alice')), 'failed')
    assert.deepEqual(store.removed, [])
})

test('冲突但按 username 查不到旧记录：不盲删，如实失败', async () => {
    const store = makeStore({ conflictTimes: 1 })
    assert.equal(await putUserCacheRecord(store, user('fresh-id', 'alice')), 'failed')
    assert.deepEqual(store.removed, [])
})

test('非唯一索引冲突的错误不触发修复（别的故障不该被吞成同名冲突）', async () => {
    const store = makeStore({ existing: { id: 'stale-id', username: 'alice' } })
    const put = store.put
    store.put = async () => {
        const error = new Error('quota')
        error.name = 'QuotaExceededError'
        throw error
    }
    assert.equal(await putUserCacheRecord(store, user('fresh-id', 'alice')), 'failed')
    assert.deepEqual(store.removed, [])
    store.put = put
})

test('username 缺失/非字符串时无法走索引，如实失败且不动数据', async () => {
    const store = makeStore({ existing: { id: 'stale-id', username: 'alice' }, conflictTimes: 2 })
    const dirty = { id: 'fresh-id' } as Iwara.User
    assert.equal(await putUserCacheRecord(store, dirty), 'failed')
    assert.deepEqual(store.removed, [])
})

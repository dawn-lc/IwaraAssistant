/**
 * 订阅流自动遍历的判据与接线。
 *
 * 为什么值得单测：这条链路的所有错误都是**静默**的。
 * - 判据写反（`filterUnlistedAndPrivate` 忘了取反）→ 两个互斥功能同时跑，用户只看到「回填没效果」；
 * - 间隔判据写反 → 每切一次列表页打一轮订阅流，用户只看到「站点变慢/被限流」；
 * - 页面没有把「到达 /videos」报给后台 → 自动遍历永远不发生，且没有任何报错。
 * 所以除了纯函数，还要把「谁在什么时机调用谁」用源码级断言钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { AUTO_SYNC_MIN_INTERVAL_MS, isAutoSyncDue, shouldAutoSyncSubscribed } from '../src/shared/autoSync'
import { isAllVideosPath } from '../src/shared/pageType'

test('判据：回填开 + 过滤关 才自动跑（源 menu.pageChange 的同款条件）', () => {
    assert.equal(shouldAutoSyncSubscribed({ addUnlistedAndPrivate: true, filterUnlistedAndPrivate: false }), true)
})

test('判据：两项都开时不跑（互斥功能同时开会自相抵消）', () => {
    assert.equal(shouldAutoSyncSubscribed({ addUnlistedAndPrivate: true, filterUnlistedAndPrivate: true }), false)
})

test('判据：回填关时不跑（不管过滤开关）', () => {
    assert.equal(shouldAutoSyncSubscribed({ addUnlistedAndPrivate: false, filterUnlistedAndPrivate: false }), false)
    assert.equal(shouldAutoSyncSubscribed({ addUnlistedAndPrivate: false, filterUnlistedAndPrivate: true }), false)
})

test('间隔：从没跑过就立刻跑', () => {
    assert.equal(isAutoSyncDue(undefined, 1_000_000), true)
})

test('间隔：不到最小间隔不跑，到点就跑', () => {
    const now = 10_000_000
    assert.equal(isAutoSyncDue(now - 1000, now), false)
    assert.equal(isAutoSyncDue(now - AUTO_SYNC_MIN_INTERVAL_MS + 1, now), false)
    assert.equal(isAutoSyncDue(now - AUTO_SYNC_MIN_INTERVAL_MS, now), true)
    assert.equal(isAutoSyncDue(now - AUTO_SYNC_MIN_INTERVAL_MS * 3, now), true)
})

test('间隔：脏时间戳视为「从没跑过」，不能让它把自动遍历永久卡死', () => {
    const now = 10_000_000
    for (const dirty of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(isAutoSyncDue(dirty, now), true, `${dirty} 应视为没跑过`)
    }
})

test('间隔：now 非法时不跑（环境异常时不发网络请求）', () => {
    assert.equal(isAutoSyncDue(undefined, Number.NaN), false)
    assert.equal(isAutoSyncDue(1, Number.POSITIVE_INFINITY), false)
})

test('触发页：只有 /videos 本身算（首页、搜索、主页、播放列表都不算）', () => {
    assert.equal(isAllVideosPath('/videos'), true)
    for (const other of ['/', '/videos/123', '/search', '/profile/alice', '/playlist/x', '/subscriptions', '/video/abc', '/videosfoo']) {
        assert.equal(isAllVideosPath(other), false, `${other} 不该触发自动遍历`)
    }
})

test('接线：页面到达 /videos 时上报，后台独立判配置与间隔', () => {
    const pageUi = readFileSync('src/content/pageUi.ts', 'utf8')
    // 只上报「到达」，配置语义留在后台（两份判据迟早会漂移）
    assert.match(pageUi, /AUTO_SYNC_SUBSCRIBED/)
    assert.match(pageUi, /isAllVideosPath\(window\.location\.pathname\)/)
    // 冷加载与路由变化都要报：源项目 pageChange() 同样两处都会跑
    assert.equal(pageUi.match(/reportAllVideosVisit\(\)/g)?.length, 3, '定义 1 处 + 冷加载 1 处 + 路由重建 1 处')

    const background = readFileSync('src/background/index.ts', 'utf8')
    assert.match(background, /case 'AUTO_SYNC_SUBSCRIBED':[\s\S]{0,200}return autoSyncSubscribed\(\)/)

    const pageSync = readFileSync('src/background/iwara/pageSync.ts', 'utf8')
    // 时间戳必须在真正开跑之前写：失败也算一次尝试，否则掉登录会每次切页重打一轮
    const body = pageSync.slice(pageSync.indexOf('export async function autoSyncSubscribed'))
    assert.ok(body.indexOf('AUTO_SYNC_AT_KEY]: Date.now()') < body.indexOf('await parseUnlistedAndPrivate()'), '先记时间戳再跑')

    // 手动入口必须保留「无条件执行」语义：用户点了按钮就该跑
    assert.match(background, /case 'SYNC_SUBSCRIBED':\s*\n\s*return parseUnlistedAndPrivate\(\)/)
})

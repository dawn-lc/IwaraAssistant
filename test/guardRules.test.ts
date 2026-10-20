/**
 * 钓鱼防护的后台状态机（`background/runtime/guardRules.ts`）。
 *
 * 为什么用假 browser 跑单测而不是全靠 e2e：
 * - **状态机是安全性的载体**：`armed / released / none` 三个状态谁覆盖谁、什么时候清理，
 *   一条写错就变成「仿冒站能自解封」或「正常网站被误封」；
 * - 真实浏览器里没法把「SW 被回收、内存丢了」这种时机精确造出来，而这里的逻辑恰恰
 *   必须跨回收成立（放行记录在 storage.session，规则在浏览器内核）。
 *
 * 用不同的 tabId 隔离用例：模块内 `released` 是跨用例的缓存，单靠断言清理会让用例
 * 互相污染（这也是真实的 SW 行为——同一次唤醒内它是内存缓存）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

interface FakeRule {
    id: number
    condition: { tabIds?: number[]; excludedResourceTypes?: string[] }
}

const rules = new Map<number, FakeRule>()
const sessionStore = new Map<string, unknown>()
const openTabs = new Map<number, { url: string }>()
const updatedListeners: Array<(tabId: number, changeInfo: { status?: string; url?: string }, tab: { url?: string }) => void> = []
const removedListeners: Array<(tabId: number) => void> = []

const fakeBrowser = {
    declarativeNetRequest: {
        updateSessionRules: async (options: { removeRuleIds?: number[]; addRules?: FakeRule[] }) => {
            for (const id of options.removeRuleIds ?? []) rules.delete(id)
            for (const rule of options.addRules ?? []) rules.set(rule.id, rule)
        },
        getSessionRules: async () => [...rules.values()]
    },
    storage: {
        session: {
            get: async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
            set: async (items: Record<string, unknown>) => {
                for (const [key, value] of Object.entries(items)) sessionStore.set(key, value)
            }
        }
    },
    tabs: {
        get: async (tabId: number) => {
            const tab = openTabs.get(tabId)
            if (tab === undefined) throw new Error(`no tab ${tabId}`)
            return tab
        },
        onUpdated: { addListener: (listener: (typeof updatedListeners)[number]) => updatedListeners.push(listener) },
        onRemoved: { addListener: (listener: (typeof removedListeners)[number]) => removedListeners.push(listener) }
    }
}

globalThis.browser = fakeBrowser as unknown as typeof chrome

const guard = await import('../src/background/runtime/guardRules')
guard.installGuardWatchers()

/** 监听器内部是 `void (async ...)()`，让它跑完再断言 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
const ruleIdsOf = (): number[] => [...rules.keys()]
const releasedMap = (): Record<string, string> => (sessionStore.get('guardReleased') ?? {}) as Record<string, string>

test('仿冒站点：装上按标签页的封锁规则', async () => {
    const mode = await guard.syncGuard(101, 'iwara-fake.example')
    assert.equal(mode, 'armed')
    const rule = rules.get(101)
    assert.ok(rule)
    assert.deepEqual(rule.condition.tabIds, [101])
    // 只放过顶层导航：否则用户点「离开」都走不了
    assert.deepEqual(rule.condition.excludedResourceTypes, ['main_frame'])
})

test('重复同步是幂等的：一个标签页只会有一条规则', async () => {
    await guard.syncGuard(102, 'iwara-fake.example')
    await guard.syncGuard(102, 'iwara-fake.example')
    assert.deepEqual(
        ruleIdsOf().filter((id) => id === 102),
        [102]
    )
})

test('官方站点：不加规则，并且顺手清掉可能的残留', async () => {
    rules.set(103, { id: 103, condition: { tabIds: [103] } })
    const mode = await guard.syncGuard(103, 'www.iwara.tv')
    assert.equal(mode, 'none')
    assert.equal(rules.has(103), false)
})

test('放行后刷新不再拦：同一标签页+主机名 → released，规则撤掉', async () => {
    rules.set(104, { id: 104, condition: { tabIds: [104] } })
    await guard.releaseGuard(104, 'iwara-fake.example')
    assert.equal(rules.has(104), false)
    // 放行要跨 SW 回收成立，所以必须落 storage.session
    assert.equal(releasedMap()['104'], 'iwara-fake.example')

    const mode = await guard.syncGuard(104, 'iwara-fake.example')
    assert.equal(mode, 'released')
    assert.equal(rules.has(104), false)
})

test('放行只对该主机名有效：换一个仿冒域名要重新拦', async () => {
    await guard.releaseGuard(105, 'iwara-fake.example')
    const mode = await guard.syncGuard(105, 'iwara-login.example')
    assert.equal(mode, 'armed')
    assert.equal(rules.has(105), true)
})

test('离开仿冒站：规则与放行记录一起清掉', async () => {
    openTabs.set(106, { url: 'http://iwara-fake.example/login' })
    await guard.releaseGuard(106, 'iwara-fake.example')
    await guard.syncGuard(106, 'iwara-fake.example')

    for (const listener of updatedListeners) listener(106, { status: 'loading' }, { url: 'https://example.com/' })
    await settle()

    assert.equal(rules.has(106), false)
    assert.equal(releasedMap()['106'], undefined)
})

test('停在仿冒站刷新时不清放行记录（否则「继续访问」一刷新就失效）', async () => {
    openTabs.set(107, { url: 'http://iwara-fake.example/next' })
    await guard.releaseGuard(107, 'iwara-fake.example')

    for (const listener of updatedListeners) listener(107, {}, { url: 'http://iwara-fake.example/other' })
    await settle()

    assert.equal(releasedMap()['107'], 'iwara-fake.example')
})

test('标签页关闭：规则与放行记录一起清掉', async () => {
    openTabs.set(108, { url: 'http://iwara-fake.example/' })
    await guard.releaseGuard(108, 'iwara-fake.example')

    for (const listener of removedListeners) listener(108)
    await settle()

    assert.equal(rules.has(108), false)
    assert.equal(releasedMap()['108'], undefined)
})

test('SW 醒来对账：标签页已不存在的残留规则被撤掉', async () => {
    rules.set(109, { id: 109, condition: { tabIds: [109] } })
    await guard.reconcileGuardRules()
    assert.equal(rules.has(109), false)
})

test('SW 醒来对账：仍停在仿冒站的标签页保留规则', async () => {
    openTabs.set(110, { url: 'http://iwara-fake.example/' })
    rules.set(110, { id: 110, condition: { tabIds: [110] } })
    await guard.reconcileGuardRules()
    assert.equal(rules.has(110), true)
})

/**
 * 通知点击目标登记表（`background/runtime/notify.ts`）。
 *
 * 守的是一个**实测报备过的缺陷**：任务通知点了能开任务面板，但「检测到第三方下载链接」
 * 那条点了毫无反应——`onClicked` 里只认 `task-` 前缀，其余一律 return。
 * 通知是扩展唯一的异步反馈通道（docs/05），点不动等于反馈断在半路。
 *
 * 为什么用假 browser 跑单测：真实环境里没法规避「用户在 SW 被回收之后才点通知」这个时机，
 * 而这套登记表存在的**理由**就是跨 SW 回收成立（它在 storage.session 而不是内存闭包）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

interface FakeNotificationOptions {
    title?: string
    message: string
    silent?: boolean
    requireInteraction?: boolean
}

const sessionStore = new Map<string, unknown>()
const created: Array<{ id: string; options: FakeNotificationOptions }> = []
/** 模拟「系统里当前活着的通知」（`notifications.getAll` 的返回） */
const alive = new Map<string, true>()

const fakeBrowser = {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    notifications: {
        create: async (id: string, options: FakeNotificationOptions) => {
            created.push({ id, options })
            // 与真实 API 一致：同 id 会先清掉旧的再创建
            alive.set(id, true)
            return id
        },
        clear: async (id: string) => {
            const existed = alive.delete(id)
            return existed
        },
        getAll: async () => Object.fromEntries(alive)
    },
    storage: {
        session: {
            get: async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
            set: async (items: Record<string, unknown>) => {
                for (const [key, value] of Object.entries(items)) sessionStore.set(key, value)
            }
        }
    }
}

globalThis.browser = fakeBrowser as unknown as typeof chrome

const { clearNotification, consumeNotificationTarget, notifyInfo, notifyWarn, showNotification } = await import('../src/background/runtime/notify')

/** `notifyInfo` / `notifyWarn` 是 fire-and-forget：等内部 await 链跑完再断言 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

test('第三方下载链接通知：点击回到视频页（不再点了没反应）', async () => {
    const url = 'https://www.iwara.tv/video/abc123'
    await showNotification('warn-links-abc123', { message: 'm', target: { kind: 'url', url } })
    assert.deepEqual(await consumeNotificationTarget('warn-links-abc123'), { kind: 'url', url })
})

test('点击目标是一次性的：消费后立刻删除（连点不会开出两个标签页）', async () => {
    await showNotification('warn-links-once', { message: 'm', target: { kind: 'url', url: 'https://www.iwara.tv/video/once' } })
    assert.notEqual(await consumeNotificationTarget('warn-links-once'), null)
    assert.equal(await consumeNotificationTarget('warn-links-once'), null)
})

test('没有登记过的通知：点击拿不到目标，也不抛错（旧版本残留的通知不会误开页面）', async () => {
    assert.equal(await consumeNotificationTarget('task-never-registered'), null)
})

test('任务通知落到任务面板页签（页签 id 是深链契约，写错就开到空页）', async () => {
    await showNotification('task-42', { message: 'm', target: { kind: 'options', tab: 'tasks' } })
    assert.deepEqual(await consumeNotificationTarget('task-42'), { kind: 'options', tab: 'tasks' })
})

test('登记表上限 50 条：被忽略的通知不会让 session 存储无限增长', async () => {
    for (let index = 0; index < 60; index++) {
        await showNotification(`warn-links-cap${index}`, { message: 'm', target: { kind: 'url', url: `https://www.iwara.tv/video/cap${index}` } })
    }
    const stored = sessionStore.get('notificationTargets') as Record<string, unknown>
    assert.equal(Object.keys(stored).length, 50)
    // 淘汰的是最旧的，最新的仍在
    assert.equal(stored['warn-links-cap0'], undefined)
    assert.notEqual(stored['warn-links-cap59'], undefined)
})

test('同一个 id 重复通知时目标被覆盖（不会因复用 id 抢到旧落点）', async () => {
    await showNotification('warn-links-dup', { message: 'm', target: { kind: 'url', url: 'https://www.iwara.tv/video/first' } })
    await showNotification('warn-links-dup', { message: 'm', target: { kind: 'options', tab: 'tasks' } })
    assert.deepEqual(await consumeNotificationTarget('warn-links-dup'), { kind: 'options', tab: 'tasks' })
})

test('notifyWarn / notifyInfo 会把目标登记进 session（调用点是 fire-and-forget）', async () => {
    notifyWarn('links-xyz', 'm', { kind: 'url', url: 'https://www.iwara.tv/video/xyz' })
    notifyInfo('batch-queued', 'm', { kind: 'options', tab: 'tasks' })
    await settle()
    assert.deepEqual(await consumeNotificationTarget('warn-links-xyz'), { kind: 'url', url: 'https://www.iwara.tv/video/xyz' })
    assert.deepEqual(await consumeNotificationTarget('info-batch-queued'), { kind: 'options', tab: 'tasks' })
})

test('通知标题缺省用品牌名（与 popup / 水印 / 右键菜单同源）', async () => {
    created.length = 0
    await showNotification('warn-links-title', { message: 'm', target: { kind: 'url', url: 'https://www.iwara.tv/video/title' } })
    assert.equal(created[0]?.options.title, 'Iwara Assistant')
})

test('显式给出的标题优先于品牌名（任务通知等场景可换标题）', async () => {
    created.length = 0
    await showNotification('warn-links-custom', { message: 'm', title: 'Custom', target: { kind: 'url', url: 'https://www.iwara.tv/video/custom' } })
    assert.equal(created[0]?.options.title, 'Custom')
})

test('存储里混入脏值时不炸：只保留结构合法的目标', async () => {
    sessionStore.set('notificationTargets', {
        'warn-links-good': { kind: 'url', url: 'https://www.iwara.tv/video/good' },
        'warn-links-bad-kind': { kind: 'nonsense', url: 'https://www.iwara.tv/video/bad' },
        'warn-links-bad-shape': 'not-an-object'
    })
    assert.deepEqual(await consumeNotificationTarget('warn-links-good'), { kind: 'url', url: 'https://www.iwara.tv/video/good' })
    assert.equal(await consumeNotificationTarget('warn-links-bad-kind'), null)
    assert.equal(await consumeNotificationTarget('warn-links-bad-shape'), null)
})

test('点击时复制的文件名随目标一起登记（源项目的复制动作挂在「打开视频链接」按钮上）', async () => {
    await showNotification('warn-links-copy', { message: 'm', target: { kind: 'url', url: 'https://www.iwara.tv/video/copy', copyText: 'C:/iwara/author/Title[id].mp4' } })
    assert.deepEqual(await consumeNotificationTarget('warn-links-copy'), {
        kind: 'url',
        url: 'https://www.iwara.tv/video/copy',
        copyText: 'C:/iwara/author/Title[id].mp4'
    })
})

test('copyText 类型不对的脏目标整条丢弃（宁可点了不复制，也不要把乱码写进剪贴板）', async () => {
    sessionStore.set('notificationTargets', { 'warn-links-bad-copy': { kind: 'url', url: 'https://www.iwara.tv/video/badcopy', copyText: 42 } })
    assert.equal(await consumeNotificationTarget('warn-links-bad-copy'), null)
})

// ── 生命周期（对齐源 toastify 的 duration/silent 语义）──────────────────

test('信息级通知：静音 + 到点自动关闭（对齐源 Info 的 duration:2000）', async () => {
    created.length = 0
    await showNotification('info-auto', { message: 'm', target: { kind: 'options', tab: 'tasks' }, silent: true, autoCloseMs: 20 })
    assert.equal(created.at(-1)?.options.silent, true)
    assert.equal(alive.has('info-auto'), true, '创建后应当存在')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(alive.has('info-auto'), false, '到点必须自己消失，不能永久占着通知中心')
})

test('警告通知常驻（对齐源 Warn/Error 的 duration:-1，等用户处理）', async () => {
    created.length = 0
    notifyWarn('warn-sticky', 'm', { kind: 'options', tab: 'tasks' })
    await settle()
    assert.equal(created.at(-1)?.options.requireInteraction, true)
    // 与源的有意差异：系统通知保留提示音（源 toast 在页面上有视觉存在感，静音后会彻底错过）
    assert.notEqual(created.at(-1)?.options.silent, true)
})

test('主动关闭（源 toast.hide 的等价物）：实时生效且重复调用不报错', async () => {
    await showNotification('warn-manual-close', { message: 'm', target: { kind: 'options', tab: 'tasks' } })
    assert.equal(await clearNotification('warn-manual-close'), true)
    assert.equal(alive.has('warn-manual-close'), false)
    assert.equal(await clearNotification('warn-manual-close'), false, '已经没了再关返回 false，而不是抛错')
})

test('通知被系统清掉后，目标按 getAll 对账清理（不会误删还活着的）', async () => {
    await showNotification('warn-prune-alive', { message: 'm', target: { kind: 'options', tab: 'tasks' } })
    await showNotification('warn-prune-dead', { message: 'm', target: { kind: 'options', tab: 'tasks' } })
    // 模拟用户直接划掉 dead（不经过我们的 clear，因此没有 onClosed 清理）
    alive.delete('warn-prune-dead')
    // 任何后续通知创建都会触发对账
    await showNotification('warn-prune-trigger', { message: 'm', target: { kind: 'options', tab: 'tasks' } })
    assert.equal(await consumeNotificationTarget('warn-prune-dead'), null, '已消失的通知不该留着目标')
    assert.deepEqual(await consumeNotificationTarget('warn-prune-alive'), { kind: 'options', tab: 'tasks' }, '还活着的通知目标不能被误删')
})

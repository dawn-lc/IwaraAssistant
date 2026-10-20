/**
 * 钓鱼防护 —— 扩展网络层封锁（declarativeNetRequest session 规则）。
 *
 * 为什么需要网络层：`content/guard/main.ts` 只能改页面 JS 上的几个 API。仿冒站绕开它们
 * 继续外传数据的手段还很多——`new Image().src`、`navigator.sendBeacon`、
 * `<form action="https://evil/collect" method="POST">`、跨域 iframe 里的原生 fetch。
 * DNR 在请求进入网络栈之前拦截，才是「真的发不出去」。
 *
 * 状态机（每个标签页最多一条规则，规则即状态）：
 *
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> none
 *     none --> armed: 页面同步 + 主机名疑似仿冒（GUARD_SYNC）
 *     armed --> released: 用户点「继续访问」（GUARD_RELEASE）
 *     armed --> none: 标签页离开仿冒站 / 关闭
 *     released --> none: 标签页离开仿冒站 / 关闭
 * ```
 *
 * 「已放行」必须跨 SW 挂起重入可用（Chrome SW 空闲 ~30s 就回收），所以记在
 * `storage.session`；不能记 `storage.local`（tabId 跨会话会重用）。
 *
 * 判定在后台而不是页面：ISOLATED 脚本的声称也只是「输入」，`classifyHost` 必须复核
 * （docs/01「业务判定归后台」）。
 */
import { guardRuleForTab, type GuardMode } from '../../shared/guardRule'
import { classifyHost } from '../../shared/site'
import { GUARD_RELEASED_KEY } from '../../shared/storageKeys'

/** tabId（字符串化，storage 是 JSON 对象）→ 放行时的主机名 */
type ReleasedMap = Record<string, string>

/** 已放行记录的内存副本；SW 重启后为空，由 `loadReleased()` 从 storage.session 水合 */
let released: ReleasedMap | null = null

function rulesApi(): typeof chrome.declarativeNetRequest | undefined {
    return browser.declarativeNetRequest
}

function hostOf(raw: string): string {
    try {
        return new URL(raw).hostname
    } catch {
        return ''
    }
}

function isReleasedMap(value: unknown): value is ReleasedMap {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    return Object.values(value).every((entry) => typeof entry === 'string')
}

async function loadReleased(): Promise<ReleasedMap> {
    if (released !== null) return released
    try {
        const stored = await browser.storage.session.get(GUARD_RELEASED_KEY)
        const value: unknown = stored[GUARD_RELEASED_KEY]
        released = isReleasedMap(value) ? value : {}
    } catch (error) {
        // 读不到就当作「没放行」：方向是更保守，不值得为此让防护失效
        console.warn('[iwara-assistant] 钓鱼防护：读取放行记录失败，按未放行处理:', error)
        released = {}
    }
    return released
}

async function saveReleased(next: ReleasedMap): Promise<void> {
    released = next
    try {
        await browser.storage.session.set({ [GUARD_RELEASED_KEY]: next })
    } catch (error) {
        // 写不进去只影响「刷新后是否再问一次」，不放松当前这一页的拦截范围
        console.warn('[iwara-assistant] 钓鱼防护：保存放行记录失败:', error)
    }
}

async function forgetRelease(tabId: number): Promise<void> {
    const map = await loadReleased()
    if (!(String(tabId) in map)) return
    const next = { ...map }
    delete next[String(tabId)]
    await saveReleased(next)
}

/** 装上/覆盖该标签页的封锁规则（重复下发幂等：先按 id 删再添加） */
async function arm(tabId: number): Promise<void> {
    const rules = rulesApi()
    if (!rules) return
    try {
        await rules.updateSessionRules({ removeRuleIds: [tabId], addRules: [guardRuleForTab(tabId)] })
    } catch (error) {
        // 降级：页面级（fetch/XHR/WS/beacon/表单/WebRTC）拦截仍在，只是拦不住 img/iframe
        console.warn('[iwara-assistant] 钓鱼防护：网络层封锁启用失败，仅保留页面级拦截:', error)
    }
}

async function disarm(tabId: number): Promise<void> {
    const rules = rulesApi()
    if (!rules) return
    try {
        await rules.updateSessionRules({ removeRuleIds: [tabId] })
    } catch (error) {
        console.warn('[iwara-assistant] 钓鱼防护：解除网络层封锁失败:', error)
    }
}

/** 页面载入时调用：判定 → 封锁 → 告诉页面该显示什么 */
export async function syncGuard(tabId: number, host: string): Promise<GuardMode> {
    if (classifyHost(host) !== 'suspicious') {
        await forgetRelease(tabId)
        await disarm(tabId)
        return 'none'
    }
    const map = await loadReleased()
    if (map[String(tabId)] === host) {
        // 放行过：规则必须同步撤掉（否则刷新后页面还是加载不出来，放行等于没放行）
        await disarm(tabId)
        return 'released'
    }
    await arm(tabId)
    return 'armed'
}

/** 用户明确选择「继续访问」：解除封锁，并记住这个标签页+主机名（刷新不再打扰） */
export async function releaseGuard(tabId: number, host: string): Promise<void> {
    await disarm(tabId)
    if (classifyHost(host) !== 'suspicious') return
    await saveReleased({ ...(await loadReleased()), [String(tabId)]: host })
}

/**
 * 标签页级状态清理。
 *
 * **必须在 `tabs.onUpdated` 里做**：规则按 tabId 匹配，上一个文档的封锁如果不撤，
 * 新站点的子资源会被误杀（顶层导航被 `main_frame` 排除，所以用户看起来是「网站坏了」）。
 */
export function installGuardWatchers(): void {
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        // 只处理顶层文档开始加载（`changeInfo.url` 单独出现时也意味着换了文档）
        if (changeInfo.status !== 'loading' && changeInfo.url === undefined) return
        const url = changeInfo.url ?? tab.url
        if (url === undefined) return
        // 仍停在仿冒站：保持现状（放行记录也要保住，否则「继续访问」一刷新就失效）
        if (classifyHost(hostOf(url)) === 'suspicious') return
        void (async () => {
            await forgetRelease(tabId)
            await disarm(tabId)
        })()
    })

    browser.tabs.onRemoved.addListener((tabId) => {
        void (async () => {
            await forgetRelease(tabId)
            await disarm(tabId)
        })()
    })
}

/**
 * 启动时对齐残留规则。
 *
 * SW 被回收时内存里的东西全丢，但 session 规则还留在浏览器里。醒来先扫一遍：
 * 规则对应的标签页已经不存在、或者已经不在仿冒站，就撤掉——否则那个标签页后面的
 * 正常浏览会被一条看不见的规则毁掉。
 */
export async function reconcileGuardRules(): Promise<void> {
    const rules = rulesApi()
    if (!rules) return
    try {
        const existing = await rules.getSessionRules()
        const stale: number[] = []
        for (const rule of existing) {
            const tabId = rule.condition.tabIds?.[0]
            if (tabId === undefined || tabId <= 0) {
                stale.push(rule.id)
                continue
            }
            const tab = await browser.tabs.get(tabId).catch(() => null)
            if (tab === null || classifyHost(hostOf(tab.url ?? '')) !== 'suspicious') stale.push(rule.id)
        }
        if (stale.length > 0) await rules.updateSessionRules({ removeRuleIds: stale })

        // 放行记录同样要清理：标签页没了、或已经不在仿冒站
        const map = await loadReleased()
        const next: ReleasedMap = {}
        let changed = false
        for (const [key, host] of Object.entries(map)) {
            const tabId = Number(key)
            const tab = Number.isSafeInteger(tabId) && tabId > 0 ? await browser.tabs.get(tabId).catch(() => null) : null
            if (tab === null || classifyHost(hostOf(tab.url ?? '')) !== 'suspicious') changed = true
            else next[key] = host
        }
        if (changed) await saveReleased(next)
    } catch (error) {
        console.warn('[iwara-assistant] 钓鱼防护：残留规则对齐失败:', error)
    }
}

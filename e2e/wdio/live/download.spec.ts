/**
 * 真实站点**全链路下载**（显式开关，不进常规套件与 CI）
 *
 * 与 `site.spec.ts` 的分工：那边只做页面 DOM 层冒烟（零副作用，绝不建任务）；
 * 这边反过来——只测下载链路，不碰页面 UI：
 *
 * ```
 * storage.local(config + refresh token)
 *   → INIT_DOWNLOAD（后台，与右键菜单/页内按钮同一条消息）
 *   → parseVideoInfo('full')（api.iwara.tv，带 Authorization + X-Version）
 *   → aria2.addUri（用户配置的 RPC 端点）
 *   → aria2 真实收到该视频的下载任务
 * ```
 *
 * 为什么不用页面按钮触发：页内 UI 需要先过 Cloudflare 并完成 MAIN/ISOLATED 握手，
 * 失败原因会混在一起。下载链路的正确性只取决于「配置 + 令牌 + 后台」，从扩展页
 * 直接发同一条消息，能把风控变量隔离在外——链路真断了才失败。
 *
 * 运行（令牌只经环境变量传入，**绝不写进仓库**）：
 * ```
 * $env:E2E_LIVE_REFRESH = '<refresh token>'
 * $env:E2E_LIVE_ARIA2_TOKEN = '<aria2 rpc token>'
 * npm run test:e2e:wdio:live:firefox
 * ```
 * 可选：`E2E_LIVE_VIDEO_ID`（默认 vhgZWCBx8X3lxT）、`E2E_LIVE_ARIA2_PATH`、
 * `E2E_LIVE_KEEP_TASK=1`（下载完成后不从 aria2 移除）。
 */
import { browser, expect } from '@wdio/globals'
import { ensureExtensionSession, type ExtensionSession } from '../helpers/extension'
import { liveEnabled } from '../helpers/live'

const VIDEO_ID = process.env.E2E_LIVE_VIDEO_ID?.trim() || 'vhgZWCBx8X3lxT'
const REFRESH = process.env.E2E_LIVE_REFRESH?.trim() ?? ''
const ARIA2_TOKEN = process.env.E2E_LIVE_ARIA2_TOKEN?.trim() ?? ''
const ARIA2_PATH = process.env.E2E_LIVE_ARIA2_PATH?.trim() || 'http://10.0.0.165:60050/jsonrpc'
/**
 * 下载路径模板。默认就是用户实机配置；改用本机 aria2 时要换（Windows 与 NAS 的
 * 文件系统不同），故做成环境变量。
 */
const DOWNLOAD_PATH = process.env.E2E_LIVE_DOWNLOAD_PATH?.trim() || '/storage/iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4'
/** 路径模板里 `%#...#%` 之前的字面前缀（用作「目录来自模板」的断言依据） */
const PATH_PREFIX = DOWNLOAD_PATH.slice(0, DOWNLOAD_PATH.indexOf('%'))
const KEEP_TASK = /^(1|true|yes)$/i.test(process.env.E2E_LIVE_KEEP_TASK?.trim() ?? '')

/**
 * 实机配置（与用户提供的配置逐字段一致）。
 * 唯一差异：`authorization` 不写进 config —— 它属于 `storage.local['auth:refresh']`，
 * 这是本扩展与原油猴脚本的存储差异，也正是历史上「导入了配置却没登录」的坑。
 */
const CONFIG = {
    language: 'zh',
    autoFollow: true,
    autoLike: true,
    autoDownloadMetadata: false,
    addUnlistedAndPrivate: true,
    filterUnlistedAndPrivate: false,
    autoCollapseMenu: true,
    friendRequestApprovalConditions: ['followedBy'],
    friendRequestApprovalMode: 'all',
    friendApproveEvidenceThreadId: '',
    promoteScriptAuthor: true,
    enableUnsafeMode: true,
    enableBeautify: true,
    enableWidescreen: true,
    experimentalFeatures: true,
    autoInjectCheckbox: true,
    autoCopySaveFileName: false,
    filterLikedVideos: false,
    checkDownloadLink: true,
    checkPriority: true,
    downloadPriority: 'Source',
    downloadType: 0,
    downloadPath: DOWNLOAD_PATH,
    downloadProxy: 'http://10.0.0.1:7890',
    downloadProxyUsername: '',
    downloadProxyPassword: '',
    aria2Path: ARIA2_PATH,
    aria2Token: ARIA2_TOKEN,
    iwaradlPath: 'http://127.0.0.1:23456/api/tasks',
    iwaradlToken: '1377538a747e4319a6a988d393285d32',
    mediaCenterApi: 'https://nas.dawnlc.me/',
    mediaCenterApiKey: 'bSoVWiVJThfeRXelIT2xKwP5kYeM8UcfU',
    pathNormalize: true,
    pathReplaceEmojis: true,
    pathFolds: true,
    pathFoldMarks: true,
    pathSanitize: true,
    pathTruncate: true,
    pathTitleMaxLength: 72,
    pathAliasMaxLength: 64,
    priority: { 360: 98, 540: 99, Source: 100, preview: 1 }
} as const

interface QueueTask {
    id?: string
    videoId?: string
    status?: string
    detail?: string
    filename?: string
    kind?: string
    gid?: string
}

interface Aria2File {
    path?: string
    length?: string
    completedLength?: string
    selected?: string
}

interface Aria2Status {
    gid?: string
    status?: string
    totalLength?: string
    completedLength?: string
    downloadSpeed?: string
    dir?: string
    files?: Aria2File[]
    errorMessage?: string
    errorCode?: string
}

describe('Iwara Assistant 真实站点全链路下载', () => {
    let session: ExtensionSession
    let aria2Path = ARIA2_PATH
    let aria2Token = ARIA2_TOKEN
    let gid = ''
    /** 本次 INIT_DOWNLOAD 创建的任务 id（队列里同一视频可能有历史任务，必须按 id 精确断言） */
    let taskId = ''

    /** 在扩展页里发一条真实的后台消息（与页内按钮/右键菜单完全同一条通路） */
    async function sendMessage<T>(req: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
        return (await browser.execute(async (message) => {
            type Scope = { runtime: { sendMessage: (msg: unknown) => Promise<unknown> } }
            const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
            return await api!.runtime.sendMessage(message)
        }, req)) as { ok: boolean; data?: T; error?: string }
    }

    /** 读 storage.local 的单个键（队列与配置的唯一真源） */
    async function readStorage<T>(key: string): Promise<T | undefined> {
        return (await browser.execute(async (name) => {
            type Scope = { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } }
            const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
            return (await api!.storage.local.get(name))[name]
        }, key)) as T | undefined
    }

    /** aria2 JSON-RPC（从扩展页发：host_permissions 已含 <all_urls>，无 CORS 问题） */
    async function rpc<T>(method: string, params: unknown[]): Promise<T> {
        const result = (await browser.execute(
            async (path, token, name, args) => {
                const res = await fetch(path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 'e2e', method: name, params: [`token:${token}`, ...args] })
                })
                const text = await res.text()
                if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
                const body = JSON.parse(text)
                return body.error ? { error: JSON.stringify(body.error) } : { result: body.result }
            },
            aria2Path,
            aria2Token,
            method,
            params
        )) as { result?: T; error?: string }
        if (result.error) throw new Error(`aria2 ${method} 失败：${result.error}`)
        return result.result as T
    }

    /** 在 aria2 的全部任务里找这个视频（以文件名里的视频 ID 为准，比 gid 更耐重试） */
    async function findTask(): Promise<Aria2Status | null> {
        const groups = await Promise.all([rpc<Aria2Status[]>('aria2.tellActive', []), rpc<Aria2Status[]>('aria2.tellStopped', [0, 4096, ['gid', 'status', 'files', 'dir', 'totalLength', 'completedLength', 'downloadSpeed', 'errorMessage', 'errorCode']])])
        const all = groups.flat()
        return all.find((task) => (task.files ?? []).some((file) => (file.path ?? '').includes(VIDEO_ID))) ?? null
    }

    before(async function (this: Mocha.Context) {
        if (!liveEnabled()) return this.skip()
        if (REFRESH === '') {
            console.warn('[live] 缺少 E2E_LIVE_REFRESH（刷新令牌只经环境变量传入，绝不写进仓库），跳过。')
            return this.skip()
        }
        if (ARIA2_TOKEN === '') {
            console.warn('[live] 缺少 E2E_LIVE_ARIA2_TOKEN，跳过。')
            return this.skip()
        }

        session = await ensureExtensionSession(browser)
        // 扩展页：不经 Cloudflare、不受站点 DOM 影响，纯粹的「后台 + 配置」环境
        await browser.url(`${session.extensionBaseUrl}options/index.html#guide`)
        await $('nav.tabs').waitForDisplayed({ timeout: 30_000 })

        // 播种配置 + 令牌：configStore 订阅 storage.onChanged，后台内存副本即时生效
        await browser.execute(
            async (config, refresh) => {
                type Scope = { storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } } }
                const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
                await api!.storage.local.set({ config, 'auth:refresh': refresh })
            },
            CONFIG,
            REFRESH
        )
        // 用实际落盘的配置做后续断言：如果 zod 把某字段剥掉了，这里就能看出来
        const stored = await readStorage<{ aria2Path: string; aria2Token: string; downloadType: number; downloadPath: string }>('config')
        expect(stored?.aria2Path).toBe(ARIA2_PATH)
        expect(stored?.downloadType).toBe(0)
        aria2Path = stored!.aria2Path
        aria2Token = stored!.aria2Token
        console.log(`[live] 宿主 ${session.browserName}；视频 ${VIDEO_ID}；aria2 ${aria2Path}`)
    })

    it('令牌可用：扩展页 POST /user/token 拿到 accessToken（不带 Cookie，和后台同一条网络路径）', async () => {
        const result = (await browser.execute(async () => {
            type Scope = { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } }
            const api = (globalThis as unknown as { browser?: Scope; chrome?: Scope }).browser ?? (globalThis as unknown as { browser?: Scope; chrome?: Scope }).chrome
            const refresh = (await api!.storage.local.get('auth:refresh'))['auth:refresh'] as string
            const res = await fetch('https://api.iwara.tv/user/token', { method: 'POST', headers: { Authorization: `Bearer ${refresh}` } })
            const text = await res.text()
            return { status: res.status, preview: text.slice(0, 160), hasToken: /"accessToken"\s*:/.test(text) }
        })) as { status: number; preview: string; hasToken: boolean }

        if (result.status === 403 && result.preview.includes('Just a moment')) {
            throw new Error('api.iwara.tv 返回 Cloudflare 挑战（本机 IP/指纹被要求验证）。这不是扩展缺陷：请先在可见窗口里打开 www.iwara.tv 通过验证，或换网络后重跑。')
        }
        expect(result.status).toBe(200)
        expect(result.hasToken).toBe(true)
    })

    it('INIT_DOWNLOAD：后台解析视频并把任务交给 aria2', async () => {
        const res = await sendMessage<{ id: string; status: string; detail?: string }>({ type: 'INIT_DOWNLOAD', payload: { videoId: VIDEO_ID } })
        console.log('[live] INIT_DOWNLOAD →', JSON.stringify(res))
        expect(res.ok).toBe(true)
        const task = res.data
        expect(task).toBeTruthy()
        taskId = task!.id

        if (task!.status === 'failed') {
            const queue = (await readStorage<QueueTask[]>('downloadQueue')) ?? []
            const failed = queue.find((item) => item.id === taskId)
            throw new Error(`任务落为 failed：${task!.detail ?? failed?.detail ?? '（无 detail）'}`)
        }

        // 队列里必须有一条本次创建的任务（后台是唯一写者，storage 是唯一真源）。
        // 按 id 而不是 videoId 匹配：同一个视频在队列里可能存在历史任务（重复下载/测试重跑），
        // 按 videoId 会拿到旧的那条，后面的状态断言就变成在验别人。
        const queued = await browser.waitUntil(
            async () => {
                const queue = (await readStorage<QueueTask[]>('downloadQueue')) ?? []
                return queue.find((item) => item.id === taskId) ?? false
            },
            { timeout: 30_000, interval: 500, timeoutMsg: '队列里没有本次创建的任务' }
        )
        console.log('[live] 队列任务 →', JSON.stringify(queued))
        expect(queued.kind ?? 'aria2').toBe('aria2')
    })

    it('aria2 真的收到了这个视频（文件名含视频 ID，目录来自路径模板）', async () => {
        const found = await browser.waitUntil(async () => (await findTask()) ?? false, { timeout: 60_000, interval: 1000, timeoutMsg: 'aria2 里没有找到该视频的任务' })
        gid = found.gid ?? ''
        console.log('[live] aria2 task →', JSON.stringify(found))
        expect(gid).not.toBe('')

        const paths = (found.files ?? []).map((file) => file.path ?? '')
        expect(paths.some((path) => path.includes(VIDEO_ID))).toBe(true)
        // 目录/文件名必须来自配置的路径模板，而不是别处的默认值
        expect(paths.some((path) => path.includes(PATH_PREFIX))).toBe(true)
    })

    it('下载真正推进直到完成（进度是 aria2 侧的事实，不是队列的自述）', async () => {
        const final = await browser.waitUntil(
            async () => {
                const status = await rpc<Aria2Status>('aria2.tellStatus', [gid, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorMessage', 'errorCode', 'files']])
                const percent = status.totalLength && status.totalLength !== '0' ? ((Number(status.completedLength) / Number(status.totalLength)) * 100).toFixed(1) : '?'
                console.log(`[live] ${status.status} ${percent}% (${status.completedLength}/${status.totalLength}) ${status.downloadSpeed ?? ''}B/s`)
                if (status.status === 'error') throw new Error(`aria2 error ${status.errorCode}: ${status.errorMessage ?? ''}`)
                return status.status === 'complete' ? status : false
            },
            { timeout: 600_000, interval: 5000, timeoutMsg: '下载未在预算内完成（aria2 仍在进行，可调整 E2E_LIVE_DOWNLOAD_TIMEOUT）' }
        )

        const total = Number(final.totalLength ?? 0)
        const done = Number(final.completedLength ?? 0)
        expect(total).toBeGreaterThan(0)
        expect(done).toBe(total)
        console.log(`[live] 完成：${done} 字节 → ${(final.files ?? []).map((file) => file.path).join(', ')}`)

        // 队列也要如实收敛（否则用户看到的是「一直在下」）。
        // 两条路径：① WS 完成通知（实时）；② 手动对账消息（与任务页「刷新状态」同一个入口）。
        // ② 必须存在：配置是 boot 之后才播种的，这个会话里的 WS 可能没来得及连上，
        // 而那正是真实用户「WS 断开期间完成」的同一种情形——以前只能等 5 分钟 alarm。
        const isComplete = async (): Promise<boolean> => {
            const queue = (await readStorage<QueueTask[]>('downloadQueue')) ?? []
            return queue.find((item) => item.id === taskId)?.status === 'complete'
        }
        const settled = await browser
            .waitUntil(isComplete, { timeout: 20_000, interval: 1000 })
            .then(() => true)
            .catch(() => false)
        if (!settled) {
            console.log('[live] 20 秒内没有收到 WS 完成通知，改走手动对账（SYNC_ARIA2_TASKS）')
            console.log('[live] 对账前队列 →', JSON.stringify((await readStorage<QueueTask[]>('downloadQueue')) ?? []))
            const reconcile = await sendMessage({ type: 'SYNC_ARIA2_TASKS', payload: {} })
            console.log('[live] SYNC_ARIA2_TASKS →', JSON.stringify(reconcile))
            console.log('[live] 对账后队列 →', JSON.stringify((await readStorage<QueueTask[]>('downloadQueue')) ?? []))
            await browser.waitUntil(isComplete, { timeout: 20_000, interval: 1000, timeoutMsg: '手动对账后队列仍未收敛到 complete' })
        }

        if (!KEEP_TASK) {
            await rpc('aria2.removeDownloadResult', [gid]).catch(() => undefined)
            console.log(`[live] 已从 aria2 移除结果 ${gid}（E2E_LIVE_KEEP_TASK=1 可保留）`)
        }
    })
})

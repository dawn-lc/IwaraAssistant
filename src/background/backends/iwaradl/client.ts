/**
 * iwaradl 后端 —— HTTP 客户端与轮询开关。
 *
 * 任务模型（纯函数）在 `shared/iwaradlTask.ts`；这里只做 I/O 与调度。
 *
 * ## API 能力（`https://github.com/Izumiko/iwaradl/blob/master/http-api.md`）
 *
 * | 方法                      | 用途                       |
 * | ------------------------- | -------------------------- |
 * | `POST /api/tasks`         | 创建任务（返回数组）       |
 * | `GET /api/tasks`          | 列出全部任务（一次拿全）   |
 * | `GET /api/tasks/{vid}`    | 取单个任务                 |
 * | `DELETE /api/tasks/{vid}` | 删除任务（**仅 pending**） |
 *
 * ⚠️ 旧实现读的是 POST 响应的 `body.id`，但它是**数组**，于是永远取不到、
 * 退化成随机 uuid；那个 uuid 之后不可能与 iwaradl 里任何任务对上，
 * 所以这个通道从来就不可能被追踪。主键是 `vid`。
 */
import { IWARADL_TARGET, callEndpoint, parseEndpoint } from '../../../shared/endpoint'
import { i18n } from '../../../shared/i18n'
import { parseIwaradlTask, parseIwaradlTasks, type IwaradlTask } from '../../../shared/iwaradlTask'
import type { QueueTask } from '../../../shared/task'
import { getConfig } from '../../storage/configStore'
import { getTasks } from '../../storage/queue'

// 模型在 shared（纯函数、可单测），但调用方只需要面对「iwaradl 后端」这一个名字，
// 不该为了一个状态映射再去找第二个 import 路径。
export { isIwaradlActive, parseIwaradlTask, parseIwaradlTasks, queueStatusOfIwaradl } from '../../../shared/iwaradlTask'
export type { IwaradlStatus, IwaradlTask } from '../../../shared/iwaradlTask'

// ── 端点与请求 ──────────────────────────────────────────────────────────

/** 端点是否可用（地址非法/留空都算没配） */
export function isIwaradlConfigured(): boolean {
    return parseEndpoint(getConfig().iwaradlPath) !== null
}

/**
 * 单任务地址：在集合地址后面加 `/{vid}`。
 *
 * 端点是**指向任务集合本身**的（默认 `.../api/tasks`），所以不能写成
 * `new URL('/api/tasks/'+vid, path)`——那会把用户自定义的路径前缀整个丢掉。
 * 去掉末尾斜杠避免 `.../api/tasks//vid`。
 */
export function iwaradlTaskUrl(base: string, vid: string): string {
    return `${base.trim().replace(/\/+$/, '')}/${encodeURIComponent(vid)}`
}

function authHeaders(): Record<string, string> {
    const token = getConfig().iwaradlToken
    return {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token === '' ? {} : { authorization: `Bearer ${token}` })
    }
}

/**
 * 发一次请求。只有**网络层失败**会被翻译成可操作文案（`callEndpoint`）；
 * 4xx/5xx 原样交给调用方处理——「服务端说 409」和「连不上」是两件事。
 */
async function request(url: string, init: RequestInit): Promise<Response> {
    return callEndpoint(IWARADL_TARGET, getConfig().iwaradlPath, () => fetch(url, { ...init, headers: authHeaders(), signal: AbortSignal.timeout(15_000) }))
}

/** 列出全部任务；响应不是数组说明对方不是 iwaradl（或版本不对） */
export async function iwaradlListTasks(): Promise<IwaradlTask[]> {
    const response = await request(getConfig().iwaradlPath.trim(), { method: 'GET' })
    if (!response.ok) throw new Error(i18n.t('notify.iwaradlNotReady'))
    const body = (await response.json().catch(() => undefined)) as unknown
    if (!Array.isArray(body)) throw new Error(i18n.t('notify.iwaradlNotReady'))
    return parseIwaradlTasks(body)
}

/** 取单个任务；404 表示它已经不在里面了（删除过/重启丢了），返回 undefined 而不是抛错 */
export async function iwaradlGetTask(vid: string): Promise<IwaradlTask | undefined> {
    const response = await request(iwaradlTaskUrl(getConfig().iwaradlPath, vid), { method: 'GET' })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(i18n.t('notify.iwaradlNotReady'))
    return parseIwaradlTask((await response.json().catch(() => undefined)) as unknown)
}

/** 删除任务的结果：iwaradl 只允许删 `pending`，`running` 会返回 409 */
export type IwaradlDeleteResult = 'deleted' | 'missing' | 'notPending'

export async function iwaradlDeleteTask(vid: string): Promise<IwaradlDeleteResult> {
    const response = await request(iwaradlTaskUrl(getConfig().iwaradlPath, vid), { method: 'DELETE' })
    if (response.status === 204) return 'deleted'
    if (response.status === 404) return 'missing'
    // 409 = task is not in pending。这是 iwaradl 的**设计限制**，不是我们的 bug：
    // 它没有提供取消正在下载任务的能力，所以这里如实上报，不假装取消成功。
    if (response.status === 409) return 'notPending'
    throw new Error(`iwaradl ${response.status}: ${await response.text()}`)
}

// ── 轮询开关（有活才开 alarm）───────────────────────────────────────────

/**
 * 队列里还需要 iwaradl 结果的记录。
 *
 * 含旧版本留下的 `handed-off`：那些任务当时被当成「不可追踪」了，
 * 但它们其实还在 iwaradl 里，轮询一旦跑起来就该被升级成真实状态。
 */
export function activeIwaradlTasks(): QueueTask[] {
    return getTasks().filter((task) => task.kind === 'iwaradl' && (task.status === 'queued' || task.status === 'running' || task.status === 'handed-off'))
}

export function hasActiveIwaradlTasks(): boolean {
    return activeIwaradlTasks().length > 0
}

export const IWARADL_SCAN_ALARM = 'scan-iwaradl'

/**
 * 轮询周期：1 分钟。
 *
 * 比 aria2 的 5 分钟扫描紧——那边有 WebSocket 推送兜底，这边只有轮询，
 * 1 分钟是「进度感」与「请求量」的折中（一条任务 = 每分钟一次 GET 列表）。
 */
export const IWARADL_SCAN_PERIOD_MIN = 1

/**
 * 按当前队列对齐 alarm 的存在性（幂等：已存在则不动，避免不断重置计时）。
 *
 * 常驻 1 分钟 alarm 会让后台每分钟醒一次、打一次 HTTP，哪怕队列里一条 iwaradl 任务都没有。
 * Chrome MV3 的 SW 每次唤醒都是冷启动成本，这类「为了可能发生的事常驻」的定时器是最该避免的。
 */
export async function syncIwaradlAlarm(): Promise<void> {
    const needed = hasActiveIwaradlTasks()
    const existing = await browser.alarms.get(IWARADL_SCAN_ALARM).catch(() => undefined)
    if (needed && !existing) {
        await browser.alarms.create(IWARADL_SCAN_ALARM, { periodInMinutes: IWARADL_SCAN_PERIOD_MIN })
        return
    }
    if (!needed && existing) await browser.alarms.clear(IWARADL_SCAN_ALARM)
}

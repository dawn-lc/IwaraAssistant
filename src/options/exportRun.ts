/**
 * 导出迁移包的**运行快照**（`storage.session`，见 `EXPORT_RUN_KEY`）。
 *
 * ## 为什么需要它
 *
 * 导出的产物是 Blob 与一整份字符串，**只能在文档里生成**：MV3 的 service worker 没有
 * `URL.createObjectURL`，后台拿不到生成 Blob 的手段，所以生产者必然是选项页。
 * 而选项页里 `ExportSection` 会随页签切换卸载——本地 `useState` 归零、进度条消失、
 * 两个按钮变回可点。用户此时再点一次，就是**第二轮全表遍历 + 第二份文件**
 * （`conflictAction: uniquify` 让磁盘上多一个文件，数据不坏，但几分钟白跑）。
 *
 * ## 为什么不是心跳超时
 *
 * 「快照说在跑」不等于真的在跑：页面被关掉、扩展被重载，循环已经死了，而快照还写着
 * `running`。长任务通用的判据是**不变量**，但这里的不变量在另一个上下文里（生产者是页面，
 * 而读取者也可能同为页面），内存不可共享。所以用 `BroadcastChannel` **问一句**:
 * 真正还在跑的页面会应答，没有应答就是残骸。这仍然是「证据」而不是「猜时间」——
 * 一个跑得慢的导出不会因为慢而被误判为中断。
 *
 * ## 只存事实，不存文案
 *
 * 快照里没有面向用户的中文字符串（与后台长任务相反：那边的生产者已经是后台，写的时候
 * 就本地化了）。这里由页面在读的时候按当前界面语言渲染，切语言不需要重跑一遍。
 */
import type { LegacyStore } from '../shared/legacyDb'

/** 导出的两个目标：落盘文件 / 写入剪贴板 */
export type ExportTarget = 'file' | 'clipboard'

/**
 * 运行状态。
 *
 * 没有 `done`：成功之后文件已经落盘、剪贴板已经写入，再留一条「已完成」记录
 * 只会让界面在用户已经看到 toast 之后又重复说一遍。成功即**删除**快照；
 * 只有「不知道结局」（页面被关掉、循环被异常打断）才留 `interrupted`。
 */
export type ExportStatus = 'idle' | 'running' | 'interrupted'

export interface ExportRun {
    status: ExportStatus
    target: ExportTarget
    /** 当前正在写的表 */
    store: LegacyStore
    /** 已写出的记录条数（含前几张表） */
    done: number
    /** 总条数（导出开始时的快照） */
    total: number
    /** 已生成的字节数（文件按 Blob 累加，剪贴板按 UTF-8 编码长度） */
    bytes: number
    updatedAt: number
}

export const IDLE_EXPORT_RUN: ExportRun = {
    status: 'idle',
    target: 'file',
    store: 'videos',
    done: 0,
    total: 0,
    bytes: 0,
    updatedAt: 0
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** 解析持久层里的快照（脏值返回 `null` = 不可信，调用方保留上一份） */
export function parseExportRun(raw: unknown): ExportRun | null {
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as Record<string, unknown>
    const status = record['status']
    if (status !== 'idle' && status !== 'running' && status !== 'interrupted') return null
    const target = record['target'] === 'clipboard' ? 'clipboard' : 'file'
    const store = record['store']
    if (store !== 'videos' && store !== 'follows' && store !== 'friends' && store !== 'idmap') return null
    return {
        status,
        target,
        store,
        done: isCount(record['done']) ? Math.max(0, record['done']) : 0,
        total: isCount(record['total']) ? Math.max(0, record['total']) : 0,
        bytes: isCount(record['bytes']) ? Math.max(0, record['bytes']) : 0,
        updatedAt: isCount(record['updatedAt']) ? record['updatedAt'] : 0
    }
}

/**
 * 完成比例。总量未知（`total === 0`，空库或计数消息失败）时返回 `undefined`，
 * 交给 `ProgressBar` 的不确定态——而不是用 0 冒充分母得出 NaN 或「一直 0%」。
 */
export function exportRunRatio(run: ExportRun | null): number | undefined {
    if (!run || run.total <= 0) return undefined
    return Math.min(1, Math.max(0, run.done / run.total))
}

/** 判断「还有没有一个真的在跑的导出」用的通道名（页面之间点对点，不经后台） */
export const EXPORT_RUN_CHANNEL = 'iwara-assistant:export-run'

/**
 * 声明「这个页面正在跑导出」，返回一个解除声明的函数（跑完/异常时调用）。
 *
 * 只做一件事：别的页面挂载时来问「还有人活着吗」，这里应答。**不自问自答**
 * （`BroadcastChannel` 本来就不投递给发送者自己的实例）。
 */
export function claimExportOwnership(): () => void {
    if (typeof BroadcastChannel === 'undefined') return () => undefined
    const channel = new BroadcastChannel(EXPORT_RUN_CHANNEL)
    channel.onmessage = (event: MessageEvent): void => {
        if (event.data === 'ping') channel.postMessage('pong')
    }
    return () => channel.close()
}

/**
 * 问一句「还有没有页面在跑导出」。超时未应答 = 残骸。
 *
 * 超时给 400ms：这是页面内通信（不是消息通道），正常应答在毫秒级；
 * 给得再久只是让「上次导出被中断」这条提示晚一点出现。
 */
export function isExportOwnerAlive(timeoutMs = 400): Promise<boolean> {
    if (typeof BroadcastChannel === undefined) return Promise.resolve(false)
    const channel = new BroadcastChannel(EXPORT_RUN_CHANNEL)
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            channel.close()
            resolve(false)
        }, timeoutMs)
        channel.onmessage = (event: MessageEvent): void => {
            if (event.data !== 'pong') return
            clearTimeout(timer)
            channel.close()
            resolve(true)
        }
        channel.postMessage('ping')
    })
}

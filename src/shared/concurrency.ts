/**
 * 受限并发池 —— 全项目「一次跑 N 个」的唯一实现。
 *
 * 为什么抽出来：MediaCenter 同步的两个阶段都需要并发（列表 1400 页、推送数万条），
 * 而「并发池」这种东西写起来十行、写对很难 —— 失败后必须**停止派发新任务**、
 * 等已在跑的收尾、再抛第一个错误；上限要归一到合法值；任务数少于并发度时不能空转。
 * 这类细节复制两份必然漂移，所以只留一处（两处调用：`scanMediaPages` 的分页扫描、
 * `mediaCenter.syncCachedToMediaCenter` 的逐条推送）。
 *
 * 语义刻意保持最小：
 * - **顺序无保证**（这是并发的定义），调用方不能用 index 表达依赖；
 * - **任一任务抛错 → 停止派发 + 等收尾 + 抛第一个错误**（后面的错误只可能是同因，
 *   多抛无用；需要「一条失败不影响其余」时由 worker 自己 catch）；
 * - `shouldStop` 用于「目的已达成」（例如候选全部命中）时正常提前结束，
 *   **不抛错**——它与失败是两件不同的事。
 */

/** 并发度归一：脏值（0、负数、NaN、小数）一律夹到 1 以上，避免一个都不跑或跑出负数 worker */
export function normalizeConcurrency(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 1
    return Math.max(1, Math.floor(value))
}

export interface RunPoolOptions {
    /** 同时进行的任务上限（缺省 1 = 串行） */
    concurrency?: number
    /** 每次准备派发前询问：返回 true 则不再派发新任务（已在跑的会跑完，不抛错） */
    shouldStop?: () => boolean
}

/**
 * 以受限并发执行 `items` 上的 `worker`。
 *
 * 空数组立即返回（不创建任何 worker）；`items.length < concurrency` 时只创建够用的 worker。
 */
export async function runPool<T>(items: readonly T[], worker: (item: T, index: number) => Promise<void>, options: RunPoolOptions = {}): Promise<void> {
    const concurrency = normalizeConcurrency(options.concurrency)
    const shouldStop = options.shouldStop
    let next = 0
    let stopped = false
    let failure: { error: unknown } | null = null

    const run = async (): Promise<void> => {
        while (!stopped) {
            const index = next++
            if (index >= items.length) return
            // 目的达成（正常提前结束）与「别处失败」共用同一个停止闸门，区别只在于是否抛错
            if (shouldStop !== undefined && shouldStop()) {
                stopped = true
                return
            }
            try {
                await worker(items[index] as T, index)
            } catch (error) {
                stopped = true
                if (failure === null) failure = { error }
                return
            }
        }
    }

    const workers = Math.min(concurrency, items.length)
    await Promise.all(Array.from({ length: workers }, () => run()))
    // 收尾后再抛：已派发的任务都结束了，调用方看到的失败不会「与仍在进行的写操作交错」
    if (failure !== null) throw (failure as { error: unknown }).error
}

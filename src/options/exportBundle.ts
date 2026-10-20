/**
 * 导出迁移包的**增量序列化**。
 *
 * 为什么不能 `JSON.stringify(整个载荷)`：
 * 视频库单条记录可以几 MB（含完整 API 响应），整库导出的 JSON 文本轻易超过
 * V8 的单字符串上限（64 位下 2^29−24 字符 ≈ 512 MiB）。一旦越过，
 * `JSON.stringify` 直接抛 `allocation size overflow` / `Invalid string length`
 * ——用户看到的就是这句话，而数据本身完全没问题、也没有任何内容超限。
 * 同理，「先把四张表全读进内存再序列化」还会让对象图本身占几百 MB 到 GB 级，
 * 峰值是文本 + 对象图两份。
 *
 * 现在按 `DB_EXPORT_PAGE` 一页一页读、一条一条序列化，产出定长文本块：
 * - 文件：每块立刻转成 Blob 收进 parts（Blob 的容量上限远高于字符串），
 *   最后 `new Blob(parts)`。块转成 Blob 后原字符串即可回收，峰值只多一个块。
 * - 剪贴板：`navigator.clipboard.writeText` 只接受单个字符串，所以由调用方
 *   设上限并如实报错（见 `CLIPBOARD_MAX_CHARS`）。
 *
 * **输出与旧实现逐字节一致**（等价于 `JSON.stringify(payload, null, 2)`），
 * 因此导入端与已有的导出文件都不需要任何改动。
 */
import { send } from '../messaging/hub'
import { LEGACY_STORES } from '../shared/legacyDb'
import type { LegacyCounts, LegacyStore, LegacyStorePage } from '../shared/legacyDb'
import { CONFIG_KEY } from '../shared/storageKeys'

/**
 * 每块的字符预算（1 Mi 字符 ≈ 2 MiB UTF-16，落盘后约 1 MiB UTF-8）。
 * 太小 → Blob parts 数量暴涨；太大 → 单块又逼近字符串压力。
 */
const CHUNK_CHARS = 1 << 20

/**
 * 剪贴板能承载的上限（字符）。
 *
 * 必须显式设限：`writeText` 要的是**一个**字符串，超限时浏览器只会给
 * 一个和导出失败一模一样的底层错误，用户无从判断该怎么办。
 * 16 Mi 字符对「只想备份配置或小库」足够，同时远低于各宿主的安全边界。
 */
export const CLIPBOARD_MAX_CHARS = 16 * 1024 * 1024

/** 展示文案里的上限（由常量推导，避免界面写一个数字、代码写另一个） */
export const CLIPBOARD_LIMIT_LABEL = `${CLIPBOARD_MAX_CHARS / (1024 * 1024)} Mi`

export interface ExportStream {
    /** 逐块产出 JSON 文本；跑完即整份导出结束 */
    chunks: AsyncGenerator<string, void, void>
    /** 各表实际导出条数（生成器跑完后才有意义，供 toast 汇报） */
    counts: Record<LegacyStore, number>
}
/** 导出进度快照（每次更新都是完整的一份，调用方不需要自己累加） */
export interface ExportProgress {
    /** 当前正在写的表 */
    store: LegacyStore
    /** 已写出的记录条数（含前几张表；当前表的已写数 = done − 前表总数总和） */
    done: number
    /** 总条数（导出开始时的快照；导出期间新增的记录会让 done 略微超出） */
    total: number
}
/** `JSON.stringify` 在值为 `undefined` 时返回 `undefined`；数组元素位应写成 `null` */
const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? 'null'

/** 给每一行加前缀（复刻 `JSON.stringify(value, null, 2)` 在指定层级的缩进） */
const indent = (text: string, prefix: string): string => text.replace(/\n/g, '\n' + prefix)

/**
 * @param onProgress 每写完一页回调一次。1.6 GB 的库约百页，百次 React 更新；
 *   每页之间的 `DB_EXPORT_PAGE` 消息往返已让出事件循环，所以进度条能真的动。
 */
export function createExportStream(onProgress?: (progress: ExportProgress) => void): ExportStream {
    const counts: Record<LegacyStore, number> = { videos: 0, follows: 0, friends: 0, idmap: 0 }

    async function* chunks(): AsyncGenerator<string, void, void> {
        let buffer = ''
        const append = (text: string): string | null => {
            buffer += text
            if (buffer.length < CHUNK_CHARS) return null
            const out = buffer
            buffer = ''
            return out
        }

        // 总条数先问后台（count() 只扫索引）。拿不到不该拖垮导出——进度只是体验，
        // 回落到 0 让 ProgressBar 走不确定态，数据照常导出。
        const totals = await send<LegacyCounts>({ type: 'DB_STORE_COUNTS', payload: {} }).catch((): LegacyCounts => ({ videos: 0, follows: 0, friends: 0, idmap: 0 }))
        const grandTotal = LEGACY_STORES.reduce((sum, store) => sum + (totals[store] ?? 0), 0)
        let done = 0

        const stored = (await browser.storage.local.get([CONFIG_KEY]))[CONFIG_KEY] as Record<string, unknown> | undefined
        let out = append('{\n  "config": ' + indent(json(stored ?? {}), '  '))
        if (out !== null) yield out

        for (const store of LEGACY_STORES) {
            onProgress?.({ store, done, total: grandTotal })
            out = append(`,\n  "${store}": `)
            if (out !== null) yield out

            // 空表要写成 `[]`（`[\n  ]` 不是合法 JSON 的数组字面量习惯写法，虽然合法但难看）
            let empty = true
            let after: string | undefined
            for (;;) {
                const page = await send<LegacyStorePage>({ type: 'DB_EXPORT_PAGE', payload: after === undefined ? { store } : { store, after } })
                for (const record of page.records) {
                    out = append(empty ? '[\n    ' : ',\n    ')
                    if (out !== null) yield out
                    empty = false
                    out = append(indent(json(record), '    '))
                    if (out !== null) yield out
                }
                counts[store] += page.records.length
                done += page.records.length
                onProgress?.({ store, done, total: grandTotal })
                if (page.nextAfter === null) break
                after = page.nextAfter
            }

            out = append(empty ? '[]' : '\n  ]')
            if (out !== null) yield out
        }

        out = append('\n}')
        if (out !== null) yield out
        if (buffer.length > 0) yield buffer
    }

    return { chunks: chunks(), counts }
}

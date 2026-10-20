/**
 * 旧油猴脚本（IwaraDownloadTool）浏览器数据库的读取约定 —— 供 content script 读取、后台校验入库。
 *
 * **为什么需要它**：旧脚本把视频库/关注/好友/ID 映射写在 **iwara.tv 页面 origin** 的 IndexedDB
 * 里（库名 `IwaraDownloadTool`，schema v22）；而扩展的库在 `chrome-extension://<id>` origin，
 * 两者不同源，后台（SW）**根本看不到页面 IDB**。唯一能读的是注入在 iwara 页面的 content script，
 * 所以数据路径只能是 content script 读 → 消息分批回传 → 后台校验后写自己的库。
 *
 * **为什么不能全自动**：
 * 1. 旧脚本的**配置**在 GM storage（ScriptCat/Tampermonkey 私有存储），不在页面 IDB 里，
 *    自动导入只能带走四张库存表，配置仍须走文件导入；
 * 2. 页面 IDB 是**页面可写**的（站点自身或其他脚本都能改），属于不可信输入，必须逐条校验；
 * 3. 每次注入都自动导入会**复活已删数据**（用户在扩展里删掉的视频/关注，下次访问又回来），
 *    因此检测自动、导入必须显式触发。
 *
 * 校验规则与「文件迁移」完全一致（同一份 sanitize，避免两条路径口径漂移）。
 */
import type { VideoInfo } from './videoInfo'

/** 旧脚本的数据库名（`D:\code\IwaraDownloadTool\src\core\dbMigration.ts` 的 DB_NAME） */
export const LEGACY_DB_NAME = 'IwaraDownloadTool'

/** 旧库中与扩展同构的四张表（配置不在其中） */
export const LEGACY_STORES = ['videos', 'follows', 'friends', 'idmap'] as const
export type LegacyStore = (typeof LEGACY_STORES)[number]

/** 各表的主键路径（分页读取 / 批量写入都要用；与旧库 v22 定义一致） */
export const LEGACY_STORE_KEY_PATH: Record<LegacyStore, string> = {
    videos: 'ID',
    follows: 'id',
    friends: 'id',
    idmap: 'ID'
}

export type LegacyCounts = Record<LegacyStore, number>

/**
 * 单条消息的载荷预算（按**字符数**估算，见 estimateLegacyRecordBytes）。
 *
 * 真实上限：Chrome 的 Mojo IPC 单消息上限 128 MB，Firefox 的 StructuredClone IPC
 * 在同一量级；本项目实测曾把 1.8 GB 一次性发出去（消息层根本没拦，写库时才炸）。
 * 取 16 MiB 字符预算 ≈ 上限的 1/8：即使记录全是 CJK（UTF-8 3 字节/字符，实际字节
 * ≤ 3× 预算 ≈ 48 MiB）仍有余量；常见几百字节/条的库一条消息能装几万条，
 * 往返次数从「几千次」降到「几十次」。
 */
export const LEGACY_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
/** 单批最多条数（体积预算之外的第二道闸：防「条数极多但每条极小」的表把单次 payload 撑成一堆对象头） */
export const LEGACY_MAX_MESSAGE_RECORDS = 1000

/**
 * 单次 IndexedDB 事务的写入预算。
 *
 * Firefox 对**一次事务**序列化后的数据量有硬上限（实测 246 MiB，
 * 超限报 `The serialized value is too large (size=…, max=257949696)`）。
 * 取 32 MiB 字符预算：非 ASCII 最坏按 3 字节/字符计 ≈ 96 MiB，不到上限的一半；
 * ASCII 为主的记录实际只占预算的 1/3。切块越少，事务与事件循环往返越少——
 * 这是大库导入速度的主要项；单条超限/坏记录由写入端的二分隔离兜底，不会丢整批。
 */
export const LEGACY_MAX_WRITE_BYTES = 32 * 1024 * 1024
export const LEGACY_MAX_WRITE_RECORDS = 500

/**
 * 记录体积估算（JSON 字符数近似字节）。
 * 只用于**分块**，不参与正确性判断：估算偏小只是多切一批，不会丢数据。
 * 预算是字符数，非 ASCII 最坏按 UTF-8 3 字节/字符膨胀——两套预算都已留下 2.5 倍以上余量。
 * 循环引用/无法序列化时返回 0（交给写入失败的隔离逻辑处理）。
 */
export function estimateLegacyRecordBytes(record: unknown): number {
    try {
        return JSON.stringify(record)?.length ?? 0
    } catch {
        return 0
    }
}

/**
 * 按体积 + 条数把记录切成消息批。
 *
 * 单条记录本身就超预算时**单独成批**（不丢弃）：是否能传/写由后续失败隔离决定，
 * 不在此处静默丢数据。
 */
export function planLegacyBatches(records: unknown[], maxBytes: number = LEGACY_MAX_MESSAGE_BYTES, maxRecords: number = LEGACY_MAX_MESSAGE_RECORDS): unknown[][] {
    const batches: unknown[][] = []
    let current: unknown[] = []
    let bytes = 0
    for (const record of records) {
        const size = estimateLegacyRecordBytes(record)
        if (current.length > 0 && (bytes + size > maxBytes || current.length >= maxRecords)) {
            batches.push(current)
            current = []
            bytes = 0
        }
        current.push(record)
        bytes += size
    }
    if (current.length > 0) batches.push(current)
    return batches
}

/** 检测/导入结果（存 storage.local.legacyDb，options 迁移页展示） */
export interface LegacyDbInfo {
    /** 页面 origin 上是否存在旧库 */
    found: boolean
    /** 各表条数（未找到时为 0） */
    counts: LegacyCounts
    /** 上次扫描时间（ms） */
    scannedAt: number
    /** 上次成功导入时间（ms）；未导入过则缺省 */
    importedAt?: number
    /** 导入进行中的进度（结束后清除） */
    progress?: LegacyImportProgress | null
}

/** 导入进度（页面读表时上报，后台落盘供 options 展示） */
export interface LegacyImportProgress {
    store: LegacyStore
    /** 本表已处理条数 */
    done: number
    /** 本表总条数（count() 得到） */
    total: number
}

export const EMPTY_LEGACY_COUNTS: LegacyCounts = { videos: 0, follows: 0, friends: 0, idmap: 0 }

/**
 * 纯对象判定 —— 面向「从旧库/迁移包里读到的未知 JSON」的统一守卫。
 * `migrationPayload` 也用它，所以在此导出而不是两边各写一份（数组不算记录）。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 视频库记录：旧库 value 即 VideoInfo（Type 原样保留，cache 视为 partial 无需转换）。
 * 只做「能不能用」的结构校验，不改写字段——旧库存的就是它自己的形态。
 */
export function sanitizeLegacyVideos(items: unknown[]): VideoInfo[] {
    const valid: VideoInfo[] = []
    for (const item of items) {
        if (!isRecord(item)) continue
        if (typeof item.ID !== 'string' || item.ID === '') continue
        if (typeof item.Type !== 'string') continue
        valid.push(item as unknown as VideoInfo)
    }
    return valid
}

/** 关注/好友记录：keyPath 是 `id`（用户名等字段按原样保留） */
export function sanitizeLegacyUsers(items: unknown[]): Iwara.User[] {
    const valid: Iwara.User[] = []
    for (const item of items) {
        if (!isRecord(item)) continue
        if (typeof item.id !== 'string' || item.id === '') continue
        valid.push(item as unknown as Iwara.User)
    }
    return valid
}

/** ID 映射记录：`{ ID, href }`；href 缺失时补空串（旧库存在只有 ID 的残记录） */
export function sanitizeLegacyIdmap(items: unknown[]): Array<{ ID: string; href: string }> {
    const valid: Array<{ ID: string; href: string }> = []
    for (const item of items) {
        if (!isRecord(item)) continue
        if (typeof item.ID !== 'string' || item.ID === '') continue
        valid.push({ ID: item.ID, href: String(item.href ?? '') })
    }
    return valid
}

/**
 * 每张表的结构校验器 —— **表驱动，不用三元分发**。
 *
 * 曾经后台写成 `store === 'videos' ? … : store === 'idmap' ? … : sanitizeUsers(…)`，
 * 最后那个 else 同时兜住了 `follows` 与 `friends`。看起来能用，但新增一张表时
 * 它会**静默**落进用户校验分支：编译通过、运行时把记录写成错的形状。
 * `Record<LegacyStore, …>` 让「加表必补一行」变成编译期约束。
 */
export const LEGACY_SANITIZERS: Record<LegacyStore, (items: unknown[]) => unknown[]> = {
    videos: sanitizeLegacyVideos,
    follows: sanitizeLegacyUsers,
    friends: sanitizeLegacyUsers,
    idmap: sanitizeLegacyIdmap
}

/** 一次导入的汇总（content script 返回、options 展示） */
export interface LegacyImportSummary extends LegacyCounts {
    /** 结构校验未通过而丢弃的条数 */
    skipped: number
    /** 传输或写入失败的条数（旧库存量异常时才会出现，已在两端做隔离） */
    failed: number
}

/** 单批写入结果（后台 LEGACY_DB_BATCH 返回） */
export interface LegacyBatchResult {
    /** 成功写入条数 */
    written: number
    /** 结构不合规被丢弃条数 */
    invalid: number
    /** 写入/克隆失败条数（二分隔离出来的坏记录） */
    failed: number
}

/**
 * 全量导出的单页（后台 `DB_EXPORT_PAGE` 返回）。
 *
 * 为什么需要分页：导出必须读四张**整表**，而一次性把整表塞进一条消息会撞
 * 消息体积上限（与旧库导入是同一个约束，见上方 LEGACY_MAX_MESSAGE_*）。
 * `nextAfter` 是主键值（`videos`/`idmap` 用 `ID`，`follows`/`friends` 用 `id`），
 * 为 `null` 表示该表已读完。
 */
export interface LegacyStorePage {
    records: unknown[]
    nextAfter: string | null
}

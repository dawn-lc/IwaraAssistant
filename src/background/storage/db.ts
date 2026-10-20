/**
 * 后台 IndexedDB 视频库 —— 自原 core/db.ts 迁移（idb 依赖不变，仅保留当前所需方法）
 *
 * 与原库（'IwaraDownloadTool'，页面 origin）不同源（extension origin），库改名为 'IwaraAssistant'。
 * schema 版本独立演进：v1 = videos / follows / friends / idmap（与原 v22 的表结构一致）。
 * 存量油猴数据迁移（GM 导出 JSON → 导入）由 options 迁移向导处理。
 *
 * 类型策略：不 extends idb 的 DBSchema（其 value 约束要求隐式索引签名，
 * 与 Iwara.* / VideoInfo 等 ambient interface 不兼容）；store 结构以下方常量为准，
 * 读写边界用显式类型收窄。
 */
import { openDB, type IDBPDatabase } from 'idb'
import { EMPTY_LEGACY_COUNTS, LEGACY_STORES, estimateLegacyRecordBytes, LEGACY_MAX_MESSAGE_BYTES, LEGACY_MAX_MESSAGE_RECORDS, LEGACY_MAX_WRITE_BYTES, LEGACY_MAX_WRITE_RECORDS, planLegacyBatches } from '../../shared/legacyDb'
import type { LegacyCounts, LegacyStore, LegacyStorePage } from '../../shared/legacyDb'
import type { VideoInfo } from '../../shared/videoInfo'

export const DB_NAME = 'IwaraAssistant'
export const DB_VERSION = 1

/** 表结构文档：videos(keyPath ID) / follows+frends(keyPath id) / idmap(keyPath ID) */

function upgradeDatabase(db: IDBPDatabase): void {
    if (!db.objectStoreNames.contains('videos')) {
        const videosStore = db.createObjectStore('videos', { keyPath: 'ID' })
        videosStore.createIndex('ID', 'ID', { unique: true })
        videosStore.createIndex('UploadTime', 'UploadTime')
        videosStore.createIndex('Private', 'Private')
        videosStore.createIndex('Unlisted', 'Unlisted')
        videosStore.createIndex('Type', 'Type')
    }

    if (!db.objectStoreNames.contains('follows')) {
        const followsStore = db.createObjectStore('follows', { keyPath: 'id' })
        followsStore.createIndex('id', 'id', { unique: true })
        followsStore.createIndex('username', 'username', { unique: true })
        followsStore.createIndex('name', 'name')
        followsStore.createIndex('friend', 'friend')
        followsStore.createIndex('following', 'following')
        followsStore.createIndex('followedBy', 'followedBy')
    }

    if (!db.objectStoreNames.contains('friends')) {
        const friendsStore = db.createObjectStore('friends', { keyPath: 'id' })
        friendsStore.createIndex('id', 'id', { unique: true })
        friendsStore.createIndex('username', 'username', { unique: true })
        friendsStore.createIndex('name', 'name')
        friendsStore.createIndex('friend', 'friend')
        friendsStore.createIndex('following', 'following')
        friendsStore.createIndex('followedBy', 'followedBy')
    }

    if (!db.objectStoreNames.contains('idmap')) {
        const idmapStore = db.createObjectStore('idmap', { keyPath: 'ID' })
        idmapStore.createIndex('ID', 'ID', { unique: true })
    }
}

const dbPromise: Promise<IDBPDatabase> = openDB(DB_NAME, DB_VERSION, {
    upgrade: (db) => upgradeDatabase(db)
})

/** 批量写入结果：失败条数不为 0 时调用方必须告知用户（不要静默） */
export interface BulkWriteResult {
    written: number
    failed: number
}

/**
 * 一个事务内的写入。
 *
 * ⚠️ 事务体积有硬上限：Firefox 在一次事务序列化数据超过 246 MiB 时直接报
 * `The serialized value is too large (size=…, max=257949696)` 并中止整个事务。
 * 旧脚本的 `videos` 记录可以达到几 MB 一条（含完整 API 响应）——早期实现把整批
 * 塞进一个事务，1.8 GB 的批次必然中止；现在由 `planLegacyBatches` 按预算切块，
 * 切块大小取「平台上限的 1/3 左右」：再小就只是白白增加事务与事件循环往返。
 */
async function putChunk(conn: IDBPDatabase, store: LegacyStore, chunk: unknown[]): Promise<void> {
    const tx = conn.transaction(store, 'readwrite')
    for (const record of chunk) await tx.store.put(record as never)
    await tx.done
}

/**
 * 写入失败时二分隔离：先把块减半重试，直到单条为止。
 * 单条仍失败 → 计为 failed（要么超大、要么无法结构化克隆），**不让一条坏记录毁掉整批**。
 */
async function writeChunkResilient(conn: IDBPDatabase, store: LegacyStore, chunk: unknown[], result: BulkWriteResult): Promise<void> {
    try {
        await putChunk(conn, store, chunk)
        result.written += chunk.length
        return
    } catch (error) {
        if (chunk.length === 1) {
            result.failed += 1
            console.warn(`[iwara-assistant] ${store} 记录写入失败（已跳过）:`, error)
            return
        }
        const mid = Math.ceil(chunk.length / 2)
        await writeChunkResilient(conn, store, chunk.slice(0, mid), result)
        await writeChunkResilient(conn, store, chunk.slice(mid), result)
    }
}

/**
 * 分块 + 失败隔离的批量写入（旧库导入主通道）。
 * 分块按体积/条数预算，避免单事务超过浏览器上限。
 */
export async function bulkPutIsolated(store: LegacyStore, records: unknown[]): Promise<BulkWriteResult> {
    const result: BulkWriteResult = { written: 0, failed: 0 }
    if (records.length === 0) return result
    const conn = await dbPromise
    for (const chunk of planLegacyBatches(records, LEGACY_MAX_WRITE_BYTES, LEGACY_MAX_WRITE_RECORDS)) {
        await writeChunkResilient(conn, store, chunk, result)
    }
    return result
}

/**
 * 四张表的当前条数 —— 导出进度条的总量来源（`DB_STORE_COUNTS`）。
 *
 * `count()` 只扫索引不反序列化记录，几万条的表也是瞬时的；
 * 而拿第一页数据来数条数会白白读出最多 16 MiB。
 */
export async function countStores(): Promise<LegacyCounts> {
    const conn = await dbPromise
    const counts: LegacyCounts = { ...EMPTY_LEGACY_COUNTS }
    await Promise.all(
        LEGACY_STORES.map(async (store) => {
            counts[store] = await conn.count(store)
        })
    )
    return counts
}

/**
 * 按主键区间读一页（全量导出用，`DB_EXPORT_PAGE` 的实现）。
 *
 * **为什么必须分页**：一条消息装不下一张整表（与旧库导入同一个体积上限）。
 * `after` 是上一页最后一条的主键，`IDBKeyRange.lowerBound(after, true)` 开区间续读；
 * 返回值 `nextAfter === null` 表示已读完。
 *
 * 单条记录自己就超预算时**仍会取它**（否则游标永远卡在同一位置），
 * 体积超限的后果交由消息层/调用方处理——不在这里静默丢数据。
 * 复用与「页面读旧库」同一套预算常量，避免两处各写一个魔数。
 */
export async function readStorePage(store: LegacyStore, after?: string, maxBytes: number = LEGACY_MAX_MESSAGE_BYTES, maxRecords: number = LEGACY_MAX_MESSAGE_RECORDS): Promise<LegacyStorePage> {
    const conn = await dbPromise
    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)
    const records: unknown[] = []
    let bytes = 0
    let lastKey: string | null = null

    const tx = conn.transaction(store, 'readonly')
    let cursor = await tx.store.openCursor(range)
    while (cursor) {
        const value = cursor.value as unknown
        const size = estimateLegacyRecordBytes(value)
        // records 为空时无条件收下第一条：单条超大型记录不能把游标卡死
        if (records.length > 0 && (bytes + size > maxBytes || records.length >= maxRecords)) break
        records.push(value)
        bytes += size
        lastKey = String(cursor.key)
        cursor = await cursor.continue()
    }
    // 从 break 出来时 cursor 指向尚未读的那条（还有剩）；自然读完时 cursor 为 null
    return { records, nextAfter: cursor === null ? null : lastKey }
}

export const db = {
    /** 批量按 ID 取视频（原 db.getVideosByIds） */
    async getVideosByIds(ids: string[]): Promise<VideoInfo[]> {
        const conn = await dbPromise
        const tx = conn.transaction('videos', 'readonly')
        const store = tx.store
        const results: VideoInfo[] = []
        for (const id of ids) {
            const video = await store.get(id)
            if (video) results.push(video)
        }
        return results
    },

    /** 批量写入（原 db.bulkPutVideos；video 主键 ID） */
    async bulkPutVideos(videos: VideoInfo[]): Promise<void> {
        const conn = await dbPromise
        const tx = conn.transaction('videos', 'readwrite')
        for (const video of videos) {
            await tx.store.put(video)
        }
        await tx.done
    },

    async putVideo(video: VideoInfo): Promise<void> {
        const conn = await dbPromise
        await conn.put('videos', video)
    },

    /**
     * 缓存回填窗口查询（原 db.getFilteredVideos，逐字段对齐）：
     * UploadTime ∈ [start, end] **开区间**；Type ∈ partial/full；Private 或 Unlisted；RAW 存在
     */
    async getFilteredVideos(startTime: number, endTime: number): Promise<VideoInfo[]> {
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return []
        const conn = await dbPromise
        const tx = conn.transaction('videos', 'readonly')
        const index = tx.store.index('UploadTime')
        const allVideos: VideoInfo[] = []
        let cursor = await index.openCursor(IDBKeyRange.bound(startTime, endTime, true, true))
        while (cursor) {
            const video = cursor.value
            if ((video.Type === 'partial' || video.Type === 'full') && (video.Private || video.Unlisted) && video.RAW != null) {
                allVideos.push(video)
            }
            cursor = await cursor.continue()
        }
        return allVideos
    },

    /** 库内最新 UploadTime（无记录时 null；回填默认窗口用） */
    async getLatestUploadTime(): Promise<number | null> {
        const conn = await dbPromise
        const tx = conn.transaction('videos', 'readonly')
        const cursor = await tx.store.index('UploadTime').openCursor(null, 'prev')
        if (!cursor) return null
        const uploadTime = (cursor.value as { UploadTime?: number }).UploadTime
        return typeof uploadTime === 'number' ? uploadTime : null
    },

    /**
     * 最近入库的 N 条（按 UploadTime 倒序；options / GET_VIDEOS 用）。
     * 走 UploadTime 索引游标，不把整库读进内存。
     */
    async getRecentVideos(limit: number): Promise<VideoInfo[]> {
        const conn = await dbPromise
        const tx = conn.transaction('videos', 'readonly')
        const results: VideoInfo[] = []
        let cursor = await tx.store.index('UploadTime').openCursor(null, 'prev')
        while (cursor && results.length < limit) {
            results.push(cursor.value as VideoInfo)
            cursor = await cursor.continue()
        }
        return results
    },

    /** 按用户名查关注记录（.follow 角标判定；username 索引唯一） */
    async getFollowByUsername(username: string): Promise<Iwara.User | undefined> {
        const conn = await dbPromise
        const tx = conn.transaction('follows', 'readonly')
        return (await tx.store.index('username').get(username)) as Iwara.User | undefined
    },

    /** 按用户 ID 查关注记录（源 `getFollowById`：autoFollow 前先查库，避免重复关注） */
    async getFollowById(id: string): Promise<Iwara.User | undefined> {
        const conn = await dbPromise
        return (await conn.get('follows', id)) as Iwara.User | undefined
    },

    async putFollow(user: Iwara.User): Promise<void> {
        const conn = await dbPromise
        await conn.put('follows', user)
    },

    async deleteFollow(id: string): Promise<void> {
        const conn = await dbPromise
        await conn.delete('follows', id)
    },

    async putFriend(user: Iwara.User): Promise<void> {
        const conn = await dbPromise
        await conn.put('friends', user)
    },

    async deleteFriend(id: string): Promise<void> {
        const conn = await dbPromise
        await conn.delete('friends', id)
    },

    /** MediaCenter ID ↔ Iwara ID 映射写入（迁移导入 / MediaCenter 推送用） */
    async putIdmap(entry: { ID: string; href: string }): Promise<void> {
        const conn = await dbPromise
        await conn.put('idmap', entry)
    },

    /** 批量写映射（原 bulkPutMediaCenterIdMaps）：批量同步建映射时一条事务完成 */
    async bulkPutIdmaps(entries: Array<{ ID: string; href: string }>): Promise<void> {
        if (entries.length === 0) return
        const conn = await dbPromise
        const tx = conn.transaction('idmap', 'readwrite')
        await Promise.all([...entries.map((entry) => tx.store.put(entry)), tx.done])
    },

    /** 读取全部映射（原 getAllMediaCenterIdMaps）：批量同步开始前加载已有缓存，避免重复建映射 */
    async getAllIdmaps(): Promise<Map<string, string>> {
        const conn = await dbPromise
        const all = (await conn.getAll('idmap')) as Array<{ ID: string; href: string }>
        const map = new Map<string, string>()
        for (const entry of all) map.set(entry.ID, entry.href)
        return map
    },

    /**
     * 只迭代 videos 表的主键（视频 ID），**不反序列化记录**。
     *
     * 原 `iterateVideoKeysBatched`。为什么必须有：视频库单条记录可达数 MB（简介 + 全部评论），
     * 用 `getAllVideos()` 做「只要 ID 列表」的作业（MediaCenter 批量匹配映射）会把整个库
     * 读进内存并 structured-clone 一遍——十万条库直接卡死标签页。
     *
     * `openKeyCursor` 只取主键，实测比 `openCursor` 快一到两个数量级。
     */
    async *iterateVideoKeysBatched(batchSize: number = 5000): AsyncGenerator<string[], void, void> {
        let lastKey: string | undefined
        let hasMore = true
        while (hasMore) {
            const conn = await dbPromise
            const tx = conn.transaction('videos', 'readonly')
            // 每批一个独立事务：否则 yield 出去后事务会被自动提交（idb 的已知陷阱）
            const range = lastKey === undefined ? undefined : IDBKeyRange.lowerBound(lastKey, true)
            let cursor = await tx.store.openKeyCursor(range)
            const batch: string[] = []
            while (cursor && batch.length < batchSize) {
                batch.push(String(cursor.primaryKey))
                lastKey = String(cursor.primaryKey)
                cursor = await cursor.continue()
            }
            hasMore = cursor !== null
            yield batch
        }
    },

    /**
     * 统计 videos 表中符合条件的记录数（源 `countVideos`：单事务游标，无 yield，事务不会被中断）。
     *
     * MediaCenter 同步用它算分母与「还需要处理多少条」，避免为了一个数字把整库读进内存。
     */
    async countVideos(predicate?: (video: VideoInfo) => boolean): Promise<number> {
        const conn = await dbPromise
        const tx = conn.transaction('videos', 'readonly')
        let cursor = await tx.store.openCursor()
        let count = 0
        while (cursor) {
            if (!predicate || predicate(cursor.value as VideoInfo)) count++
            cursor = await cursor.continue()
        }
        return count
    },

    /**
     * 按批次迭代 videos 表完整记录（源 `iterateVideosBatched`）。
     *
     * 与 `iterateVideoKeysBatched` 的分工：需要**记录内容**（做匹配、逐条改写）时用这个；
     * 只要 ID 列表时用 key 版本（快一到两个数量级）。
     *
     * 分页游标同时记住 `key` 与 `primaryKey`：索引值可能重复（同一上传时间的多个视频），
     * 只用 key 做边界会漏掉或重复返回同 key 的记录。
     *
     * `sortBy` 传索引名（如 `'UploadTime'`）走索引游标；缺省按主键。
     */
    async *iterateVideosBatched(batchSize: number = 500, predicate?: (video: VideoInfo) => boolean, sortBy?: 'UploadTime' | 'ID', direction: IDBCursorDirection = 'next'): AsyncGenerator<VideoInfo[], void, void> {
        let lastIndexKey: IDBValidKey | undefined
        let lastPrimaryKey: IDBValidKey | undefined
        let hasMore = true
        while (hasMore) {
            const conn = await dbPromise
            const tx = conn.transaction('videos', 'readonly')
            const source = sortBy ? tx.store.index(sortBy) : tx.store
            // 游标类型由 source 自身推导：store 与 index 的游标类型参数不同，写死任一种都编不过
            type VideosCursor = Awaited<ReturnType<typeof source.openCursor>>

            let cursor: VideosCursor | null
            if (lastIndexKey === undefined) {
                cursor = await source.openCursor(null, direction)
            } else if (direction === 'prev') {
                // 降序：upperBound 含当前 key，再跳过本批已处理过的记录
                const range = IDBKeyRange.upperBound(lastIndexKey, false)
                cursor = await source.openCursor(range, direction)
                while (cursor && cursor.key === lastIndexKey && lastPrimaryKey !== undefined && cursor.primaryKey >= lastPrimaryKey) {
                    cursor = await cursor.continue()
                }
            } else {
                // 升序：lowerBound 含当前 key，再跳过本批已处理过的记录
                const range = IDBKeyRange.lowerBound(lastIndexKey, false)
                cursor = await source.openCursor(range, direction)
                while (cursor && cursor.key === lastIndexKey && lastPrimaryKey !== undefined && cursor.primaryKey <= lastPrimaryKey) {
                    cursor = await cursor.continue()
                }
            }

            const batch: VideoInfo[] = []
            while (cursor && batch.length < batchSize) {
                const video = cursor.value as VideoInfo
                if (!predicate || predicate(video)) batch.push(video)
                lastIndexKey = cursor.key
                lastPrimaryKey = cursor.primaryKey
                cursor = await cursor.continue()
            }

            hasMore = cursor !== null
            // 事务在此 yield 后安全自动提交
            yield batch
        }
    },

    /**
     * 通用分批迭代任意表（源 `iterateTableBatched`）：按主键升序、每批独立事务。
     *
     * 给「整表导出/整表清理」用——这些场景的调用方不该关心表结构，
     * 也不该为了不撑爆事务而自己手写分页边界。
     */
    async *iterateTableBatched<T = unknown>(table: LegacyStore, batchSize: number = 500): AsyncGenerator<T[], void, void> {
        let lastKey: IDBValidKey | undefined
        let hasMore = true
        while (hasMore) {
            const conn = await dbPromise
            const tx = conn.transaction(table, 'readonly')
            // exclusive 边界：从上一批最后一条之后开始
            const range = lastKey === undefined ? undefined : IDBKeyRange.lowerBound(lastKey, true)
            let cursor = await tx.store.openCursor(range)
            const batch: T[] = []
            while (cursor && batch.length < batchSize) {
                batch.push(cursor.value as T)
                lastKey = cursor.primaryKey
                cursor = await cursor.continue()
            }
            hasMore = cursor !== null
            yield batch
        }
    },

    /** 读取映射（MediaCenter 推送前查缓存） */
    async getIdmap(ID: string): Promise<{ ID: string; href: string } | undefined> {
        const conn = await dbPromise
        return (await conn.get('idmap', ID)) as { ID: string; href: string } | undefined
    },

    async deleteIdmap(ID: string): Promise<void> {
        const conn = await dbPromise
        await conn.delete('idmap', ID)
    },

    // ── 全量读取【仅后台内部使用】──
    //
    // ⚠️ options 虽然与后台同 origin（都是扩展 origin），物理上能直接 openDB，
    // 但**分层上不允许**：视频库是后台专属（docs/01），options 一律经消息查询。
    // 早期迁移页曾直接 import 本文件并直写，造成「同一个库两个写入者」。
    // 外部（options/popup/content）请用：GET_VIDEOS（查询）/ DB_EXPORT_PAGE（导出）/
    // LEGACY_DB_BATCH（批量写入）。
    //
    // 只有整库扫描用途（MediaCenter 同步）留在这里；**导出不要加方法**——
    // 那是 options 的调用路径，必须走 `readStorePage` 分页，否则又会诱使调用方搬回 options。

    async getAllVideos(): Promise<VideoInfo[]> {
        const conn = await dbPromise
        return (await conn.getAll('videos')) as VideoInfo[]
    }
}

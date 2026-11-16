/**
 * 旧脚本页面数据库迁移 —— 四条 `LEGACY_DB_*` 消息的实现。
 *
 * 为什么不在 `index.ts` 的 switch 里：那段代码有 50 行，混在 30 个 case 中间会让
 * 「消息路由」这个装配层变成业务层。这里只做「页面回传 → 校验 → 落库 → 写进度」，
 * 判据本身在 `shared/legacyDb.ts`（`LEGACY_SANITIZERS` + 分批预算），落库在 `storage/db.ts`。
 *
 * ## 为什么必须经过页面
 *
 * 旧库（IndexedDB `IwaraDownloadTool`）在 **iwara.tv origin**，扩展后台看不到它。
 * 只能由 content script 读取后分批回传（见 `content/isolated.ts` 的 `pullLegacyDb`）。
 * 因此 `IMPORT_LEGACY_DB` 需要至少一个真实的 iwara 标签页在场。
 */
import type { Push, Res } from '../../messaging/protocol'
import { i18n } from '../../shared/i18n'
import { LEGACY_SANITIZERS } from '../../shared/legacyDb'
import type { LegacyBatchResult, LegacyDbInfo, LegacyImportProgress, LegacyImportSummary, LegacyStore } from '../../shared/legacyDb'
import { LEGACY_DB_INFO_KEY, LEGACY_DB_SCANNED_KEY } from '../../shared/storageKeys'
import { bulkPutIsolated } from './db'

/** 读一次已存的扫描信息（缺失就是 `undefined`，不要伪造一个空对象） */
async function readInfo(): Promise<LegacyDbInfo | undefined> {
    const stored = await browser.storage.local.get(LEGACY_DB_INFO_KEY)
    return stored[LEGACY_DB_INFO_KEY] as LegacyDbInfo | undefined
}

/**
 * 页面探测结果上报。**保留已存的 `importedAt`**：探测是每次进页面都可能重跑的，
 * 若覆盖掉导入时间，迁移页的「上次导入于…」会凭空消失。
 */
export async function recordLegacyScan(payload: { found: boolean; counts: LegacyDbInfo['counts'] }): Promise<{ info: LegacyDbInfo }> {
    const previous = (await readInfo()) ?? ({} as Partial<LegacyDbInfo>)
    const info: LegacyDbInfo = {
        found: payload.found,
        counts: payload.counts,
        scannedAt: Date.now(),
        ...(typeof previous.importedAt === 'number' ? { importedAt: previous.importedAt } : {})
    }
    await browser.storage.local.set({ [LEGACY_DB_INFO_KEY]: info, [LEGACY_DB_SCANNED_KEY]: true })
    return { info }
}

/**
 * 一批记录入库：逐条校验 + 分块写。
 * 块内失败会二分隔离到单条（见 `bulkPutIsolated`），坏记录只丢自己。
 */
export async function storeLegacyBatch(payload: { store: LegacyStore; records: unknown[] }): Promise<LegacyBatchResult> {
    const { store, records } = payload
    const valid = LEGACY_SANITIZERS[store](records)
    const result: LegacyBatchResult = { written: 0, invalid: records.length - valid.length, failed: 0 }
    if (valid.length > 0) {
        const written = await bulkPutIsolated(store, valid)
        result.written = written.written
        result.failed = written.failed
    }
    return result
}

/**
 * 长任务进度：写进 `legacyDb.progress`，迁移页订阅 storage 就能看到。
 *
 * 不走消息响应是因为导入要跑几分钟，而消息通道有单事件时长上限；
 * 这里只写本地存储（一次性小对象，不刷盘成高频写）。
 */
export async function recordLegacyProgress(progress: LegacyImportProgress): Promise<{ ok: true }> {
    const base = (await readInfo()) ?? { found: true, counts: { videos: 0, follows: 0, friends: 0, idmap: 0 }, scannedAt: Date.now() }
    await browser.storage.local.set({ [LEGACY_DB_INFO_KEY]: { ...base, progress } satisfies LegacyDbInfo })
    return { ok: true }
}

/**
 * 发起导入：让一个 iwara 标签页读取它的页面 IDB 并分批回传。
 *
 * 无论成败都要**清掉进度与 `importing` 标记**，否则 UI 会卡在「导入中…」——
 * 那是最难自行恢复的假状态（用户不知道要刷新还是重试）。
 *
 * `importing` 是**后台侧的运行真相**，界面不能只用自己的 `busy` state 判断：
 * 用户切到别的页签再回来时组件会重挂载，`busy` 归零 —— 进度条消失、按钮变回可点，
 * 而导入还在跑几分钟，再点一次就是两条并发的导入写同一张表。
 */
export async function importLegacyDb(): Promise<LegacyImportSummary> {
    const tabs = await browser.tabs.query({ url: ['*://*.iwara.tv/*'] })
    const target = tabs.find((tab) => typeof tab.id === 'number')
    if (typeof target?.id !== 'number') throw new Error(i18n.t('notify.needIwaraTab'))

    // 先置标记再开跑：中间任何 await 都可能让界面重挂载，早一步写就少一个窗口
    await markImporting(true)
    let settled = false
    try {
        const response = (await browser.tabs.sendMessage(target.id, { type: 'LEGACY_DB_PULL', payload: {} } satisfies Push).catch(() => undefined)) as Res | undefined

        if (!response?.ok) throw new Error(response?.error ?? i18n.t('notify.legacyReadFailed'))

        const summary = response.data as LegacyImportSummary
        const info: LegacyDbInfo = {
            found: true,
            counts: { videos: summary.videos, follows: summary.follows, friends: summary.friends, idmap: summary.idmap },
            scannedAt: Date.now(),
            importedAt: Date.now(),
            progress: null,
            importing: false
        }
        await browser.storage.local.set({ [LEGACY_DB_INFO_KEY]: info, [LEGACY_DB_SCANNED_KEY]: true })
        settled = true
        return summary
    } finally {
        // 失败分支必须清：不清就永远停在「导入中」（最难受的假状态）。
        // 成功分支已经写了完整 info（`importing: false`），这里不再重复写一次。
        if (!settled) await markImporting(false)
    }
}

/** 只改 `importing`（保留 `counts` / `importedAt` / `progress` 其余字段），失败静默 */
async function markImporting(importing: boolean): Promise<void> {
    try {
        const previous = await readInfo()
        if (!previous) {
            // 从未扫描过就发起导入：先造一个最小的 info，否则界面读不到任何东西
            await browser.storage.local.set({ [LEGACY_DB_INFO_KEY]: { found: true, counts: { videos: 0, follows: 0, friends: 0, idmap: 0 }, scannedAt: Date.now(), importing } satisfies LegacyDbInfo })
            return
        }
        await browser.storage.local.set({ [LEGACY_DB_INFO_KEY]: { ...previous, importing } satisfies LegacyDbInfo })
    } catch {
        // 写失败只影响「切页签回来能不能看到在跑」，不能打断导入本身
    }
}

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
 * 无论成败都要**清掉进度**，否则 UI 会卡在「导入中…」——那是最难自行恢复的
 * 假状态（用户不知道要刷新还是重试）。
 */
export async function importLegacyDb(): Promise<LegacyImportSummary> {
    const tabs = await browser.tabs.query({ url: ['*://*.iwara.tv/*'] })
    const target = tabs.find((tab) => typeof tab.id === 'number')
    if (typeof target?.id !== 'number') throw new Error(i18n.t('notify.needIwaraTab'))

    const response = (await browser.tabs.sendMessage(target.id, { type: 'LEGACY_DB_PULL', payload: {} } satisfies Push).catch(() => undefined)) as Res | undefined

    if (!response?.ok) {
        const previous = await readInfo()
        if (previous) await browser.storage.local.set({ [LEGACY_DB_INFO_KEY]: { ...previous, progress: null } satisfies LegacyDbInfo })
        throw new Error(response?.error ?? i18n.t('notify.legacyReadFailed'))
    }

    const summary = response.data as LegacyImportSummary
    const info: LegacyDbInfo = {
        found: true,
        counts: { videos: summary.videos, follows: summary.follows, friends: summary.friends, idmap: summary.idmap },
        scannedAt: Date.now(),
        importedAt: Date.now(),
        progress: null
    }
    await browser.storage.local.set({ [LEGACY_DB_INFO_KEY]: info, [LEGACY_DB_SCANNED_KEY]: true })
    return summary
}

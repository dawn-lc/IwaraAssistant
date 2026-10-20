/**
 * 迁移页签 —— 油猴脚本数据迁移向导（docs/06 M4）
 *
 * 两条导入通道：
 * 1. **旧脚本浏览器数据库**（首选，库存四表）：旧库在 iwara.tv 页面 origin，只能由 content
 *    script 读取，后台转发拉取并逐批校验入库——不需要用户手工导出，但需开着 iwara 标签页。
 * 2. **粘贴 / 文件**（配置只能走这条）：旧脚本的「导出配置」是 `GM_setClipboard(config)`，
 *    剪贴板里是**裸配置对象**（没有 config 包裹，也不含库存四表）；本扩展自己的导出则是
 *    完整迁移包 `{ config, videos, follows, friends, idmap }`。两种形态都由
 *    `shared/migrationStream` 识别，UI 只负责把文本或文件变成字符块。
 *
 * 两条通道共用 `shared/legacyDb` 的校验函数，避免口径漂移。
 *
 * ## 为什么是三个独立区块
 *
 * 架构约定：**状态属于区块，不属于页面**。
 * 曾经导出/复制/导入写在同一个组件里共用一个布尔 `busy`，于是点「导出为 JSON 文件」时
 * 下面的导入按钮会喊「导入中…」；当时我用 `'export' | 'copy' | 'import'` 枚举去打补丁，
 * 但那只是让画错的边界勉强能用——根因是三个独立操作共用了页面级状态。
 * 现在拆成三个组件文件（见 `./migrate/`），每个自带自己的进行中状态与结果，
 * 跨区块污染在结构上不可能发生。本文件**不持有任何状态**，只负责把三者摆在一起。
 */
import type { ReactElement } from 'react'
import { ExportSection } from './migrate/ExportSection'
import { ImportSection } from './migrate/ImportSection'
import { LegacyDbImport } from './migrate/LegacyDbImport'

export function MigrateTab(): ReactElement {
    return (
        <>
            <LegacyDbImport />
            <ExportSection />
            <ImportSection />
        </>
    )
}

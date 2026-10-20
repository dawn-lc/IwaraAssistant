/**
 * 迁移载荷的**形态与类型** —— 解析实现见 `migrationStream`（流式，不整串解析）。
 *
 * 为什么「形态」这件事本身要单独定义：
 * - 旧油猴脚本的「导出配置」并不是导出文件，而是 `GM_setClipboard(stringify(config))`
 *   （见源项目 `ui/setup.ts` + `ui/configUi.ts`），剪贴板里是**裸配置对象**；
 *   用户在新扩展里只能粘贴它，而不是选一个不存在的文件。
 * - 本扩展自己的「导出全部数据」是**完整迁移包**（`{ config, videos, follows, friends, idmap }`）。
 * - 两条来源都必须能导入，且不能互相误判：把一份完整包当配置、或把裸配置当包，
 *   都会静默丢数据（前者会把四张表当未知键忽略，后者会用默认值覆盖配置）。
 *
 * 识别规则（顺序即优先级）：
 * 1. 含 `config` 或任一四表数组键 → 完整迁移包；
 * 2. 否则，只要含有**至少一个本扩展认识的配置键** → 裸配置对象；
 * 3. 都不是 → 报错（绝不做「当成空配置并写默认值」这种破坏性兜底）。
 */
import { configSchema } from './configSchema'

export type MigrationPayloadShape = 'package' | 'config'

/** 本扩展认识的配置键集合（用于区分「裸配置」与「一堆无关 JSON」） */
const CONFIG_KEYS = new Set(Object.keys(configSchema.shape))

/** 迁移包/配置里本扩展不认识的键（UI 提示用；未知键会被 schema 剥离，不会写入） */
export function unknownConfigKeys(config: Record<string, unknown>): string[] {
    return Object.keys(config).filter((key) => !CONFIG_KEYS.has(key))
}

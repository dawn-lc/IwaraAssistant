/**
 * `storage.onChanged` 变更集的读取 —— 全项目唯一收窄点。
 *
 * 为什么需要它：`browser.storage.onChanged` 的 `changes` 参数在两个宿主的 TS 类型里
 * 都不够好用（Chrome 的 `{ [key: string]: StorageChange }` 里 `newValue?: any`，
 * Firefox 的 lib 又不一定参与编译），于是每个调用点都写一遍
 * `(changes as { [key: string]: { newValue?: unknown } })[KEY]?.newValue`。
 *
 * 六处这样的重复一旦漂移（例如某处写成 `as any` 或忘了 `?.`），
 * 得到的就是**静默的 undefined**——回调照常执行，只是永远拿不到新值。
 * 收窄成唯一实现后，调用点只表达意图：给我这个键的新值。
 */

/** 变更集里单个键的形态（Chrome `StorageChange` 的宽松版） */
export interface StorageChangeEntry {
    oldValue?: unknown
    newValue?: unknown
}

export type StorageChangeSet = Record<string, StorageChangeEntry | undefined>

/**
 * 读取某个键的新值。
 *
 * 键不存在时返回 `undefined`；键存在但被删除（`newValue` 缺省）时同样返回 `undefined`
 * —— 这两种情况在业务上都等价于「没有值」，调用方不需要区分。
 * 需要区分时用 `key in changes` 自行判断。
 */
export function changedValue<T = unknown>(changes: Record<string, unknown>, key: string): T | undefined {
    return (changes as StorageChangeSet)[key]?.newValue as T | undefined
}

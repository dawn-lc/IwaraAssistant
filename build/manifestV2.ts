/**
 * MV3 形状 → MV2 形状（Firefox 变体专用，见 manifest/variants.ts 的 `manifestVersion: 2`）。
 *
 * base 模板永远按 MV3 写（Chrome 是主产物），MV2 的差异在这里做**一次性、可枚举**的改写，
 * 而不是在 base 里塞一堆占位符：字段一多，占位符方案会让「某个字段漏写」变成静默失败。
 *
 * | MV3                                          | MV2                                |
 * | -------------------------------------------- | ---------------------------------- |
 * | `host_permissions`                           | 并入 `permissions`（MV2 没有这个键） |
 * | `optional_host_permissions`                  | 并入 `optional_permissions`        |
 * | `action`                                     | `browser_action`                   |
 * | `content_security_policy: {extension_pages}` | 字符串                             |
 * | `web_accessible_resources: [{resources}]`    | `string[]`（摊平）                 |
 * | `background.service_worker`                  | `background.scripts` + `persistent`|
 * | `minimum_chrome_version`                     | 删除（Chrome 专属）                |
 *
 * 独立成模块是为了能被单测覆盖：manifest 错了，扩展在 Firefox 上要么装不上、
 * 要么静默少权限，报错点离真因非常远。
 */
export function toManifestV2(manifest: Record<string, unknown>): void {
    mergeIntoPermissions(manifest, 'host_permissions', 'permissions')
    mergeIntoPermissions(manifest, 'optional_host_permissions', 'optional_permissions')

    if ('action' in manifest) {
        manifest['browser_action'] = manifest['action']
        delete manifest['action']
    }

    const csp = manifest['content_security_policy']
    if (csp && typeof csp === 'object') {
        const extensionPages = (csp as { extension_pages?: string }).extension_pages
        if (extensionPages) manifest['content_security_policy'] = extensionPages
        else delete manifest['content_security_policy']
    }

    const war = manifest['web_accessible_resources']
    if (Array.isArray(war)) {
        manifest['web_accessible_resources'] = (war as Array<string | { resources?: string[] }>).flatMap((entry) => (typeof entry === 'string' ? [entry] : (entry.resources ?? [])))
    }

    const background = manifest['background']
    if (background && typeof background === 'object' && 'service_worker' in background) {
        const worker = (background as { service_worker: string }).service_worker
        manifest['background'] = { scripts: [worker], persistent: true }
    }

    // Chrome 专属键：留在 Firefox 包里既无意义，也会误导「Firefox 也受这个下限约束」
    delete manifest['minimum_chrome_version']

    manifest['manifest_version'] = 2

    const leftovers = ['host_permissions', 'optional_host_permissions', 'action', 'minimum_chrome_version'].filter((key) => key in manifest)
    if (leftovers.length > 0) throw new Error(`[build] MV2 转换后仍残留 MV3 专有键：${leftovers.join(', ')}（请更新 build/manifestV2.ts）`)
}

/** 把 MV3 的 `*_host_permissions` 并入对应的 MV2 权限数组（去重，保持 base 顺序在前） */
function mergeIntoPermissions(manifest: Record<string, unknown>, sourceKey: string, targetKey: string): void {
    const source = manifest[sourceKey]
    delete manifest[sourceKey]
    if (!Array.isArray(source) || source.length === 0) return
    const existing = Array.isArray(manifest[targetKey]) ? (manifest[targetKey] as string[]) : []
    manifest[targetKey] = [...existing, ...source.filter((item): item is string => typeof item === 'string' && !existing.includes(item))]
}

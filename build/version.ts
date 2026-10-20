/**
 * 扩展版本号 —— `package.json` 是**唯一真源**，manifest 里的 `version` 是构建期派生产物。
 *
 * 为什么需要这层：
 * - 商店只接受 1~4 段整数（`1.2.3`、`1.2.3.4`），`1.0.0-beta.1` 这类预发布串会被拒收；
 * - Chrome Web Store 每段上限 65535，AMO 每段最多 9 位 → 同时上架必须取**交集**；
 * - 两份 manifest 的版本号曾经是手写的第二个真源，改 `package.json` 不会影响产物。
 *
 * 因此这里**不静默清洗**：版本号不合法就直接让构建失败，并说明怎么改。
 * 悄悄把 `1.0.0-beta.1` 削成 `1.0.0` 会让 git tag 与商店版本对不上，
 * 那是最难排查的一类发布事故。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * 商店接受的版本格式：1~4 段十进制整数，非零段不得前导零。
 * 与 MDN / Chrome 文档的正则同义，只是把段数上限写进量词。
 */
const VERSION_PATTERN = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/

/**
 * 单段上限：Chrome 是 65535（AMO 允许 9 位数字，但两家同时上架必须取交集）。
 * `65535` 只有 5 位，所以 9 位那条限制按数学上被包含了，不必单独判。
 */
const MAX_SEGMENT = 65535

/**
 * 校验版本号，不合法直接抛错。
 *
 * `source` 只用于错误信息（例如 `package.json`），调用方不必自己拼前缀。
 */
export function assertExtensionVersion(version: unknown, source = 'package.json'): asserts version is string {
    if (typeof version !== 'string' || version === '') {
        throw new Error(`[version] ${source} 缺少 version 字段。扩展版本号只能有一个真源，请先设置它`)
    }
    if (!VERSION_PATTERN.test(version)) {
        throw new Error(`[version] ${source} 的 version "${version}" 不符合扩展清单格式：` + `必须是 1~4 段十进制整数（如 1、1.2、1.2.3、1.2.3.4），非零段不得前导零。` + `预发布标识（-beta.1 / +build）商店不收——用第 4 段表达构建号（1.2.3.1），或在 package.json 里去掉预发布后缀`)
    }
    const segments = version.split('.')
    if (segments.every((segment) => segment === '0')) {
        throw new Error(`[version] ${source} 的 version "${version}" 全为 0，Chrome Web Store 会拒收`)
    }
    for (const segment of segments) {
        if (Number(segment) > MAX_SEGMENT) {
            throw new Error(`[version] ${source} 的 version "${version}" 中有一段超过 ${MAX_SEGMENT}（Chrome Web Store 上限；AMO 允许 9 位数字，但同时上架必须取交集）`)
        }
    }
}

/**
 * 读取并校验 `package.json` 的 version。
 *
 * 构建脚本在写 manifest 前调用它——**校验失败就让构建失败**，
 * 不允许"产物里没有版本号"或"版本号是猜的"。
 */
export async function readExtensionVersion(rootDir: string): Promise<string> {
    const packagePath = path.join(rootDir, 'package.json')
    let parsed: unknown
    try {
        parsed = JSON.parse(await fs.readFile(packagePath, 'utf8'))
    } catch (error) {
        throw new Error(`[version] 无法读取 ${path.relative(rootDir, packagePath)}：${error instanceof Error ? error.message : String(error)}`)
    }
    const version = (parsed as { version?: unknown }).version
    assertExtensionVersion(version, 'package.json')
    return version
}

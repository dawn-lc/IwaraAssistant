/**
 * 商店打包（node --import tsx/esm ./build/package.ts [chrome|firefox]）—— 发布交付物
 *
 * 产物：
 *   dist/chrome.zip   —— Chrome Web Store 上传包
 *   dist/firefox.zip  —— AMO 上传包
 *
 * 两个入口：
 *  - `npm run build` 会在双目标编译后自动调用本脚本（日常只需要这一条命令）
 *  - `npm run package[:chrome|:firefox]` 单独重打已有产物（不重新编译）
 *
 * 用手写 ZIP（deflateRaw + 中央目录）而非 Compress-Archive：
 *  - 条目路径强制正斜杠（Compress-Archive 写反斜杠分隔符，部分商店校验器拒绝）
 *  - manifest.json 恒在包根（商店加载要求）
 *  - 产物字节确定（时间戳取构建时刻，单次构建内一致）
 */
import { deflateRawSync } from 'node:zlib'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { crc32 } from './crc32'

const root = path.resolve(import.meta.dirname, '..')
const destRoot = path.join(root, 'dist')

// ── ZIP 结构 ─────────────────────────────────────────────────────────

interface ZipEntry {
    name: string
    data: Buffer
    compressed: Buffer
    crc: number
}

/** DOS 时间戳（本地时刻；2s 精度） */
function dosDateTime(date: Date): { time: number; date: number } {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
    const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    return { time, date: dosDate }
}

async function collectFiles(sourceDir: string, base = ''): Promise<ZipEntry[]> {
    const entries: ZipEntry[] = []
    const items = await fs.readdir(sourceDir, { withFileTypes: true })
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(sourceDir, item.name)
        const relative = base === '' ? item.name : `${base}/${item.name}`
        if (item.isDirectory()) {
            entries.push(...(await collectFiles(absolute, relative)))
        } else {
            const data = await fs.readFile(absolute)
            entries.push({
                name: relative, // 强制正斜杠：商店校验器兼容性
                data,
                compressed: deflateRawSync(data, { level: 9 }),
                crc: crc32(data)
            })
        }
    }
    return entries
}

function writeZip(entries: ZipEntry[], builtAt: Date): Buffer {
    const { time, date } = dosDateTime(builtAt)
    const localParts: Buffer[] = []
    const centralParts: Buffer[] = []
    let offset = 0

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8')
        const useDeflate = entry.compressed.length < entry.data.length
        const stored = useDeflate ? entry.compressed : entry.data

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4) // version needed
        local.writeUInt16LE(0, 6) // flags（前后长度已知，无需 data descriptor）
        local.writeUInt16LE(useDeflate ? 8 : 0, 8)
        local.writeUInt16LE(time, 10)
        local.writeUInt16LE(date, 12)
        local.writeUInt32LE(entry.crc, 14)
        local.writeUInt32LE(stored.length, 18)
        local.writeUInt32LE(entry.data.length, 22)
        local.writeUInt16LE(name.length, 26)
        local.writeUInt16LE(0, 28)
        localParts.push(local, name, stored)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4) // version made by
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(0, 8)
        central.writeUInt16LE(useDeflate ? 8 : 0, 10)
        central.writeUInt16LE(time, 12)
        central.writeUInt16LE(date, 14)
        central.writeUInt32LE(entry.crc, 16)
        central.writeUInt32LE(stored.length, 20)
        central.writeUInt32LE(entry.data.length, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt16LE(0, 30) // extra len
        central.writeUInt16LE(0, 32) // comment len
        central.writeUInt16LE(0, 34) // disk start
        central.writeUInt16LE(0, 36) // internal attrs
        central.writeUInt32LE(0, 38) // external attrs
        central.writeUInt32LE(offset, 42)
        centralParts.push(central, name)

        offset += 30 + name.length + stored.length
    }

    const centralBuf = Buffer.concat(centralParts)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)

    return Buffer.concat([...localParts, centralBuf, eocd])
}

// ── 执行 ─────────────────────────────────────────────────────────────

type Target = 'chrome' | 'firefox'

/**
 * 目标选择：不带参数打两个目标；`package.ts chrome` 只打 Chrome。
 * 旧实现忽略 argv——`npm run package:chrome` 实际仍会连 Firefox 一起打，
 * 且在 firefox 产物缺失时直接抛错（明明只要 chrome 包）。
 */
const requested = process.argv.slice(2).filter((arg): arg is Target => arg === 'chrome' || arg === 'firefox')
const targets: Target[] = requested.length > 0 ? [...new Set(requested)] : ['chrome', 'firefox']

for (const target of targets) {
    const sourceDir = path.join(destRoot, target)
    const manifestPath = path.join(sourceDir, 'manifest.json')
    if (!existsSync(manifestPath)) {
        throw new Error(`[package] 缺少 ${path.relative(root, manifestPath)}——先运行 npm run build`)
    }
    const manifestVersion = (JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version?: string }).version ?? '?.?.?'
    const entries = await collectFiles(sourceDir)
    const zip = writeZip(entries, new Date())
    const outFile = path.join(destRoot, `${target}.zip`)
    await fs.writeFile(outFile, zip)
    console.log(`[package] dist/${target}.zip  v${manifestVersion}  ${entries.length} 个文件  ${(zip.length / 1024).toFixed(1)} KiB`)
}

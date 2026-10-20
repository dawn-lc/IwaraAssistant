/**
 * 图标栅格化器：`assets/icons/logo.svg` → PNG 像素。
 *
 * **为什么要有这一层，而不是把 SVG 直接当图标**：
 * - Chrome 的 manifest `icons` 明确**不支持 SVG**（只接受 Blink 支持的栅格格式：
 *   BMP/GIF/ICO/JPEG/PNG），Chrome Web Store 也要求 128×128 PNG；
 * - Firefox 92+ 支持 SVG，但同一份 SVG 无法按尺寸给出不同的几何修正——
 *   16px 下完整 logo 的细节（锯齿挖空 + 播放三角）只有 1~2 个像素，会糊成一团（见 sampleGlyph）；
 * - 双宿主一批产物更简单，不如统一输出 PNG。
 *
 * 因此：**SVG 是唯一几何来源**（设计工具可直接编辑），PNG 在构建期由此模块生成，
 * 仓库不再保存一份可能过期的 PNG 副本。
 *
 * 实现：只解析 `M / L / H / V / Z`（直线段），按 **nonzero 绕向规则**填充
 * （内层子路径绕向与外壳相反 → 自然成为挖空，这正是 SVG 的默认语义；
 * 改成「轮廓异或」虽然在这张图上等价，却会掩盖「绕向写反」这类错误），
 * 4×4 超采样做抗锯齿，PNG 编码用 node:zlib（无第三方依赖）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { crc32 } from './crc32'

const root = path.resolve(import.meta.dirname, '..')

/** 几何源文件（唯一来源）。改图标只改这个文件。 */
export const LOGO_SVG_PATH = path.join(root, 'assets', 'icons', 'logo.svg')

// ── 几何解析 ─────────────────────────────────────────────────────────

type Point = { x: number; y: number }

interface Bounds {
    minX: number
    minY: number
    width: number
    height: number
}

const PATH_TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g
const NUMBER = /[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g

/**
 * 解析 SVG path 的 `M / L / H / V / Z`（含相对形式与小写命令）。
 *
 * 只实现直线段命令，遇到其它命令**直接抛错**：静默跳过会生成一个缺块的 logo，
 * 而图标是肉眼很难逐像素核对的东西。
 */
function parseSvgContours(pathData: string): Point[][] {
    const tokens = pathData.match(PATH_TOKEN) ?? []
    const contours: Point[][] = []
    let contour: Point[] = []
    let cursor: Point = { x: 0, y: 0 }
    let subpathStart: Point = cursor
    let command = ''
    let index = 0
    const nextNumber = (): number => {
        const raw = tokens[index++]
        const value = raw === undefined || /^[a-zA-Z]$/.test(raw) ? Number.NaN : Number(raw)
        if (!Number.isFinite(value)) throw new Error(`图标路径解析失败：命令 ${command} 缺少数字参数`)
        return value
    }
    while (index < tokens.length) {
        const token = tokens[index]!
        if (/^[a-zA-Z]$/.test(token)) {
            command = token
            index++
        } else if (command === '') {
            throw new Error(`图标路径解析失败：数字 "${token}" 前缺少命令`)
        }
        const upper = command.toUpperCase()
        const relative = command !== upper
        if (upper === 'M') {
            if (contour.length > 0) contours.push(contour)
            const x = nextNumber()
            const y = nextNumber()
            cursor = relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y }
            subpathStart = cursor
            contour = [cursor]
            // 紧跟的第一个坐标对是 moveto，其余是隐式 lineto（SVG 语义）
            command = relative ? 'l' : 'L'
        } else if (upper === 'L') {
            const x = nextNumber()
            const y = nextNumber()
            cursor = relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y }
            contour.push(cursor)
        } else if (upper === 'H') {
            const x = nextNumber()
            cursor = { x: relative ? cursor.x + x : x, y: cursor.y }
            contour.push(cursor)
        } else if (upper === 'V') {
            const y = nextNumber()
            cursor = { x: cursor.x, y: relative ? cursor.y + y : y }
            contour.push(cursor)
        } else if (upper === 'Z') {
            if (contour.length > 0) contours.push(contour)
            contour = []
            cursor = subpathStart
            command = ''
        } else {
            throw new Error(`图标路径里有本栅格化器未实现的命令 "${command}"（只支持 M/L/H/V/Z，曲线请先转成折线）`)
        }
    }
    if (contour.length > 0) contours.push(contour)
    return contours
}

/** 解析 `<polygon points="x y x y …">` */
function parsePolygonContour(points: string): Point[] {
    const numbers = points.match(NUMBER)?.map(Number) ?? []
    if (numbers.length < 6 || numbers.length % 2 !== 0) throw new Error(`图标多边形解析失败：${points}`)
    const contour: Point[] = []
    for (let index = 0; index < numbers.length; index += 2) contour.push({ x: numbers[index]!, y: numbers[index + 1]! })
    return contour
}

interface LogoGeometry {
    /** 外壳（菱形，顺时针/逆时针皆可，靠绕向与挖空区分） */
    shell: Point[]
    /** 中间挖空（绕向与外壳相反） */
    hole: Point[]
    /** 播放三角（原口径） */
    triangle: Point[]
    /** 播放三角（小尺寸光学放大版） */
    triangleSmall: Point[]
    bounds: Bounds
}

let cachedGeometry: LogoGeometry | null = null

function loadGeometry(): LogoGeometry {
    if (cachedGeometry) return cachedGeometry
    const markup = readFileSync(LOGO_SVG_PATH, 'utf8')
    if (!/<svg[\s>]/i.test(markup)) throw new Error(`图标源文件不是 SVG：${LOGO_SVG_PATH}`)
    if (!/viewBox\s*=\s*"/i.test(markup)) throw new Error(`图标源文件缺少 viewBox（Firefox 直接使用 SVG 时必需）：${LOGO_SVG_PATH}`)

    const pathData = /<path\b[^>]*\sd\s*=\s*"([^"]+)"/i.exec(markup)?.[1]
    if (!pathData) throw new Error(`图标源文件缺少 <path d="…">：${LOGO_SVG_PATH}`)

    const polygonTags = [...markup.matchAll(/<polygon\b[^>]*>/gi)].map((match) => match[0])
    if (polygonTags.length !== 1) throw new Error(`图标源文件应含 1 个 <polygon>（播放三角），实际 ${polygonTags.length}`)
    const points = /\spoints\s*=\s*"([^"]+)"/i.exec(polygonTags[0]!)?.[1]
    if (!points) throw new Error(`图标 <polygon> 缺少 points 属性：${LOGO_SVG_PATH}`)

    const subpaths = parseSvgContours(pathData)
    if (subpaths.length !== 2) throw new Error(`图标 <path> 应含 2 个子路径（外壳 + 挖空），实际 ${subpaths.length}`)
    const shell = subpaths[0]!
    const hole = subpaths[1]!
    const triangle = parsePolygonContour(points)

    /**
     * 小尺寸专用的播放三角：绕几何中心放大。
     * 图标设计里的常规光学调整——同一个形状在 16px 下只有 3~4 像素，
     * 按原比例挖空会退化成一个点；放大后仍是「三角」，不会变成另一个符号。
     */
    const opticalScale = 1.4
    const cx = triangle.reduce((sum, point) => sum + point.x, 0) / triangle.length
    const cy = triangle.reduce((sum, point) => sum + point.y, 0) / triangle.length
    const triangleSmall = triangle.map((point) => ({ x: cx + (point.x - cx) * opticalScale, y: cy + (point.y - cy) * opticalScale }))

    const all = [...shell, ...hole, ...triangle]
    const xs = all.map((point) => point.x)
    const ys = all.map((point) => point.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const bounds: Bounds = { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
    if (bounds.width <= 0 || bounds.height <= 0) throw new Error('图标几何退化了（宽或高为 0），检查 SVG 路径')

    cachedGeometry = { shell, hole, triangle, triangleSmall, bounds }
    return cachedGeometry
}

// ── 绘制 ─────────────────────────────────────────────────────────────

/** 圆角矩形的有向距离（内部为负） */
function sdRoundRect(point: Point, halfWidth: number, halfHeight: number, radius: number): number {
    const dx = Math.abs(point.x) - (halfWidth - radius)
    const dy = Math.abs(point.y) - (halfHeight - radius)
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
    return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/**
 * 某组轮廓在 SVG 坐标处的绕向数（nonzero 填充规则）：0 = 在轮廓外。
 * 对每条边做「水平射线穿越」计数（Dan Sunday 的 winding number）。
 */
function windingAt(contours: Point[][], px: number, py: number): number {
    let winding = 0
    for (const contour of contours) {
        for (let index = 0; index < contour.length; index++) {
            const a = contour[index]!
            const b = contour[(index + 1) % contour.length]!
            const side = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)
            // 向上穿过射线 +1，向下穿过 -1
            if (a.y <= py) {
                if (b.y > py && side > 0) winding++
            } else if (b.y <= py && side < 0) {
                winding--
            }
        }
    }
    return winding
}

/**
 * logo 占图标边长比例。
 * 16px 用简化图形（见 sampleGlyph），占位略微放大以保住轮廓。
 */
function logoCoverage(size: number): number {
    return size <= 16 ? 0.84 : 0.78
}

interface LogoTransform {
    scale: number
    left: number
    top: number
}

function logoTransform(bounds: Bounds, coverage: number): LogoTransform {
    const scale = Math.min(coverage / bounds.width, coverage / bounds.height)
    return { scale, left: (1 - bounds.width * scale) / 2, top: (1 - bounds.height * scale) / 2 }
}

/** 归一化采样点是否落在 logo 实心区（含挖空判定） */
function sampleGlyph(x: number, y: number, geometry: LogoGeometry, transform: LogoTransform, simplified: boolean): boolean {
    const { bounds } = geometry
    const px = (x - transform.left) / transform.scale + bounds.minX
    const py = (y - transform.top) / transform.scale + bounds.minY
    if (!simplified) return windingAt([geometry.shell, geometry.hole, geometry.triangle], px, py) !== 0

    // 16px：锯齿挖空与播放三角各自只有 1~2 像素，会互相挤压成模糊一团。
    // 改为「实心菱形 + 播放三角挖空」：保留两个可辨认元素，丢掉最细的那块。
    return windingAt([geometry.shell], px, py) !== 0 && windingAt([geometry.triangleSmall], px, py) === 0
}

/** 单个采样点的颜色（含透明度），返回 [r,g,b,a]（a ∈ [0,1]） */
function sampleAt(size: number, x: number, y: number): [number, number, number, number] {
    // 底板：圆角方形，半径 0.22
    const plate = sdRoundRect({ x: x - 0.5, y: y - 0.5 }, 0.5, 0.5, 0.22)
    if (plate > 0) return [0, 0, 0, 0]

    const geometry = loadGeometry()
    const transform = logoTransform(geometry.bounds, logoCoverage(size))
    // logo 填充：近白色（与站点正文色一致）
    if (sampleGlyph(x, y, geometry, transform, size <= 16)) return [0xf8, 0xf8, 0xff, 1]

    // 底色：竖直渐变，顶部亮（#61afef）→ 底部深（#2993e9）
    const t = Math.min(Math.max(y, 0), 1)
    return [Math.round(0x61 + (0x29 - 0x61) * t), Math.round(0xaf + (0x93 - 0xaf) * t), Math.round(0xef + (0xe9 - 0xef) * t), 1]
}

/** 渲染一张 RGBA 图标（4×4 超采样） */
function renderPixels(size: number): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(size * size * 4)
    const samples = 4
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0
            let g = 0
            let b = 0
            let a = 0
            for (let sy = 0; sy < samples; sy++) {
                for (let sx = 0; sx < samples; sx++) {
                    const px = (x + (sx + 0.5) / samples) / size
                    const py = (y + (sy + 0.5) / samples) / size
                    const [cr, cg, cb, ca] = sampleAt(size, px, py)
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
                }
            }
            const total = samples * samples
            const index = (y * size + x) * 4
            const alpha = a / total
            pixels[index] = alpha > 0 ? Math.round(r / a) : 0
            pixels[index + 1] = alpha > 0 ? Math.round(g / a) : 0
            pixels[index + 2] = alpha > 0 ? Math.round(b / a) : 0
            pixels[index + 3] = Math.round(alpha * 255)
        }
    }
    return pixels
}

// ── PNG 编码（IHDR / IDAT / IEND）────────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typeBuffer = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
    return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(size: number, pixels: Uint8ClampedArray): Buffer {
    const raw = Buffer.alloc((size * 4 + 1) * size)
    let offset = 0
    for (let y = 0; y < size; y++) {
        raw[offset++] = 0 // filter: none
        for (let x = 0; x < size; x++) {
            const index = (y * size + x) * 4
            raw[offset++] = pixels[index]!
            raw[offset++] = pixels[index + 1]!
            raw[offset++] = pixels[index + 2]!
            raw[offset++] = pixels[index + 3]!
        }
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(size, 0)
    ihdr.writeUInt32BE(size, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // color type: RGBA
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))])
}

/**
 * 生成指定边长的 PNG（manifest 图标就靠它）。
 *
 * 16px 会自动走简化几何 + 光学放大（见 sampleGlyph），不用调用方操心。
 */
export function renderIconPng(size: number): Buffer {
    if (!Number.isInteger(size) || size <= 0 || size > 2048) throw new Error(`图标尺寸非法：${size}`)
    return encodePng(size, renderPixels(size))
}

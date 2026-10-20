/**
 * CRC32（IEEE 802.3，反射多项式 0xEDB88320）—— ZIP 打包用。
 *
 * 图标 PNG 已交给 @resvg/resvg-js 编码，这里只服务 `package.ts` 的 ZIP 条目。
 */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
    return c
})

/** 计算 CRC32（无符号 32 位） */
export function crc32(buffer: Buffer): number {
    let crc = 0xffffffff
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!
    return (crc ^ 0xffffffff) >>> 0
}

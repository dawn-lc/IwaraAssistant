/**
 * CRC32（IEEE 802.3，反射多项式 0xEDB88320）—— 构建脚本共用。
 *
 * PNG 的每个 chunk 与 ZIP 的每个条目都要写 CRC32；两处都在 `build/` 下、
 * 都是 Node 侧代码，因此实现只保留这一份（此前 `iconRenderer.ts` 与 `package.ts`
 * 各抄了一份，算法一致但改一处漏一处就会产出坏包）。
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

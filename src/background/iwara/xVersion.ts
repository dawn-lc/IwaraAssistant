/**
 * X-Version 请求签名 —— 原 network/xVersion.ts 移植（WebCrypto，SW 可用）
 * 服务端对文件请求校验：SHA-1([文件名, expires, 密钥] 拼接串)
 */
const X_VERSION_SECRET = 'mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN'

export async function getXVersion(urlString: string): Promise<string> {
    const url = new URL(urlString)
    const data = new TextEncoder().encode([url.pathname.split('/').pop(), url.searchParams.get('expires'), X_VERSION_SECRET].join('_'))
    const hashBuffer = await crypto.subtle.digest('SHA-1', data)
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
}

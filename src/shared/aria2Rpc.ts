/**
 * aria2 JSON-RPC 的请求参数构造（WS 与 HTTP 两条传输共用）。
 *
 * ⚠️ 这里放的是踩坑点，不要内联回调用方：
 * HTTP 分支曾经自己拼过一次 `token:`，WS 分支直接发了裸 params，于是同一句
 * `aria2.getVersion` —— 走 WS 就是 `Unauthorized`，走 HTTP 就成功。旧实现恰好靠
 * 「WS 报错一律降级 HTTP」掩盖住了；一旦改成「RPC 级错误不降级」，环境自检立刻报
 * `{"code":1,"message":"Unauthorized"}`（用户实测）。
 *
 * 对真实 aria2 1.36.0 的 WS 探针实测（同一 token）：
 *   无 token => {"error":{"code":1,"message":"Unauthorized"}}
 *   带 token => {"result":{"version":"1.36.0", ...}}
 *
 * 结论：认证参数必须由**唯一一处**生成，两条传输都取这一份。`test/aria2Auth.test.ts`
 * 会把「源码里只有一处拼 token」钉住。
 */

/** 把 token 拼进 RPC 参数第 0 位（aria2 只认第 0 个参数的 `token:` 前缀） */
export function aria2AuthParams(token: string, params: unknown[]): unknown[] {
    return [`token:${token}`, ...params]
}

/**
 * 外部端点（aria2 / iwaradl / MediaCenter / 链接检查）的解析与失败文案。
 *
 * 这些用例守的是「错误必须可操作」：manifest 虽然一次性声明了 `<all_urls>`，
 * 用户仍可能在扩展管理页把站点访问收窄，此时浏览器只抛一句
 * `NetworkError when attempting to fetch resource.`（Firefox）/
 * `Failed to fetch`（Chrome）——不说哪个端点、也不说下一步做什么。
 * 而我们的反馈通道只有系统通知、任务面板一行 detail、设置页一个徽章，
 * 所以文案必须带 target + host + 恢复入口，并把引擎原文保留为证据。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ARIA2_TARGET, MEDIA_CENTER_TARGET, describeEndpointFailure, describeEndpointInvalid, parseEndpoint } from '../src/shared/endpoint'
import { setLanguage } from '../src/shared/i18n'

// 断言中文文案，显式固定语言（否则跟随运行环境的系统语言）
setLanguage('zh')

test('合法端点：http/https 绝对地址，host 与权限 pattern 一并给出', () => {
    assert.deepEqual(parseEndpoint('http://10.0.0.165:60050/jsonrpc'), {
        href: 'http://10.0.0.165:60050/jsonrpc',
        host: '10.0.0.165:60050',
        pattern: 'http://10.0.0.165:60050/*'
    })
    // 首尾空白是复制粘贴的常见残留，不该判为非法
    assert.equal(parseEndpoint('  https://nas.example.com/  ')?.pattern, 'https://nas.example.com/*')
})

test('非法端点：非 http(s)、相对地址、空值都返回 null', () => {
    for (const raw of ['', '   ', '10.0.0.165:60050', 'file:///tmp/rpc', 'ftp://host/rpc', 'ws://127.0.0.1:6800', 'not a url']) {
        assert.equal(parseEndpoint(raw), null, `应当拒绝: ${JSON.stringify(raw)}`)
    }
})

test('未授权且是网络层错误时指向具体设置页，而不是只说连不上', () => {
    const message = describeEndpointFailure(ARIA2_TARGET, 'http://10.0.0.165:60050/jsonrpc', 'NetworkError when attempting to fetch resource.', false)
    assert.match(message, /未授权/)
    assert.match(message, /aria2/)
    assert.match(message, /10\.0\.0\.165:60050/)
    assert.match(message, /设置 → RPC/)
    // 未授权时不该把「守护进程是否已启动」这条误导性提示塞给用户
    assert.doesNotMatch(message, /守护进程/)
})

test('未授权但不是网络层错误：如实给原文，不硬塞「去授权」', () => {
    const message = describeEndpointFailure(ARIA2_TARGET, 'http://10.0.0.165:60050/jsonrpc', 'unexpected token < in JSON', false)
    assert.doesNotMatch(message, /未授权/)
    assert.match(message, /unexpected token/)
})

test('已授权但连不上：保留引擎原文作为证据', () => {
    const message = describeEndpointFailure(ARIA2_TARGET, 'http://127.0.0.1:6800/jsonrpc', 'NetworkError when attempting to fetch resource.', true)
    assert.match(message, /无法连接/)
    assert.match(message, /aria2/)
    assert.match(message, /127\.0\.0\.1:6800/)
    assert.match(message, /NetworkError/)
    assert.match(message, /守护进程/)
})

test('同一套文案适用于 MediaCenter（授权入口不同）', () => {
    const message = describeEndpointFailure(MEDIA_CENTER_TARGET, 'https://nas.example.com/', 'Failed to fetch', false)
    assert.match(message, /MediaCenter/)
    assert.match(message, /nas\.example\.com/)
    assert.match(message, /设置 → 高级/)
})

test('端点地址非法时回显用户填的值（不要静默改成默认值）', () => {
    const message = describeEndpointInvalid(ARIA2_TARGET, '10.0.0.165:60050')
    assert.match(message, /地址不合法/)
    assert.match(message, /10\.0\.0\.165:60050/)
    // 运行时失败路径遇到非法地址时也不会变成「连不上」这种误导文案
    assert.equal(describeEndpointFailure(ARIA2_TARGET, '10.0.0.165:60050', 'boom', false), message)
})

test('失败文案只暴露 host，不暴露完整 URL（端点可能带 token）', () => {
    const message = describeEndpointFailure(ARIA2_TARGET, 'http://127.0.0.1:6800/jsonrpc?token=secret', 'Failed to fetch', false)
    assert.match(message, /127\.0\.0\.1:6800/)
    assert.doesNotMatch(message, /secret/)
})

/**
 * 实测 Firefox 158：扩展页 fetch 内网 http 端点只有 NetworkError，回环与 Chrome 都正常。
 * 根因是 Firefox 的本地网络访问（LNA）策略，不是主页权限——文案必须区分「浏览器拦了」
 * 与「守护进程没起来」，后者会把人引去重启一个好好的服务。
 *
 * 但这套「浏览器拦了」的提示**只对 MV3 成立**：实测 MV2 下 fetch / XHR / ws 打局域网均成功，
 * 所以判据必须看 manifest 版本，否则将来出 MV2 变体会误报。
 */
const withFirefoxManifest = (manifestVersion: number | undefined, run: () => void) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const userAgentDescriptor = navigatorDescriptor?.value === undefined ? undefined : Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent')
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0',
        configurable: true
    })
    const store = globalThis as unknown as { browser?: unknown }
    const previousBrowser = store.browser
    if (manifestVersion !== undefined) {
        store.browser = { runtime: { getManifest: () => ({ manifest_version: manifestVersion }) } }
    }
    try {
        run()
    } finally {
        if (userAgentDescriptor === undefined) delete (globalThis.navigator as { userAgent?: string }).userAgent
        else Object.defineProperty(globalThis.navigator, 'userAgent', userAgentDescriptor)
        if (previousBrowser === undefined) delete store.browser
        else store.browser = previousBrowser
    }
}

test('Firefox + MV3 + 内网 http 端点：指出浏览器拦截，不说「守护进程没起」', () => {
    withFirefoxManifest(3, () => {
        const message = describeEndpointFailure(ARIA2_TARGET, 'http://10.0.0.165:60050/jsonrpc', 'NetworkError when attempting to fetch resource.', true)
        assert.match(message, /Firefox/)
        assert.match(message, /10\.0\.0\.165:60050/)
        assert.doesNotMatch(message, /守护进程/)
        // 已授权（contains 为 true）时不能又说「未授权」——这是主页权限之外的另一套策略
        assert.doesNotMatch(message, /未授权/)
        assert.match(message, /不是权限问题/)
        assert.match(message, /https/)

        // 回环是例外：仍然是「守护进程/端口」这套排查
        const loopback = describeEndpointFailure(ARIA2_TARGET, 'http://127.0.0.1:6800/jsonrpc', 'NetworkError when attempting to fetch resource.', true)
        assert.match(loopback, /守护进程/)
        assert.doesNotMatch(loopback, /Firefox/)
    })
})

test('Firefox + MV2：局域网 http 本来就能通，失败说明是守护进程/端口问题', () => {
    withFirefoxManifest(2, () => {
        const message = describeEndpointFailure(ARIA2_TARGET, 'http://10.0.0.165:60050/jsonrpc', 'NetworkError when attempting to fetch resource.', true)
        assert.match(message, /守护进程/)
        assert.doesNotMatch(message, /Firefox/)
        assert.doesNotMatch(message, /不是权限问题/)
    })
})

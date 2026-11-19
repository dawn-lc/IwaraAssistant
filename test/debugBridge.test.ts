import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bridgeEndpoint, commandNeedsTaskId, countTaskStatus, DEBUG_BRIDGE_COMMANDS, maskSecrets, parseBridgeCommands } from '../src/shared/debugBridge'
import { configSchema } from '../src/shared/configSchema'
import { readSource } from './sourceGuard'

test('脱敏：凭据字段一律变 ***，其余原样', () => {
    const masked = maskSecrets({ aria2Token: 'abc', iwaradlToken: '', downloadProxyPassword: 'p', aria2Path: 'http://x', nested: { aria2Token: 'zzz' } })
    assert.equal(masked.aria2Token, '***')
    assert.equal(masked.iwaradlToken, '', '空的不用脱敏（否则看不出「没配」）')
    assert.equal(masked.downloadProxyPassword, '***')
    assert.equal(masked.aria2Path, 'http://x')
    assert.deepEqual(masked.nested, { aria2Token: '***' }, '嵌套也要脱')
})

test('脱敏：cookie / secret / authorization 也被认出来（宁可多脱）', () => {
    const masked = maskSecrets({ iwaraCookie: 'c', clientSecret: 's', Authorization: 'a', userAgent: 'ua' })
    assert.equal(masked.iwaraCookie, '***')
    assert.equal(masked.clientSecret, '***')
    assert.equal(masked.Authorization, '***')
    assert.equal(masked.userAgent, 'ua')
})

test('计数：按状态累加', () => {
    const tasks = [{ status: 'running' }, { status: 'running' }, { status: 'failed' }, { status: 'complete' }] as never
    assert.deepEqual(countTaskStatus(tasks), { running: 2, failed: 1, complete: 1 })
})

test('命令解析：白名单外的命令一律丢弃（本机端口也可能被别人占）', () => {
    const { accepted, rejected } = parseBridgeCommands([{ id: 'c1', command: 'scan' }, { id: 'c2', command: 'retry', taskId: 't1' }, { id: 'c3', command: 'eval', code: 'fetch(...)' }, { id: 'c4', command: 'setConfig' }, { command: 'logs' }, { id: 'c5' }, 'not-an-object', null])
    assert.deepEqual(accepted, [
        { id: 'c1', command: 'scan' },
        { id: 'c2', command: 'retry', taskId: 't1' }
    ])
    // 没有 id 就无法把回执对回去 → 连命令名一起记进「被拒绝」，方便在日志里追
    assert.deepEqual(rejected, ['eval', 'setConfig', 'logs', '<no-command>'])
})

test('命令解析：非数组输入不会抛（服务端返回畸形也算正常情况）', () => {
    assert.deepEqual(parseBridgeCommands(undefined), { accepted: [], rejected: [] })
    assert.deepEqual(parseBridgeCommands({ commands: [{ id: 'c1', command: 'scan' }] }), { accepted: [], rejected: [] })
})

test('需要 taskId 的命令只有那三个', () => {
    assert.equal(commandNeedsTaskId('retry'), true)
    assert.equal(commandNeedsTaskId('rebuild'), true)
    assert.equal(commandNeedsTaskId('remove'), true)
    assert.equal(commandNeedsTaskId('scan'), false)
    assert.equal(commandNeedsTaskId('snapshot'), false)
})

test('端点只连回环地址，不接受任意 URL', () => {
    assert.equal(bridgeEndpoint(8765), 'http://127.0.0.1:8765/poll')
    assert.equal(bridgeEndpoint(Number.NaN), 'http://127.0.0.1:0/poll')
    for (const name of DEBUG_BRIDGE_COMMANDS) assert.match(name, /^[a-z]+$/)
})

test('配置：调试通道默认关闭，端口默认 8765', () => {
    const parsed = configSchema.parse({})
    assert.equal(parsed.debugBridgeEnabled, false, '默认开＝未经用户同意就往外发调试数据')
    assert.equal(parsed.debugBridgePort, 8765)
    assert.throws(() => configSchema.parse({ debugBridgePort: 80 }), '低端口不该被接受')
})

test('接线：boot 要启动调试通道，且扩展侧只长轮询 /poll', () => {
    const index = readSource('src/background/index.ts')
    assert.match(index, /import \{ startDebugBridge, watchDebugBridgeConfig \} from '\.\/runtime\/debugBridge'/, '调试通道必须由 boot 拉起（否则用户开了也不会连）')
    assert.match(index, /startDebugBridge\(\)/, 'boot 里要调用')
    const bridge = readSource('src/background/runtime/debugBridge.ts')
    assert.match(bridge, /bridgeEndpoint\(port\)/)
    assert.match(bridge, /parseBridgeCommands\(payload\.commands\)/, '命令必须过白名单')
    assert.match(bridge, /maskSecrets\(getConfig\(\)/, '出站配置必须脱敏')
    assert.match(bridge, /config\.debugBridgeEnabled !== true/, '关闭状态下不许起循环')
    assert.match(index, /watchDebugBridgeConfig\(\)/, '打开开关要立刻生效，不等浏览器重启')
    assert.match(bridge, /changes\[CONFIG_KEY\]\?\.newValue/, '必须读 newValue：configStore 的内存副本是异步更新的')
    assert.match(bridge, /if \(next\.debugBridgeEnabled !== true\) \{/, '关掉开关要停循环')
})

test('接线：调试服务只绑回环地址，且没有任何监听外部端口的代码', () => {
    const server = readFileSync('scripts/debug-bridge-server.mjs', 'utf8')
    assert.match(server, /server\.listen\(port, '127\.0\.0\.1'/, '调试服务不能绑 0.0.0.0')
    assert.doesNotMatch(server, /0\.0\.0\.0/, '不绑所有网卡')
    assert.match(server, /\/poll/, '扩展侧靠它对接')
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ARIA2_BOUNDED_MAX_TRIES, ARIA2_GLOBAL_OPTIONS_DEFAULT, aria2ProxyParams, aria2RetryParams, aria2StoppedQueryLimit, aria2TuningParams, parseAria2GlobalOptions, shouldBoundAria2Retries } from '../src/shared/aria2Options'
import { parseAria2Capabilities } from '../src/shared/aria2Flavor'

// 真机抓下来的 getGlobalOption 片段（本机 aria2-next 3.1.1 与远程上游 1.36.0）
const LOCAL_NEXT = { 'max-tries': '0', 'retry-wait': '10', 'max-concurrent-downloads': '5', 'max-connection-per-server': '16', split: '8', 'min-split-size': '1048576', 'max-download-result': '1000', continue: 'true', 'allow-overwrite': 'false', 'auto-file-renaming': 'false', 'all-proxy': '', dir: 'C:\\Users\\x\\Downloads' }
const REMOTE_UPSTREAM = { 'max-tries': '0', 'retry-wait': '10', 'max-connection-per-server': '16', split: '16', 'min-split-size': '1048576', continue: 'true', 'allow-overwrite': 'true', 'auto-file-renaming': 'false', dir: '/downloads' }

test('解析真实配置：字符串一律转成数字/布尔，缺字段用上游默认值', () => {
    const local = parseAria2GlobalOptions(LOCAL_NEXT)
    assert.equal(local.maxTries, 0)
    assert.equal(local.retryWait, 10)
    assert.equal(local.maxConnectionPerServer, 16)
    assert.equal(local.split, 8)
    assert.equal(local.minSplitSize, 1048576)
    assert.equal(local.continueEnabled, true)
    assert.equal(local.autoFileRenaming, false)
    assert.equal(local.allProxy, '')
    const remote = parseAria2GlobalOptions(REMOTE_UPSTREAM)
    assert.equal(remote.split, 16)
    assert.equal(remote.allowOverwrite, true)
    assert.equal(remote.maxDownloadResult, ARIA2_GLOBAL_OPTIONS_DEFAULT.maxDownloadResult, '没配就按默认 1000')
    assert.equal(parseAria2GlobalOptions(undefined), ARIA2_GLOBAL_OPTIONS_DEFAULT, '探测不到就按上游默认')
    assert.deepEqual(parseAria2GlobalOptions({}), ARIA2_GLOBAL_OPTIONS_DEFAULT)
})

test('解析脏值不抛，回落默认', () => {
    const dirty = parseAria2GlobalOptions({ 'max-tries': 'abc', 'retry-wait': '-3', 'max-download-result': '', continue: 'yes', 'all-proxy': undefined as unknown as string })
    assert.equal(dirty.maxTries, ARIA2_GLOBAL_OPTIONS_DEFAULT.maxTries)
    assert.equal(dirty.retryWait, ARIA2_GLOBAL_OPTIONS_DEFAULT.retryWait)
    assert.equal(dirty.maxDownloadResult, ARIA2_GLOBAL_OPTIONS_DEFAULT.maxDownloadResult)
    assert.equal(dirty.continueEnabled, ARIA2_GLOBAL_OPTIONS_DEFAULT.continueEnabled)
    assert.equal(dirty.allProxy, '')
})

test('只有「403 会卡死的分支」+「服务端无限重试」才补 max-tries', () => {
    const next3 = parseAria2Capabilities({ version: '3.1.1', product: 'aria2-next', enabledFeatures: ['ED2K', 'HLS/DASH'] })
    const upstream = parseAria2Capabilities({ version: '1.36.0', enabledFeatures: ['BitTorrent'] })
    const infinite = parseAria2GlobalOptions({ 'max-tries': '0' })
    const bounded = parseAria2GlobalOptions({ 'max-tries': '5' })
    assert.equal(shouldBoundAria2Retries(next3, infinite), true)
    assert.equal(shouldBoundAria2Retries(next3, bounded), false, '用户自己设了上限就不该被覆盖')
    assert.equal(shouldBoundAria2Retries(upstream, infinite), false, '上游会正常报错，不需要补')
    assert.equal(shouldBoundAria2Retries(undefined, infinite), false, '探测不到按上游处理')
    assert.deepEqual(aria2RetryParams(next3, infinite), { 'max-tries': String(ARIA2_BOUNDED_MAX_TRIES) })
    assert.deepEqual(aria2RetryParams(next3, bounded), {})
})

test('没配代理时一个键都不给（传空串会废掉 aria2.conf 里的代理，真机实测）', () => {
    assert.deepEqual(aria2ProxyParams(''), {}, '空串必须转成「不传」，不是「传空」')
    assert.deepEqual(aria2ProxyParams('   '), {})
    assert.deepEqual(aria2ProxyParams('http://127.0.0.1:7890'), { 'all-proxy': 'http://127.0.0.1:7890' })
    assert.deepEqual(aria2ProxyParams('http://127.0.0.1:7890', 'u', 'p'), { 'all-proxy': 'http://127.0.0.1:7890', 'all-proxy-user': 'u', 'all-proxy-passwd': 'p' })
    assert.deepEqual(aria2ProxyParams('http://127.0.0.1:7890', '', ''), { 'all-proxy': 'http://127.0.0.1:7890' }, '空账号密码不该出现')
})

test('tellStopped 条数按服务端窗口自适应', () => {
    assert.equal(aria2StoppedQueryLimit(parseAria2GlobalOptions({ 'max-download-result': '1000' })), 1000)
    assert.equal(aria2StoppedQueryLimit(parseAria2GlobalOptions({ 'max-download-result': '0' })), 4096, '不限就由我们封顶')
    assert.equal(aria2StoppedQueryLimit(parseAria2GlobalOptions({ 'max-download-result': '100000' })), 4096, '超过上限时仍按 4096 封顶')
    assert.equal(aria2StoppedQueryLimit(undefined), 1000)
})

test('接线：投递参数必须走自适应入口，不许再直接塞配置', () => {
    const downloaders = readFileSync('src/background/download/downloaders.ts', 'utf8')
    assert.match(downloaders, /aria2RetryParams\(caps, options\)/)
    assert.match(downloaders, /aria2ProxyParams\(config\.downloadProxy/, '代理必须走 aria2ProxyParams（空值省略）')
    assert.doesNotMatch(downloaders, /'all-proxy': config\.downloadProxy/, '直接传配置会在没配代理时传空串，静默废掉服务端代理')
    const tracker = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    assert.match(tracker, /aria2StoppedQueryLimit\(await aria2GlobalOptions\(\)\)/, '结果窗口要按服务端配置取')
})

test('连接参数：上游默认值下必须显式抬高，用户配得更高则不覆盖', () => {
    const tuning = aria2TuningParams(parseAria2GlobalOptions({}), { maxConnections: 4, split: 4 })
    assert.equal(tuning['max-connection-per-server'], '4', '上游默认 -x=1：不补就是单连接')
    assert.equal(tuning.split, undefined, '上游 split 默认 5 ≥ 4，不需要覆盖（只上不下）')
    assert.equal(tuning['min-split-size'], '1M', '默认 20M 时小于 40M 的文件即使设了 4 连接也只有一条在干活')
    assert.equal(tuning['retry-wait'], '5', 'retry-wait=0 时 502/503 不会被重试')
    const tuned = parseAria2GlobalOptions({ 'max-connection-per-server': '16', split: '16', 'min-split-size': '1048576', 'retry-wait': '10' })
    assert.deepEqual(aria2TuningParams(tuned, { maxConnections: 4, split: 4 }), {}, '用户自己在 conf 里配得更高就尊重他')
    // 越界夹回 1..16；split 想设 1（= 不分段）时服务端本来就有 5，不需要也没理由覆盖
    assert.deepEqual(aria2TuningParams(undefined, { maxConnections: 99, split: 0 }), { 'max-connection-per-server': '16', 'min-split-size': '1M', 'retry-wait': '5' })
})

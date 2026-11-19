import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ARIA2_CAPABILITIES_UPSTREAM, aria2StatusFieldsWith, parseAria2Capabilities, refineAria2Capabilities } from '../src/shared/aria2Flavor'
import { aria2Progress, aria2ProgressOf } from '../src/shared/aria2Recover'

// ── 三台真机抓下来的原始 getVersion 结果（2026-11-18 / 11-19）────────

const UPSTREAM_1360 = {
    version: '1.36.0',
    enabledFeatures: ['Async DNS', 'BitTorrent', 'Firefox3 Cookie', 'GZip', 'HTTPS', 'Message Digest', 'Metalink', 'XML-RPC', 'SFTP']
}

const NEXT_249 = {
    version: '2.4.9',
    enabledFeatures: ['Async DNS', 'BitTorrent', 'ED2K', 'Firefox3 Cookie', 'GZip', 'HTTPS', 'Message Digest', 'Metalink', 'XML-RPC', 'SFTP']
}

const NEXT_311 = {
    version: '3.1.1',
    product: 'aria2-next',
    rpcVersion: '1.1.0',
    enabledFeatures: ['BitTorrent', 'ED2K', 'GZip', 'HTTPS', 'HLS/DASH', 'Message Digest', 'Metalink', 'SFTP'],
    mediaFeatures: ['request-contexts', 'stable-track-ids', 'structured-errors', 'captured-inputs'],
    downloadFeatures: ['filename-hints', 'filename-resolution']
}

test('上游 1.36.0：不认识任何分支特性，且不许按版本号误判', () => {
    const caps = parseAria2Capabilities(UPSTREAM_1360)
    assert.equal(caps.flavor, 'aria2')
    assert.equal(caps.major, 1)
    assert.equal(caps.selfIdentifying, false, '上游没有 product 字段')
    assert.equal(caps.probe, false)
    assert.equal(caps.moveDownload, false)
    assert.equal(caps.media, false)
    assert.equal(caps.stallsOnForbidden, false)
})

test('aria2-next 2.4.9：没有 product，只能靠 ED2K 认出来；但 3.x 的能力它一个都没有', () => {
    const caps = parseAria2Capabilities(NEXT_249)
    assert.equal(caps.flavor, 'aria2-next', '2.4.9 没有 product，不靠 ED2K 就会误判成上游')
    assert.equal(caps.major, 2)
    assert.equal(caps.selfIdentifying, false, '2.4.9 确实没有 product 字段')
    assert.equal(caps.probe, false, '实测 2.4.9 没有 aria2.probe')
    assert.equal(caps.moveDownload, false)
    assert.equal(caps.media, false)
    assert.equal(caps.stallsOnForbidden, false, '实测 2.4.9 的 403 会正常报 error 22')
})

test('aria2-next 3.1.1：自报身份，probe/moveDownload/媒体/403 停滞全部成立', () => {
    const caps = parseAria2Capabilities(NEXT_311)
    assert.equal(caps.flavor, 'aria2-next')
    assert.equal(caps.major, 3)
    assert.equal(caps.selfIdentifying, true)
    assert.equal(caps.probe, true)
    assert.equal(caps.moveDownload, true)
    assert.equal(caps.media, true)
    assert.equal(caps.stallsOnForbidden, true, '实测 403 永远停在 active，必须靠 max-tries 逼出错误')
})

test('探测不到就按上游处理（认错方向代价不对称）', () => {
    assert.deepEqual(parseAria2Capabilities(undefined), ARIA2_CAPABILITIES_UPSTREAM)
    assert.deepEqual(parseAria2Capabilities({}), ARIA2_CAPABILITIES_UPSTREAM)
    const garbage = parseAria2Capabilities({ version: 'not-a-version', enabledFeatures: [] })
    assert.equal(garbage.flavor, 'aria2')
    assert.equal(garbage.major, 0)
    assert.equal(garbage.stallsOnForbidden, false)
})

test('方法表是事实：拿得到就以它为准', () => {
    const caps = parseAria2Capabilities(NEXT_249)
    assert.equal(caps.probe, false)
    const refined = refineAria2Capabilities(caps, ['aria2.probe', 'aria2.moveDownload', 'aria2.tellActive'])
    assert.equal(refined.probe, true)
    assert.equal(refined.moveDownload, true)
    const stripped = refineAria2Capabilities(parseAria2Capabilities(NEXT_311), ['aria2.tellActive'])
    assert.equal(stripped.probe, false, '自称 3.x 但方法表里没有 probe，就不该用')
    assert.deepEqual(refineAria2Capabilities(caps, []), caps, '空方法表不该把能力清零')
})

test('媒体分支才请求 media 字段，且不重复', () => {
    const base = ['gid', 'status', 'totalLength']
    assert.deepEqual(aria2StatusFieldsWith(base, parseAria2Capabilities(UPSTREAM_1360)), base)
    assert.deepEqual(aria2StatusFieldsWith(base, parseAria2Capabilities(NEXT_249)), base)
    assert.deepEqual(aria2StatusFieldsWith(base, parseAria2Capabilities(NEXT_311)), [...base, 'media'])
    assert.deepEqual(aria2StatusFieldsWith([...base, 'media'], parseAria2Capabilities(NEXT_311)), [...base, 'media'])
    assert.deepEqual(aria2StatusFieldsWith(base, undefined), base, '没探测过就按上游')
})

test('媒体任务的进度只能从 media.progress 读（totalLength 恒 0）', () => {
    const media = { totalLength: '0', completedLength: '1048576', media: { progress: '0.42' } }
    assert.equal(aria2Progress(media), 0, '旧算法在媒体任务上恒 0——这就是进度条永远不动的根因')
    assert.equal(aria2ProgressOf(media), 0.42)
    assert.equal(aria2ProgressOf({ totalLength: '0', completedLength: '0', media: { progress: '1.000000' } }), 1)
    assert.equal(aria2ProgressOf({ totalLength: '0', completedLength: '0' }), 0, '拿不到就不猜')
    assert.equal(aria2ProgressOf({ totalLength: '0', completedLength: '0', media: { progress: '7' } }), 1, '超界钳位')
})

test('非媒体任务：aria2ProgressOf 与旧算法的结果必须完全一致', () => {
    for (const status of [
        { totalLength: '1000', completedLength: '250' },
        { totalLength: '1000', completedLength: '0' },
        { totalLength: '', completedLength: '5' },
        { totalLength: '0', completedLength: '5' }
    ]) {
        assert.equal(aria2ProgressOf(status), aria2Progress(status), JSON.stringify(status))
    }
})

test('接线：字段集与进度都必须走分支感知的入口', () => {
    const tracker = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    assert.match(tracker, /aria2StatusFieldsWith\(PROGRESS_FIELDS/, '扫描与探测都要按分支能力取字段')
    assert.doesNotMatch(tracker, /aria2Progress\(status\)/, '进度必须走 aria2ProgressOf，否则媒体任务恒 0%')
    const downloaders = readFileSync('src/background/download/downloaders.ts', 'utf8')
    assert.match(downloaders, /caps\?\.stallsOnForbidden \? \{ 'max-tries': '5' \}/, '只有 403 会卡死的分支才加 max-tries')
    assert.match(downloaders, /aria2AddUriParams\(localPath, cookie, await aria2Capabilities\(\)\)/, '投递时必须先探测分支')
})

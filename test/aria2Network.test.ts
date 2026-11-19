/**
 * 网络层失败的分类与退避（`shared/aria2Network.ts`）。
 *
 * 这组判据决定「重解析到底有没有用」——判错的方向不对称：
 * 把网络问题当链接过期 ⇒ 每轮扫描都去解析一次、重建一次任务，出口坏掉时等于自残；
 * 把链接过期当网络问题 ⇒ 任务永远等下去，而重解析明明能立刻救回来。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { NETWORK_BACKOFF_BASE_MS, NETWORK_BACKOFF_CAP_MS, NETWORK_BREAKER_COOLDOWN_MS, NETWORK_BREAKER_MIN_TASKS, NETWORK_BREAKER_WINDOW_MS, classifyAria2Failure, isNetworkFetchError, networkBackoffDue, networkBackoffRemaining, nextNetworkBackoff, shouldOpenNetworkBreaker } from '../src/shared/aria2Network'

test('分类：文件冲突与永久失败先分走（重试一定再撞）', () => {
    assert.equal(classifyAria2Failure('13', 'File already exists'), 'file-conflict')
    assert.equal(classifyAria2Failure('11', 'Duplicate download'), 'file-conflict')
    // 8 = 本地文件比远端大（真机：218 480 256 B 的旧文件 vs 更短的远端）。它不是 permanent：
    // 重建没用，但带覆盖参数重投一次就能好 → 归 file-conflict 才能拿到「强制覆盖」这条出路。
    assert.equal(classifyAria2Failure('8', '/downloads/a.mp4 is larger than the remote file'), 'file-conflict')
    assert.equal(classifyAria2Failure('9', 'Not enough disk space'), 'permanent')
    assert.equal(classifyAria2Failure('17', 'File I/O error'), 'permanent')
})

test('分类：网络层错误码单独一档（不该重解析）', () => {
    assert.equal(classifyAria2Failure('6', 'Network problem'), 'network')
    assert.equal(classifyAria2Failure('19', 'Name resolution failed'), 'network')
    assert.equal(classifyAria2Failure('2', 'Timeout'), 'network')
    assert.equal(classifyAria2Failure('23', 'Too many redirects'), 'network')
    assert.equal(classifyAria2Failure('1', 'Connection reset by peer'), 'network')
})

test('分类：422 必须看 status —— 同一个错误码下 403 与 503 是两件事', () => {
    assert.equal(classifyAria2Failure('22', 'The response status is not successful. status=403'), 'expired')
    assert.equal(classifyAria2Failure('22', 'status=404'), 'expired')
    assert.equal(classifyAria2Failure('22', 'status=503'), 'transient')
    assert.equal(classifyAria2Failure('22', 'status=502'), 'transient')
    assert.equal(classifyAria2Failure('22', 'no status here'), 'expired', '拿不到状态码按链接问题处理（重解析无害）')
    assert.equal(classifyAria2Failure('4', 'Not found'), 'expired')
    assert.equal(classifyAria2Failure(undefined, undefined), 'unknown')
    assert.equal(classifyAria2Failure('1', 'something odd'), 'unknown')
})

test('浏览器 fetch 异常：只认传输层，不认 HTTP 状态', () => {
    assert.equal(isNetworkFetchError(new TypeError('Failed to fetch')), true)
    assert.equal(isNetworkFetchError(new TypeError('NetworkError when attempting to fetch resource.')), true)
    assert.equal(isNetworkFetchError(new TypeError('Load failed')), true)
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    assert.equal(isNetworkFetchError(abort), true, '我们自己的超时也算网络层')
    assert.equal(isNetworkFetchError(new Error('HTTP 500')), false)
    assert.equal(isNetworkFetchError(new SyntaxError('bad json')), false)
    assert.equal(isNetworkFetchError(undefined), false)
})

test('退避：1 分钟起翻倍，封顶 30 分钟', () => {
    let state = nextNetworkBackoff(undefined, 1_000_000)
    assert.equal(state.count, 1)
    assert.equal(state.nextAt - state.lastAt, NETWORK_BACKOFF_BASE_MS)
    state = nextNetworkBackoff(state, 1_100_000)
    assert.equal(state.nextAt - state.lastAt, NETWORK_BACKOFF_BASE_MS * 2)
    for (let index = 0; index < 10; index += 1) state = nextNetworkBackoff(state, 1_200_000)
    assert.equal(state.nextAt - state.lastAt, NETWORK_BACKOFF_CAP_MS, '再多次也不超过 30 分钟')
})

test('退避：到期才允许重试，且能算出还剩多久', () => {
    const state = nextNetworkBackoff(undefined, 1_000_000)
    assert.equal(networkBackoffDue(undefined, 1), true, '没有记录就该试')
    assert.equal(networkBackoffDue(state, 1_000_000 + 1), false)
    assert.equal(networkBackoffDue(state, state.nextAt), true)
    assert.equal(networkBackoffRemaining(state, 1_000_000), NETWORK_BACKOFF_BASE_MS)
    assert.equal(networkBackoffRemaining(state, state.nextAt + 5), 0)
})

test('熔断：短时间内成片网络失败才触发（单个任务失败不该拉闸）', () => {
    const now = 5_000_000
    const make = (count: number, lastAt: number) => ({ count, lastAt, nextAt: lastAt + 60_000 })
    assert.equal(shouldOpenNetworkBreaker({ a: make(1, now), b: make(1, now) }, now), false)
    assert.equal(shouldOpenNetworkBreaker({ a: make(1, now), b: make(1, now), c: make(1, now) }, now), true)
    assert.equal(shouldOpenNetworkBreaker({ a: make(1, now - NETWORK_BREAKER_WINDOW_MS - 1), b: make(1, now), c: make(1, now) }, now), false, '窗口外的失败不算')
    assert.equal(NETWORK_BREAKER_MIN_TASKS, 3)
    assert.ok(NETWORK_BREAKER_COOLDOWN_MS > 0)
})

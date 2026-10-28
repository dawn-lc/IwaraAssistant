/**
 * 批量下载去重规则（`shared/downloadDedupe.ts`）。
 *
 * 这些判据都是**会静默吞掉用户下载意图**的决策：判错的方向是「该下的没下」，
 * 用户看不到任何报错，只会以为扩展坏了。所以每条规则单独钉一个用例。
 *
 * 除了纯函数，还带两条**源码级守卫**：它们钉的不是算法而是「接线」。
 * 纯函数写得再对，没被调用点调用就等于没有——单条入口曾经就完全没接去重，
 * 而这种缺失不会有任何类型错误。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { blockingTaskFor, dedupeAgainstAria2, dedupeAgainstQueue, planQueueLiveDuplicates, reusableFailedTaskFor } from '../src/shared/downloadDedupe'
import type { QueueTask } from '../src/shared/task'

function task(videoId: string, status: QueueTask['status'], updatedAt?: number): QueueTask {
    return {
        id: `task-${videoId}-${status}`,
        videoId,
        kind: 'aria2',
        status,
        ...(updatedAt === undefined ? {} : { updatedAt })
    }
}

test('本地队列：已完成的跳过（重新勾选最近下载过的不会重复投递）', () => {
    const result = dedupeAgainstQueue(['a', 'b', 'c'], [task('a', 'complete'), task('b', 'running')])
    assert.deepEqual(result.ids, ['c'])
    assert.deepEqual(result.skipped, ['a', 'b'])
})

test('本地队列：排队中/进行中也跳过（同一视频不并行下两份）', () => {
    const result = dedupeAgainstQueue(['a', 'b'], [task('a', 'queued'), task('b', 'running')])
    assert.deepEqual(result.ids, [])
    assert.deepEqual(result.skipped, ['a', 'b'])
})

test('本地队列：失败的不跳过（用户重新勾选就是想再试一次）', () => {
    const result = dedupeAgainstQueue(['a'], [task('a', 'failed')])
    assert.deepEqual(result.ids, ['a'])
    assert.deepEqual(result.skipped, [])
})

test('本地队列：以最新一条记录为准（失败过、后来重试成功 → 跳过）', () => {
    const result = dedupeAgainstQueue(['a'], [task('a', 'failed', 1000), task('a', 'complete', 2000)])
    assert.deepEqual(result.skipped, ['a'])
})

test('本地队列：最新一条是失败时允许重下（成功过、后来重试失败 → 不跳过）', () => {
    const result = dedupeAgainstQueue(['a'], [task('a', 'complete', 1000), task('a', 'failed', 2000)])
    assert.deepEqual(result.ids, ['a'])
})

test('本地队列：没有时间戳的旧记录不会盖掉带时间戳的新记录', () => {
    const result = dedupeAgainstQueue(['a'], [task('a', 'complete', 2000), task('a', 'failed')])
    assert.deepEqual(result.skipped, ['a'])
})

test('本地队列：保持入参顺序（入队节流按这个顺序跑，顺序变了用户看到的完成次序会乱）', () => {
    const result = dedupeAgainstQueue(['c', 'a', 'b'], [])
    assert.deepEqual(result.ids, ['c', 'a', 'b'])
})

test('本地队列：队列里有别的视频不影响本次（不是「队列非空就全跳过」）', () => {
    const result = dedupeAgainstQueue(['x'], [task('a', 'complete'), task('b', 'complete')])
    assert.deepEqual(result.ids, ['x'])
})

test('aria2：已存在（活跃/等待/已完成）的跳过', () => {
    const result = dedupeAgainstAria2(['a', 'b', 'c'], new Set(['a', 'c']))
    assert.deepEqual(result.ids, ['b'])
    assert.deepEqual(result.skipped, ['a', 'c'])
})

test('本地队列：跳过（第三方网盘链接）的不算已下载，必须允许重新投递', () => {
    // 「跳过」是「上次没下」，不是「下过了」。把它当已完成会静默吞掉用户的下载意图：
    // 用户在列表页重新勾选它、什么都没发生，也无任何提示。
    const result = dedupeAgainstQueue(['a'], [task('a', 'skipped')])
    assert.deepEqual(result.ids, ['a'])
    assert.deepEqual(result.skipped, [])
})

test('本地队列：已交付（外部下载器/iwaradl）不拦重新投递 —— 我们并不知道对方成没成', () => {
    // 拦下来等于替外部下载器宣布成功：用户再勾一次、什么都没发生、也没有任何提示。
    const result = dedupeAgainstQueue(['a'], [task('a', 'handed-off')])
    assert.deepEqual(result.ids, ['a'])
    assert.deepEqual(result.skipped, [])
})

test('aria2：集合为空时原样返回（aria2 里确实没有这些任务）', () => {
    const result = dedupeAgainstAria2(['a', 'b'], new Set())
    assert.deepEqual(result.ids, ['a', 'b'])
    assert.deepEqual(result.skipped, [])
})

// ── 单条下载（`blockingTaskFor`）──────────────────────────────────────
// 此前单条入口（页内「下载此视频」/ 右键菜单 / DOWNLOAD）**完全不去重**，
// 只有一层「同一时刻正在投递」的进程内闸门，拦不住「投递完成后再点一次」。
// 判定必须与批量同源，否则两个入口会在边界状态上给出不同结果。

test('单条下载：已完成的任务应当被拦住，并返回那条记录（而不是新建一条）', () => {
    const existing = task('a', 'complete')
    const blocking = blockingTaskFor('a', [existing])
    assert.equal(blocking?.id, existing.id)
})

test('单条下载：进行中 / 排队中同样拦住', () => {
    for (const status of ['running', 'queued'] as const) {
        assert.equal(blockingTaskFor('a', [task('a', status)])?.status, status)
    }
})

test('单条下载：失败 / 跳过 / 已交付不拦（与批量的判据完全一致）', () => {
    for (const status of ['failed', 'skipped', 'handed-off'] as const) {
        assert.equal(blockingTaskFor('a', [task('a', status)]), undefined, status)
    }
})

test('单条下载：以最新一条记录为准（成功过、后来重试失败 → 允许重下）', () => {
    assert.equal(blockingTaskFor('a', [task('a', 'complete', 1000), task('a', 'failed', 2000)]), undefined)
    assert.equal(blockingTaskFor('a', [task('a', 'failed', 1000), task('a', 'complete', 2000)])?.status, 'complete')
})

test('单条下载：队列里没有该视频时不拦', () => {
    assert.equal(blockingTaskFor('a', [task('b', 'complete')]), undefined)
    assert.equal(blockingTaskFor('a', []), undefined)
})

// ── 失败记录复用（`reusableFailedTaskFor`）─────────────────────────────
// 「允许重下」不等于「每次重下都新建一行」。不复用会让同一个 videoId 在任务列表里
// 堆出多条失败记录——用户看到的就是「去重没生效」。

test('失败记录复用：同一视频失败过 → 返回那条记录', () => {
    const failed = task('a', 'failed')
    assert.equal(reusableFailedTaskFor('a', [failed])?.id, failed.id)
})

test('失败记录复用：最新一条是 complete / running / queued 时不复用（那不是重试）', () => {
    for (const status of ['complete', 'running', 'queued'] as const) {
        assert.equal(reusableFailedTaskFor('a', [task('a', status)]), undefined, status)
    }
})

test('失败记录复用：skipped / handed-off 不能当成失败下载记录改写', () => {
    for (const status of ['skipped', 'handed-off'] as const) {
        assert.equal(reusableFailedTaskFor('a', [task('a', status)]), undefined, status)
    }
})

test('失败记录复用：多条失败记录取最新一条（旧行保留，不在这里清理历史）', () => {
    const older = task('a', 'failed', 1000)
    const newer = task('a', 'failed', 2000)
    assert.equal(reusableFailedTaskFor('a', [older, newer])?.id, newer.id)
})

test('失败记录复用：没有记录 / 别的视频 → undefined', () => {
    assert.equal(reusableFailedTaskFor('a', []), undefined)
    assert.equal(reusableFailedTaskFor('a', [task('b', 'failed')]), undefined)
})

// ── 源码级接线守卫（缺失不会有任何类型错误）──────────────────────────

test('接线：单条下载入口（runDownloadInner）必须调用 blockingTaskFor', () => {
    const source = readFileSync('src/background/download/dispatch.ts', 'utf8')
    assert.match(source, /blockingTaskFor\(payload\.videoId, getTasks\(\)\)/, '单条下载必须做队列去重；删掉这行会让重复点击在 aria2 里堆两份')
    // 去重要在解析之前：命中去重时不该再打一次「详情 + 文件源 + N 页评论」
    const dedupeIndex = source.indexOf('blockingTaskFor(payload.videoId, getTasks())')
    const parseIndex = source.indexOf('await resolveVideo(payload)')
    assert.ok(dedupeIndex > 0 && parseIndex > 0, '两个锚点都应存在')
    assert.ok(dedupeIndex < parseIndex, '去重必须排在解析之前（否则重复投递仍然要付一次完整解析）')
})

test('接线：FORCE_DOWNLOAD 必须绕过队列去重（用户明确的「我就是要下」）', () => {
    const source = readFileSync('src/background/index.ts', 'utf8')
    const line = source.split('\n').find((row) => row.includes('skipLinkCheck: true'))
    assert.ok(line !== undefined, 'FORCE_DOWNLOAD 的分派行应存在')
    assert.match(line, /skipDedupe: true/, '强制下载被自动判据拦住就变成「点了没反应」')
})

test('接线：强制下载必须先结掉同视频的 skipped 待办（解析失败也不该留两行待办）', () => {
    const source = readFileSync('src/background/download/dispatch.ts', 'utf8')
    const settle = source.indexOf('if (payload.skipLinkCheck === true) await removeSkippedFor(payload.videoId)')
    const parse = source.indexOf('await resolveVideo(payload)')
    assert.ok(settle > 0, '强制下载入口必须先结掉 skipped 待办（用户已经做出了选择）')
    assert.ok(parse > settle, '必须排在解析之前：解析失败时只该留一条「失败」记录')
})

test('接线：消息路由必须等队列就绪再处理（否则 dedupe 看到空队列、addTask 覆盖磁盘）', () => {
    const source = readFileSync('src/background/index.ts', 'utf8')
    // 逐行判、且要求整行只有这条语句：用 `/await queueReady\(\)/` 会匹配到注释，
    // 把代码注释掉守卫仍然绿（第一次写就是这样漏的，已由 verify-guards 证明）
    const lines = source.split('\n')
    const isStatement = (line: string, call: RegExp): boolean => !line.trim().startsWith('//') && call.test(line)
    assert.ok(
        lines.some((line) => isStatement(line, /^\s*await queueReady\(\)\s*$/)),
        'SW 冷启动时消息可能先于 loadQueue 到达'
    )
    assert.ok(
        lines.some((line) => isStatement(line, /^\s*await configReady\s*$/)),
        'getConfig() 在 configReady 之前返回默认值'
    )
})

// ── 队列内去重（`planQueueLiveDuplicates`）────────────────────────────
// 管的是「队列里已经有重复记录」，比「要不要投递」更凶：两条活跃记录会让同一文件
// 被并行下两份，浏览器通道还会按记录数吃掉并发槽位。

function liveTask(videoId: string, status: QueueTask['status'], extra: Partial<QueueTask> = {}): QueueTask {
    return { id: `task-${videoId}-${status}-${extra.updatedAt ?? 0}`, videoId, kind: 'aria2', status, ...extra }
}

test('队列内去重：同一视频两条活跃记录只留一条', () => {
    const running = liveTask('a', 'running', { updatedAt: 1000 })
    const queued = liveTask('a', 'queued', { updatedAt: 2000 })
    const plan = planQueueLiveDuplicates([running, queued])
    assert.equal(plan.keep.length, 1)
    assert.equal(plan.drop.length, 1)
    // 没有 kindRef 时按时间戳留新的
    assert.equal(plan.keep[0]!.id, queued.id)
    assert.equal(plan.drop[0]!.id, running.id)
})

test('队列内去重：kindRef 命中 aria2 tellActive 的那条优先保留（不是在下的那条绝不能被丢）', () => {
    const inFlight = liveTask('a', 'running', { kindRef: 'gid-live', updatedAt: 1000 })
    const newer = liveTask('a', 'queued', { updatedAt: 9999 })
    const plan = planQueueLiveDuplicates([newer, inFlight], new Set(['gid-live']))
    assert.equal(plan.keep[0]!.id, inFlight.id, '真正在下载的记录被丢弃 = 用户看着进度条消失')
    assert.equal(plan.drop[0]!.id, newer.id)
})

test('队列内去重：保留者没有 kindRef 时继承被丢弃者的 gid（否则追踪器再也认不出这条任务）', () => {
    const withGid = liveTask('a', 'running', { kindRef: 'gid-1', updatedAt: 1000 })
    const noGid = liveTask('a', 'queued', { updatedAt: 9999 })
    // 没有 liveGids 提示时，`kindRef` 非空就优先，所以带 gid 的那条会被留下、无需继承
    const direct = planQueueLiveDuplicates([withGid, noGid])
    assert.equal(direct.keep[0]!.id, withGid.id)
    assert.deepEqual(direct.inheritKindRef, [])

    // 反向构造：强行让不带 gid 的那条成为保留者（两条都带 gid 时靠时间戳决胜）
    const older = liveTask('b', 'running', { kindRef: 'gid-old', updatedAt: 1 })
    const newerWithGid = liveTask('b', 'running', { kindRef: 'gid-new', updatedAt: 2 })
    const plan = planQueueLiveDuplicates([older, newerWithGid])
    assert.equal(plan.keep[0]!.id, newerWithGid.id)
    assert.deepEqual(plan.inheritKindRef, [], '保留者已有 gid，不该再继承')
})

test('队列内去重：只收敛活跃记录 —— complete 历史与失败的记录原样保留', () => {
    const complete = liveTask('a', 'complete', { updatedAt: 5000 })
    const failed = liveTask('a', 'failed', { updatedAt: 4000 })
    const running = liveTask('a', 'running', { updatedAt: 1000 })
    const plan = planQueueLiveDuplicates([complete, failed, running])
    assert.deepEqual(plan.drop, [], '一条活跃记录没有重复，历史记录之间并存是合法的')
    assert.equal(plan.keep.length, 0)
})

test('队列内去重：活跃记录只有一条时不动（避免无意义落盘）', () => {
    const plan = planQueueLiveDuplicates([liveTask('a', 'running', { updatedAt: 1 }), liveTask('b', 'complete')])
    assert.deepEqual(plan.drop, [])
    assert.deepEqual(plan.keep, [])
})

test('队列内去重：不同视频互不影响', () => {
    const plan = planQueueLiveDuplicates([liveTask('a', 'running'), liveTask('b', 'queued'), liveTask('c', 'queued')])
    assert.deepEqual(plan.drop, [])
})

test('队列内去重：三条重复只留一条、丢两条', () => {
    const plan = planQueueLiveDuplicates([liveTask('a', 'running', { updatedAt: 1 }), liveTask('a', 'queued', { updatedAt: 2 }), liveTask('a', 'running', { updatedAt: 3 })])
    assert.equal(plan.keep.length, 1)
    assert.equal(plan.drop.length, 2)
})

// ── 源码级接线：队列内去重必须被 boot 与 aria2 扫描调用 ────────────────

test('接线：boot 必须收敛队列内重复活跃记录', () => {
    const source = readFileSync('src/background/index.ts', 'utf8')
    assert.match(source, /await collapseDuplicateLiveTasks\(\)/, '没有这一步，SW 冷启动后同一视频的两条「下载中」会一直并存到用户手动清')
})

test('接线：aria2 扫描必须把 tellActive 的 gid 传给队列去重', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    assert.match(source, /collapseDuplicateLiveTasks\(liveGids\)/, '不传 liveGids 就只能靠时间戳猜，可能丢掉真正在下的那条')
})

test('接线：失败记录必须复用（批量/单条重下不该每次新建一行）', () => {
    const source = readFileSync('src/background/download/dispatch.ts', 'utf8')
    assert.match(source, /reusableFailedTaskFor\(video\.ID, getTasks\(\)\)/, '去掉复用，失败过的视频每点一次下载就多一行')
})

test('接线：retryTask 必须防重入（用户「重试全部」与 30 分钟 alarm 会同时命中同一条）', () => {
    const source = readFileSync('src/background/download/dispatch.ts', 'utf8')
    assert.match(source, /retryingTaskIds\.has\(task\.id\)/, '两个重试同时跑会对同一文件发两次 addUri，随后扫描必然 abort 一条')
})

test('接线：停止冗余 aria2 副本前必须先把 kindRef 指向赢家', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    const start = source.indexOf('for (const loser of plan.liveLosers)')
    const end = source.indexOf('for (const loser of plan.garbageLosers)')
    assert.ok(start > 0 && end > start, '两段循环都应存在')
    const loop = source.slice(start, end)
    const patch = loop.indexOf('patchTask(')
    const stop = loop.indexOf('stopLiveCopy(')
    assert.ok(patch > 0 && stop > 0, '循环里应同时有 patchTask 与 stopLiveCopy')
    assert.ok(patch < stop, '先 remove 再改 kindRef 会让 aria2 的 onDownloadError 把正常任务标成 failed（“Download aborted.”）')
})

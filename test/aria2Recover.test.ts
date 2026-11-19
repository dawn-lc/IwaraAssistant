/**
 * aria2 恢复判据（`shared/aria2Recover.ts`）。
 *
 * 这些判据决定「要不要动用户的下载任务」——重建/换地址/重启都会打断正在跑的下载。
 * 判错的两个方向都很难看：过松 → 反复重启，白丢已下好的进度；过紧 → 死了的任务永远不救。
 * 所以每条规则都单钉用例，尤其是「98% 豁免」与「速度 0 不豁免」这两个反直觉分支。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ARIA2_UNSEEN_SETTLE_LIMIT, ARIA2_STOPPED_PAGE, pickUnseenQueueTasks, MAX_RECOVER_ATTEMPTS, MIN_SLOW_POLLS, MIN_STALL_POLLS, SLOW_SPEED_THRESHOLD, STALL_MIN_SAMPLE_INTERVAL_MS, aria2Progress, buildChangeUriParams, canRebuildFromOldUris, compareForKeep, emptyScanMemory, gidPriority, isFileConflictErrorCode, isLiveAria2Status, isAria2GidMissingError, nextStallSample, parseScanMemory, planAria2Group, planResidualAdoption, planStoppedWindow, recoverCooldownRemaining, ARIA2_RECOVER_MIN_INTERVAL_MS, isUnrecoverableParseFailure, recoverExhausted, shouldRestartForSlowSpeed, shouldRestartForStall, taskLatestExpiry } from '../src/shared/aria2Recover'
import { uriExpiresAt } from '../src/shared/url'
import { RETRY_MAX_ATTEMPTS } from '../src/shared/constants'
import { readSource } from './sourceGuard'

function active(completed: number, total: number, speed: number) {
    return { status: 'active' as const, totalLength: String(total), completedLength: String(completed), downloadSpeed: String(speed) }
}

test('进度：totalLength 为 0 或缺失时返回 0（不做除零）', () => {
    assert.equal(aria2Progress({ totalLength: '0', completedLength: '100' }), 0)
    assert.equal(aria2Progress({ completedLength: '100' }), 0)
    assert.equal(aria2Progress({ totalLength: 'abc', completedLength: '100' }), 0)
})

test('进度：超过总量时钳到 1（服务端偶发 completedLength > totalLength）', () => {
    assert.equal(aria2Progress({ totalLength: '100', completedLength: '150' }), 1)
    assert.equal(aria2Progress({ totalLength: '100', completedLength: '50' }), 0.5)
})

test('过期时间：没有 expires 参数或 URL 非法时视为 -Infinity', () => {
    assert.equal(uriExpiresAt('https://example.com/a.mp4'), -Infinity)
    assert.equal(uriExpiresAt('not a url'), -Infinity)
    assert.equal(uriExpiresAt('https://example.com/a.mp4?expires=1700000000'), 1_700_000_000)
})

test('任务过期时间：多 URL 取最晚的那个（说明任务还能撑更久）', () => {
    const status = { files: [{ uris: [{ uri: 'https://e.com/a?expires=100' }, { uri: 'https://e.com/b?expires=300' }] }, { uris: [{ uri: 'https://e.com/c?expires=200' }] }] }
    assert.equal(taskLatestExpiry(status), 300)
})

test('任务过期时间：没有任何可用 URL 时返回 -Infinity', () => {
    assert.equal(taskLatestExpiry({}), -Infinity)
    assert.equal(taskLatestExpiry({ files: [{ uris: [] }] }), -Infinity)
})

test('gid 优先级：active > waiting > paused/complete > 其他', () => {
    assert.ok(gidPriority('active') > gidPriority('waiting'))
    assert.ok(gidPriority('waiting') > gidPriority('paused'))
    assert.equal(gidPriority('paused'), gidPriority('complete'))
    assert.ok(gidPriority('complete') > gidPriority('error'))
})

test('择优：完成度相同时，过期时间晚的胜出（即便对方状态更活跃）', () => {
    const alive = { gid: 'g1', status: 'waiting' as const, files: [{ uris: [{ uri: 'https://e.com/a?expires=200' }] }] }
    const expiring = { gid: 'g2', status: 'active' as const, files: [{ uris: [{ uri: 'https://e.com/b?expires=100' }] }] }
    assert.ok(compareForKeep(alive, expiring) < 0, '过期晚的应排在前')
    assert.ok(compareForKeep(expiring, alive) > 0)
})

test('择优：完成度最高的胜出，哪怕它的地址更早过期（已下字节是用户真正付出的成本）', () => {
    const nearlyDone = { gid: 'g-almost', status: 'active' as const, totalLength: '100', completedLength: '90', files: [{ uris: [{ uri: 'https://e.com/a?expires=100' }] }] }
    const fresh = { gid: 'g-fresh', status: 'active' as const, totalLength: '100', completedLength: '0', files: [{ uris: [{ uri: 'https://e.com/b?expires=999' }] }] }
    // 按旧的「过期时间优先」会留下 0% 的 fresh、remove 掉 90% 的，用户白下 90%
    assert.ok(compareForKeep(nearlyDone, fresh) < 0)
    assert.ok(compareForKeep(fresh, nearlyDone) > 0)
})

test('择优：aria2 的 complete 记作 100%（totalLength 读不到时也不能算 0%）', () => {
    const done = { gid: 'g-done', status: 'complete' as const, files: [] }
    const active = { gid: 'g-active', status: 'active' as const, totalLength: '100', completedLength: '99', files: [] }
    assert.ok(compareForKeep(done, active) < 0, '完成记录不能被一个 99% 的副本压过')
})

test('择优：进度相同（都是 0%）时已完成字节多的优先（同一下载被拆到两个 gid 的边界）', () => {
    const more = { gid: 'g-more', status: 'active' as const, totalLength: '0', completedLength: '4096', files: [] }
    const less = { gid: 'g-less', status: 'active' as const, totalLength: '0', completedLength: '1024', files: [] }
    assert.ok(compareForKeep(more, less) < 0)
    assert.ok(compareForKeep(less, more) > 0)
})

test('择优：过期时间相同才比活跃度', () => {
    const waiting = { gid: 'g1', status: 'waiting' as const, files: [{ uris: [{ uri: 'https://e.com/a?expires=100' }] }] }
    const activeTask = { gid: 'g2', status: 'active' as const, files: [{ uris: [{ uri: 'https://e.com/b?expires=100' }] }] }
    assert.ok(compareForKeep(activeTask, waiting) < 0)
})

test('择优：都相同时优先保留队列正在跟踪的那个 gid', () => {
    const a = { gid: 'g1', status: 'active' as const, files: [] }
    const b = { gid: 'g2', status: 'active' as const, files: [] }
    assert.ok(compareForKeep(a, b, 'g2') > 0)
    assert.ok(compareForKeep(a, b, 'g1') < 0)
    assert.equal(compareForKeep(a, b), 0)
})

test('慢速重启：首次观察只记录，不重启', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), undefined), false)
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), MIN_SLOW_POLLS - 1), false)
})

test('慢速重启：达到采样次数阈值则重启（第 2 次扫描动手）', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, 1024), MIN_SLOW_POLLS), true)
})

test('慢速重启：速度高于阈值的活跃任务不动', () => {
    assert.equal(shouldRestartForSlowSpeed(active(1000, 10_000, SLOW_SPEED_THRESHOLD + 1), MIN_SLOW_POLLS), false)
})

test('慢速重启：非 active 状态不走慢速判定', () => {
    const paused = { ...active(1000, 10_000, 0), status: 'paused' as const }
    assert.equal(shouldRestartForSlowSpeed(paused, MIN_SLOW_POLLS), false)
})

test('慢速重启：进度 ≥98% 且速度非 0 时豁免（别把快下完的任务重启掉）', () => {
    assert.equal(shouldRestartForSlowSpeed(active(99, 100, 1024), MIN_SLOW_POLLS), false)
})

test('慢速重启：速度为 0 时不豁免 98%（连接已死，等下去没有意义）', () => {
    assert.equal(shouldRestartForSlowSpeed(active(99, 100, 0), MIN_SLOW_POLLS), true)
})

test('扫描记忆：缺失或非对象时返回空表', () => {
    assert.deepEqual(parseScanMemory(undefined), emptyScanMemory())
    assert.deepEqual(parseScanMemory(null), emptyScanMemory())
    assert.deepEqual(parseScanMemory('broken'), emptyScanMemory())
    assert.deepEqual(parseScanMemory({ slowPolls: 'x', recoverAttempts: 3 }), emptyScanMemory())
})

test('扫描记忆：丢弃脏计数（否则写坏的值会让任务无限重启或永不重启）', () => {
    const parsed = parseScanMemory({
        slowPolls: { good: 2, zero: 0, negative: -1, nan: Number.NaN, text: '3', huge: 99_999 },
        recoverAttempts: { ok: 1 }
    })
    assert.deepEqual(parsed.slowPolls, { good: 2 })
    assert.deepEqual(parsed.recoverAttempts, { ok: 1 })
})

test('扫描记忆：正常值原样保留（跨 SW 回收后「连续 N 次」才能接着数）', () => {
    const parsed = parseScanMemory({ slowPolls: { videoA: 1 }, recoverAttempts: { videoB: 7 } })
    assert.equal(parsed.slowPolls['videoA'], 1)
    assert.equal(parsed.recoverAttempts['videoB'], 7)
})

test('重试上限：达到 MAX_RECOVER_ATTEMPTS 即用尽', () => {
    assert.equal(recoverExhausted(MAX_RECOVER_ATTEMPTS - 1), false)
    assert.equal(recoverExhausted(MAX_RECOVER_ATTEMPTS), true)
})

test('重建兜底：有新鲜地址时任何状态都能重建', () => {
    for (const status of ['active', 'waiting', 'paused', 'error', 'removed']) {
        assert.equal(canRebuildFromOldUris(status, true), true, status)
    }
})

test('重建兜底：没有新鲜地址时只允许对已死的任务用旧地址', () => {
    assert.equal(canRebuildFromOldUris('error', false), true)
    assert.equal(canRebuildFromOldUris('removed', false), true)
})

test('重建兜底：活着的任务不得用旧地址重建（这是 87 个真实任务被复制的根因）', () => {
    for (const status of ['active', 'waiting', 'paused']) {
        assert.equal(canRebuildFromOldUris(status, false), false, status)
    }
})

test('changeUri 参数：fileIndex 必须是 1（传 0 被 aria2 拒绝）', () => {
    const params = buildChangeUriParams('gid1', ['old'], ['new'])
    assert.deepEqual(params, ['gid1', 1, ['old'], ['new'], 0])
    assert.ok((params[1] as number) >= 1, 'aria2: the value must be greater than or equal to 1')
})

test('changeUri 参数：position 必须显式给 0（否则新地址只追加到队尾，旧地址仍被使用）', () => {
    const params = buildChangeUriParams('gid1', ['old'], ['new'])
    assert.equal(params.length, 5, '缺 position 时 aria2 会把新 URI 追加到末尾')
    assert.equal(params[4], 0)
})

test('gid 缺失错误：识别 aria2 的真实报文', () => {
    assert.equal(isAria2GidMissingError({ code: 1, message: 'GID 4cb40e84a20159b3 is not found' }), true)
    assert.equal(isAria2GidMissingError({ code: 1, message: 'gid abc is not found' }), true)
})

test('gid 缺失错误：不把其它错误当成「任务没了」', () => {
    assert.equal(isAria2GidMissingError(undefined), false)
    assert.equal(isAria2GidMissingError(null), false)
    assert.equal(isAria2GidMissingError('GID x is not found'), false, '裸字符串不是 RPC 错误对象')
    assert.equal(isAria2GidMissingError({ code: 1, message: 'Unauthorized' }), false)
    assert.equal(isAria2GidMissingError({ code: 1, message: 'GID#abc cannot be unpaused now' }), false)
})

// ── 同视频多条任务的收敛（`planAria2Group`）─────────────────────────
// 这一组是「删谁的下载」的判据。判错的两个方向都很糟：
// 删了活跃任务 → 用户正在下的大文件消失；该删没删 → 同一文件在 aria2 里堆 N 份。

test('活状态判定：active / waiting / paused 算活，终态不算', () => {
    for (const status of ['active', 'waiting', 'paused']) assert.equal(isLiveAria2Status(status), true, status)
    for (const status of ['complete', 'error', 'removed']) assert.equal(isLiveAria2Status(status), false, status)
})

test('同视频收敛：正在下的活任务压过「恰好没过期」的完成历史（不能为了腾地方删掉用户的活下载）', () => {
    // 历史记录的 URL 过期更晚 —— 这正是 `compareForKeep` 会选错的方向
    const live = { gid: 'g-live', status: 'active' as const, files: [{ uris: [{ uri: 'https://e.com/a?expires=100' }] }] }
    const history = { gid: 'g-done', status: 'complete' as const, files: [{ uris: [{ uri: 'https://e.com/b?expires=999' }] }] }
    const plan = planAria2Group([history, live])
    assert.equal(plan?.winner.gid, 'g-live')
    assert.deepEqual(
        plan?.liveLosers.map((task) => task.gid),
        []
    )
    assert.deepEqual(
        plan?.historyLosers.map((task) => task.gid),
        ['g-done'],
        '完成历史必须归入 historyLosers（只记日志、不发 RPC）'
    )
})

test('同视频收敛：完成历史永远不会被列为要删除的对象', () => {
    const live = { gid: 'g1', status: 'active' as const }
    const done = { gid: 'g2', status: 'complete' as const }
    const plan = planAria2Group([live, done])!
    const removable = [...plan.liveLosers, ...plan.garbageLosers].map((task) => task.gid)
    assert.ok(!removable.includes('g2'), '删掉完成历史 = 用户重下同名文件时找不到已下过的记录')
})

test('同视频收敛：多条活任务里保留完成度最高的那条（不是最活跃的那条）', () => {
    const fresh = { gid: 'g-fresh', status: 'active' as const, totalLength: '100', completedLength: '0' }
    const paused90 = { gid: 'g-paused', status: 'paused' as const, totalLength: '100', completedLength: '90' }
    const waiting50 = { gid: 'g-waiting', status: 'waiting' as const, totalLength: '100', completedLength: '50' }
    const plan = planAria2Group([fresh, paused90, waiting50])!
    assert.equal(plan.winner.gid, 'g-paused', '按活跃度会选 active 那条，用户于是丢掉 90%')
    assert.deepEqual(plan.liveLosers.map((task) => task.gid).sort(), ['g-fresh', 'g-waiting'])
})

test('同视频收敛：同一路径的重复完成记录只清结果（一个视频一个任务）', () => {
    const doneA = { gid: 'g-a', status: 'complete' as const, files: [{ path: '/media/a.mp4', uris: [] }] }
    const doneB = { gid: 'g-b', status: 'complete' as const, files: [{ path: '/media/a.mp4', uris: [] }] }
    const plan = planAria2Group([doneA, doneB])!
    assert.equal(plan.duplicateHistory.length, 1)
    assert.deepEqual(
        plan.historyLosers.map((task) => task.gid),
        []
    )
    // 保留者仍在，磁盘上的文件只有一份，删掉多余的结果条目不影响任何东西
    assert.ok([doneA.gid, doneB.gid].includes(plan.winner.gid))
})

test('同视频收敛：不同路径的完成记录都保留（不同画质/不同模板是两份真实文件）', () => {
    const sd = { gid: 'g-sd', status: 'complete' as const, files: [{ path: '/media/a_sd.mp4', uris: [] }] }
    const hd = { gid: 'g-hd', status: 'complete' as const, files: [{ path: '/media/a_hd.mp4', uris: [] }] }
    const plan = planAria2Group([sd, hd])!
    assert.deepEqual(plan.duplicateHistory, [])
    assert.equal(plan.historyLosers.length, 1)
})

test('同视频收敛：活任务优先于完成历史（重下时不能被历史记录判成重复）', () => {
    const live = { gid: 'g-live', status: 'active' as const, totalLength: '100', completedLength: '1', files: [{ path: '/media/a.mp4', uris: [] }] }
    const done = { gid: 'g-done', status: 'complete' as const, files: [{ path: '/media/a.mp4', uris: [] }] }
    const plan = planAria2Group([live, done])!
    assert.equal(plan.winner.gid, 'g-live', '用户删了文件重下时，历史记录不该把自己变成「赢家」并把新任务停掉')
    assert.deepEqual(plan.duplicateHistory, [], '历史记录本身也不是重复项（它是唯一一条 complete）')
})

test('同视频收敛：多条活任务只留一条，其余归 liveLosers', () => {
    const a = { gid: 'g-a', status: 'active' as const }
    const b = { gid: 'g-b', status: 'waiting' as const }
    const c = { gid: 'g-c', status: 'paused' as const }
    const plan = planAria2Group([a, b, c])!
    assert.equal(plan.winner.gid, 'g-a')
    assert.deepEqual(plan.liveLosers.map((task) => task.gid).sort(), ['g-b', 'g-c'])
})

test('同视频收敛：error / removed 归 garbageLosers（只清记录，不发 remove）', () => {
    const live = { gid: 'g1', status: 'active' as const }
    const err = { gid: 'g2', status: 'error' as const }
    const removed = { gid: 'g3', status: 'removed' as const }
    const plan = planAria2Group([live, err, removed])!
    assert.equal(plan.winner.gid, 'g1')
    assert.deepEqual(plan.garbageLosers.map((task) => task.gid).sort(), ['g2', 'g3'])
    assert.deepEqual(plan.liveLosers, [])
})

test('同视频收敛：全是活任务时优先保留队列正在跟踪的 gid', () => {
    const a = { gid: 'g-a', status: 'active' as const }
    const b = { gid: 'g-b', status: 'active' as const }
    assert.equal(planAria2Group([a, b], 'g-b')?.winner.gid, 'g-b')
})

test('同视频收敛：空组返回 undefined（调用方据此跳过，不要崩）', () => {
    assert.equal(planAria2Group([]), undefined)
})

test('同视频收敛：只有一条任务时它自己就是 winner，没有任何 loser', () => {
    const plan = planAria2Group([{ gid: 'g1', status: 'complete' as const }])!
    assert.equal(plan.winner.gid, 'g1')
    assert.deepEqual([plan.liveLosers, plan.garbageLosers, plan.historyLosers], [[], [], []])
})

// ── 残留收编（`planResidualAdoption`）──────────────────────────────
// 这组判据决定「用户能不能看见 / 能不能重试」aria2 里的历史失败。
// 旧实现把 error 也一起吃「30 天内已完成」的跳过分支，实测让 309 条 403 死任务
// 永远留在 aria2 里且不出现在任务面板。

test('残留收编：完成态 + 完成表命中 → 跳过入队（已完成，不需要用户操作）', () => {
    assert.deepEqual(planResidualAdoption('complete', true), { adopt: false })
})

test('残留收编：完成态 + 完成表未命中 → 收编（保持 complete 并补记完成表）', () => {
    assert.deepEqual(planResidualAdoption('complete', false), { adopt: true })
})

test('残留收编：error 即使完成表命中也要收编成待办（这是 309 条 403 死任务的根因）', () => {
    const known = planResidualAdoption('error', true)
    assert.equal(known.adopt, true, '「30 天内完成过」说的是更早那次下载，不能替用户忽略这一次失败')
    assert.equal(known.attempts, RETRY_MAX_ATTEMPTS, '必须给满上限，否则 30 分钟后闹钟会把 309 条过期直链一起重投')
})

test('残留收编：error / removed 在完成表未命中时同样收编，且都带满上限 attempts', () => {
    for (const status of ['error', 'removed']) {
        assert.deepEqual(planResidualAdoption(status, false), { adopt: true, attempts: RETRY_MAX_ATTEMPTS }, status)
    }
})

test('残留收编：活任务收编时不限制 attempts（它们本来就没失败过）', () => {
    for (const status of ['active', 'waiting', 'paused']) {
        assert.deepEqual(planResidualAdoption(status, true), { adopt: true }, status)
    }
})

test('残留收编：上限可注入（与 RETRY_MAX_ATTEMPTS 解耦，便于调用方换策略）', () => {
    assert.equal(planResidualAdoption('error', true, 7).attempts, 7)
})

// ── 文件冲突错误（`isFileConflictErrorCode`）────────────────────────────
// aria2 的报错文案写着「add --allow-overwrite=true」，但源码里有一条分支
// （adjustFilename → isSameFileBeingDownloaded → tryAutoFileRenaming）
// **完全无视 allow-overwrite**，只认 auto-file-renaming。
// 这类错误重建必然再撞同一个文件，必须识别出来直接判失败，而不是白跑 8 轮。

test('文件冲突错误：aria2 的 13（FILE_ALREADY_EXISTS）与 11（DUPLICATE_DOWNLOAD）都算', () => {
    assert.equal(isFileConflictErrorCode('13'), true)
    assert.equal(isFileConflictErrorCode(13), true)
    assert.equal(isFileConflictErrorCode('11'), true)
    assert.equal(isFileConflictErrorCode(11), true)
})

test('文件冲突错误：其他错误码不算（403 是 HTTP_PROTOCOL_ERROR=22，重解析确实能救）', () => {
    assert.equal(isFileConflictErrorCode('22'), false, '403 是链接过期，重解析是新地址能修好的')
    assert.equal(isFileConflictErrorCode('1'), false)
    assert.equal(isFileConflictErrorCode('0'), false)
    assert.equal(isFileConflictErrorCode(''), false)
})

test('文件冲突错误：缺失/脏值不误判（宁可走正常恢复，也不要漏掉可恢复的任务）', () => {
    assert.equal(isFileConflictErrorCode(undefined), false)
    assert.equal(isFileConflictErrorCode('abc'), false)
    assert.equal(isFileConflictErrorCode('-1'), false)
})

test('文件冲突错误：判据不依赖 allow-overwrite（那条文案在这个分支上是误导）', () => {
    // 断言函数签名只收 errorCode：如果将来有人加个 allowOverwrite 参数并据此放行，
    // 这个用例会编译失败——那时的行为就回到了「白跑 8 轮」。
    assert.equal(isFileConflictErrorCode.length, 1)
})

// ── 源码级接线守卫：三类 loser 必须走三条不同的处置路径 ──────────────
// 纯函数只负责「分类」；「分类之后发什么 RPC」在 tracker 里。
// 上一版正是在这里出的事：三类 loser 共用 `stopRedundantTask`，而它无条件
// `removeDownloadResult` → 用户每重下一次以前下过的视频，就删掉一条完成历史
// （源项目 Issue #405 的同一个坑，注释写着、实现没守住）。这种错不会有类型错误。

function trackerBody(name: string): string {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    const start = source.indexOf(`async function ${name}(`)
    assert.ok(start > 0, `找不到 ${name}`)
    // 用下一个顶层 async function 作为边界（本文件的顶层函数都以此开头）
    const nextFunction = source.indexOf('\nasync function ', start + 1)
    const nextExport = source.indexOf('\nexport ', start + 1)
    const candidates = [nextFunction, nextExport].filter((index) => index > start)
    const end = candidates.length > 0 ? Math.min(...candidates) : source.length
    return source.slice(start, end)
}

test('清结果必须走会等的 helper：remove 之后结果还没入表，直接 removeDownloadResult 只会静默失败', () => {
    const client = readFileSync('src/background/backends/aria2/client.ts', 'utf8')
    const start = client.indexOf('export async function aria2RemoveResult(')
    assert.ok(start > 0, 'aria2RemoveResult 应存在')
    const body = client.slice(start, client.indexOf('\n}', start) + 2)
    assert.match(body, /aria2\.removeDownloadResult/, 'helper 内部必须真的清结果')
    assert.match(body, /for \(let i = 0; i < attempts; i\+\+\)/, '必须重试等待结果入表，而不是打一次就放弃')
    assert.doesNotMatch(body, /catch \{\s*\}/, '清理失败不能静默：至少留一行日志')
    assert.match(body, /isAria2GidMissingError/, '「GID is not found」有两种含义：结果未入表（要等）与任务压根不留记录（已清干净）。实测取消 waiting 任务属于后者，不区分会白等 1 秒并打假警告')
    assert.match(body, /if \(exists === false\) return true/, '查到 gid 已彻底不存在时必须直接判成功，否则取消排队任务会空转重试')
})

test('接线：liveLosers 的处置既 remove 也清结果（只 remove 会留下 stopped 记录，下轮又被收编）', () => {
    const body = trackerBody('stopLiveCopy')
    assert.match(body, /aria2\.remove'/, '必须真的停掉在跑的那份')
    assert.match(body, /aria2RemoveResult\(/, '只 remove 会留下记录，下轮扫描把它当另一个同源任务再收编 → 死循环')
})

test('接线：garbageLosers 的处置只清结果，不 remove（error/removed 已经不在活动队列里）', () => {
    const body = trackerBody('discardGarbageCopy')
    assert.match(body, /aria2RemoveResult\(/)
    assert.doesNotMatch(body, /aria2\.remove'/, '对已死任务发 remove 只会换回一个错误')
})

test('取消路径：先摘掉 kindRef 再 remove（否则 error 事件会把刚取消的任务当失败，甚至触发恢复重建）', () => {
    const source = readFileSync('src/background/download/cancel.ts', 'utf8')
    const start = source.indexOf('async function removeAria2Task(')
    assert.ok(start > 0, 'removeAria2Task 应存在')
    const body = source.slice(start, source.indexOf('\n}', start) + 2)
    const patchAt = body.indexOf('kindRef: undefined')
    const removeAt = body.indexOf("aria2.remove'")
    assert.ok(patchAt > 0, '必须先摘关联')
    assert.ok(removeAt > patchAt, '摘关联必须在 remove 之前')
    assert.match(body, /aria2RemoveResult\(/, '清结果要等它入表')
})

test('扫描必须拉三张表：waiting/paused 只在 tellWaiting 里，漏了就是死分支', () => {
    // 真正的对账逻辑在 runAria2Scan（scanAria2TasksAndEnqueue 只是单飞外壳）
    const body = trackerBody('runAria2Scan')
    assert.match(body, /aria2\.tellActive/, 'active 一路')
    assert.match(body, /aria2\.tellStopped/, 'stopped 一路')
    assert.match(body, /aria2\.tellWaiting/, 'waiting/paused 只在 tellWaiting 里：漏了它，排队中的任务会一直显示「下载中」')
    // 去重判据只认 active：排队副本没在传，把它的 gid 算进 liveGids 会让去重误留一条空转的
    assert.match(body, /const liveGids = new Set\(activeTasks\.map/, 'liveGids 必须只由 active 构成')
})

test('失败事件必须先分类再决定（否则 WS 报失败、5 分钟后扫描又「恢复」同一个 gid）', () => {
    const body = trackerBody('handleDownloadError')
    assert.match(body, /isFileConflictErrorCode\(/, '文件冲突类错误重建也只会再撞一次，要单独报')
    assert.match(body, /tryRecover\(/, '其余错误应当场就地修，而不是留一条假失败等 5 分钟')
    assert.match(body, /aria2FileConflict/, '冲突文案要如实说明，不能落成「未知错误码」')
    // 冲突分支在 tryRecover 之前也会写 failed，所以拿「最后那次」比：那是兜底的失败落库
    assert.ok(body.indexOf('tryRecover(') < body.lastIndexOf("task.status = 'failed'"), '先尝试恢复，失败才落 failed')
})

test('字段表只有一份，且必须包含 errorCode', () => {
    const client = readFileSync('src/background/backends/aria2/client.ts', 'utf8')
    assert.match(client, /export const ARIA2_STATUS_FIELDS = \[[^\]]*'errorCode'/, 'errorCode 漏了 → 失败原因恒为「未知错误码」，文件冲突判定永远为假')
    assert.match(client, /'aria2\.tellStatus', \[gid, \[\.\.\.ARIA2_STATUS_FIELDS\]\]/, 'tellStatus 必须用统一字段表，不许就地手写数组')
})

test('接线：完成历史（historyLosers）不得触发任何 RPC', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    const start = source.indexOf('plan.historyLosers.length > 0')
    assert.ok(start > 0, 'historyLosers 分支应存在')
    const block = source.slice(start, source.indexOf('\n            }', start))
    assert.doesNotMatch(block, /aria2API\(/, '删掉完成历史 = 用户重下以前下过的视频时，aria2 里那条记录被静默抹掉（源 Issue #405）')
    assert.doesNotMatch(block, /stopLiveCopy|discardGarbageCopy/, '历史记录不该进任何清理路径')
})

test('接线：重复完成记录只清结果（不 remove、不动磁盘文件）', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    const start = source.indexOf('for (const duplicate of plan.duplicateHistory)')
    assert.ok(start > 0, 'duplicateHistory 分支应存在，否则同一视频会留下多条完成记录')
    const block = source.slice(start, source.indexOf('\n            }', start))
    assert.match(block, /discardGarbageCopy\(duplicate\)/, '已完成的任务不在活动队列里，remove 只会换回一个错误')
    assert.doesNotMatch(block, /aria2\.remove'/)
})

test('接线：保留者是被暂停的任务时必须 unpause（否则去重之后下载就停了）', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    const start = source.indexOf("if (!queuedTask && plan.liveLosers.length > 0 && winner.status === 'paused')")
    assert.ok(start > 0, '完成度优先可能选出 paused 的赢家，必须有恢复动作')
    const block = source.slice(start, source.indexOf('\n            }', start))
    assert.match(block, /aria2\.unpause/)
})

test('接线：扫描必须用 planAria2Group 分类，而不是自己再判一遍状态', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    assert.match(source, /const plan = planAria2Group\(group, queuedTask\?\.kindRef\)/)
    // 只认「定义/调用」，注释里提到旧名字是正常的（那里正是在记载这个坑）
    assert.doesNotMatch(source, /async function stopRedundantTask/, '旧的「三类一起清」入口不该回来')
    assert.doesNotMatch(source, /await stopRedundantTask\(/, '旧的「三类一起清」入口不该回来')
})

test('接线：扫描必须用 planResidualAdoption 决定收编，而不是自己写状态判断', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    assert.match(source, /const adoption = planResidualAdoption\(winner\.status, doneMap\[videoId\] !== undefined\)/)
    // 回归守卫：旧的「非 active/waiting 就跳过」写法不得回来
    assert.doesNotMatch(source, /doneMap\[videoId\] !== undefined && winner\.status !== 'active'/, '把 error 一起跳过会让失败残留永远烂在 aria2 里（实测 309 条）')
})

test('接线：收编必须批量落盘（逐条 addTask 会写盘 N 次并让界面刷新 N 次）', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    assert.match(source, /await addTasks\(pendingAdoptions\)/, '309 条逐条 addTask 会让选项页卡住')
})

test('接线：文件冲突错误必须在重建之前拦下（否则白跑 8 轮重解析 + addUri）', () => {
    const source = readFileSync('src/background/backends/aria2/tracker.ts', 'utf8')
    const guard = source.indexOf('isFileConflictErrorCode(winner.errorCode)')
    assert.ok(guard > 0, 'recoverCore 必须识别文件冲突错误')
    const rebuild = source.indexOf('await rebuildAria2Task(winner.gid, videoId, winner)', guard)
    assert.ok(rebuild > guard, '判据必须排在 rebuild 之前')
})

// ── 停滞判定：active 但字节完全不动（aria2 不报错时唯一可用的信号）──────────────

function stalled(completed: number, speed = 0) {
    return { status: 'active' as const, totalLength: '1000', completedLength: String(completed), downloadSpeed: String(speed) }
}

test('停滞采样：首次只记录，采样过近不重复计数', () => {
    const first = nextStallSample(stalled(100), undefined, 1_000_000)
    assert.ok(first)
    assert.equal(first.polls, 1)
    const close = nextStallSample(stalled(100), first, 1_000_000 + Math.floor(STALL_MIN_SAMPLE_INTERVAL_MS / 2))
    assert.equal(close?.polls, 1, '两条定时器撞在一起时不能各记一笔')
    assert.equal(close?.at, first.at, '不累加时保留原采样时间，判据才不会随相位漂移')
    const second = nextStallSample(stalled(100), close, 1_000_000 + STALL_MIN_SAMPLE_INTERVAL_MS + 1)
    assert.equal(second?.polls, 2, '隔够了时间还没动，这才是第二次观测')
})

test('停滞采样：有进展就重新数，有速度或离开 active 直接清零', () => {
    const first = nextStallSample(stalled(100), undefined, 1_000_000)
    const moved = nextStallSample(stalled(200), first, 1_000_000 + STALL_MIN_SAMPLE_INTERVAL_MS + 1)
    assert.equal(moved?.polls, 1, '字节数变了就是有进展')
    assert.equal(nextStallSample(stalled(200, 5000), moved, 2_000_000), undefined, '有速度不用管')
    assert.equal(nextStallSample({ ...stalled(200), status: 'waiting' as const }, moved, 2_000_000), undefined, '排队不算停滞')
    assert.equal(nextStallSample({ ...stalled(200), status: 'error' as const }, moved, 2_000_000), undefined, '报错交给 rebuild 分支')
})

test('停滞采样：媒体任务靠 media.progress 算「在动」（totalLength 恒 0 的分支）', () => {
    const media = (progress: string) => ({ status: 'active' as const, totalLength: '0', completedLength: '0', downloadSpeed: '0', media: { progress } })
    const first = nextStallSample(media('0.300000'), undefined, 1_000_000)
    assert.equal(first?.polls, 1)
    // completedLength 一直是 0，但媒体进度在涨 → 分片还在合并，绝不能判停滞
    const moving = nextStallSample(media('0.400000'), first, 1_000_000 + STALL_MIN_SAMPLE_INTERVAL_MS + 1)
    assert.equal(moving?.polls, 1, '媒体进度变了就是有进展')
    assert.notEqual(moving?.signature, first?.signature)
    const frozen = nextStallSample(media('0.400000'), moving, 2_000_000)
    assert.equal(frozen?.polls, 2, '媒体进度也不动了才是真停滞')
    assert.equal(shouldRestartForStall({ status: 'active' as const, downloadSpeed: '0' }, frozen), true, '媒体任务也必须能判停滞')
})

test('停滞判定：连续 2 次采样都没动才重启，且只对 active 生效', () => {
    const one = { signature: '100|0', polls: 1, at: 1 }
    const enough = { signature: '100|0', polls: MIN_STALL_POLLS, at: 1 }
    assert.equal(shouldRestartForStall(stalled(100), one), false, '只观测到一次不动手')
    assert.equal(shouldRestartForStall(stalled(100), enough), true)
    assert.equal(shouldRestartForStall(stalled(100), undefined), false)
    assert.equal(shouldRestartForStall(stalled(100, 1024), enough), false, '有速度就走慢速判据，不按停滞处理')
    assert.equal(shouldRestartForStall({ ...stalled(100), status: 'waiting' as const }, enough), false)
})

test('扫描记忆：停滞采样能跨 SW 回收保留，脏值一律丢弃', () => {
    const memory = parseScanMemory({
        stallSamples: {
            ok: { signature: '1024|0.5', polls: 2, at: 1_700_000_000_000 },
            badSignature: { signature: 42, polls: 2, at: 1 },
            badPolls: { signature: '1|0', polls: 0, at: 1 },
            badAt: { signature: '1|0', polls: 2, at: 'x' },
            badShape: 'nope'
        }
    })
    assert.deepEqual(Object.keys(memory.stallSamples), ['ok'])
    assert.deepEqual(emptyScanMemory().stallSamples, {})
})

test('接线：停滞判定在恢复链里，且慢速采样只有 probe 一个记账方', () => {
    const tracker = readSource('src/background/backends/aria2/tracker.ts')
    assert.match(tracker, /const stallSample = observeStall\(videoId, winner\)/, '恢复链必须先记停滞采样')
    assert.match(tracker, /shouldRestartForStall\(winner, stallSample\)/, 'stallSample 必须参与 needsRestart')
    assert.match(tracker, /trackSlowObservation\(videoId, winner, recordSlow\)/, '扫描与 probe 要区分记账权')
    assert.match(tracker, /tryRecover\(videoId, status, queuedTask, true\)/, 'probe 是唯一记账方')
    assert.doesNotMatch(tracker, /tryRecover\(videoId, winner, queuedTask, true\)/, '扫描（5 分钟）也记账会把「连续 2 次」的含义搅成 2 分钟和 10 分钟两种')
    assert.match(tracker, /if \(scanInFlight\) return scanInFlight/, '扫描必须单飞（12 MB 的 tellStopped 不能并发两份）')
    assert.match(tracker, /if \(probeInFlight\) return probeInFlight/, '探测也必须单飞')
})

// ── P1-1：tellStopped 的增量窗口（每 5 分钟要不要传 12 MB）──────────────────────

test('增量窗口：计数没变就一条都不拉（每轮 12 MB 变 0）', () => {
    assert.deepEqual(planStoppedWindow({ sessionChanged: false, currentTotal: 100, lastTotal: 100, fullSweepDue: false }), { num: 0, restarted: false })
    assert.deepEqual(planStoppedWindow({ sessionChanged: false, currentTotal: 103, lastTotal: 100, fullSweepDue: false }), { num: 11, restarted: false }, '计数涨 3 就只拉 3 + 8 条余量')
    assert.deepEqual(planStoppedWindow({ sessionChanged: false, currentTotal: 5000, lastTotal: 100, fullSweepDue: false }), { num: ARIA2_STOPPED_PAGE, restarted: false }, '暴涨也只拉一页')
})

test('增量窗口：没有基线 / 计数不可信 / 到点全量，都退回全量', () => {
    assert.deepEqual(planStoppedWindow({ sessionChanged: false, currentTotal: 100, lastTotal: -1, fullSweepDue: false }), { num: ARIA2_STOPPED_PAGE, restarted: false })
    assert.deepEqual(planStoppedWindow({ sessionChanged: false, currentTotal: Number.NaN, lastTotal: 100, fullSweepDue: false }), { num: ARIA2_STOPPED_PAGE, restarted: false })
    assert.deepEqual(planStoppedWindow({ sessionChanged: false, currentTotal: 100, lastTotal: 100, fullSweepDue: true, fullSize: 1000 }), { num: 1000, restarted: false })
    assert.deepEqual(planStoppedWindow({ sessionChanged: true, currentTotal: 100, lastTotal: 100, fullSweepDue: false, fullSize: 64 }), { num: 64, restarted: true }, 'aria2 重启过：必须全量，且调用方要清空采样')
    assert.deepEqual(planStoppedWindow({ sessionChanged: false, currentTotal: 3, lastTotal: 1134, fullSweepDue: false, fullSize: 64 }), { num: 64, restarted: true }, '计数倒退只能是重启；按 delta=0 跳过就会漏掉重启后的全部新记录')
})

test('扫描记忆：增量窗口与网络退避都能跨 SW 回收保留（脏值丢弃）', () => {
    const memory = parseScanMemory({ stoppedTotal: 42, sessionId: 'abc', scanRound: 7, networkBreakerUntil: 123456, networkFailures: { ok: { count: 2, lastAt: 100, nextAt: 200 }, zero: { count: 0, lastAt: 1, nextAt: 2 }, broken: 'x' } })
    assert.equal(memory.stoppedTotal, 42)
    assert.equal(memory.sessionId, 'abc')
    assert.equal(memory.scanRound, 7)
    assert.equal(memory.networkBreakerUntil, 123456)
    assert.deepEqual(Object.keys(memory.networkFailures), ['ok'])
    const blank = parseScanMemory(undefined)
    assert.equal(blank.stoppedTotal, -1, '没有基线必须能被识别出来')
    assert.equal(blank.sessionId, '')
    assert.equal(blank.networkBreakerUntil, 0)
})

test('会话 ID：两个方法名都要试（3.1.1 只有 aria2.getSessionInfo，上游只有 system.getSessionInfo）', () => {
    const client = readSource('src/background/backends/aria2/client.ts')
    assert.match(client, /ARIA2_SESSION_INFO_METHODS = \['aria2\.getSessionInfo', 'system\.getSessionInfo'\]/, '两个名字都要在表里，顺序按实测优先级')
    assert.match(client, /res\?\.result\?\.sessionId/, 'RPC 错误不抛异常，必须先看 result')
    const tracker = readSource('src/background/backends/aria2/tracker.ts')
    assert.match(tracker, /aria2SessionId\(\)/, '扫描必须走带兜底的读取')
    assert.doesNotMatch(tracker, /'aria2\.getSessionInfo'/, '调用点写死方法名就没有兜底（上游只有 system 那个）')
})

test('接线：扫描先问计数（P1-1）、恢复链区分网络失败、attempts 先落盘', () => {
    const tracker = readSource('src/background/backends/aria2/tracker.ts')
    assert.match(tracker, /planStoppedWindow\(\{/)
    assert.match(tracker, /window\.num === 0 \? Promise\.resolve/, '计数没变就不许请求 tellStopped')
    assert.match(tracker, /classifyAria2Failure\(winner\.errorCode, winner\.errorMessage\) === 'network'/, '网络层失败必须与链接过期分开')
    assert.match(tracker, /scanMemory\.networkBreakerUntil > now/, '熔断期间一个动作都不做')
    const alarms = readSource('src/background/runtime/alarms.ts')
    assert.match(alarms, /await patchTask\(task\.id, \{ attempts \}\)/, 'attempts 必须先落盘再重试')
    assert.doesNotMatch(alarms, /^\s*task\.attempts = /m, '只改内存对象会在 SW 回收后归零')
    const dispatch = readSource('src/background/download/dispatch.ts')
    assert.doesNotMatch(dispatch, /task\.attempts = \(task\.attempts \?\? 0\) \+ 1/, '失败分支与自动重试不能各记一次')
    const downloaders = readSource('src/background/download/downloaders.ts')
    assert.match(downloaders, /aria2TuningParams\(options, \{ maxConnections: config\.aria2MaxConnections/, '连接数/分段必须显式投递（上游默认单连接）')
})

// ── 「aria2 里已经没有」的任务要收敛掉（界面「下载中」必须等于 aria2 的真实数量）──

test('残骸筛选：只挑活状态 + 已绑定 gid + 三个列表都没出现的', () => {
    const tasks = [
        { id: 'a', status: 'running', kind: 'aria2', kindRef: 'g1', updatedAt: 2 },
        { id: 'b', status: 'running', kind: 'aria2', kindRef: 'g1', updatedAt: 1 },
        { id: 'c', status: 'complete', kind: 'aria2', kindRef: 'g2' },
        { id: 'd', status: 'running', kind: 'browser', kindRef: 'g3' },
        { id: 'e', status: 'queued', kind: 'aria2' }
    ]
    const picked = pickUnseenQueueTasks(tasks, new Set(['g2']))
    assert.deepEqual(
        picked.map((item) => item.id),
        ['b', 'a'],
        '只留没出现在 aria2 列表里的；旧的先处理'
    )
})

test('残骸筛选：每轮有上限，剩下的下一轮继续', () => {
    const tasks = Array.from({ length: 50 }, (_, index) => ({ id: `t${index}`, status: 'running', kind: 'aria2', kindRef: `g${index}`, updatedAt: index }))
    assert.equal(pickUnseenQueueTasks(tasks, new Set()).length, ARIA2_UNSEEN_SETTLE_LIMIT)
    assert.equal(pickUnseenQueueTasks(tasks, new Set(), 3).length, 3)
})

test('接线：扫描必须对不在三份列表里的任务逐条 tellStatus 收敛', () => {
    const tracker = readSource('src/background/backends/aria2/tracker.ts')
    assert.match(tracker, /await settleUnseenQueueTasks\(listedGids\)/, '不调用这一步，gid 被清掉的任务会永远停在「下载中」（实测界面 115 条 vs aria2 numActive 1）')
    assert.match(tracker, /pickUnseenQueueTasks\(getTasks\(\), seenGids\)/, '残骸的筛选判据必须在 shared 里（已单测）')
    assert.match(tracker, /if \(status === undefined\) \{/, '查不到 gid（not found）必须单独处理，不能混进「传输失败」')
    assert.match(tracker, /i18n\.t\('tasks\.staleAria2Gone'\)/, '如实告诉用户：aria2 里已经没有这条任务')
})

test('接线：扫描要清掉我们自己的失败记录（stopped 列表不被重试残骸撑大）', () => {
    const tracker = readSource('src/background/backends/aria2/tracker.ts')
    assert.match(tracker, /await discardFailedAria2Records\(stopRes\.result \?\? \[\]\)/, '不清就每轮重试都留一条 0 B error，AriaNg 里看起来就是重复失败任务在堆积')
    // 收窄到函数体：只允许删 error/removed 的**我们自己的**记录
    const start = tracker.indexOf('async function discardFailedAria2Records')
    assert.ok(start > 0, '清理函数必须存在')
    const body = tracker.slice(start, tracker.indexOf('async function settleUnseenQueueTasks'))
    assert.match(body, /task\.status === 'failed'/, '只清队列里已记为 failed 的（已完成的历史要留作去重证据）')
    assert.match(body, /record\.status !== 'error' && record\.status !== 'removed'/, 'complete 一律不删')
    assert.match(body, /aria2RemoveResult\(record\.gid\)/, '清的是本轮 stopped 里那条记录')
})

test('文件冲突码包含 8（本地文件比远端大）：重建救不了，但覆盖可以', () => {
    assert.equal(isFileConflictErrorCode(13), true)
    assert.equal(isFileConflictErrorCode('11'), true)
    assert.equal(isFileConflictErrorCode(8), true, 'errorCode 8 若不归到冲突类，就会被当成未知错误反复重建')
    assert.equal(isFileConflictErrorCode(22), false)
})

test('接线：队列说 running、aria2 已报错的行必须收敛', () => {
    const tracker = readSource('src/background/backends/aria2/tracker.ts')
    assert.match(tracker, /await settleErroredQueueTasks\(stopRes\.result \?\? \[\]\)/, '不看这一眼，扩展重载期间出错的任务会永远显示「下载中」（真机：zgC4YDXRi5Rq90）')
    const start = tracker.indexOf('async function settleErroredQueueTasks')
    assert.ok(start > 0)
    const body = tracker.slice(start, tracker.indexOf('async function settleUnseenQueueTasks'))
    assert.match(body, /record\.status === 'error' \|\| record\.status === 'removed'/, '只处理真正结束的记录')
    assert.match(body, /isFileConflictErrorCode\(record\.errorCode\)/, '冲突类要给用户「强制覆盖」入口（打 conflict 标记）')
    assert.match(body, /await tryRecover\(task\.videoId, record, task\)/, '非冲突类仍要走自动恢复，不能一律标失败')
})

test('自动恢复节流：同一视频两次尝试之间至少隔一分钟', () => {
    const now = 1_000_000_000
    assert.equal(recoverCooldownRemaining(undefined, now), 0, '没试过就该立刻能试（否则新失败永远不恢复）')
    assert.equal(recoverCooldownRemaining(0, now), 0)
    assert.equal(recoverCooldownRemaining(Number.NaN, now), 0, '脏值不能把任务永久锁住')
    assert.equal(recoverCooldownRemaining(now, now), ARIA2_RECOVER_MIN_INTERVAL_MS)
    assert.equal(recoverCooldownRemaining(now - 30_000, now), 30_000)
    assert.equal(recoverCooldownRemaining(now - ARIA2_RECOVER_MIN_INTERVAL_MS, now), 0, '正好到期就该放行')
    assert.equal(recoverCooldownRemaining(now - 10 * ARIA2_RECOVER_MIN_INTERVAL_MS, now), 0)
})

test('不可恢复的解析失败：视频没了 / 仅好友可见 / 被禁，其余照旧', () => {
    assert.equal(isUnrecoverableParseFailure('errors.notFound'), true)
    assert.equal(isUnrecoverableParseFailure('{"message":"errors.privateVideo"}'), true)
    assert.equal(isUnrecoverableParseFailure('errors.forbidden'), true)
    assert.equal(isUnrecoverableParseFailure('TypeError: Failed to fetch'), false, '网络失败必须继续按网络路径退避')
    assert.equal(isUnrecoverableParseFailure('errors.invalidRequest'), false)
})

test('接线：站点说视频不可用时，不许再用旧直链重建', () => {
    const tracker = readSource('src/background/backends/aria2/tracker.ts')
    // 两条调用点都要拦：needsRebuild 直连重建、以及「原地换地址失败后降级重建」
    assert.equal((tracker.match(/if \(rebuilt && 'blocked' in rebuilt\) return await settleBlocked\(rebuilt\)/g) ?? []).length, 2, '被站点挡住的视频继续重建＝每轮留一条 0 B error（真机：私有视频每 40 秒一条）')
    assert.match(tracker, /async function failUnrecoverableVideo/, '要如实标失败并给出下一步')
    assert.match(tracker, /await describeParseFailure\(videoId, message\)/, '私有视频必须给出「去作者主页加好友」的入口，而不是一句 API 报文')
    const recover = readSource('src/background/backends/aria2/recover.ts')
    assert.match(recover, /if \(fresh && 'blocked' in fresh\) return \{ blocked: fresh\.blocked \}/, 'rebuild 的入口就要拦住，不能等 addUri 之后才发现')
})

test('扫描记忆：recoverAt 只收有限正数（脏值不锁死恢复）', () => {
    const parsed = parseScanMemory({ recoverAt: { ok: 1700000000000, bad: 'x', neg: -5, zero: 0, huge: Number.POSITIVE_INFINITY } })
    assert.deepEqual(parsed.recoverAt, { ok: 1700000000000 })
    assert.deepEqual(emptyScanMemory().recoverAt, {})
})

test('接线：恢复换 gid 必须清掉旧记录，且手动重建不受节流影响', () => {
    const tracker = readSource('src/background/backends/aria2/tracker.ts')
    assert.match(tracker, /recoverCooldownRemaining\(scanMemory\.recoverAt\[videoId\], Date\.now\(\)\)/, '没有冷却闸门，WS 错误事件会在十几秒内烧完 8 轮（真机实测 13 秒 / 8 次）')
    assert.match(tracker, /scanMemory\.recoverAt\[videoId\] = Date\.now\(\)/, '尝试时间必须记账，否则冷却无从判断')
    assert.match(tracker, /if \(result\.gid !== winner\.gid\) await aria2RemoveResult\(winner\.gid\)/, '换 gid 不清旧记录：每轮恢复都在 aria2 的 stopped 里留一条 error 残骸')
    // 收窄到 reset 函数体：手动「重建」必须能把节流一起清掉
    const start = tracker.indexOf('export async function resetAria2RecoveryState')
    assert.ok(start > 0)
    const body = tracker.slice(start, start + 900)
    assert.match(body, /delete scanMemory\.recoverAt\[videoId\]/, '手动重建不能被自动节流挡住')
})

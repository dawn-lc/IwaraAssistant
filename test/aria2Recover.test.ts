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

import { MAX_RECOVER_ATTEMPTS, MIN_SLOW_POLLS, SLOW_SPEED_THRESHOLD, aria2Progress, buildChangeUriParams, canRebuildFromOldUris, compareForKeep, emptyScanMemory, gidPriority, isFileConflictErrorCode, isLiveAria2Status, isAria2GidMissingError, parseScanMemory, planAria2Group, planResidualAdoption, recoverExhausted, shouldRestartForSlowSpeed, taskLatestExpiry } from '../src/shared/aria2Recover'
import { uriExpiresAt } from '../src/shared/url'
import { RETRY_MAX_ATTEMPTS } from '../src/shared/constants'

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

test('接线：liveLosers 的处置既 remove 也清结果（只 remove 会留下 stopped 记录，下轮又被收编）', () => {
    const body = trackerBody('stopLiveCopy')
    assert.match(body, /aria2\.remove'/, '必须真的停掉在跑的那份')
    assert.match(body, /aria2\.removeDownloadResult/, '只 remove 会留下记录，下轮扫描把它当另一个同源任务再收编 → 死循环')
})

test('接线：garbageLosers 的处置只清结果，不 remove（error/removed 已经不在活动队列里）', () => {
    const body = trackerBody('discardGarbageCopy')
    assert.match(body, /aria2\.removeDownloadResult/)
    assert.doesNotMatch(body, /aria2\.remove'/, '对已死任务发 remove 只会换回一个错误')
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

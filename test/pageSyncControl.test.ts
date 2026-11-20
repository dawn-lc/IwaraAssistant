/**
 * 站点遍历的**暂停 / 停止**接线守卫（源码级断言）。
 *
 * 为什么用源码断言：pageSync 顶层把 db（idb → indexedDB）拉进依赖链，node 单测 import 会直接炸；
 * 而这几条守的恰好是结构——闸门有没有插进循环、停止时游标是不是被当成「自然跑完」删掉。
 * 端到端行为要真站点，单测只能守到这一层。
 *
 * ⚠️ 源码守卫的生命线是**真的会红**：写完必须临时改坏一次确认。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readSource } from './sourceGuard'

const source = readSource('src/background/iwara/pageSync.ts')

test('两个遍历循环都必须过页间闸门（否则暂停按钮点了没反应）', () => {
    const gates = source.split('if (!(await awaitControl()))').length - 1
    assert.ok(gates >= 2, '全站遍历与订阅流都必须接闸门')
    assert.match(source, /while \(control === 'pause'\)/, '暂停必须是真的挂住，不是空转')
})

test('暂停期间必须有续命调用（否则 MV3 空闲 30 秒把任务回收，暂停等于必死）', () => {
    const gateStart = source.indexOf('async function awaitControl(')
    assert.notEqual(gateStart, -1, '未找到 awaitControl')
    const gateBody = source.slice(gateStart, source.indexOf('\n}\n', gateStart))
    assert.match(gateBody, /storage\.local\.get\(SYNC_PROGRESS_KEY\)/, '暂停循环里必须周期性调一次扩展 API')
    assert.match(gateBody, /PAUSE_HEARTBEAT_MS/, '续命间隔必须走常量，不要散落魔法数')
})

test('停止必须以「保留断点」收尾，不能走自然结束那条删游标的路径', () => {
    const stopAt = source.indexOf('if (stopped) {')
    assert.notEqual(stopAt, -1, '未找到停止分支')
    const branch = source.slice(stopAt, source.indexOf('\n        }\n', stopAt))
    assert.match(branch, /writeSyncCursor\(advanceSyncCursor\(contiguous, processed\)\)/, '停止必须把游标写到连续完成的最后一页')
    assert.doesNotMatch(branch, /clearSyncCursor\(/, '停止时删游标会让「下次继续」从第 0 页重翻几千页')
})

test('控制意图必须在起跑与收尾两侧复位（残留的 pause 会让下一轮自我暂停）', () => {
    const startAt = source.indexOf('export async function startSiteSync(')
    const startBody = source.slice(startAt, source.indexOf('\n}\n', startAt))
    assert.match(startBody, /control = 'run'/, '起跑必须清掉上一轮的控制意图')
    const settleAt = source.indexOf('async function settleRun(')
    const settleBody = source.slice(settleAt, source.indexOf('\n}\n', settleAt))
    assert.match(settleBody, /control = 'run'/, '收尾必须复位控制意图')
})

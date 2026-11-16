/**
 * MediaCenter 批量同步的**接线守卫**（源码级断言）。
 *
 * 为什么用源码断言而不是跑真实流程：`background/iwara/mediaCenter` 顶层就把
 * `db`（idb → `indexedDB`）拉进依赖链，node 单测里 import 会直接炸；
 * 而这几条要守的恰好是「结构」而非「计算」——串行循环会不会回来、
 * 进度有没有漏报跳过的条目、override 有没有偷偷多做一次往返。
 * 端到端行为由 `e2e/playwright/specs/media-center.spec.ts` 覆盖。
 *
 * ⚠️ 源码守卫的生命线是**真的会红**：写完必须临时改坏一次确认。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { repoRoot, readSource } from './sourceGuard'

const source = readSource('src/background/iwara/mediaCenter.ts')
const advancedSource = readSource('src/options/tabs/AdvancedTab.tsx')

test('阶段二必须用受限并发池，且并发度由 PUSH_CONCURRENCY 控制', () => {
    assert.match(source, /await runPool\(/, '阶段二必须调用 runPool')
    assert.match(source, /concurrency: PUSH_CONCURRENCY/, 'runPool 必须显式接收 PUSH_CONCURRENCY')
    assert.match(source, /const PUSH_CONCURRENCY = 6\b/, '并发度应与源项目一致（6）')
})

test('串行推送的旧实现不得回来（for-of + 150ms sleep）', () => {
    assert.doesNotMatch(source, /for \(const \[videoId, mediaCenterId\] of matched\)/, '串行 for-of 推送必须已删除')
    assert.doesNotMatch(source, /setTimeout\(resolve, 150\)/, '串行时代的 150ms 节流在并发 worker 里只是空转槽位')
})

test('进度必须覆盖「被跳过」的条目（跳过的记录也要计入已完成）', () => {
    // 解析失败 / 库里没有记录都走 return，只有 finally 才能保证进度条走到 total
    assert.match(source, /finally \{[\s\S]{0,200}reportPush\(\+\+settled, matched\.size\)/, '进度上报必须在 finally 里，且分母是映射总数')
})

test('阶段一只收「还没有映射」的候选（这是「全部已映射 → 零远端请求」的前提）', () => {
    assert.match(source, /if \(!matched\.has\(videoId\)\) candidates\.push\(videoId\)/, '候选必须过滤掉已有映射的视频')
})

test('override 命中时不得再回查 recordExists（省掉每条一次冗余往返）', () => {
    // `db.getIdmap` / `recordExists` 必须整体位于 `if (!mediaCenterId)` 分支内
    const branchStart = source.indexOf('if (!mediaCenterId) {')
    assert.notEqual(branchStart, -1, '未找到「没有记录 id 才回查」的分支')
    const branchEnd = source.indexOf('\n        }', branchStart)
    const branch = source.slice(branchStart, branchEnd)
    assert.match(branch, /db\.getIdmap\(/, '分支内应读取本地 idmap')
    assert.match(branch, /recordExists\(/, '分支内应验证映射有效性')
    // 分支外不允许再出现这两者（否则 override 路径又会多做一次请求）
    const outside = source.slice(0, branchStart) + source.slice(branchEnd)
    assert.doesNotMatch(outside, /await db\.getIdmap\(video\.ID\)/, 'db.getIdmap 只能出现在「没有 override」的分支里')
    assert.doesNotMatch(outside, /await recordExists\(/, 'recordExists 只能出现在「没有 override」的分支里')
})

// ── 进度通道：session 快照 + 订阅（不是轮询）──────────────────────

test('进度必须写进 storage.session 快照（页面订阅它，而不是轮询消息）', () => {
    const publishStart = source.indexOf('function publishProgress(')
    assert.notEqual(publishStart, -1, '未找到 publishProgress')
    const publishBody = source.slice(publishStart, source.indexOf('\n}', publishStart))
    assert.match(publishBody, /liveProgress = progress/, '内存仍是唯一运行真相')
    assert.match(publishBody, /browser\.storage\.session\.set\(\{ \[MEDIA_SYNC_PROGRESS_KEY\]/, '必须写 session 快照（写 local 会残留「正在同步」）')
    assert.doesNotMatch(publishBody, /storage\.local/, '进度不得落 local')
})

test('进入阶段二必须先上报（否则「全部已映射」时会一直显示读列表 0/0）', () => {
    const pushPublish = source.indexOf("stage: 'push'")
    const poolStart = source.indexOf('await runPool(')
    assert.notEqual(pushPublish, -1, '阶段二必须上报一次初始进度')
    assert.ok(pushPublish < poolStart, '阶段二的初始上报必须排在 runPool 之前')
})

test('读取进度必须做残骸归一（session 里的 running 不等于真在跑）', () => {
    const readStart = source.indexOf('export async function readMediaSyncProgress(')
    assert.notEqual(readStart, -1, '未找到 readMediaSyncProgress')
    const readBody = source.slice(readStart, source.indexOf('\n}', readStart))
    assert.match(readBody, /settleInterrupted\(/, '必须用不变量判定残骸，而不是直接信任 session')
})

test('终态快照必须先落盘再释放内存标记（顺序反了会把刚跑完的判成中断）', () => {
    const finallyStart = source.lastIndexOf('} finally {')
    const finallyBody = source.slice(finallyStart)
    const writeAt = finallyBody.indexOf('browser.storage.session.set')
    const clearAt = finallyBody.indexOf('liveProgress = null')
    assert.notEqual(writeAt, -1, 'finally 必须写终态快照')
    assert.notEqual(clearAt, -1, 'finally 必须释放内存标记')
    assert.ok(writeAt < clearAt, '必须先写终态再清 liveProgress')
})

test('options 页必须订阅快照（onChanged），而不是轮询进度消息', () => {
    // 页面侧统一走 `useStorageSnapshot`：它内部订阅 `storage.onChanged`，脏值经 parse 回落。
    // 断言放在 hook 里而不是页面文件里，是因为「订阅」这件事现在只有一处实现。
    const widgetSource = readSource('src/options/widgets.tsx')
    const hookStart = widgetSource.indexOf('export function useStorageSnapshot<T>(')
    assert.notEqual(hookStart, -1, '未找到 useStorageSnapshot')
    const hookBody = widgetSource.slice(hookStart)
    assert.match(hookBody, /browser\.storage\.onChanged\.addListener\(/, 'hook 必须订阅快照变更')
    assert.match(hookBody, /removeListener\(/, '卸载必须移除监听（否则每次切页签都泄漏一个）')
    assert.match(hookBody, /areaName !== area/, '只处理目标 storage 区的变更')

    // 页面只保留「取初值」这一次消息，且不得出现任何轮询
    const stateAt = advancedSource.indexOf('GET_MEDIA_SYNC_STATE')
    assert.notEqual(stateAt, -1, '挂载时要取一次初值（后台在那里做残骸归一）')
    assert.doesNotMatch(advancedSource, /setTimeout\(/, 'MediaCenter 进度不得轮询（长任务期间往返不受控）')
    assert.doesNotMatch(advancedSource, /\.poll|void poll/, '不得再出现轮询函数')
    assert.equal(advancedSource.split('GET_MEDIA_SYNC_STATE').length - 1, 1, 'GET_MEDIA_SYNC_STATE 只能用于挂载初值')
    // 旧协议 `GET_SYNC_STATE` 已删除：它只是第二条读取进度的路，留着就会有人再接一遍轮询
    assert.doesNotMatch(advancedSource, /GET_SYNC_STATE/, '遍历进度也必须走订阅，不得回退到消息轮询')
})

test('运行态必须同时看本地 busy 与快照 running（切页签回来不能丢）', () => {
    assert.match(advancedSource, /const mediaRunning = mediaBusy \|\| mediaProgress\?\.running === true/, '运行态必须是「本次点击 + 后台快照」的并集')
    // 按钮禁用与进度条都必须用 mediaRunning；用 mediaBusy 会让重挂载后的界面与后台脱节
    assert.match(advancedSource, /disabled=\{mediaRunning \|\|/, '按钮必须按 mediaRunning 禁用')
    assert.match(advancedSource, /mediaRunning \? <ProgressBar/, '进度条必须按 mediaRunning 渲染')
})

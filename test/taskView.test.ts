/**
 * 任务列表视图模型（`shared/taskView.ts`）。
 *
 * 这套规则决定「任务列表里每一行告诉用户做什么」，是系统通知做不了按钮/富文本之后
 * 那些交互的**唯一落点**。判错不会报错，只会让用户点了没反应或者被送到错的页面，
 * 所以每条规则都要能被单测逐条钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { sortTasks, taskCounts, taskGroupOf, taskPrimaryActionOf, taskSecondaryActionOf, taskProgressOf, taskStatusKey, isClearable, followUpOpenSettles } from '../src/shared/taskView'
import type { QueueTask } from '../src/shared/task'

function task(overrides: Partial<QueueTask> & Pick<QueueTask, 'status'>): QueueTask {
    return { id: 't1', videoId: 'v1', kind: 'aria2', ...overrides }
}

// ── 分组 ────────────────────────────────────────────────────────────────

test('分组：失败与跳过都是「需要处理」，其余三组各归各位', () => {
    assert.equal(taskGroupOf(task({ status: 'failed' })), 'attention')
    assert.equal(taskGroupOf(task({ status: 'skipped' })), 'attention')
    assert.equal(taskGroupOf(task({ status: 'running' })), 'active')
    assert.equal(taskGroupOf(task({ status: 'queued' })), 'active')
    assert.equal(taskGroupOf(task({ status: 'complete' })), 'done')
    // 已交付（iwaradl / 外部下载器）：活已经交出去了，扩展这边没有待办
    assert.equal(taskGroupOf(task({ status: 'handed-off' })), 'done')
})

test('跳过**不**属于「已完成」：它是悬而未决的待办，不是历史记录', () => {
    // 这条看似吹毛求疵，但它决定「清除已结束」会不会把用户唯一的找回入口抹掉
    assert.notEqual(taskGroupOf(task({ status: 'skipped' })), 'done')
})

test('进度：只在进行中显示（已完成/失败显示百分比毫无意义）', () => {
    assert.equal(taskProgressOf(task({ status: 'running', progress: 0.42 })), 0.42)
    assert.equal(taskProgressOf(task({ status: 'queued', progress: 0.42 })), 0.42)
    assert.equal(taskProgressOf(task({ status: 'complete', progress: 1 })), undefined)
    assert.equal(taskProgressOf(task({ status: 'failed', progress: 0.9 })), undefined)
    assert.equal(taskProgressOf(task({ status: 'skipped' })), undefined)
})

test('进度：未知就是 undefined，不能回退成 0（否则界面声称「刚开始」而实际快下完了）', () => {
    assert.equal(taskProgressOf(task({ status: 'running' })), undefined)
    assert.equal(taskProgressOf(task({ status: 'running', progress: Number.NaN })), undefined)
})

test('进度：脏值夹到 0~1（后端偶发给出 1.2 不能让进度条超出容器）', () => {
    assert.equal(taskProgressOf(task({ status: 'running', progress: 1.2 })), 1)
    assert.equal(taskProgressOf(task({ status: 'running', progress: -0.5 })), 0)
})

// ── 主操作 ──────────────────────────────────────────────────────────────
test('跳过行：主操作是「打开视频页」，不是重试（重试会再次被同一道门拦下）', () => {
    const action = taskPrimaryActionOf(task({ status: 'skipped', followUpUrl: 'https://www.iwara.tv/video/v1' }))
    assert.deepEqual(action, { kind: 'open', url: 'https://www.iwara.tv/video/v1', labelKey: 'tasks.actionOpenVideo' })
})

test('跳过行没有跳转目标时退化为强制下载（至少还能把视频下下来）', () => {
    assert.equal(taskPrimaryActionOf(task({ status: 'skipped' })).kind, 'force-download')
    assert.equal(taskPrimaryActionOf(task({ status: 'skipped', followUpUrl: '' })).kind, 'force-download')
})

test('失败的外部视频：主操作是「打开原始地址」，重试一万次也不会成功', () => {
    const action = taskPrimaryActionOf(task({ status: 'failed', followUpUrl: 'https://example.com/embed/1' }))
    assert.deepEqual(action, { kind: 'open', url: 'https://example.com/embed/1', labelKey: 'tasks.actionOpenSource' })
})

test('私有视频失败：主操作是「打开作者主页」，不能标成「打开原始地址」', () => {
    const action = taskPrimaryActionOf(task({ status: 'failed', followUpUrl: 'https://www.iwara.tv/profile/alice', followUpKind: 'author' }))
    assert.deepEqual(action, { kind: 'open', url: 'https://www.iwara.tv/profile/alice', labelKey: 'tasks.actionOpenAuthor' })
})

test('普通失败：主操作是重试', () => {
    assert.deepEqual(taskPrimaryActionOf(task({ status: 'failed' })), { kind: 'retry', labelKey: 'common.retry' })
})

test('已完成：主操作仍是重试（想再下一份）', () => {
    assert.equal(taskPrimaryActionOf(task({ status: 'complete' })).kind, 'retry')
})

test('已交付：主操作也是重试（外部下载器没接住时可以再交一次）', () => {
    assert.equal(taskPrimaryActionOf(task({ status: 'handed-off', kind: 'others' })).kind, 'retry')
})

test('进行中也有主操作槽位（由 UI 置灰）：行与行之间按钮不能错位', () => {
    // 若这里返回 null，running 行的移除按钮会顶到第一位，
    // 依赖「第一颗是主操作、最后一颗是移除」的用例与键盘顺序都会乱
    assert.equal(taskPrimaryActionOf(task({ status: 'running' })).kind, 'retry')
    assert.equal(taskPrimaryActionOf(task({ status: 'queued' })).kind, 'retry')
})

// ── 次操作 ──────────────────────────────────────────────────────────────

test('次操作：只有「已能打开视频页的跳过行」才额外给强制下载', () => {
    assert.deepEqual(taskSecondaryActionOf(task({ status: 'skipped', followUpUrl: 'https://www.iwara.tv/video/v1' })), { kind: 'force-download', labelKey: 'tasks.actionForceDownload' })
})

test('次操作：其它状态一律没有（避免同意义的两个入口）', () => {
    for (const status of ['failed', 'running', 'queued', 'complete', 'handed-off'] as const) {
        assert.equal(taskSecondaryActionOf(task({ status })), null, `${status} 不该有次操作`)
    }
    // 没有跳转目标的跳过行，主操作本身就是强制下载，再加一个就是重复
    assert.equal(taskSecondaryActionOf(task({ status: 'skipped' })), null)
})

test('次操作：私有视频失败必须同时给「重试」（加好友只是前置条件，还要对方通过）', () => {
    assert.deepEqual(taskSecondaryActionOf(task({ status: 'failed', followUpUrl: 'https://www.iwara.tv/profile/alice', followUpKind: 'author' })), { kind: 'retry', labelKey: 'common.retry' })
})

test('次操作：外部视频失败仍然不给重试（永远失败在 external Video 分支）', () => {
    assert.equal(taskSecondaryActionOf(task({ status: 'failed', followUpUrl: 'https://example.com/embed/1', followUpKind: 'external' })), null)
})

// ── 打开后续地址 = 手动处理完 ───────────────────────────────────────────
// 待办清单不能只进不出：用户打开视频页/原始地址去处理之后，记录必须自己消失。
// 但**只有待办能结**——重试复用同一条记录，旧通知点下去时它可能正在下载；
// 那种情况移除会先取消下载器，代价不该由误点承担。

test('打开后续地址：只有待办（失败/跳过）才结算', () => {
    for (const status of ['failed', 'skipped'] as const) assert.equal(followUpOpenSettles(task({ status })), true, `${status} 应结算`)
    for (const status of ['running', 'queued', 'complete', 'handed-off'] as const) assert.equal(followUpOpenSettles(task({ status })), false, `${status} 不该被「打开通知」结掉`)
})

// ── 接线守卫（缺失不会有任何类型错误）──────────────────────────────────

test('接线：任务页「打开」必须成功打开页面后再移除记录', () => {
    const source = readFileSync('src/options/tabs/TasksTab.tsx', 'utf8')
    const openIndex = source.indexOf('await browser.tabs.create({ url, active: true })')
    const removeIndex = source.indexOf("return send<RemoveResult>({ type: 'REMOVE_TASK'")
    assert.ok(openIndex > 0, '打开后续地址的调用应存在')
    assert.ok(removeIndex > 0, '打开后必须把待办从队列移除（否则「需要处理」只增不减）')
    assert.ok(openIndex < removeIndex, '顺序不能反：页面没打开就删记录等于把待办弄丢')
})

test('接线：点通知结算前必须复核任务当前状态（复用记录可能已是 running）', () => {
    const source = readFileSync('src/background/index.ts', 'utf8')
    const start = source.indexOf('browser.notifications.onClicked.addListener')
    const end = source.indexOf('// ── 启动恢复', start)
    assert.ok(start > 0 && end > start, '通知点击处理器应存在')
    const block = source.slice(start, end)
    assert.match(block, /findTask\(\{ id: target\.taskId \}\)/, '必须先取出这条任务')
    assert.match(block, /followUpOpenSettles\(task\)/, '必须按当前状态判断能不能结算')
    const guardIndex = block.indexOf('followUpOpenSettles(task)')
    const removeIndex = block.indexOf('removeTaskById(task.id)')
    assert.ok(guardIndex > 0 && removeIndex > guardIndex, '判据必须在移除之前')
})

test('接线：任务通知的目标必须带 taskId（不带就结不掉那条待办）', () => {
    const source = readFileSync('src/background/storage/queue.ts', 'utf8')
    assert.match(source, /taskId: task\.id/, 'notifyTask 的 url 目标必须登记对应的任务 id')
})

// ── 排序与计数 ──────────────────────────────────────────────────────────

test('排序：需要处理排最前，组内最近更新优先', () => {
    const now = 1_000_000
    const sorted = sortTasks([task({ id: 'done-old', videoId: 'done', status: 'complete', updatedAt: now - 500 }), task({ id: 'fail-old', videoId: 'failOld', status: 'failed', updatedAt: now - 400 }), task({ id: 'run', videoId: 'run', status: 'running', updatedAt: now - 100 }), task({ id: 'skip-new', videoId: 'skipNew', status: 'skipped', updatedAt: now - 50 })])
    assert.deepEqual(
        sorted.map((item) => item.videoId),
        ['skipNew', 'failOld', 'run', 'done']
    )
})

test('排序：没有时间戳的旧记录排在同组后面（不能因为缺字段就冒到顶上）', () => {
    const sorted = sortTasks([task({ id: 'legacy', videoId: 'legacy', status: 'failed' }), task({ id: 'new', videoId: 'newer', status: 'failed', updatedAt: 1000 })])
    assert.deepEqual(
        sorted.map((item) => item.videoId),
        ['newer', 'legacy']
    )
})

test('计数：跳过计入 attention，不计入 done —— 决定角标、标题与批量按钮的可用性', () => {
    const counts = taskCounts([task({ id: 'a', status: 'skipped' }), task({ id: 'b', status: 'failed' }), task({ id: 'c', status: 'running' }), task({ id: 'd', status: 'queued' }), task({ id: 'e', status: 'complete' }), task({ id: 'f', status: 'handed-off' })])
    assert.deepEqual(counts, { attention: 2, active: 2, done: 2, total: 6 })
})

test('清除已结束：可清的只有终态历史，跳过与进行中一律不清', () => {
    // `failed` 属于 pending 分组，但它确实是一次结束了的尝试 —— 用户有权一次性清掉
    for (const status of ['complete', 'failed', 'handed-off'] as const) assert.equal(isClearable(task({ status })), true, `${status} 应可清`)
    for (const status of ['running', 'queued', 'skipped'] as const) assert.equal(isClearable(task({ status })), false, `${status} 不可清`)
})

// ── 状态文案 ────────────────────────────────────────────────────────────

test('状态文案：每个状态 × 通道都有专属键，不会退化成显示原始英文状态名', () => {
    assert.equal(taskStatusKey(task({ status: 'skipped' })), 'skipped')
    assert.equal(taskStatusKey(task({ status: 'handed-off', kind: 'others' })), 'handedOff')
    assert.equal(taskStatusKey(task({ status: 'running', kind: 'aria2' })), 'runningAria2')
    // iwaradl 也有自己的文案：它现在能追踪，用户需要知道进度来自哪个后端
    assert.equal(taskStatusKey(task({ status: 'running', kind: 'iwaradl' })), 'runningIwaradl')
    assert.equal(taskStatusKey(task({ status: 'queued', kind: 'iwaradl' })), 'queuedIwaradl')
    assert.equal(taskStatusKey(task({ status: 'queued', kind: 'browser' })), 'queued')
})

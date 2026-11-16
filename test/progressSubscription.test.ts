/**
 * 「长任务进度」统一走快照订阅的**接线守卫**（源码级断言）。
 *
 * 背景：本仓库有三处会跑几分钟的批量任务，都踩过同一个坑 ——
 *
 * 1. 站点遍历（`SYNC_ALL_VIDEOS` / `SYNC_SUBSCRIBED`，写 `storage.local.syncProgress`）
 * 2. 好友一键审批（写 `storage.session.friendApproveProgress`）
 * 3. MediaCenter 批量同步（写 `storage.session.mediaSyncProgress`，见 `mediaCenterSync.test.ts`）
 *
 * 原来的写法是页面侧 `setTimeout` 轮询消息。它有两个必然发生的故障：
 * 长任务期间消息往返不受扩展控制（排队/延迟派发），一次被卡住进度就停在旧值；
 * 而 `catch` 之后不重建定时器 ⇒ 轮询**永久停止**，没有任何机制让它恢复。
 * 现在统一为：后台写快照 + 页面 `storage.onChanged` 订阅（`useStorageSnapshot`）。
 *
 * 另外还有一个同源的假状态：**「在跑」只由页面本地 state 判断**。
 * 用户切到别的页签再回来，组件重挂载、本地 state 归零 —— 进度条消失、按钮变回可点，
 * 而任务还在跑，再点一次就是两条并发的写入。所以每处都必须把
 * 「本地 busy ∪ 后台快照」当作判据。
 *
 * ⚠️ 源码守卫的生命线是**真的会红**：写完必须临时改坏一次确认。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readSource } from './sourceGuard'

const friendsSource = readSource('src/options/tabs/FriendsTab.tsx')
const legacyImportUi = readSource('src/options/tabs/migrate/LegacyDbImport.tsx')
const legacyImportBg = readSource('src/background/storage/legacyImport.ts')
const pageSyncSource = readSource('src/background/iwara/pageSync.ts')
const advancedSource = readSource('src/options/tabs/AdvancedTab.tsx')
const exportSource = readSource('src/options/tabs/migrate/ExportSection.tsx')

test('好友审批：页面订阅 session 快照，且只保留「取初值」这一次消息', () => {
    assert.match(friendsSource, /useStorageSnapshot<FriendApproveProgress>\(\{/, '必须用统一 hook 订阅快照')
    assert.match(friendsSource, /area: 'session'/, '审批进度是会话级数据')
    assert.match(friendsSource, /parse: parseFriendApproveProgress/, '快照必须经解析（脏值返回 null）')
    assert.equal(friendsSource.split('GET_FRIEND_APPROVE_STATE').length - 1, 1, 'GET_FRIEND_APPROVE_STATE 只能用于挂载初值')
    assert.doesNotMatch(friendsSource, /setTimeout\(/, '不得退化成轮询（一次失败就永久停更）')
    assert.doesNotMatch(friendsSource, /GET_FRIEND_APPROVE_STATE[\s\S]{0,400}setTimeout/, '取初值之后不得再排下一次')
})

test('好友审批：运行态 = 快照 running（不能只看本地 starting）', () => {
    // 按钮禁用与进度条都必须用派生的 running；用 starting 会让重挂载后的界面与后台脱节
    assert.match(friendsSource, /friendApproveView\(snapshot\)/, '运行态必须从快照派生')
    assert.match(friendsSource, /disabled=\{running \|\| starting/, '按钮必须按 running ∪ starting 禁用')
    assert.match(friendsSource, /running \? <ProgressBar/, '进度条必须按 running 渲染')
})

test('旧库导入：运行态必须包含后台的 importing 标记', () => {
    assert.match(legacyImportUi, /const running = busy \|\| info\?\.importing === true/, '「在跑」= 本地点击 ∪ 后台标记（重挂载后不能丢）')
    assert.match(legacyImportUi, /disabled=\{running\}/, '按钮必须按 running 禁用')
    // 进度文案与进度条共用同一份派生：分开算两遍必然在 total=0 这类边界上漂移
    assert.match(legacyImportUi, /const progressText = running \?/, '进度文案必须由 running 门控')
    assert.match(legacyImportUi, /\{progressText \? \([\s\S]{0,200}<ProgressBar/, '进度条与进度文案必须同源渲染')
})

test('旧库导入：后台必须自己维护 importing，而不是指望页面 state', () => {
    // 起跑前置位（中间任何 await 都可能让界面重挂载）
    const setTrueAt = legacyImportBg.indexOf('await markImporting(true)')
    const sendAt = legacyImportBg.indexOf('tabs.sendMessage(target.id')
    assert.notEqual(setTrueAt, -1, '发起导入前必须置 importing: true')
    assert.ok(setTrueAt < sendAt, '置位必须排在发消息之前')
    // 失败分支清位：不清就永远停在「导入中」——最难自行恢复的假状态
    assert.match(legacyImportBg, /finally \{[\s\S]{0,200}if \(!settled\) await markImporting\(false\)/, '失败分支必须清标记')
    // 成功分支写完整 info（含 importing: false）
    assert.match(legacyImportBg, /importing: false/, '成功分支要写终态 importing: false')
})

test('站点遍历：快照形状只有一处真源（shared），后台与页面都从那里取', () => {
    assert.match(pageSyncSource, /from '\.\.\/\.\.\/shared\/syncState'/, '后台必须用 shared 的 SyncState/parseSyncState')
    assert.match(advancedSource, /from '\.\.\/\.\.\/shared\/syncState'/, '页面必须用同一份（不许手抄一份 interface）')
    assert.doesNotMatch(pageSyncSource, /^interface SyncState\b/m, '旧的本地 interface 必须已删除')
    assert.doesNotMatch(advancedSource, /^interface SyncState\b/m, '旧的本地 interface 必须已删除')
    // 页面侧不得再 import background（分层铁律：会把 idb/indexedDB 拉进页面 bundle）
    assert.doesNotMatch(advancedSource, /from '\.\.\/\.\.\/background\//, 'options 不得 import background')
})

test('站点遍历：后台不再提供「给我当前进度」的消息（多一条路就会有人再接轮询）', () => {
    const protocol = readSource('src/messaging/protocol.ts')
    const router = readSource('src/background/index.ts')
    assert.doesNotMatch(protocol, /'GET_SYNC_STATE'/, '旧协议必须已删除')
    assert.doesNotMatch(router, /case 'GET_SYNC_STATE'/, '旧路由必须已删除')
    assert.doesNotMatch(pageSyncSource, /readSyncState/, '并发时直接回「已在跑」，不要再留一条读取路径')
})

// ── 遍历不得挂在消息响应里（Chrome 5 分钟单事件上限）──────────────────

test('遍历：路由只占位就返回，绝不 await 整轮', () => {
    const router = readSource('src/background/index.ts')
    assert.match(router, /case 'SYNC_ALL_VIDEOS':[\s\S]{0,600}return startSiteSync\('all', req\.payload\.from === 'restart' \? 'restart' : 'resume'\)/, '全站遍历必须走 startSiteSync（立即返回），起点由后台按游标决定')
    assert.match(router, /case 'SYNC_SUBSCRIBED':\s*\n\s*return startSiteSync\('subscribed'\)/, '订阅遍历同理')
    // 旧的「等跑完再返回」入口不得回来（它们返回 SyncState，正是 5 分钟上限的来源）
    assert.doesNotMatch(router, /syncAllVideosPages|parseUnlistedAndPrivate/, '不得再直接调用「跑完才返回」的实现')
})

test('遍历：startSiteSync 必须 void 起任务并在前面同步占位', () => {
    const startAt = pageSyncSource.indexOf('export async function startSiteSync(')
    assert.notEqual(startAt, -1, '未找到 startSiteSync')
    const body = pageSyncSource.slice(startAt, pageSyncSource.indexOf('\n}\n', startAt))
    // 同步占位：判断与占用之间不能夹 await，否则连点两次会起两条循环
    const claimAt = body.indexOf('running = true')
    const awaitAt = body.indexOf('await ')
    assert.notEqual(claimAt, -1, '必须同步占位 running')
    assert.ok(claimAt < awaitAt, '占位必须排在第一个 await 之前')
    // fire-and-forget：不 await 任务，否则又回到 5 分钟上限
    assert.match(body, /void \(kind === 'all' \? runAllVideos\(startPage\) : runSubscribed\(\)\)/, '任务必须 void 起（fire-and-forget），起点作为参数传入')
    assert.match(body, /return \{ started: true \}/, '占位后立即回 started')
    assert.doesNotMatch(body, /await (runAllVideos|runSubscribed)\(\)/, '不得 await 任务本身')
})

test('遍历：收尾必须先写终态快照再释放内存标记', () => {
    const settleAt = pageSyncSource.indexOf('async function settleRun(')
    assert.notEqual(settleAt, -1, '未找到 settleRun')
    const body = pageSyncSource.slice(settleAt, pageSyncSource.indexOf('\n}\n', settleAt))
    const writeAt = body.indexOf('await report(state)')
    // 取**最后**一处：函数开头还有 `state.running = false`（改的是快照对象，不是进程标记）
    const releaseAt = body.lastIndexOf('running = false')
    assert.notEqual(writeAt, -1, '收尾必须写终态快照')
    assert.notEqual(releaseAt, -1, '收尾必须释放内存标记')
    assert.ok(writeAt < releaseAt, '先落终态再清 running（反了会把刚跑完的判成中断）')
    // 两条循环都必须走同一个收尾（分头写一份必然有一处漏掉）
    assert.equal(pageSyncSource.match(/await settleRun\(state\)/g)?.length, 2, '两处遍历都必须调用 settleRun')
})

test('遍历：被杀掉的进程留下的「running:true」必须由 boot 归一', () => {
    const router = readSource('src/background/index.ts')
    assert.match(router, /await settleInterruptedSync\(\)/, 'boot 必须归一陈旧的遍历快照（否则进度条永远转圈）')
    const settleAt = pageSyncSource.indexOf('export async function settleInterruptedSync(')
    assert.notEqual(settleAt, -1, '未找到 settleInterruptedSync')
    const body = pageSyncSource.slice(settleAt, pageSyncSource.indexOf('\n}\n', settleAt))
    // 判据是**不变量**（内存里有没有任务），不能是心跳超时：遍历期间本来就可能是分钟级无写入
    assert.match(body, /if \(running\) return/, '已经有任务在跑就不是残骸（消息可能先于 boot 后半段到达）')
    assert.match(body, /!snapshot\.running/, '本来没在跑时一个字都不改')
    assert.match(body, /running: false, kind: null/, '归一结果必须显式关掉运行态')
})

test('遍历：每页开头都要写一次快照（进度来源 + SW 保活活动）', () => {
    // 5 分钟上限只作用于单个事件；fire-and-forget 之后靠「每页一次扩展 API 调用」
    // 重置 30 秒空闲计时器。若把逐页 report 改成只在开头/结尾写一次，
    // 任务会在第一个长 sleep 之后被回收，而且用户看不到进度。
    // 按**循环结构**断言（而不是数次数）：两条遍历都必须「设好页码 → 写文案 → 上报」。
    const perPage = pageSyncSource.match(/state\.page = page\s*\n\s*state\.message = [^\n]*\n\s*await report\(state\)/g) ?? []
    assert.equal(perPage.length, 2, '全站与订阅流两条遍历都必须在每页开头写快照')
})
// ── 断点续跑（全站遍历）────────────────────────────────────────────

test('游标：存 storage.session，且只做「连续推进」', () => {
    assert.match(pageSyncSource, /SYNC_CURSOR_KEY/, '游标键必须从 shared/storageKeys 取（不许在调用点拼字符串）')
    const writeAt = pageSyncSource.indexOf('async function writeSyncCursor(')
    assert.notEqual(writeAt, -1, '未找到 writeSyncCursor')
    const body = pageSyncSource.slice(writeAt, pageSyncSource.indexOf('\n}\n', writeAt))
    assert.match(body, /browser\.storage\.session\.set/, '游标必须存 session：落盘会让下次开浏览器从几天前的页码开始')
    assert.doesNotMatch(body, /storage\.local/, '不得写 local（那是给用户看的进度快照，用途不同）')
    // 连续推进：入参必须来自 advanceSyncCursor，不能是「当前页 + 1」这种按最大页推进的写法
    assert.match(pageSyncSource, /const advanced = advanceSyncCursor\(contiguous, processed\)/, '必须用连续推进')
    assert.match(pageSyncSource, /contiguous = advanced/, '推进结果必须写回 contiguous（否则下一轮又按旧的起点算）')
    assert.doesNotMatch(pageSyncSource, /writeSyncCursor\(page \+ 1\)/, '不得按「当前页 + 1」推进（会把失败那一页永久漏掉）')
})

test('游标：自然收尾才删，被打断的那一轮必须留着', () => {
    assert.match(pageSyncSource, /if \(unresolved\.length === 0\) await clearSyncCursor\(\)/, '一页不缺才删游标')
    assert.match(pageSyncSource, /else await writeSyncCursor\(contiguous\)/, '还有缺页就把游标停在最早那一页，否则「N 页失败」的提示是空话')
    // settleRun 是所有退出路径的收尾点：在那里清游标等于「永远不能续跑」
    const settleAt = pageSyncSource.indexOf('async function settleRun(')
    assert.notEqual(settleAt, -1, '未找到 settleRun')
    const settleBody = pageSyncSource.slice(settleAt, pageSyncSource.indexOf('\n}\n', settleAt))
    assert.doesNotMatch(settleBody, /clearSyncCursor/, '收尾函数不得清游标')
})

test('游标：「从头开始」必须在起跑之前删游标', () => {
    const startAt = pageSyncSource.indexOf('export async function startSiteSync(')
    assert.notEqual(startAt, -1, '未找到 startSiteSync')
    const body = pageSyncSource.slice(startAt, pageSyncSource.indexOf('\n}\n', startAt))
    const clearAt = body.indexOf("if (from === 'restart') await clearSyncCursor()")
    const runAt = body.indexOf('void (kind ===')
    assert.notEqual(clearAt, -1, 'restart 必须删游标')
    assert.ok(clearAt < runAt, '删游标要排在起跑之前（否则本轮从第 0 页跑完、游标还指着旧位置）')
    // 订阅流刻意不接游标（自动触发 + 5 分钟间隔，两套判据会互相打架）
    assert.match(body, /if \(kind === 'all'\) \{/, '只有全站遍历读游标')
})

test('游标：页面必须订阅 session 快照，并由它派生「有断点」', () => {
    assert.match(advancedSource, /useStorageSnapshot<SyncCursor>\(\{ area: 'session', key: SYNC_CURSOR_KEY/, '页面必须订阅断点游标')
    assert.match(advancedSource, /parse: parseSyncCursorOrIdle/, '解析器必须永不返回 null（游标合法地可以不存在）')
    assert.match(advancedSource, /const hasCursor = cursor\.nextPage > 0/, '「有断点」必须由游标派生')
    assert.match(advancedSource, /hasCursor \? t\('advanced\.syncResume'/, '有断点时主按钮必须变成「继续」')
    assert.match(advancedSource, /startSync\('all', 'restart'\)/, '必须保留显式「从头开始」入口（不许只做续跑）')
})

// ── 导出进度跨上下文（产物只能在文档里生成）──────────────────────────

test('导出：运行态必须在 session 快照里，不能只放页面 state', () => {
    assert.match(exportSource, /useStorageSnapshot<ExportRun>\(\{/, '必须用统一快照 hook')
    assert.match(exportSource, /area: 'session'/, '导出运行态是会话级数据')
    assert.match(exportSource, /browser\.storage\.session\.set/, '必须真的写快照（切页签重挂载才有东西可看）')
    assert.doesNotMatch(exportSource, /useState<\{ store: LegacyStore; done: number/, '旧的本地进度 state 必须已删除')
    assert.match(exportSource, /const running = localBusy !== null \|\| run\.status === 'running'/, '运行态 = 本地点击 ∪ 快照（重挂载后不能丢）')
    assert.match(exportSource, /disabled=\{running\}/, '两个按钮都必须按 running 禁用，否则会跑出第二轮全表遍历')
})

test('导出：判活用「问一句」，不用心跳超时', () => {
    assert.match(exportSource, /claimExportOwnership\(\)/, '生产者必须应答，否则另一个标签页会把它当残骸')
    assert.match(exportSource, /await isExportOwnerAlive\(\)/, '挂载时必须问一句还有没有页面在跑')
    assert.doesNotMatch(exportSource, /!await isExportOwnerAlive/, '反问分支不能写成永假条件')
    assert.doesNotMatch(exportSource, /Date\.now\(\) - [A-Za-z.]*updatedAt/, '不得用「多久没更新」猜死活：慢导出会被误判成中断')
    assert.match(exportSource, /releaseRef\.current = null/, '收尾必须关掉应答器（否则界面永远显示在跑）')
})

test('导出：成功写回 idle，不得删键', () => {
    // hook 把「解析不出来」当「不可信、保留上一份」→ 删键会让进度条永不消失（实测过）
    assert.doesNotMatch(exportSource, /storage\.session\.remove\(/, '不得删键')
    assert.match(exportSource, /publish\(\{ status: 'idle' \}\)/, '成功必须写回 idle 终态')
})

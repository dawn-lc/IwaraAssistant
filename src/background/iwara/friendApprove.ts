/**
 * 好友请求一键审批 —— 原 features/friendRequests.ts 的后台编排
 *
 * 流程：拉取全部收到的请求 → 按启用条件（any/all）逐条判定 → 满足者 POST 批准。
 * 与原版的差异：页面内注入按钮改为 options「好友」页触发（扩展页无注入竞态）。
 *
 * ## 为什么必须放在后台
 *
 * - `options_ui.open_in_tab: true` 意味着它是个**标签页**：用户关掉或刷新会让中间所有
 *   `fetch` 被中止，审批停在半路；后台不绑定任何标签页的生命周期。
 * - 隐藏/被遮挡标签页的 `setTimeout` 会被节流到 1 秒甚至更长——审批循环里那条
 *   `sleep` 会被放大几十倍。
 * - 并发锁只在单实例上下文里成立（两个 options 标签页会各有一把锁）。
 *
 * ## 运行状态的唯一真相是内存
 *
 * `liveTask` 存在 ⇔ 任务真的在跑（任务、变量、进程同生共死）。因此：
 * - 持久层（`storage.session`）只用于**把快照送给别的上下文**，不承载「是否在跑」；
 * - 读到 `running: true` 但 `liveTask` 为空 = 上一个进程的残骸，由 `settleInterrupted`
 *   归一为「已中断」（详见 `shared/approvalProgress.ts` 头部）。
 *
 * ## 为什么启动不返回结果
 *
 * `runtime.sendMessage` 的处理器受单事件时长上限约束（Chrome 为 5 分钟）。
 * 勾了评论类条件且主页评论极多时，真实耗时可能超过它——把结果绑在消息响应上，
 * 会让页面在任务仍在跑的时候先报错。所以启动只回 `{ started }`，**结果走同一条
 * 持久化快照**：无论消息通道是否还活着，终态都能被读到。
 */
import { getConfig } from '../storage/configStore'
import { fetchAllFriendRequests, getLocalUser } from './interactions'
import { fetchCommentsByUser } from './comments'
import { checkApprovalConditions, needsCommentEvidence, type ApprovalContext } from '../../shared/approvalConditions'
import { IDLE_FRIEND_APPROVE_PROGRESS, settleInterrupted, type FriendApproveProgress, type FriendApproveResult } from '../../shared/approvalProgress'
import { FRIEND_APPROVE_PROGRESS_KEY } from '../../shared/storageKeys'
import { addFriend } from './interactions'
import { notifyInfo } from '../runtime/notify'
import { i18n } from '../../shared/i18n'

/** 单条批准间的节流（避免请求风暴；原版同为 delay 节流） */
const APPROVE_INTERVAL_MS = 10

/**
 * 快照写入的最小间隔。
 *
 * 逐条处理时（间隔 10ms）不节流就是 N 次 `storage.session.set`，纯属浪费且会淹没
 * `onChanged`。200ms 对 1 秒轮询完全够用；**阶段切换与结束时强制写**，不会漏关键节点。
 * `storage.session` 是内存态，写它不产生磁盘 I/O，节流只省 CPU 与事件噪音。
 */
const PROGRESS_WRITE_INTERVAL_MS = 200

/** 逐条结果上限（消息与快照都不该被几百行文本撑大） */
const MAX_RESULT_LINES = 100

let lastProgressWriteAt = 0

/**
 * 正在跑的任务快照。**唯一的运行真相**：
 * - 非 null ⇔ 任务在跑（二者同生共死）；
 * - 进程被回收时它随之消失，所以不存在「内存说停了、实际还在跑」。
 */
let liveTask: FriendApproveProgress | null = null

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadRecord(): Promise<FriendApproveProgress | null> {
    try {
        const stored = (await browser.storage.session.get(FRIEND_APPROVE_PROGRESS_KEY))[FRIEND_APPROVE_PROGRESS_KEY]
        return (stored as FriendApproveProgress | undefined) ?? null
    } catch {
        // 没有 storage.session 的宿主：退化成「无快照」，只是看不到进度，不影响审批本身
        return null
    }
}

async function saveRecord(record: FriendApproveProgress, force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - lastProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return
    lastProgressWriteAt = now
    try {
        await browser.storage.session.set({ [FRIEND_APPROVE_PROGRESS_KEY]: { ...record, updatedAt: now } })
    } catch {
        // 写失败只影响进度可见性，不能打断审批
    }
}

/**
 * 读取当前快照（options 轮询用）。
 *
 * 归一逻辑放在这里，不依赖 `boot()` 的执行时机：
 * 「持久层说在跑、内存里没任务」在任何时刻都只可能是残骸，读到就顺手修掉。
 */
export async function readFriendApproveProgress(): Promise<FriendApproveProgress> {
    if (liveTask) return liveTask
    const stored = await loadRecord()
    if (!stored) return IDLE_FRIEND_APPROVE_PROGRESS
    const settled = settleInterrupted(stored, false)
    if (settled) {
        await saveRecord(settled, true)
        return settled
    }
    return stored
}

/** 启动结果：只表示「有没有真的开跑」，不承载审批结果（见文件头部） */
export interface StartApproveResult {
    started: boolean
    /** 已经在跑等，直接告知原因比让用户等一秒才知道更清楚 */
    error?: string
}

/** 收集评论证据（仅当启用条件里含评论类条件时抓取；失败降级为空证据） */
async function gatherCommentEvidence(conditionIds: string[], meId: string, threadId: string): Promise<Map<string, Map<string, string[]>>> {
    const evidence = new Map<string, Map<string, string[]>>()
    const tasks: Array<Promise<void>> = []

    if (conditionIds.includes('commentedProfile')) {
        tasks.push(
            fetchCommentsByUser('profile', meId)
                .then((byUser) => {
                    evidence.set('profile', byUser)
                })
                .catch(() => undefined)
        )
    }
    if (conditionIds.includes('commentedForumThread') && threadId !== '') {
        tasks.push(
            fetchCommentsByUser('forumThread', threadId)
                .then((byUser) => {
                    evidence.set(`forum:${threadId}`, byUser)
                })
                .catch(() => undefined)
        )
    }

    await Promise.all(tasks)
    return evidence
}

function resultLine(lines: string[], line: string): void {
    if (lines.length < MAX_RESULT_LINES) lines.push(line)
}

/**
 * 启动一键审批（options「好友」页按钮触发）。
 *
 * **不等待任务完成**：立刻回 `{ started: true }`，结果经快照送达。
 * 理由见文件头部「为什么启动不返回结果」。
 */
export function startFriendApproval(): StartApproveResult {
    // 并发锁：只在单实例上下文里成立，所以任务必须在后台跑
    if (liveTask) return { started: false, error: i18n.t('notify.friendAlreadyRunning') }

    const record: FriendApproveProgress = {
        running: true,
        phase: 'collecting',
        done: 0,
        total: 0,
        approved: 0,
        skipped: 0,
        failed: 0,
        startedAt: Date.now(),
        finishedAt: 0,
        updatedAt: 0
    }
    liveTask = record
    // 立刻写一次：否则第一次轮询（最多 1 秒后）读到的还是上一次的终态
    void saveRecord(record, true)
    void runApproval(record)
    return { started: true }
}

/** 真正干活的部分；**任何出口都必须经过 finally**，否则 `liveTask` 会永久占位 */
async function runApproval(record: FriendApproveProgress): Promise<void> {
    const config = getConfig()
    const result: FriendApproveResult = { total: 0, approved: 0, failed: 0, skipped: 0, lines: [] }

    try {
        const me = await getLocalUser()
        if (!me) {
            result.error = i18n.t('notify.notLoggedIn')
            return
        }

        const conditionIds = config.friendRequestApprovalConditions
        const mode = config.friendRequestApprovalMode
        if (conditionIds.length === 0) {
            result.error = i18n.t('notify.noConditions')
            return
        }

        const { requests, truncated } = await fetchAllFriendRequests(me.id)
        result.total = requests.length
        record.total = requests.length
        // 拉不全就必须说，不能表现得「就这么多」——用户否则会以为剩下的都被跳过了
        if (truncated) {
            result.truncated = true
            resultLine(result.lines, i18n.t('notify.friendTruncated', { n: requests.length }))
        }
        if (requests.length === 0) {
            resultLine(result.lines, i18n.t('notify.noPending'))
            return
        }

        const evidence = needsCommentEvidence(conditionIds) ? await gatherCommentEvidence(conditionIds, me.id, config.friendApproveEvidenceThreadId) : new Map<string, Map<string, string[]>>()

        // 证据齐了、总量也已知：从这里开始是确定态进度
        record.phase = 'deciding'
        await saveRecord(record, true)

        for (const entry of requests) {
            const context: ApprovalContext = {
                user: entry.user,
                commentEvidence: evidence,
                evidenceThreadId: config.friendApproveEvidenceThreadId
            }
            const label = `${entry.user.username}(${entry.user.id})`

            if (!checkApprovalConditions(conditionIds, mode, context)) {
                result.skipped++
                record.skipped++
                resultLine(result.lines, i18n.t('notify.friendSkipped', { name: label }))
            } else if (await addFriend(entry.user.id)) {
                result.approved++
                record.approved++
                resultLine(result.lines, i18n.t('notify.friendApproved', { name: label }))
            } else {
                result.failed++
                record.failed++
                resultLine(result.lines, i18n.t('notify.friendRejected', { name: label }))
            }

            record.done++
            await saveRecord(record)
            await sleep(APPROVE_INTERVAL_MS)
        }

        notifyInfo('friend-approve', i18n.t('notify.friendSummary', { approved: result.approved, skipped: result.skipped, failed: result.failed }), { kind: 'options', tab: 'friends' })
    } catch (error) {
        // 抛错也要留下原因：否则只看到一个「已中断」，没有任何解释
        result.error = error instanceof Error ? error.message : String(error)
    } finally {
        // 先落终态快照再释放 liveTask：顺序反了会出现「内存已空、存储仍写着 running」
        // 的短暂窗口，此时读取方会把刚跑完的这次误判成「已中断」。
        record.running = false
        record.phase = 'idle'
        record.finishedAt = Date.now()
        record.result = result
        await saveRecord(record, true)
        liveTask = null
    }
}

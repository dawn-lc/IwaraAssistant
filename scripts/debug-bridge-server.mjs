/**
 * 本地调试服务：接扩展推上来的快照，并给它下发白名单命令。
 *
 * 用法：
 *   node scripts/debug-bridge-server.mjs [port]        默认 8765
 *   http://127.0.0.1:8765/                            人看的摘要页
 *   http://127.0.0.1:8765/summary                     JSON 摘要（agent 用这个）
 *   http://127.0.0.1:8765/state                       最近一次完整 snapshot + 命令回执
 *   http://127.0.0.1:8765/command?command=scan        下发命令（也可 POST {"command":"retry","taskId":"..."}）
 *
 * 只绑定回环地址，不接受外部入站。扩展那边默认关闭这个通道（「高级」页 → 调试通道）。
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const port = Number.parseInt(process.argv[2] ?? '8765', 10) || 8765
const STATE_FILE = 'temp/debug-bridge-state.json'
let snapshot = null
let lastPollAt = 0
let results = []
let commands = []
let nextCommandId = 1

function reply(res, status, body, type = 'application/json; charset=utf-8') {
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(text)
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
}

function escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
    return String(value).replace(/[&<>"]/g, (char) => map[char])
}

/** 摘要：给 agent 读的最小集合（不把 800 多条任务全灌进上下文） */
function summary() {
    const tasks = snapshot?.tasks ?? []
    const failed = tasks.filter((task) => task.status === 'failed')
    const running = tasks.filter((task) => task.status === 'running')
    const logs = snapshot?.logs ?? []
    return {
        connected: Date.now() - lastPollAt < 30000,
        lastPollAgoMs: lastPollAt === 0 ? null : Date.now() - lastPollAt,
        version: snapshot?.version ?? null,
        runtime: snapshot?.runtime ?? null,
        counts: snapshot?.counts ?? null,
        taskTotal: tasks.length,
        failedCount: failed.length,
        failed: failed.slice(0, 30).map((task) => ({ id: task.id, videoId: task.videoId, detail: String(task.detail ?? '').slice(0, 200), kindRef: task.kindRef, attempts: task.attempts, updatedAt: task.updatedAt })),
        runningCount: running.length,
        running: running.slice(0, 20).map((task) => ({ id: task.id, videoId: task.videoId, progress: task.progress, kindRef: task.kindRef, updatedAt: task.updatedAt })),
        scanMemory: snapshot?.scanMemory ?? null,
        alarms: snapshot?.alarms ?? [],
        logs: logs.filter((entry) => entry.level !== 'info').slice(-40),
        lastInfoLogs: logs.filter((entry) => entry.level === 'info').slice(-20),
        pendingCommands: commands.length,
        results: results.slice(-10)
    }
}

function pageHtml() {
    const data = summary()
    const rows = data.failed.map((task) => '<tr><td>' + escapeHtml(task.videoId) + '</td><td>' + (task.attempts ?? '') + '</td><td>' + escapeHtml(task.detail) + '</td><td>' + escapeHtml(task.kindRef ?? '') + '</td></tr>').join('')
    const logs = data.logs.map((entry) => '<li>' + new Date(entry.at).toISOString() + ' [' + entry.level + '] ' + escapeHtml(entry.text) + '</li>').join('')
    const age = data.lastPollAgoMs === null ? '从未收到轮询' : Math.round(data.lastPollAgoMs / 1000) + ' 秒前最后一次轮询'
    return ['<!doctype html><meta charset="utf-8"><title>iwara-assistant 调试通道</title>', '<style>body{font:14px/1.5 system-ui;margin:24px;max-width:1100px}h1{font-size:18px}code{background:#f3f3f3;padding:1px 4px}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}ul{padding-left:18px}</style>', '<h1>iwara-assistant 调试通道</h1>', '<p>' + (data.connected ? '扩展已连接' : '未连接（' + age + '）') + ' · 版本 <code>' + (data.version ?? '?') + '</code> · ' + (data.runtime ?? '?') + '</p>', '<p>队列：' + JSON.stringify(data.counts ?? {}) + ' · 任务总数 ' + data.taskTotal + '</p>', '<p>' + ['snapshot', 'scan', 'logs'].map((name) => '<a href="/command?command=' + name + '">' + name + '</a>').join(' · ') + ' · <a href="/state">原始快照</a> · <a href="/summary">摘要 JSON</a></p>', '<h2>失败任务（前 30）</h2><table><tr><th>视频</th><th>尝试</th><th>详情</th><th>gid</th></tr>' + rows + '</table>', '<h2>警告与错误日志</h2><ul>' + logs + '</ul>'].join('\n')
}

function enqueue(parsed) {
    const command = { id: 'c' + nextCommandId++, command: String(parsed.command ?? ''), ...(parsed.taskId === undefined || parsed.taskId === '' ? {} : { taskId: String(parsed.taskId) }) }
    commands.push(command)
    console.log('[bridge] 排队命令', JSON.stringify(command))
    return command
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/poll') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (body.snapshot) snapshot = body.snapshot
        results = [...results, ...(body.results ?? [])].slice(-50)
        if (lastPollAt === 0) console.log('[bridge] 扩展已连接：' + (snapshot?.version ?? '?') + ' / ' + (snapshot?.runtime ?? '?'))
        lastPollAt = Date.now()
        try {
            writeFileSync(STATE_FILE, JSON.stringify({ lastPollAt, snapshot, results }, null, 2))
        } catch {
            // 落盘失败不影响调试
        }
        const deliver = commands
        commands = []
        return reply(res, 200, { commands: deliver })
    }
    if (req.method === 'POST' && url.pathname === '/command') {
        const raw = (await readBody(req)) || '{}'
        let parsed
        try {
            parsed = JSON.parse(raw)
        } catch {
            parsed = Object.fromEntries(new URLSearchParams(raw))
        }
        return reply(res, 200, { queued: enqueue(parsed) })
    }
    if (url.pathname === '/command') {
        return reply(res, 200, { queued: enqueue(Object.fromEntries(url.searchParams)) })
    }
    if (url.pathname === '/summary') return reply(res, 200, summary())
    if (url.pathname === '/state') return reply(res, 200, { lastPollAt, snapshot, results })
    if (url.pathname === '/') return reply(res, 200, pageHtml(), 'text/html; charset=utf-8')
    return reply(res, 404, { error: 'not found' })
})

server.listen(port, '127.0.0.1', () => {
    console.log('[bridge] 调试服务已启动：http://127.0.0.1:' + port + '/')
    console.log('[bridge] 在扩展「高级」页启用「调试通道」并填端口 ' + port + '，扩展就会主动连上来')
})

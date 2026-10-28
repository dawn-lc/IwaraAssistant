/**
 * pre-push 钩子 —— **把 CI 的 verify job 跑在本地**。
 *
 * ## 为什么值得在推送前跑一遍
 *
 * CI 的 `verify` job 就是这六步（见 `.github/workflows/ci.yml`）。等 CI 变成红灯再回来，
 * 一轮至少一分钟，而且失败的 run 会留在 Actions 里干扰「最近是否健康」的判断。
 * 同一个门禁在本地跑一次只要几十秒 —— 早发现一次就省一轮往返。
 *
 * 与 pre-commit 的分工是**成本分层**：
 * - pre-commit（每次提交）只做毫秒级的格式化，绝不跑类型检查 —— 慢的钩子会被 `--no-verify` 绕过；
 * - pre-push（每次推送）做事后不可撤销前**唯一一次**完整验证。
 *
 * ## 唯一的优化：只改文档时跳过
 *
 * 若本次推送的所有改动都是 `.md`，类型检查与构建不可能受影响，于是直接跳过。
 * 判据取**保守方向**：算不出改动清单（新分支、远端 ref 不在本地、stdin 为空）时
 * 一律跑全量，绝不因为「看起来像文档」而漏检。
 *
 * ## 逃生阀
 *
 * - `SKIP_PUSH_CHECKS=1 git push` —— 跳过整个门禁（急着推热修时用）
 * - `git push --no-verify` —— 同上，git 原生
 * - `HOOK_REFS="<localSha> <remoteSha>" ...` —— 手工复现某次推送的判定（调试用）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'

/**
 * npm 可执行文件。
 *
 * Windows 上直接 `spawnSync('npm.cmd', …)` 会报 **EINVAL**：Node 20 起禁止不经 shell
 * 启动 `.cmd`/`.bat`（CVE-2024-27980 的修复）。所以 Windows 必须带 `shell: true`，
 * 而那时 Node 只是把参数用空格拼成一行 —— 当前脚本名都不含空格，与 `build/env.ts` 同一套判据。
 */
const IS_WINDOWS = process.platform === 'win32'
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm'

/** 与 CI verify job 逐步对齐；顺序也一致（类型检查最便宜且最能定位问题） */
const STEPS = [
    { label: '类型检查（扩展 + 单测）', script: 'type-check' },
    { label: '类型检查（Playwright）', script: 'type-check:e2e' },
    { label: '类型检查（WDIO）', script: 'type-check:wdio' },
    { label: '单元测试', script: 'test:unit' },
    { label: '构建并打包（Chrome + Firefox）', script: 'build' },
    { label: 'Firefox 清单校验（web-ext lint）', script: 'lint:firefox' }
]

/**
 * 读取 git 从 stdin 送来的 ref 行：`<local ref> <local sha> <remote ref> <remote sha>`。
 *
 * 必须先把 stdin 读干净，否则 git 会认为钩子没消费输入而报错。
 * 手工执行（TTY）或输入为空时返回空数组 —— 调用方按「算不出改动」处理。
 */
function readRefLines() {
    // ⚠️ 顺序不能反：真实 `git push` 时 stdin 是管道（isTTY 为 false）走下面的读取；
    // 但在交互终端里手工执行时 isTTY 为 true，若先判 TTY 就会把下面这个调试开关短路掉。
    const override = process.env.HOOK_REFS?.trim()
    if (override !== undefined && override !== '') return [override]
    if (process.stdin.isTTY) return []
    try {
        return fs
            .readFileSync(0, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
    } catch {
        // stdin 已关闭 / 不可读：当作没有 ref 信息
        return []
    }
}

/** 本次推送涉及的改动文件；判断不了就返回 null（调用方据此跑全量） */
function changedFiles(refLines) {
    const files = []
    for (const line of refLines) {
        const [, localSha, , remoteSha] = line.split(/\s+/)
        // 删除分支 / 新分支：没有可比较的区间
        if (localSha === undefined || remoteSha === undefined) return null
        if (/^0+$/.test(localSha)) continue
        if (/^0+$/.test(remoteSha)) return null
        try {
            const out = execFileSync('git', ['diff', '--name-only', `${remoteSha}..${localSha}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            files.push(...out.split('\n').filter((file) => file !== ''))
        } catch {
            // 远端 sha 不在本地（没 fetch 过）：无法比较
            return null
        }
    }
    return files
}

function runStep(step) {
    console.log(`\n[pre-push] ▶ ${step.label}   (npm run ${step.script})`)
    const result = spawnSync(NPM, ['run', step.script], { stdio: 'inherit', shell: IS_WINDOWS })
    if (result.error !== undefined) return `无法执行 npm run ${step.script}：${result.error.message}`
    if (result.status !== 0) return `npm run ${step.script} 失败（退出码 ${String(result.status)}）`
    return null
}

function main() {
    if (process.env.SKIP_PUSH_CHECKS === '1') {
        console.log('[pre-push] SKIP_PUSH_CHECKS=1，跳过推送前检查')
        return 0
    }

    if (!fs.existsSync('node_modules')) {
        console.error('[pre-push] 找不到 node_modules：先跑 npm install 再推送（CI 一定会安装依赖并跑这些检查）')
        return 1
    }

    const refLines = readRefLines()
    const files = changedFiles(refLines)
    if (files !== null && files.length > 0 && files.every((file) => file.endsWith('.md'))) {
        console.log(`[pre-push] 本次推送只改动 ${files.length} 个 Markdown 文件，跳过检查`)
        return 0
    }

    console.log(`[pre-push] 开始本地门禁（与 CI verify job 同序），${String(STEPS.length)} 步`)

    for (const step of STEPS) {
        const failure = runStep(step)
        if (failure === null) continue
        console.error(`\n[pre-push] ✗ ${failure}`)
        console.error('[pre-push] 已阻止推送。修好后重新 push；确需跳过：`git push --no-verify` 或 `SKIP_PUSH_CHECKS=1 git push`\n')
        return 1
    }

    console.log(`\n[pre-push] ✓ 全部 ${String(STEPS.length)} 步通过\n`)
    return 0
}

process.exit(main())

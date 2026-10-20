/**
 * 带环境变量执行命令 —— npm scripts 的唯一外壳（scripts 里不要再写 `node -e`）。
 *
 * 为什么需要：npm scripts 里 `KEY=VALUE cmd` 只有 POSIX shell 认。原先 Windows 上靠
 * `node -e "process.env.X='1';process.exit(require('child_process').execSync(…))"` 顶了 6 份：
 * 引号在 PowerShell / cmd / bash 下解析规则不同，改一次命令要同步 6 处，
 * 而且 execSync 失败是抛异常（退出码语义靠未捕获异常兜），难以排错。
 *
 * 用法：node --import tsx/esm ./build/env.ts KEY=VALUE [KEY=VALUE …] -- <command> [args…]
 */
import { spawnSync } from 'node:child_process'

const separator = process.argv.indexOf('--')
if (separator === -1) {
    console.error('[env] 缺少 `--` 分隔符。用法：node --import tsx/esm ./build/env.ts KEY=VALUE … -- <command> [args…]')
    process.exit(1)
}

const env: NodeJS.ProcessEnv = { ...process.env }
for (const assignment of process.argv.slice(2, separator)) {
    const index = assignment.indexOf('=')
    if (index <= 0) {
        console.error(`[env] 不是 KEY=VALUE 形式：${assignment}`)
        process.exit(1)
    }
    env[assignment.slice(0, index)] = assignment.slice(index + 1)
}

const [executable, ...args] = process.argv.slice(separator + 1)
if (!executable) {
    console.error('[env] `--` 之后缺少要执行的命令')
    process.exit(1)
}

// Windows 上 npx / wdio 是 .cmd 垫片，必须经 shell 才能解析；而 shell 模式下 Node 只是把参数
// 用空格拼成一行（不替我们加引号）。当前所有脚本的参数都不含空格，遇到含空格的参数直接报错，
// 比让 cmd.exe 静默拆错参数要好排查。
if (process.platform === 'win32' && args.some((arg) => /\s/.test(arg))) {
    console.error(`[env] Windows 下不支持含空格的参数：${JSON.stringify(args.find((arg) => /\s/.test(arg)))}`)
    process.exit(1)
}

const result = spawnSync(executable, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
if (result.error) {
    console.error(`[env] 启动失败：${result.error.message}`)
    process.exit(1)
}
process.exit(result.status ?? 1)

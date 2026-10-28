/**
 * 把仓库的 git 钩子目录指向 `.githooks` —— 由 `npm install` / `npm ci` 的 `prepare` 自动执行。
 *
 * ## 为什么需要这一步
 *
 * git 默认只认 `.git/hooks`，而那个目录**不进版本控制**：字面意义上「无法在克隆时自带钩子」。
 * 官方给出的唯一可分发机制就是 `core.hooksPath`，所以必须有一次性配置。
 * 挂在 `prepare` 上是因为它在 `npm install` 之后自动跑，不需要用户记住任何命令。
 *
 * ## 三条必须遵守的约束
 *
 * 1. **绝不失败**：`prepare` 抛错会让 `npm install` / `npm ci` 整体失败。
 *    所以在非 git 环境（只解压源码）、CI 浅克隆、git 不可用时一律静默跳过。
 * 2. **不覆盖用户已有的 `core.hooksPath`**：别的工具（husky、pre-commit 框架）也可能设置它，
 *    抢过来会静默破坏对方的钩子。只有「未设置」或「已经是 .githooks」时才写入。
 * 3. **Windows 上 chmod 无意义**：Git for Windows 用自带 sh 执行钩子，不看可执行位；
 *    这里仍尝试一次 `chmodSync`，让 Linux/macOS 克隆后也能正常执行。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const TARGET = '.githooks'

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

try {
    git(['rev-parse', '--git-dir'])

    let current = ''
    try {
        current = git(['config', '--get', 'core.hooksPath'])
    } catch {
        // 未设置时 `git config --get` 退出码为 1，属正常情况
    }

    if (current !== '' && current !== TARGET) {
        console.log(`[hooks] core.hooksPath 已指向 "${current}"，保持不动（未安装提交前格式化）`)
    } else if (current === TARGET) {
        // 幂等：每次 npm install 都会跑到这里，不必重复打印
    } else {
        git(['config', 'core.hooksPath', TARGET])
        console.log(`[hooks] 已启用提交前自动格式化（core.hooksPath = ${TARGET}）`)
    }

    try {
        fs.chmodSync(`${TARGET}/pre-commit`, 0o755)
    } catch {
        // Windows 无此概念；或文件不存在——都不影响钩子工作
    }
} catch {
    // 非 git 仓库 / git 不可用：静默跳过，绝不让安装失败
}

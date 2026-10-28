/**
 * commit-msg 钩子 —— 校验提交消息符合本仓既有约定。
 *
 * ## 为什么值得自动检查
 *
 * 这个仓库的历史消息一直是 `<type>: <subject>`（`feat` / `fix` / `refactor` / `chore` / `ci` …），
 * 但约定只存在于人的记忆里。写错格式的代价不在这一条，而在**之后所有按前缀检索/生成 changelog 的场景**：
 * 一旦混进无前缀的消息，就没法可靠地把「修 bug」和「改文档」分开。
 *
 * 这类检查必须**便宜且判据明确**（毫秒级、不依赖任何工具链），否则会被 `--no-verify` 绕过。
 *
 * ## 允许的形态
 *
 * | 形态 | 例子 | 来源 |
 * |---|---|---|
 * | `<type>: <subject>` | `fix: 修复私有视频解析` | 手写 |
 * | `<type>(scope): <subject>` | `ci(actions): 升级到 v7` | 手写 |
 * | `<type>!: <subject>` | `feat!: 移除旧配置项` | 破坏性变更 |
 * | 纯版本号 | `0.1.32` / `v0.1.32` | `npm version` 自动生成 |
 * | 合并 / 回滚 / fixup | `Merge branch …` / `Revert "…"` / `fixup! …` | git 自动生成 |
 *
 * **刻意不检查长度**：本仓消息中英混排，硬性字符上限只会逼人删掉有用的说明。
 * 想写长就把细节放正文（第二个 `-m`），主题行保持一句话。
 */
import fs from 'node:fs'

/** 允许的类型 —— 取自仓库历史里真实出现过的前缀，加几个通用项。新增类型时改这一行即可。 */
const TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test']

/** `<type>` 或 `<type>(scope)`，可选 `!`，然后是冒号 + 空格 + 非空正文 */
const CONVENTIONAL = new RegExp(`^(?:${TYPES.join('|')})(?:\\([^()]+\\))?!?: \\S`)

/** `npm version` 产生的提交（本仓 `0.1.32` 这种），以及手工打的 `v` 前缀版本 */
const VERSION_ONLY = /^v?\d+(?:\.\d+)*$/

/** git 自己在合并/回滚/fixup/amend 时生成的主题行 */
const GIT_GENERATED = /^(?:Merge |Revert "|fixup! |squash! |amend! )/

function firstMeaningfulLine(message) {
    for (const raw of message.split(/\r?\n/)) {
        const line = raw.trimEnd()
        // `#` 开头是注释（git 默认模板）；`git commit -v` 的 diff 也在注释里
        if (line.trim() === '' || line.startsWith('#')) continue
        return line
    }
    return ''
}

function main() {
    const messagePath = process.argv[2]
    if (messagePath === undefined || messagePath === '') {
        // 拿不到消息文件（理论上不会发生）：不拦，报一声即可
        console.warn('[commit-msg] 未收到消息文件路径，跳过校验')
        return 0
    }

    let message
    try {
        message = fs.readFileSync(messagePath, 'utf8')
    } catch (error) {
        console.warn(`[commit-msg] 读取提交消息失败，跳过校验：${error.message}`)
        return 0
    }

    const subject = firstMeaningfulLine(message)
    if (subject === '') {
        // 空消息会被 git 自己拦下（除非 --allow-empty-message），这里不重复报错
        return 0
    }

    if (CONVENTIONAL.test(subject) || VERSION_ONLY.test(subject) || GIT_GENERATED.test(subject)) return 0

    console.error(`
[commit-msg] 提交消息不符合本仓约定：

    ${subject}

要求：<type>: <一句话说明>    例：fix: 修复私有视频解析后详情仍是 API 原文

可用的 type：${TYPES.join(' / ')}
  · 带影响范围：ci(actions): 升级到 v7
  · 破坏性变更：feat!: 移除旧配置项
  · npm version 产生的纯版本号、git 生成的 Merge/Revert/fixup 消息不受此限制

确需跳过：git commit --no-verify
`)
    return 1
}

process.exit(main())

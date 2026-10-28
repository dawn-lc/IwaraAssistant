#!/usr/bin/env node
/**
 * pre-commit 钩子的实际逻辑 —— **提交前把要提交的文件排好版**。
 *
 * ## 为什么在提交前做，而不是在 CI 里查
 *
 * CI 里的 `prettier --check` 是「事后报警」：它红的时候代码本身往往完全正确（只差几个空格），
 * 却让整条流水线后面的单测 / 构建 / `web-ext lint` / 上传产物全部 `skipped`——
 * 用最不重要的一项给整轮验证行使否决权。而且它只告诉你「不合格」，
 * 用户还得自己回去跑一次 `format`。
 *
 * 钩子则是「事前修好」：格式问题**根本没有机会进入提交**，CI 也就不必再为它设门。
 * 这不是降低标准，而是把同一件事放到它唯一能被自动解决的位置上。
 *
 * ## 三条安全性质（每一条都对应一种会丢用户工作的写法）
 *
 * 1. **只碰暂存的文件**：用 `git diff --cached` 取清单，不扫工作区。否则会把用户
 *    还没打算提交的改动一并格式化并 `git add` 进去。
 * 2. **暂存内容必须等于工作区内容**才动手（字节比较）：部分暂存（改了 A 段 add、又改了 B 段没 add）
 *    时，格式化工作区文件再 `git add` 会把 B 段也提交进去。这种情况**阻止提交**并给出解决办法，
 *    绝不自作主张。
 * 3. **只处理 prettier 认识且不被 `.prettierignore` 排除的文件**：`*.json`（locale / lock）、
 *    `dist`、`temp`、`reference`、录制快照都在 ignore 里，钩子必须与 `npm run format` 用同一套判据。
 *
 * 格式化失败（文件有语法错误）时阻止提交并打印 prettier 的原话 —— 那种情况下
 * 「帮你改好」是不可能的，硬提交进去只会在别的地方炸。
 *
 * 逃生阀：`git commit --no-verify`，或 `SKIP_FORMAT_HOOK=1 git commit ...`。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import prettier from 'prettier'

/** git 输出按 utf8 读（路径可能含中文；清单用 -z 分隔，不靠换行） */
function git(args) {
    return execFileSync('git', args, { encoding: 'utf8' })
}

/** 取这次提交的文件清单（排除删除；rename 取新路径） */
function stagedFiles() {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
        .split('\0')
        .filter((file) => file !== '')
}

async function main() {
    let files
    try {
        files = stagedFiles()
    } catch (error) {
        // 拿不到清单（不是 git 仓库 / git 版本异常）：不能因此拦住提交，如实说一声就走
        console.warn(`[format] 无法读取暂存文件，跳过格式化：${error.message}`)
        return 0
    }
    if (files.length === 0) return 0

    const formatted = []
    const unstaged = []
    const failures = []

    for (const file of files) {
        if (!fs.existsSync(file)) continue

        // 判据与 `npm run format` 完全同源：.prettierignore + prettier 能否推断出 parser
        const info = await prettier.getFileInfo(file, { ignorePath: '.prettierignore' })
        if (info.ignored || info.inferredParser === null) continue

        // 暂存版本 vs 工作区版本：不一致说明有未暂存的改动，格式化会把它一起提交
        const stagedBytes = execFileSync('git', ['show', `:${file}`], { maxBuffer: 256 * 1024 * 1024 })
        const workBytes = fs.readFileSync(file)
        if (!stagedBytes.equals(workBytes)) {
            unstaged.push(file)
            continue
        }

        const config = await prettier.resolveConfig(file)
        if (config === null) continue

        const source = workBytes.toString('utf8')
        try {
            const output = await prettier.format(source, { ...config, filepath: file })
            if (output === source) continue
            fs.writeFileSync(file, output)
            git(['add', '--', file])
            formatted.push(file)
        } catch (error) {
            failures.push(`${file}\n    ${String(error.message).split('\n').slice(0, 4).join('\n    ')}`)
        }
    }

    if (formatted.length > 0) {
        console.log(`[format] 已自动格式化并重新暂存 ${formatted.length} 个文件：`)
        for (const file of formatted) console.log(`  ${file}`)
    }

    if (failures.length > 0) {
        console.error(`\n[format] ${failures.length} 个文件无法格式化（prettier 报错），已阻止提交：`)
        for (const failure of failures) console.error(`  ${failure}`)
        console.error('\n修好后再提交；确需跳过请用 `git commit --no-verify`。\n')
        return 1
    }

    if (unstaged.length > 0) {
        console.error(`\n[format] ${unstaged.length} 个文件同时有「已暂存」与「未暂存」的改动，已阻止提交：`)
        for (const file of unstaged) console.error(`  ${file}`)
        console.error('\n直接格式化工作区文件会把未暂存的改动一起提交，所以这里不代劳。两种做法：')
        console.error('  · 把改动都暂存：`git add -u`（或 `git add <文件>`）后重新提交')
        console.error('  · 只提交已暂存部分：`git stash push --keep-index` → 提交 → `git stash pop`')
        console.error('  · 确需跳过：`git commit --no-verify`\n')
        return 1
    }

    return 0
}

process.exit(await main())

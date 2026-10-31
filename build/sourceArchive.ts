/**
 * 源码包（AMO 审核用）—— node --import tsx/esm ./build/sourceArchive.ts
 *
 * 为什么需要它：本项目用 esbuild 把多入口 TS 打成 IIFE 单文件，属于 AMO 政策里的
 * 「将多个文件合并为一的工具」。按 Add-on Policies 第 3.1 节，这类产物必须同时提交
 * **未经过二次处理的源码**与可复现的构建说明，否则审核员可以驳回。
 *
 * 为什么用 `git archive` 而不是手写 ZIP：它只导出**已跟踪**的文件，
 * `node_modules` / `dist` / `temp` / `.git` 天然被排除，不需要维护忽略清单。
 * 代价是导出的是 **HEAD 的内容**，所以工作区有未提交改动时会警告——
 * 那种情况下源码包与提交上去的安装包对不上，审核员会视为「无法复现」。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
const outfile = path.join('dist', `source-${version}.zip`)

const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

const dirty = git('status', '--porcelain').trim()
if (dirty !== '') {
    console.warn('[source] 工作区有未提交改动，源码包只含 HEAD 的内容：')
    for (const line of dirty.split('\n')) console.warn(`[source]   ${line}`)
    console.warn('[source] 先提交再打包，否则审核员无法按源码复现同一个安装包')
}

git('archive', '--format=zip', '-o', outfile, 'HEAD')
console.log(`[source] ${outfile}  v${version}`)
console.log('[source] 提交到 AMO 时同时给出构建说明：npm ci && npm run build:firefox → dist/firefox')

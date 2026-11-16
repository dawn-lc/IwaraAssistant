/**
 * 源码守卫的共用工具。
 *
 * ## 为什么需要剥注释
 *
 * 这些断言用「源码里有没有这段结构」来守行为。注释里提到旧实现（
 * 「以前是每 2s 发 `GET_SYNC_STATE`」「串行时代有 150ms 节流」）会让
 * `doesNotMatch` **假红**、`match` **假绿**，两边都得防。
 *
 * ## 为什么不是用正则吃掉块注释与行注释
 *
 * 因为这两种「注释起始」在真实代码里到处都是，而且**会出现在字符串里**：
 * `'*://*.iwara.tv/*'` 里就含 `/*`，`apiUrl('/videos')` 相邻处也能凑出组合。
 * 一旦按「从 `/*` 到下一个 `*／`」整段删除，被吃掉的往往是**后面成片的真实代码**
 * （本轮实测：`legacyImport.ts` 的 `await markImporting(true)` 整段消失，
 * 守卫于是在一段残缺文本上断言 —— 这是最容易骗过自己的假绿）。
 *
 * 所以改成**逐行判定**：只丢弃「行首（可有缩进）就是注释起始」的行
 * （`//` / `/*` / `*` / `*／`）。它永远不会截断代码行；代价是行尾注释会保留，
 * 那最多让 `doesNotMatch` 假红 —— 往更严格的方向失败，不会漏过真实回归。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 仓库根（`test/` 的上一级） */
export const repoRoot = path.resolve(import.meta.dirname, '..')

/**
 * 丢弃整行注释（行尾注释保留，理由见文件头）。
 *
 * **先归一换行**：本仓库的源码是 CRLF，而守卫里到处用 `indexOf('\n}\n')` 切函数体。
 * 不归一时那条切片永远返回 -1，`slice(start, -1)` 于是退回「除最后一个字符外的整个文件」——
 * 断言在整份源码上跑，`doesNotMatch` 必然被别处的同名标识符命中（假红），
 * 而 `match` 则可能在注释外的任何位置凑巧满足（假绿）。归一之后切片才是真的那个函数体。
 */
export function stripComments(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter((line) => !/^[ \t]*(\/\/|\/\*|\*)/.test(line))
        .join('\n')
}

/** 读仓库内的源文件并剥注释；`relative` 用正斜杠，例如 `src/options/widgets.tsx` */
export function readSource(relative: string): string {
    return stripComments(fs.readFileSync(path.join(repoRoot, relative), 'utf8'))
}

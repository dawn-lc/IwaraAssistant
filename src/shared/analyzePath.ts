/**
 * 本地路径分析 —— 原 core/path.ts Path 类的精简移植
 *
 * 词序与原实现一致：模板渲染（replaceVariable）在先，analyze 在后——变量已解析，
 * 段内不会再有 %#...#% 节点，故 AST 的"变量不透明节点"机制在此省略。
 * 保留：空路径/UNC 拒绝、Windows 盘符判定、'.'/'..' 导航解析（越界报错）、
 * Windows 段非法字符校验、directory/fullName/baseName/extension 提取。
 */
import { i18n } from './i18n'

export interface AnalyzedPath {
    /** 归一化后的完整路径（保留类型分隔符：Windows '\', Unix/Relative '/'） */
    fullPath: string
    /** 目录部分（含根） */
    directory: string
    /** 文件名（含扩展名） */
    fullName: string
    type: 'Windows' | 'Unix' | 'Relative'
    /** 扩展名（不含点） */
    extension: string
    /** 文件名（不含扩展名） */
    baseName: string
}

const WINDOWS_ILLEGAL = /[\\/:*?"<>|]/

export function analyzePath(input: string): AnalyzedPath {
    if (input === '') throw new Error(i18n.t('error.pathEmpty'))
    if (input.startsWith('\\\\')) throw new Error(i18n.t('error.pathUnc'))

    // 词法：分隔符（\ /）切分，记录首分隔符用于类型判定（原 tokenize 语义）
    const tokens: Array<{ kind: 'sep'; char: '\\' | '/' } | { kind: 'text'; value: string }> = []
    let start = 0
    for (let i = 0; i <= input.length; i++) {
        const ch = input[i]
        if (ch === '\\' || ch === '/' || i === input.length) {
            if (i > start) tokens.push({ kind: 'text', value: input.substring(start, i) })
            if (ch === '\\' || ch === '/') tokens.push({ kind: 'sep', char: ch })
            start = i + 1
        }
    }

    const first = tokens[0]
    const second = tokens[1]
    const isWindows = first?.kind === 'text' && /^[A-Za-z]:$/.test(first.value) && second?.kind === 'sep'
    const isUnix = !isWindows && first?.kind === 'sep' && first.char === '/'
    const type: AnalyzedPath['type'] = isWindows ? 'Windows' : isUnix ? 'Unix' : 'Relative'

    let root: string | null = null
    let index = 0
    if (isWindows && first?.kind === 'text') {
        root = first.value
        index = 2
    } else if (isUnix) {
        root = '/'
        index = 1
    }

    const names: string[] = []
    for (; index < tokens.length; index++) {
        const token = tokens[index]
        if (!token || token.kind === 'sep') continue
        if (token.value === '.') continue
        if (token.value === '..') {
            if (names.length === 0) throw new Error(i18n.t('error.pathEscape'))
            names.pop()
            continue
        }
        names.push(token.value)
    }
    if (names.length === 0) throw new Error(i18n.t('error.pathEmpty'))

    // 语义校验（对齐原 validate）：Windows 检查盘符与段内非法字符；Unix/Relative 只防空
    if (type === 'Windows') {
        if (!root || !/^[A-Za-z]:$/.test(root)) throw new Error(i18n.t('error.pathInvalid'))
        for (const name of names) {
            if (WINDOWS_ILLEGAL.test(name)) throw new Error(i18n.t('error.pathIllegalChars'))
        }
    }

    const sep = type === 'Windows' ? '\\' : '/'
    /**
     * 根前缀 —— 三个分支都要正确，源项目 `Path.render` 同义：
     * - Windows 绝对路径：`D:` + `\`；Unix 绝对路径：**保留前导 `/`**；
     * - 相对路径：无前缀（前导分隔符按冗余忽略，源项目注释同款）。
     *
     * ⚠️ 历史缺陷：这里曾写成 `type === 'Unix' && root !== null ? ''`，
     * 把 `/home/a/b.mp4` 渲染成 `home/a/b.mp4`（丢掉根），导致
     * iwaradl 通道的 `download_dir` 在 macOS/Linux 上变成相对路径。
     * 由 test/analyzePath.test.ts 守护。
     */
    const head = type === 'Windows' && root !== null ? root + sep : type === 'Unix' ? sep : ''
    const fullPath = head + names.join(sep)
    const fullName = names[names.length - 1]!
    // directory 是「fullPath 去掉文件名」，因此带尾分隔符（源项目 extractDirectory 同义）
    const directory = fullPath.slice(0, fullPath.length - fullName.length)
    const dotIndex = fullName.lastIndexOf('.')
    const baseName = dotIndex > 0 ? fullName.slice(0, dotIndex) : fullName
    const extension = dotIndex > 0 ? fullName.slice(dotIndex + 1) : ''

    return { fullPath, directory, fullName, type, extension, baseName }
}

/**
 * 转 downloads.download 的相对 filename：剥离盘符/根分隔符，统一 '/'。
 *
 * 两宿主都禁止绝对路径与 `..`，但**都支持子目录**：Chrome 一直支持；
 * Firefox 自 51 起支持（Bugzilla 1280044 早已 FIXED），会按 `/` 自动建目录。
 * 实测 Firefox 158：`filename: 'a/b/c.txt'` → `~/Downloads/a/b/c.txt`，`state: complete`。
 *
 * ⚠️ 历史缺陷：曾经对 Firefox 做「扁平化」（`/` 换 `_`），理由是那条 2016 年的
 * bug 未修——结论早过时，代价是同一份路径模板在两个宿主产生完全不同的目录结构。
 */
export function toDownloadFilename(analyzed: AnalyzedPath): string {
    let relative = analyzed.fullPath
    if (analyzed.type === 'Windows') relative = relative.replace(/^[A-Za-z]:/, '')
    relative = relative.replace(/^[/\\]+/, '').replaceAll('\\', '/')
    if (relative === '' || relative.startsWith('..')) throw new Error(i18n.t('error.pathRelative', { relative }))
    return relative
}

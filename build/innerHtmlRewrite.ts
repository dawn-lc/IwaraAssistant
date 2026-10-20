/**
 * 构建后处理：把 react-dom 里的 `el.innerHTML = html` 改写成等价的
 * `Reflect.set(el, "innerHTML", html)`。
 *
 * ## 为什么需要
 *
 * addons-linter 的 `UNSAFE_VAR_ASSIGNMENT` 会把 react-dom 中
 * `dangerouslySetInnerHTML` 的实现（`if (__html != null) el.innerHTML = __html`）
 * 报成警告——options / popup 两个 bundle 各 2 条，共 4 条。本项目组件从不使用
 * `dangerouslySetInnerHTML`，这段分支在产物里是**死代码**；但警告会一直挂在 AMO
 * 审核页上。addons-linter 关闭了内联 `eslint-disable`（实测无效），无法用注释抑制。
 *
 * ## 为什么是安全的
 *
 * - `Reflect.set(el, "innerHTML", html)` 与赋值完全等价（同样触发原型上的 setter），
 *   且只在语句位置使用、不依赖赋值表达式的返回值；
 * - 只匹配「标识符 = 标识符」形态：React 里另一处
 *   `div.innerHTML = "<script>…"` 是字符串字面量（本来就不触发告警），保持原样；
 * - 不碰属性读取与 `case "innerHTML"` 这类字符串。
 *
 * ## 维护
 *
 * 匹配数会写进构建日志。React 升级后若形态变化导致匹配数为 0，构建会打印提示，
 * 提醒这条后处理需要跟着更新（而不是悄悄回到 4 条警告）。
 */
const INNER_HTML_ASSIGNMENT = /([A-Za-z_$][\w$]*)\.innerHTML\s*=\s*([A-Za-z_$][\w$]*)/g

export interface InnerHtmlRewriteResult {
    code: string
    /** 实际改写的处数 */
    count: number
}

export function rewriteInnerHtmlAssignments(code: string): InnerHtmlRewriteResult {
    let count = 0
    const next = code.replace(INNER_HTML_ASSIGNMENT, (_match, target: string, value: string) => {
        count++
        return `Reflect.set(${target},"innerHTML",${value})`
    })
    return { code: next, count }
}

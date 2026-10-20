/**
 * 手动下载对话框（`#pluginOverlay`）—— 粘贴一批视频 ID / 链接后入队。
 *
 * 输入接受的形态（对齐源项目的手动下载框）：ID 列表用空格、`|`、中文逗号分隔；
 * 每一项既可以是裸 ID，也可以是完整链接（取路径里的 ID）。重复项去重。
 */
import { videoIdFromPath } from '../../shared/pageType'
import { i18n } from '../../shared/i18n'
import { OVERLAY_ID, hostNode } from './dom'
import { sendBatch } from './requests'

export function openManualDialog(): void {
    if (document.getElementById(OVERLAY_ID)) return

    const overlay = document.createElement('div')
    overlay.id = OVERLAY_ID

    const dialog = document.createElement('div')
    dialog.className = 'main'

    const title = document.createElement('p')
    title.textContent = i18n.t('page.manual.title')

    const hint = document.createElement('p')
    hint.textContent = i18n.t('page.manual.hint')

    const textarea = document.createElement('textarea')
    textarea.rows = 12
    textarea.placeholder = 'AeGUIRO2D5vQ6F|qQsUMJa19LcK3L'

    const row = document.createElement('div')
    row.className = 'ia-actions'

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ia-ghost'
    cancel.textContent = i18n.t('page.manual.cancel')
    cancel.addEventListener('click', () => overlay.remove())

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.textContent = i18n.t('page.manual.confirm')
    confirm.addEventListener('click', () => {
        const ids = textarea.value
            .split(/[\s|,，]+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 0)
            .map((token) => videoIdFromPath(token) ?? token)
            .filter((token, index, list) => list.indexOf(token) === index)
        overlay.remove()
        if (ids.length > 0) void sendBatch(ids)
    })

    row.appendChild(cancel)
    row.appendChild(confirm)
    dialog.appendChild(title)
    dialog.appendChild(hint)
    dialog.appendChild(textarea)
    dialog.appendChild(row)
    overlay.appendChild(dialog)
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) overlay.remove()
    })
    hostNode().appendChild(overlay)
    textarea.focus()
}

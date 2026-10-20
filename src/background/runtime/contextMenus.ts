/**
 * 右键菜单 —— 平台原生入口（docs/01：另一主交互入口，零注入成本）
 * 视频链接 / 视频页右键 → 提取视频 ID → 走 INIT_DOWNLOAD 同一链路
 *
 * 标题走 `shared/i18n` 而不是 `browser.i18n`：后者只跟随**浏览器**语言，
 * 用户在 options 里把界面改成日语后右键菜单仍会是英语。
 */
import { runDownload } from '../download/dispatch'
import { pageTypeOf } from '../../shared/pageType'
import { i18n } from '../../shared/i18n'

const MENU_PARENT = 'iwara-assistant-root'
const MENU_LINK = 'iwara-assistant-download-link'
const MENU_PAGE = 'iwara-assistant-download-page'

function videoIdFromUrl(raw: string | undefined): string | null {
    if (!raw) return null
    try {
        const match = new URL(raw).pathname.match(/\/video\/([^/?#]+)/)
        return match?.[1] ?? null
    } catch {
        return null
    }
}

/** 注册菜单（SW 重入幂等：先清空再建） */
export async function setupContextMenus(): Promise<void> {
    browser.contextMenus.removeAll(() => {
        browser.contextMenus.create({
            id: MENU_PARENT,
            title: i18n.t('app.name'),
            contexts: ['page', 'link', 'selection', 'video'],
            documentUrlPatterns: ['*://*.iwara.tv/*']
        })
        browser.contextMenus.create({
            id: MENU_LINK,
            parentId: MENU_PARENT,
            title: i18n.t('page.menu.downloadThis'),
            contexts: ['link'],
            targetUrlPatterns: ['*://*.iwara.tv/video/*', '*://www.iwara.tv/video/*']
        })
        browser.contextMenus.create({
            id: MENU_PAGE,
            parentId: MENU_PARENT,
            title: i18n.t('page.menu.downloadThis'),
            contexts: ['page'],
            documentUrlPatterns: ['*://*.iwara.tv/video/*', '*://www.iwara.tv/video/*']
        })
    })
}

export function onContextMenuClicked(info: chrome.contextMenus.OnClickData): void {
    if (info.menuItemId !== MENU_LINK && info.menuItemId !== MENU_PAGE) return
    const videoId = videoIdFromUrl(info.linkUrl) ?? videoIdFromUrl(info.pageUrl)
    if (!videoId) return
    // 页型从发起页 URL 推（源 `getPageTypeProbe()` 的等价物）：
    // 在**视频详情页**右键下载时不应再被「简介/评论有网盘链接」拦——用户正看着那些内容。
    const pageType = pageTypeFromUrl(info.pageUrl)
    // 与消息链路同一入口（等价于 INIT_DOWNLOAD 分支，省一次消息往返）
    void runDownload({ videoId, ...(pageType === undefined ? {} : { pageType }) })
}

/** 从 URL 取页型；URL 非法时交给调用方缺省（按非视频页处理，与源探针默认值一致） */
function pageTypeFromUrl(raw: string | undefined): ReturnType<typeof pageTypeOf> | undefined {
    if (!raw) return undefined
    try {
        return pageTypeOf(new URL(raw).pathname)
    } catch {
        return undefined
    }
}

/**
 * 下载执行器 —— 原 download/{download,aria2}.ts 的后台移植（4 通道）
 *
 * - browser：downloads.download（相对文件名，含子目录；两宿主同构）
 * - aria2：JSON-RPC addUri（cookie 经页面转发；WebSocket 追踪）
 * - iwaradl：POST /api/tasks
 * - others：后台标签页打开富化后的下载地址（替代 GM_openInTab）
 */
import { analyzePath, toDownloadFilename } from '../../shared/analyzePath'
import type { AnalyzedPath } from '../../shared/analyzePath'
import { ARIA2_TARGET, IWARADL_TARGET, callEndpoint } from '../../shared/endpoint'
import { parseIwaradlTasks } from '../../shared/iwaradlTask'
import { SITE_HOST } from '../../shared/site'
import { i18n } from '../../shared/i18n'
import { prune, stringify } from '../../shared/strings'
import type { FullVideoInfo } from '../../shared/videoInfo'
import { getPageCookie } from '../iwara/auth'
import { getConfig } from '../storage/configStore'
import { buildDownloadUrl, getDownloadPath } from './downloadPath'

export interface ChannelContext {
    /** 页面转发的 document.cookie（无则读最近快照） */
    cookie?: string
    overwrite?: boolean
}

// ── browser 通道（原 browserDownload：GM_download → downloads.download）──

/**
 * 浏览器下载失败文案映射（源 `browserDownloadErrorParse`）。
 *
 * `downloads.download` 的拒绕原因对用户完全不可读（`"Invalid URL"` / 裸错误对象），
 * 源项目把它们映射成人话；扩展里 Reject 仍是 Error（消息里带浏览器原文），
 * 所以这里按错误消息关键词归类，匹配不上时保留原文——
 * **宁可不翻译，也不能把原始信息丢掉**，否则用户无法上报。
 */
export function browserDownloadErrorParse(error: unknown): string {
    if (!(error instanceof Error)) return stringify(error)
    const raw = error.message
    // 浏览器侧的关键词：无下载权限 / 与该站点交互被限制 / 不支持该 URL / 保存失败
    if (/not permitted|notpermitted|access denied/i.test(raw)) return i18n.t('notify.browserDownloadNotPermitted')
    if (/not supported|unsupported|invalid url/i.test(raw)) return i18n.t('notify.browserDownloadNotSupported')
    if (/download.*(failed|not succeeded)|network/i.test(raw)) return i18n.t('notify.browserDownloadNotSucceeded', { detail: raw })
    return raw
}

export async function browserDownload(videoInfo: FullVideoInfo, ctx: ChannelContext): Promise<{ downloadId: number }> {
    void ctx
    const localPath = getDownloadPath(videoInfo)
    // 子目录两宿主都支持（Firefox 51+ 自动建目录），路径模板在哪个宿主都照原样生效
    const filename = toDownloadFilename(localPath)
    const downloadId = await browser.downloads.download({
        url: videoInfo.DownloadUrl,
        filename,
        conflictAction: ctx.overwrite ? 'overwrite' : 'uniquify'
    })
    return { downloadId }
}

// ── aria2 通道（原 aria2Download）────────────────────────────────────

import { aria2API } from '../backends/aria2/client'

interface Aria2TaskRef {
    gid: string
    downloadParams: Record<string, unknown>
}

/**
 * aria2 任务的 addUri 参数（`aria2Download` 与「重建任务」共用）。
 *
 * 不接收 `videoInfo`：这些选项全部来自**已渲染好的本地路径**与全局配置。
 * 重建时视频信息可能解析失败，若签名要求一个 video，调用方就得伪造一个假的——
 * 而假的字段一旦被用到就会写出错误文件名。这里只收真正需要的输入。
 */
export function aria2AddUriParams(localPath: AnalyzedPath, cookie: string): Record<string, unknown> {
    const config = getConfig()
    return prune({
        'force-save': true,
        'allow-overwrite': true,
        'all-proxy': config.downloadProxy,
        'all-proxy-passwd': config.downloadProxy !== '' ? config.downloadProxyPassword : undefined,
        'all-proxy-user': config.downloadProxy !== '' ? config.downloadProxyUsername : undefined,
        out: localPath.fullName,
        dir: localPath.directory,
        referer: SITE_HOST,
        header: [`Cookie:${cookie}`]
    })
}

export async function aria2Download(videoInfo: FullVideoInfo, ctx: ChannelContext): Promise<Aria2TaskRef> {
    const config = getConfig()
    const localPath = getDownloadPath(videoInfo)
    // 执行器统一经 buildDownloadUrl 注入 videoid/download 参数（与 others/browser 一致）
    const downloadUrl = buildDownloadUrl(videoInfo, localPath)
    const cookie = ctx.cookie ?? (await getPageCookie())
    const downloadParams = aria2AddUriParams(localPath, cookie)
    // 指令走 WS 实时通道（未连接时 aria2API 内部自动降级 HTTP）
    const res = await callEndpoint(ARIA2_TARGET, config.aria2Path, () => aria2API<string>('aria2.addUri', [[downloadUrl.href], downloadParams]))
    if (typeof res.result !== 'string' || res.result === '') throw new Error(i18n.t('notify.aria2Failed', { detail: stringify(res) }))
    return { gid: res.result, downloadParams }
}

// ── iwaradl 通道（原 iwaradlDownload）────────────────────────────────

/**
 * 投递到 iwaradl 守护进程，返回它的**任务主键**。
 *
 * 主键是 `vid`（视频 ID）——它的 API 就是 `/api/tasks/{vid}`，没有独立的 task id。
 *
 * ⚠️ 旧实现这里读的是 `body.id`，但 POST 的响应是**数组**
 * （`[{ vid, status, progress, created_at, options }]`），因此永远取不到，
 * 最后退化成 `crypto.randomUUID()` —— 那个 uuid 之后不可能与 iwaradl 里任何任务对上，
 * 所以 iwaradl 通道永远无法追踪。这不只是「不支持追踪」，是追踪代码写错了。
 */
export async function iwaradlDownload(videoInfo: FullVideoInfo, ctx: ChannelContext): Promise<{ taskId: string }> {
    const config = getConfig()
    const localPath = getDownloadPath(videoInfo)
    const cookie = ctx.cookie ?? (await getPageCookie())

    let proxyURL: URL | undefined
    if (config.downloadProxy !== '') {
        proxyURL = new URL(config.downloadProxy)
        proxyURL.username = config.downloadProxyUsername
        proxyURL.password = config.downloadProxyPassword
    }

    const response = await callEndpoint(IWARADL_TARGET, config.iwaradlPath, () =>
        fetch(config.iwaradlPath, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${config.iwaradlToken}`
            },
            body: JSON.stringify(
                prune({
                    urls: [`https://${SITE_HOST}/video/${videoInfo.ID}`],
                    options: {
                        proxy_url: proxyURL ? proxyURL.href : undefined,
                        cookies: cookie,
                        download_dir: localPath.directory,
                        filename_template: localPath.fullName
                    }
                })
            )
        })
    )
    if (!response.ok) throw new Error(`iwaradl ${response.status}: ${stringify(await response.text())}`)
    const created = parseIwaradlTasks((await response.json().catch(() => undefined)) as unknown)
    // 以响应里的 vid 为准；万一它没回（老版本/格式差异）就用自己的视频 ID——
    // 对账是按 vid 查的，用 videoInfo.ID 仍然能对上，而随机 uuid 一定对不上
    return { taskId: created[0]?.vid ?? videoInfo.ID }
}

// ── others 通道（原 othersDownload：GM_openInTab 直链）────────────────

export async function othersDownload(videoInfo: FullVideoInfo, ctx: ChannelContext): Promise<{ tabId: number }> {
    void ctx
    const localPath = getDownloadPath(videoInfo)
    const downloadUrl = buildDownloadUrl(videoInfo, localPath)
    const tab = await browser.tabs.create({ url: downloadUrl.href, active: false })
    return { tabId: tab.id ?? -1 }
}

// ── 元数据 JSON（原 generateMetadata* / browserDownloadMetadata）──────

function generateMetadataContent(videoInfo: FullVideoInfo): string {
    const metadata = Object.assign({}, videoInfo, {
        DownloadPath: getDownloadPath(videoInfo).fullPath,
        MetaDataVersion: browser.runtime.getManifest().version
    })
    return JSON.stringify(metadata, null, 2)
}

/** 元数据 JSON 下载（autoDownloadMetadata 开关；blob URL + downloads API） */
export async function downloadMetadata(videoInfo: FullVideoInfo): Promise<void> {
    const localPath = getDownloadPath(videoInfo)
    const metadataContent = generateMetadataContent(videoInfo)
    const blobUrl = URL.createObjectURL(new Blob([metadataContent], { type: 'text/plain' }))
    const filename = toDownloadFilename(analyzePath(`${localPath.directory}/${localPath.baseName}.json`))
    try {
        await browser.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify' })
    } finally {
        // 下载已登记（browser 端持有引用）； revoke 延迟到空闲，SW 挂起时由浏览器回收
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    }
}

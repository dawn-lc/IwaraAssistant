/**
 * 向后台发起下载请求 —— 页内所有「要下载」的动作只从这里出去。
 *
 * 两个入口刻意分开：
 * - `sendBatch` 走 `BATCH_DOWNLOAD`（后台有进程内互斥，连点会被拒绝）
 * - `sendOne` 走 `INIT_DOWNLOAD`（单条下载不该被「上一批还在跑」挡住）
 *
 * 消息失败只 `console.warn`：页内没有状态反馈通道（通知走后台 notifications），
 * 弹一个页内 toast 会与站点自身的提示打架。
 */
import { pageTypeOf } from '../../shared/pageType'

/** 批量入队（后台串行执行；返回结果经 notifications 汇报） */
export async function sendBatch(videoIds: string[]): Promise<void> {
    try {
        // pageType 供后台的 `checkDownloadLink` 判定：视频详情页不检查（源 `getPageTypeProbe() !== Video`）
        await browser.runtime.sendMessage({ type: 'BATCH_DOWNLOAD', payload: { videoIds, pageType: pageTypeOf(window.location.pathname) } })
    } catch (error) {
        console.warn('[iwara-assistant] batch download failed:', error)
    }
}

/** 单条入队（不走批量互斥） */
export async function sendOne(videoId: string): Promise<void> {
    try {
        await browser.runtime.sendMessage({ type: 'INIT_DOWNLOAD', payload: { videoId, pageType: pageTypeOf(window.location.pathname) } })
    } catch (error) {
        console.warn('[iwara-assistant] download failed:', error)
    }
}

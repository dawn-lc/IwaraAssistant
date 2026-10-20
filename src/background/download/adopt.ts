/**
 * 「接管」others 通道的下载 —— 把「已交付、之后再也看不到」升级成可追踪。
 *
 * ## 为什么可能
 *
 * `others` 通道做的事是：后台开一个标签页指向拼好的直链。浏览器接着会**自己**把那个地址
 * 当成一次下载（`downloads` API 里能看到它）。也就是说结果其实是有回传的，
 * 只是回传落在浏览器自己的下载管理器里、而不是我们的任务记录上。
 *
 * 判据是扩展在直链里注入的 `videoid` 参数（`buildDownloadUrl` 统一加的，
 * 与 aria2 的「任务反查」用的是同一个标记）。命中「同视频的 others 任务」就绑定过去。
 *
 * ## 为什么接管后把 kind 改成 browser
 *
 * 因为从这一刻起**确实是浏览器在下载**：进度、完成、中断都来自 `downloads`，
 * 取消走 `downloads.cancel`。保留 `kind: 'others'` 会让 `cancelStrategyOf`
 * 判成「不可取消」，删记录就变成「看着它在后台继续下」。
 *
 * 接管是**单向的升级**：`handed-off`（已交付、不可追踪）→ `running`（可追踪）。
 * 没有被接管的 `others` 任务保持原样，不会因此变成僵尸。
 */
import { i18n } from '../../shared/i18n'
import { videoIdOfDownloadUrl } from '../../shared/url'
import { getTasks, notifyTask, patchTask } from '../storage/queue'

/**
 * 尝试接管一次浏览器下载。返回是否接管成功。
 *
 * 只认「`others` 且状态为 `handed-off`」的任务：`handed-off` 表示我们已经把活交出去、
 * 正等着一个能追踪它的机会。已经在追踪的任务（有 `kindRef`）不会被抢。
 */
export async function adoptHandedOffDownload(item: { id: number; url: string }): Promise<boolean> {
    const videoId = videoIdOfDownloadUrl(item.url)
    if (videoId === undefined) return false
    const task = getTasks().find((candidate) => candidate.videoId === videoId && candidate.kind === 'others' && candidate.status === 'handed-off')
    if (!task) return false

    const patched = await patchTask(task.id, {
        kind: 'browser',
        kindRef: String(item.id),
        status: 'running',
        detail: i18n.t('tasks.adoptedByBrowser')
    })
    if (!patched) return false

    // 极快的小文件可能在接管之前就下完了：`onChanged` 只会在那一刻找一次 kindRef，
    // 找不到就永远错过了。所以接管后必须自己复核一次当前状态。
    const [current] = await browser.downloads.search({ id: item.id }).catch(() => [])
    if (!current) return true
    if (current.state === 'complete') {
        const done = await patchTask(task.id, { status: 'complete', detail: undefined })
        if (done) await notifyTask(done)
    } else if (current.state === 'interrupted') {
        const failed = await patchTask(task.id, { status: 'failed', detail: current.error })
        if (failed) await notifyTask(failed)
    }
    return true
}

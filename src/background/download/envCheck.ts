/**
 * 保存前 / 启动时的环境自检 —— 原 network/envCheck.ts 的后台移植
 *
 * 源项目的 `check()` 分三步：本地路径模板能否渲染 → 按下载通道探测端点 → 浏览器环境。
 * 目的是**在用户真正开始下载之前**就指出配置错在哪，而不是等他选了一堆视频、
 * 点了下载之后才收到「全部失败」。
 *
 * 与源的平台差异（必须在报告里说明）：
 * - `EnvCheck`：源判断油猴脚本的 `downloadMode` 是否走了浏览器 API；扩展本来就只有
 *   `downloads` API 一条路，所以改为检查 `downloads` 权限是否仍被授予。
 * - 触发时机：源在页面加载时跑一次；扩展的 service worker 约 30 秒空闲就挂起，
 *   `boot()` 会在每次唤醒时重跑——在那里面做网络探测等于每 30 秒打一次 aria2。
 *   所以改为「options 页加载时 + 用户点测试按钮 + 下载开始前」，
 *   语义（早于下载指出配置问题）不变，频率可控。
 */
import { i18n } from '../../shared/i18n'
import { ARIA2_TARGET, IWARADL_TARGET, callEndpoint } from '../../shared/endpoint'
import { DownloadType } from '../../shared/configSchema'
import { stringify } from '../../shared/strings'
import { getConfig } from '../storage/configStore'
import { aria2API } from '../backends/aria2/client'
import { getDownloadPath } from './downloadPath'
import type { FullVideoInfo } from '../../shared/videoInfo'

/** 自检结果：`step` 指出是哪一步失败，便于 UI 直接高亮对应设置分区 */
export interface CheckResult {
    ok: boolean
    step: 'path' | 'aria2' | 'iwaradl' | 'browser' | null
    message: string
}

const PASS: CheckResult = { ok: true, step: null, message: '' }

/** 路径模板自检用的假视频（源用 `test` 占位，此处补齐 getDownloadPath 需要的字段） */
const PROBE_VIDEO: FullVideoInfo = {
    Type: 'full',
    ID: 'test',
    Title: 'test',
    Alias: 'test',
    Author: 'test',
    DownloadUrl: 'https://www.iwara.tv/video/test',
    DownloadQuality: 'test',
    UploadTime: 0,
    FileName: 'test'
} as FullVideoInfo

/**
 * 本地路径模板是否有效（源 `localPathCheck`）。
 *
 * 用一份假数据把模板渲染一遍：能渲染出非空 `fullPath` 才算通过。
 * 这一步能抓住「模板里写了不存在的变量」「整条模板被 sanitize 清空」这类
 * 在真正下载时才会炸、而且炸得很难看的配置错误。
 */
export function localPathCheck(): CheckResult {
    try {
        const path = getDownloadPath(PROBE_VIDEO)
        if (path.fullPath === '') throw new Error('analyzeLocalPath isEmpty')
        return PASS
    } catch (error) {
        return { ok: false, step: 'path', message: i18n.t('notify.downloadPathError', { detail: stringify(error) }) }
    }
}

/** aria2 RPC 连通性（源 `aria2Check`：tellActive 能通且无 error 字段） */
async function aria2Check(): Promise<CheckResult> {
    const config = getConfig()
    try {
        const res = await callEndpoint(ARIA2_TARGET, config.aria2Path, () => aria2API<unknown[]>('aria2.tellActive', []))
        if (res.error !== undefined) {
            return { ok: false, step: 'aria2', message: i18n.t('notify.connectionTestFailed', { target: 'aria2', detail: stringify(res.error) }) }
        }
        return PASS
    } catch (error) {
        return { ok: false, step: 'aria2', message: i18n.t('notify.connectionTestFailed', { target: 'aria2', detail: stringify(error) }) }
    }
}

/** iwaradl 连通性（源 `iwaradlCheck`：GET 端点必须返回数组） */
async function iwaradlCheck(): Promise<CheckResult> {
    const config = getConfig()
    try {
        const body = await callEndpoint(IWARADL_TARGET, config.iwaradlPath, async () => {
            const response = await fetch(config.iwaradlPath, {
                method: 'GET',
                headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${config.iwaradlToken}` }
            })
            if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
            return await response.json()
        })
        if (!Array.isArray(body)) {
            return { ok: false, step: 'iwaradl', message: i18n.t('notify.connectionTestFailed', { target: 'iwaradl', detail: i18n.t('notify.iwaradlNotReady') }) }
        }
        return PASS
    } catch (error) {
        return { ok: false, step: 'iwaradl', message: i18n.t('notify.connectionTestFailed', { target: 'iwaradl', detail: stringify(error) }) }
    }
}

/**
 * 浏览器环境（源 `EnvCheck` 的扩展版）：`downloads` 权限是否仍被授予。
 *
 * 用户可以在扩展管理页单独关掉「下载文件」权限，此时 `downloads.download()` 会抛
 * `not_permitted`。提前检查能把「权限被关」和「网盘真的不给文件」区分开。
 */
async function browserCheck(): Promise<CheckResult> {
    try {
        const granted = await browser.permissions.contains({ permissions: ['downloads'] })
        if (!granted) return { ok: false, step: 'browser', message: i18n.t('notify.browserDownloadNotPermitted') }
        return PASS
    } catch (error) {
        return { ok: false, step: 'browser', message: i18n.t('notify.connectionTestFailed', { target: 'browser', detail: stringify(error) }) }
    }
}

/**
 * 按当前 `downloadType` 执行对应自检（源 `check`）。
 *
 * 路径检查永远先跑：模板渲染不了的话，后面三个通道哪个通了都没意义。
 * `others` 通道不需要额外探测——它就是打开一个标签页。
 */
export async function check(): Promise<CheckResult> {
    const pathResult = localPathCheck()
    if (!pathResult.ok) return pathResult
    switch (getConfig().downloadType) {
        case DownloadType.Aria2:
            return aria2Check()
        case DownloadType.Iwaradl:
            return iwaradlCheck()
        case DownloadType.Browser:
            return browserCheck()
        default:
            return PASS
    }
}

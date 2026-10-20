/**
 * 下载路径渲染 —— 原 download/downloadPath.ts 移植
 * 模板渲染（sanitize 规则链）→ analyzePath；四通道统一经 buildDownloadUrl 富化地址
 */
import { analyzePath, type AnalyzedPath } from '../../shared/analyzePath'
import { replaceEmojis, replaceVariable, truncate } from '../../shared/strings'
import type { FullVideoInfo } from '../../shared/videoInfo'
import { getConfig } from '../storage/configStore'

/** 文件名规范化（TITLE/ALIAS 共用规则链，仅截断长度不同；与原实现逐项对齐） */
function sanitize(source: string, maxLength: number, cfg: ReturnType<typeof getConfig>): string {
    let name = source
    if (cfg.pathNormalize) name = name.normalize('NFKC')
    if (cfg.pathReplaceEmojis) name = replaceEmojis(name, '_')
    if (cfg.pathFoldMarks) name = name.replaceAll(/(\P{Mark})(\p{Mark}+)/gu, '_')
    if (cfg.pathSanitize) name = name.replace(/^\.|[\\/:*?"<>|]/g, '_')
    if (cfg.pathTruncate) name = truncate(name, maxLength)
    return name
}

/** 根据视频信息生成下载路径（原 getDownloadPath） */
export function getDownloadPath(videoInfo: FullVideoInfo): AnalyzedPath {
    const cfg = getConfig()
    return analyzePath(
        replaceVariable(cfg.downloadPath.trim(), {
            NowTime: new Date(),
            UploadTime: new Date(videoInfo.UploadTime),
            AUTHOR: videoInfo.Author,
            ID: videoInfo.ID,
            TITLE: sanitize(videoInfo.Title, cfg.pathTitleMaxLength, cfg),
            ALIAS: sanitize(videoInfo.Alias, cfg.pathAliasMaxLength, cfg),
            QUALITY: videoInfo.DownloadQuality
        })
    )
}

/**
 * 从视频信息构建带 videoid/download 参数的下载地址（原 buildDownloadUrl）：
 * - videoid：任务反查视频 ID 的基础（aria2 追踪依赖）
 * - download：本地文件名（执行器识别）
 */
export function buildDownloadUrl(videoInfo: FullVideoInfo, localPath: AnalyzedPath): URL {
    const url = new URL(videoInfo.DownloadUrl)
    url.searchParams.set('videoid', videoInfo.ID)
    url.searchParams.set('download', localPath.fullName)
    return url
}

/**
 * 评论下载链接特征片段 —— 原 data/downloadLinks.json 原样转 TS（checkDownloadLink 用）
 */
export const DOWNLOAD_LINK_PATTERNS: readonly string[] = ['iwara.zip', 'pan.baidu', '/s/', 'mega.nz', 'drive.google.com', 'aliyundrive', 'uploadgig', 'katfile', 'storex', 'subyshare', 'rapidgator', 'filebe', 'filespace', 'mexa.sh', 'mexashare', 'mx-sh.net', 'icerbox', 'alfafile', '1drv.ms', 'onedrive.', 'gofile.io', 'workupload.com', 'pixeldrain.', 'dailyuploads.net', 'katfile.com', 'fikper.com', 'frdl.io', 'rg.to', 'gigafile.nu', 'mediafire.com']

/**
 * 文本是否命中第三方网盘特征（纯判据，不含配置开关——配置门在调用方）。
 *
 * 与源 `checkIsHaveDownloadLink` 逐字一致的**朴素子串、忽略大小写**匹配：
 * 不做 URL 解析、不用正则。特征表里的 `/s/`、`storex`、`filebe` 这类片段
 * 天然会误报，这是源项目的已知取舍（宁可多提示，也不要漏掉网盘链接）。
 */
export function matchesDownloadLink(text: string): boolean {
    if (text === '') return false
    const lower = text.toLowerCase()
    return DOWNLOAD_LINK_PATTERNS.some((pattern) => lower.includes(pattern))
}

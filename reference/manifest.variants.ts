// 差异表：manifest.base.json → 两宿主派生
// 构建脚本（build/manifests.ts）按此表做 JSON 深合并 + 占位符替换
export interface ManifestVariant {
    placeholder: Record<string, string>
    extra: Record<string, unknown>
}

export const chromeVariant: ManifestVariant = {
    placeholder: {
        'background_key': 'service_worker',
        'background_value': 'background.js',
        'min_version_key': 'minimum_chrome_version',
        'min_version_value': '111',
    },
    extra: {},
}

export const firefoxVariant: ManifestVariant = {
    placeholder: {
        'background_key': 'scripts',
        'background_value': 'background.js',
        'min_version_key': 'browser_specific_settings',
        'min_version_value': 'UNREPLACEABLE', // 见 extra，由构建脚本深合并
    },
    extra: {
        // extra 覆盖 apply(base) 结果：scripts 按 MDN 规范声明为数组
        background: { scripts: ['background.js'] },
        browser_specific_settings: {
            gecko: {
                id: 'iwara-assistant@dawnlc.me',
                strict_min_version: '128.0',
            },
        },
    },
}

export const localeOverrides = {
    en: 'Download and manage videos from iwara.tv',
    ja: 'iwara.tv の動画を一括ダウンロード',
    'zh-CN': '批量下载与管理 iwara.tv 视频',
}

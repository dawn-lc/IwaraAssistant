/**
 * 差异表：manifest.base.json → 两宿主派生
 * 构建脚本（build/index.ts）按此表做占位符替换（含键名）+ extra 顶层合并
 *
 * 双 manifest 策略（docs/03）：
 *   chrome  —— MV3，background.service_worker；minimum_chrome_version 111（world:MAIN 门槛）
 *   firefox —— **MV2**，background.scripts 持久化后台页；browser_specific_settings 锁 128.0
 *
 * Firefox 为什么走 MV2 而不是 MV3（docs/02 实测矩阵）：
 * - MV3 扩展被本地网络访问（LNA）策略拦死：`http://10.x` / `ws://10.x` 一律 NetworkError，
 *   回环除外，且用户侧 pref 关不掉。**MV2 完全豁免**（同一份代码、同一个源，唯一变量是
 *   manifest_version），这是 aria2/iwaradl 部署在 NAS 上的唯一可行路径。
 * - MV3 事件页会被挂起，MV2 可以 `persistent: true` 常驻——顺带消掉事件页挂起的整类问题。
 * 代价只有清单形状（见 build/index.ts `toManifestV2`）与 `action`→`browserAction` 一处 shim；
 * 钓鱼防护用的 `declarativeNetRequest` session 规则、`world: "MAIN"`、`storage.session`
 * 在 MV2 下均实测可用。
 */
export interface ManifestVariant {
    placeholder: Record<string, string>
    extra: Record<string, unknown>
    /**
     * 变体专属权限（追加到 base `permissions` 末尾，自动去重）。
     * 用追加而不是在 `extra.permissions` 里整表覆盖：后者会让 base 的权限清单
     * 复制两份，两边改一处忘一处。
     */
    extraPermissions?: string[]
    /**
     * 该变体的 manifest 版本。缺省 3。
     * 声明为 2 时构建期调用 `toManifestV2()` 把 base 的 MV3 形状改写为 MV2
     * （`host_permissions` → `permissions`、`action` → `browser_action` 等），
     * 这样 base 模板仍只有一份、两边不用各写一遍权限清单。
     */
    manifestVersion?: 2
}

/** manifest 描述文案（en 供 placeholder；ja/zh-CN 备注用，UI 文案在 _locales） */
export const EXT_DESCRIPTION = {
    en: 'Download and manage videos from iwara.tv',
    ja: 'iwara.tv の動画を一括ダウンロード',
    'zh-CN': '批量下载与管理 iwara.tv 视频'
}

const sharedPlaceholder = {
    description: EXT_DESCRIPTION.en,
    action_title: 'Iwara Assistant'
}

export const chromeVariant: ManifestVariant = {
    placeholder: {
        ...sharedPlaceholder,
        background_key: 'service_worker',
        background_value: 'background.js'
    },
    extra: {
        minimum_chrome_version: '111'
    },
    // SW 没有 DOM，剪贴板只能经 offscreen document 写（Chrome 109+）。
    // Firefox 事件页有 DOM，不需要该权限。
    extraPermissions: ['offscreen']
}

export const firefoxVariant: ManifestVariant = {
    placeholder: {
        ...sharedPlaceholder
    },
    manifestVersion: 2,
    extra: {
        // MV2 使用持久化后台页：脚本在浏览器启动时加载并常驻，HTTP/WS 连接与内存状态不会被回收。
        // 这也是 Firefox 侧不再需要「保活」的原因（Chrome MV3 的对照实现见 src/background/runtime/keepAlive.ts）。
        background: { scripts: ['background.js'], persistent: true },
        browser_specific_settings: {
            gecko: {
                id: 'iwara-assistant@dawnlc.me',
                strict_min_version: '128.0',
                // AMO 数据收集披露（Firefox 141+ 要求声明；本项目不向开发者回传任何数据 → none）
                data_collection_permissions: { required: ['none'] }
            }
        }
    }
}

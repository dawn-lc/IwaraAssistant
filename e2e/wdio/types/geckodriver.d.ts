/**
 * 补丁：geckodriver 0.37 / @wdio/types 的 GeckodriverOptions 尚未声明
 * `--allow-system-access`（FF 138+ 导航 moz-extension 页必需），
 * 但 geckodriver 包的 parseParams 会把 camelCase 键透传为 CLI flag。
 */
declare namespace WebdriverIO {
    interface GeckodriverOptions {
        allowSystemAccess?: boolean
    }
}

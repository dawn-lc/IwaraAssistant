/**
 * host 权限状态查询。
 *
 * **权限模型已改**：所有网站访问权限在 `host_permissions` 里一次性声明
 * （`<all_urls>`），不再走 `optional_host_permissions` + `permissions.request()`
 * 的逐站点授权流程。原因见 docs/03：
 * - RPC 端点（aria2 / iwaradl / MediaCenter）地址由用户随意填写，逐个申请只是把
 *   同一件事重复 N 次，且每次都要一次原生弹窗；
 * - 钓鱼仿冒站点防护**必须**在任意站点上运行（主机名包含品牌词的域名每天都在变，
 *   事先不知道要申请谁），只有全站权限才能覆盖。
 *
 * 这里只保留**状态诊断**，不提供申请动作：
 * `permissions.request()` 只能申请 optional 权限，对 required 的 host 权限无效
 * （Chrome 直接报 "Cannot request required permission"）。用户若在浏览器扩展页
 * 把站点访问改成「点击时」或撤销授权，正确动作是在浏览器 UI 里改回来——扩展能做的是
 * 如实告诉他「现在没权限、去哪里开」。
 */

/** 全站权限模式（与 manifest `host_permissions` 完全一致） */
export const ALL_SITES_PATTERN = '<all_urls>'

/**
 * 是否持有全站访问权限。
 *
 * 语义边界（别过度承诺）：返回 `true` 只代表**权限已声明且未被撤销**；
 * Chrome 的「点击时」模式下权限仍算已授予，但内容脚本要等用户点扩展图标才注入。
 * 因此 UI 文案只能写「已声明/已被撤销」，不能写「页内功能一定正常」。
 */
export async function hasAllSitesAccess(): Promise<boolean> {
    try {
        return await browser.permissions.contains({ origins: [ALL_SITES_PATTERN] })
    } catch {
        return false
    }
}

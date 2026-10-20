/**
 * options 入口骨架 —— 配置中心（替代注入式 configPanel）
 *
 * 直接读写 browser.storage（写者也允许是 options：单机单用户，无跨写者竞态；
 * 变更经 storage.onChanged 广播给各页面失效缓存）。
 * 静态文案走 _locales（browser.i18n.getMessage），动态占位符渲染沿用 shared/i18n。
 */
import '../browser/globals'

document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset['i18n']!
    const localized = browser.i18n.getMessage(key)
    if (localized) el.textContent = localized
})

const form = document.querySelector<HTMLFormElement>('#configForm')!

async function loadConfig(): Promise<void> {
    const { config } = await browser.storage.local.get('config')
    // TODO: 按 shared/config-schema 渲染表单（下载模式、路径模板、aria2/iwaradl 端点、过滤开关）
    form.dataset['loaded'] = String(Boolean(config))
}

// 自定义 RPC 端点变更 → 动态申请 origin 权限（docs/03 流程）
async function requestEndpointPermission(origin: string): Promise<boolean> {
    const granted = await browser.permissions.request({ origins: [origin] })
    return granted
}

// 油猴数据迁移导入（docs/06 M4）
document.querySelector<HTMLInputElement>('#migrationFile')!.addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return
    const payload = JSON.parse(await file.text()) as { config?: unknown; videos?: unknown[] }
    // TODO: schema 校验后按 key 分别写入 storage.local / IndexedDB（视频库经消息或直写）
    console.info('migration payload keys', Object.keys(payload))
    void requestEndpointPermission
})

void loadConfig()

/**
 * options 的 toast 宿主 —— sonner 需要有人把 `<Toaster>` 挂到树上，这里只做这件事。
 *
 * 业务代码直接 `import { toast } from 'sonner'` 调用，不套 `notifyXxx` 包装：
 * 真正需要固定的东西已在调用点就地表达——保存 toast 的覆盖式 `id` 与 e2e
 * `testId` 是 `appStore.ts` 里 `SAVE_TOAST` 常量，操作类 toast 各自独立堆叠。
 *
 * 本文件只集中「配置」：主题、位置、可见条数、关闭按钮、a11y 文案。
 * `classNames.toast = 'ia-toast'` 是 `options.css` 里接回设计 token 的钩子。
 */
import type { ReactElement } from 'react'
import { Toaster } from 'sonner'
import { useTranslation } from 'react-i18next'

export function OptionsToaster(): ReactElement {
    const { t } = useTranslation()
    return (
        <Toaster
            theme="dark"
            position="bottom-right"
            offset={18}
            gap={8}
            visibleToasts={3}
            closeButton
            richColors
            duration={3000}
            // 库自带文案是英文（Notifications / Close toast），按当前语言显式覆盖
            containerAriaLabel={t('toast.notifications')}
            customAriaLabel={t('toast.notifications')}
            toastOptions={{ classNames: { toast: 'ia-toast' }, closeButtonAriaLabel: t('toast.close') }}
        />
    )
}

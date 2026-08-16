/**
 * 浏览器半入口：扫描文档中的对话滚动容器（[data-conversation-scroll]），
 * 为每个容器挂载 ScrollFlowController，并在插件卸载时完整清理。
 * 同时注册 General 设置行（动画档位 + 弹簧开关）并持久化偏好。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ScrollFlowController, type ScrollFlowOptions } from './scroll-flow-controller.ts'
import {
  followOptionsForMode, ScrollFlowPolicy, SCROLL_FLOW_SETTINGS_NAMESPACE,
  type ScrollFlowSettings,
} from './scroll-flow-settings.ts'
import { ScrollFlowSettingsRow, type ScrollFlowSettingsRowInjected } from './settings-row.tsx'

export const name = 'dsh-web-scroll-flow'

/** 对话滚动容器选择器（ConversationRoot 的 scrollBody）。 */
export const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'

/** 插件需要等待的服务。 */
export const inject = ['slots', 'settingsScope']

export interface ScrollFlowInstall {
  /** 更新全部控制器的动效配置（设置面板切换档位 / 弹簧开关）。 */
  setOptions(options: ScrollFlowOptions): void
  /** 卸载全部控制器并停止观察。 */
  dispose(): void
}

/**
 * 在给定根节点下安装滚动动效：同步扫描现有容器，并用 MutationObserver
 * 跟随后续的挂载 / 卸载（会话打开、视图切换、面板折叠都会增减容器）。
 * @param root - 扫描与观察的根节点（通常为 document）。
 * @param options - 初始动效配置。
 * @returns 卸载句柄。
 */
export function installScrollFlow(root: ParentNode, options: ScrollFlowOptions = {}): ScrollFlowInstall {
  const controllers = new Map<HTMLElement, ScrollFlowController>()
  const sync = (): void => {
    const elements = Array.from(root.querySelectorAll<HTMLElement>(SCROLLPORT_SELECTOR))
    for (const element of elements) {
      if (!controllers.has(element)) {
        controllers.set(element, new ScrollFlowController(element, options).attach())
      }
    }
    for (const [element, controller] of controllers) {
      if (!element.isConnected) {
        controller.dispose()
        controllers.delete(element)
      }
    }
  }
  sync()
  const observer = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver(sync)
  observer?.observe(root as Node, { childList: true, subtree: true })
  return {
    setOptions(next: ScrollFlowOptions): void {
      for (const controller of controllers.values()) controller.setOptions(next)
    },
    dispose(): void {
      observer?.disconnect()
      for (const controller of controllers.values()) controller.dispose()
      controllers.clear()
    },
  }
}

/**
 * 插件入口：浏览器端激活时安装滚动动效、注册设置行并持久化偏好。
 * @param ctx - 客户端 cordis 上下文。
 */
export function apply(ctx: Context): void {
  const policy = new ScrollFlowPolicy(
    ctx.settingsScope.bind<ScrollFlowSettings>({ namespace: SCROLL_FLOW_SETTINGS_NAMESPACE }),
  )

  const syncInstallOptions = (): ScrollFlowOptions => ({
    follow: followOptionsForMode(policy.followMode.getSnapshot()),
    bounce: policy.bounceEnabled.getSnapshot()
      ? undefined // 默认回弹参数
      : null,
  })

  ctx.effect(() => {
    const install = installScrollFlow(document, syncInstallOptions())
    const disposeFollow = policy.followMode.subscribe(() => {
      install.setOptions({ follow: followOptionsForMode(policy.followMode.getSnapshot()) })
    })
    const disposeBounce = policy.bounceEnabled.subscribe(() => {
      install.setOptions({ bounce: policy.bounceEnabled.getSnapshot() ? undefined : null })
    })
    return () => {
      disposeFollow()
      disposeBounce()
      install.dispose()
    }
  })

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'scroll-flow',
    order: 30,
    inject: (): ScrollFlowSettingsRowInjected => ({
      hooks: {
        followMode: policy.followMode,
        bounceEnabled: policy.bounceEnabled,
      },
      setFollowMode: (mode) => { policy.setFollowMode(mode) },
      setBounceEnabled: (enabled) => { policy.setBounceEnabled(enabled) },
    }),
  }, ScrollFlowSettingsRow))
}

/**
 * 浏览器半入口：扫描文档中的对话滚动容器（[data-conversation-scroll]），
 * 为每个容器挂载 ScrollFlowController，并在插件卸载时完整清理。
 * 同时注册 General 设置行（动画档位 + 弹簧开关）并持久化偏好。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ScrollFlowController, type ScrollFlowOptions } from './scroll-flow-controller.ts'
import { TypewriterController } from './typewriter.ts'
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
  /** 启用 / 停用逐字打字机效果。 */
  setTypewriterEnabled(enabled: boolean): void
  /** 卸载全部控制器并停止观察。 */
  dispose(): void
}

interface ScrollportEntry {
  controller: ScrollFlowController
  typewriter: TypewriterController | null
}

/**
 * 在给定根节点下安装滚动动效与逐字吐字动画：同步扫描现有容器，并用
 * MutationObserver 跟随后续的挂载 / 卸载（会话打开、视图切换、面板折叠
 * 都会增减容器）。
 * @param root - 扫描与观察的根节点（通常为 document）。
 * @param options - 初始动效配置。
 * @param typewriter - 是否启用逐字吐字动画（跟随动画档位）。
 * @returns 卸载句柄。
 */
export function installScrollFlow(
  root: ParentNode,
  options: ScrollFlowOptions = {},
  typewriter = false,
): ScrollFlowInstall {
  const entries = new Map<HTMLElement, ScrollportEntry>()
  const sync = (): void => {
    const elements = Array.from(root.querySelectorAll<HTMLElement>(SCROLLPORT_SELECTOR))
    for (const element of elements) {
      if (!entries.has(element)) {
        const controller = new ScrollFlowController(element, options).attach()
        entries.set(element, {
          controller,
          typewriter: typewriter
            ? new TypewriterController(
              element.querySelector<HTMLElement>('[data-chat-flow]') ?? element,
              { onRestore: () => { controller.suppressEntryFor(600) } },
            ).attach()
            : null,
        })
      }
    }
    for (const [element, entry] of entries) {
      if (!element.isConnected) {
        entry.controller.dispose()
        entry.typewriter?.dispose()
        entries.delete(element)
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
      for (const entry of entries.values()) entry.controller.setOptions(next)
    },
    setTypewriterEnabled(enabled: boolean): void {
      for (const entry of entries.values()) {
        if (enabled && entry.typewriter === null) {
          entry.typewriter = new TypewriterController(
            entry.controller.element.querySelector<HTMLElement>('[data-chat-flow]')
              ?? entry.controller.element,
            { onRestore: () => { entry.controller.suppressEntryFor(600) } },
          ).attach()
        } else if (!enabled && entry.typewriter !== null) {
          entry.typewriter.dispose()
          entry.typewriter = null
        }
      }
    },
    dispose(): void {
      observer?.disconnect()
      for (const entry of entries.values()) {
        entry.controller.dispose()
        entry.typewriter?.dispose()
      }
      entries.clear()
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
    const install = installScrollFlow(
      document,
      syncInstallOptions(),
      policy.typewriterEnabled.getSnapshot(),
    )
    const disposeFollow = policy.followMode.subscribe(() => {
      install.setOptions({ follow: followOptionsForMode(policy.followMode.getSnapshot()) })
      // 档位关闭时也关掉打字机；重新开启时无法在已挂载的安装上补装，
      // 由页面刷新/会话重挂自然恢复。
      if (policy.followMode.getSnapshot() === 'off') install.setOptions({ follow: null })
    })
    const disposeBounce = policy.bounceEnabled.subscribe(() => {
      install.setOptions({ bounce: policy.bounceEnabled.getSnapshot() ? undefined : null })
    })
    const disposeTypewriter = policy.typewriterEnabled.subscribe(() => {
      install.setTypewriterEnabled(policy.typewriterEnabled.getSnapshot())
    })
    return () => {
      disposeFollow()
      disposeBounce()
      disposeTypewriter()
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
        typewriterEnabled: policy.typewriterEnabled,
      },
      setFollowMode: (mode) => { policy.setFollowMode(mode) },
      setBounceEnabled: (enabled) => { policy.setBounceEnabled(enabled) },
      setTypewriterEnabled: (enabled) => { policy.setTypewriterEnabled(enabled) },
    }),
  }, ScrollFlowSettingsRow))
}

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
  type ScrollFlowSettings, type TypewriterMode,
} from './scroll-flow-settings.ts'
import { ScrollFlowSettingsRow, type ScrollFlowSettingsRowInjected } from './settings-row.tsx'
import { debugLog, mountDebugGlobal } from './debug-log.ts'

export const name = 'dsh-web-scroll-flow'

/** 对话滚动容器选择器（ConversationRoot 的 scrollBody）。 */
export const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'

/** 插件需要等待的服务。 */
export const inject = ['slots', 'settingsScope']

/** 打字机控制器的公共清理接口（native / overlay 两实现共用）。 */
interface TypewriterLike {
  dispose(): void
}

export interface ScrollFlowInstall {
  /** 更新全部控制器的动效配置（设置面板切换档位 / 弹簧开关）。 */
  setOptions(options: ScrollFlowOptions): void
  /** 启用 / 停用逐字打字机效果。 */
  setTypewriterEnabled(enabled: boolean): void
  /** 切换打字机实现模式（原生截断 / 覆盖层模拟）。 */
  setTypewriterMode(mode: TypewriterMode): void
  /** 卸载全部控制器并停止观察。 */
  dispose(): void
}

interface ScrollportEntry {
  controller: ScrollFlowController
  typewriter: TypewriterLike | null
}

/** 按模式创建打字机控制器（flow 内 fallback 到滚动容器本身）。 */
function createTypewriter(
  element: HTMLElement,
  _mode: TypewriterMode,
  controller: ScrollFlowController,
): TypewriterLike {
  const flow = element.querySelector<HTMLElement>('[data-chat-flow]') ?? element
  const onRestore = (): void => { controller.suppressEntryFor(600) }
  // 打字机内容增长（每写完一行高度 + 一行）：期间贴底跟随用平滑滚动，
  // 让上一行文字被平滑往上推；而不是瞬时跳变或下压回弹。
  const onContentChange = (): void => { controller.smoothFollowFor(1_000) }
  // Both modes use the parsed, non-destructive renderer. It clones React's
  // Markdown tree and progressively reveals clone text nodes without touching
  // the source DOM, preserving formatting while avoiding full-text flashes.
  void _mode
  return new TypewriterController(flow, { onRestore, onContentChange }).attach()
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
  typewriterMode: TypewriterMode = 'native',
): ScrollFlowInstall {
  const entries = new Map<HTMLElement, ScrollportEntry>()
  const sync = (): void => {
    const elements = Array.from(root.querySelectorAll<HTMLElement>(SCROLLPORT_SELECTOR))
    for (const element of elements) {
      if (!entries.has(element)) {
        const controller = new ScrollFlowController(element, options).attach()
        entries.set(element, {
          controller,
          typewriter: typewriter ? createTypewriter(element, typewriterMode, controller) : null,
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
  let syncScheduled = false
  const scheduleSync = (): void => {
    if (syncScheduled) return
    syncScheduled = true
    queueMicrotask(() => {
      syncScheduled = false
      sync()
    })
  }
  const observer = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver(scheduleSync)
  observer?.observe(root as Node, { childList: true, subtree: true })
  return {
    setOptions(next: ScrollFlowOptions): void {
      for (const entry of entries.values()) entry.controller.setOptions(next)
    },
    setTypewriterEnabled(enabled: boolean): void {
      for (const entry of entries.values()) {
        if (enabled && entry.typewriter === null) {
          entry.typewriter = createTypewriter(
            entry.controller.element,
            typewriterMode,
            entry.controller,
          )
        } else if (!enabled && entry.typewriter !== null) {
          entry.typewriter.dispose()
          entry.typewriter = null
        }
      }
    },
    setTypewriterMode(mode: TypewriterMode): void {
      typewriterMode = mode
      for (const entry of entries.values()) {
        if (entry.typewriter === null) continue
        entry.typewriter.dispose()
        entry.typewriter = createTypewriter(entry.controller.element, mode, entry.controller)
      }
    },
    dispose(): void {
      observer?.disconnect()
      for (const entry of entries.values()) {
        entry.typewriter?.dispose()
        entry.controller.dispose()
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
      ? undefined
      : null,
  })

  // 正在思考的摘要文字：smooth 推进。放在 effect 外面，不受 effect 重建影响。
  const thinkStyle = document.createElement('style')
  thinkStyle.id = 'dsh-think-scroll-smooth'
  thinkStyle.textContent = '[data-variant="think"][data-state="running"] [class*="summary"]{scroll-behavior:smooth}'
  document.head.appendChild(thinkStyle)

  // 禁用对话滚动容器的滚动锚定：打字机隐藏 / 恢复 Markdown 与覆盖层增长
  // 会触发浏览器 overflow-anchor 自动调整 scrollTop，表现为"页面被悄悄往上
  // 拉"（即使我们的 scrollTop setter 没有收到任何写入）。
  const anchorStyle = document.createElement('style')
  anchorStyle.id = 'dsh-scroll-anchor-none'
  anchorStyle.textContent = '[data-conversation-scroll]{overflow-anchor:none}'
  document.head.appendChild(anchorStyle)

  // 调试日志全局读取接口（window.__dshScrollFlowDebug）。
  mountDebugGlobal()

  ctx.effect(() => {
    debugLog('install', 'effect-start', {})
    const install = installScrollFlow(
      document,
      syncInstallOptions(),
      policy.typewriterEnabled.getSnapshot(),
      policy.typewriterMode.getSnapshot(),
    )
    const disposeFollow = policy.followMode.subscribe(() => {
      install.setOptions({ follow: followOptionsForMode(policy.followMode.getSnapshot()) })
      if (policy.followMode.getSnapshot() === 'off') install.setOptions({ follow: null })
    })
    const disposeBounce = policy.bounceEnabled.subscribe(() => {
      install.setOptions({ bounce: policy.bounceEnabled.getSnapshot() ? undefined : null })
    })
    const disposeTypewriter = policy.typewriterEnabled.subscribe(() => {
      install.setTypewriterEnabled(policy.typewriterEnabled.getSnapshot())
    })
    const disposeTypewriterMode = policy.typewriterMode.subscribe(() => {
      install.setTypewriterMode(policy.typewriterMode.getSnapshot())
    })
    return () => {
      disposeFollow()
      disposeBounce()
      disposeTypewriter()
      disposeTypewriterMode()
      thinkStyle.remove()
      anchorStyle.remove()
      debugLog('install', 'effect-stop', {})
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
        typewriterMode: policy.typewriterMode,
      },
      setFollowMode: (mode) => { policy.setFollowMode(mode) },
      setBounceEnabled: (enabled) => { policy.setBounceEnabled(enabled) },
      setTypewriterEnabled: (enabled) => { policy.setTypewriterEnabled(enabled) },
      setTypewriterMode: (mode) => { policy.setTypewriterMode(mode) },
    }),
  }, ScrollFlowSettingsRow))
}

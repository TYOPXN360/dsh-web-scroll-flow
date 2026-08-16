import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  SCROLL_FLOW_SETTINGS_NAMESPACE, ScrollFlowSettingsSchema,
} from './settings.ts'

export const name = 'dsh-web-scroll-flow'

/**
 * 节点半入口：注册浏览器设置项的 Host section，使 General 设置行写入的
 * 偏好持久化到用户设置文档。滚动动效本身在浏览器半（/client）。
 * @param ctx - 主机侧 cordis 上下文。
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(SCROLL_FLOW_SETTINGS_NAMESPACE),
      ScrollFlowSettingsSchema,
    )
  })
}

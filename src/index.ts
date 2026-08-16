import type { Context } from '@deepseek-ai/cordis'
// 类型-only：SettingsNamespace 是品牌字符串；运行时由本地校验替代，
// 避免 node 半 external 依赖在用户 profile 里缺失导致加载失败。
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  SCROLL_FLOW_SETTINGS_NAMESPACE, ScrollFlowSettingsSchema,
} from './settings.ts'

export const name = 'dsh-web-scroll-flow'

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/** 校验并品牌化 settings namespace（与 dsh-settings 的运行时规则一致）。 */
function settingsNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value as SettingsNamespace
}

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

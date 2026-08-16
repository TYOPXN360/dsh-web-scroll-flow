/**
 * 滚动动效设置的 Host 侧声明：namespace 与 schemastery schema。
 * Host 注册该 section 后，浏览器侧的 settingsScope 写入才会持久化。
 */

import z from '@deepseek-ai/schemastery'

export const SCROLL_FLOW_SETTINGS_NAMESPACE = 'dsh-web-scroll-flow'
export const FOLLOW_MODE_FIELD = 'followMode'
export const BOUNCE_ENABLED_FIELD = 'bounceEnabled'
export const TYPEWRITER_ENABLED_FIELD = 'typewriterEnabled'
export const TYPEWRITER_MODE_FIELD = 'typewriterMode'

export const FOLLOW_MODES = ['off', 'gentle', 'medium'] as const
export type FollowMode = (typeof FOLLOW_MODES)[number]

export const TYPEWRITER_MODES = ['native', 'overlay'] as const
export type TypewriterMode = (typeof TYPEWRITER_MODES)[number]

export const DEFAULT_FOLLOW_MODE: FollowMode = 'medium'
export const DEFAULT_BOUNCE_ENABLED = true
export const DEFAULT_TYPEWRITER_ENABLED = true
export const DEFAULT_TYPEWRITER_MODE: TypewriterMode = 'native'

export interface ScrollFlowSettings {
  followMode: FollowMode
  bounceEnabled: boolean
  typewriterEnabled: boolean
  typewriterMode: TypewriterMode
}

/** Host 持久化 schema；浏览器 settingsScope 也会用它校验 wire section。 */
export const ScrollFlowSettingsSchema: z<ScrollFlowSettings> = z.object({
  [FOLLOW_MODE_FIELD]: z.union([...FOLLOW_MODES]).default(DEFAULT_FOLLOW_MODE),
  [BOUNCE_ENABLED_FIELD]: z.boolean().default(DEFAULT_BOUNCE_ENABLED),
  [TYPEWRITER_ENABLED_FIELD]: z.boolean().default(DEFAULT_TYPEWRITER_ENABLED),
  [TYPEWRITER_MODE_FIELD]: z.union([...TYPEWRITER_MODES]).default(DEFAULT_TYPEWRITER_MODE),
})

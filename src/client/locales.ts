/** `scrollFlow` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'scrollFlow'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.nav': '滚动动画',
  'settings.title': '流式滚动动画',
  'settings.description': '模型输出时自动跟随最新内容，滚动平滑过渡（含未展开的思考摘要）',
  'settings.debugTitle': '调试日志',
  'settings.debugDescription': '记录插件事件与帧率（约 2 万条环形上限，经 window.__DSH_SCROLL_FLOW_DEBUG__ 查看）',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<ScrollFlowKey, string> = {
  'section.nav': 'Scroll animation',
  'settings.title': 'Streaming scroll animation',
  'settings.description': 'Smoothly follow the latest content while the model streams, including collapsed thinking summaries',
  'settings.debugTitle': 'Debug logs',
  'settings.debugDescription': 'Buffer plugin events and frame rate (ring of ~20k entries; inspect via window.__DSH_SCROLL_FLOW_DEBUG__)',
}

/** Key domain of the `scrollFlow` namespace (zh is the source of truth). */
export type ScrollFlowKey = keyof typeof zh

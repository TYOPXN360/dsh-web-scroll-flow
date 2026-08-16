/**
 * General 设置中的滚动动效偏好行：动画档位选择（关闭 / 优雅 / 适中）
 * 与弹簧开关。控件是原生 select / checkbox，避免引入额外 UI 依赖。
 */

import { createElement, type ChangeEvent, type ReactElement } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FollowMode } from './scroll-flow-settings.ts'

export interface ScrollFlowSettingsRowInjected {
  hooks: {
    followMode: SnapshotStore<FollowMode>
    bounceEnabled: SnapshotStore<boolean>
  }
  setFollowMode: (mode: FollowMode) => void
  setBounceEnabled: (enabled: boolean) => void
}

export type ScrollFlowSettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & InjectFace<ScrollFlowSettingsRowInjected>

const FOLLOW_OPTIONS: readonly { id: FollowMode; label: string }[] = [
  { id: 'off', label: '关闭' },
  { id: 'gentle', label: '优雅' },
  { id: 'medium', label: '适中' },
]

const rowStyle: Record<string, string> = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  minHeight: '44px',
}

const textStyle: Record<string, string> = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
}

const titleStyle: Record<string, string> = {
  font: 'var(--dsw-font-s-strong-14)',
  color: 'var(--dsw-alias-label-primary)',
}

const descStyle: Record<string, string> = {
  font: 'var(--dsw-font-xs-13)',
  color: 'var(--dsw-alias-label-caption)',
}

const controlStyle: Record<string, string> = {
  font: 'var(--dsw-font-s-14)',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover-solid)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '6px',
  padding: '4px 8px',
}

/** General 设置行：滚动动画档位 + 弹簧开关。 */
export function ScrollFlowSettingsRow({
  useFollowMode, useBounceEnabled, setFollowMode, setBounceEnabled,
}: ScrollFlowSettingsRowProps): ReactElement {
  const mode = useFollowMode(value => value)
  const bounceEnabled = useBounceEnabled(value => value)

  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' } },
    createElement('div', { style: rowStyle },
      createElement('div', { style: textStyle },
        createElement('div', { style: titleStyle }, '自动滚动动画'),
        createElement('div', { style: descStyle }, '内容自动跟随时的平滑推送幅度：关闭、优雅（慢速上推）或适中（当前默认）'),
      ),
      createElement('select', {
        value: mode,
        style: controlStyle,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          setFollowMode(event.target.value as FollowMode)
        },
        'aria-label': '自动滚动动画',
      },
        FOLLOW_OPTIONS.map(option => createElement('option', { key: option.id, value: option.id }, option.label)),
      ),
    ),
    createElement('div', { style: rowStyle },
      createElement('div', { style: textStyle },
        createElement('div', { style: titleStyle }, '边缘回弹'),
        createElement('div', { style: descStyle }, '手动滚动到顶部 / 底部时的弹簧回弹效果'),
      ),
      createElement('input', {
        type: 'checkbox',
        checked: bounceEnabled,
        style: { width: '16px', height: '16px', accentColor: 'var(--dsw-static-deepseek-500)' },
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          setBounceEnabled(event.target.checked)
        },
        'aria-label': '边缘回弹',
      }),
    ),
  )
}

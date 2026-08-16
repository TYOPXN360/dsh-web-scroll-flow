/**
 * 滚动动效设置：动画档位（关闭 / 优雅 / 适中）与弹簧开关。
 * 值通过 settingsScope 持久化到 Host；无 settingsScope 时保持进程内。
 */

import {
  createSnapshotStore, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { FollowOptions } from './scroll-flow-controller.ts'

/** 自动滚动动画档位：关闭、优雅（慢速上推）、适中（当前默认）。 */
export type FollowMode = 'off' | 'gentle' | 'medium'

export interface ScrollFlowSettings {
  followMode: FollowMode
  bounceEnabled: boolean
}

export const SCROLL_FLOW_SETTINGS_NAMESPACE = 'dsh-web-scroll-flow'
export const FOLLOW_MODE_FIELD = 'followMode'
export const BOUNCE_ENABLED_FIELD = 'bounceEnabled'

export const DEFAULT_FOLLOW_MODE: FollowMode = 'medium'
export const DEFAULT_BOUNCE_ENABLED = true

/** 适中：当前幅度（200ms 大距离平滑）。 */
const MEDIUM_FOLLOW: FollowOptions = { duration: 200 }
/** 优雅：更慢一点往上推。 */
const GENTLE_FOLLOW: FollowOptions = { duration: 380 }

/** 把用户档位翻译成 controller 配置。 */
export function followOptionsForMode(mode: FollowMode): FollowOptions | null {
  switch (mode) {
    case 'off': return null
    case 'gentle': return GENTLE_FOLLOW
    case 'medium': return MEDIUM_FOLLOW
  }
}

/**
 * 滚动动效偏好：持有 live 值，订阅持久化 scope 采纳 Host 值，
 * 用户修改时先发布再写 Host。
 */
export class ScrollFlowPolicy {
  readonly followMode: SnapshotStore<FollowMode> = createSnapshotStore(DEFAULT_FOLLOW_MODE)
  readonly bounceEnabled: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_BOUNCE_ENABLED)
  private readonly host: SettingsScope<ScrollFlowSettings> | undefined

  /**
   * @param host - durable preference scope；缺失时保持进程内默认值。
   */
  constructor(host?: SettingsScope<ScrollFlowSettings>) {
    this.host = host
    if (host !== undefined) {
      host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /** 切换自动滚动动画档位（关闭 / 优雅 / 适中）。 */
  setFollowMode(mode: FollowMode): void {
    if (this.followMode.getSnapshot() === mode) return
    this.followMode.set(mode)
    void this.host?.set(FOLLOW_MODE_FIELD, mode)
  }

  /** 切换边缘回弹弹簧开关。 */
  setBounceEnabled(enabled: boolean): void {
    if (this.bounceEnabled.getSnapshot() === enabled) return
    this.bounceEnabled.set(enabled)
    void this.host?.set(BOUNCE_ENABLED_FIELD, enabled)
  }

  private adopt(host: SettingsScope<ScrollFlowSettings>): void {
    const section = host.getSnapshot().value
    if (section === undefined) return
    const mode = section.followMode
    if (mode === 'off' || mode === 'gentle' || mode === 'medium') {
      this.followMode.set(mode)
    }
    if (typeof section.bounceEnabled === 'boolean') {
      this.bounceEnabled.set(section.bounceEnabled)
    }
  }
}

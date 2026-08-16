/**
 * 滚动动效设置：动画档位（关闭 / 优雅 / 适中）、弹簧开关与打字机开关。
 * 持久化主通道是浏览器 localStorage（与透明 UI 等纯 UI 插件一致，刷新
 * 即可恢复）；若 Host settingsScope 可用，也同步写入 Host 作为增强。
 */

import {
  createSnapshotStore, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { FollowOptions } from './scroll-flow-controller.ts'

/** 自动滚动动画档位：关闭、优雅（慢速上推）、适中（当前默认）。 */
export type FollowMode = 'off' | 'gentle' | 'medium'

/** 打字机实现模式：原生（直接截断原始 Markdown）或覆盖层（叠加模拟层）。 */
export type TypewriterMode = 'native' | 'overlay'

export interface ScrollFlowSettings {
  followMode: FollowMode
  bounceEnabled: boolean
  typewriterEnabled: boolean
  typewriterMode: TypewriterMode
}

export const SCROLL_FLOW_SETTINGS_NAMESPACE = 'dsh-web-scroll-flow'
export const FOLLOW_MODE_FIELD = 'followMode'
export const BOUNCE_ENABLED_FIELD = 'bounceEnabled'
export const TYPEWRITER_ENABLED_FIELD = 'typewriterEnabled'
export const TYPEWRITER_MODE_FIELD = 'typewriterMode'

export const DEFAULT_FOLLOW_MODE: FollowMode = 'medium'
export const DEFAULT_BOUNCE_ENABLED = true
export const DEFAULT_TYPEWRITER_ENABLED = true
export const DEFAULT_TYPEWRITER_MODE: TypewriterMode = 'native'

/** localStorage 持久化键（单一 JSON 对象）。 */
const STORAGE_KEY = 'dsh-web-scroll-flow.settings'

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

function isFollowMode(value: unknown): value is FollowMode {
  return value === 'off' || value === 'gentle' || value === 'medium'
}

/** 从 localStorage 读取偏好；损坏或缺失返回 undefined。 */
function readLocalSettings(): ScrollFlowSettings | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return undefined
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const section = value as Partial<ScrollFlowSettings>
    if (!isFollowMode(section.followMode)
      || typeof section.bounceEnabled !== 'boolean'
      || typeof section.typewriterEnabled !== 'boolean'
      || (section.typewriterMode !== 'native' && section.typewriterMode !== 'overlay')) {
      return undefined
    }
    return section as ScrollFlowSettings
  } catch {
    return undefined
  }
}

function writeLocalSettings(section: ScrollFlowSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(section))
  } catch {
    // localStorage 不可用（隐私模式等）时静默跳过，设置仍进程内生效。
  }
}

/**
 * 滚动动效偏好：live 值先由 localStorage 恢复，用户修改同时写
 * localStorage 与 Host scope（若可用）。
 */
export class ScrollFlowPolicy {
  readonly followMode: SnapshotStore<FollowMode> = createSnapshotStore(DEFAULT_FOLLOW_MODE)
  readonly bounceEnabled: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_BOUNCE_ENABLED)
  readonly typewriterEnabled: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_TYPEWRITER_ENABLED)
  readonly typewriterMode: SnapshotStore<TypewriterMode> = createSnapshotStore(DEFAULT_TYPEWRITER_MODE)
  private readonly host: SettingsScope<ScrollFlowSettings> | undefined

  /**
   * @param host - 可选 Host 持久化 scope；localStorage 始终是主通道。
   */
  constructor(host?: SettingsScope<ScrollFlowSettings>) {
    this.host = host
    const local = readLocalSettings()
    if (local !== undefined) {
      this.followMode.set(local.followMode)
      this.bounceEnabled.set(local.bounceEnabled)
      this.typewriterEnabled.set(local.typewriterEnabled)
      this.typewriterMode.set(local.typewriterMode)
    }
    if (host !== undefined) {
      host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  private persist(): void {
    writeLocalSettings({
      followMode: this.followMode.getSnapshot(),
      bounceEnabled: this.bounceEnabled.getSnapshot(),
      typewriterEnabled: this.typewriterEnabled.getSnapshot(),
      typewriterMode: this.typewriterMode.getSnapshot(),
    })
  }

  /** 切换自动滚动动画档位（关闭 / 优雅 / 适中）。 */
  setFollowMode(mode: FollowMode): void {
    if (this.followMode.getSnapshot() === mode) return
    this.followMode.set(mode)
    this.persist()
    void this.host?.set(FOLLOW_MODE_FIELD, mode)
  }

  /** 切换边缘回弹弹簧开关。 */
  setBounceEnabled(enabled: boolean): void {
    if (this.bounceEnabled.getSnapshot() === enabled) return
    this.bounceEnabled.set(enabled)
    this.persist()
    void this.host?.set(BOUNCE_ENABLED_FIELD, enabled)
  }

  /** 切换逐字打字机效果开关。 */
  setTypewriterEnabled(enabled: boolean): void {
    if (this.typewriterEnabled.getSnapshot() === enabled) return
    this.typewriterEnabled.set(enabled)
    this.persist()
    void this.host?.set(TYPEWRITER_ENABLED_FIELD, enabled)
  }

  /** 切换打字机实现模式（原生截断 / 覆盖层模拟）。 */
  setTypewriterMode(mode: TypewriterMode): void {
    if (this.typewriterMode.getSnapshot() === mode) return
    this.typewriterMode.set(mode)
    this.persist()
    void this.host?.set(TYPEWRITER_MODE_FIELD, mode)
  }

  private adopt(host: SettingsScope<ScrollFlowSettings>): void {
    const section = host.getSnapshot().value
    if (section === undefined) return
    if (isFollowMode(section.followMode)) this.followMode.set(section.followMode)
    if (typeof section.bounceEnabled === 'boolean') this.bounceEnabled.set(section.bounceEnabled)
    if (typeof section.typewriterEnabled === 'boolean') this.typewriterEnabled.set(section.typewriterEnabled)
    if (section.typewriterMode === 'native' || section.typewriterMode === 'overlay') {
      this.typewriterMode.set(section.typewriterMode)
    }
  }
}

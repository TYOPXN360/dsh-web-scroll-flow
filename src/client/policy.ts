/**
 * Live preference policy for the streaming scroll animation. Preferences are
 * persisted to browser localStorage (the Host settings transport turned out to
 * be a dead end for these per-user UI toggles — writes never reached the
 * document, so a refresh lost the switch state). localStorage is the single
 * durable source of truth; the snapshot stores mirror its `enabled` and
 * `debug` fields so both registered surfaces (the settings section and the
 * dock behavior) subscribe through one stable source, and writes flow back
 * through `saveLocal`. The `debug` mirror also drives the debug-logger gate.
 */

import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_DEBUG, DEFAULT_ENABLED, type ScrollFlowSettings,
} from '../settings.ts'
import { setDebugLogging } from './debug-logger.ts'

/** localStorage key holding the JSON { enabled, debug } preference blob. */
const STORAGE_KEY = 'ui-scroll-flow'

/** Read the persisted preference blob; returns {} on absence or corruption. */
function loadLocal(): Partial<ScrollFlowSettings> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Partial<ScrollFlowSettings>
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist both preferences; a failing write (private mode, quota) only costs
 *  this session's persistence — the in-memory stores still hold the state. */
function saveLocal(value: ScrollFlowSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Non-fatal: the toggles keep working until the next reload.
  }
}

/**
 * Preference policy: localStorage-backed mirror of the two switches.
 */
export class ScrollFlowPolicy {
  /** Live `enabled` mirror (stable observable source for both slots). */
  readonly enabled: SnapshotStore<boolean>

  /** Live `debug` mirror (settings-section Debug switch). */
  readonly debug: SnapshotStore<boolean>

  constructor() {
    const saved = loadLocal()
    this.enabled = createSnapshotStore(
      typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULT_ENABLED,
    )
    this.debug = createSnapshotStore(
      typeof saved.debug === 'boolean' ? saved.debug : DEFAULT_DEBUG,
    )
    setDebugLogging(this.debug.getSnapshot())
  }

  /** Turn the streaming scroll animation on or off. */
  setEnabled(enabled: boolean): void {
    if (this.enabled.getSnapshot() === enabled) return
    this.enabled.set(enabled)
    saveLocal({ enabled, debug: this.debug.getSnapshot() })
  }

  /** Turn the debug logger on or off. */
  setDebug(debug: boolean): void {
    if (this.debug.getSnapshot() === debug) return
    this.debug.set(debug)
    setDebugLogging(debug)
    saveLocal({ enabled: this.enabled.getSnapshot(), debug })
  }
}

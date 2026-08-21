/**
 * Debug observability for the streaming scroll animation: a fixed-capacity
 * ring buffer of plugin events plus a frame-rate / jank tracker. Everything
 * is gated by `setDebugLogging` — driven by the General-settings Debug switch
 * — so with the switch off each call site costs only a boolean check. The
 * buffer is exposed on `window.__DSH_SCROLL_FLOW_DEBUG__` for live inspection
 * (devtools or automation), e.g. while reproducing an animation issue.
 */

/** Ring capacity: ~20k entries covers a continuous streaming session. */
export const DEBUG_LOG_CAPACITY = 20_000

/** One buffered plugin event. */
export interface DebugLogEntry {
  /** wall-clock timestamp (Date.now()). */
  t: number
  /** event type: state | guard | pin | follow | snap | fade | fps | jank. */
  type: string
  /** human-readable detail (may be absent). */
  detail: string | undefined
}

let active = false
const ring = new Array<DebugLogEntry>(DEBUG_LOG_CAPACITY)
let head = 0
let count = 0

/** Turn debug logging on/off (General-settings Debug switch). */
export function setDebugLogging(next: boolean): void {
  if (active === next) return
  active = next
  if (next) {
    // Fresh measurement window so the first fps/jank readings are clean.
    fpsFrames = 0
    fpsWindowStart = null
    lastFrameAt = null
    logDebug('state', 'debug on')
  } else {
    logDebug('state', 'debug off')
  }
}

/** Append one event; once the ring is full the oldest entry is dropped. */
export function logDebug(type: string, detail?: string): void {
  if (!active) return
  ring[head] = { t: Date.now(), type, detail }
  head = (head + 1) % DEBUG_LOG_CAPACITY
  if (count < DEBUG_LOG_CAPACITY) count += 1
}

/** Chronological snapshot of the ring (oldest first). */
export function dumpDebugLogs(): DebugLogEntry[] {
  if (count < DEBUG_LOG_CAPACITY) return ring.slice(0, count)
  return [...ring.slice(head), ...ring.slice(0, head)]
}

/** Drop all buffered entries. */
export function clearDebugLogs(): void {
  head = 0
  count = 0
}

/** Per-type counters over the current buffer plus the total count. */
export function debugLogStats(): Record<string, number> & { total: number } {
  const byType: Record<string, number> = {}
  for (const entry of dumpDebugLogs()) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1
  }
  return { ...byType, total: count }
}

// --- frame-rate / jank tracker ---------------------------------------------

let fpsFrames = 0
let fpsWindowStart: number | null = null
let lastFrameAt: number | null = null

/** Feed one animation frame (called from the behavior's rAF tick). Reports a
 *  rolling frame rate once per second and flags frame gaps over 200ms — jank,
 *  or a frozen / backgrounded tab. */
export function tickDebugFrame(): void {
  if (!active) return
  const now = performance.now()
  if (fpsWindowStart === null) fpsWindowStart = now
  fpsFrames += 1
  if (lastFrameAt !== null) {
    const gap = now - lastFrameAt
    if (gap > 200) logDebug('jank', `${Math.round(gap)}ms`)
  }
  lastFrameAt = now
  const elapsed = now - fpsWindowStart
  if (elapsed >= 1000) {
    logDebug('fps', `${Math.round((fpsFrames * 1000) / elapsed)}`)
    fpsFrames = 0
    fpsWindowStart = null
  }
}

// --- live probe ---------------------------------------------------------------

/** Probe surface exposed on `window.__DSH_SCROLL_FLOW_DEBUG__`. */
export interface ScrollFlowDebugProbe {
  /** Whether the Debug switch is currently on (logging active). */
  active: () => boolean
  /** Chronological log snapshot (oldest first). */
  logs: () => DebugLogEntry[]
  /** Drop all buffered entries. */
  clear: () => void
  /** Per-type counters plus total. */
  stats: () => ReturnType<typeof debugLogStats>
  /** Ring capacity. */
  capacity: number
}

const PROBE_KEY = '__DSH_SCROLL_FLOW_DEBUG__'

/** Expose the ring on `window` for live inspection (devtools / automation). */
export function installDebugProbe(): void {
  if (typeof window === 'undefined') return
  const probe: ScrollFlowDebugProbe = {
    active: () => active,
    logs: dumpDebugLogs,
    clear: clearDebugLogs,
    stats: debugLogStats,
    capacity: DEBUG_LOG_CAPACITY,
  }
  try {
    Object.defineProperty(window, PROBE_KEY, { configurable: true, value: probe })
  } catch {
    // Non-configurable collision on a page that already defines the key.
    (window as unknown as Record<string, unknown>)[PROBE_KEY] = probe
  }
}

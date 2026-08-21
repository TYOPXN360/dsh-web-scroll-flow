// @vitest-environment jsdom
/** Debug logger: the ring buffer (20k cap, oldest dropped), the gate driven
 * by the settings Debug switch, the per-second frame-rate reporter and jank
 * flagging, and the `window.__DSH_SCROLL_FLOW_DEBUG__` probe surface. The
 * module is a singleton, so each test resets gate and buffer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearDebugLogs, DEBUG_LOG_CAPACITY, debugLogStats, dumpDebugLogs, installDebugProbe,
  logDebug, setDebugLogging, tickDebugFrame,
} from '../src/client/debug-logger.ts'

beforeEach(() => {
  setDebugLogging(false)
  clearDebugLogs()
})

afterEach(() => {
  setDebugLogging(false)
  clearDebugLogs()
  vi.restoreAllMocks()
})

describe('debug ring buffer', () => {
  it('drops nothing while the gate is off', () => {
    logDebug('state', 'ignored')
    expect(dumpDebugLogs()).toEqual([])
    expect(debugLogStats().total).toBe(0)
  })

  it('records events while the gate is on and dumps in chronological order', () => {
    setDebugLogging(true)
    clearDebugLogs() // drop the synthetic 'debug on' entry
    logDebug('state', 'a')
    logDebug('fps', '60')
    const logs = dumpDebugLogs()
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ type: 'state', detail: 'a' })
    expect(logs[1]).toMatchObject({ type: 'fps', detail: '60' })
    expect(logs[0].t).toBeTypeOf('number')
  })

  it('caps the ring at ~20k entries and drops the oldest', () => {
    setDebugLogging(true)
    clearDebugLogs()
    for (let i = 0; i < DEBUG_LOG_CAPACITY + 5; i++) {
      logDebug('state', `#${i}`)
    }
    const logs = dumpDebugLogs()
    expect(logs).toHaveLength(DEBUG_LOG_CAPACITY)
    expect(logs[0].detail).toBe('#5') // oldest five evicted
    expect(logs[logs.length - 1].detail).toBe(`#${DEBUG_LOG_CAPACITY + 4}`)
    expect(debugLogStats().total).toBe(DEBUG_LOG_CAPACITY)
  })

  it('clears the buffer and resets per-type stats', () => {
    setDebugLogging(true)
    clearDebugLogs()
    logDebug('guard', 'engage')
    logDebug('guard', 'release')
    logDebug('state', 'x')
    expect(debugLogStats()).toMatchObject({ guard: 2, state: 1, total: 3 })
    clearDebugLogs()
    expect(dumpDebugLogs()).toEqual([])
    expect(debugLogStats().total).toBe(0)
  })
})

describe('frame-rate tracker', () => {
  it('reports a rolling frame rate once per second', () => {
    setDebugLogging(true)
    clearDebugLogs()
    const now = vi.spyOn(performance, 'now')
    const interval = 1000 / 60
    for (let i = 0; i < 59; i++) {
      now.mockReturnValue(i * interval)
      tickDebugFrame()
    }
    now.mockReturnValue(1000)
    tickDebugFrame() // 60th frame completes the 1s window
    expect(dumpDebugLogs().some(e => e.type === 'fps' && e.detail === '60')).toBe(true)
  })

  it('flags frame gaps over 200ms as jank (frozen / backgrounded tab)', () => {
    setDebugLogging(true)
    clearDebugLogs()
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(100)
    tickDebugFrame() // first frame: lastFrameAt = 100
    now.mockReturnValue(420)
    tickDebugFrame() // 320ms gap > 200
    expect(dumpDebugLogs().some(e => e.type === 'jank' && e.detail === '320ms')).toBe(true)
  })

  it('does not log frames while the gate is off', () => {
    clearDebugLogs()
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(0)
    tickDebugFrame()
    now.mockReturnValue(1000)
    tickDebugFrame()
    expect(dumpDebugLogs()).toEqual([])
  })
})

describe('live probe', () => {
  it('exposes the ring on window.__DSH_SCROLL_FLOW_DEBUG__', () => {
    installDebugProbe()
    const probe = (window as unknown as Record<string, { active(): boolean; logs(): unknown[]; clear(): void; stats(): unknown; capacity: number }>)
      .__DSH_SCROLL_FLOW_DEBUG__
    expect(probe.capacity).toBe(DEBUG_LOG_CAPACITY)
    expect(probe.active()).toBe(false)
    expect(probe.logs()).toEqual([])
    expect(typeof probe.clear).toBe('function')
    expect(typeof probe.stats).toBe('function')
    expect(typeof probe.logs).toBe('function')
  })

  it('serves live entries through the probe while the gate is on', () => {
    setDebugLogging(true)
    clearDebugLogs()
    logDebug('pin', 'translateY(-12px)')
    const probe = (window as unknown as Record<string, { logs(): unknown[]; stats(): { total: number; pin?: number } }>)
      .__DSH_SCROLL_FLOW_DEBUG__
    expect(probe.logs().some(e => (e as { type: string }).type === 'pin')).toBe(true)
    expect(probe.stats().pin).toBe(1)
    expect(probe.stats().total).toBe(1)
  })
})

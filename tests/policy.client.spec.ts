// @vitest-environment jsdom
/**
 * ScrollFlowPolicy behavior: defaults, localStorage persistence (write on
 * toggle, read on construction), debug gate wiring, and corruption tolerance.
 * The published `dsh-client-runtime/client` artifact is a __ModuleLoader__
 * bundle (not importable under vitest), so this spec supplies a minimal store
 * engine. localStorage is real in jsdom; each test starts from an empty store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore: <T>(initial: T) => {
    let value = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: (next: T) => {
        value = next
        for (const listener of listeners) listener()
      },
    }
  },
}))
import { ScrollFlowPolicy } from '../src/client/policy.ts'
import { DEFAULT_DEBUG, DEFAULT_ENABLED } from '../src/settings.ts'
import { clearDebugLogs, dumpDebugLogs, setDebugLogging } from '../src/client/debug-logger.ts'

/** The policy's localStorage key (kept in sync with policy.ts). */
const STORAGE_KEY = 'ui-scroll-flow'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  setDebugLogging(false)
  clearDebugLogs()
})

describe('ScrollFlowPolicy', () => {
  it('defaults to enabled-on / debug-off when nothing is persisted', () => {
    const policy = new ScrollFlowPolicy()
    expect(policy.enabled.getSnapshot()).toBe(DEFAULT_ENABLED)
    expect(DEFAULT_ENABLED).toBe(true)
    expect(policy.debug.getSnapshot()).toBe(DEFAULT_DEBUG)
    expect(DEFAULT_DEBUG).toBe(false)
  })

  it('reads a persisted preference blob on construction', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: false, debug: true }))
    const policy = new ScrollFlowPolicy()
    expect(policy.enabled.getSnapshot()).toBe(false)
    expect(policy.debug.getSnapshot()).toBe(true)
  })

  it('writes the whole preference blob on setEnabled', () => {
    const policy = new ScrollFlowPolicy()
    policy.setDebug(true)
    policy.setEnabled(false)
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(persisted).toEqual({ enabled: false, debug: true })
    expect(policy.enabled.getSnapshot()).toBe(false)
  })

  it('does not re-write an unchanged preference', () => {
    const policy = new ScrollFlowPolicy()
    policy.setEnabled(true) // already the default
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('survives a reload: a new policy instance sees the persisted state', () => {
    const first = new ScrollFlowPolicy()
    first.setEnabled(false)
    first.setDebug(true)
    const second = new ScrollFlowPolicy()
    expect(second.enabled.getSnapshot()).toBe(false)
    expect(second.debug.getSnapshot()).toBe(true)
  })

  it('falls back to defaults when the blob is corrupted', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    const policy = new ScrollFlowPolicy()
    expect(policy.enabled.getSnapshot()).toBe(true)
    expect(policy.debug.getSnapshot()).toBe(false)
  })

  it('falls back to defaults when the blob is not an object', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify('garbage'))
    const policy = new ScrollFlowPolicy()
    expect(policy.enabled.getSnapshot()).toBe(true)
    expect(policy.debug.getSnapshot()).toBe(false)
  })

  it('flips the logger gate on setDebug and on construction', () => {
    clearDebugLogs()
    const policy = new ScrollFlowPolicy()
    expect(dumpDebugLogs()).toEqual([]) // gate off by default
    policy.setDebug(true)
    expect(policy.debug.getSnapshot()).toBe(true)
    expect(dumpDebugLogs().some(e => e.detail === 'debug on')).toBe(true) // gate live
  })

  it('turns the logger gate on when a persisted debug=true blob loads', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ debug: true }))
    clearDebugLogs()
    new ScrollFlowPolicy()
    expect(dumpDebugLogs().some(e => e.detail === 'debug on')).toBe(true)
  })
})

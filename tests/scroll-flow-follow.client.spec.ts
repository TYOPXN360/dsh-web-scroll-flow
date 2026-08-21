// @vitest-environment jsdom
/** Collapsed Think summary line-end follow: `advanceFollowScroll` intercepts
 * ReasoningRow's `scrollLeft` writes (pending target, not applied) and eases
 * the real position with a TIME-based constant, so a 600Hz panel glides as
 * visibly as 60Hz — a frame-count easing would finish in ~5ms there and read
 * as the old instant jump. Small per-token deltas get a slower constant
 * (visible glide), large landings a fast one (catch up). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { advanceFollowScroll } from '../src/client/ScrollFlowBehavior.tsx'
import { clearDebugLogs, setDebugLogging } from '../src/client/debug-logger.ts'

afterEach(() => {
  vi.restoreAllMocks()
  setDebugLogging(false)
  clearDebugLogs()
})

/** A `[data-follow-end]`-style element with a readable/writable scrollLeft
 * (jsdom exposes the Element.prototype accessor pair, which the interception
 * saves and re-applies). */
function makeFollowEnd(initial = 0): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-follow-end', '')
  el.scrollLeft = initial
  return el
}

/** Install the interception with one no-op advance (delta 0), then return the
 * element ready for a subsequent ReasoningRow write to be recorded as pending. */
function seed(el: HTMLElement): void {
  advanceFollowScroll(el)
}

/** Mock performance.now along a timeline; the n-th call returns times[n]. */
function at(times: number[]): void {
  const now = vi.spyOn(performance, 'now')
  let i = 0
  now.mockImplementation(() => {
    const t = times[Math.min(i, times.length - 1)]
    i += 1
    return t
  })
}

describe('advanceFollowScroll', () => {
  it('intercepts a write as pending and eases toward it with the slow constant', () => {
    const el = makeFollowEnd(0)
    seed(el)
    at([1000])
    el.scrollLeft = 100 // ReasoningRow write — recorded, not applied
    const next = advanceFollowScroll(el)
    expect(next).not.toBe(100) // not an instant jump
    // First eased frame with no prior dt: default 16.7ms; k = 1 - exp(-16.7/30) ≈ 0.427
    expect(next).toBeCloseTo(42.7, 0)
    expect(el.scrollLeft).toBeCloseTo(42.7, 0) // applied to the real position
  })

  it('is refresh-rate independent: dt drives the easing, not frame count', () => {
    const el = makeFollowEnd(0)
    seed(el)
    at([1000, 1001.67])
    el.scrollLeft = 100
    const first = advanceFollowScroll(el) // dt default 16.7 → ~42.7
    const second = advanceFollowScroll(el) // dt 1.67ms (600Hz) → k = 1-exp(-1.67/30) ≈ 0.054
    expect(first).toBeCloseTo(42.7, 0)
    expect(second).toBeCloseTo(first + (100 - first) * (1 - Math.exp(-1.67 / 30)), 1)
  })

  it('uses the fast constant for large landings so it catches up', () => {
    const el = makeFollowEnd(0)
    seed(el)
    at([1000])
    el.scrollLeft = 500 // big landing (>100 threshold)
    const next = advanceFollowScroll(el)
    // k = 1 - exp(-16.7/10) ≈ 0.812; 0 + 500 * 0.812 ≈ 406
    expect(next).toBeCloseTo(406, 0)
  })

  it('clamps the frame delta so a backgrounded tab cannot jump the easing', () => {
    const el = makeFollowEnd(0)
    seed(el)
    at([1000, 6000])
    el.scrollLeft = 100
    advanceFollowScroll(el) // ~42.7, lastFollowAt = 1000
    const next = advanceFollowScroll(el) // 5000ms later, dt clamped to 100 → k ≈ 0.964
    expect(next).toBeCloseTo(42.7 + (100 - 42.7) * (1 - Math.exp(-100 / 30)), 0)
  })

  it('returns current without writing once the target is reached', () => {
    const el = makeFollowEnd(50)
    seed(el)
    at([1000])
    el.scrollLeft = 50.2 // sub-pixel delta
    expect(advanceFollowScroll(el)).toBe(50)
    expect(el.scrollLeft).toBe(50)
  })
})

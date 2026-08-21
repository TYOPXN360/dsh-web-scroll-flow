// @vitest-environment jsdom
/** ScrollFlowBehavior label pinning: while the tag is active and the view is
 * following, a rAF loop compensates the running-turn status label's glide-lag
 * dip with a `translateY(-min(lag, 80px))` transform — the label's visual
 * position stays pinned while the scrollport is behind the growing content.
 * The scroll position is never touched (small lags), so the vertical follow
 * animation (including an expanded Think's per-line commits) is preserved in
 * full; sub-pixel lags get no transform (label-text churn can't toggle a 1px
 * pin), and lags beyond the cap are corrected by one snap back to the floor
 * while following. Reader scroll-up releases both pin and snap. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { ScrollFlowBehavior, pinStatusLabel, type ScrollFlowBehaviorProps } from '../src/client/ScrollFlowBehavior.tsx'
import { clearDebugLogs, dumpDebugLogs, setDebugLogging } from '../src/client/debug-logger.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setDebugLogging(false)
  clearDebugLogs()
  // The test port is appended to the document (jsdom event propagation needs
  // it in the tree for the window-capture guard to see scroll events); drop
  // any leftovers the cleanup missed.
  document.body.querySelectorAll('[data-conversation-scroll]').forEach(el => el.remove())
})

function behaviorProps(enabled: boolean, running: boolean): ScrollFlowBehaviorProps {
  return {
    useEnabled: selector => selector(enabled),
    useSession: selector => selector({ running } as ConversationSnapshot),
  }
}

function makePort(scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement {
  const port = document.createElement('div')
  port.setAttribute('data-conversation-scroll', '')
  Object.defineProperty(port, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(port, 'clientHeight', { configurable: true, value: clientHeight })
  port.scrollTop = scrollTop
  return port
}

describe('pinStatusLabel', () => {
  it('compensates a per-line residual lag exactly', () => {
    // One appended line (~24px): the label dips by the lag; the transform
    // cancels it 1:1.
    expect(pinStatusLabel(makePort(1000, 100, 900))).toBe('') // gap 0: nothing
    expect(pinStatusLabel(makePort(1024, 100, 901))).toBe('translateY(-23px)')
  })

  it('covers the follow threshold and the 600Hz steady-state lag', () => {
    expect(pinStatusLabel(makePort(1000, 100, 875))).toBe('translateY(-25px)') // gap 25
    expect(pinStatusLabel(makePort(1000, 100, 860))).toBe('translateY(-40px)') // gap 40: the observed 600Hz steady lag
    expect(pinStatusLabel(makePort(1000, 100, 820))).toBe('translateY(-80px)') // gap 80: capped at PIN_CAP
  })

  it('caps beyond the pin reach without yanking the label', () => {
    // gap 1900: reader territory — capped at PIN_CAP (the following gate,
    // tested below, is what actually releases the pin for readers).
    expect(pinStatusLabel(makePort(3000, 100, 1000))).toBe('translateY(-80px)')
  })

  it('leaves landed and sub-pixel-gap viewports unpinned', () => {
    expect(pinStatusLabel(makePort(1000, 100, 900))).toBe('')
    expect(pinStatusLabel(makePort(1000, 100, 899.6))).toBe('') // gap 0.4 < dead zone
  })
})

describe('ScrollFlowBehavior label-pinning loop', () => {
  /** Capture the rAF callback instead of running it, so each frame can be
   * driven manually; cancelAnimationFrame clears the capture. */
  function stubRaf() {
    let captured: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      captured = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      captured = null
    })
    return { frame: () => captured?.(performance.now()), get captured() { return captured } }
  }

  function mount(port: HTMLElement, enabled: boolean, running: boolean) {
    // The port itself carries `data-conversation-scroll` (see makePort), so
    // the flow column and the behavior render directly inside it — the
    // behavior resolves the fake-geometry port, not a nested wrapper. The
    // port must sit in the document tree for the window-capture glide guard
    // to observe scroll events (jsdom propagates only tree-attached nodes).
    document.body.appendChild(port)
    const { rerender } = render(
      <>
        <div data-chat-flow="">
          <div role="status">Deep diving...</div>
        </div>
        <ScrollFlowBehavior {...behaviorProps(enabled, running)} />
      </>,
      { container: port },
    )
    const label = port.querySelector<HTMLElement>('[role="status"]')!
    return { label, rerender }
  }

  it('pins the label every frame while streaming, without touching scrollTop', () => {
    const raf = stubRaf()
    const port = makePort(1000, 100, 900)
    const { label } = mount(port, true, true)
    expect(raf.captured).not.toBeNull() // the loop is armed
    // A line is appended while pinned: floor grows, scrollTop lags 24px.
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 1024 })
    port.scrollTop = 900
    raf.frame()
    expect(label.style.transform).toBe('translateY(-24px)') // dip compensated
    expect(port.scrollTop).toBe(900) // scroll untouched: animation preserved
    // The glide lands: lag 0 → the pin releases, transform cleared.
    port.scrollTop = 924
    raf.frame()
    expect(label.style.transform).toBe('')
    expect(raf.captured).not.toBeNull() // the loop keeps running
  })

  it('caps the pin for large lags, then snaps the scrollport back to the floor', () => {
    const raf = stubRaf()
    const port = makePort(3000, 100, 900) // lag 2000: an expanding Think mid-glide
    const { label } = mount(port, true, true)
    raf.frame()
    // The snap fires on the first frame (lag 2000 > 80, following); in jsdom
    // the write lands instantly, so the pin releases in the same tick (a real
    // browser glides from 2000px down, the pin riding -80 → 0).
    expect(port.scrollTop).toBe(2900) // snapped to the floor
    expect(label.style.transform).toBe('')
  })

  it('does not re-snap while a snap-initiated glide is landing (lag falling)', () => {
    const raf = stubRaf()
    const port = makePort(3000, 100, 900)
    const { label } = mount(port, true, true)
    raf.frame() // snap: scrollTop → 2900
    expect(port.scrollTop).toBe(2900)
    // The glide lands: scrollTop now reports an intermediate position (lag 60).
    port.scrollTop = 2840
    raf.frame()
    expect(port.scrollTop).toBe(2840) // no re-snap while lag (60) < cap
    expect(label.style.transform).toBe('translateY(-60px)')
  })

  it('releases pin and snap when the reader scrolled away (following intent off)', () => {
    const raf = stubRaf()
    const port = makePort(3000, 100, 900) // lag 2000
    const { label } = mount(port, true, true)
    raf.frame() // snap fires: floor reached
    expect(port.scrollTop).toBe(2900)
    port.dispatchEvent(new Event('scroll')) // glide landed (gap 0): guard re-syncs lastTop
    // Reader scrolls up: backward movement clears the following intent.
    port.scrollTop = 2000
    port.dispatchEvent(new Event('scroll'))
    // New content commits while the reader is away (lag 1000) — no pin, no snap.
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 3100 })
    port.scrollTop = 2000
    raf.frame()
    expect(label.style.transform).toBe('') // not pinned for a reader
    expect(port.scrollTop).toBe(2000) // not yanked back down
  })

  it('does not arm the loop when streaming is off', () => {
    const raf = stubRaf()
    const port = makePort(1000, 100, 900)
    mount(port, true, false)
    expect(raf.captured).toBeNull()
  })

  it('releases the pin when streaming ends mid-glide', () => {
    const raf = stubRaf()
    const port = makePort(1024, 100, 900)
    const { label, rerender } = mount(port, true, true)
    raf.frame()
    expect(label.style.transform).toBe('translateY(-24px)')
    rerender(
      <>
        <div data-chat-flow="">
          <div role="status">Deep diving...</div>
        </div>
        <ScrollFlowBehavior {...behaviorProps(true, false)} />
      </>,
    )
    expect(raf.captured).toBeNull() // cancelAnimationFrame ran
    expect(label.style.transform).toBe('') // no lingering transform
  })

  it('records state and snap events while debug logging is on', () => {
    setDebugLogging(true)
    clearDebugLogs()
    const raf = stubRaf()
    const port = makePort(3000, 100, 900)
    mount(port, true, true)
    raf.frame() // one tick: tag state + snap fired
    const logs = dumpDebugLogs()
    expect(logs.some(e => e.type === 'state' && e.detail?.includes('tag on'))).toBe(true)
    expect(logs.some(e => e.type === 'snap' && e.detail?.includes('lag=2000'))).toBe(true)
  })
})

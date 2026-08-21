// @vitest-environment jsdom
/** ScrollFlowBehavior glide guard: while the tag is active, the capture-phase
 * window listener hides the chat view's own smooth-follow scroll events
 * (forward movement with a >25px gap) from the scrollport's bubble-phase
 * handler, so the follow ledger never sees a flip condition mid-animation.
 * Backward (reader) movement, landed positions, idle events, and events on
 * other scrollables all pass through untouched. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { ScrollFlowBehavior, type ScrollFlowBehaviorProps } from '../src/client/ScrollFlowBehavior.tsx'

afterEach(cleanup)

function behaviorProps(enabled: boolean, running: boolean): ScrollFlowBehaviorProps {
  return {
    useEnabled: selector => selector(enabled),
    useSession: selector => selector({ running } as ConversationSnapshot),
  }
}

/** Mount the behavior inside a simulated conversation scrollport with the
 * given geometry, pre-positioned at the bottom (gap 0). Registers a bubble
 * phase listener (the chat view's stand-in) after a settle event, so the
 * guard's initial position sync never counts against the spy. */
function mount(enabled: boolean, running: boolean) {
  const { container, rerender } = render(
    <div data-conversation-scroll="">
      <ScrollFlowBehavior {...behaviorProps(enabled, running)} />
    </div>,
  )
  const port = container.querySelector<HTMLElement>('[data-conversation-scroll]')!
  Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
  port.scrollTop = 900 // at the floor: gap = 1000 - 100 - 900 = 0
  port.dispatchEvent(new Event('scroll')) // settle: guard records scrollTop 900
  const spy = vi.fn()
  port.addEventListener('scroll', spy)
  return { port, spy, rerender }
}

/** Simulate a content commit while pinned: the floor grows to `newFloor`, then
 * the chat view's smooth write advances the position toward it. */
function commit(port: HTMLElement, newScrollHeight: number, glideTop: number) {
  Object.defineProperty(port, 'scrollHeight', { configurable: true, value: newScrollHeight })
  port.scrollTop = glideTop
}

describe('ScrollFlowBehavior glide guard', () => {
  it('suppresses forward glide events with a >25px gap while streaming', () => {
    const { port, spy } = mount(true, true)
    commit(port, 3000, 905) // new floor 2900; glide frame: gap 1995, moving down
    port.dispatchEvent(new Event('scroll'))
    expect(spy).not.toHaveBeenCalled() // the ledger never saw the flip condition
  })

  it('passes the landed event through and exits suppression', () => {
    const { port, spy } = mount(true, true)
    commit(port, 3000, 905)
    port.dispatchEvent(new Event('scroll')) // suppressed (in flight)
    expect(spy).not.toHaveBeenCalled()
    port.scrollTop = 2900 // glide completed: gap 0
    port.dispatchEvent(new Event('scroll'))
    expect(spy).toHaveBeenCalledTimes(1) // landing reached the chat view
  })

  it('passes reader backward movement through mid-glide and exits suppression', () => {
    const { port, spy } = mount(true, true)
    commit(port, 3000, 905)
    port.dispatchEvent(new Event('scroll')) // suppressed (in flight)
    expect(spy).not.toHaveBeenCalled()
    port.scrollTop = 800 // reader wheeled up during the glide
    port.dispatchEvent(new Event('scroll'))
    expect(spy).toHaveBeenCalledTimes(1) // reader movement is never hidden
    port.scrollTop = 700 // reader keeps moving up
    port.dispatchEvent(new Event('scroll'))
    expect(spy).toHaveBeenCalledTimes(2) // suppression stays exited for readers
  })

  it('keeps suppressing when the stream ends mid-glide, until landing', () => {
    const { port, spy, rerender } = mount(true, true)
    commit(port, 3000, 905)
    port.dispatchEvent(new Event('scroll')) // suppressed
    rerender(
      <div data-conversation-scroll="">
        <ScrollFlowBehavior {...behaviorProps(true, false)} />
      </div>,
    ) // stream ended while the glide is still in flight
    port.scrollTop = 1500
    port.dispatchEvent(new Event('scroll')) // glide tail: still suppressed
    expect(spy).not.toHaveBeenCalled()
    port.scrollTop = 2900
    port.dispatchEvent(new Event('scroll')) // landed: passes
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not suppress when streaming is off', () => {
    const { port, spy } = mount(true, false)
    commit(port, 3000, 905)
    port.dispatchEvent(new Event('scroll'))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not suppress a small commit glide (gap within the follow threshold)', () => {
    const { port, spy } = mount(true, true)
    commit(port, 1020, 905) // new floor 920; glide frame: gap 15 <= 25
    port.dispatchEvent(new Event('scroll'))
    expect(spy).toHaveBeenCalledTimes(1) // the tail-landing loop pins these, not the guard
  })

  it('ignores scroll events from other scrollables', () => {
    const { port, spy } = mount(true, true)
    const nested = document.createElement('div')
    port.append(nested)
    const nestedSpy = vi.fn()
    nested.addEventListener('scroll', nestedSpy)
    nested.dispatchEvent(new Event('scroll'))
    expect(nestedSpy).toHaveBeenCalledTimes(1) // the guard never touches it
    expect(spy).not.toHaveBeenCalled()
  })
})

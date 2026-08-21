// @vitest-environment jsdom
/** ScrollFlowBehavior behavior: the `data-scroll-flow` tag lands on the
 * owning conversation scrollport only while streaming AND the preference is
 * enabled, and drops when either condition ends. */
import { afterEach, describe, expect, it } from 'vitest'
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

function mount(enabled: boolean, running: boolean) {
  const { container } = render(
    <div data-conversation-scroll="">
      <ScrollFlowBehavior {...behaviorProps(enabled, running)} />
    </div>,
  )
  return container.querySelector<HTMLElement>('[data-conversation-scroll]')!
}

describe('ScrollFlowBehavior', () => {
  it('tags the scrollport while streaming and enabled', () => {
    const scrollport = mount(true, true)
    expect(scrollport.hasAttribute('data-scroll-flow')).toBe(true)
  })

  it('leaves the scrollport untagged when streaming is off', () => {
    const scrollport = mount(true, false)
    expect(scrollport.hasAttribute('data-scroll-flow')).toBe(false)
  })

  it('leaves the scrollport untagged when the preference is off', () => {
    const scrollport = mount(false, true)
    expect(scrollport.hasAttribute('data-scroll-flow')).toBe(false)
  })

  it('drops the tag when the stream ends', () => {
    const { container, rerender } = render(
      <div data-conversation-scroll="">
        <ScrollFlowBehavior {...behaviorProps(true, true)} />
      </div>,
    )
    const scrollport = container.querySelector<HTMLElement>('[data-conversation-scroll]')!
    expect(scrollport.hasAttribute('data-scroll-flow')).toBe(true)
    rerender(
      <div data-conversation-scroll="">
        <ScrollFlowBehavior {...behaviorProps(true, false)} />
      </div>,
    )
    expect(scrollport.hasAttribute('data-scroll-flow')).toBe(false)
  })

  it('is a no-op without an owning scrollport', () => {
    expect(() => render(<ScrollFlowBehavior {...behaviorProps(true, true)} />)).not.toThrow()
  })
})

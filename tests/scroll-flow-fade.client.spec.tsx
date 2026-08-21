// @vitest-environment jsdom
/** New-row fade-in: the behavior watches the flow column's subtree with a
 * MutationObserver and plays a one-shot 220ms opacity animation on freshly
 * mounted flow items (`data-chat-flow-key`: messages, tool-call rows) and
 * collapsed reasoning rows (`data-follow-end`). Plain inserts (text nodes,
 * non-marker elements) never animate; the observer only runs while the
 * preference is on. Element.prototype.animate is stubbed (jsdom has none). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { ScrollFlowBehavior, type ScrollFlowBehaviorProps } from '../src/client/ScrollFlowBehavior.tsx'

const originalAnimate = Element.prototype.animate

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Element.prototype.animate = originalAnimate
  document.body.querySelectorAll('[data-conversation-scroll]').forEach(el => el.remove())
})

function behaviorProps(enabled: boolean, running: boolean): ScrollFlowBehaviorProps {
  return {
    useEnabled: selector => selector(enabled),
    useSession: selector => selector({ running } as ConversationSnapshot),
  }
}

function mount(enabled: boolean, running: boolean) {
  const port = document.createElement('div')
  port.setAttribute('data-conversation-scroll', '')
  Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
  port.scrollTop = 900
  document.body.appendChild(port)
  const animate = vi.fn()
  Element.prototype.animate = animate
  const { rerender } = render(
    <>
      <div data-chat-flow="">
        <div role="status">Deep diving...</div>
      </div>
      <ScrollFlowBehavior {...behaviorProps(enabled, running)} />
    </>,
    { container: port },
  )
  const flow = port.querySelector<HTMLElement>('[data-chat-flow]')!
  return { port, flow, animate, rerender }
}

/** MutationObserver callbacks are microtasks in jsdom; let them flush. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function flowItem(key: string, kind = 'message'): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-chat-flow-key', key)
  el.setAttribute('data-chat-flow-kind', kind)
  return el
}

describe('new-row fade-in', () => {
  it('fades in a freshly mounted flow item (message / tool call)', async () => {
    const { flow, animate } = mount(true, true)
    flow.appendChild(flowItem('k1', 'tool-call'))
    await flush()
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenCalledWith(
      [{ opacity: 0 }, { opacity: 1 }],
      expect.objectContaining({ duration: 220, easing: 'ease-out' }),
    )
  })

  it('fades in a collapsed reasoning row appended deep inside a message', async () => {
    const { flow, animate } = mount(true, true)
    const item = flowItem('k1')
    const span = document.createElement('span')
    span.setAttribute('data-follow-end', '')
    item.appendChild(span)
    flow.appendChild(item)
    await flush()
    // Both the flow item and the reasoning row animate (subtree observation).
    expect(animate).toHaveBeenCalledTimes(2)
  })

  it('ignores container divs with no rows inside', async () => {
    const { flow, animate } = mount(true, true)
    const div = document.createElement('div')
    div.textContent = 'chrome wrapper'
    flow.appendChild(div)
    await flush()
    expect(animate).not.toHaveBeenCalled()
  })

  it('ignores inline bits (span, icon) inside a message', async () => {
    const { flow, animate } = mount(true, true)
    const item = flowItem('k1')
    const span = document.createElement('span')
    span.setAttribute('data-chat-anchor-key', 'a1')
    span.textContent = 'inline'
    item.appendChild(span)
    flow.appendChild(item)
    await flush()
    expect(animate).toHaveBeenCalledTimes(1) // only the flow item, not the span
  })

  it('fades in every markdown block row inside a message', async () => {
    const { flow, animate } = mount(true, true)
    const item = flowItem('k1')
    const body = document.createElement('div')
    const p = document.createElement('p'); p.textContent = 'para one'
    const p2 = document.createElement('p'); p2.textContent = 'para two'
    const ul = document.createElement('ul')
    const li = document.createElement('li'); li.textContent = 'item'
    ul.appendChild(li)
    const pre = document.createElement('pre'); pre.textContent = 'code()'
    const h2 = document.createElement('h2'); h2.textContent = 'head'
    body.append(p, p2, ul, pre, h2)
    item.appendChild(body)
    flow.appendChild(item)
    await flush()
    // flow item + 6 markdown rows (p, p, ul, li, pre, h2)
    expect(animate).toHaveBeenCalledTimes(7)
  })

  it('fades in a markdown block appended to an existing message', async () => {
    const { flow, animate } = mount(true, true)
    const item = flowItem('k1')
    flow.appendChild(item)
    await flush()
    expect(animate).toHaveBeenCalledTimes(1)
    const body = document.createElement('div')
    const p = document.createElement('p'); p.textContent = 'streamed later'
    body.appendChild(p)
    item.appendChild(body)
    await flush()
    expect(animate).toHaveBeenCalledTimes(2) // the new row animates on its own
  })

  it('slides a streaming expanded think body in, without splitting it', async () => {
    const { flow, animate } = mount(true, true)
    const item = flowItem('k1')
    const think = document.createElement('div')
    think.setAttribute('data-variant', 'think')
    think.setAttribute('data-state', 'running')
    const body = document.createElement('div') // css.thinkBody: bare {text}
    body.textContent = 'line one\nline two\nline three'
    think.appendChild(body)
    item.appendChild(think)
    flow.appendChild(item)
    await flush()
    // the body stays a bare text node — only the slide-in animation runs
    expect(body.children).toHaveLength(0)
    expect(animate).toHaveBeenCalledTimes(2) // item + slide-in (think root no longer row-level)
  })

  it('does not touch a collapsed running think (no body)', async () => {
    const { flow, animate } = mount(true, true)
    const item = flowItem('k1')
    const think = document.createElement('div')
    think.setAttribute('data-variant', 'think')
    think.setAttribute('data-state', 'running')
    // collapsed → summary span with data-follow-end, no body div
    const span = document.createElement('span')
    span.setAttribute('data-follow-end', '')
    span.textContent = '正在思考中…'
    think.appendChild(span)
    item.appendChild(think)
    flow.appendChild(item)
    await flush()
    expect(think.style.cssText).toBe('') // no inline styles applied
    // item fades in, think gets its row fade via follow-end, no slide
    expect(animate).toHaveBeenCalledTimes(2) // item + think row via follow-end
  })

  it('reveals rows from the top when an already-mounted think is expanded', async () => {
    const { flow, animate } = mount(true, true)
    // The Think root mounts first (collapsed); the user expands it later, so
    // only its body is inserted — the observer must find the Think via the
    // body's ancestor and reveal the settled content from the top.
    const item = flowItem('k1')
    const think = document.createElement('div')
    think.setAttribute('data-variant', 'think')
    think.setAttribute('data-state', 'ok')
    item.appendChild(think)
    flow.appendChild(item)
    await flush()
    const before = animate.mock.calls.length // item + think row
    const body = document.createElement('div')
    body.textContent = 'top\nmiddle\nbottom'
    think.appendChild(body) // expansion mounts only the body
    await flush()
    expect([...body.children].map(r => r.textContent)).toEqual(['top', 'middle', 'bottom'])
    const rowDelays = animate.mock.calls.slice(before).map(c => c[1]?.delay ?? 0)
    expect(rowDelays).toEqual([0, 30, 60])
  })

  it('does not re-reveal when a streaming expansion settles', async () => {
    const { flow, animate } = mount(true, true)
    const item = flowItem('k1')
    const think = document.createElement('div')
    think.setAttribute('data-variant', 'think')
    think.setAttribute('data-state', 'running')
    const body = document.createElement('div')
    body.textContent = 'line one\nline two'
    think.appendChild(body)
    item.appendChild(think)
    flow.appendChild(item)
    await flush()
    think.setAttribute('data-state', 'ok')
    await flush()
    // no split — the text was already on screen while streaming, so a
    // re-reveal would be redundant.
    expect(body.children).toHaveLength(0) // still a bare text node
  })

  it('does not fade the same row twice when reported as both an added node and a descendant', async () => {
    const { flow, animate } = mount(true, true)
    // A flow item is inserted with the thinking row inside; the same row is
    // then re-inserted by itself (React reporting it again): it must not
    // replay its animation a second time.
    const item = flowItem('k1')
    const think = document.createElement('div')
    think.setAttribute('data-variant', 'think')
    think.setAttribute('data-state', 'ok')
    const span = document.createElement('span')
    span.setAttribute('data-follow-end', '')
    span.textContent = 'summary'
    think.appendChild(span)
    item.appendChild(think)
    flow.appendChild(item)
    await flush()
    expect(animate).toHaveBeenCalledTimes(2) // item + think row
    flow.appendChild(think) // moves it — insertion reported again
    await flush()
    expect(animate).toHaveBeenCalledTimes(2) // think row already faded
  })

  it('does not touch the collapsed summary span', async () => {
    const { flow, animate } = mount(true, true)
    const item = flowItem('k1')
    const think = document.createElement('div')
    think.setAttribute('data-variant', 'think')
    think.setAttribute('data-state', 'running')
    const span = document.createElement('span')
    span.setAttribute('data-follow-end', '')
    span.textContent = 'summary line'
    think.appendChild(span)
    item.appendChild(think)
    flow.appendChild(item)
    await flush()
    // flow item + follow-end span (collapsed summary); the span is not a DIV
    // body, so exactly 2 animations — no phantom third from the wrapper.
    expect(animate).toHaveBeenCalledTimes(2)
  })

  it('splits only the innermost think body once settled, never the wrapper', async () => {
    const { flow, animate } = mount(true, true)
    // Real ReasoningRow DOM: think root > wrapper div > thinkBody (bare text).
    // Only the innermost body may be split — splitting the wrapper would wipe
    // the styled text container and leave plain rows ("turns into body text").
    const item = flowItem('k1')
    const think = document.createElement('div')
    think.setAttribute('data-variant', 'think')
    think.setAttribute('data-state', 'ok')
    const wrapper = document.createElement('div')
    const body = document.createElement('div')
    body.textContent = 'a\nb\nc'
    wrapper.appendChild(body)
    think.appendChild(wrapper)
    item.appendChild(think)
    flow.appendChild(item)
    await flush()
    // the wrapper keeps its child; only the body got split
    expect(wrapper.children).toHaveLength(1)
    expect(body.children).toHaveLength(3)
    expect([...body.children].map(r => r.textContent)).toEqual(['a', 'b', 'c'])
    expect(animate).toHaveBeenCalledTimes(4) // item + 3 rows (think root not row-level without follow-end)
  })

  it('does not observe when the preference is off', async () => {
    const { flow, animate } = mount(false, true)
    flow.appendChild(flowItem('k1'))
    await flush()
    expect(animate).not.toHaveBeenCalled()
  })

  it('disconnects the observer on unmount', async () => {
    const { flow, animate, rerender } = mount(true, true)
    rerender(
      <>
        <div data-chat-flow="">
          <div role="status">Deep diving...</div>
        </div>
      </>,
    )
    flow.appendChild(flowItem('k1'))
    await flush()
    expect(animate).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
/** ScrollFlowSection: the dedicated Settings menu page hosting the streaming
 * scroll animation switch and the Debug-log switch — heading copy, switch
 * states, and both toggle writes — fed straight props, no render machinery. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ScrollFlowSection, type ScrollFlowSectionProps } from '../src/client/ScrollFlowSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function mount(enabled: boolean, debug = false) {
  const setEnabled = vi.fn()
  const setDebug = vi.fn()
  const props: ScrollFlowSectionProps = {
    useEnabled: selector => selector(enabled),
    useDebug: selector => selector(debug),
    setEnabled,
    setDebug,
    t: (key) => zh[key] ?? key,
  }
  render(<ScrollFlowSection {...props} />)
  return { setEnabled, setDebug }
}

describe('ScrollFlowSection', () => {
  it('renders the page heading and both switch rows', () => {
    mount(true)
    expect(screen.getByText('滚动动画')).toBeDefined()
    expect(screen.getByText('流式滚动动画')).toBeDefined()
    expect(screen.getByText('模型输出时自动跟随最新内容，滚动平滑过渡（含未展开的思考摘要）')).toBeDefined()
    expect(screen.getByText('调试日志')).toBeDefined()
    expect(screen.getByText('记录插件事件与帧率（约 2 万条环形上限，经 window.__DSH_SCROLL_FLOW_DEBUG__ 查看）')).toBeDefined()
  })

  it('reflects the enabled state on the first switch', () => {
    mount(true)
    const controls = screen.getAllByRole('switch')
    expect(controls[0].getAttribute('aria-checked')).toBe('true')
  })

  it('reflects the disabled state on the first switch', () => {
    mount(false)
    const controls = screen.getAllByRole('switch')
    expect(controls[0].getAttribute('aria-checked')).toBe('false')
  })

  it('reflects the debug state on the second switch', () => {
    mount(true, true)
    const controls = screen.getAllByRole('switch')
    expect(controls[1].getAttribute('aria-checked')).toBe('true')
  })

  it('toggles the animation switch off through the write callback', () => {
    const { setEnabled } = mount(true)
    fireEvent.click(screen.getAllByRole('switch')[0])
    expect(setEnabled).toHaveBeenCalledWith(false)
  })

  it('toggles the debug switch on through the write callback', () => {
    const { setDebug } = mount(false)
    fireEvent.click(screen.getAllByRole('switch')[1])
    expect(setDebug).toHaveBeenCalledWith(true)
  })
})

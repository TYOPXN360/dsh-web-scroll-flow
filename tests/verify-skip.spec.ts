// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { TypewriterController } from '../src/client/typewriter.ts'

let clock = 0

function makeFlow(): { md: HTMLElement; shell: HTMLElement } {
  const flow = document.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  const shell = document.createElement('div')
  shell.style.position = 'static'
  const md = document.createElement('div')
  md.className = '_markdown_abc'
  shell.append(md)
  flow.append(shell)
  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  flow.append(status)
  document.body.append(flow)
  return { md, shell }
}

/** 只用手动 tick 驱动（jsdom 的 setTimeout interval 会与手动时钟竞争）。 */
function tickOnly(tw: TypewriterController, n: number): void {
  for (let i = 0; i < n; i++) {
    clock += 16
    tw.tick(clock)
  }
}

beforeEach(() => {
  clock = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('大文本 Markdown 不跳过', () => {
  it('长文本最终完整覆盖源文本（不跳过中间段）', async () => {
    const { md, shell } = makeFlow()
    const tw = new TypewriterController(
      document.querySelector<HTMLElement>('[data-chat-flow]')!,
      { loadGrace: 0, baseSpeed: 0.08, settleDelay: 100_000, cursorHold: 1000 },
    ).attach()
    md.innerHTML = [
      '<p>第一段内容</p>',
      '<p>第二段内容</p>',
      '<pre><code>const code = 1</code></pre>',
      '<ul><li>列表项</li></ul>',
    ].join('')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(tw.active).toBe(true)
    const sourceText = md.textContent ?? ''
    const overlay = shell.querySelector<HTMLElement>('.dsh-scroll-flow-typewriter-overlay')!

    tickOnly(tw, 400)
    expect(overlay.textContent).toBe(sourceText)
    expect(tw.shown).toBe(sourceText.length)
    tw.dispose()
  })

  it('打字中途结构重建（追加段落/代码块/列表）后仍完整显示', async () => {
    const { md, shell } = makeFlow()
    const tw = new TypewriterController(
      document.querySelector<HTMLElement>('[data-chat-flow]')!,
      { loadGrace: 0, baseSpeed: 0.08, settleDelay: 100_000, cursorHold: 1000 },
    ).attach()

    md.innerHTML = '<p>第一段内容</p><p>第二段内容</p>'
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(tw.active).toBe(true)
    tickOnly(tw, 5)

    // 结构重建：追加代码块和列表（React 重渲染 → 节点数变化）。
    // renderOverlay 会用最新 markdown 重建 overlay（旧 overlay 被 replaceWith）。
    md.innerHTML = '<p>第一段内容</p><p>第二段内容</p><pre><code>code here</code></pre><ul><li>item</li></ul>'
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(tw.active).toBe(true)

    const sourceText = md.textContent ?? ''
    tickOnly(tw, 500)
    // 重新查询 overlay（重建后旧引用已 detached）。
    const overlay = shell.querySelector<HTMLElement>('.dsh-scroll-flow-typewriter-overlay')!
    expect(overlay).not.toBeNull()
    expect(overlay.textContent).toBe(sourceText)
    tw.dispose()
  })
})

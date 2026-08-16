// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypewriterController, TYPEWRITER_OVERLAY_CLASS } from '../src/client/typewriter.ts'

let clock = 0

function makeMarkdownFlow(
  texts: string[],
): { flow: HTMLElement; markdowns: HTMLElement[]; shells: HTMLElement[] } {
  const flow = document.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  const markdowns: HTMLElement[] = []
  const shells: HTMLElement[] = []
  for (const text of texts) {
    const shell = document.createElement('div')
    shell.style.position = 'static'
    const markdown = document.createElement('div')
    markdown.className = '_markdown_abc123'
    markdown.style.cssText = 'font: 14px/22px sans-serif; padding-left: 8px;'
    markdown.textContent = text
    shell.append(markdown)
    flow.append(shell)
    markdowns.push(markdown)
    shells.push(shell)
  }
  document.body.append(flow)
  return { flow, markdowns, shells }
}

/** 修改 markdown 文本并等待 MutationObserver 落地。 */
async function growText(markdown: HTMLElement, text: string): Promise<void> {
  markdown.textContent = text
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

beforeEach(() => {
  clock = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('TypewriterController', () => {
  it('文本增长时安装覆盖层并逐字吐字，底层隐藏', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()

    await growText(markdown, '你好')
    expect(typewriter.active).toBe(true)
    expect(markdown.style.visibility).toBe('hidden')
    const overlay = shell.querySelector<HTMLElement>(`.${TYPEWRITER_OVERLAY_CLASS}`)
    expect(overlay).not.toBeNull()
    expect(overlay!.textContent).toBe('')

    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBe(1)
    expect(overlay!.textContent).toBe('你')
    expect(overlay!.querySelector('span')).not.toBeNull() // 光标

    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBe(2)
    expect(overlay!.textContent).toBe('你好')
    typewriter.dispose()
  })

  it('覆盖层继承目标排版并对齐内容盒（打字中与打完后位置一致）', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    // 模拟 markdown 在 shell 内有偏移和排版。
    markdown.style.cssText = 'font: 15px/24px serif; padding-left: 12px; padding-top: 6px; letter-spacing: 1px;'
    Object.defineProperty(markdown, 'offsetLeft', { configurable: true, get: () => 12 })
    Object.defineProperty(markdown, 'offsetTop', { configurable: true, get: () => 6 })
    Object.defineProperty(markdown, 'offsetWidth', { configurable: true, get: () => 400 })
    Object.defineProperty(markdown, 'offsetHeight', { configurable: true, get: () => 48 })

    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()
    await growText(markdown, '排版')

    const overlay = shell.querySelector<HTMLElement>(`.${TYPEWRITER_OVERLAY_CLASS}`)!
    expect(overlay.style.left).toBe('12px')
    expect(overlay.style.top).toBe('6px')
    expect(overlay.style.width).toBe('400px')
    expect(overlay.style.fontFamily).toBe('serif')
    expect(overlay.style.fontSize).toContain('15px')
    expect(overlay.style.lineHeight).toContain('24px')
    // jsdom 对 letter-spacing 的 computed 支持有限；验证它进入了内联样式。
    expect(overlay.style.cssText).toContain('letter-spacing: 1px')
    typewriter.dispose()
  })

  it('多个 Markdown 目标（思维链 + 正文）可同时打字', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow(['', ''])
    const think = markdowns[0]!
    const body = markdowns[1]!
    const thinkShell = shells[0]!
    const bodyShell = shells[1]!
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()

    await growText(think, '思考中')
    await growText(body, '回答')

    expect(typewriter.active).toBe(true)
    expect(thinkShell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).not.toBeNull()
    expect(bodyShell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).not.toBeNull()

    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBe(2) // 两个目标各推进 1 字
    typewriter.dispose()
  })

  it('文本停止增长后恢复原始 Markdown 并移除覆盖层', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 200, cursorHold: 30 }).attach()

    await growText(markdown, '固定文本')
    for (let i = 0; i < 4; i++) {
      clock += 16
      typewriter.tick(clock)
    }
    expect(typewriter.shown).toBe(4)

    clock += 300
    typewriter.tick(clock)
    await new Promise<void>((resolve) => { setTimeout(resolve, 60) })

    // 光标保持期结束后 session 清理，恢复 Markdown。
    expect(typewriter.active).toBe(false)
    expect(markdown.style.visibility).toBe('')
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    typewriter.dispose()
  })

  it('大文本提速（effectiveSpeed 3 倍：同样 tick 推进更多字符）', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 10_000, cursorHold: 1 }).attach()

    await growText(markdown, 'x'.repeat(13_000))
    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBeGreaterThanOrEqual(4)
    typewriter.dispose()
  })

  it('overlay 自身 mutation 不会误重启打字机', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 50, cursorHold: 5 }).attach()

    await growText(markdown, '短')
    clock += 16
    typewriter.tick(clock)
    clock += 100
    typewriter.tick(clock)
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(typewriter.active).toBe(false)
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    expect(markdown.style.visibility).toBe('')

    markdown.setAttribute('data-x', '1')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(typewriter.active).toBe(false)
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    typewriter.dispose()
  })

  it('dispose 清理覆盖层与隐藏状态', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()

    await growText(markdown, '测试')
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).not.toBeNull()

    typewriter.dispose()
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    expect(markdown.style.visibility).toBe('')
  })
})

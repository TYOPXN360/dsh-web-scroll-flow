// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypewriterController, TYPEWRITER_OVERLAY_CLASS } from '../src/client/typewriter.ts'

let clock = 0

function makeMarkdownFlow(text: string): { flow: HTMLElement; markdown: HTMLElement; shell: HTMLElement } {
  const shell = document.createElement('div')
  shell.style.position = 'static'
  const markdown = document.createElement('div')
  markdown.className = '_markdown_abc123'
  markdown.textContent = text
  shell.append(markdown)
  const flow = document.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  flow.append(shell)
  document.body.append(flow)
  return { flow, markdown, shell }
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
    const { flow, markdown, shell } = makeMarkdownFlow('')
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()

    await growText(markdown, '你好')
    expect(typewriter.active).toBe(true)
    expect(markdown.style.visibility).toBe('hidden')
    const overlay = shell.querySelector<HTMLElement>(`.${TYPEWRITER_OVERLAY_CLASS}`)
    expect(overlay).not.toBeNull()
    expect(overlay!.textContent).toBe('')

    // 推进一帧：0.1 字/ms * 16ms ≈ 1 字
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

  it('文本停止增长后恢复原始 Markdown 并移除覆盖层', async () => {
    const { flow, markdown, shell } = makeMarkdownFlow('')
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 200, cursorHold: 30 }).attach()

    await growText(markdown, '固定文本')
    // 推进到全部显示（4 次 tick，累计 64ms < settleDelay 200，不提前 settle）。
    for (let i = 0; i < 4; i++) {
      clock += 16
      typewriter.tick(clock)
    }
    expect(typewriter.shown).toBe(4)

    // 超过 settleDelay 后再 tick 应触发 settle，cursorHold 后清理。
    clock += 300
    typewriter.tick(clock)
    expect(typewriter.active).toBe(false)
    await new Promise<void>((resolve) => { setTimeout(resolve, 60) })

    expect(markdown.style.visibility).toBe('')
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    typewriter.dispose()
  })

  it('大文本提速（effectiveSpeed 3 倍：同样 tick 推进更多字符）', async () => {
    const { flow, markdown } = makeMarkdownFlow('')
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 10_000, cursorHold: 1 }).attach()

    await growText(markdown, 'x'.repeat(13_000))
    clock += 16
    typewriter.tick(clock)
    // 基础 0.1*16=1.6→1；3 倍=0.3*16=4.8→4
    expect(typewriter.shown).toBeGreaterThanOrEqual(4)
    typewriter.dispose()
  })

  it('overlay 自身 mutation 不会误重启打字机', async () => {
    const { flow, markdown, shell } = makeMarkdownFlow('')
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 50, cursorHold: 5 }).attach()

    await growText(markdown, '短')
    clock += 16
    typewriter.tick(clock)
    clock += 100
    typewriter.tick(clock) // settle
    expect(typewriter.active).toBe(false)
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    expect(markdown.style.visibility).toBe('')

    // 静止文本不再被重新打字（即使有其它 mutation）。
    markdown.setAttribute('data-x', '1')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(typewriter.active).toBe(false)
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    typewriter.dispose()
  })

  it('dispose 清理覆盖层与隐藏状态', async () => {
    const { flow, markdown, shell } = makeMarkdownFlow('')
    const typewriter = new TypewriterController(flow, { baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()

    await growText(markdown, '测试')
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).not.toBeNull()

    typewriter.dispose()
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    expect(markdown.style.visibility).toBe('')
  })
})

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
  it('初始化宽限期内不启动打字机（刷新后历史消息不打字）', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new TypewriterController(
      flow,
      { loadGrace: 1000, baseSpeed: 0.1, settleDelay: 500, cursorHold: 30 },
    ).attach()

    await growText(markdown, '历史消息加载')
    expect(typewriter.active).toBe(false)
    typewriter.dispose()
  })

  it('宽限期过后新增增长才启动打字机', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new TypewriterController(
      flow,
      { loadGrace: 100, baseSpeed: 0.1, settleDelay: 500, cursorHold: 30 },
    ).attach()

    await growText(markdown, '加载内容')
    expect(typewriter.active).toBe(false)

    clock += 100
    await growText(markdown, '加载内容新增文本')
    expect(typewriter.active).toBe(true)
    typewriter.dispose()
  })

  it('文本增长时安装覆盖层并逐字吐字，底层不占高度（无整段空白）', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    await growText(markdown, '你好')
    expect(typewriter.active).toBe(true)
    const overlay = shell.querySelector<HTMLElement>(`.${TYPEWRITER_OVERLAY_CLASS}`)
    expect(overlay).not.toBeNull()
    // markdown 打字期间 display:none，不预留整段空白。
    expect(markdown.style.display).toBe('none')
    expect(overlay!.style.display).not.toBe('none')
    expect(overlay!.textContent).toBe('')
    expect(overlay!.querySelector('span')).not.toBeNull() // 光标

    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBe(1)
    expect(overlay!.textContent).toBe('你')

    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBe(2)
    expect(overlay!.textContent).toBe('你好')
    typewriter.dispose()
  })

  it('大文本按要求公式提速（13 000 字远快于短文本）', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 10_000,
      cursorHold: 1,
    }).attach()

    await growText(markdown, 'x'.repeat(13_000))
    clock += 16
    typewriter.tick(clock)
    // 13 000 字 → multiplier ≈ 51 → 每帧约 81 字。
    expect(typewriter.shown).toBeGreaterThanOrEqual(10)
    typewriter.dispose()
  })

  it('多个 Markdown 目标（思维链 + 正文）可同时打字', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow(['', ''])
    const think = markdowns[0]!
    const body = markdowns[1]!
    const thinkShell = shells[0]!
    const bodyShell = shells[1]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    await growText(think, '思考中')
    await growText(body, '回答')

    expect(typewriter.active).toBe(true)
    expect(thinkShell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).not.toBeNull()
    expect(bodyShell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).not.toBeNull()

    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBe(2)
    typewriter.dispose()
  })

  it('文本停止增长后恢复原始 Markdown 并移除覆盖层', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 200,
      cursorHold: 30,
    }).attach()

    await growText(markdown, '固定文本')
    for (let i = 0; i < 4; i++) {
      clock += 16
      typewriter.tick(clock)
    }
    expect(typewriter.shown).toBe(4)

    clock += 300
    typewriter.tick(clock)
    await new Promise<void>((resolve) => { setTimeout(resolve, 60) })

    expect(typewriter.active).toBe(false)
    expect(markdown.style.display).toBe('')
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    typewriter.dispose()
  })

  it('overlay 自身 mutation 不会误重启打字机', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 50,
      cursorHold: 5,
    }).attach()

    await growText(markdown, '短')
    clock += 16
    typewriter.tick(clock)
    clock += 100
    typewriter.tick(clock)
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(typewriter.active).toBe(false)
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    expect(markdown.style.display).toBe('')

    markdown.setAttribute('data-x', '1')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(typewriter.active).toBe(false)
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    typewriter.dispose()
  })

  it('dispose 清理覆盖层与恢复 markdown', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    await growText(markdown, '测试')
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).not.toBeNull()

    typewriter.dispose()
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    expect(markdown.style.display).toBe('')
  })
})

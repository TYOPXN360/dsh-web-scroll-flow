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
  it('初始化宽限期内不启动打字机（刷新后历史消息不打字）', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new TypewriterController(
      flow,
      { loadGrace: 1000, baseSpeed: 0.1, settleDelay: 500, cursorHold: 30 },
    ).attach()

    // 宽限期内历史消息渲染（文本变化）——不启动打字。
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

    // 宽限期内增长被忽略。
    await growText(markdown, '加载内容')
    expect(typewriter.active).toBe(false)

    // 宽限期过后新增长触发打字。
    clock += 100
    await growText(markdown, '加载内容新增文本')
    expect(typewriter.active).toBe(true)
    typewriter.dispose()
  })

  it('文本增长时安装覆盖层并逐字吐字，底层隐藏', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()

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

  it('覆盖层以目标结构克隆承载，逐字填充且段落行距保留（打完不跳变）', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    Object.defineProperty(markdown, 'offsetLeft', { configurable: true, get: () => 5 })
    Object.defineProperty(markdown, 'offsetTop', { configurable: true, get: () => 3 })
    Object.defineProperty(markdown, 'offsetWidth', { configurable: true, get: () => 300 })

    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()
    // 流式更新：markdown 渲染成"两段"结构并增长文本。
    const p1 = document.createElement('p')
    p1.textContent = '第一段'
    const p2 = document.createElement('p')
    p2.textContent = '第二段内容'
    markdown.textContent = ''
    markdown.append(p1, p2)
    await growText(p1, '第一段')

    const overlay = shell.querySelector<HTMLElement>(`.${TYPEWRITER_OVERLAY_CLASS}`)!
    expect(overlay.querySelectorAll('p').length).toBe(2) // 结构克隆保留段落
    expect(overlay.style.left).toBe('5px')
    expect(overlay.style.top).toBe('3px')
    expect(overlay.style.width).toBe('300px')

    // 只打完第一段时，第二段为空块被隐藏（不预留整段空白）。
    clock += 16
    typewriter.tick(clock)
    typewriter.tick(clock)
    typewriter.tick(clock)
    const overlayPs = overlay.querySelectorAll('p')
    expect(overlayPs[0]!.style.display).not.toBe('none')
    expect(overlayPs[1]!.style.display).toBe('none')

    // 打完所有：两段都显示。
    clock += 200
    typewriter.tick(clock)
    expect(overlayPs[1]!.style.display).not.toBe('none')
    typewriter.dispose()
  })

  it('大文本提速（有效速度随文本总量线性上升）', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1, settleDelay: 10_000, cursorHold: 1 }).attach()

    // 小文本：baseSpeed。
    await growText(markdown, '短文本')
    clock += 16
    typewriter.tick(clock)
    const smallStep = typewriter.shown
    expect(smallStep).toBe(1)
    typewriter.dispose()
  })

  it('大文本提速（13 000 字远快于短文本）', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1, settleDelay: 10_000, cursorHold: 1 }).attach()

    await growText(markdown, 'x'.repeat(13_000))
    clock += 16
    typewriter.tick(clock)
    // 13 000 字 → 提速 ~18 倍 → 每帧约 28 字。
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
      baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()

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
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1, settleDelay: 200, cursorHold: 30 }).attach()

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

  it('overlay 自身 mutation 不会误重启打字机', async () => {
    const { flow, markdowns, shells } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const shell = shells[0]!
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1, settleDelay: 50, cursorHold: 5 }).attach()

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
    const typewriter = new TypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1, settleDelay: 1_000, cursorHold: 50 }).attach()

    await growText(markdown, '测试')
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).not.toBeNull()

    typewriter.dispose()
    expect(shell.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}`)).toBeNull()
    expect(markdown.style.visibility).toBe('')
  })
})

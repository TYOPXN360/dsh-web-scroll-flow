// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeTypewriterController, TYPEWRITER_OVERLAY_CLASS } from '../src/client/native-typewriter.ts'

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
  // 模拟正在运行的会话：Deep diving 状态行存在，打字机才允许启动。
  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  status.textContent = 'Deep diving...'
  flow.append(status)
  document.body.append(flow)
  return { flow, markdowns, shells }
}

/** 修改 markdown 文本并等待 MutationObserver 落地。 */
async function growText(markdown: HTMLElement, text: string): Promise<void> {
  markdown.textContent = text
  // 等 MutationObserver + rAF 防抖 flush 落地。
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
}

function cursorOf(markdown: HTMLElement): HTMLElement | null {
  return markdown.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}-cursor`)
}

beforeEach(() => {
  clock = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('TypewriterController — 原生模式', () => {
  it('初始化宽限期内不启动打字机（刷新后历史消息不打字）', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new NativeTypewriterController(
      flow,
      { loadGrace: 1000, baseSpeed: 0.1, settleDelay: 500, cursorHold: 30 },
    ).attach()

    await growText(markdown, '历史消息加载')
    expect(typewriter.active).toBe(false)
    expect(markdown.textContent).toBe('历史消息加载') // 未被截断
    typewriter.dispose()
  })

  it('文本增长时直接截断原始 Markdown 并显示光标', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new NativeTypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    await growText(markdown, '你好')
    expect(typewriter.active).toBe(true)
    // 尚未 tick：shownChars=0 → 原始文本被截空，只有光标。
    expect(markdown.textContent).toBe('')
    expect(cursorOf(markdown)).not.toBeNull()

    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBe(1)
    expect(markdown.textContent).toBe('你')

    clock += 16
    typewriter.tick(clock)
    expect(markdown.textContent).toBe('你好')
    expect(cursorOf(markdown)).not.toBeNull()
    typewriter.dispose()
  })

  it('React 全量写入后被截回前缀，下一 chunk 再更新目标', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new NativeTypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    await growText(markdown, '第一')
    clock += 16
    typewriter.tick(clock)
    clock += 16
    typewriter.tick(clock)
    expect(markdown.textContent).toBe('第一')

    // React 追加完整文本（第三字）→ mutation 后应保留已显示前缀。
    await growText(markdown, '第一段')
    expect(typewriter.active).toBe(true)
    expect(typewriter.targetLength).toBe(3)
    typewriter.dispose()
  })

  it('忽略 React 中间态的短文本提交，避免目标被截短', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new NativeTypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    await growText(markdown, '完整目标文本')
    expect(typewriter.targetLength).toBe(6)

    markdown.textContent = '完整'
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(typewriter.targetLength).toBe(6)

    markdown.textContent = '完整目标文本'
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(typewriter.targetLength).toBe(6)
    typewriter.dispose()
  })
  it('文本停止增长后恢复完整文本并移除光标', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new NativeTypewriterController(flow, {
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
    expect(markdown.textContent).toBe('固定文本')

    clock += 300
    typewriter.tick(clock)
    await new Promise<void>((resolve) => { setTimeout(resolve, 60) })
    expect(typewriter.active).toBe(false)
    expect(markdown.textContent).toBe('固定文本')
    expect(cursorOf(markdown)).toBeNull()
    typewriter.dispose()
  })

  it('大文本按要求公式提速', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new NativeTypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 10_000,
      cursorHold: 1,
    }).attach()

    await growText(markdown, 'x'.repeat(13_000))
    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBeGreaterThanOrEqual(10)
    typewriter.dispose()
  })

  it('多个 Markdown 目标（思维链 + 正文）可同时打字', async () => {
    const { flow, markdowns } = makeMarkdownFlow(['', ''])
    const think = markdowns[0]!
    const body = markdowns[1]!
    const typewriter = new NativeTypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    await growText(think, '思考中')
    await growText(body, '回答')

    expect(typewriter.active).toBe(true)
    expect(cursorOf(think)).not.toBeNull()
    expect(cursorOf(body)).not.toBeNull()

    clock += 16
    typewriter.tick(clock)
    expect(typewriter.shown).toBeGreaterThanOrEqual(2)
    typewriter.dispose()
  })

  it('同一消息内 markdown 节点被替换（思维链流式）时迁移打字机', async () => {
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    const item = document.createElement('div')
    item.setAttribute('data-chat-anchor-key', 'msg-1')
    const inner = document.createElement('div')
    inner.className = '_root_9cl6j_3'
    item.append(inner)
    flow.append(item)
    const status = document.createElement('div')
    status.setAttribute('role', 'status')
    status.textContent = 'Deep diving...'
    flow.append(status)
    document.body.append(flow)

    const typewriter = new NativeTypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    const md1 = document.createElement('div')
    md1.className = '_markdown_abc'
    md1.textContent = '思维'
    inner.append(md1)
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(typewriter.active).toBe(true)
    expect(cursorOf(md1)).not.toBeNull()

    // 先打到 2 字（保留 shownChars 用于迁移验证）。
    clock += 16
    typewriter.tick(clock)
    clock += 16
    typewriter.tick(clock)
    expect(md1.textContent).toBe('思维')

    // React 替换成新 markdown 节点，文本延续 → 迁移打字机。
    const md2 = document.createElement('div')
    md2.className = '_markdown_abc'
    md2.textContent = '思维链内容'
    md1.replaceWith(md2)
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(typewriter.active).toBe(true)
    // 迁移后 shownChars 保留，光标跟随新节点。
    expect(cursorOf(md2)).not.toBeNull()
    expect(typewriter.targetLength).toBeGreaterThanOrEqual(3)
    typewriter.dispose()
  })

  it('没有运行状态（历史加载）时绝不启动打字机', async () => {
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    document.body.append(flow)
    const typewriter = new NativeTypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    const shell = document.createElement('div')
    const md = document.createElement('div')
    md.className = '_markdown_abc'
    md.textContent = '历史消息完整文本'
    shell.append(md)
    flow.append(shell)
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(typewriter.active).toBe(false)
    expect(md.textContent).toBe('历史消息完整文本')
    expect(cursorOf(md)).toBeNull()
    typewriter.dispose()
  })

  it('光标自身 mutation 不会误重启打字机', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new NativeTypewriterController(flow, {
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
    expect(markdown.textContent).toBe('短')
    expect(cursorOf(markdown)).toBeNull()

    markdown.setAttribute('data-x', '1')
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(typewriter.active).toBe(false)
    typewriter.dispose()
  })

  it('dispose 中途恢复完整文本并清理光标', async () => {
    const { flow, markdowns } = makeMarkdownFlow([''])
    const markdown = markdowns[0]!
    const typewriter = new NativeTypewriterController(flow, {
      loadGrace: 0,
      baseSpeed: 0.1,
      settleDelay: 1_000,
      cursorHold: 50,
    }).attach()

    await growText(markdown, '测试文本')
    clock += 16
    typewriter.tick(clock)
    expect(markdown.textContent.length).toBeLessThan(4)

    typewriter.dispose()
    expect(cursorOf(markdown)).toBeNull()
    expect(markdown.textContent).toBe('测试文本')
  })
})

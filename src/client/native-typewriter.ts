/**
 * NativeTypewriterController（原生模式）— 直接在原始 Markdown 文本节点上做
 * 逐字打字机，不再叠加覆盖层。
 *
 * 原理：DSH 流式时 React 会把 Markdown 的完整文本渲染进 DOM；本控制器
 * 用 MutationObserver 捕获这次写入，立即把原始文本节点截断为"已打字前缀"
 * （未显示的字符清空），浏览器实际绘制的是前缀 + 闪烁光标。下一次流式
 * chunk 到达时再重复"React 写全量 → 我们截前缀"的循环。打字结束后恢复
 * 完整文本并移除光标。
 *
 * 好处：
 * - 没有覆盖层、没有双份 DOM、没有位置 / 行距 / 光标锚定问题。
 * - 段落结构就是原始 Markdown 结构，段落间距天然一致。
 * - 打字中原始元素高度 = 已显示前缀高度，不预留整段空白。
 */

/** 兼容旧名：光标与样式标记仍使用该 class 前缀。 */
export const TYPEWRITER_OVERLAY_CLASS = 'dsh-scroll-flow-typewriter-overlay'

export interface TypewriterOptions {
  /** 基础吐字速度（字/ms）。默认 0.06（约 60 字/秒）。 */
  baseSpeed: number
  /** 停止增长多久（ms）后视为流式结束。默认 500。 */
  settleDelay: number
  /** 流式结束后光标保留时长（ms）。默认 900。 */
  cursorHold: number
  /**
   * 宽限期（ms）：初始化后这段时间内的文本变化视为历史加载，不启动
   * 打字机（避免刷新 / 首次打开时整页历史消息一起打字）。默认 1200。
   */
  loadGrace: number
  /**
   * 恢复回调：打字结束恢复原始 Markdown（布局高度突变）前触发，用于
   * 让同一滚动容器的控制器抑制"入场回弹"。
   */
  onRestore?: () => void
}

const DEFAULT_OPTIONS: TypewriterOptions = {
  baseSpeed: 0.06,
  settleDelay: 500,
  cursorHold: 900,
  loadGrace: 1200,
}

const CURSOR_CLASS = `${TYPEWRITER_OVERLAY_CLASS}-cursor`

const CURSOR_STYLE: Partial<CSSStyleDeclaration> = {
  display: 'inline-block',
  width: '2px',
  height: '1em',
  verticalAlign: 'text-bottom',
  marginLeft: '1px',
  background: 'currentColor',
  opacity: '0.85',
  animation: 'dsh-typewriter-blink 1s steps(1) infinite',
}

const BLINK_KEYFRAMES = `
@keyframes dsh-typewriter-blink {
  50% { opacity: 0; }
}
`

/** 消息 Markdown 容器选择器：Markdown 渲染根（hash class 前缀不固定，按特征匹配）。 */
const MARKDOWN_SELECTOR = '[class*="_markdown_"], [data-dsh-markdown], .markdown'

/** 文档序收集一个容器内的所有文本节点（含空节点，保持与目标文本切片对齐）。 */
function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }
  return nodes
}

/** 一个流式目标的原生打字机状态。 */
interface TypewriterSession {
  markdown: HTMLElement
  /** session 所属消息容器（flow 直接子容器）；节点被替换后仍可定位迁移。 */
  messageContainer: Element | null
  /** session 所属消息内的 Markdown 顺序，避免思维链与正文互相迁移。 */
  markdownIndex: number
  targetText: string
  /** 当前 Markdown 结构下各文本节点的原始长度（React 全量写入时缓存）。 */
  textLengths: number[]
  shownChars: number
  lastGrowthAt: number
  lastEmitAt: number
  settleTimer: ReturnType<typeof setTimeout> | undefined
  holdTimer: ReturnType<typeof setTimeout> | undefined
}

/**
 * 一个内容列的原生打字机控制器。构造后 {@link attach} 生效，
 * {@link dispose} 完整清理。
 */
export class NativeTypewriterController {
  private readonly flow: HTMLElement
  private readonly options: TypewriterOptions

  private observer: MutationObserver | null = null
  private readonly sessions = new Map<HTMLElement, TypewriterSession>()
  /** attach 时已存在的 Markdown（历史消息），宽限期只保护这些。 */
  private readonly baselineMarkdowns = new Set<HTMLElement>()
  /** 每个 Markdown 当前可见文本：区分"React 全量写入"与"我们自己的截断"。 */
  private readonly lastSeenByMarkdown = new Map<HTMLElement, string>()
  private readonly loadedAt = performance.now()
  private disposed = false

  constructor(flow: HTMLElement, options: Partial<TypewriterOptions> = {}) {
    this.flow = flow
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /** 当前所有活跃打字机已显示字符总数（测试 / 调试读取）。 */
  get shown(): number {
    let total = 0
    for (const session of this.sessions.values()) total += session.shownChars
    return total
  }

  /** 当前所有活跃打字机目标文本总长（测试 / 调试读取）。 */
  get targetLength(): number {
    let total = 0
    for (const session of this.sessions.values()) total += session.targetText.length
    return total
  }

  /** 是否处于流式打字状态。 */
  get active(): boolean {
    return this.sessions.size > 0
  }

  attach(): this {
    if (this.disposed) throw new Error('NativeTypewriterController: 已销毁的控制器不能重新挂载')
    this.ensureStyleTag()
    for (const markdown of this.markdowns()) {
      this.baselineMarkdowns.add(markdown)
      this.lastSeenByMarkdown.set(markdown, markdown.textContent ?? '')
    }
    // rAF 防抖：React 流式提交会拆成多帧，等一帧结束后再统一处理，
    // 避免把中间态文本当成完整目标（原生截断模式下会丢字）。
    this.observer = new MutationObserver(() => { this.scheduleFlush() })
    this.observer.observe(this.flow, { childList: true, subtree: true, characterData: true })
    return this
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    for (const session of this.sessions.values()) this.teardownSession(session)
    this.sessions.clear()
  }

  /** 手动推进所有打字机一帧（测试用；浏览器端由 interval 驱动）。 */
  tick(now = performance.now()): void {
    for (const session of this.sessions.values()) this.emitStep(session, now)
  }

  private markdowns(): HTMLElement[] {
    return Array.from(this.flow.querySelectorAll<HTMLElement>(MARKDOWN_SELECTOR))
  }

  private flushScheduled = false
  /** Mutation 回调时立即拍的快照：此时 React 刚写入完整文本，节点长度可信。 */
  private readonly pendingLengths = new Map<HTMLElement, number[]>()
  private readonly pendingText = new Map<HTMLElement, string>()

  /**
   * 合并同一帧内的多次 mutation，用微任务统一处理：React commit 在同步
   * 微任务链里完成，queueMicrotask 会在打字 interval（宏任务）之前截断，
   * 避免 interval 把 React 完整写入覆盖成已显示前缀，导致丢字。
   */
  private scheduleFlush(): void {
    if (this.disposed) return
    for (const markdown of this.markdowns()) {
      const text = markdown.textContent ?? ''
      // 只记录"React 新写入"（与当前可见前缀不同）；我们自己的截断
      // mutation 不覆盖快照，避免 interval 推进时把完整目标覆盖掉。
      if (text === this.lastSeenByMarkdown.get(markdown)) continue
      this.pendingLengths.set(markdown, collectTextNodes(markdown).map(node => node.data?.length ?? 0))
      this.pendingText.set(markdown, text)
    }
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      if (!this.disposed) this.onFlowChanged()
      this.pendingLengths.clear()
      this.pendingText.clear()
    })
  }

  private onFlowChanged(): void {
    if (this.disposed) return
    const markdowns = this.markdowns()
    const live = new Set<HTMLElement>(markdowns)
    const loading = performance.now() - this.loadedAt < this.options.loadGrace
    // 只有会话正在运行（Deep diving 状态行存在）才可能流式；刷新 / 历史
    // 加载没有运行状态，即使有文本变化也绝不启动打字机。
    const running = this.hasRunningTurn()
    for (const markdown of markdowns) {
      const text = markdown.textContent ?? ''
      const isNewNode = !this.baselineMarkdowns.has(markdown)
      const lastSeen = this.lastSeenByMarkdown.get(markdown)
      if (text === lastSeen) continue
      // 只有"持续增长"（新文本是上次文本的前缀扩展）才像流式打字；
      // 一次性渲染完整的历史消息不会启动。
      const growth = lastSeen !== undefined
        && text.length > lastSeen.length
        && text.startsWith(lastSeen)
      const existing = this.sessions.get(markdown)
      if (existing !== undefined) {
        // 用 mutation 时刻的快照（React 全量写入）而非当前 DOM（可能已被
        // 截断），避免节点长度对不上导致丢字。
        const snapshotText = this.pendingText.get(markdown) ?? text
        const snapshotLengths = this.pendingLengths.get(markdown)
          ?? collectTextNodes(markdown).map(node => node.data?.length ?? 0)
        // 只把"前缀扩展"当成新的完整目标；中间态（React 分批提交）不
        // 污染 targetText，只同步节点长度并截回当前目标。
        const extension = snapshotText.length > existing.targetText.length
          && snapshotText.startsWith(existing.targetText)
        const sameTarget = snapshotText === existing.targetText
        if (extension) {
          existing.targetText = snapshotText
          existing.lastGrowthAt = performance.now()
          if (existing.shownChars >= existing.targetText.length) {
            existing.shownChars = Math.max(0, existing.targetText.length - 1)
          }
          existing.textLengths = snapshotLengths
        } else if (sameTarget) {
          // React may rebuild the same text with a new Markdown node structure.
          existing.textLengths = snapshotLengths
        } else {
          // A persistent Markdown rewrite can be non-prefix (for example when
          // a block is normalized). Stop native truncation rather than keeping
          // an obsolete target that can permanently hide the new text.
          this.abandonSession(existing, snapshotText)
          continue
        }
        this.applyPrefix(existing)
        this.ensureStreaming(existing)
        continue
      }
      this.lastSeenByMarkdown.set(markdown, text)
      if (text.length === 0) continue
      // 没有运行状态时，任何文本变化都视为历史加载，不启动。
      if (!running) continue
      // 宽限期内的变化都视为历史加载，不启动。
      if (loading) continue
      // 宽限期后出现的新节点：真实新消息，即使整段一次到位也启动打字
      // （真实思维链可能不是前缀增长，而是整段渲染）。
      if (isNewNode) {
        if (this.tryMigrateSession(markdown, text)) continue
        this.startSession(markdown, text)
        continue
      }
      // 旧节点：同一消息内被替换（思维链流式）时优先迁移；否则需要增长。
      if (this.tryMigrateSession(markdown, text)) continue
      if (!growth) continue
      this.startSession(markdown, text)
    }
    for (const [markdown, session] of this.sessions) {
      if (!markdown.isConnected || !live.has(markdown)) this.teardownSession(session)
    }
  }

  /** 会话是否正在运行（Deep diving 状态行存在）。 */
  private hasRunningTurn(): boolean {
    return this.flow.querySelector('[role="status"]') !== null
  }

  private messageContainerOf(el: HTMLElement): Element | null {
    return el.closest('[data-chat-anchor-key]')
      ?? Array.from(this.flow.children).find(child => child.contains(el))
      ?? null
  }

  private markdownIndexOf(el: HTMLElement): number {
    const container = this.messageContainerOf(el)
    if (container === null) return -1
    return Array.from(container.querySelectorAll<HTMLElement>(MARKDOWN_SELECTOR)).indexOf(el)
  }

  /** 同一消息内 markdown 节点被替换且文本延续时，迁移打字机 session。 */
  private tryMigrateSession(next: HTMLElement, text: string): boolean {
    const nextContainer = this.messageContainerOf(next)
    const nextIndex = this.markdownIndexOf(next)
    for (const [oldMarkdown, session] of this.sessions) {
      if (oldMarkdown === next) continue
      if (session.messageContainer === null || session.messageContainer !== nextContainer) continue
      if (session.markdownIndex !== nextIndex) continue
      if (!text.startsWith(session.targetText)) continue
      this.migrateSession(session, next, text)
      return true
    }
    return false
  }

  private migrateSession(session: TypewriterSession, next: HTMLElement, text: string): void {
    this.sessions.delete(session.markdown)
    session.markdown = next
    session.messageContainer = this.messageContainerOf(next)
    session.markdownIndex = this.markdownIndexOf(next)
    session.targetText = text
    session.textLengths = collectTextNodes(next).map(node => node.data?.length ?? 0)
    session.lastGrowthAt = performance.now()
    if (session.shownChars >= text.length) session.shownChars = Math.max(0, text.length - 1)
    this.sessions.set(next, session)
    this.applyPrefix(session)
    this.ensureStreaming(session)
  }

  private startSession(markdown: HTMLElement, text: string): void {
    const session: TypewriterSession = {
      markdown,
      messageContainer: this.messageContainerOf(markdown),
      markdownIndex: this.markdownIndexOf(markdown),
      targetText: text,
      textLengths: collectTextNodes(markdown).map(node => node.data?.length ?? 0),
      shownChars: 0,
      lastGrowthAt: performance.now(),
      lastEmitAt: 0,
      settleTimer: undefined,
      holdTimer: undefined,
    }
    this.sessions.set(markdown, session)
    this.applyPrefix(session)
    this.ensureStreaming(session)
  }

  private ensureStreaming(session: TypewriterSession): void {
    if (session.settleTimer !== undefined) return
    const interval = 16
    const step = (): void => {
      if (this.disposed) return
      this.emitStep(session, performance.now())
      if (session.shownChars >= session.targetText.length
        && performance.now() - session.lastGrowthAt >= this.options.settleDelay) {
        this.settle(session)
        return
      }
      session.settleTimer = setTimeout(step, interval)
    }
    session.settleTimer = setTimeout(step, interval)
  }

  private pendingSessions(): TypewriterSession[] {
    return this.markdowns()
      .map(markdown => this.sessions.get(markdown))
      .filter((session): session is TypewriterSession => session !== undefined
        && session.shownChars < session.targetText.length)
  }

  private emitStep(session: TypewriterSession, now: number): void {
    const pending = this.pendingSessions()
    if (pending[0] !== session) return
    const delta = session.lastEmitAt === 0 ? 16 : Math.max(0, now - session.lastEmitAt)
    session.lastEmitAt = now
    // Serialize visual output from top to bottom while preserving the aggregate
    // throughput that parallel sessions previously produced.
    const speed = pending.reduce((total, item) => total + this.effectiveSpeed(item.targetText.length), 0)
    const charsToAdd = Math.max(1, Math.floor(delta * speed))
    session.shownChars = Math.min(session.targetText.length, session.shownChars + charsToAdd)
    this.applyPrefix(session)
    if (session.shownChars >= session.targetText.length
      && now - session.lastGrowthAt >= this.options.settleDelay) {
      this.settle(session)
    }
  }

  /**
   * 速度公式（无上限）：400 字以内用基础速度，之后随文本总量线性加速，
   * 每多 250 字提速 1 倍，超大段话也平滑尽快完成。
   */
  private effectiveSpeed(length: number): number {
    if (length <= 400) return this.options.baseSpeed
    const multiplier = 1 + (length - 400) / 250
    return this.options.baseSpeed * multiplier
  }

  /**
   * 原生截断：把原始 Markdown 的文本节点内容按 shownChars 前缀重建，
   * 未显示的字符清空；光标插到最后一个文本节点之后。React 下一次全量
   * 写入会被 onFlowChanged 捕获并再次截回。
   */
  private applyPrefix(session: TypewriterSession): void {
    const markdown = session.markdown
    const target = session.targetText
    const shown = session.shownChars
    const lengths = session.textLengths
    const nodes = collectTextNodes(markdown)
    // 结构变化未稳定时保留上一次可信快照；下一次 React 完整提交会重新同步。
    if (nodes.length !== lengths.length) return
    let offset = 0
    let lastTextNode: Text | null = null
    for (let i = 0; i < nodes.length && i < lengths.length; i++) {
      const node = nodes[i]!
      const length = lengths[i] ?? 0
      if (offset >= shown || length === 0) {
        node.data = ''
      } else {
        const take = Math.min(length, shown - offset)
        node.data = target.slice(offset, offset + take)
        lastTextNode = node
      }
      offset += length
    }
    // 光标插到最后一个有文本的节点之后（React 可能已移除旧光标，直接重建）。
    markdown.querySelector(`.${CURSOR_CLASS}`)?.remove()
    const cursor = document.createElement('span')
    cursor.className = CURSOR_CLASS
    cursor.style.cssText = Object.entries(CURSOR_STYLE).map(([k, v]) => `${k}:${v}`).join(';')
    if (lastTextNode !== null) {
      lastTextNode.parentElement?.insertBefore(cursor, lastTextNode.nextSibling)
    } else {
      markdown.appendChild(cursor)
    }
    // 我们自己的截断应成为"当前可见文本"，避免下一次 mutation 误判。
    this.lastSeenByMarkdown.set(markdown, target.slice(0, shown))
  }

  /** 流式稳定：结束打字，保留光标一小段时间后移除。 */
  private settle(session: TypewriterSession): void {
    if (session.settleTimer === undefined) return
    clearTimeout(session.settleTimer)
    session.settleTimer = undefined
    if (session.shownChars < session.targetText.length) session.shownChars = session.targetText.length
    this.applyPrefix(session)
    session.holdTimer = setTimeout(() => { this.teardownSession(session) }, this.options.cursorHold)
  }

  private abandonSession(session: TypewriterSession, currentText: string): void {
    clearTimeout(session.settleTimer)
    clearTimeout(session.holdTimer)
    session.settleTimer = undefined
    session.holdTimer = undefined
    this.options.onRestore?.()
    session.markdown.querySelector(`.${CURSOR_CLASS}`)?.remove()
    this.sessions.delete(session.markdown)
    this.lastSeenByMarkdown.set(session.markdown, currentText)
  }

  private teardownSession(session: TypewriterSession): void {
    clearTimeout(session.settleTimer)
    clearTimeout(session.holdTimer)
    session.settleTimer = undefined
    session.holdTimer = undefined
    this.options.onRestore?.()
    // dispose / 设置切换可能发生在打字中途；先恢复完整文本，避免截断内容残留。
    this.restoreText(session)
    session.markdown.querySelector(`.${CURSOR_CLASS}`)?.remove()
    this.sessions.delete(session.markdown)
  }

  private restoreText(session: TypewriterSession): void {
    const nodes = collectTextNodes(session.markdown)
    if (nodes.length !== session.textLengths.length) {
      // 结构已被 React 替换时，优先保证完整文本可见，不静默留下截断内容。
      session.markdown.textContent = session.targetText
      this.lastSeenByMarkdown.set(session.markdown, session.targetText)
      return
    }
    let offset = 0
    for (let i = 0; i < nodes.length; i++) {
      const length = session.textLengths[i] ?? 0
      nodes[i]!.data = session.targetText.slice(offset, offset + length)
      offset += length
    }
    this.lastSeenByMarkdown.set(session.markdown, session.targetText)
  }

  private ensureStyleTag(): void {
    if (document.querySelector('#dsh-typewriter-style') !== null) return
    const style = document.createElement('style')
    style.id = 'dsh-typewriter-style'
    style.textContent = BLINK_KEYFRAMES
    document.head.appendChild(style)
  }
}

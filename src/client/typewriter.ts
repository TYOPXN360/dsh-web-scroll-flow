/**
 * TypewriterController — 为正在流式的助手消息（思维链 + 正文 Markdown）
 * 做逐字打字机动画。
 *
 * 实现边界：不改 DSH 的 React 渲染，只操作 DOM。
 * - MutationObserver 监听内容列文本增长；只有文本实际变化才启动对应
 *   Markdown 的打字机（历史 / 静态消息不会误打字；overlay 自身 mutation
 *   不触发重启）。
 * - 打字期间把目标 Markdown 设为 display:none（不占高度、不预留整段
 *   空白），用一个作为正常流元素的纯文本覆盖层占据已打文本的真实高度，
 *   逐字吐出 + 末尾闪烁光标；因此消息高度随打字增长，无"长白条"。
 * - 覆盖层继承目标 markdown 的字体 / 行高 / 颜色，位置一致。
 * - 文本总量大时按公式线性提速，确保非常大段也尽快打完。
 * - 文本停止增长超过阈值视为流式结束：恢复原始 Markdown，短暂保留光标。
 */

/** 覆盖层用 class 标记，便于测试与清理。 */
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
  /** Called when a live Markdown chunk starts or grows. */
  onContentChange?: () => void
}

const DEFAULT_OPTIONS: TypewriterOptions = {
  baseSpeed: 0.06,
  settleDelay: 500,
  cursorHold: 900,
  loadGrace: 1200,
}

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

// const MAX_SPEED_MULTIPLIER = 24
const BLINK_KEYFRAMES = `
@keyframes dsh-typewriter-blink {
  50% { opacity: 0; }
}
`

/** 覆盖层继承的文本排版样式，保证与最终 Markdown 的文字位置一致。 */
const INHERITED_TEXT_STYLES: readonly (keyof CSSStyleDeclaration)[] = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'whiteSpace',
]

/** 消息 Markdown 容器选择器：Markdown 渲染根（hash class 前缀不固定，按特征匹配）。 */
const MARKDOWN_SELECTOR = '[class*="_markdown_"], [data-dsh-markdown], .markdown'

/** 思考链内容选择器。 */
const THINK_BODY_SELECTOR = '[data-variant="think"][aria-expanded="true"] > * > [class*="thinkBody"], [class*="thinkBody"]'

/** 组合内容选择器：主消息 Markdown + 思考链 body。 */
const CONTENT_SELECTOR = `${MARKDOWN_SELECTOR}, ${THINK_BODY_SELECTOR}`

/** 一个流式目标的打字机状态。 */
interface TypewriterSession {
  markdown: HTMLElement
  /** session 所属消息容器（flow 直接子容器）；节点被替换后仍可定位迁移。 */
  messageContainer: Element | null
  /** session 所属消息内的 Markdown 顺序，避免思维链与正文互相迁移。 */
  markdownIndex: number
  shell: HTMLElement | null
  overlay: HTMLDivElement | null
  /** React Markdown 文本节点的完整长度，按渲染后的 DOM 顺序对应。 */
  textLengths: number[]
  targetText: string
  shownChars: number
  lastGrowthAt: number
  lastEmitAt: number
  settleTimer: ReturnType<typeof setTimeout> | undefined
  holdTimer: ReturnType<typeof setTimeout> | undefined
}

/**
 * 一个内容列的打字机控制器。构造后 {@link attach} 生效，{@link dispose}
 * 完整清理。
 */
export class TypewriterController {
  private readonly flow: HTMLElement
  private readonly options: TypewriterOptions

  /** 段落间保留的底部间距（px），复制自目标 markdown 的 p margin，打字与完成一致。 */
  private observer: MutationObserver | null = null
  private readonly sessions = new Map<HTMLElement, TypewriterSession>()
  /** attach 时已存在的 Markdown（历史消息），宽限期只保护这些。 */
  private readonly baselineMarkdowns = new Set<HTMLElement>()
  /** 每个 Markdown 的最后可见文本：区分"流式增长"与"我们自己的 overlay mutation"。 */
  private readonly lastSeenByMarkdown = new Map<HTMLElement, string>()
  /** 已完成消息的全文签名，防止 React 重建同一消息时重新播放。 */
  private readonly completedTargets = new WeakMap<Element, Map<number, string>>()
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
    if (this.disposed) throw new Error('TypewriterController: 已销毁的控制器不能重新挂载')
    this.ensureStyleTag()
    for (const markdown of this.markdowns()) {
      this.baselineMarkdowns.add(markdown)
      this.lastSeenByMarkdown.set(markdown, this.contentText(markdown))
    }
    this.observer = new MutationObserver(() => { this.onFlowChanged() })
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
    return Array.from(this.flow.querySelectorAll<HTMLElement>(CONTENT_SELECTOR))
      .filter(el => !el.classList.contains(TYPEWRITER_OVERLAY_CLASS))
  }

  private textNodes(root: Node): Text[] {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null) {
      const text = node as Text
      if (text.parentElement?.closest(
        'button,[data-copy],[aria-label*="copy" i],[aria-label*="复制"],[data-testid*="copy" i],[class*="copy" i]',
      ) === null) {
        nodes.push(text)
      }
      node = walker.nextNode()
    }
    return nodes
  }

  private contentText(markdown: HTMLElement): string {
    return this.textNodes(markdown).map(node => node.data).join('')
  }

  private textLengths(markdown: HTMLElement): number[] {
    return this.textNodes(markdown).map(node => node.data.length)
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
      const text = this.contentText(markdown)
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
        // React / Markdown 可能在一次提交中间短暂写入较短文本；活跃流式目标
        // 只能接受相同文本或前缀扩展，避免把暂态 DOM 当成完整目标而吞字。
        const extension = text.length >= existing.targetText.length
          && text.startsWith(existing.targetText)
        if (extension) {
          existing.targetText = text
          existing.textLengths = this.textLengths(markdown)
          existing.lastGrowthAt = performance.now()
          this.options.onContentChange?.()
          this.lastSeenByMarkdown.set(markdown, text)
          if (existing.shownChars >= existing.targetText.length) {
            existing.shownChars = Math.max(0, existing.targetText.length - 1)
          }
        } else {
          // Markdown parsers may briefly expose a shorter or structurally
          // rebuilt snapshot between stream chunks. Keep the active session;
          // destroying it here causes the next chunk to replay from zero.
          continue
        }
        this.ensureStreaming(existing)
        continue
      }
      this.lastSeenByMarkdown.set(markdown, text)
      // 宽限期内的变化都视为历史加载，不启动。
      if (loading) continue
      // React may replace the completed Markdown node with an equivalent node;
      // keep the finished content instead of replaying the typewriter.
      if (this.completedTextOf(markdown) === text) continue
      // 状态行可能在最后一批 assistant Markdown 到达前先被移除；已有
      // 节点的前缀增长仍是当前流式输出，新历史节点则继续保持静态。
      if (!running && !growth) continue
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
    return Array.from(container.querySelectorAll<HTMLElement>(CONTENT_SELECTOR))
      .filter(markdown => !markdown.classList.contains(TYPEWRITER_OVERLAY_CLASS))
      .indexOf(el)
  }

  private completedTextOf(markdown: HTMLElement): string | undefined {
    const container = this.messageContainerOf(markdown)
    if (container === null) return undefined
    return this.completedTargets.get(container)?.get(this.markdownIndexOf(markdown))
  }

  private rememberCompleted(session: TypewriterSession): void {
    const container = this.messageContainerOf(session.markdown)
    if (container === null) return
    const entries = this.completedTargets.get(container) ?? new Map<number, string>()
    entries.set(this.markdownIndexOf(session.markdown), session.targetText)
    this.completedTargets.set(container, entries)
  }

  /** 同一消息内 markdown 节点被替换时迁移打字机 session（流式分段）。 */
  private tryMigrateSession(next: HTMLElement, text: string): boolean {
    const nextContainer = this.messageContainerOf(next)
    const nextIndex = this.markdownIndexOf(next)
    for (const [oldMarkdown, session] of this.sessions) {
      if (oldMarkdown === next) continue
      if (session.messageContainer === null || session.messageContainer !== nextContainer) continue
      if (session.markdownIndex !== nextIndex) continue
      if (text.length === 0) continue
      // Streaming deliveries can momentarily rebuild to a shorter snapshot;
      // both a growing prefix and a shorter continuation belong to the same
      // logical block, so keep typing rather than restarting from zero.
      if (!text.startsWith(session.targetText) && !session.targetText.startsWith(text)) continue
      this.migrateSession(session, next, text)
      return true
    }
    return false
  }

  private migrateSession(session: TypewriterSession, next: HTMLElement, text: string): void {
    const oldMarkdown = session.markdown
    const oldShell = session.shell
    const newShell = next.parentElement
    this.restoreSourcePositioning(oldMarkdown)
    if (session.overlay !== null && newShell !== null && oldShell !== newShell) {
      oldShell?.removeChild(session.overlay)
      newShell.insertBefore(session.overlay, next)
    }
    this.sessions.delete(oldMarkdown)
    session.markdown = next
    session.messageContainer = this.messageContainerOf(next)
    session.markdownIndex = this.markdownIndexOf(next)
    session.shell = newShell
    // Only grow the target on a real extension; transient shorter snapshots
    // keep the already-streamed target and progress, so nothing truncates or
    // appears to instant-finish.
    if (text.length > session.targetText.length && text.startsWith(session.targetText)) {
      session.targetText = text
      if (session.shownChars >= text.length) session.shownChars = Math.max(0, text.length - 1)
    }
    session.textLengths = this.textLengths(next)
    session.lastGrowthAt = performance.now()
    this.options.onContentChange?.()
    next.style.position = 'absolute'
    next.style.left = '-9999px'
    next.style.visibility = 'hidden'
    next.style.pointerEvents = 'none'
    this.sessions.set(next, session)
    this.renderOverlay(session)
    this.ensureStreaming(session)
  }

  private startSession(markdown: HTMLElement, text: string): void {
    const session: TypewriterSession = {
      markdown,
      messageContainer: this.messageContainerOf(markdown),
      markdownIndex: this.markdownIndexOf(markdown),
      shell: markdown.parentElement,
      overlay: null,
      textLengths: this.textLengths(markdown),
      targetText: text,
      shownChars: 0,
      lastGrowthAt: performance.now(),
      lastEmitAt: 0,
      settleTimer: undefined,
      holdTimer: undefined,
    }
    this.sessions.set(markdown, session)
    this.options.onContentChange?.()
    this.installOverlay(session)
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
    if (session.overlay === null) return
    const pending = this.pendingSessions()
    if (pending[0] !== session) return
    const delta = session.lastEmitAt === 0 ? 16 : Math.max(0, now - session.lastEmitAt)
    session.lastEmitAt = now
    // Serialize visual output from top to bottom while preserving the aggregate
    // throughput that parallel sessions previously produced.
    const speed = pending.reduce((total, item) => total + this.effectiveSpeed(item.targetText.length), 0)
    const charsToAdd = Math.max(1, Math.floor(delta * speed))
    session.shownChars = Math.min(session.targetText.length, session.shownChars + charsToAdd)
    this.renderOverlay(session)
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
   * 覆盖层作为正常流元素占据已打文本高度：目标 markdown 打字期间
   * display:none（不占高、不预留整段空白），覆盖层继承其字体输入逐字。
   */
  private stripInteractiveControls(root: HTMLElement): void {
    root.querySelectorAll(
      'button,[data-copy],[aria-label*="copy" i],[aria-label*="复制"],[data-testid*="copy" i],[class*="copy" i]',
    ).forEach(control => control.remove())
  }

  private installOverlay(session: TypewriterSession): void {
    const markdown = session.markdown
    const shell = session.shell
    if (shell === null) return
    const overlay = markdown.cloneNode(true) as HTMLDivElement
    this.stripInteractiveControls(overlay)
    overlay.classList.add(TYPEWRITER_OVERLAY_CLASS)
    overlay.style.display = 'none'
    overlay.style.pointerEvents = 'none'
    overlay.style.userSelect = 'none'
    // Clone the parsed tree so paragraphs, code, and inline Markdown keep their layout.
    shell.insertBefore(overlay, markdown)
    session.overlay = overlay
    // Hide source offscreen so it retains full layout for re-cloning, but
    // doesn't occupy flow space or flash its content.
    markdown.style.position = 'absolute'
    markdown.style.left = '-9999px'
    markdown.style.visibility = 'hidden'
    markdown.style.pointerEvents = 'none'
    this.renderOverlay(session)
  }

  /**
   * 按段落渲染：目标文本用空行（\n\n）分隔段落。复用已有段落 div，只
   * 更新文本与段距；段落数变化时才增删节点，避免高频流式下每帧重建
   * DOM（手机端卡顿 / 发热主因）。
   */
  private renderOverlay(session: TypewriterSession): void {
    let overlay = session.overlay
    if (overlay === null) return
    overlay.style.display = session.shownChars > 0 ? 'block' : 'none'
    let nodes = this.textNodes(overlay)
    if (nodes.length !== session.textLengths.length) {
      const replacement = session.markdown.cloneNode(true) as HTMLDivElement
      this.stripInteractiveControls(replacement)
      replacement.classList.add(TYPEWRITER_OVERLAY_CLASS)
      replacement.style.cssText = overlay.style.cssText
      overlay.replaceWith(replacement)
      overlay = replacement
      session.overlay = overlay
      overlay.style.display = session.shownChars > 0 ? 'block' : 'none'
      nodes = this.textNodes(overlay)
    }
    const cursor = overlay.querySelector<HTMLSpanElement>(`.${TYPEWRITER_OVERLAY_CLASS}-cursor`)
      ?? this.createCursor()
    const prefix = session.targetText.slice(0, session.shownChars)
    let offset = 0
    let lastVisible: Text | null = null
    const nodeStarts = new Map<Text, number>()
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      const length = session.textLengths[i] ?? 0
      nodeStarts.set(node, offset)
      const take = Math.max(0, Math.min(length, prefix.length - offset))
      node.data = prefix.slice(offset, offset + take)
      if (take > 0) lastVisible = node
      offset += length
    }
    // Pre-mount the next block just before its first character arrives. Its
    // box is ready for text, but later blocks do not reserve a whole page.
    for (const block of overlay.querySelectorAll<HTMLElement>(
      'p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,ol,ul',
    )) {
      const starts = this.textNodes(block)
        .map(node => nodeStarts.get(node))
        .filter((start): start is number => start !== undefined)
      const start = starts.length > 0 ? Math.min(...starts) : null
      const shouldShow = start !== null && session.shownChars >= Math.max(0, start - 1)
      if (shouldShow) {
        if (block.dataset.dshTypewriterHidden === 'true') {
          delete block.dataset.dshTypewriterHidden
          block.style.display = ''
        }
      } else {
        block.dataset.dshTypewriterHidden = 'true'
        block.style.display = 'none'
      }
    }
    if (lastVisible !== null && lastVisible.parentElement !== null) {
      lastVisible.parentElement.insertBefore(cursor, lastVisible.nextSibling)
    } else {
      overlay.appendChild(cursor)
    }
  }

  private createCursor(): HTMLSpanElement {
    const cursor = document.createElement('span')
    cursor.className = `${TYPEWRITER_OVERLAY_CLASS}-cursor`
    cursor.style.cssText = Object.entries(CURSOR_STYLE).map(([k, v]) => `${k}:${v}`).join(';')
    return cursor
  }

  /** 流式稳定：结束打字，保留光标一小段时间后恢复原始 Markdown。 */
  private settle(session: TypewriterSession): void {
    if (session.settleTimer === undefined && session.overlay === null) return
    clearTimeout(session.settleTimer)
    session.settleTimer = undefined
    if (session.shownChars < session.targetText.length) session.shownChars = session.targetText.length
    this.renderOverlay(session)
    this.rememberCompleted(session)
    session.holdTimer = setTimeout(() => { this.teardownSession(session) }, this.options.cursorHold)
  }

  private restoreSourcePositioning(el: HTMLElement): void {
    if (el.style.position === 'absolute') el.style.position = ''
    if (el.style.left === '-9999px') el.style.left = ''
    if (el.style.visibility === 'hidden') el.style.visibility = ''
    if (el.style.pointerEvents === 'none') el.style.pointerEvents = ''
  }

  private teardownSession(session: TypewriterSession): void {
    clearTimeout(session.settleTimer)
    clearTimeout(session.holdTimer)
    session.settleTimer = undefined
    session.holdTimer = undefined
    // 恢复原始 Markdown 前通知同一容器的 controller 抑制入场推升。
    this.options.onRestore?.()
    this.restoreSourcePositioning(session.markdown)
    if (session.overlay !== null) {
      session.overlay.remove()
      session.overlay = null
    }
    this.sessions.delete(session.markdown)
  }

  private ensureStyleTag(): void {
    if (document.querySelector('#dsh-typewriter-style') !== null) return
    const style = document.createElement('style')
    style.id = 'dsh-typewriter-style'
    style.textContent = BLINK_KEYFRAMES
    document.head.appendChild(style)
  }
}

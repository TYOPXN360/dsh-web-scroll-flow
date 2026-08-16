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

/** 一个流式目标的打字机状态。 */
interface TypewriterSession {
  markdown: HTMLElement
  shell: HTMLElement | null
  overlay: HTMLDivElement | null
  targetText: string
  /** 段落底部间距（px），复制自目标 markdown 的 p，打字与完成一致。 */
  paragraphGap: number
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
  /** 每个 Markdown 的最后可见文本：区分"流式增长"与"我们自己的 overlay mutation"。 */
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
    if (this.disposed) throw new Error('TypewriterController: 已销毁的控制器不能重新挂载')
    this.ensureStyleTag()
    for (const markdown of this.markdowns()) {
      this.lastSeenByMarkdown.set(markdown, markdown.textContent ?? '')
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
    return Array.from(this.flow.querySelectorAll<HTMLElement>(MARKDOWN_SELECTOR))
  }

  private onFlowChanged(): void {
    if (this.disposed) return
    const markdowns = this.markdowns()
    const live = new Set<HTMLElement>(markdowns)
    const loading = performance.now() - this.loadedAt < this.options.loadGrace
    for (const markdown of markdowns) {
      const text = markdown.textContent ?? ''
      const lastSeen = this.lastSeenByMarkdown.get(markdown)
      if (text === lastSeen) continue
      this.lastSeenByMarkdown.set(markdown, text)
      if (text.length === 0) continue
      const existing = this.sessions.get(markdown)
      if (existing === undefined) {
        if (loading) continue
        this.startSession(markdown, text)
      } else {
        existing.targetText = text
        existing.lastGrowthAt = performance.now()
        if (existing.shownChars >= existing.targetText.length) {
          existing.shownChars = Math.max(0, existing.targetText.length - 1)
        }
        this.ensureStreaming(existing)
      }
    }
    for (const [markdown, session] of this.sessions) {
      if (!markdown.isConnected || !live.has(markdown)) this.teardownSession(session)
    }
  }

  private startSession(markdown: HTMLElement, text: string): void {
    const session: TypewriterSession = {
      markdown,
      shell: markdown.parentElement,
      overlay: null,
      paragraphGap: 0,
      targetText: text,
      shownChars: 0,
      lastGrowthAt: performance.now(),
      lastEmitAt: 0,
      settleTimer: undefined,
      holdTimer: undefined,
    }
    this.sessions.set(markdown, session)
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

  private emitStep(session: TypewriterSession, now: number): void {
    if (session.overlay === null) return
    const delta = session.lastEmitAt === 0 ? 16 : Math.max(0, now - session.lastEmitAt)
    session.lastEmitAt = now
    const speed = this.effectiveSpeed(session.targetText.length)
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
  private installOverlay(session: TypewriterSession): void {
    const markdown = session.markdown
    const shell = session.shell
    if (shell === null) return
    const overlay = document.createElement('div')
    overlay.className = TYPEWRITER_OVERLAY_CLASS
    overlay.style.cssText = Object.entries({
      margin: '0',
      padding: '0',
      minHeight: '1em',
      pointerEvents: 'none',
      fontSize: 'inherit',
      lineHeight: 'inherit',
      color: 'inherit',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      wordBreak: 'break-word',
    }).map(([k, v]) => `${k}:${v}`).join(';')
    const style = getComputedStyle(markdown)
    for (const prop of INHERITED_TEXT_STYLES) {
      const value = style[prop]
      if (typeof value === 'string' && value !== '') {
        overlay.style.setProperty(String(prop), value)
      }
    }
    // 段落间距：取目标 markdown 第一个段落的 margin-bottom，打字与完成一致。
    const firstParagraph = markdown.querySelector('p, li, pre, blockquote')
    if (firstParagraph !== null) {
      session.paragraphGap = parseFloat(getComputedStyle(firstParagraph).marginBottom) || 0
    }
    // 覆盖层放在 markdown 之前，占据已打文本的高度。
    shell.insertBefore(overlay, markdown)
    session.overlay = overlay
    markdown.style.display = 'none'
    this.renderOverlay(session)
  }

  /**
   * 按段落渲染：目标文本用空行（\n\n）分隔段落，覆盖层为每个已进行的段落
   * 生成一个带相同 margin 的 div。打字中段尾就有与完成一致的间距，未进行
   * 的段不占位置（不预留空白），光标排在已打文本末尾。
   */
  private renderOverlay(session: TypewriterSession): void {
    const overlay = session.overlay
    if (overlay === null) return
    // 光标节点复用：先取出现有光标，清段落时保留它，避免高频流式下
    // 光标反复移除/重建导致思维链里看不到光标。
    const cursor = overlay.querySelector(`.${TYPEWRITER_OVERLAY_CLASS}-cursor`)
      ?? this.createCursor()
    for (const child of Array.from(overlay.children)) {
      if (child === cursor) continue
      child.remove()
    }
    const prefix = session.targetText.slice(0, session.shownChars)
    const paragraphs = prefix.split('\n\n').filter(segment => segment !== '' || session.shownChars === 0)
    let lastParagraph: HTMLDivElement | null = null
    paragraphs.forEach((paragraph, index) => {
      if (paragraph === '') return
      const p = document.createElement('div')
      p.textContent = paragraph
      if (index < paragraphs.length - 1) {
        p.style.margin = `0 0 ${session.paragraphGap}px`
      }
      overlay.appendChild(p)
      lastParagraph = p
    })
    // 光标紧跟正在输入的字符：放在最后一段（若存在）末尾，否则覆盖层根。
    const anchor = lastParagraph === null ? overlay : lastParagraph
    if (cursor.parentElement !== anchor) anchor.appendChild(cursor)
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
    session.holdTimer = setTimeout(() => { this.teardownSession(session) }, this.options.cursorHold)
  }

  private teardownSession(session: TypewriterSession): void {
    clearTimeout(session.settleTimer)
    clearTimeout(session.holdTimer)
    session.settleTimer = undefined
    session.holdTimer = undefined
    // 恢复原始 Markdown 前通知同一容器的 controller 抑制入场推升。
    this.options.onRestore?.()
    if (session.markdown.style.display === 'none') session.markdown.style.display = ''
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

/**
 * TypewriterController — 为正在流式的助手消息（思维链 + 正文 Markdown）
 * 做逐字打字机动画。
 *
 * 实现边界：不改 DSH 的 React 渲染，只操作 DOM。
 * - MutationObserver 监听内容列文本增长；只有文本实际变化才启动对应
 *   Markdown 的打字机（历史消息静止，不会误打字；overlay 自身 mutation
 *   不会重启）。
 * - 每个流式目标一个覆盖层：目标 Markdown 设为 visibility:hidden（保留
 *   布局），覆盖层精确对齐其内容盒并继承排版样式，按字符匀速吐出纯文本，
 *   末尾带闪烁光标；因此打字中与打完字后文字位置一致。
 * - 文本总量大时自动提高吐字速度，保证"字多也平滑"。
 * - 文本停止增长超过阈值视为流式结束，短暂保留光标后恢复原始 Markdown。
 */

/** 覆盖层用 class 标记，便于测试与清理。 */
export const TYPEWRITER_OVERLAY_CLASS = 'dsh-scroll-flow-typewriter-overlay'

export interface TypewriterOptions {
  /** 基础吐字速度（字/ms）。默认 0.035（约 28 字/秒）。 */
  baseSpeed: number
  /** 停止增长多久（ms）后视为流式结束。默认 500。 */
  settleDelay: number
  /** 流式结束后光标保留时长（ms）。默认 900。 */
  cursorHold: number
}

const DEFAULT_OPTIONS: TypewriterOptions = {
  baseSpeed: 0.035,
  settleDelay: 500,
  cursorHold: 900,
}

const OVERLAY_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  margin: '0',
  padding: '0',
  pointerEvents: 'none',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
}

/** 覆盖层需继承的文本排版样式，保证打完字恢复 Markdown 时位置一致。 */
const INHERITED_TEXT_STYLES: readonly (keyof CSSStyleDeclaration)[] = [
  'font',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textAlign',
  'textTransform',
  'direction',
  'color',
]

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

/** 一个流式目标的打字机状态。 */
interface TypewriterSession {
  markdown: HTMLElement
  shell: HTMLElement | null
  overlay: HTMLDivElement | null
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

  private observer: MutationObserver | null = null
  private readonly sessions = new Map<HTMLElement, TypewriterSession>()
  /** 每个 Markdown 的最后可见文本：区分"流式增长"与"我们自己的 overlay mutation"。 */
  private readonly lastSeenByMarkdown = new Map<HTMLElement, string>()
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
    // 记录当前静止文本；流式由后续文本变化触发，避免历史消息被误打字，
    // 也避免 overlay 自身 mutation 被误判为流式并反复重启。
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
    for (const markdown of markdowns) {
      const text = markdown.textContent ?? ''
      const lastSeen = this.lastSeenByMarkdown.get(markdown)
      if (text === lastSeen) continue
      this.lastSeenByMarkdown.set(markdown, text)
      if (text.length === 0) continue
      const existing = this.sessions.get(markdown)
      if (existing === undefined) {
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

  /** 字多时提速：总量 > 4000 字提到 2 倍，> 12000 提到 3 倍。 */
  private effectiveSpeed(length: number): number {
    if (length > 12_000) return this.options.baseSpeed * 3
    if (length > 4_000) return this.options.baseSpeed * 2
    return this.options.baseSpeed
  }

  /** 覆盖层与目标 Markdown 内容盒对齐，并继承文本排版样式。 */
  private installOverlay(session: TypewriterSession): void {
    const markdown = session.markdown
    const shell = session.shell
    if (shell === null) return
    const overlay = document.createElement('div')
    overlay.className = TYPEWRITER_OVERLAY_CLASS
    overlay.style.cssText = Object.entries(OVERLAY_STYLE).map(([k, v]) => `${k}:${v}`).join(';')
    shell.appendChild(overlay)
    if (getComputedStyle(shell).position === 'static') shell.style.position = 'relative'
    session.overlay = overlay
    markdown.style.visibility = 'hidden'

    // 对齐：overlay 与 markdown 同在 shell 内，按 markdown 的 offset 定位。
    overlay.style.left = `${markdown.offsetLeft}px`
    overlay.style.top = `${markdown.offsetTop}px`
    overlay.style.width = `${markdown.offsetWidth}px`
    overlay.style.height = `${markdown.offsetHeight}px`
    const style = getComputedStyle(markdown)
    for (const prop of INHERITED_TEXT_STYLES) {
      const value = style[prop]
      if (typeof value === 'string' && value !== '') {
        const cssProp = String(prop).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
        overlay.style.setProperty(cssProp, value)
      }
    }
    this.renderOverlay(session)
  }

  private renderOverlay(session: TypewriterSession): void {
    const overlay = session.overlay
    if (overlay === null) return
    overlay.textContent = session.targetText.slice(0, session.shownChars)
    const cursor = document.createElement('span')
    cursor.style.cssText = Object.entries(CURSOR_STYLE).map(([k, v]) => `${k}:${v}`).join(';')
    overlay.appendChild(cursor)
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
    if (session.markdown.style.visibility === 'hidden') session.markdown.style.visibility = ''
    if (session.shell !== null && session.overlay !== null) {
      const overlay = session.overlay
      session.overlay = null
      overlay.remove()
      if (getComputedStyle(session.shell).position === 'relative'
        && session.shell.style.position === 'relative') {
        session.shell.style.position = ''
      }
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

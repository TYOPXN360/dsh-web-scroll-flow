/**
 * TypewriterController — 为正在流式的助手消息做逐字打字机动画。
 *
 * 实现边界：不改 DSH 的 React 渲染，只操作 DOM。
 * - MutationObserver 监听内容列文本增长，识别"正在流式"的最后一条
 *   Markdown 消息。
 * - 流式期间把消息的 Markdown 容器设为 visibility:hidden（保留布局），
 *   在上方叠加一个同尺寸覆盖层，按字符匀速吐出纯文本，末尾带闪烁光标。
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
  inset: '0',
  margin: '0',
  padding: '0',
  pointerEvents: 'none',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
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

/** 消息 Markdown 容器选择器：Markdown 渲染根（hash class 前缀不固定，按特征匹配）。 */
const MARKDOWN_SELECTOR = '[class*="_markdown_"], [data-dsh-markdown], .markdown'

/**
 * 一个内容列的打字机控制器。构造后 {@link attach} 生效，{@link dispose}
 * 完整清理。
 */
export class TypewriterController {
  private readonly flow: HTMLElement
  private readonly options: TypewriterOptions

  private observer: MutationObserver | null = null
  private markdown: HTMLElement | null = null
  private shell: HTMLElement | null = null
  private overlay: HTMLDivElement | null = null
  private targetText = ''
  private lastSeenText = ''
  private shownChars = 0
  private lastGrowthAt = 0
  private lastEmitAt = 0
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  private holdTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  /** 是否正在流式打字。 */
  private streaming = false

  constructor(flow: HTMLElement, options: Partial<TypewriterOptions> = {}) {
    this.flow = flow
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /** 当前已显示字符数（测试 / 调试读取）。 */
  get shown(): number {
    return this.shownChars
  }

  /** 当前目标完整文本长度（测试 / 调试读取）。 */
  get targetLength(): number {
    return this.targetText.length
  }

  /** 是否处于流式打字状态。 */
  get active(): boolean {
    return this.streaming
  }

  attach(): this {
    if (this.disposed) throw new Error('TypewriterController: 已销毁的控制器不能重新挂载')
    this.ensureStyleTag()
    // 记录当前静止文本；流式由后续文本变化触发，避免 overlay 自身
    // mutation 被误判为流式并反复重启。
    const current = this.findStreamingMarkdown()
    this.lastSeenText = current?.textContent ?? ''
    this.observer = new MutationObserver(() => { this.onFlowChanged() })
    this.observer.observe(this.flow, { childList: true, subtree: true, characterData: true })
    return this
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    this.teardown()
  }

  /** 手动推进一次吐字（测试用；浏览器端由 interval 驱动）。 */
  tick(now = performance.now()): void {
    this.emitStep(now)
  }

  private onFlowChanged(): void {
    if (this.disposed) return
    const markdown = this.findStreamingMarkdown()
    const text = markdown?.textContent ?? ''
    // 文本没变：mutation 来自我们自己的 overlay / 其它非文本更新，不重启。
    if (text === this.lastSeenText) return
    this.lastSeenText = text
    if (markdown === null) {
      if (this.markdown !== null && !this.markdown.isConnected) this.teardown()
      return
    }
    if (this.markdown !== markdown) {
      this.teardown()
      this.markdown = markdown
      // overlay 与 Markdown 容器同层：放入 markdown 的直接父容器，绝对覆盖其文本区。
      this.shell = markdown.parentElement
      this.targetText = text
      this.shownChars = 0
      this.lastGrowthAt = performance.now()
      this.lastEmitAt = 0
      this.startStreaming()
      return
    }
    if (text.length > this.targetText.length || text !== this.targetText) {
      this.targetText = text
      this.lastGrowthAt = performance.now()
      if (this.shownChars >= this.targetText.length) {
        // 目标已全部显示，但仍可能继续增长；保持流式直到稳定。
        this.shownChars = Math.max(0, this.targetText.length - 1)
      }
      this.startStreaming()
    }
  }

  /** 找到"正在增长"的助手 Markdown 容器：内容列中最后一个 Markdown 元素。 */
  private findStreamingMarkdown(): HTMLElement | null {
    const candidates = this.flow.querySelectorAll<HTMLElement>(MARKDOWN_SELECTOR)
    if (candidates.length === 0) return null
    return candidates[candidates.length - 1] ?? null
  }

  private startStreaming(): void {
    if (this.streaming) return
    this.streaming = true
    clearTimeout(this.settleTimer)
    clearTimeout(this.holdTimer)
    this.installOverlay()
    // 吐字由 interval 驱动；高频 MutationObserver 只更新目标。
    const interval = 16
    let last = performance.now()
    const step = (): void => {
      if (this.disposed || !this.streaming) return
      const now = performance.now()
      this.emitStep(now)
      // 停止增长判定：连续 settleDelay 无变化则收尾。
      if (this.shownChars >= this.targetText.length && now - this.lastGrowthAt >= this.options.settleDelay) {
        this.settle()
        return
      }
      last = now
      this.settleTimer = setTimeout(step, interval)
    }
    this.settleTimer = setTimeout(step, interval)
  }

  private emitStep(now: number): void {
    if (!this.streaming || this.markdown === null || this.overlay === null) return
    const delta = this.lastEmitAt === 0 ? 16 : Math.max(0, now - this.lastEmitAt)
    this.lastEmitAt = now
    const speed = this.effectiveSpeed()
    const charsToAdd = Math.max(1, Math.floor(delta * speed))
    this.shownChars = Math.min(this.targetText.length, this.shownChars + charsToAdd)
    this.renderOverlay()
    // 全部吐出且停止增长超过阈值：结束打字并进入光标保持。
    if (this.shownChars >= this.targetText.length && now - this.lastGrowthAt >= this.options.settleDelay) {
      this.settle()
    }
  }

  /** 字多时提速：总量 > 4000 字提到 2 倍，> 12000 提到 3 倍。 */
  private effectiveSpeed(): number {
    const length = Math.max(1, this.targetText.length)
    if (length > 12_000) return this.options.baseSpeed * 3
    if (length > 4_000) return this.options.baseSpeed * 2
    return this.options.baseSpeed
  }

  private installOverlay(): void {
    const markdown = this.markdown
    const shell = this.shell
    if (markdown === null || shell === null) return
    // 覆盖层放在消息外壳（有定位/背景的祖先）内，绝对覆盖 Markdown 区域。
    const overlay = document.createElement('div')
    overlay.className = TYPEWRITER_OVERLAY_CLASS
    overlay.style.cssText = Object.entries(OVERLAY_STYLE).map(([k, v]) => `${k}:${v}`).join(';')
    overlay.dataset.for = 'typewriter'
    shell.appendChild(overlay)
    // 确保定位：shell 若 static 则转 relative。
    if (getComputedStyle(shell).position === 'static') shell.style.position = 'relative'
    this.overlay = overlay
    markdown.style.visibility = 'hidden'
    this.renderOverlay()
  }

  private renderOverlay(): void {
    const overlay = this.overlay
    if (overlay === null) return
    overlay.textContent = this.targetText.slice(0, this.shownChars)
    const cursor = document.createElement('span')
    cursor.style.cssText = Object.entries(CURSOR_STYLE).map(([k, v]) => `${k}:${v}`).join(';')
    overlay.appendChild(cursor)
  }

  /** 流式稳定：结束打字，保留光标一小段时间后恢复原始 Markdown。 */
  private settle(): void {
    if (!this.streaming) return
    this.streaming = false
    clearTimeout(this.settleTimer)
    if (this.shownChars < this.targetText.length) this.shownChars = this.targetText.length
    this.renderOverlay()
    this.holdTimer = setTimeout(() => { this.teardown() }, this.options.cursorHold)
  }

  private teardown(): void {
    this.streaming = false
    clearTimeout(this.settleTimer)
    clearTimeout(this.holdTimer)
    if (this.markdown !== null) this.markdown.style.visibility = ''
    if (this.shell !== null && this.overlay !== null) {
      // 仅移除我们安装的 overlay，恢复 shell 定位（避免影响后续安装）。
      const overlay = this.overlay
      this.overlay = null
      overlay.remove()
      if (getComputedStyle(this.shell).position === 'relative'
        && (this.shell.style.position === 'relative')) {
        this.shell.style.position = ''
      }
    }
    // 记录当前文本：移除 overlay 引发的 mutation 不应误判为新的流式。
    this.lastSeenText = this.markdown?.textContent ?? this.lastSeenText
    this.markdown = null
    this.shell = null
    this.targetText = ''
    this.shownChars = 0
  }

  private ensureStyleTag(): void {
    if (document.querySelector('#dsh-typewriter-style') !== null) return
    const style = document.createElement('style')
    style.id = 'dsh-typewriter-style'
    style.textContent = BLINK_KEYFRAMES
    document.head.appendChild(style)
  }
}

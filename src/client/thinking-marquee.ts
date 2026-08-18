/**
 * Thinking marquee: horizontal slide animation for collapsed thinking summaries
 * whose text overflows. The text scrolls from start to end and back, pausing
 * at each end so the user can read it.
 *
 * Respects `prefers-reduced-motion`.
 */

const SUMMARY_SELECTOR = '[data-variant="think"][data-state="running"] [class*="summary"]'
const STYLE_ID = 'dsh-thinking-marquee-style'

const STYLE = `
@keyframes dsh-think-marquee {
  0%       { transform: translateX(0); }
  15%      { transform: translateX(var(--dsh-marquee-shift, 0px)); }
  85%      { transform: translateX(var(--dsh-marquee-shift, 0px)); }
  100%     { transform: translateX(0); }
}

${SUMMARY_SELECTOR} {
  --dsh-marquee-shift: 0px;
}

${SUMMARY_SELECTOR}[data-marquee] {
  animation: dsh-think-marquee var(--dsh-marquee-duration, 8s) ease-in-out infinite;
  text-overflow: clip;
}

@media (prefers-reduced-motion: reduce) {
  ${SUMMARY_SELECTOR}[data-marquee] {
    animation: none;
  }
}
`

export class ThinkingMarquee {
  private readonly root: ParentNode
  private styleEl: HTMLStyleElement | null = null
  private observer: MutationObserver | null = null
  private resizeObserver: ResizeObserver | null = null
  private readonly observed = new WeakSet<Element>()
  private disposed = false

  constructor(root: ParentNode) {
    this.root = root
  }

  attach(): this {
    if (this.disposed) throw new Error('ThinkingMarquee: 已销毁的实例不能重新挂载')
    this.injectStyle()
    this.sync()
    this.observer = new MutationObserver(() => { this.sync() })
    this.observer.observe(this.root as Node, { childList: true, subtree: true })
    return this
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.styleEl?.remove()
    this.styleEl = null
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-marquee]')) {
      el.removeAttribute('data-marquee')
      el.style.removeProperty('--dsh-marquee-shift')
      el.style.removeProperty('--dsh-marquee-duration')
    }
  }

  private injectStyle(): void {
    const doc = document
    if (doc.querySelector(`#${STYLE_ID}`) !== null) return
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE
    doc.head.appendChild(style)
    this.styleEl = style
  }

  private sync(): void {
    const summaries = Array.from(this.root.querySelectorAll<HTMLElement>(SUMMARY_SELECTOR))
    for (const el of summaries) {
      this.measure(el)
      if (!this.observed.has(el)) {
        this.observed.add(el)
        this.resizeObserver ??= new ResizeObserver((entries) => {
          for (const entry of entries) this.measure(entry.target as HTMLElement)
        })
        this.resizeObserver.observe(el)
      }
    }
  }

  private measure(el: HTMLElement): void {
    const parent = el.closest('[aria-expanded]')
    const expanded = parent?.getAttribute('aria-expanded') === 'true'
    const overflow = el.scrollWidth - el.clientWidth

    if (expanded || overflow <= 2) {
      el.removeAttribute('data-marquee')
      el.style.removeProperty('--dsh-marquee-shift')
      el.style.removeProperty('--dsh-marquee-duration')
      return
    }

    el.setAttribute('data-marquee', '')
    el.style.setProperty('--dsh-marquee-shift', `${-overflow}px`)
    // Longer text → longer cycle so reading speed stays comfortable.
    const duration = Math.max(6, Math.min(16, 4 + overflow / 60))
    el.style.setProperty('--dsh-marquee-duration', `${duration.toFixed(1)}s`)
  }
}

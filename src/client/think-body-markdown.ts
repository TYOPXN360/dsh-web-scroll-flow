/**
 * Post-render Markdown for thinking body content.
 * React renders thinkBody as plain text; this converts it to HTML progressively.
 */

import { thinkMarkdownToHtml } from './think-markdown.ts'

const MARKED_ATTR = 'data-dsh-think-md'

export class ThinkBodyMarkdown {
  private readonly root: ParentNode
  private observer: MutationObserver | null = null
  private syncScheduled = false
  private readonly lastText = new WeakMap<HTMLElement, string>()
  private disposed = false

  constructor(root: ParentNode) {
    this.root = root
  }

  attach(): this {
    if (this.disposed) throw new Error('ThinkBodyMarkdown: disposed')
    this.sync()
    this.observer = new MutationObserver(() => {
      if (this.syncScheduled) return
      this.syncScheduled = true
      queueMicrotask(() => {
        this.syncScheduled = false
        this.sync()
      })
    })
    this.observer.observe(this.root as Node, { childList: true, subtree: true, characterData: true })
    return this
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    // Restore plain text for all rendered elements.
    for (const el of this.root.querySelectorAll<HTMLElement>(`[${MARKED_ATTR}]`)) {
      const original = this.lastText.get(el)
      if (original !== undefined) el.textContent = original
      el.removeAttribute(MARKED_ATTR)
    }
  }

  private sync(): void {
    const bodies = this.root.querySelectorAll<HTMLElement>('[class*="thinkBody"]')
    for (const body of bodies) {
      const text = body.textContent ?? ''
      const prev = this.lastText.get(body)
      if (text === prev) continue
      this.lastText.set(body, text)
      // Convert to markdown HTML, preserving the source text for typewriter.
      body.innerHTML = thinkMarkdownToHtml(text)
      body.setAttribute(MARKED_ATTR, '')
    }
  }
}

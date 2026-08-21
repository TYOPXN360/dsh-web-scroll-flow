// The behavior component only toggles the `data-scroll-flow` tag; the actual
// animation is the stylesheet it ships. jsdom never evaluates CSS, so these
// assertions pin the shipped rule set at source level — vertical bottom-follow
// animated, horizontal collapsed-Think summary follow pinned instant (auto),
// each with the reduced-motion fallback.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const STYLES = new URL('../src/client/ScrollFlowBehavior.module.css', import.meta.url)

async function styles(): Promise<string> {
  const css = await readFile(STYLES, 'utf8')
  // Collapse whitespace so rule shape is asserted without line-break coupling.
  return css.replace(/\s+/g, ' ')
}

describe('ScrollFlowBehavior styles', () => {
  it('smoothes the scrollport bottom-follow while the tag is on', async () => {
    const css = await styles()
    expect(css).toContain(':global([data-conversation-scroll][data-scroll-flow])')
    expect(css).toMatch(
      /\[data-conversation-scroll\]\[data-scroll-flow\]\)\s*\{\s*scroll-behavior: smooth;/,
    )
  })

  it('keeps the collapsed Think summary line-end follow instant (auto) under the same tag', async () => {
    // `scroll-behavior` is inherited, so the follow-end would otherwise pick
    // up the scrollport's smooth; the browser's fixed-duration animation
    // cannot keep up with token cadence, so the rule pins it back to auto.
    const css = await styles()
    expect(css).toContain('[data-follow-end]')
    expect(css).toMatch(
      /\[data-conversation-scroll\]\[data-scroll-flow\]\s+\[data-follow-end\]\)\s*\{\s*scroll-behavior: auto;/,
    )
  })

  it('disables the vertical rule under prefers-reduced-motion', async () => {
    const css = await styles()
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('[data-conversation-scroll][data-scroll-flow]')
    expect(reduced).not.toContain('[data-follow-end]') // already auto at base
    expect(reduced).toContain('scroll-behavior: auto;')
  })

  it('keeps the anchor invisible', async () => {
    const css = await styles()
    expect(css).toMatch(/\.anchor\s*\{\s*display: none;/)
  })

  it('keeps the running-turn status label last so a pending steering bubble cannot push it up', async () => {
    const css = await styles()
    expect(css).toMatch(
      /\[data-conversation-scroll\]\[data-scroll-flow\]\s+\[data-chat-flow\]\s*>\s*\[role="status"\]\)\s*\{\s*order: 1;/,
    )
  })
})

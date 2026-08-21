/**
 * Streaming scroll-transition behavior. Mounted on the
 * `conversation.composer.dock` seat (inside the active conversation
 * scrollport), this component carries no visible UI: while the model is
 * streaming and the preference is on, it tags the resolved scrollport with
 * `data-scroll-flow`, which global rules answer with `scroll-behavior: smooth`
 * — so the chat view's own bottom-follow writes (`el.scrollTop =
 * el.scrollHeight`) animate instead of snapping, while wheel / touch reader
 * scrolling stays native (scroll-behavior only affects programmatic scrolls).
 * The collapsed Think summary's line-end follow (`scrollLeft` on
 * `[data-follow-end]`) cannot use that smooth: its writes land every ~3
 * frames, shorter than the browser's fixed minimum animation duration, so the
 * animation would crawl. Instead the element's `scrollLeft` is intercepted
 * while streaming — writes are recorded as a pending target — and a fast
 * per-frame easing animates the real position at token speed. The tag drops
 * the instant the stream ends, the preference turns off, or the session
 * unmounts.
 *
 * The tag alone has a side effect this component compensates for: the chat
 * view's follow ledger assumes a programmatic write lands instantly, so a
 * smooth glide's intermediate scroll events (gap > 25px while moving toward
 * the floor) are misattributed as reader input and drop the bottom-follow
 * state — the "back to bottom" button flickers on, or follow is lost for the
 * rest of a large stream. A capture-phase listener on `window` therefore
 * suppresses exactly those glide-progress events (forward movement with a
 * real gap, only while the tag is active) before the scrollport's own
 * bubble-phase handler sees them, and passes everything else through —
 * backward (reader) movement, landed positions, and all events while idle.
 *
 * A second side effect: a smooth glide is never instant, so between a content
 * commit and its glide landing the viewport sits a few px behind the floor —
 * and because the running-turn status label is the flow column's last item,
 * that residual lag shows up as the label dipping a few px on every appended
 * line. Rather than snapping the scroll position (which would strip the
 * transition from small per-line commits — most visibly an expanded Think's
 * vertical follow), the label is pinned visually: while the tag is active and
 * the view is following, a requestAnimationFrame loop applies
 * `translateY(-min(lag, PIN_CAP))` to the label, cancelling its dip without
 * ever touching scrollTop, so the vertical follow animation is preserved.
 * On high-refresh displays the fixed-duration CSS glide can trail fast growth
 * by 30–60px (beyond the pin's visual reach): a snap then writes scrollTop
 * back to the floor once (gated on following intent and on the lag stalling),
 * and the glide lands. Sub-pixel lags get no transform at all, so label-text
 * churn (the Deep-diving elapsed counter re-renders every second) can't
 * toggle a 1px pin. Reader scroll-up clears the following intent, which
 * releases both the pin and the snap — a reader is never yanked back down.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ScrollFlowBehavior.module.css'
import { logDebug, tickDebugFrame } from './debug-logger.ts'

/** The conversation scrollport tag ConversationRoot paints on its scrollBody. */
const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'
/** The tag this plugin toggles on the resolved scrollport. */
const SCROLL_FLOW_ATTRIBUTE = 'data-scroll-flow'
/** The flow column inside the scrollport; new messages, tool calls, and
 * reasoning rows are its direct or descendant children. */
const FLOW_COLUMN_SELECTOR = '[data-chat-flow]'
/** ChatView counts the scrollport as pinned at the bottom within this gap
 * (FOLLOW_THRESHOLD + 1); a glide with a larger gap is the flip condition. */
const AT_BOTTOM_GAP = 25
/** CSS selector for the running-turn status label inside the flow column. */
const STATUS_SELECTOR = '[data-chat-flow] > [role="status"]'
/** Maximum visual pin compensation, px. A high-refresh (600Hz) display makes
 *  the CSS smooth glide's fixed ~500ms duration lag behind content that grows
 *  faster than one commit per animation — steady-state lag of 30–60px on large
 *  streams. The cap covers that range while the view is following; beyond it
 *  (reader territory) the pin is released entirely (followingRef gates it), so
 *  the label moves naturally instead of being yanked. */
const PIN_CAP = 80
/** Sub-pixel dead zone: lags ≤ this get no transform at all, so label-text
 *  churn (the Deep-diving elapsed-time counter re-renders every second, and
 *  pending labels swap in) cannot toggle a 1px pin on and off. */
const PIN_DEAD_ZONE = 0.5

/**
 * Compute an optional `translateY` transform that pins the running-turn status
 * label at its resting viewport position while the scrollport lags behind the
 * growing content by the glide's residual lag (a positive gap within
 * PIN_DEAD_ZONE..PIN_CAP). The scroll position is never touched, so the
 * vertical follow animation is preserved in full; lags beyond the cap — and
 * all lags when the reader is scrolling (the component gates pinning on its
 * following intent, not on this pure function) — leave the label to move
 * naturally.
 * @param scrollport - the tagged conversation scrollport.
 * @returns the CSS transform value, or `''` when no pinning is needed.
 */
export function pinStatusLabel(scrollport: HTMLElement): string {
  const lag = scrollport.scrollHeight - scrollport.clientHeight - scrollport.scrollTop
  if (lag <= PIN_DEAD_ZONE) return ''
  return `translateY(${-Math.min(lag, PIN_CAP)}px)`
}

/** The collapsed Think summary's line-end follow element (ReasoningRow paints
 * this while its block is the streaming tail). */
const FOLLOW_SELECTOR = '[data-follow-end]'

/** Fade-in duration for newly mounted flow rows. */
const FADE_IN_DURATION = 220

/** Markdown block tags MarkdownText paints as independent rows (a paragraph,
 * list item, fence, quote, heading, table, footnote section, …). Together
 * with the two data markers they define "one row" for the fade-in. */
const ROW_LEVEL_TAGS = new Set([
  'P', 'LI', 'PRE', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'TABLE', 'FIGURE', 'SECTION', 'HR',
])

/** One row of the chat flow: a flow item (message / tool call), a collapsed
 * reasoning row, or a Markdown block row inside a message. Inline bits
 * (spans, icons, code internals) are not rows and never animate. Expanded
 * thinking bodies are deliberately NOT rows: their text is one bare node
 * that React rewrites on every streaming chunk, so any DOM we insert there
 * is deleted immediately (visible flicker) — they stay plain. The observer
 * only reports insertions inside the flow column, so no out-of-tree guard is
 * needed here. */
function isRowLevel(el: HTMLElement): boolean {
  if (el.hasAttribute('data-chat-flow-key') || el.hasAttribute('data-follow-end')) return true
  return ROW_LEVEL_TAGS.has(el.tagName)
}

/** The innermost content container of an expanded Think: the deepest DIV
 * inside `[data-variant="think"]` (not the Think root, not a nested flow
 * item). Some thinks render their body as bare text, others as Markdown
 * rows — both live in the deepest div, which is what the streaming bottom
 * shadow is applied to. The body's DOM is never restructured here, so
 * React's per-chunk text rewrites are safe. Collapsed thinks carry their
 * summary in a `[data-follow-end]` span and have no body — they return null
 * so they never get a shadow (or a split). */
function findExpandedThinkBody(think: HTMLElement): HTMLElement | null {
  if (think.querySelector('[data-follow-end]') !== null) return null
  let best: HTMLElement | null = null
  for (const d of think.querySelectorAll('div')) {
    if (d === think) continue
    if (d.hasAttribute('data-chat-flow-key')) continue
    if (d.closest('[data-variant="think"]') !== think) continue
    best = d
  }
  return best
}

const thinkExpandedOnce = new WeakSet<HTMLElement>()
/** Position transition for an expanding Think: the body opens from 0 to its
 * natural height over 220ms, so the content below it is pushed down with an
 * animation instead of jumping into place. The collapse to 0 happens before
 * the first paint (forced reflow), so the user only ever sees the opening.
 * Each body is animated at most once — later observer hits (split rows being
 * inserted, the think re-rendering on collapse/expand) must not replay the
 * animation. Streaming bodies cannot use this (their height grows with the
 * text), so they get a simple slide-in instead. Collapsing cannot be
 * animated from the plugin: React unmounts the body on the same commit,
 * leaving no frame for an exit animation (the harness is not modified). */
function animateThinkExpandHeight(body: HTMLElement): void {
  if (thinkExpandedOnce.has(body)) return
  thinkExpandedOnce.add(body)
  if (typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return
  }
  const target = body.scrollHeight
  if (target <= 0) return
  body.style.height = '0px'
  body.style.overflow = 'hidden'
  void body.offsetHeight // commit the collapse before the first paint
  const anim = body.animate(
    [{ height: '0px' }, { height: `${target}px` }],
    { duration: 220, easing: 'ease-out' },
  )
  anim.onfinish = () => {
    body.style.height = ''
    body.style.overflow = ''
  }
}

/** Lightweight slide-in for a streaming expanded Think: content keeps
 * growing, so a fixed-height animation would clip it — a transform slide is
 * layout-free and safe. */
function animateThinkSlideIn(body: HTMLElement): void {
  if (typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return
  }
  body.animate(
    [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 200, easing: 'ease-out' },
  )
}

/** One-shot fade-in of a freshly mounted row via the Web Animations API
 * (no CSS keyframes needed, so a plain module stylesheet never leaks). The
 * element keeps its layout box from the first frame — history is pushed up
 * while the new row fades in. Reduced-motion users get a plain insert. */
function fadeIn(el: HTMLElement, delayMs = 0): void {
  if (typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return
  }
  try {
    el.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: FADE_IN_DURATION, easing: 'ease-out', delay: delayMs, fill: 'both' },
    )
    const tag = el.tagName
    const marker = el.hasAttribute('data-follow-end') ? ' fe' : el.hasAttribute('data-chat-flow-key') ? ' flow' : ''
    logDebug('fade', `row ${tag}${marker}`)
  } catch {
    // No Web Animations API (older engine): the insert is simply unanimated.
  }
}

/** Row-by-row reveal of an expanded thinking body once it settles. The body
 * is one bare text node (no DOM rows), so the text is split into one element
 * per line and every line fades in from the top, one after another (30ms
 * apart). The split only runs while the Think is settled (`data-state="ok"`):
 * while streaming, React rewrites the body's text node on every chunk and
 * deletes any rows we insert (visible flicker), so streaming expansions get
 * the bottom shadow instead and the split runs once the turn finishes. */
function revealThinkBodyLines(el: HTMLElement): void {
  if (el.querySelector('[data-scroll-flow-row]') !== null) return // already split
  const lines = (el.textContent ?? '').split('\n')
  if (lines.length <= 1) return
  logDebug('fade', `think split lines=${lines.length}`)
  // The body is a flex container (painted for a single text node), so each
  // split row must claim its own line inside it — `flex: 0 0 100%` makes
  // every row a full-width flex item that wraps to its own line, and
  // `pre-wrap` preserves the row's internal whitespace.
  el.textContent = ''
  for (const [i, line] of lines.entries()) {
    const row = document.createElement('div')
    row.setAttribute('data-scroll-flow-row', '')
    row.style.flex = '0 0 100%'
    row.style.whiteSpace = 'pre-wrap'
    row.style.boxSizing = 'border-box'
    row.textContent = line ?? ''
    el.appendChild(row)
    // Top-down stagger: rows fade in one after another (30ms apart), capped
    // so a very long think does not spend seconds animating. `fill: 'both'`
    // keeps each row invisible during its delay, then fades it in.
    fadeOnce(row, Math.min(i, 40) * 30)
  }
}

/** Fade target for a row marker: a collapsed reasoning summary's line-end
 * marker lives on an inline span — fade the whole Think row (icon + title +
 * summary) instead, so the "one line" fades as a unit. */
function fadeRowTarget(el: HTMLElement): HTMLElement {
  if (el.hasAttribute('data-follow-end')) {
    return el.closest('[data-variant="think"]') ?? el
  }
  return el
}

/** An element only fades in once per short window, ever: a batch insert
 * reports the same row both as an added node and as a descendant of another
 * added node, and a frozen markdown block can appear in several mutation
 * entries while the message streams around it. Replaying the animation within
 * that window is what made collapsed reasoning rows strobe. A hard
 * "only once per lifetime" rule is too strict, though — React can re-mount a
 * row a moment later (moving it reports an insertion), and then a fresh row
 * appearing after the window must be allowed to fade in again. */
const FADE_DEDUP_WINDOW_MS = 500
const fadedAt = new WeakMap<HTMLElement, number>()
function fadeOnce(el: HTMLElement, delayMs = 0): void {
  const last = fadedAt.get(el) ?? -Infinity
  if (performance.now() - last < FADE_DEDUP_WINDOW_MS) return
  fadedAt.set(el, performance.now())
  fadeIn(el, delayMs)
}

/** Time constant (ms) for the follow easing toward a small target delta — the
 * per-token increments. 30ms gives a visible ~90ms glide per write at any
 * refresh rate (easing is time-based, so a 600Hz panel animates just as
 * smoothly as 60Hz; a frame-count easing would finish in ~5ms there and look
 * like the old instant jump). */
const FOLLOW_TAU_SLOW = 30
/** Time constant (ms) for large deltas (a whole line/paragraph landed at once):
 * catch up fast instead of trailing. */
const FOLLOW_TAU_FAST = 10
/** |target - current| above which the fast time constant applies. */
const FOLLOW_TAU_THRESHOLD = 100
/** Clamp the frame delta so a backgrounded tab's resumed first frame cannot
 * jump the easing to completion. */
const FOLLOW_DT_MAX = 100
/** Monotonic time of the last follow advance (time-based easing needs dt). */
let lastFollowAt = 0

/** Per-element intercept state: the native `scrollLeft` accessor pair and the
 * latest target ReasoningRow asked for (kept pending, not applied). */
interface FollowState {
  read: () => number
  write: (value: number) => void
  pending: number
}

const followStates = new WeakMap<Element, FollowState>()
/** Debug sampling: log follow progress every N animation frames — one line of
 *  streaming per few frames would otherwise flood the 20k ring. */
const FOLLOW_LOG_EVERY = 30
let followFrames = 0

/** Install an instance-level `scrollLeft` that records ReasoningRow's line-end
 * writes as a pending target instead of applying them. The element's own
 * programmatic writes (which scroll the summary in a real browser) keep
 * working through the saved native accessors, so nothing else is affected;
 * instance shadowing restores the prototype accessor on release. Returns null
 * when the platform exposes no accessor (nothing to intercept). */
function interceptFollowScroll(el: HTMLElement): FollowState | null {
  const existing = followStates.get(el)
  if (existing !== undefined) return existing
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
  if (desc === undefined || !('get' in desc) || !('set' in desc)) return null
  const getter = desc.get
  const setter = desc.set
  const state: FollowState = {
    read: () => getter.call(el),
    write: value => setter.call(el, value),
    pending: getter.call(el),
  }
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => getter.call(el),
    set: (value: number) => { state.pending = value },
  })
  followStates.set(el, state)
  // Fresh time base: the easing's dt starts counting from this element's first
  // advance (module-level state must not leak across elements or test runs).
  lastFollowAt = 0
  logDebug('follow', `intercept on (pos=${Math.round(state.pending)})`)
  return state
}

/** Drop the instance shadow so ReasoningRow's writes land natively again
 * (instant end-of-stream reset, the pre-plugin behavior). */
function releaseFollowScroll(el: HTMLElement): void {
  if (followStates.delete(el)) {
    delete (el as { scrollLeft?: unknown }).scrollLeft
    logDebug('follow', 'intercept off')
  }
}

/**
 * Advance the collapsed Think summary's line-end follow toward its intercepted
 * target. ReasoningRow writes `scrollLeft = scrollWidth - clientWidth` on a
 * ~3-frame cadence while streaming; intercepting those writes (recording them
 * as `pending` instead of applying them) lets this loop animate the real
 * position with a time-based easing — a visible transition that still keeps up
 * with token speed, unlike `scroll-behavior: smooth`, whose fixed minimum
 * duration is longer than the write cadence and so crawls. The easing's time
 * constant makes the glide duration refresh-rate independent (600Hz vs 60Hz
 * panels see the same ~90ms glide per small write, instead of 1–2 frames of
 * motion that are indistinguishable from an instant jump). When no accessor
 * exists the element is left untouched (native instant follow).
 * @param el - the `[data-follow-end]` summary element.
 * @returns the applied scrollLeft, or null when nothing was intercepted.
 */
export function advanceFollowScroll(el: HTMLElement): number | null {
  const state = interceptFollowScroll(el)
  if (state === null) return null
  const current = state.read()
  const target = state.pending
  if (Math.abs(target - current) <= 0.5) return current
  const now = performance.now()
  const dt = lastFollowAt === 0 ? 16.7 : Math.min(now - lastFollowAt, FOLLOW_DT_MAX)
  lastFollowAt = now
  const tau = Math.abs(target - current) > FOLLOW_TAU_THRESHOLD
    ? FOLLOW_TAU_FAST
    : FOLLOW_TAU_SLOW
  const next = current + (target - current) * (1 - Math.exp(-dt / tau))
  state.write(next)
  followFrames += 1
  if (followFrames % FOLLOW_LOG_EVERY === 0) {
    logDebug('follow', `anim pos=${Math.round(next)} target=${Math.round(target)} dt=${Math.round(dt)}`)
  }
  return next
}

/** Registration-side behavior face (the enabled hook rides the shared policy). */
export interface ScrollFlowBehaviorInjected {
  hooks: {
    /** Persisted streaming-animation preference bound as useEnabled. */
    enabled: SnapshotStore<boolean>
  }
}

/** Full dock-entry props. */
export type ScrollFlowBehaviorProps =
  PropsRuntime<'conversation.composer.dock'>
  & InjectFace<ScrollFlowBehaviorInjected>

/**
 * Toggle the smooth-scroll tag on the owning conversation scrollport while
 * streaming is active and the preference is enabled, and shield the chat
 * view's follow ledger from its own glide events.
 * @param props - composed dock slot props.
 * @returns a hidden anchor element (no visible UI).
 */
export function ScrollFlowBehavior({ useEnabled, useSession }: ScrollFlowBehaviorProps) {
  const enabled = useEnabled(value => value)
  const running = useSession(snapshot => snapshot.running)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const scrollportRef = useRef<HTMLElement | null>(null)
  const activeRef = useRef(false)
  activeRef.current = enabled && running
  const suppressRef = useRef(false)
  const lastTopRef = useRef(0)
  /** Whether the user is (still) following the growing content at the bottom.
   * Reader scroll-up clears it; landing at the bottom sets it. The label pin
   * and the large-lag snap both gate on it, so a reader who scrolled away is
   * never yanked back down. */
  const followingRef = useRef(true)
  /** True while a snap-initiated glide is still in flight (lag is falling).
   * Re-snapping every frame would restart the smooth animation forever and the
   * scrollTop would never advance; snapping only when the lag stops falling
   * (stalled or growing) lets the glide land. */
  const snappingRef = useRef(false)
  const prevLagRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (anchor === null) return
    const scrollport = anchor.closest<HTMLElement>(SCROLLPORT_SELECTOR)
    if (scrollport === null) return
    const active = enabled && running
    scrollport.toggleAttribute(SCROLL_FLOW_ATTRIBUTE, active)
    logDebug('state', `tag ${active ? 'on' : 'off'} (enabled=${enabled} running=${running})`)
    if (scrollportRef.current !== scrollport) {
      // The active conversation's scrollport changed: reset the guard state.
      scrollportRef.current = scrollport
      suppressRef.current = false
      followingRef.current = true
      lastTopRef.current = scrollport.scrollTop
      snappingRef.current = false
      prevLagRef.current = null
      logDebug('state', 'scrollport changed')
    }
    // Label pinning: while the tag is up and the view is following, compensate
    // the status label's dip (translateY of the residual lag) every frame —
    // never touching scrollTop, so the vertical follow animation is preserved
    // in full. When the lag exceeds the cap (a stalled glide on a 600Hz panel
    // where the fixed ~500ms CSS animation can't keep up with fast growth), a
    // snap writes scrollTop back to the floor once — the glide then lands and
    // the pin resumes. The collapsed Think summary's line-end follow runs
    // alongside: its writes are intercepted and animated at a time-based
    // easing that keeps up with tokens at any refresh rate.
    // New-message fade-in: every freshly mounted flow item (a message, a tool
    // call row, a newly appended reasoning row) fades in over ~220ms while
    // history is pushed up by the normal document flow. The observer watches
    // the flow column's subtree for child insertions and animates only the
    // two row-level markers — ChatView paints `data-chat-flow-key` on each
    // flow item and ReasoningRow paints `data-follow-end` on a collapsed
    // summary's line-end span — so text-node churn inside a growing stream
    // never triggers an animation. Reduced-motion users see plain inserts.
    const observer = new MutationObserver(entries => {
      for (const entry of entries) {
        // A Think settled (data-state running→ok): nothing to do — a
        // streaming expansion was already on screen (its slide-in played on
        // insertion); no re-reveal. The split top-down reveal only runs when
        // a *settled* Think is expanded (body insertion, above).
        if (entry.type === 'attributes' && entry.attributeName === 'data-state') {
          continue
        }
        for (const node of entry.addedNodes) {
          if (node.nodeType !== 1) continue
          const el = node as HTMLElement
          // An expanded Think just mounted (or re-rendered): while it is
          // running, it gets a slide-in; once settled it is revealed from the
          // top with a height animation. Covers three shapes of insertion:
          // the Think root itself, a Think inside the inserted fragment, and
          // — when the user expands an already-mounted Think — just its body.
          const handleThink = (t: HTMLElement): void => {
            const body = findExpandedThinkBody(t)
            logDebug('fade', `think ${t.getAttribute('data-state')} body=${body !== null}`)
            if (body === null) return
            if (t.getAttribute('data-state') === 'running') {
              animateThinkSlideIn(body)
            } else {
              // Settled: reveal the full text from the top and open the body
              // with a height animation so the content below is pushed down
              // smoothly. Only plain-text bodies are split — a body that
              // already renders Markdown rows (p/li/pre) or any child
              // elements (e.g. a collapsed header) is left alone, its rows
              // are row-level and fade in on their own.
              if (body.querySelector('p, li, pre, [data-follow-end]') === null
                && body.children.length === 0) {
                revealThinkBodyLines(body)
              }
              animateThinkExpandHeight(body)
            }
          }
          if (el.getAttribute('data-variant') === 'think') {
            handleThink(el)
          } else {
            const inside = el.closest('[data-variant="think"]') as HTMLElement | null
            if (inside !== null) handleThink(inside)
          }
          el.querySelectorAll('[data-variant="think"]').forEach(n => {
            handleThink(n as HTMLElement)
          })
          // Walk the inserted fragment: the top element itself and any
          // row-level rows inside it (a batch insert — a whole message, a
          // list, a frozen markdown block — never reports inner rows as
          // separate addedNodes). Every row fades in exactly once.
          if (isRowLevel(el)) {
            fadeOnce(fadeRowTarget(el))
          }
          el.querySelectorAll('*').forEach(n => {
            const row = n as HTMLElement
            if (!isRowLevel(row)) return
            fadeOnce(fadeRowTarget(row))
          })
        }
      }
    })
    const flow = scrollport.querySelector(FLOW_COLUMN_SELECTOR)
    if (enabled && flow !== null) {
      observer.observe(flow, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-state'],
      })
    }
    let raf = 0
    let lastTransform = ''
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      tickDebugFrame()
      const port = scrollportRef.current
      if (port === null) return
      // Large-lag correction: a 600Hz panel's CSS smooth glide (~500ms fixed
      // duration) can trail content that grows faster than one commit per
      // animation, leaving a steady lag beyond what the pin covers. Snap the
      // scrollTop back to the floor once (guard suppresses the glide's
      // intermediate events, so the chat ledger stays blind) and let the
      // glide land; the followingRef gate keeps a reader who scrolled away
      // from being pulled back down.
      const floor = port.scrollHeight - port.clientHeight
      const lag = floor - port.scrollTop
      if (followingRef.current && lag > PIN_CAP) {
        if (!snappingRef.current || (prevLagRef.current !== null && lag >= prevLagRef.current - 0.5)) {
          port.scrollTop = floor
          snappingRef.current = true
          logDebug('snap', `floor=${floor} lag=${Math.round(lag)}`)
        }
        prevLagRef.current = lag
      } else {
        snappingRef.current = false
        prevLagRef.current = null
      }
      const label = port.querySelector<HTMLElement>(STATUS_SELECTOR)
      if (label !== null) {
        const next = followingRef.current ? pinStatusLabel(port) : ''
        if (next !== lastTransform) {
          label.style.transform = next
          lastTransform = next
          logDebug('pin', next === '' ? 'release' : next)
        }
      }
      const follow = port.querySelector<HTMLElement>(FOLLOW_SELECTOR)
      if (follow !== null) advanceFollowScroll(follow)
    }
    if (active) raf = requestAnimationFrame(tick)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      const label = scrollport.querySelector<HTMLElement>(STATUS_SELECTOR)
      if (label !== null) label.style.transform = ''
      const follow = scrollport.querySelector<HTMLElement>(FOLLOW_SELECTOR)
      if (follow !== null) releaseFollowScroll(follow)
      scrollport.removeAttribute(SCROLL_FLOW_ATTRIBUTE)
    }
  }, [enabled, running])

  // Glide guard: hide the chat view's own smooth-follow scroll events from its
  // ledger while the model streams. Capture on window runs before any listener
  // on the scrollport itself (scroll events do not bubble, but the capture
  // path still traverses ancestors first), so stopImmediatePropagation here
  // keeps the chat view's handler blind to glide progress — but only for
  // forward movement with a real gap; backward (reader) movement and landed
  // positions pass through untouched.
  useEffect(() => {
    const scrollport = scrollportRef.current
    if (scrollport === null) return
    lastTopRef.current = scrollport.scrollTop
    const onScroll = (event: Event): void => {
      const port = scrollportRef.current
      if (port === null || event.target !== port) return
      if (!activeRef.current && !suppressRef.current) return
      const top = port.scrollTop
      const gap = port.scrollHeight - port.clientHeight - top
      // Update following intent before the guard logic: every scroll event
      // (whether suppressed or released) tells us whether the reader is
      // following or scrolled away.
      if (top < lastTopRef.current - 0.5) followingRef.current = false
      if (gap <= AT_BOTTOM_GAP) followingRef.current = true
      if (suppressRef.current) {
        if (top < lastTopRef.current - 0.5 || gap <= AT_BOTTOM_GAP) {
          suppressRef.current = false // reader took over, or the glide landed
          logDebug('guard', `release (gap=${Math.round(gap)})`)
        } else {
          lastTopRef.current = top
          event.stopImmediatePropagation()
          return
        }
      } else if (gap > AT_BOTTOM_GAP && top > lastTopRef.current + 0.5) {
        suppressRef.current = true // follow-glide after a large content commit
        lastTopRef.current = top
        event.stopImmediatePropagation()
        logDebug('guard', `engage (gap=${Math.round(gap)})`)
        return
      }
      lastTopRef.current = top
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [])

  return <div ref={anchorRef} className={css.anchor} aria-hidden="true" />
}

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrollFlowController } from '../src/client/scroll-flow-controller.ts'

/** 可控时钟（performance.now 的 mock 数据源）。 */
let clock = 0
/** 手动驱动的 rAF 队列。 */
let rafQueue: Array<FrameRequestCallback> = []

/** 替换原型 scrollTop 为可写的 mock（jsdom 原生是 no-op）。 */
function mockNativeScrollTop(): { get(): number; set(value: number): void; setFloor(floor: number): void; restore(): void } {
  let real = 0
  let floor = 0
  const set = (value: number): void => {
    real = Math.max(0, Math.min(value, floor))
  }
  const installed: Array<{ proto: object; original: PropertyDescriptor }> = []
  for (const proto of [HTMLElement.prototype, Element.prototype]) {
    const original = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
    if (original !== undefined) {
      Object.defineProperty(proto, 'scrollTop', { configurable: true, get: () => real, set })
      installed.push({ proto, original })
    }
  }
  return {
    get: () => real,
    set,
    setFloor: (value: number) => { floor = value },
    restore: () => {
      for (const { proto, original } of installed) Object.defineProperty(proto, 'scrollTop', original)
    },
  }
}

/** 手动推进 rAF 队列：以 ~16ms 步长分割时长，模拟真实浏览器帧调度。 */
function stepFrames(ms: number): void {
  while (ms > 0) {
    const step = Math.min(16, ms)
    clock += step
    ms -= step
    const current = rafQueue.splice(0)
    for (const callback of current) callback(clock)
  }
}

/** 模拟内容增长：更新元素的 scrollHeight 与原生 mock 的 floor。 */
function setScrollHeight(el: HTMLElement, value: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => value })
  scrollMock.setFloor(Math.max(0, value - clientHeight))
}

/** 构造带几何信息与回弹目标的滚动容器（同时设置原生 mock 的 floor）。 */
function makeScroller(scrollHeight = 1100, clientHeight = 100, withBounceTarget = true): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-conversation-scroll', '')
  document.body.append(el)
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  setScrollHeight(el, scrollHeight, clientHeight)
  if (withBounceTarget) {
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    el.append(flow)
  }
  return el
}

/** 构造滚轮事件（jsdom 的 WheelEvent init 支持 deltaY）。 */
function makeWheel(deltaY: number, prevented = false): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true })
  if (prevented) event.preventDefault()
  return event
}

/** matchMedia 的桩：可动态切换 matches 并触发 change 监听。 */
function mockMatchMedia(matches = false): {
  setMatches(next: boolean): void
} {
  let current = matches
  const listeners = new Set<EventListener>()
  const media = {
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, listener: EventListener) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: EventListener) => { listeners.delete(listener) },
  }
  Object.defineProperty(media, 'matches', { get: () => current })
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  return {
    setMatches(next: boolean): void {
      current = next
      for (const listener of listeners) listener({ matches: next } as unknown as Event)
    },
  }
}

let scrollMock: ReturnType<typeof mockNativeScrollTop>

beforeEach(() => {
  clock = 1_000
  rafQueue = []
  scrollMock = mockNativeScrollTop()
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    rafQueue.push(callback)
    return rafQueue.length
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  scrollMock.restore()
  document.body.innerHTML = ''
})

describe('ScrollFlowController — 自动跟随动画', () => {
  it('跟随写入（目标=scrollHeight）启动平滑动画，并立即向读取方报告目标', () => {
    const el = makeScroller(1100, 100) // floor = 1000
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100

    // getter 立即报告目标（ChatView 账本一致），真实位置尚未移动。
    expect(controller.reported).toBe(1000)
    expect(el.scrollTop).toBe(1000)
    expect(scrollMock.get()).toBe(0)
    expect(controller.following).toBe(true)

    // 中间态：真实位置处于起点与目标之间。
    stepFrames(140)
    const mid = scrollMock.get()
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1000)

    // 完成：真实位置到达目标，动画结束。
    stepFrames(200)
    expect(scrollMock.get()).toBe(1000)
    expect(controller.following).toBe(false)
    expect(controller.reported).toBe(1000)
  })

  it('动画中的重复同目标跟随写入不重启动画', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100
    stepFrames(140)
    expect(controller.following).toBe(true)
    el.scrollTop = 1100 // 同目标（scroll 事件触发的重复 toBottom）
    stepFrames(140) // 若重启动画，此后的 140ms 不足以完成（总推进 280ms 恰好临界）
    expect(scrollMock.get()).toBe(1000)
    expect(controller.following).toBe(false)
  })

  it('跟随目标变化（内容继续增长）时平滑重定向到新 floor', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100
    stepFrames(100)
    setScrollHeight(el, 1600, 100) // 新内容流入，scrollHeight 增长
    el.scrollTop = 1600 // 新 floor = 1500

    expect(controller.following).toBe(true)
    stepFrames(400)
    expect(scrollMock.get()).toBe(1500)
    expect(controller.following).toBe(false)
  })

  it('动画期间 scroll 事件不打断动画（只有明确用户输入才打断）', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100 // 大距离跟随：0 → 1000
    stepFrames(70)
    // 浏览器异步派发 scroll 事件（动画自身的写入触发），不应误判为用户打断。
    el.dispatchEvent(new Event('scroll'))
    expect(controller.following).toBe(true)

    stepFrames(300)
    expect(scrollMock.get()).toBe(1000)
    expect(controller.following).toBe(false)
  })

  it('贴底小增量跟随：瞬时滚动 + 整列入场推升（ChatAnimation 式）', () => {
    const el = makeScroller(1100, 100)
    const flow = el.querySelector<HTMLElement>('[data-chat-flow]')!
    const status = document.createElement('div')
    status.setAttribute('role', 'status')
    status.textContent = 'Deep diving...'
    flow.append(status)

    const controller = new ScrollFlowController(el).attach()
    scrollMock.set(970) // 已贴底，只有 30px 增量

    el.scrollTop = 1100 // 新 floor = 1000

    // 滚动位置瞬时落到新底部（不依赖 scrollTop 动画，流式时不会震动）。
    expect(scrollMock.get()).toBe(1000)
    expect(controller.following).toBe(false)
    // 整列先向下压，再平滑回位；状态行反向抵消保持固定。
    expect(controller.entering).toBe(true)
    stepFrames(64)
    expect(controller.entryShift).toBeGreaterThan(0)
    expect(controller.entryShift).toBeLessThan(28)
    expect(flow.style.transform).not.toBe('')
    expect(status.style.transform).not.toBe('')

    // 动画结束：位移归零，transform 清空。
    stepFrames(400)
    expect(controller.entering).toBe(false)
    expect(controller.entryShift).toBe(0)
    expect(flow.style.transform).toBe('')
    expect(status.style.transform).toBe('')
  })

  it('高频连续跟随不重启入场动画（流式逐 token 稳定）', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()
    scrollMock.set(970)

    el.scrollTop = 1100
    stepFrames(16)
    const afterFirst = controller.entryShift
    expect(controller.entering).toBe(true)

    // 16ms 后再次小增量跟随（同目标）：不应从 28px 重新下压。
    el.scrollTop = 1100
    stepFrames(16)
    expect(controller.entering).toBe(true)
    expect(controller.entryShift).toBeLessThan(afterFirst)

    stepFrames(400)
    expect(controller.entering).toBe(false)
    expect(controller.entryShift).toBe(0)
  })

  it('非跟随写入（恢复位置 / prepend 锚定）瞬时通过', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 500
    expect(scrollMock.get()).toBe(500)
    expect(controller.reported).toBe(500)
    expect(controller.following).toBe(false)
  })

  it('attach / dispose 在存在 ResizeObserver 时正常（flow 高度监视不抛错）', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()
    expect(() => controller.dispose()).not.toThrow()
  })

  it('大幅自动滚动动画期间状态行钉在最终位置，不随动画漂移', () => {
    const el = makeScroller(1100, 100)
    const flow = el.querySelector<HTMLElement>('[data-chat-flow]')!
    const status = document.createElement('div')
    status.setAttribute('role', 'status')
    status.textContent = 'Deep diving...'
    flow.append(status)

    const controller = new ScrollFlowController(el).attach()
    el.scrollTop = 1100 // 0 → 1000 的大距离跟随

    stepFrames(64)
    expect(controller.following).toBe(true)
    // 状态行补偿 = real - target，抵消未走完的滚动位移（负值，向上钉住）。
    const expected = `translateY(${(scrollMock.get() - 1000).toFixed(2)}px)`
    expect(status.style.transform).toBe(expected)
    expect(flow.style.transform).toBe('')

    stepFrames(300)
    expect(controller.following).toBe(false)
    expect(status.style.transform).toBe('')
  })

  it('动画中被用户滚动（滚轮）打断后重新同步真实位置', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100
    stepFrames(70)
    scrollMock.set(123) // 浏览器 / 用户把真实位置改到别处
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))

    expect(controller.following).toBe(false)
    expect(controller.reported).toBe(123)
    expect(el.scrollTop).toBe(123)
  })

  it('动画中被键盘滚动打断', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100
    stepFrames(70)
    expect(controller.following).toBe(true)

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    expect(controller.following).toBe(false)
  })

  it('动画中被鼠标按下（滚动条拖动）打断', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100
    stepFrames(70)
    expect(controller.following).toBe(true)

    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(controller.following).toBe(false)
  })

  it('动画打断后，浏览器原生滚动不经 setter 也能被 getter 立即读到', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100 // 启动动画
    stepFrames(70)
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true })) // 用户打断
    expect(controller.following).toBe(false)

    // 模拟浏览器原生滚动（wheel/滚动条直接改内部值，不触发我们的 setter）。
    scrollMock.set(500)
    expect(el.scrollTop).toBe(500) // getter 非动画时直读原生值，不再顶住
  })

  it('reduced-motion 下跟随写入瞬时完成', () => {
    mockMatchMedia(true)
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100

    expect(controller.following).toBe(false)
    expect(scrollMock.get()).toBe(1000)
    expect(controller.reported).toBe(1000)
  })

  it('减动效在运行中开启时打断进行中的动画', () => {
    const media = mockMatchMedia(false)
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.scrollTop = 1100
    stepFrames(70)
    media.setMatches(true)

    expect(controller.following).toBe(false)
    expect(controller.reported).toBe(scrollMock.get())
  })
})

describe('ScrollFlowController — 边缘回弹', () => {
  it('顶部继续向上滚：内容向下拉伸后弹簧回弹归零', () => {
    const el = makeScroller(1100, 100)
    const flow = el.querySelector<HTMLElement>('[data-chat-flow]')!
    const controller = new ScrollFlowController(el).attach()

    el.dispatchEvent(makeWheel(-100))
    expect(controller.bounceShift).toBe(0)
    stepFrames(16)
    expect(controller.bounceShift).toBeGreaterThan(0)
    expect(flow.style.transform).toContain('translateY')

    // 松手后（超过 releaseDelay）拉伸释放，弹簧把位移带回 0。
    stepFrames(150)
    stepFrames(1_000)
    expect(controller.bounceShift).toBeCloseTo(0, 1)
    expect(flow.style.transform).toBe('')
    expect(flow.style.transform).toBe('')
  })

  it('底部继续向下滚：内容向上拉伸', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()
    scrollMock.set(1000) // 已在底部

    el.dispatchEvent(makeWheel(100))
    stepFrames(16)
    expect(controller.bounceShift).toBeLessThan(0)
  })

  it('可滚动方向的滚轮只释放拉伸，不产生回弹', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.dispatchEvent(makeWheel(-100))
    stepFrames(16)
    expect(controller.bounceShift).toBeGreaterThan(0)

    // 用户滚到中间后继续向上滚：可以正常滚动，释放拉伸，位移弹簧回中。
    scrollMock.set(500)
    el.dispatchEvent(makeWheel(-100))
    stepFrames(800)
    expect(controller.bounceShift).toBeCloseTo(0, 1)
  })

  it('defaultPrevented 的滚轮（输入栏链式滚动）不触发回弹', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.dispatchEvent(makeWheel(-100, true))
    el.dispatchEvent(makeWheel(-100, true))
    stepFrames(16)
    expect(controller.bounceShift).toBe(0)
  })

  it('容器内没有回弹目标（如 trajectory 视图）时回弹不生效', () => {
    const el = makeScroller(1100, 100, false)
    const controller = new ScrollFlowController(el).attach()

    el.dispatchEvent(makeWheel(-100))
    stepFrames(16)
    expect(controller.bounceShift).toBe(0)
  })

  it('reduced-motion 下回弹禁用', () => {
    mockMatchMedia(true)
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    el.dispatchEvent(makeWheel(-100))
    stepFrames(16)
    expect(controller.bounceShift).toBe(0)
  })

  it('回弹时状态行（Deep diving / 待插话消息）保持固定', () => {
    const el = makeScroller(1100, 100)
    const flow = el.querySelector<HTMLElement>('[data-chat-flow]')!
    const status = document.createElement('div')
    status.setAttribute('role', 'status')
    status.textContent = 'Deep diving...'
    const pending = document.createElement('div')
    pending.setAttribute('data-pending-steering', '')
    pending.textContent = '待插话消息'
    flow.append(status, pending)

    const controller = new ScrollFlowController(el).attach()
    el.dispatchEvent(makeWheel(-100))
    stepFrames(16)
    stepFrames(32)

    expect(controller.bounceShift).toBeGreaterThan(0)
    expect(flow.style.transform).not.toBe('')
    // 状态行用反向 transform 抵消列的位移。
    expect(status.style.transform).toBe(`translateY(${(-controller.bounceShift).toFixed(2)}px)`)
    expect(pending.style.transform).toBe(`translateY(${(-controller.bounceShift).toFixed(2)}px)`)

    // 松手回中后所有 transform 清空。
    stepFrames(150)
    stepFrames(1_000)
    expect(controller.bounceShift).toBeCloseTo(0, 1)
    expect(flow.style.transform).toBe('')
    expect(status.style.transform).toBe('')
    expect(pending.style.transform).toBe('')
  })

  it('可配置幅度与灵敏度', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el, {
      bounce: { amplitude: 10, pullRate: 24, stiffness: 160, damping: 12, sensitivity: 50, releaseDelay: 120 },
    }).attach()

    el.dispatchEvent(makeWheel(-200)) // 灵敏度 50 → 一次拉满
    stepFrames(16)
    stepFrames(32)
    expect(controller.bounceShift).toBeGreaterThan(5)
    expect(controller.bounceShift).toBeLessThanOrEqual(10)
  })
})

describe('ScrollFlowController — 生命周期', () => {
  it('attach 覆写实例 scrollTop，dispose 完整还原', () => {
    const el = makeScroller(1100, 100)
    const flow = el.querySelector<HTMLElement>('[data-chat-flow]')!
    const controller = new ScrollFlowController(el).attach()

    expect(Object.getOwnPropertyDescriptor(el, 'scrollTop')).toBeDefined()

    el.dispatchEvent(makeWheel(-100))
    stepFrames(16)
    expect(flow.style.transform).not.toBe('')

    controller.dispose()
    expect(Object.getOwnPropertyDescriptor(el, 'scrollTop')).toBeUndefined()
    expect(flow.style.transform).toBe('')
    // dispose 后写入走原生路径。
    el.scrollTop = 300
    expect(scrollMock.get()).toBe(300)
  })

  it('dispose 幂等，且已销毁的控制器不能重新挂载', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el).attach()

    controller.dispose()
    controller.dispose()
    expect(() => controller.attach()).toThrow(/已销毁/)
  })

  it('不支持的选项关闭对应行为', () => {
    const el = makeScroller(1100, 100)
    const controller = new ScrollFlowController(el, { follow: null, bounce: null }).attach()

    el.scrollTop = 1100
    expect(scrollMock.get()).toBe(1000) // 瞬时
    expect(controller.following).toBe(false)

    el.dispatchEvent(makeWheel(-100))
    stepFrames(16)
    expect(controller.bounceShift).toBe(0)
  })
})

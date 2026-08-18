/**
 * ScrollFlowController — 为 DSH Web 的对话滚动容器（[data-conversation-scroll]）
 * 附加滚动动效：
 *
 * 1. 自动跟随动画（ChatAnimation 式）：
 *    - 贴底小增量跟随（内容流入 / 自动换行 / 思维链展开）：滚动位置瞬时
 *      落到新底部，同时整个消息列先向下压 `entryPushPx`，再平滑回位。
 *      视觉上就是新内容从底部平滑出现、旧消息被整体往上推；不依赖滚动条
 *      动画，流式输出不会因频繁重定向而震动。
 *    - 大距离跳转（点击"回到底部"）：保留 scrollTop 平滑缓动。
 * 2. 边缘回弹：手动滚轮越过顶 / 底边缘时，内容小幅拉伸，随后弹簧回弹。
 *
 * 手动滚动本身从不插值 —— 浏览器原生手感保持不变；控制器只负责
 * 自动跟随的入场 / 跳转动效与边缘回弹。
 *
 * 实现要点：
 * - 对容器实例覆写 `scrollTop`（configurable），区分"贴底跟随写入"
 *   （目标 == scrollHeight）与其它写入（恢复位置、prepend 锚定）。
 * - 所有内容位移统一渲染到 `[data-chat-flow]` 的 transform：
 *   `entryOffset`（入场推升）+ `bounceOffset`（回弹拉伸）；Deep diving、
 *   待插话消息等"现场状态行"用反向位移保持固定在最终位置。
 * - 只有明确的用户输入（滚轮 / 触摸 / 鼠标按下 / 键盘滚动）会打断动画。
 *
 * 调试：关键决策（跟随写入分类、入场抑制、回弹触发）都写入
 * debugLog，`window.__dshScrollFlowDebug.dump()` 可导出完整时间线。
 */

import { debugLog } from './debug-log.ts'

/** 回弹的橡皮筋状态机参数。 */
export interface BounceOptions {
  /**
   * 软增益参考距离（px）：拉动越远，单位滚轮输入产生的位移越小
   * （增益 = 1/(1+|offset|/amplitude)），但是无硬上限——只要一直滚，
   * 内容就一直跟手；松手后平滑缓动归位。默认 16。
   */
  amplitude: number
  /** 松手归位缓动的基准时长（ms）。默认 160。 */
  stiffness: number
  /** 归位缓动按距离的附加时长系数（ms/px）。默认 1.2。 */
  damping: number
  /** 滚轮灵敏度：多少 deltaY 折算成一次 amplitude 的拉动。默认 220。 */
  sensitivity: number
  /** 滚轮停止多久后进入释放回弹（ms）。默认 120。 */
  releaseDelay: number
}

/** 自动跟随动画参数。 */
export interface FollowOptions {
  /**
   * 动画时长（ms）：贴底跟随的入场推升时长；大距离"回到底部"跳转的
   * 最大时长（距离满 200px 用满该值，小距离更短）。默认 200
   * （设置中的"优雅"档传 380）。
   */
  duration: number
}

export interface ScrollFlowOptions {
  /** 自动跟随动画参数；`null` 关闭该行为。 */
  follow?: FollowOptions | null
  /** 边缘回弹参数；`null` 关闭该行为。 */
  bounce?: BounceOptions | null
  /** 回弹内容列选择器（容器内）。默认 `[data-chat-flow]`。 */
  bounceTargetSelector?: string
}

const DEFAULT_FOLLOW: FollowOptions = { duration: 200 }
/** 减弱后的回弹：拉动更短（sensitivity 更高 + amplitude 更小）、回弹更软更快收敛。 */
const DEFAULT_BOUNCE: BounceOptions = {
  amplitude: 16,
  stiffness: 110,
  damping: 14,
  sensitivity: 220,
  releaseDelay: 120,
}

/** 视为"同一目标"的容差（px），避免 scroll 事件触发的重复跟随写入重启动画。 */
const SAME_TARGET_TOLERANCE = 1
/** 弹簧 / 拉伸收敛阈值（px）。 */
const REST_EPSILON = 0.05
/** 贴底小增量 vs 大距离跳转的分界（px）。 */
const ENTRY_FOLLOW_DISTANCE = 48
/** 待插话消息导致的增长上限（px）：超过视为普通大距离（回底/其它增长），
 * 只有贴近该值的增长走"瞬时 + 状态行补偿"路径。 */
const PENDING_MAX_DISTANCE = 500
/** 入场推升的最大下压位移（px）。 */
const ENTRY_PUSH_PX = 28
/** 连续入场动画的最小间隔（ms），流式逐 token 时避免高频重启动画。 */
const ENTRY_MIN_INTERVAL = 120

/** 捕获容器元素类型的原生 `scrollTop` 访问器（原型链，含 jsdom 兼容回退）。 */
function nativeScrollTopDescriptor(): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
    ?? Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
}

/** 缓动：easeOutCubic，先快后慢的自然收尾。 */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 一个对话滚动容器的滚动动效控制器。构造后调用 {@link attach} 生效，
 * {@link dispose} 完整还原（移除属性覆写、监听与残留 transform）。
 */
export class ScrollFlowController {
  readonly element: HTMLElement

  private follow: FollowOptions | null
  private bounce: BounceOptions | null
  private readonly bounceSelector: string
  private readonly nativeGet: () => number
  private readonly nativeSet: (value: number) => void

  /** 大距离跳转时向读取方报告的逻辑位置（动画中提前到达目标）。 */
  private reportedTop = 0
  /** 大距离 scrollTop 缓动状态。 */
  private animating = false
  private animStart = 0
  private animTarget = 0
  private animStartTime = 0
  private animDuration = 0
  /** 贴底入场推升状态：整列先下压后平滑回位。 */
  private entryActive = false
  private entryStartTime = 0
  private entryDuration = 0
  private entryPush = 0
  private lastEntryStartAt = 0
  /** 当前入场推升位移（px，正 = 列向下压）。 */
  private entryOffset = 0
  /** 抑制入场推升的截止时间：布局恢复（打字结束）引起的高度突变不应被当新内容入场。 */
  private suppressEntryUntil = 0
  /** 打字机活动期截止时间：期间贴底跟随改用平滑滚动（每写完一行，上一行文字平滑上推）。 */
  private smoothFollowUntil = 0
  /** 本次 follow 动画被"不同目标"重载的次数（排障用）。 */
  private followRestarts = 0
  /** 本次入场推升被"重复触发"重载的次数（排障用）。 */
  private entryRestarts = 0
  /** 帧日志限频时间戳。 */
  private lastFrameLogAt = 0
  /** 状态行位置日志限频时间戳。 */
  private lastStatusLogAt = 0
  /** 边缘回弹状态：跟手位移（px，顶边缘为正/向下拉，底边缘为负/向上拉）。 */
  private bounceOffset = 0
  private bounceVelocity = 0
  private releasing = false
  /** 松手缓动归位状态（无弹簧振荡）。 */
  private releaseStartOffset = 0
  private releaseStartTime = 0
  private releaseDuration = 120
  private lastWheelAt = 0
  private bounceFrameAt = 0
  private touchY: number | null = null
  private bounceTarget: HTMLElement | null = null
  /** flow 高度监视：检测内容收回（高度减小）时清位移，避免与浏览器 clamp 叠加成"撞墙回弹"。 */
  private flowObserver: ResizeObserver | null = null
  private lastFlowHeight = 0
  /** rAF 调度：非 0 表示有未决帧。 */
  private frameId = 0
  private disposed = false
  private reducedMotion = false

  /** 滚轮：用户手动滚动 → 打断动画；边缘继续向外滚时跟手拉动。 */
  private readonly onWheel = (event: WheelEvent): void => {
    this.cancelAnimation('wheel')
    this.cancelEntry('wheel')
    this.applyEdgePull(event.deltaY, event)
  }

  private applyEdgePull(deltaY: number, event: Event): void {
    if (this.bounce === null || this.disposed || this.reducedMotion
      || event.defaultPrevented || deltaY === 0) return
    if (this.eventConsumedByChildScroll(event, deltaY)) return
    if (this.resolveBounceTarget() === null) return
    const real = this.nativeGet()
    const floor = Math.max(0, this.element.scrollHeight - this.element.clientHeight)
    const atTop = real <= 0
    const atBottom = floor - real <= 1
    const pushingOut = (deltaY < 0 && atTop) || (deltaY > 0 && atBottom)
    if (!pushingOut) {
      this.beginRelease()
      return
    }
    if (event.cancelable) event.preventDefault()
    this.lastWheelAt = performance.now()
    const direction = deltaY < 0 ? 1 : -1
    const unit = Math.abs(deltaY) / this.bounce.sensitivity * this.bounce.amplitude
    const gain = 1 / (1 + Math.abs(this.bounceOffset) / Math.max(1, this.bounce.amplitude))
    this.bounceOffset += direction * unit * gain
    this.bounceVelocity = 0
    this.bounceFrameAt = performance.now()
    this.releasing = false
    this.ensureFrame()
  }

  /** 目标与容器之间是否存在能在滚动方向上继续滚动的子滚动元素。 */
  private eventConsumedByChildScroll(event: Event, deltaY: number): boolean {
    const target = event.target instanceof Element ? event.target : null
    if (target === null || !this.element.contains(target)) return false
    let el: Element | null = target
    while (el !== null && el !== this.element) {
      if (el.scrollHeight > el.clientHeight) {
        const style = getComputedStyle(el)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          if (deltaY < 0 && el.scrollTop > 0) return true
          const floor = el.scrollHeight - el.clientHeight
          if (deltaY > 0 && el.scrollTop < floor - 1) return true
        }
      }
      el = el.parentElement
    }
    return false
  }

  /** 触摸开始：记录手指位置，后续只在边缘越界时接管。 */
  private readonly onTouchStart = (event: TouchEvent): void => {
    this.cancelAll('touch')
    this.touchY = event.touches[0]?.clientY ?? null
  }

  private readonly onTouchMove = (event: TouchEvent): void => {
    const currentY = event.touches[0]?.clientY
    if (this.touchY === null || currentY === undefined) return
    const deltaY = this.touchY - currentY
    this.touchY = currentY
    this.cancelAnimation('touch')
    this.cancelEntry('touch')
    this.applyEdgePull(deltaY, event)
  }

  private readonly onTouchEnd = (): void => {
    this.touchY = null
    this.beginRelease()
  }


  /** 点击：非滚动交互（展开消息等），清掉残留位移避免重排时误显。 */
  private readonly onClick = (): void => {
    this.cancelAll('click')
  }

  /** 按下（滚动条拖动、触摸板点击等）：用户接管，打断动画。 */
  private readonly onPointerDown = (): void => {
    this.cancelAll('pointer')
  }

  /** 键盘滚动（PageUp/PageDown/方向键等）：用户接管，打断动画。 */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown'
      || event.key === 'PageUp' || event.key === 'PageDown'
      || event.key === 'Home' || event.key === 'End'
      || event.key === ' ') {
      this.cancelAll('key')
    }
  }

  constructor(element: HTMLElement, options: ScrollFlowOptions = {}) {
    this.element = element
    this.follow = options.follow === undefined ? DEFAULT_FOLLOW : options.follow
    this.bounce = options.bounce === undefined ? DEFAULT_BOUNCE : options.bounce
    this.bounceSelector = options.bounceTargetSelector ?? '[data-chat-flow]'
    const descriptor = nativeScrollTopDescriptor()
    if (descriptor === undefined || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') {
      throw new Error('ScrollFlowController: 当前环境缺少原生 scrollTop 访问器')
    }
    this.nativeGet = () => descriptor.get!.call(element)
    this.nativeSet = (value) => { descriptor.set!.call(element, value) }
    this.reportedTop = this.nativeGet()
  }

  /**
   * 运行时更新动效配置（设置面板切换动画档位 / 弹簧开关）。
   * 关闭某项时立即取消对应动画并清理残留状态。
   * @param options - 新配置；未提供的字段保持当前值。
   */
  setOptions(options: ScrollFlowOptions): void {
    if ('follow' in options) this.follow = options.follow === undefined ? DEFAULT_FOLLOW : options.follow
    if ('bounce' in options) this.bounce = options.bounce === undefined ? DEFAULT_BOUNCE : options.bounce
    if (this.follow === null) {
      this.cancelAnimation('settings')
      this.cancelEntry('settings')
    }
    if (this.bounce === null) {
      this.resetBounce('settings')
      this.applyFlowTransform()
    }
  }

  /** 是否处于减动效模式（prefers-reduced-motion）。 */
  get reducedMotionEnabled(): boolean {
    return this.reducedMotion
  }

  /** 挂载：覆写 scrollTop、绑定监听、解析回弹目标。 */
  attach(): this {
    if (this.disposed) throw new Error('ScrollFlowController: 已销毁的控制器不能重新挂载')
    Object.defineProperty(this.element, 'scrollTop', {
      configurable: true,
      enumerable: true,
      // 大距离动画中向读取方报告目标（ChatView 账本一致）；其余状态直读
      // 原生真实值，浏览器原生滚动（滚轮 / 滚动条）不经 setter 也能同步。
      get: () => this.animating ? this.reportedTop : this.nativeGet(),
      set: (value: number) => { this.onScrollTopWrite(value) },
    })
    this.element.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
    this.element.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true })
    this.element.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false })
    this.element.addEventListener('touchend', this.onTouchEnd, { capture: true, passive: true })
    this.element.addEventListener('touchcancel', this.onTouchEnd, { capture: true, passive: true })
    this.element.addEventListener('mousedown', this.onPointerDown, { capture: true, passive: true })
    this.element.addEventListener('keydown', this.onKeyDown, { capture: true, passive: true })
    this.element.addEventListener('click', this.onClick, { capture: true, passive: true })
    this.observeFlowHeight()
    this.syncReducedMotion()
    const media = this.reducedMotionMedia()
    media?.addEventListener('change', this.onReducedMotionChange)
    return this
  }

  /**
   * 观察内容列高度：工具 / 消息收回（高度减小）时立即取消入场与回弹，
   * 清掉应用中的 transform，避免与浏览器 clamp 叠加出"撞墙回弹"。
   */
  private observeFlowHeight(): void {
    if (typeof ResizeObserver === 'undefined') return
    const flow = this.resolveBounceTarget()
    if (flow === null) return
    this.lastFlowHeight = flow.offsetHeight
    this.flowObserver = new ResizeObserver(() => {
      if (flow.offsetHeight < this.lastFlowHeight) {
        this.cancelAnimation('height-shrink')
        this.cancelEntry('height-shrink')
        this.resetBounce('height-shrink')
        this.resetFlowTransform()
      }
      this.lastFlowHeight = flow.offsetHeight
    })
    this.flowObserver.observe(flow)
  }

  /** 卸载：还原原生 scrollTop、移除监听、取消动画与残留 transform。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelAll('dispose')
    this.flowObserver?.disconnect()
    this.flowObserver = null
    delete (this.element as unknown as Record<string, unknown>).scrollTop
    this.element.removeEventListener('wheel', this.onWheel, { capture: true })
    this.element.removeEventListener('touchstart', this.onTouchStart, { capture: true })
    this.element.removeEventListener('touchmove', this.onTouchMove, { capture: true })
    this.element.removeEventListener('touchend', this.onTouchEnd, { capture: true })
    this.element.removeEventListener('touchcancel', this.onTouchEnd, { capture: true })
    this.element.removeEventListener('mousedown', this.onPointerDown, { capture: true })
    this.element.removeEventListener('keydown', this.onKeyDown, { capture: true })
    this.element.removeEventListener('click', this.onClick, { capture: true })
    this.reducedMotionMedia()?.removeEventListener('change', this.onReducedMotionChange)
    this.resetFlowTransform()
  }

  /** 逻辑位置（测试 / 调试读取）。 */
  get reported(): number {
    return this.reportedTop
  }

  /** 是否正在执行大距离 scrollTop 动画。 */
  get following(): boolean {
    return this.animating
  }

  /** 是否正在执行贴底入场推升动画。 */
  get entering(): boolean {
    return this.entryActive
  }

  /** 在指定时长内抑制贴底入场推升（打字机恢复布局等非流式高度突变）。 */
  suppressEntryFor(durationMs: number): void {
    this.suppressEntryUntil = performance.now() + durationMs
    this.cancelEntry('suppress')
  }

  /**
   * 在指定时长内，贴底跟随写入改用平滑滚动（打字机每写完一行，上一行
   * 文字平滑上推，而不是瞬时跳变 / 下压回弹）。由 index.ts 在打字机
   * 内容增长时调用。
   */
  smoothFollowFor(durationMs: number): void {
    this.smoothFollowUntil = performance.now() + durationMs
    debugLog('anim', 'smooth-follow:arm', { durationMs, until: Math.round(this.smoothFollowUntil) })
  }

  /** 当前回弹位移（px）。 */
  get bounceShift(): number {
    return this.bounceOffset
  }

  /** 当前入场推升位移（px）。 */
  get entryShift(): number {
    return this.entryOffset
  }

  private onScrollTopWrite(value: number): void {
    const floor = Math.max(0, this.element.scrollHeight - this.element.clientHeight)
    const real = this.nativeGet()
    // 跟随写入语义：ChatView 把 scrollTop 设为 scrollHeight（内容增长/贴底）。
    // 不要求 distance>0 —— 贴底后内容继续增长时 real 已到 floor 但仍触发入场。
    const isFollowWrite = this.follow !== null
      && !this.reducedMotion
      && Math.abs(value - this.element.scrollHeight) <= SAME_TARGET_TOLERANCE
    if (!isFollowWrite) {
      // 非跟随写入（恢复位置 / prepend 锚定）：原样瞬时通过。
      debugLog('scroll', 'write:pass-through', {
        value: Math.round(value), real: Math.round(real),
        floor: Math.round(floor), scrollHeight: this.element.scrollHeight,
      })
      this.cancelAll('pass-through')
      this.nativeSet(value)
      this.reportedTop = this.nativeGet()
      return
    }
    const distance = floor - real
    // 打字机活动期：贴底跟随用平滑滚动（每写完一行，上一行文字平滑上推，
    // 而不是瞬时跳变 / 下压回弹）。大距离跳转也走平滑滚动动画。
    const smoothing = performance.now() < this.smoothFollowUntil
    // 待插话消息（status 后方）出现导致的小幅增长：瞬时跟随并立即补偿
    // 状态行位置，避免 200ms 平滑滚动把 Deep diving 明显"顶上去"。只有
    // 增长量接近待插话消息占位（而非用户在中部的大距离回底）才走该路径。
    const pendingGrowth = this.statusHasPendingAfter()
      && distance > 0 && distance <= PENDING_MAX_DISTANCE
    if ((distance > ENTRY_FOLLOW_DISTANCE || smoothing) && pendingGrowth) {
      debugLog('scroll', 'write:pending-instant', {
        distance: Math.round(distance), floor: Math.round(floor),
        real: Math.round(real), scrollHeight: this.element.scrollHeight,
      })
      this.cancelAnimation('pending')
      this.cancelEntry('pending')
      this.nativeSet(value)
      // 立即应用状态行补偿（offset 为 0，status 被 +pending 占位拉回原位）。
      this.applyFlowTransform()
      return
    }
    if (distance > ENTRY_FOLLOW_DISTANCE || smoothing) {
      debugLog('scroll', 'write:smooth-follow', {
        distance: Math.round(distance), floor: Math.round(floor),
        real: Math.round(real), scrollHeight: this.element.scrollHeight, smoothing,
      })
      this.cancelEntry('follow')
      this.startFollowAnimation(floor)
      return
    }
    // 贴底跟随（流式增量 / 自动换行 / 展开思维链）：瞬时落到新底部，
    // 再播放整列入场推升，避免滚动条动画在高频流式下震动。
    if (this.animating) {
      // 平滑动画进行中（大距离收尾 / 打字机平滑期）：不要取消动画切到
      // 入场推升，否则剩余距离会从平滑滚动突然变成瞬时跳（"回弹"感）。
      // 同目标由 merge 合并，新目标重定向继续平滑。
      debugLog('scroll', 'write:entry-push-animating', {
        distance: Math.round(distance), real: Math.round(real), floor: Math.round(floor),
      })
      this.startFollowAnimation(floor)
      return
    }
    debugLog('scroll', 'write:entry-push', {
      distance: Math.round(distance), floor: Math.round(floor),
      real: Math.round(real), scrollHeight: this.element.scrollHeight,
    })
    this.nativeSet(value)
    this.startEntryPush()
  }

  private startFollowAnimation(target: number): void {
    // 同目标动画进行中：合并写入，不重启。否则动画帧驱动 scroll 事件 →
    // ChatView 读到"已到底"→ 再次写 scrollTop=scrollHeight → 新动画从
    // 中间值重启，动画永远无法完成，页面持续平滑滚动（"集中爆发"）。
    if (this.animating && Math.abs(target - this.animTarget) <= SAME_TARGET_TOLERANCE) {
      debugLog('anim', 'follow:merge', {
        target: Math.round(target), from: Math.round(this.animStart),
      })
      return
    }
    if (this.animating) {
      // 动画进行中目标变化（内容继续增长）：从当前中间值重启，属于正常
      // 重载，记录以便排查"动画总是重载"。
      this.followRestarts++
      debugLog('anim', 'follow:restart', {
        from: Math.round(this.nativeGet()),
        oldTarget: Math.round(this.animTarget),
        newTarget: Math.round(target),
        restarts: this.followRestarts,
      })
    } else {
      this.followRestarts = 0
    }
    this.animating = true
    this.animStart = this.nativeGet()
    this.animTarget = target
    // 自适应时长：距离满 200px 用满配置值；打字机活动期小距离（一行）也
    // 用平滑时长（160ms 封顶），让"写完一行上一行被平滑推上去"。
    const maxDuration = Math.max(1, this.follow?.duration ?? 1)
    const distance = Math.abs(target - this.animStart)
    const smoothing = performance.now() < this.smoothFollowUntil
    this.animDuration = smoothing
      ? Math.min(maxDuration, Math.max(24, 160 * (distance / 48)))
      : Math.max(16, Math.min(maxDuration, maxDuration * (distance / 200)))
    this.animStartTime = performance.now()
    // 立即向读取方报告目标：ChatView 的 observedTop 账本同步，回底按钮不闪。
    this.reportedTop = target
    debugLog('anim', 'follow:start', {
      from: Math.round(this.animStart), to: Math.round(target),
      distance: Math.round(distance), duration: Math.round(this.animDuration),
      smoothing, restarts: this.followRestarts,
    })
    this.ensureFrame()
  }

  /** 贴底入场推升：整列先下压 ENTRY_PUSH_PX，再平滑回位（ChatAnimation 式）。 */
  private startEntryPush(): void {
    if (this.resolveBounceTarget() === null || this.follow === null) return
    const now = performance.now()
    // 打字机恢复布局等非流式高度突变期间抑制入场，避免"打完字回弹"。
    if (now < this.suppressEntryUntil) {
      debugLog('scroll', 'entry-push:suppressed', {
        until: Math.round(this.suppressEntryUntil), now: Math.round(now),
      })
      return
    }
    // 流式逐 token 时高频到达：已有动画在播就不重启，避免连续下压抖动。
    if (this.entryActive && now - this.lastEntryStartAt < ENTRY_MIN_INTERVAL) {
      debugLog('scroll', 'entry-push:throttled', {
        lastStart: Math.round(this.lastEntryStartAt), now: Math.round(now),
      })
      return
    }
    if (this.entryActive) {
      // 动画播放中且超过最小间隔：整列重新下压（重载），记录次数。
      this.entryRestarts++
      debugLog('anim', 'entry:restart', {
        restarts: this.entryRestarts, sinceLast: Math.round(now - this.lastEntryStartAt),
      })
    } else {
      this.entryRestarts = 0
    }
    debugLog('scroll', 'entry-push:start', {
      push: ENTRY_PUSH_PX, duration: this.follow.duration,
    })
    this.entryActive = true
    this.entryPush = ENTRY_PUSH_PX
    this.entryDuration = Math.max(16, this.follow.duration)
    this.entryStartTime = now
    this.lastEntryStartAt = now
    this.ensureFrame()
  }

  private cancelAnimation(reason = 'unknown'): void {
    if (!this.animating) return
    debugLog('anim', 'follow:cancel', {
      reason, at: Math.round(this.nativeGet()), target: Math.round(this.animTarget),
      restarts: this.followRestarts,
    })
    this.animating = false
    this.reportedTop = this.nativeGet()
  }

  private cancelEntry(reason = 'unknown'): void {
    if (!this.entryActive) return
    debugLog('anim', 'entry:cancel', {
      reason, offset: Math.round(this.entryOffset * 100) / 100,
      restarts: this.entryRestarts,
    })
    this.entryActive = false
    this.entryOffset = 0
    this.applyFlowTransform()
  }

  /** 用户输入 / 关闭设置：取消全部动画并清理位移。 */
  private cancelAll(reason = 'unknown'): void {
    this.cancelAnimation(reason)
    this.cancelEntry(reason)
    this.resetBounce(reason)
  }

  /** 清除回弹状态（触控 / 关闭设置等用户操作，瞬时清干净）。 */
  private resetBounce(reason = 'unknown'): void {
    if (Math.abs(this.bounceOffset) > REST_EPSILON) {
      debugLog('anim', 'bounce:reset', {
        reason, offset: Math.round(this.bounceOffset * 100) / 100,
      })
    }
    this.bounceOffset = 0
    this.bounceVelocity = 0
    this.releasing = false
    this.bounceFrameAt = 0
    this.applyFlowTransform()
  }

  /** 松手释放：进入平滑缓动归位模式（offset 保留不回零，缓动带回；无振荡）。 */
  private beginRelease(): void {
    if (Math.abs(this.bounceOffset) <= REST_EPSILON) {
      this.resetBounce('release-idle')
      return
    }
    this.releasing = true
    this.bounceVelocity = 0
    // 缓动归位：时长按位移距离自适应（基准 + 每 px 附加），避免大位移
    // 也瞬间弹回；easeOut 一次到位，不来回振荡。
    const distance = Math.abs(this.bounceOffset)
    this.releaseStartOffset = this.bounceOffset
    this.releaseStartTime = performance.now()
    this.releaseDuration = Math.max(
      80,
      Math.min(320, (this.bounce?.stiffness ?? 160) + distance * (this.bounce?.damping ?? 1.2)),
    )
    debugLog('anim', 'bounce:release-start', {
      offset: Math.round(this.bounceOffset * 100) / 100,
      duration: Math.round(this.releaseDuration),
    })
  }

  private syncReducedMotion(): void {
    this.reducedMotion = this.reducedMotionMedia()?.matches ?? false
  }

  /** 减动效媒体查询（缺失时返回 undefined，保持禁用姿态）。 */
  private reducedMotionMedia(): MediaQueryList | undefined {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined
  }

  private readonly onReducedMotionChange = (): void => {
    this.syncReducedMotion()
    if (this.reducedMotion) this.cancelAll('reduced-motion')
  }

  /** 惰性解析内容列：视图切换（chat ↔ trajectory）后下次动画重新查找。 */
  private resolveBounceTarget(): HTMLElement | null {
    if (this.bounceTarget !== null && this.bounceTarget.isConnected) return this.bounceTarget
    this.bounceTarget = this.element.querySelector<HTMLElement>(this.bounceSelector)
    return this.bounceTarget
  }

  /**
   * 列尾的 Deep diving 与待插话行是 flow 的直接状态行；它们需要钉在
   * 视口中的原位置，避免跟随消息列的入场/回弹位移。嵌套的历史错误状态
   * 不参与补偿，避免改变普通消息的布局。
   */
  private fixedStatusElements(flow: HTMLElement): HTMLElement[] {
    return Array.from(flow.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement
        && child.matches('[role="status"], [data-pending-steering]'),
    )
  }

  private pendingShiftBefore(status: HTMLElement): number {
    let shift = 0
    let sibling = status.previousElementSibling
    while (sibling !== null) {
      if (sibling instanceof HTMLElement && sibling.matches('[data-pending-steering]')) {
        shift += sibling.getBoundingClientRect().height
      }
      sibling = sibling.previousElementSibling
    }
    return shift
  }

  /**
   * status 后方是否存在待插话消息（data-pending-steering 出现在状态行之后）。
   * 存在时，待插话消息导致的贴底跟随会走"瞬时 + 状态行补偿"路径。
   */
  private statusHasPendingAfter(): boolean {
    const target = this.resolveBounceTarget()
    if (target === null) return false
    const status = Array.from(target.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement
        && child.matches('[role="status"]'),
    )
    if (status === undefined) return false
    let sibling = status.nextElementSibling
    while (sibling !== null) {
      if (sibling instanceof HTMLElement && sibling.matches('[data-pending-steering]')) {
        return true
      }
      sibling = sibling.nextElementSibling
    }
    return false
  }

  /**
   * status 后方的待插话消息总占位（含间距）。待插话消息渲染在 Deep diving
   * 状态行之后（flow 末尾），出现时 scrollHeight 增长、贴底跟随把视口往下
   * 推，状态行会被"顶上去"；贴底时用该值反向补偿，把状态行拉回原位。
   */
  private pendingShiftAfter(status: HTMLElement): number {
    let shift = 0
    let prev: HTMLElement | null = status
    let sibling = status.nextElementSibling
    while (sibling !== null) {
      if (sibling instanceof HTMLElement && sibling.matches('[data-pending-steering]')) {
        // offsetTop 是相对 flow（offsetParent）的坐标，不受滚动影响；
        // 与上一个兄弟的 offsetTop 差 = 该行占位（含列 gap）。
        const gap = Math.max(0, sibling.offsetTop - prev.offsetTop - prev.offsetHeight)
        shift += sibling.offsetHeight + gap
        prev = sibling
      }
      sibling = sibling.nextElementSibling
    }
    return shift
  }

  /**
   * 统一渲染内容列位移：入场推升 + 回弹拉伸叠加到 transform；直接状态行
   * 用反向位移保持在原位置。
   */
  private applyFlowTransform(): void {
    const target = this.resolveBounceTarget()
    if (target === null) return
    const offset = this.entryOffset + (
      Math.abs(this.bounceOffset) > REST_EPSILON ? this.bounceOffset : 0
    )
    const transform = Math.abs(offset) > REST_EPSILON
      ? `translateY(${offset.toFixed(2)}px)`
      : ''
    target.style.transform = transform
    target.style.willChange = transform === '' ? '' : 'transform'
    // During a large automatic catch-up, let the status row travel with the
    // content so it stays out of view until the scroll reaches the bottom.
    // Pinning applies to manual edge bounce and small entry pushes only.
    for (const el of this.fixedStatusElements(target)) {
      const isStatus = el.matches('[role="status"]')
      const pendingShift = isStatus ? this.pendingShiftBefore(el) : 0
      // 贴底时，status 后方的待插话消息会把状态行顶上去（视口跟随）：反向
      // 补偿其占位，把状态行拉回原位。非贴底（用户浏览中间）不补偿。
      const atBottom = this.nativeGet()
        >= Math.max(0, this.element.scrollHeight - this.element.clientHeight) - 1
      const afterShift = isStatus && atBottom ? this.pendingShiftAfter(el) : 0
      const counterOffset = this.animating ? 0 : -offset - pendingShift + afterShift
      const counter = Math.abs(counterOffset) > REST_EPSILON
        ? `translateY(${counterOffset.toFixed(2)}px)`
        : ''
      el.style.transform = counter
      el.style.willChange = counter === '' ? '' : 'transform'
      // 状态行位置日志（限频 120ms）：排查"发送待插话消息时 Deep diving
      // 被顶上去"——记录补偿位移、待插话行高与 offset 的关系。
      const statusNow = performance.now()
      if (statusNow - this.lastStatusLogAt > 120) {
        this.lastStatusLogAt = statusNow
        debugLog('anim', 'status-transform', {
          role: isStatus ? 'status' : 'pending',
          counterOffset: Math.round(counterOffset * 100) / 100,
          pendingShift: Math.round(pendingShift * 100) / 100,
          afterShift: Math.round(afterShift * 100) / 100,
          offset: Math.round(offset * 100) / 100,
          animating: this.animating,
          transform: counter,
        })
      }
    }
  }

  private resetFlowTransform(): void {
    const target = this.resolveBounceTarget()
    if (target === null) return
    target.style.transform = ''
    target.style.willChange = ''
    for (const el of this.fixedStatusElements(target)) {
      el.style.transform = ''
      el.style.willChange = ''
    }
  }

  private ensureFrame(): void {
    if (this.disposed || this.frameId !== 0) return
    this.frameId = requestAnimationFrame(this.frameStep)
  }

  private readonly frameStep = (): void => {
    this.frameId = 0
    if (this.disposed) return
    const now = performance.now()
    let active = false

    // 1) 大距离 scrollTop 缓动（点击"回到底部"）。
    if (this.animating) {
      const duration = Math.max(1, this.animDuration)
      const t = (now - this.animStartTime) / duration
      if (t >= 1) {
        this.nativeSet(this.animTarget)
        this.animating = false
        this.reportedTop = this.nativeGet()
        debugLog('anim', 'follow:complete', {
          duration: Math.round(now - this.animStartTime), restarts: this.followRestarts,
        })
      } else {
        const value = this.animStart + (this.animTarget - this.animStart) * easeOutCubic(t)
        this.nativeSet(value)
        active = true
      }
    }

    // 2) 贴底入场推升：entryPush 平滑衰减到 0。
    if (this.entryActive) {
      const t = clamp((now - this.entryStartTime) / Math.max(1, this.entryDuration), 0, 1)
      this.entryOffset = this.entryPush * (1 - easeOutCubic(t))
      if (t >= 1) {
        this.entryActive = false
        this.entryOffset = 0
        debugLog('anim', 'entry:complete', {
          duration: Math.round(now - this.entryStartTime), restarts: this.entryRestarts,
        })
      } else {
        active = true
      }
    }

    // 3) 边缘回弹：滚轮还在边缘拉动时跟手保持；滚轮停止 releaseDelay
    //    后进入弹簧回中（松手释放）。
    if (this.bounce !== null && this.resolveBounceTarget() !== null) {
      const idleMs = now - this.lastWheelAt
      if (idleMs > this.bounce.releaseDelay && !this.releasing
        && Math.abs(this.bounceOffset) > REST_EPSILON) {
        this.beginRelease()
      }
      if (this.releasing) {
        // 松手：平滑缓动归位（easeOut，一次性返回原处，无弹簧振荡）。
        const t = clamp(
          (now - this.releaseStartTime) / Math.max(1, this.releaseDuration),
          0, 1,
        )
        this.bounceOffset = this.releaseStartOffset * (1 - easeOutCubic(t))
        if (t >= 1) {
          this.bounceOffset = 0
          this.bounceVelocity = 0
          this.releasing = false
        } else {
          active = true
        }
      } else if (Math.abs(this.bounceOffset) > REST_EPSILON) {
        // 跟手拉动中：保持帧循环，等待滚轮停止后进入释放。
        active = true
      }
    }

    // 帧级日志（限频 30ms）：记录动画实际播放过程，排查"动画总是重载"。
    if (now - this.lastFrameLogAt > 30) {
      this.lastFrameLogAt = now
      if (this.animating || this.entryActive || Math.abs(this.bounceOffset) > REST_EPSILON) {
        debugLog('anim', 'frame', {
          follow: this.animating ? Math.round(this.nativeGet()) : null,
          entry: this.entryActive ? Math.round(this.entryOffset * 100) / 100 : null,
          bounce: Math.abs(this.bounceOffset) > REST_EPSILON
            ? Math.round(this.bounceOffset * 100) / 100
            : null,
        })
      }
    }

    this.applyFlowTransform()
    if (active) this.ensureFrame()
  }
}

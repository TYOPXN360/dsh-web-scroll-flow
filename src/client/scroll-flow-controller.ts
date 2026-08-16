/**
 * ScrollFlowController — 为 DSH Web 的对话滚动容器（[data-conversation-scroll]）
 * 附加两种滚动动效：
 *
 * 1. 自动跟随动画：程序性的"贴底跟随"写入（内容流入 / 自动换行时
 *    ChatView 执行 `scrollTop = scrollHeight`）从瞬时跳变改为平滑缓动，
 *    视觉上形成内容向上顶、视口向下拉的连续自然滚动。
 * 2. 边缘回弹：手动滚轮越过顶 / 底边缘时，内容做小幅拉伸，随后弹簧回弹
 *    （橡皮筋效果）。
 *
 * 手动滚动本身从不插值 —— 浏览器原生手感保持不变；控制器只负责
 * 自动跟随的过渡动画与边缘回弹，不修改滚轮 / 触摸的原生行为。
 *
 * 实现要点：
 * - 对容器实例覆写 `scrollTop`（configurable），用 getter/setter 把
 *   "跟随写入"（目标 == scrollHeight）与其它写入（恢复位置、prepend 锚定）
 *   区分开：跟随写入立即向读取方报告目标值（保持 ChatView 的
 *   atBottom 账本一致、不闪回底按钮），真实位置由 rAF 缓动逼近；
 *   其它写入原样瞬时通过。
 * - 动画期间监听原生 scroll / wheel / touchstart，一旦真实位置偏离
 *   预期（用户输入打断）立即取消动画并重新同步。
 * - 回弹目标为容器内的 `[data-chat-flow]` 内容列，transform: translateY
 *   不改变布局与可滚动范围。
 */

/** 回弹的弹簧状态机参数。 */
export interface BounceOptions {
  /** 回弹最大幅度（px）。默认 24。 */
  amplitude: number
  /** 拉动阶段跟手速率（1/s）。默认 24。 */
  pullRate: number
  /** 释放阶段弹簧刚度（1/s²）。默认 160。 */
  stiffness: number
  /** 释放阶段弹簧阻尼（1/s）。默认 12。 */
  damping: number
  /** 滚轮灵敏度：多少 deltaY 拉满一次回弹。默认 140。 */
  sensitivity: number
  /** 滚轮停止多久后进入释放回弹（ms）。默认 120。 */
  releaseDelay: number
}

/** 自动跟随动画参数。 */
export interface FollowOptions {
  /**
   * 大距离跟随动画的最大时长（ms）。实际时长按距离自适应：
   * 距离满 200px 时用满该值，小增量（流式逐字增长）最短 16ms，
   * 避免底部状态行（Deep diving、时间、待发消息）在增量小时缓慢漂移。
   * 默认 200。
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
const DEFAULT_BOUNCE: BounceOptions = {
  amplitude: 24,
  pullRate: 24,
  stiffness: 160,
  damping: 12,
  sensitivity: 140,
  releaseDelay: 120,
}

/** 视为"同一目标"的容差（px），避免 scroll 事件触发的重复跟随写入重启动画。 */
const SAME_TARGET_TOLERANCE = 1
/** 弹簧 / 拉伸收敛阈值（px）。 */
const REST_EPSILON = 0.05

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

  /** 逻辑位置：getter 向读取方报告的值（动画中提前到达目标）。 */
  private reportedTop = 0
  /** 自动跟随动画状态。 */
  private animating = false
  private animStart = 0
  private animTarget = 0
  private animStartTime = 0
  /** 当前动画时长（自适应：大距离平滑、小距离近乎瞬时）。 */
  private animDuration = 0
  /** 边缘回弹状态。 */
  private bounceOffset = 0
  private bounceVelocity = 0
  private stretch = 0
  private bounceDirection = 0
  private lastWheelAt = 0
  private bounceTarget: HTMLElement | null = null
  /** rAF 调度：非 0 表示有未决帧。 */
  private frameId = 0
  private disposed = false
  private reducedMotion = false

  /** 滚轮：用户手动滚动 → 打断动画；仅当手势直达容器边缘且未被子滚动框消费时累积回弹拉伸。 */
  private readonly onWheel = (event: WheelEvent): void => {
    this.cancelAnimation()
    if (this.bounce === null || this.disposed || this.reducedMotion
      || event.defaultPrevented || event.deltaY === 0) return
    // 事件来自容器内部的滚动元素（消息详情、代码块等）时保持原生滚动，
    // 不触发页面级回弹。
    if (this.eventConsumedByChildScroll(event)) return
    // 容器内无回弹目标（如 trajectory 视图）时忽略。
    if (this.resolveBounceTarget() === null) return
    const real = this.nativeGet()
    const floor = Math.max(0, this.element.scrollHeight - this.element.clientHeight)
    const atTop = real <= 0
    const atBottom = floor - real <= 1
    const pushingOut = (event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)
    if (!pushingOut) {
      this.release()
      return
    }
    this.lastWheelAt = performance.now()
    // 顶边缘：内容向下拉（+y）；底边缘：内容向上拉（-y）。
    this.bounceDirection = event.deltaY < 0 ? 1 : -1
    const delta = Math.abs(event.deltaY)
    this.stretch = Math.min(1, this.stretch + Math.min(1, delta / this.bounce.sensitivity))
    this.ensureFrame()
  }

  /** 目标与容器之间是否存在能在滚动方向上继续滚动的子滚动元素。 */
  private eventConsumedByChildScroll(event: WheelEvent): boolean {
    const target = event.target instanceof Element ? event.target : null
    if (target === null || !this.element.contains(target)) return false
    let el: Element | null = target
    while (el !== null && el !== this.element) {
      if (el.scrollHeight > el.clientHeight) {
        const style = getComputedStyle(el)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          if (event.deltaY < 0 && el.scrollTop > 0) return true
          const floor = el.scrollHeight - el.clientHeight
          if (event.deltaY > 0 && el.scrollTop < floor - 1) return true
        }
      }
      el = el.parentElement
    }
    return false
  }

  /** 触摸开始：用户接管滚动，打断动画并清掉残留拉伸。 */
  private readonly onTouchStart = (): void => {
    this.cancelAnimation()
    this.release()
  }

  /** 点击：非滚动交互（展开消息等），清掉残留拉伸避免重排时误显位移。 */
  private readonly onClick = (): void => {
    this.release()
  }

  /** 按下（滚动条拖动、键盘滚动、触摸板点击等）：用户接管，打断动画。 */
  private readonly onPointerDown = (): void => {
    this.cancelAnimation()
    this.release()
  }

  /** 键盘滚动（PageUp/PageDown/方向键等）：用户接管，打断动画。 */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown'
      || event.key === 'PageUp' || event.key === 'PageDown'
      || event.key === 'Home' || event.key === 'End'
      || event.key === ' ') {
      this.cancelAnimation()
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
    if (options.follow !== undefined) this.follow = options.follow
    if (options.bounce !== undefined) this.bounce = options.bounce
    if (this.follow === null) this.cancelAnimation()
    if (this.bounce === null) {
      this.release()
      this.resetBounceTransform()
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
      // 动画中向读取方报告目标（ChatView 账本一致）；非动画直接读原生
      // 真实值，浏览器原生滚动（滚轮 / 滚动条）不经 setter 也能立刻同步。
      get: () => this.animating ? this.reportedTop : this.nativeGet(),
      set: (value: number) => { this.onScrollTopWrite(value) },
    })
    this.element.addEventListener('wheel', this.onWheel, { capture: true, passive: true })
    this.element.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true })
    this.element.addEventListener('mousedown', this.onPointerDown, { capture: true, passive: true })
    this.element.addEventListener('keydown', this.onKeyDown, { capture: true, passive: true })
    this.element.addEventListener('click', this.onClick, { capture: true, passive: true })
    this.syncReducedMotion()
    const media = this.reducedMotionMedia()
    media?.addEventListener('change', this.onReducedMotionChange)
    return this
  }

  /** 卸载：还原原生 scrollTop、移除监听、取消动画与残留 transform。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelAnimation()
    this.release()
    delete (this.element as unknown as Record<string, unknown>).scrollTop
    this.element.removeEventListener('wheel', this.onWheel, { capture: true })
    this.element.removeEventListener('touchstart', this.onTouchStart, { capture: true })
    this.element.removeEventListener('mousedown', this.onPointerDown, { capture: true })
    this.element.removeEventListener('keydown', this.onKeyDown, { capture: true })
    this.element.removeEventListener('click', this.onClick, { capture: true })
    this.reducedMotionMedia()?.removeEventListener('change', this.onReducedMotionChange)
    this.resetBounceTransform()
  }

  /** 逻辑位置（测试 / 调试读取）。 */
  get reported(): number {
    return this.reportedTop
  }

  /** 是否正在执行自动跟随动画。 */
  get following(): boolean {
    return this.animating
  }

  /** 当前回弹位移（px）。 */
  get bounceShift(): number {
    return this.bounceOffset
  }

  private onScrollTopWrite(value: number): void {
    const floor = Math.max(0, this.element.scrollHeight - this.element.clientHeight)
    const real = this.nativeGet()
    const isFollowWrite = this.follow !== null
      && !this.reducedMotion
      && Math.abs(value - this.element.scrollHeight) <= SAME_TARGET_TOLERANCE
      && floor - real > SAME_TARGET_TOLERANCE
    if (isFollowWrite) {
      if (this.animating && Math.abs(this.animTarget - floor) <= SAME_TARGET_TOLERANCE) {
        // 同一目标：scroll 事件引发的重复跟随写入是 no-op，动画继续。
        this.reportedTop = floor
        return
      }
      this.startFollowAnimation(floor)
      return
    }
    this.cancelAnimation()
    this.nativeSet(value)
    this.reportedTop = this.nativeGet()
  }

  private startFollowAnimation(target: number): void {
    this.animating = true
    this.animStart = this.nativeGet()
    this.animTarget = target
    // 自适应时长：小增量（流式逐字增长）近乎瞬时，大距离（回到底部）平滑。
    const maxDuration = Math.max(1, this.follow?.duration ?? 1)
    const distance = Math.abs(target - this.animStart)
    this.animDuration = Math.max(16, Math.min(maxDuration, maxDuration * (distance / 200)))
    this.animStartTime = performance.now()
    // 立即向读取方报告目标：ChatView 的 observedTop 账本同步，回底按钮不闪。
    this.reportedTop = target
    this.ensureFrame()
  }

  private cancelAnimation(): void {
    if (!this.animating) return
    this.animating = false
    this.reportedTop = this.nativeGet()
    this.applyStatusCompensation()
  }

  /** 释放回弹：清空拉伸累积，弹簧把位移带回 0。 */
  private release(): void {
    this.stretch = 0
    this.bounceDirection = 0
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
    if (this.reducedMotion) {
      this.cancelAnimation()
      this.release()
    }
  }

  /** 惰性解析回弹目标：视图切换（chat ↔ trajectory）后下次滚轮重新查找。 */
  private resolveBounceTarget(): HTMLElement | null {
    if (this.bounceTarget !== null && this.bounceTarget.isConnected) return this.bounceTarget
    this.bounceTarget = this.element.querySelector<HTMLElement>(this.bounceSelector)
    return this.bounceTarget
  }

  /**
   * 回弹时保持固定的"现场状态"元素：列尾的 Deep diving（role=status）
   * 与待插话消息（data-pending-steering）。它们是 data-chat-flow 的直接
   * 子元素；消息内部的状态（如重试提示）在消息节点后代里，不在此列。
   */
  private fixedStatusElements(flow: HTMLElement): HTMLElement[] {
    const result: HTMLElement[] = []
    for (const child of flow.children) {
      if (child instanceof HTMLElement && child.matches('[role="status"], [data-pending-steering]')) {
        result.push(child)
      }
    }
    return result
  }

  private applyBounce(): void {
    const target = this.resolveBounceTarget()
    if (target === null) return
    const offset = Math.abs(this.bounceOffset) > REST_EPSILON
      ? this.bounceOffset
      : 0
    target.style.transform = offset === 0 ? '' : `translateY(${offset.toFixed(2)}px)`
    target.style.willChange = offset === 0 ? '' : 'transform'
    this.applyStatusCompensation()
  }

  /**
   * 状态行（Deep diving / 待插话消息）保持固定的补偿：自动跟随动画期间
   * 抵消未走完的滚动位移（translateY(real - target)），回弹期间抵消列的
   * 拉伸（translateY(-bounceOffset)）。两者互斥，可简单叠加。
   */
  private applyStatusCompensation(): void {
    const target = this.resolveBounceTarget()
    if (target === null) return
    const followShift = this.animating
      ? this.nativeGet() - this.animTarget
      : 0
    const bounceShift = Math.abs(this.bounceOffset) > REST_EPSILON
      ? -this.bounceOffset
      : 0
    const offset = followShift + bounceShift
    const transform = Math.abs(offset) > REST_EPSILON
      ? `translateY(${offset.toFixed(2)}px)`
      : ''
    for (const el of this.fixedStatusElements(target)) {
      el.style.transform = transform
      el.style.willChange = transform === '' ? '' : 'transform'
    }
  }

  private resetBounceTransform(): void {
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

    // 1) 自动跟随动画：真实位置向目标缓动。
    if (this.animating) {
      const duration = Math.max(1, this.animDuration)
      const t = (now - this.animStartTime) / duration
      if (t >= 1) {
        this.nativeSet(this.animTarget)
        this.animating = false
        this.reportedTop = this.nativeGet()
      } else {
        const value = this.animStart + (this.animTarget - this.animStart) * easeOutCubic(t)
        this.nativeSet(value)
        active = true
      }
      // 状态行在动画期间钉在最终位置，避免大幅滚动时跟着漂移。
      this.applyStatusCompensation()
    }

    // 2) 边缘回弹：有内容目标时才推进（拉动跟手 + 松手弹簧回中）。
    if (this.bounce !== null && this.resolveBounceTarget() !== null) {
      const idleMs = now - this.lastWheelAt
      if (idleMs > this.bounce.releaseDelay && this.stretch !== 0) {
        // 松手：拉伸按指数衰减，位移由弹簧带回。
        this.stretch *= Math.exp(-6 * Math.min(1, idleMs / 1000))
        if (this.stretch < 0.01) this.release()
      }
      const targetOffset = this.bounceDirection * this.stretch * this.bounce.amplitude
      const dt = 0.016
      if (Math.abs(targetOffset) > 0.5) {
        // 拉动阶段：跟手逼近目标，不积累弹簧速度。
        this.bounceOffset += (targetOffset - this.bounceOffset)
          * Math.min(1, this.bounce.pullRate * dt)
        this.bounceVelocity = 0
      } else {
        // 释放阶段：弹簧把位移带回 0（小幅过冲）。
        this.bounceVelocity += -this.bounceOffset * this.bounce.stiffness * dt
        this.bounceVelocity *= Math.exp(-this.bounce.damping * dt)
        this.bounceOffset += this.bounceVelocity * dt
      }
      const settled = Math.abs(this.bounceOffset) <= REST_EPSILON
        && Math.abs(this.bounceVelocity) <= REST_EPSILON
        && Math.abs(targetOffset) <= REST_EPSILON
      if (settled) {
        this.bounceOffset = 0
        this.bounceVelocity = 0
      } else {
        active = true
      }
      this.applyBounce()
    }

    if (active) this.ensureFrame()
  }
}

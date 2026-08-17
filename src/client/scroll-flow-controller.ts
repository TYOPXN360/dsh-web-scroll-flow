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
 */

/** 回弹的橡皮筋状态机参数。 */
export interface BounceOptions {
  /**
   * 软增益参考距离（px）：拉动越远，单位滚轮输入产生的位移越小
   * （增益 = 1/(1+|offset|/amplitude)），但是无硬上限——只要一直滚，
   * 内容就一直跟手；松手后弹簧回中。默�达 24。
   */
  amplitude: number
  /** 释放阶段弹簧刚度（1/s²）。默认 160。 */
  stiffness: number
  /** 释放阶段弹簧阻尼（1/s）。默认 12。 */
  damping: number
  /** 滚轮灵敏度：多少 deltaY 折算成一次 amplitude 的拉动。默认 140。 */
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
const DEFAULT_BOUNCE: BounceOptions = {
  amplitude: 24,
  stiffness: 160,
  damping: 12,
  sensitivity: 140,
  releaseDelay: 120,
}

/** 视为"同一目标"的容差（px），避免 scroll 事件触发的重复跟随写入重启动画。 */
const SAME_TARGET_TOLERANCE = 1
/** 弹簧 / 拉伸收敛阈值（px）。 */
const REST_EPSILON = 0.05
/** 贴底小增量 vs 大距离跳转的分界（px）。 */
const ENTRY_FOLLOW_DISTANCE = 48
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
  /** 边缘回弹状态：跟手位移（px，顶边缘为正/向下拉，底边缘为负/向上拉）。 */
  private bounceOffset = 0
  private bounceVelocity = 0
  private releasing = false
  private lastWheelAt = 0
  private bounceFrameAt = 0
  private bounceTarget: HTMLElement | null = null
  /** flow 高度监视：检测内容收回（高度减小）时清位移，避免与浏览器 clamp 叠加成"撞墙回弹"。 */
  private flowObserver: ResizeObserver | null = null
  private lastFlowHeight = 0
  /** rAF 调度：非 0 表示有未决帧。 */
  private frameId = 0
  private disposed = false
  private reducedMotion = false

  /** 滚轮：用户手动滚动 → 打断动画；边缘继续向外滚时跟手拉动（无上限），
   *  滚轮停止 releaseDelay 后松手释放弹簧回中。 */
  private readonly onWheel = (event: WheelEvent): void => {
    this.cancelAnimation()
    this.cancelEntry()
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
      // 正常滚动方向：立即进入释放，让残留的橡皮筋平滑回中。
      this.beginRelease()
      return
    }
    // 边缘越界时阻止滚动链继续滚动外层页面；正常滚动仍保持原生行为。
    if (event.cancelable) event.preventDefault()
    this.lastWheelAt = performance.now()
    // 顶边缘：内容向下拉（+y）；底边缘：内容向上拉（-y）。
    const direction = event.deltaY < 0 ? 1 : -1
    // 跟手累积：软增益递减，无硬上限（一直滚就一直拉）。
    const unit = Math.abs(event.deltaY) / this.bounce.sensitivity * this.bounce.amplitude
    const gain = 1 / (1 + Math.abs(this.bounceOffset) / Math.max(1, this.bounce.amplitude))
    this.bounceOffset += direction * unit * gain
    this.bounceVelocity = 0
    this.bounceFrameAt = performance.now()
    this.releasing = false
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
    this.cancelAll()
  }

  /** 点击：非滚动交互（展开消息等），清掉残留位移避免重排时误显。 */
  private readonly onClick = (): void => {
    this.cancelAll()
  }

  /** 按下（滚动条拖动、触摸板点击等）：用户接管，打断动画。 */
  private readonly onPointerDown = (): void => {
    this.cancelAll()
  }

  /** 键盘滚动（PageUp/PageDown/方向键等）：用户接管，打断动画。 */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown'
      || event.key === 'PageUp' || event.key === 'PageDown'
      || event.key === 'Home' || event.key === 'End'
      || event.key === ' ') {
      this.cancelAll()
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
      this.cancelAnimation()
      this.cancelEntry()
    }
    if (this.bounce === null) {
      this.resetBounce()
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
        this.cancelAnimation()
        this.cancelEntry()
        this.resetBounce()
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
    this.cancelAll()
    this.flowObserver?.disconnect()
    this.flowObserver = null
    delete (this.element as unknown as Record<string, unknown>).scrollTop
    this.element.removeEventListener('wheel', this.onWheel, { capture: true })
    this.element.removeEventListener('touchstart', this.onTouchStart, { capture: true })
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
      this.cancelAll()
      this.nativeSet(value)
      this.reportedTop = this.nativeGet()
      return
    }
    const distance = floor - real
    if (distance > ENTRY_FOLLOW_DISTANCE) {
      // 大距离跳转（点击"回到底部"）：平滑滚动动画。
      this.cancelEntry()
      this.startFollowAnimation(floor)
      return
    }
    // 贴底跟随（流式增量 / 自动换行 / 展开思维链）：瞬时落到新底部，
    // 再播放整列入场推升，避免滚动条动画在高频流式下震动。
    this.cancelAnimation()
    this.nativeSet(value)
    this.startEntryPush()
  }

  private startFollowAnimation(target: number): void {
    this.animating = true
    this.animStart = this.nativeGet()
    this.animTarget = target
    // 自适应时长：距离满 200px 用满配置值。
    const maxDuration = Math.max(1, this.follow?.duration ?? 1)
    const distance = Math.abs(target - this.animStart)
    this.animDuration = Math.max(16, Math.min(maxDuration, maxDuration * (distance / 200)))
    this.animStartTime = performance.now()
    // 立即向读取方报告目标：ChatView 的 observedTop 账本同步，回底按钮不闪。
    this.reportedTop = target
    this.ensureFrame()
  }

  /** 贴底入场推升：整列先下压 ENTRY_PUSH_PX，再平滑回位（ChatAnimation 式）。 */
  private startEntryPush(): void {
    if (this.resolveBounceTarget() === null || this.follow === null) return
    // 打字机恢复布局等非流式高度突变期间抑制入场，避免"打完字回弹"。
    if (performance.now() < this.suppressEntryUntil) return
    const now = performance.now()
    // 流式逐 token 时高频到达：已有动画在播就不重启，避免连续下压抖动。
    if (this.entryActive && now - this.lastEntryStartAt < ENTRY_MIN_INTERVAL) return
    this.entryActive = true
    this.entryPush = ENTRY_PUSH_PX
    this.entryDuration = Math.max(16, this.follow.duration)
    this.entryStartTime = now
    this.lastEntryStartAt = now
    this.ensureFrame()
  }

  private cancelAnimation(): void {
    if (!this.animating) return
    this.animating = false
    this.reportedTop = this.nativeGet()
  }

  private cancelEntry(): void {
    if (!this.entryActive) return
    this.entryActive = false
    this.entryOffset = 0
    this.applyFlowTransform()
  }

  /** 用户输入 / 关闭设置：取消全部动画并清理位移。 */
  private cancelAll(): void {
    this.cancelAnimation()
    this.cancelEntry()
    this.resetBounce()
  }

  /** 清除回弹状态（触控 / 关闭设置等用户操作，瞬时清干净）。 */
  private resetBounce(): void {
    this.bounceOffset = 0
    this.bounceVelocity = 0
    this.releasing = false
    this.bounceFrameAt = 0
    this.applyFlowTransform()
  }

  /** 松手释放：进入弹簧回中模式（offset 保留不回零，弹簧带回）。 */
  private beginRelease(): void {
    if (Math.abs(this.bounceOffset) <= REST_EPSILON) {
      this.resetBounce()
      return
    }
    this.releasing = true
    this.bounceVelocity = 0
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
    if (this.reducedMotion) this.cancelAll()
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
    const followShift = this.animating
      ? this.nativeGet() - this.animTarget
      : 0
    const counterOffset = -offset + followShift
    const counter = Math.abs(counterOffset) > REST_EPSILON
      ? `translateY(${counterOffset.toFixed(2)}px)`
      : ''
    for (const el of this.fixedStatusElements(target)) {
      el.style.transform = counter
      el.style.willChange = counter === '' ? '' : 'transform'
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
        const dt = this.bounceFrameAt === 0
          ? 0.016
          : clamp((now - this.bounceFrameAt) / 1_000, 0.001, 0.05)
        this.bounceFrameAt = now
        this.bounceVelocity += -this.bounceOffset * this.bounce.stiffness * dt
        this.bounceVelocity *= Math.exp(-this.bounce.damping * dt)
        this.bounceOffset += this.bounceVelocity * dt
        const settled = Math.abs(this.bounceOffset) <= REST_EPSILON
          && Math.abs(this.bounceVelocity) <= REST_EPSILON
        if (settled) {
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

    this.applyFlowTransform()
    if (active) this.ensureFrame()
  }
}

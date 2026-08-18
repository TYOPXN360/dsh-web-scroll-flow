window.__ModuleLoader__.load({
	id: "dsh-web-scroll-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		let react = require("react");
		//#region src/client/debug-log.ts
		const MAX_ENTRIES = 5e3;
		const entries = [];
		let consoleEnabled = false;
		try {
			consoleEnabled = typeof localStorage !== "undefined" && (localStorage.getItem("dsh-web-scroll-flow.debug") === "1" || typeof location !== "undefined" && location.search.includes("dsh-debug"));
		} catch {
			consoleEnabled = false;
		}
		/** 记录一条调试日志（始终入缓冲；console 输出受开关控制）。 */
		function debugLog(tag, msg, data) {
			const entry = {
				t: performance.now(),
				ts: Date.now(),
				tag,
				msg,
				...data ?? {}
			};
			entries.push(entry);
			if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
			if (consoleEnabled) console.debug(`[dsh-scroll-flow:${tag}] ${msg}`, data ?? "");
		}
		/** 取出全部缓冲条目（拷贝，避免调用方修改内部缓冲）。 */
		function debugDump() {
			return entries.slice();
		}
		/** 清空缓冲（排查新一轮问题时先清空，再等事件发生）。 */
		function debugClear() {
			entries.length = 0;
		}
		/** 在 window 上挂载全局读取接口（index.ts 调用一次）。 */
		function mountDebugGlobal() {
			if (typeof window === "undefined") return;
			const g = window;
			if (g.__dshScrollFlowDebug !== void 0) return;
			g.__dshScrollFlowDebug = {
				dump: debugDump,
				clear: debugClear,
				enabled: consoleEnabled
			};
		}
		//#endregion
		//#region src/client/scroll-flow-controller.ts
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
		const DEFAULT_FOLLOW = { duration: 200 };
		/** 减弱后的回弹：拉动更短（sensitivity 更高 + amplitude 更小）、回弹更软更快收敛。 */
		const DEFAULT_BOUNCE = {
			amplitude: 16,
			stiffness: 110,
			damping: 14,
			sensitivity: 220,
			releaseDelay: 120
		};
		/** 视为"同一目标"的容差（px），避免 scroll 事件触发的重复跟随写入重启动画。 */
		const SAME_TARGET_TOLERANCE = 1;
		/** 弹簧 / 拉伸收敛阈值（px）。 */
		const REST_EPSILON = .05;
		/** 贴底小增量 vs 大距离跳转的分界（px）。 */
		const ENTRY_FOLLOW_DISTANCE = 48;
		/** 待插话消息导致的增长上限（px）：超过视为普通大距离（回底/其它增长），
		* 只有贴近该值的增长走"瞬时 + 状态行补偿"路径。 */
		const PENDING_MAX_DISTANCE = 500;
		/** 入场推升的最大下压位移（px）。 */
		const ENTRY_PUSH_PX = 28;
		/** 连续入场动画的最小间隔（ms），流式逐 token 时避免高频重启动画。 */
		const ENTRY_MIN_INTERVAL = 120;
		/** 捕获容器元素类型的原生 `scrollTop` 访问器（原型链，含 jsdom 兼容回退）。 */
		function nativeScrollTopDescriptor() {
			return Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop") ?? Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
		}
		/** 缓动：easeOutCubic，先快后慢的自然收尾。 */
		function easeOutCubic(t) {
			return 1 - (1 - t) ** 3;
		}
		function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}
		/**
		* 一个对话滚动容器的滚动动效控制器。构造后调用 {@link attach} 生效，
		* {@link dispose} 完整还原（移除属性覆写、监听与残留 transform）。
		*/
		var ScrollFlowController = class {
			element;
			follow;
			bounce;
			bounceSelector;
			nativeGet;
			nativeSet;
			/** 大距离跳转时向读取方报告的逻辑位置（动画中提前到达目标）。 */
			reportedTop = 0;
			/** 大距离 scrollTop 缓动状态。 */
			animating = false;
			animStart = 0;
			animTarget = 0;
			animStartTime = 0;
			animDuration = 0;
			/** 贴底入场推升状态：整列先下压后平滑回位。 */
			entryActive = false;
			entryStartTime = 0;
			entryDuration = 0;
			entryPush = 0;
			lastEntryStartAt = 0;
			/** 当前入场推升位移（px，正 = 列向下压）。 */
			entryOffset = 0;
			/** 抑制入场推升的截止时间：布局恢复（打字结束）引起的高度突变不应被当新内容入场。 */
			suppressEntryUntil = 0;
			/** 打字机活动期截止时间：期间贴底跟随改用平滑滚动（每写完一行，上一行文字平滑上推）。 */
			smoothFollowUntil = 0;
			/** 本次 follow 动画被"不同目标"重载的次数（排障用）。 */
			followRestarts = 0;
			/** 本次入场推升被"重复触发"重载的次数（排障用）。 */
			entryRestarts = 0;
			/** 帧日志限频时间戳。 */
			lastFrameLogAt = 0;
			/** 状态行位置日志限频时间戳。 */
			lastStatusLogAt = 0;
			/** 边缘回弹状态：跟手位移（px，顶边缘为正/向下拉，底边缘为负/向上拉）。 */
			bounceOffset = 0;
			bounceVelocity = 0;
			releasing = false;
			/** 松手缓动归位状态（无弹簧振荡）。 */
			releaseStartOffset = 0;
			releaseStartTime = 0;
			releaseDuration = 120;
			lastWheelAt = 0;
			bounceFrameAt = 0;
			touchY = null;
			bounceTarget = null;
			/** flow 高度监视：检测内容收回（高度减小）时清位移，避免与浏览器 clamp 叠加成"撞墙回弹"。 */
			flowObserver = null;
			lastFlowHeight = 0;
			/** rAF 调度：非 0 表示有未决帧。 */
			frameId = 0;
			disposed = false;
			reducedMotion = false;
			/** 滚轮：用户手动滚动 → 打断动画；边缘继续向外滚时跟手拉动。 */
			onWheel = (event) => {
				this.cancelAnimation("wheel");
				this.cancelEntry("wheel");
				this.applyEdgePull(event.deltaY, event);
			};
			applyEdgePull(deltaY, event) {
				if (this.bounce === null || this.disposed || this.reducedMotion || event.defaultPrevented || deltaY === 0) return;
				if (this.eventConsumedByChildScroll(event, deltaY)) return;
				if (this.resolveBounceTarget() === null) return;
				const real = this.nativeGet();
				const floor = Math.max(0, this.element.scrollHeight - this.element.clientHeight);
				const atTop = real <= 0;
				const atBottom = floor - real <= 1;
				if (!(deltaY < 0 && atTop || deltaY > 0 && atBottom)) {
					this.beginRelease();
					return;
				}
				if (event.cancelable) event.preventDefault();
				this.lastWheelAt = performance.now();
				const direction = deltaY < 0 ? 1 : -1;
				const unit = Math.abs(deltaY) / this.bounce.sensitivity * this.bounce.amplitude;
				const gain = 1 / (1 + Math.abs(this.bounceOffset) / Math.max(1, this.bounce.amplitude));
				this.bounceOffset += direction * unit * gain;
				this.bounceVelocity = 0;
				this.bounceFrameAt = performance.now();
				this.releasing = false;
				this.ensureFrame();
			}
			/** 目标与容器之间是否存在能在滚动方向上继续滚动的子滚动元素。 */
			eventConsumedByChildScroll(event, deltaY) {
				const target = event.target instanceof Element ? event.target : null;
				if (target === null || !this.element.contains(target)) return false;
				let el = target;
				while (el !== null && el !== this.element) {
					if (el.scrollHeight > el.clientHeight) {
						const style = getComputedStyle(el);
						if (style.overflowY === "auto" || style.overflowY === "scroll") {
							if (deltaY < 0 && el.scrollTop > 0) return true;
							const floor = el.scrollHeight - el.clientHeight;
							if (deltaY > 0 && el.scrollTop < floor - 1) return true;
						}
					}
					el = el.parentElement;
				}
				return false;
			}
			/** 触摸开始：记录手指位置，后续只在边缘越界时接管。 */
			onTouchStart = (event) => {
				this.cancelAll("touch");
				this.touchY = event.touches[0]?.clientY ?? null;
			};
			onTouchMove = (event) => {
				const currentY = event.touches[0]?.clientY;
				if (this.touchY === null || currentY === void 0) return;
				const deltaY = this.touchY - currentY;
				this.touchY = currentY;
				this.cancelAnimation("touch");
				this.cancelEntry("touch");
				this.applyEdgePull(deltaY, event);
			};
			onTouchEnd = () => {
				this.touchY = null;
				this.beginRelease();
			};
			/** 点击：非滚动交互（展开消息等），清掉残留位移避免重排时误显。 */
			onClick = () => {
				this.cancelAll("click");
			};
			/** 按下（滚动条拖动、触摸板点击等）：用户接管，打断动画。 */
			onPointerDown = () => {
				this.cancelAll("pointer");
			};
			/** 键盘滚动（PageUp/PageDown/方向键等）：用户接管，打断动画。 */
			onKeyDown = (event) => {
				if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End" || event.key === " ") this.cancelAll("key");
			};
			constructor(element, options = {}) {
				this.element = element;
				this.follow = options.follow === void 0 ? DEFAULT_FOLLOW : options.follow;
				this.bounce = options.bounce === void 0 ? DEFAULT_BOUNCE : options.bounce;
				this.bounceSelector = options.bounceTargetSelector ?? "[data-chat-flow]";
				const descriptor = nativeScrollTopDescriptor();
				if (descriptor === void 0 || typeof descriptor.get !== "function" || typeof descriptor.set !== "function") throw new Error("ScrollFlowController: 当前环境缺少原生 scrollTop 访问器");
				this.nativeGet = () => descriptor.get.call(element);
				this.nativeSet = (value) => {
					descriptor.set.call(element, value);
				};
				this.reportedTop = this.nativeGet();
			}
			/**
			* 运行时更新动效配置（设置面板切换动画档位 / 弹簧开关）。
			* 关闭某项时立即取消对应动画并清理残留状态。
			* @param options - 新配置；未提供的字段保持当前值。
			*/
			setOptions(options) {
				if ("follow" in options) this.follow = options.follow === void 0 ? DEFAULT_FOLLOW : options.follow;
				if ("bounce" in options) this.bounce = options.bounce === void 0 ? DEFAULT_BOUNCE : options.bounce;
				if (this.follow === null) {
					this.cancelAnimation("settings");
					this.cancelEntry("settings");
				}
				if (this.bounce === null) {
					this.resetBounce("settings");
					this.applyFlowTransform();
				}
			}
			/** 是否处于减动效模式（prefers-reduced-motion）。 */
			get reducedMotionEnabled() {
				return this.reducedMotion;
			}
			/** 挂载：覆写 scrollTop、绑定监听、解析回弹目标。 */
			attach() {
				if (this.disposed) throw new Error("ScrollFlowController: 已销毁的控制器不能重新挂载");
				Object.defineProperty(this.element, "scrollTop", {
					configurable: true,
					enumerable: true,
					get: () => this.animating ? this.reportedTop : this.nativeGet(),
					set: (value) => {
						this.onScrollTopWrite(value);
					}
				});
				this.element.addEventListener("wheel", this.onWheel, {
					capture: true,
					passive: false
				});
				this.element.addEventListener("touchstart", this.onTouchStart, {
					capture: true,
					passive: true
				});
				this.element.addEventListener("touchmove", this.onTouchMove, {
					capture: true,
					passive: false
				});
				this.element.addEventListener("touchend", this.onTouchEnd, {
					capture: true,
					passive: true
				});
				this.element.addEventListener("touchcancel", this.onTouchEnd, {
					capture: true,
					passive: true
				});
				this.element.addEventListener("mousedown", this.onPointerDown, {
					capture: true,
					passive: true
				});
				this.element.addEventListener("keydown", this.onKeyDown, {
					capture: true,
					passive: true
				});
				this.element.addEventListener("click", this.onClick, {
					capture: true,
					passive: true
				});
				this.observeFlowHeight();
				this.syncReducedMotion();
				this.reducedMotionMedia()?.addEventListener("change", this.onReducedMotionChange);
				return this;
			}
			/**
			* 观察内容列高度：工具 / 消息收回（高度减小）时立即取消入场与回弹，
			* 清掉应用中的 transform，避免与浏览器 clamp 叠加出"撞墙回弹"。
			*/
			observeFlowHeight() {
				if (typeof ResizeObserver === "undefined") return;
				const flow = this.resolveBounceTarget();
				if (flow === null) return;
				this.lastFlowHeight = flow.offsetHeight;
				this.flowObserver = new ResizeObserver(() => {
					if (flow.offsetHeight < this.lastFlowHeight) {
						this.cancelAnimation("height-shrink");
						this.cancelEntry("height-shrink");
						this.resetBounce("height-shrink");
						this.resetFlowTransform();
					}
					this.lastFlowHeight = flow.offsetHeight;
				});
				this.flowObserver.observe(flow);
			}
			/** 卸载：还原原生 scrollTop、移除监听、取消动画与残留 transform。 */
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.cancelAll("dispose");
				this.flowObserver?.disconnect();
				this.flowObserver = null;
				delete this.element.scrollTop;
				this.element.removeEventListener("wheel", this.onWheel, { capture: true });
				this.element.removeEventListener("touchstart", this.onTouchStart, { capture: true });
				this.element.removeEventListener("touchmove", this.onTouchMove, { capture: true });
				this.element.removeEventListener("touchend", this.onTouchEnd, { capture: true });
				this.element.removeEventListener("touchcancel", this.onTouchEnd, { capture: true });
				this.element.removeEventListener("mousedown", this.onPointerDown, { capture: true });
				this.element.removeEventListener("keydown", this.onKeyDown, { capture: true });
				this.element.removeEventListener("click", this.onClick, { capture: true });
				this.reducedMotionMedia()?.removeEventListener("change", this.onReducedMotionChange);
				this.resetFlowTransform();
			}
			/** 逻辑位置（测试 / 调试读取）。 */
			get reported() {
				return this.reportedTop;
			}
			/** 是否正在执行大距离 scrollTop 动画。 */
			get following() {
				return this.animating;
			}
			/** 是否正在执行贴底入场推升动画。 */
			get entering() {
				return this.entryActive;
			}
			/** 在指定时长内抑制贴底入场推升（打字机恢复布局等非流式高度突变）。 */
			suppressEntryFor(durationMs) {
				this.suppressEntryUntil = performance.now() + durationMs;
				this.cancelEntry("suppress");
			}
			/**
			* 在指定时长内，贴底跟随写入改用平滑滚动（打字机每写完一行，上一行
			* 文字平滑上推，而不是瞬时跳变 / 下压回弹）。由 index.ts 在打字机
			* 内容增长时调用。
			*/
			smoothFollowFor(durationMs) {
				this.smoothFollowUntil = performance.now() + durationMs;
				debugLog("anim", "smooth-follow:arm", {
					durationMs,
					until: Math.round(this.smoothFollowUntil)
				});
			}
			/** 当前回弹位移（px）。 */
			get bounceShift() {
				return this.bounceOffset;
			}
			/** 当前入场推升位移（px）。 */
			get entryShift() {
				return this.entryOffset;
			}
			onScrollTopWrite(value) {
				const floor = Math.max(0, this.element.scrollHeight - this.element.clientHeight);
				const real = this.nativeGet();
				if (!(this.follow !== null && !this.reducedMotion && Math.abs(value - this.element.scrollHeight) <= SAME_TARGET_TOLERANCE)) {
					debugLog("scroll", "write:pass-through", {
						value: Math.round(value),
						real: Math.round(real),
						floor: Math.round(floor),
						scrollHeight: this.element.scrollHeight
					});
					this.cancelAll("pass-through");
					this.nativeSet(value);
					this.reportedTop = this.nativeGet();
					return;
				}
				const distance = floor - real;
				const smoothing = performance.now() < this.smoothFollowUntil;
				const pendingGrowth = this.statusHasPendingAfter() && distance > 0 && distance <= PENDING_MAX_DISTANCE;
				if ((distance > ENTRY_FOLLOW_DISTANCE || smoothing) && pendingGrowth) {
					debugLog("scroll", "write:pending-instant", {
						distance: Math.round(distance),
						floor: Math.round(floor),
						real: Math.round(real),
						scrollHeight: this.element.scrollHeight
					});
					this.cancelAnimation("pending");
					this.cancelEntry("pending");
					this.nativeSet(value);
					this.applyFlowTransform();
					return;
				}
				if (distance > ENTRY_FOLLOW_DISTANCE || smoothing) {
					debugLog("scroll", "write:smooth-follow", {
						distance: Math.round(distance),
						floor: Math.round(floor),
						real: Math.round(real),
						scrollHeight: this.element.scrollHeight,
						smoothing
					});
					this.cancelEntry("follow");
					this.startFollowAnimation(floor);
					return;
				}
				if (this.animating) {
					debugLog("scroll", "write:entry-push-animating", {
						distance: Math.round(distance),
						real: Math.round(real),
						floor: Math.round(floor)
					});
					this.startFollowAnimation(floor);
					return;
				}
				debugLog("scroll", "write:entry-push", {
					distance: Math.round(distance),
					floor: Math.round(floor),
					real: Math.round(real),
					scrollHeight: this.element.scrollHeight
				});
				this.nativeSet(value);
				this.startEntryPush();
			}
			startFollowAnimation(target) {
				if (this.animating && Math.abs(target - this.animTarget) <= SAME_TARGET_TOLERANCE) {
					debugLog("anim", "follow:merge", {
						target: Math.round(target),
						from: Math.round(this.animStart)
					});
					return;
				}
				if (this.animating) {
					this.followRestarts++;
					debugLog("anim", "follow:restart", {
						from: Math.round(this.nativeGet()),
						oldTarget: Math.round(this.animTarget),
						newTarget: Math.round(target),
						restarts: this.followRestarts
					});
				} else this.followRestarts = 0;
				this.animating = true;
				this.animStart = this.nativeGet();
				this.animTarget = target;
				const maxDuration = Math.max(1, this.follow?.duration ?? 1);
				const distance = Math.abs(target - this.animStart);
				const smoothing = performance.now() < this.smoothFollowUntil;
				this.animDuration = smoothing ? Math.min(maxDuration, Math.max(24, 160 * (distance / 48))) : Math.max(16, Math.min(maxDuration, maxDuration * (distance / 200)));
				this.animStartTime = performance.now();
				this.reportedTop = target;
				debugLog("anim", "follow:start", {
					from: Math.round(this.animStart),
					to: Math.round(target),
					distance: Math.round(distance),
					duration: Math.round(this.animDuration),
					smoothing,
					restarts: this.followRestarts
				});
				this.ensureFrame();
			}
			/** 贴底入场推升：整列先下压 ENTRY_PUSH_PX，再平滑回位（ChatAnimation 式）。 */
			startEntryPush() {
				if (this.resolveBounceTarget() === null || this.follow === null) return;
				const now = performance.now();
				if (now < this.suppressEntryUntil) {
					debugLog("scroll", "entry-push:suppressed", {
						until: Math.round(this.suppressEntryUntil),
						now: Math.round(now)
					});
					return;
				}
				if (this.entryActive && now - this.lastEntryStartAt < ENTRY_MIN_INTERVAL) {
					debugLog("scroll", "entry-push:throttled", {
						lastStart: Math.round(this.lastEntryStartAt),
						now: Math.round(now)
					});
					return;
				}
				if (this.entryActive) {
					this.entryRestarts++;
					debugLog("anim", "entry:restart", {
						restarts: this.entryRestarts,
						sinceLast: Math.round(now - this.lastEntryStartAt)
					});
				} else this.entryRestarts = 0;
				debugLog("scroll", "entry-push:start", {
					push: ENTRY_PUSH_PX,
					duration: this.follow.duration
				});
				this.entryActive = true;
				this.entryPush = ENTRY_PUSH_PX;
				this.entryDuration = Math.max(16, this.follow.duration);
				this.entryStartTime = now;
				this.lastEntryStartAt = now;
				this.ensureFrame();
			}
			cancelAnimation(reason = "unknown") {
				if (!this.animating) return;
				debugLog("anim", "follow:cancel", {
					reason,
					at: Math.round(this.nativeGet()),
					target: Math.round(this.animTarget),
					restarts: this.followRestarts
				});
				this.animating = false;
				this.reportedTop = this.nativeGet();
			}
			cancelEntry(reason = "unknown") {
				if (!this.entryActive) return;
				debugLog("anim", "entry:cancel", {
					reason,
					offset: Math.round(this.entryOffset * 100) / 100,
					restarts: this.entryRestarts
				});
				this.entryActive = false;
				this.entryOffset = 0;
				this.applyFlowTransform();
			}
			/** 用户输入 / 关闭设置：取消全部动画并清理位移。 */
			cancelAll(reason = "unknown") {
				this.cancelAnimation(reason);
				this.cancelEntry(reason);
				this.resetBounce(reason);
			}
			/** 清除回弹状态（触控 / 关闭设置等用户操作，瞬时清干净）。 */
			resetBounce(reason = "unknown") {
				if (Math.abs(this.bounceOffset) > REST_EPSILON) debugLog("anim", "bounce:reset", {
					reason,
					offset: Math.round(this.bounceOffset * 100) / 100
				});
				this.bounceOffset = 0;
				this.bounceVelocity = 0;
				this.releasing = false;
				this.bounceFrameAt = 0;
				this.applyFlowTransform();
			}
			/** 松手释放：进入平滑缓动归位模式（offset 保留不回零，缓动带回；无振荡）。 */
			beginRelease() {
				if (Math.abs(this.bounceOffset) <= REST_EPSILON) {
					this.resetBounce("release-idle");
					return;
				}
				this.releasing = true;
				this.bounceVelocity = 0;
				const distance = Math.abs(this.bounceOffset);
				this.releaseStartOffset = this.bounceOffset;
				this.releaseStartTime = performance.now();
				this.releaseDuration = Math.max(80, Math.min(320, (this.bounce?.stiffness ?? 160) + distance * (this.bounce?.damping ?? 1.2)));
				debugLog("anim", "bounce:release-start", {
					offset: Math.round(this.bounceOffset * 100) / 100,
					duration: Math.round(this.releaseDuration)
				});
			}
			syncReducedMotion() {
				this.reducedMotion = this.reducedMotionMedia()?.matches ?? false;
			}
			/** 减动效媒体查询（缺失时返回 undefined，保持禁用姿态）。 */
			reducedMotionMedia() {
				return typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : void 0;
			}
			onReducedMotionChange = () => {
				this.syncReducedMotion();
				if (this.reducedMotion) this.cancelAll("reduced-motion");
			};
			/** 惰性解析内容列：视图切换（chat ↔ trajectory）后下次动画重新查找。 */
			resolveBounceTarget() {
				if (this.bounceTarget !== null && this.bounceTarget.isConnected) return this.bounceTarget;
				this.bounceTarget = this.element.querySelector(this.bounceSelector);
				return this.bounceTarget;
			}
			/**
			* 列尾的 Deep diving 与待插话行是 flow 的直接状态行；它们需要钉在
			* 视口中的原位置，避免跟随消息列的入场/回弹位移。嵌套的历史错误状态
			* 不参与补偿，避免改变普通消息的布局。
			*/
			fixedStatusElements(flow) {
				return Array.from(flow.children).filter((child) => child instanceof HTMLElement && child.matches("[role=\"status\"], [data-pending-steering]"));
			}
			pendingShiftBefore(status) {
				let shift = 0;
				let sibling = status.previousElementSibling;
				while (sibling !== null) {
					if (sibling instanceof HTMLElement && sibling.matches("[data-pending-steering]")) shift += sibling.getBoundingClientRect().height;
					sibling = sibling.previousElementSibling;
				}
				return shift;
			}
			/**
			* status 后方是否存在待插话消息（data-pending-steering 出现在状态行之后）。
			* 存在时，待插话消息导致的贴底跟随会走"瞬时 + 状态行补偿"路径。
			*/
			statusHasPendingAfter() {
				const target = this.resolveBounceTarget();
				if (target === null) return false;
				const status = Array.from(target.children).find((child) => child instanceof HTMLElement && child.matches("[role=\"status\"]"));
				if (status === void 0) return false;
				let sibling = status.nextElementSibling;
				while (sibling !== null) {
					if (sibling instanceof HTMLElement && sibling.matches("[data-pending-steering]")) return true;
					sibling = sibling.nextElementSibling;
				}
				return false;
			}
			/**
			* status 后方的待插话消息总占位（含间距）。待插话消息渲染在 Deep diving
			* 状态行之后（flow 末尾），出现时 scrollHeight 增长、贴底跟随把视口往下
			* 推，状态行会被"顶上去"；贴底时用该值反向补偿，把状态行拉回原位。
			*/
			pendingShiftAfter(status) {
				let shift = 0;
				let prev = status;
				let sibling = status.nextElementSibling;
				while (sibling !== null) {
					if (sibling instanceof HTMLElement && sibling.matches("[data-pending-steering]")) {
						const gap = Math.max(0, sibling.offsetTop - prev.offsetTop - prev.offsetHeight);
						shift += sibling.offsetHeight + gap;
						prev = sibling;
					}
					sibling = sibling.nextElementSibling;
				}
				return shift;
			}
			/**
			* 统一渲染内容列位移：入场推升 + 回弹拉伸叠加到 transform；直接状态行
			* 用反向位移保持在原位置。
			*/
			applyFlowTransform() {
				const target = this.resolveBounceTarget();
				if (target === null) return;
				const offset = this.entryOffset + (Math.abs(this.bounceOffset) > REST_EPSILON ? this.bounceOffset : 0);
				const transform = Math.abs(offset) > REST_EPSILON ? `translateY(${offset.toFixed(2)}px)` : "";
				target.style.transform = transform;
				target.style.willChange = transform === "" ? "" : "transform";
				for (const el of this.fixedStatusElements(target)) {
					const isStatus = el.matches("[role=\"status\"]");
					const pendingShift = isStatus ? this.pendingShiftBefore(el) : 0;
					const atBottom = this.nativeGet() >= Math.max(0, this.element.scrollHeight - this.element.clientHeight) - 1;
					const afterShift = isStatus && atBottom ? this.pendingShiftAfter(el) : 0;
					const counterOffset = this.animating ? 0 : -offset - pendingShift + afterShift;
					const counter = Math.abs(counterOffset) > REST_EPSILON ? `translateY(${counterOffset.toFixed(2)}px)` : "";
					el.style.transform = counter;
					el.style.willChange = counter === "" ? "" : "transform";
					const statusNow = performance.now();
					if (statusNow - this.lastStatusLogAt > 120) {
						this.lastStatusLogAt = statusNow;
						debugLog("anim", "status-transform", {
							role: isStatus ? "status" : "pending",
							counterOffset: Math.round(counterOffset * 100) / 100,
							pendingShift: Math.round(pendingShift * 100) / 100,
							afterShift: Math.round(afterShift * 100) / 100,
							offset: Math.round(offset * 100) / 100,
							animating: this.animating,
							transform: counter
						});
					}
				}
			}
			resetFlowTransform() {
				const target = this.resolveBounceTarget();
				if (target === null) return;
				target.style.transform = "";
				target.style.willChange = "";
				for (const el of this.fixedStatusElements(target)) {
					el.style.transform = "";
					el.style.willChange = "";
				}
			}
			ensureFrame() {
				if (this.disposed || this.frameId !== 0) return;
				this.frameId = requestAnimationFrame(this.frameStep);
			}
			frameStep = () => {
				this.frameId = 0;
				if (this.disposed) return;
				const now = performance.now();
				let active = false;
				if (this.animating) {
					const duration = Math.max(1, this.animDuration);
					const t = (now - this.animStartTime) / duration;
					if (t >= 1) {
						this.nativeSet(this.animTarget);
						this.animating = false;
						this.reportedTop = this.nativeGet();
						debugLog("anim", "follow:complete", {
							duration: Math.round(now - this.animStartTime),
							restarts: this.followRestarts
						});
					} else {
						const value = this.animStart + (this.animTarget - this.animStart) * easeOutCubic(t);
						this.nativeSet(value);
						active = true;
					}
				}
				if (this.entryActive) {
					const t = clamp((now - this.entryStartTime) / Math.max(1, this.entryDuration), 0, 1);
					this.entryOffset = this.entryPush * (1 - easeOutCubic(t));
					if (t >= 1) {
						this.entryActive = false;
						this.entryOffset = 0;
						debugLog("anim", "entry:complete", {
							duration: Math.round(now - this.entryStartTime),
							restarts: this.entryRestarts
						});
					} else active = true;
				}
				if (this.bounce !== null && this.resolveBounceTarget() !== null) {
					if (now - this.lastWheelAt > this.bounce.releaseDelay && !this.releasing && Math.abs(this.bounceOffset) > REST_EPSILON) this.beginRelease();
					if (this.releasing) {
						const t = clamp((now - this.releaseStartTime) / Math.max(1, this.releaseDuration), 0, 1);
						this.bounceOffset = this.releaseStartOffset * (1 - easeOutCubic(t));
						if (t >= 1) {
							this.bounceOffset = 0;
							this.bounceVelocity = 0;
							this.releasing = false;
						} else active = true;
					} else if (Math.abs(this.bounceOffset) > REST_EPSILON) active = true;
				}
				if (now - this.lastFrameLogAt > 30) {
					this.lastFrameLogAt = now;
					if (this.animating || this.entryActive || Math.abs(this.bounceOffset) > REST_EPSILON) debugLog("anim", "frame", {
						follow: this.animating ? Math.round(this.nativeGet()) : null,
						entry: this.entryActive ? Math.round(this.entryOffset * 100) / 100 : null,
						bounce: Math.abs(this.bounceOffset) > REST_EPSILON ? Math.round(this.bounceOffset * 100) / 100 : null
					});
				}
				this.applyFlowTransform();
				if (active) this.ensureFrame();
			};
		};
		//#endregion
		//#region src/client/typewriter.ts
		/**
		* TypewriterController — 为正在流式的助手消息（思维链 + 正文 Markdown）
		* 做逐字打字机动画。
		*
		* 实现边界：不改 DSH 的 React 渲染，只操作 DOM。
		* - MutationObserver 监听内容列文本增长；只有文本实际变化才启动对应
		*   Markdown 的打字机（历史 / 静态消息不会误打字；overlay 自身 mutation
		*   不触发重启）。
		* - 打字期间把目标 Markdown 设为 display:none（不占高度、不预留整段
		*   空白），用一个作为正常流元素的纯文本覆盖层占据已打文本的真实高度，
		*   逐字吐出 + 末尾闪烁光标；因此消息高度随打字增长，无"长白条"。
		* - 覆盖层继承目标 markdown 的字体 / 行高 / 颜色，位置一致。
		* - 文本总量大时按公式线性提速，确保非常大段也尽快打完。
		* - 文本停止增长超过阈值视为流式结束：恢复原始 Markdown，短暂保留光标。
		*
		* 调试：每个 markdown 的流式决策（启动 / 迁移 / 跳过）与打字机起点都写入
		* debugLog，`window.__dshScrollFlowDebug.dump()` 可导出完整时间线。
		*/
		/** 覆盖层用 class 标记，便于测试与清理。 */
		const TYPEWRITER_OVERLAY_CLASS = "dsh-scroll-flow-typewriter-overlay";
		const DEFAULT_OPTIONS = {
			baseSpeed: .06,
			settleDelay: 500,
			cursorHold: 900,
			loadGrace: 1200
		};
		const CURSOR_STYLE = {
			display: "inline-block",
			width: "2px",
			height: "1em",
			verticalAlign: "text-bottom",
			marginLeft: "1px",
			background: "currentColor",
			opacity: "0.85",
			animation: "dsh-typewriter-blink 1s steps(1) infinite"
		};
		const BLINK_KEYFRAMES = `
@keyframes dsh-typewriter-blink {
  50% { opacity: 0; }
}
`;
		/** 消息 Markdown 容器选择器：Markdown 渲染根（hash class 前缀不固定，按特征匹配）。 */
		const MARKDOWN_SELECTOR = "[class*=\"_markdown_\"], [data-dsh-markdown], .markdown";
		/** 思考链内容选择器（仅 running + 展开时）。 */
		const THINK_BODY_SELECTOR = "[data-variant=\"think\"][data-state=\"running\"] [class*=\"thinkBody\"]";
		/** 思考链摘要选择器（仅 running + 折叠时可见的文字行）。 */
		const THINK_SUMMARY_SELECTOR = "[data-variant=\"think\"][data-state=\"running\"] [class*=\"summary\"]";
		/** 组合内容选择器：主消息 Markdown + 思考链 body + 思考链摘要。 */
		const CONTENT_SELECTOR = `${MARKDOWN_SELECTOR}, ${THINK_BODY_SELECTOR}, ${THINK_SUMMARY_SELECTOR}`;
		/**
		* 一个内容列的打字机控制器。构造后 {@link attach} 生效，{@link dispose}
		* 完整清理。
		*/
		var TypewriterController = class {
			flow;
			options;
			/** 段落间保留的底部间距（px），复制自目标 markdown 的 p margin，打字与完成一致。 */
			observer = null;
			sessions = /* @__PURE__ */ new Map();
			/** attach 时已存在的 Markdown（历史消息），宽限期只保护这些。 */
			baselineMarkdowns = /* @__PURE__ */ new Set();
			/** 每个 Markdown 的最后可见文本：区分"流式增长"与"我们自己的 overlay mutation"。 */
			lastSeenByMarkdown = /* @__PURE__ */ new Map();
			/** 已完成消息的全文签名，防止 React 重建同一消息时重新播放。 */
			completedTargets = /* @__PURE__ */ new WeakMap();
			loadedAt = performance.now();
			disposed = false;
			constructor(flow, options = {}) {
				this.flow = flow;
				this.options = {
					...DEFAULT_OPTIONS,
					...options
				};
			}
			/** 当前所有活跃打字机已显示字符总数（测试 / 调试读取）。 */
			get shown() {
				let total = 0;
				for (const session of this.sessions.values()) total += session.shownChars;
				return total;
			}
			/** 当前所有活跃打字机目标文本总长（测试 / 调试读取）。 */
			get targetLength() {
				let total = 0;
				for (const session of this.sessions.values()) total += session.targetText.length;
				return total;
			}
			/** 是否处于流式打字状态。 */
			get active() {
				return this.sessions.size > 0;
			}
			attach() {
				if (this.disposed) throw new Error("TypewriterController: 已销毁的控制器不能重新挂载");
				this.ensureStyleTag();
				for (const markdown of this.markdowns()) {
					this.baselineMarkdowns.add(markdown);
					this.lastSeenByMarkdown.set(markdown, this.contentText(markdown));
				}
				this.observer = new MutationObserver(() => {
					this.onFlowChanged();
				});
				this.observer.observe(this.flow, {
					childList: true,
					subtree: true,
					characterData: true
				});
				return this;
			}
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.observer?.disconnect();
				this.observer = null;
				for (const session of this.sessions.values()) this.teardownSession(session);
				this.sessions.clear();
			}
			/** 手动推进所有打字机一帧（测试用；浏览器端由 interval 驱动）。 */
			tick(now = performance.now()) {
				for (const session of this.sessions.values()) this.emitStep(session, now);
			}
			markdowns() {
				return Array.from(this.flow.querySelectorAll(CONTENT_SELECTOR)).filter((el) => !el.classList.contains(TYPEWRITER_OVERLAY_CLASS));
			}
			textNodes(root) {
				const nodes = [];
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				let node = walker.nextNode();
				while (node !== null) {
					const text = node;
					if (text.parentElement?.closest("button,[data-copy],[aria-label*=\"copy\" i],[aria-label*=\"复制\"],[data-testid*=\"copy\" i],[class*=\"copy\" i]") === null) nodes.push(text);
					node = walker.nextNode();
				}
				return nodes;
			}
			contentText(markdown) {
				return this.textNodes(markdown).map((node) => node.data).join("");
			}
			textLengths(markdown) {
				return this.textNodes(markdown).map((node) => node.data.length);
			}
			onFlowChanged() {
				if (this.disposed) return;
				const markdowns = this.markdowns();
				const live = new Set(markdowns);
				const loading = performance.now() - this.loadedAt < this.options.loadGrace;
				const running = this.hasRunningTurn();
				for (const markdown of markdowns) {
					const text = this.contentText(markdown);
					const isNewNode = !this.baselineMarkdowns.has(markdown);
					const lastSeen = this.lastSeenByMarkdown.get(markdown);
					if (text === lastSeen) continue;
					const growth = lastSeen !== void 0 && text.length > lastSeen.length && text.startsWith(lastSeen);
					const existing = this.sessions.get(markdown);
					if (existing !== void 0) {
						if (text.length >= existing.targetText.length && text.startsWith(existing.targetText)) {
							existing.targetText = text;
							existing.textLengths = this.textLengths(markdown);
							existing.lastGrowthAt = performance.now();
							debugLog("tw", "session:extension", {
								targetLen: text.length,
								shownChars: existing.shownChars,
								think: markdown.matches(THINK_BODY_SELECTOR)
							});
							if (existing.holdTimer !== void 0) {
								clearTimeout(existing.holdTimer);
								existing.holdTimer = void 0;
							}
							this.options.onContentChange?.();
							this.lastSeenByMarkdown.set(markdown, text);
							if (existing.shownChars >= existing.targetText.length) existing.shownChars = Math.max(0, existing.targetText.length - 1);
						} else continue;
						this.ensureStreaming(existing);
						continue;
					}
					this.lastSeenByMarkdown.set(markdown, text);
					if (text.length === 0) continue;
					if (loading) {
						debugLog("tw", "skip:loading-grace", {
							textLen: text.length,
							think: markdown.matches(THINK_BODY_SELECTOR)
						});
						continue;
					}
					if (this.completedTextOf(markdown) === text) continue;
					if (!running && !growth) continue;
					if (isNewNode) {
						if (this.tryMigrateSession(markdown, text)) continue;
						if (markdown.matches(THINK_BODY_SELECTOR) && lastSeen === void 0) {
							debugLog("tw", "skip:think-body-first-show", { textLen: text.length });
							continue;
						}
						const startChars = lastSeen?.length ?? 0;
						debugLog("tw", "session:start-new", {
							textLen: text.length,
							startChars,
							think: markdown.matches(THINK_BODY_SELECTOR)
						});
						this.startSession(markdown, text, startChars);
						continue;
					}
					if (this.tryMigrateSession(markdown, text)) continue;
					if (!growth) continue;
					const startChars = lastSeen?.length ?? 0;
					debugLog("tw", "session:start-growth", {
						textLen: text.length,
						startChars,
						lastSeenLen: lastSeen?.length ?? -1
					});
					this.startSession(markdown, text, startChars);
				}
				for (const [markdown, session] of this.sessions) if (!markdown.isConnected || !live.has(markdown)) {
					debugLog("tw", "session:teardown-detached", {
						textLen: session.targetText.length,
						shownChars: session.shownChars
					});
					this.teardownSession(session);
				}
			}
			/** 会话是否正在运行（Deep diving 状态行存在）。 */
			hasRunningTurn() {
				return this.flow.querySelector("[role=\"status\"]") !== null;
			}
			messageContainerOf(el) {
				return el.closest("[data-chat-anchor-key]") ?? Array.from(this.flow.children).find((child) => child.contains(el)) ?? null;
			}
			markdownIndexOf(el) {
				const container = this.messageContainerOf(el);
				if (container === null) return -1;
				return Array.from(container.querySelectorAll(CONTENT_SELECTOR)).filter((markdown) => !markdown.classList.contains(TYPEWRITER_OVERLAY_CLASS)).indexOf(el);
			}
			completedTextOf(markdown) {
				const container = this.messageContainerOf(markdown);
				if (container === null) return void 0;
				return this.completedTargets.get(container)?.get(this.markdownIndexOf(markdown));
			}
			rememberCompleted(session) {
				const container = this.messageContainerOf(session.markdown);
				if (container === null) return;
				const entries = this.completedTargets.get(container) ?? /* @__PURE__ */ new Map();
				entries.set(this.markdownIndexOf(session.markdown), session.targetText);
				this.completedTargets.set(container, entries);
			}
			/** 同一消息内 markdown 节点被替换时迁移打字机 session（流式分段）。 */
			tryMigrateSession(next, text) {
				const nextContainer = this.messageContainerOf(next);
				const nextIndex = this.markdownIndexOf(next);
				for (const [oldMarkdown, session] of this.sessions) {
					if (oldMarkdown === next) continue;
					if (session.messageContainer === null || session.messageContainer !== nextContainer) continue;
					if (session.markdownIndex !== nextIndex) continue;
					if (text.length === 0) continue;
					if (!text.startsWith(session.targetText) && !session.targetText.startsWith(text)) continue;
					this.migrateSession(session, next, text);
					return true;
				}
				return false;
			}
			migrateSession(session, next, text) {
				const oldMarkdown = session.markdown;
				const oldShell = session.shell;
				const newShell = next.parentElement;
				this.restoreSourcePositioning(oldMarkdown);
				if (session.overlay !== null && newShell !== null && oldShell !== newShell) {
					oldShell?.removeChild(session.overlay);
					newShell.insertBefore(session.overlay, next);
				}
				this.sessions.delete(oldMarkdown);
				session.markdown = next;
				session.messageContainer = this.messageContainerOf(next);
				session.markdownIndex = this.markdownIndexOf(next);
				session.shell = newShell;
				if (text.length > session.targetText.length && text.startsWith(session.targetText)) {
					session.targetText = text;
					if (session.shownChars >= text.length) session.shownChars = Math.max(0, text.length - 1);
				}
				session.textLengths = this.textLengths(next);
				session.lastGrowthAt = performance.now();
				this.options.onContentChange?.();
				next.style.position = "absolute";
				next.style.left = "-9999px";
				next.style.visibility = "hidden";
				next.style.pointerEvents = "none";
				this.sessions.set(next, session);
				this.renderOverlay(session);
				this.ensureStreaming(session);
			}
			startSession(markdown, text, startChars = 0) {
				const session = {
					markdown,
					messageContainer: this.messageContainerOf(markdown),
					markdownIndex: this.markdownIndexOf(markdown),
					shell: markdown.parentElement,
					overlay: null,
					textLengths: this.textLengths(markdown),
					targetText: text,
					shownChars: Math.max(0, Math.min(startChars, text.length)),
					lastGrowthAt: performance.now(),
					lastEmitAt: 0,
					settleTimer: void 0,
					holdTimer: void 0
				};
				debugLog("tw", "session:start", {
					textLen: text.length,
					startChars: session.shownChars,
					think: markdown.matches(THINK_BODY_SELECTOR),
					summary: markdown.matches(THINK_SUMMARY_SELECTOR)
				});
				this.sessions.set(markdown, session);
				this.options.onContentChange?.();
				this.installOverlay(session);
				this.ensureStreaming(session);
			}
			ensureStreaming(session) {
				if (session.settleTimer !== void 0) return;
				const interval = 16;
				const step = () => {
					if (this.disposed) return;
					this.emitStep(session, performance.now());
					if (session.shownChars >= session.targetText.length && performance.now() - session.lastGrowthAt >= this.options.settleDelay) {
						this.settle(session);
						return;
					}
					session.settleTimer = setTimeout(step, interval);
				};
				session.settleTimer = setTimeout(step, interval);
			}
			pendingSessions() {
				return this.markdowns().map((markdown) => this.sessions.get(markdown)).filter((session) => session !== void 0 && session.shownChars < session.targetText.length);
			}
			emitStep(session, now) {
				if (session.overlay === null) return;
				const pending = this.pendingSessions();
				if (pending[0] !== session) return;
				const delta = session.lastEmitAt === 0 ? 16 : Math.max(0, now - session.lastEmitAt);
				session.lastEmitAt = now;
				const speed = pending.reduce((total, item) => total + this.effectiveSpeed(item.targetText.length), 0);
				const charsToAdd = Math.max(1, Math.floor(delta * speed));
				const previous = session.shownChars;
				session.shownChars = Math.min(session.targetText.length, session.shownChars + charsToAdd);
				if (session.shownChars > previous) this.options.onContentChange?.();
				this.renderOverlay(session);
				if (session.shownChars >= session.targetText.length && now - session.lastGrowthAt >= this.options.settleDelay) this.settle(session);
			}
			/**
			* 速度公式（无上限）：400 字以内用基础速度，之后随文本总量线性加速，
			* 每多 250 字提速 1 倍，超大段话也平滑尽快完成。
			*/
			effectiveSpeed(length) {
				if (length <= 400) return this.options.baseSpeed;
				const multiplier = 1 + (length - 400) / 250;
				return this.options.baseSpeed * multiplier;
			}
			/**
			* 覆盖层作为正常流元素占据已打文本高度：目标 markdown 打字期间
			* display:none（不占高、不预留整段空白），覆盖层继承其字体输入逐字。
			*/
			stripInteractiveControls(root) {
				root.querySelectorAll("button,[data-copy],[aria-label*=\"copy\" i],[aria-label*=\"复制\"],[data-testid*=\"copy\" i],[class*=\"copy\" i]").forEach((control) => control.remove());
			}
			installOverlay(session) {
				const markdown = session.markdown;
				const shell = session.shell;
				if (shell === null) return;
				debugLog("tw", "overlay:install", {
					textLen: session.targetText.length,
					shownChars: session.shownChars,
					think: markdown.matches(THINK_BODY_SELECTOR)
				});
				const overlay = markdown.cloneNode(true);
				this.stripInteractiveControls(overlay);
				overlay.classList.add(TYPEWRITER_OVERLAY_CLASS);
				overlay.style.display = "none";
				overlay.style.pointerEvents = "none";
				overlay.style.userSelect = "none";
				shell.insertBefore(overlay, markdown);
				session.overlay = overlay;
				markdown.style.position = "absolute";
				markdown.style.left = "-9999px";
				markdown.style.visibility = "hidden";
				markdown.style.pointerEvents = "none";
				this.renderOverlay(session);
			}
			/**
			* 按段落渲染：目标文本用空行（\n\n）分隔段落。复用已有段落 div，只
			* 更新文本与段距；段落数变化时才增删节点，避免高频流式下每帧重建
			* DOM（手机端卡顿 / 发热主因）。
			*/
			renderOverlay(session) {
				let overlay = session.overlay;
				if (overlay === null) return;
				overlay.style.display = session.shownChars > 0 ? "block" : "none";
				let nodes = this.textNodes(overlay);
				if (nodes.length !== session.textLengths.length) {
					const replacement = session.markdown.cloneNode(true);
					this.stripInteractiveControls(replacement);
					replacement.classList.add(TYPEWRITER_OVERLAY_CLASS);
					replacement.style.cssText = overlay.style.cssText;
					overlay.replaceWith(replacement);
					overlay = replacement;
					session.overlay = overlay;
					overlay.style.display = session.shownChars > 0 ? "block" : "none";
					nodes = this.textNodes(overlay);
					session.textLengths = nodes.map((node) => node.data.length);
				}
				const cursor = overlay.querySelector(`.dsh-scroll-flow-typewriter-overlay-cursor`) ?? this.createCursor();
				const prefix = session.targetText.slice(0, session.shownChars);
				let offset = 0;
				let lastVisible = null;
				const nodeStarts = /* @__PURE__ */ new Map();
				for (let i = 0; i < nodes.length; i++) {
					const node = nodes[i];
					const snapshot = i < session.textLengths.length ? session.textLengths[i] : -1;
					const length = snapshot >= 0 ? snapshot : Math.max(0, prefix.length - offset);
					nodeStarts.set(node, offset);
					const take = Math.max(0, Math.min(length, prefix.length - offset));
					node.data = prefix.slice(offset, offset + take);
					if (take > 0) lastVisible = node;
					offset += length;
				}
				for (const block of overlay.querySelectorAll("p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,ol,ul")) {
					const starts = this.textNodes(block).map((node) => nodeStarts.get(node)).filter((start) => start !== void 0);
					const start = starts.length > 0 ? Math.min(...starts) : null;
					if (start !== null && session.shownChars >= Math.max(0, start - 1)) {
						if (block.dataset.dshTypewriterHidden === "true") {
							delete block.dataset.dshTypewriterHidden;
							block.style.display = "";
						}
					} else {
						block.dataset.dshTypewriterHidden = "true";
						block.style.display = "none";
					}
				}
				if (lastVisible !== null && lastVisible.parentElement !== null) lastVisible.parentElement.insertBefore(cursor, lastVisible.nextSibling);
				else overlay.appendChild(cursor);
			}
			createCursor() {
				const cursor = document.createElement("span");
				cursor.className = `${TYPEWRITER_OVERLAY_CLASS}-cursor`;
				cursor.style.cssText = Object.entries(CURSOR_STYLE).map(([k, v]) => `${k}:${v}`).join(";");
				return cursor;
			}
			/** 流式稳定：结束打字，保留光标一小段时间后恢复原始 Markdown。 */
			settle(session) {
				if (session.settleTimer === void 0 && session.overlay === null) return;
				debugLog("tw", "session:settle", {
					textLen: session.targetText.length,
					shownChars: session.shownChars
				});
				clearTimeout(session.settleTimer);
				session.settleTimer = void 0;
				if (session.shownChars < session.targetText.length) session.shownChars = session.targetText.length;
				this.renderOverlay(session);
				this.rememberCompleted(session);
				session.holdTimer = setTimeout(() => {
					this.teardownSession(session);
				}, this.options.cursorHold);
			}
			restoreSourcePositioning(el) {
				if (el.style.position === "absolute") el.style.position = "";
				if (el.style.left === "-9999px") el.style.left = "";
				if (el.style.visibility === "hidden") el.style.visibility = "";
				if (el.style.pointerEvents === "none") el.style.pointerEvents = "";
			}
			teardownSession(session) {
				debugLog("tw", "session:teardown", {
					textLen: session.targetText.length,
					shownChars: session.shownChars
				});
				clearTimeout(session.settleTimer);
				clearTimeout(session.holdTimer);
				session.settleTimer = void 0;
				session.holdTimer = void 0;
				this.options.onRestore?.();
				this.restoreSourcePositioning(session.markdown);
				if (session.overlay !== null) {
					session.overlay.remove();
					session.overlay = null;
				}
				this.sessions.delete(session.markdown);
			}
			ensureStyleTag() {
				if (document.querySelector("#dsh-typewriter-style") !== null) return;
				const style = document.createElement("style");
				style.id = "dsh-typewriter-style";
				style.textContent = BLINK_KEYFRAMES;
				document.head.appendChild(style);
			}
		};
		//#endregion
		//#region src/client/scroll-flow-settings.ts
		/**
		* 滚动动效设置：动画档位（关闭 / 优雅 / 适中）、弹簧开关与打字机开关。
		* 持久化主通道是浏览器 localStorage（与透明 UI 等纯 UI 插件一致，刷新
		* 即可恢复）；若 Host settingsScope 可用，也同步写入 Host 作为增强。
		*/
		const SCROLL_FLOW_SETTINGS_NAMESPACE = "dsh-web-scroll-flow";
		const FOLLOW_MODE_FIELD = "followMode";
		const BOUNCE_ENABLED_FIELD = "bounceEnabled";
		const TYPEWRITER_ENABLED_FIELD = "typewriterEnabled";
		const TYPEWRITER_MODE_FIELD = "typewriterMode";
		const DEFAULT_FOLLOW_MODE = "medium";
		const DEFAULT_TYPEWRITER_MODE = "native";
		/** localStorage 持久化键（单一 JSON 对象）。 */
		const STORAGE_KEY = "dsh-web-scroll-flow.settings";
		/** 适中：当前幅度（200ms 大距离平滑）。 */
		const MEDIUM_FOLLOW = { duration: 200 };
		/** 优雅：更慢一点往上推。 */
		const GENTLE_FOLLOW = { duration: 380 };
		/** 把用户档位翻译成 controller 配置。 */
		function followOptionsForMode(mode) {
			switch (mode) {
				case "off": return null;
				case "gentle": return GENTLE_FOLLOW;
				case "medium": return MEDIUM_FOLLOW;
			}
		}
		function isFollowMode(value) {
			return value === "off" || value === "gentle" || value === "medium";
		}
		/** 从 localStorage 读取偏好；损坏或缺失返回 undefined。 */
		function readLocalSettings() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw === null) return void 0;
				const value = JSON.parse(raw);
				if (typeof value !== "object" || value === null) return void 0;
				const section = value;
				if (!isFollowMode(section.followMode) || typeof section.bounceEnabled !== "boolean" || typeof section.typewriterEnabled !== "boolean" || section.typewriterMode !== "native" && section.typewriterMode !== "overlay") return;
				return section;
			} catch {
				return;
			}
		}
		function writeLocalSettings(section) {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(section));
			} catch {}
		}
		/**
		* 滚动动效偏好：live 值先由 localStorage 恢复，用户修改同时写
		* localStorage 与 Host scope（若可用）。
		*/
		var ScrollFlowPolicy = class {
			followMode = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(DEFAULT_FOLLOW_MODE);
			bounceEnabled = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(true);
			typewriterEnabled = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(true);
			typewriterMode = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(DEFAULT_TYPEWRITER_MODE);
			host;
			/**
			* @param host - 可选 Host 持久化 scope；localStorage 始终是主通道。
			*/
			constructor(host) {
				this.host = host;
				const local = readLocalSettings();
				if (local !== void 0) {
					this.followMode.set(local.followMode);
					this.bounceEnabled.set(local.bounceEnabled);
					this.typewriterEnabled.set(local.typewriterEnabled);
					this.typewriterMode.set(local.typewriterMode);
				}
				if (host !== void 0) {
					host.subscribe(() => {
						this.adopt(host);
					});
					this.adopt(host);
				}
			}
			persist() {
				writeLocalSettings({
					followMode: this.followMode.getSnapshot(),
					bounceEnabled: this.bounceEnabled.getSnapshot(),
					typewriterEnabled: this.typewriterEnabled.getSnapshot(),
					typewriterMode: this.typewriterMode.getSnapshot()
				});
			}
			/** 切换自动滚动动画档位（关闭 / 优雅 / 适中）。 */
			setFollowMode(mode) {
				if (this.followMode.getSnapshot() === mode) return;
				this.followMode.set(mode);
				this.persist();
				this.host?.set(FOLLOW_MODE_FIELD, mode);
			}
			/** 切换边缘回弹弹簧开关。 */
			setBounceEnabled(enabled) {
				if (this.bounceEnabled.getSnapshot() === enabled) return;
				this.bounceEnabled.set(enabled);
				this.persist();
				this.host?.set(BOUNCE_ENABLED_FIELD, enabled);
			}
			/** 切换逐字打字机效果开关。 */
			setTypewriterEnabled(enabled) {
				if (this.typewriterEnabled.getSnapshot() === enabled) return;
				this.typewriterEnabled.set(enabled);
				this.persist();
				this.host?.set(TYPEWRITER_ENABLED_FIELD, enabled);
			}
			/** 切换打字机实现模式（原生截断 / 覆盖层模拟）。 */
			setTypewriterMode(mode) {
				if (this.typewriterMode.getSnapshot() === mode) return;
				this.typewriterMode.set(mode);
				this.persist();
				this.host?.set(TYPEWRITER_MODE_FIELD, mode);
			}
			adopt(host) {
				const section = host.getSnapshot().value;
				if (section === void 0) return;
				if (isFollowMode(section.followMode)) this.followMode.set(section.followMode);
				if (typeof section.bounceEnabled === "boolean") this.bounceEnabled.set(section.bounceEnabled);
				if (typeof section.typewriterEnabled === "boolean") this.typewriterEnabled.set(section.typewriterEnabled);
				if (section.typewriterMode === "native" || section.typewriterMode === "overlay") this.typewriterMode.set(section.typewriterMode);
			}
		};
		//#endregion
		//#region src/client/settings-row.tsx
		/**
		* General 设置中的滚动动效偏好行：动画档位选择（关闭 / 优雅 / 适中）
		* 与弹簧开关。控件是原生 select / checkbox，避免引入额外 UI 依赖。
		*/
		const FOLLOW_OPTIONS = [
			{
				id: "off",
				label: "关闭"
			},
			{
				id: "gentle",
				label: "优雅"
			},
			{
				id: "medium",
				label: "适中"
			}
		];
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "16px",
			minHeight: "44px"
		};
		const textStyle = {
			display: "flex",
			flexDirection: "column",
			gap: "2px"
		};
		const titleStyle = {
			font: "var(--dsw-font-s-strong-14)",
			color: "var(--dsw-alias-label-primary)"
		};
		const descStyle = {
			font: "var(--dsw-font-xs-13)",
			color: "var(--dsw-alias-label-caption)"
		};
		const controlStyle = {
			font: "var(--dsw-font-s-14)",
			color: "var(--dsw-alias-label-primary)",
			background: "var(--dsw-alias-interactive-bg-hover-solid)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "6px",
			padding: "4px 8px"
		};
		/** General 设置行：滚动动画档位 + 边缘回弹 + 打字机效果与模式。 */
		function ScrollFlowSettingsRow({ useFollowMode, useBounceEnabled, useTypewriterEnabled, useTypewriterMode, setFollowMode, setBounceEnabled, setTypewriterEnabled, setTypewriterMode }) {
			const mode = useFollowMode((value) => value);
			const bounceEnabled = useBounceEnabled((value) => value);
			const typewriterEnabled = useTypewriterEnabled((value) => value);
			const typewriterMode = useTypewriterMode((value) => value);
			const renderCheckbox = (label, checked, onChange) => (0, react.createElement)("input", {
				type: "checkbox",
				checked,
				style: {
					width: "16px",
					height: "16px",
					accentColor: "var(--dsw-static-deepseek-500)"
				},
				onChange: (event) => {
					onChange(event.target.checked);
				},
				"aria-label": label
			});
			return (0, react.createElement)("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				padding: "4px 0"
			} }, (0, react.createElement)("div", { style: rowStyle }, (0, react.createElement)("div", { style: textStyle }, (0, react.createElement)("div", { style: titleStyle }, "自动滚动动画"), (0, react.createElement)("div", { style: descStyle }, "内容自动跟随时的平滑推送幅度：关闭、优雅（慢速上推）或适中（当前默认）")), (0, react.createElement)("select", {
				value: mode,
				style: controlStyle,
				onChange: (event) => {
					setFollowMode(event.target.value);
				},
				"aria-label": "自动滚动动画"
			}, FOLLOW_OPTIONS.map((option) => (0, react.createElement)("option", {
				key: option.id,
				value: option.id
			}, option.label)))), (0, react.createElement)("div", { style: rowStyle }, (0, react.createElement)("div", { style: textStyle }, (0, react.createElement)("div", { style: titleStyle }, "边缘回弹"), (0, react.createElement)("div", { style: descStyle }, "手动滚动到顶部 / 底部时的弹簧回弹效果")), renderCheckbox("边缘回弹", bounceEnabled, setBounceEnabled)), (0, react.createElement)("div", { style: rowStyle }, (0, react.createElement)("div", { style: textStyle }, (0, react.createElement)("div", { style: titleStyle }, "打字机效果"), (0, react.createElement)("div", { style: descStyle }, "流式输出时以字为单位逐字显示，并带闪烁光标")), renderCheckbox("打字机效果", typewriterEnabled, setTypewriterEnabled)), (0, react.createElement)("div", { style: rowStyle }, (0, react.createElement)("div", { style: textStyle }, (0, react.createElement)("div", { style: titleStyle }, "打字机模式"), (0, react.createElement)("div", { style: descStyle }, "原生：保留实时 Markdown 渲染；覆盖层：叠加模拟层")), (0, react.createElement)("select", {
				value: typewriterMode,
				style: {
					...controlStyle,
					opacity: typewriterEnabled ? 1 : .5
				},
				disabled: !typewriterEnabled,
				onChange: (event) => {
					setTypewriterMode(event.target.value);
				},
				"aria-label": "打字机模式"
			}, (0, react.createElement)("option", { value: "native" }, "原生"), (0, react.createElement)("option", { value: "overlay" }, "覆盖层"))));
		}
		//#endregion
		//#region src/client/index.ts
		const name = "dsh-web-scroll-flow";
		/** 对话滚动容器选择器（ConversationRoot 的 scrollBody）。 */
		const SCROLLPORT_SELECTOR = "[data-conversation-scroll]";
		/** 插件需要等待的服务。 */
		const inject = ["slots", "settingsScope"];
		/** 按模式创建打字机控制器（flow 内 fallback 到滚动容器本身）。 */
		function createTypewriter(element, _mode, controller) {
			const flow = element.querySelector("[data-chat-flow]") ?? element;
			const onRestore = () => {
				controller.suppressEntryFor(600);
			};
			const onContentChange = () => {
				controller.smoothFollowFor(1e3);
			};
			return new TypewriterController(flow, {
				onRestore,
				onContentChange
			}).attach();
		}
		/**
		* 在给定根节点下安装滚动动效与逐字吐字动画：同步扫描现有容器，并用
		* MutationObserver 跟随后续的挂载 / 卸载（会话打开、视图切换、面板折叠
		* 都会增减容器）。
		* @param root - 扫描与观察的根节点（通常为 document）。
		* @param options - 初始动效配置。
		* @param typewriter - 是否启用逐字吐字动画（跟随动画档位）。
		* @returns 卸载句柄。
		*/
		function installScrollFlow(root, options = {}, typewriter = false, typewriterMode = "native") {
			const entries = /* @__PURE__ */ new Map();
			const sync = () => {
				const elements = Array.from(root.querySelectorAll(SCROLLPORT_SELECTOR));
				for (const element of elements) if (!entries.has(element)) {
					const controller = new ScrollFlowController(element, options).attach();
					entries.set(element, {
						controller,
						typewriter: typewriter ? createTypewriter(element, typewriterMode, controller) : null
					});
				}
				for (const [element, entry] of entries) if (!element.isConnected) {
					entry.controller.dispose();
					entry.typewriter?.dispose();
					entries.delete(element);
				}
			};
			sync();
			let syncScheduled = false;
			const scheduleSync = () => {
				if (syncScheduled) return;
				syncScheduled = true;
				queueMicrotask(() => {
					syncScheduled = false;
					sync();
				});
			};
			const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleSync);
			observer?.observe(root, {
				childList: true,
				subtree: true
			});
			return {
				setOptions(next) {
					for (const entry of entries.values()) entry.controller.setOptions(next);
				},
				setTypewriterEnabled(enabled) {
					for (const entry of entries.values()) if (enabled && entry.typewriter === null) entry.typewriter = createTypewriter(entry.controller.element, typewriterMode, entry.controller);
					else if (!enabled && entry.typewriter !== null) {
						entry.typewriter.dispose();
						entry.typewriter = null;
					}
				},
				setTypewriterMode(mode) {
					typewriterMode = mode;
					for (const entry of entries.values()) {
						if (entry.typewriter === null) continue;
						entry.typewriter.dispose();
						entry.typewriter = createTypewriter(entry.controller.element, mode, entry.controller);
					}
				},
				dispose() {
					observer?.disconnect();
					for (const entry of entries.values()) {
						entry.typewriter?.dispose();
						entry.controller.dispose();
					}
					entries.clear();
				}
			};
		}
		/**
		* 插件入口：浏览器端激活时安装滚动动效、注册设置行并持久化偏好。
		* @param ctx - 客户端 cordis 上下文。
		*/
		function apply(ctx) {
			const policy = new ScrollFlowPolicy(ctx.settingsScope.bind({ namespace: SCROLL_FLOW_SETTINGS_NAMESPACE }));
			const syncInstallOptions = () => ({
				follow: followOptionsForMode(policy.followMode.getSnapshot()),
				bounce: policy.bounceEnabled.getSnapshot() ? void 0 : null
			});
			const thinkStyle = document.createElement("style");
			thinkStyle.id = "dsh-think-scroll-smooth";
			thinkStyle.textContent = "[data-variant=\"think\"][data-state=\"running\"] [class*=\"summary\"]{scroll-behavior:smooth}";
			document.head.appendChild(thinkStyle);
			const anchorStyle = document.createElement("style");
			anchorStyle.id = "dsh-scroll-anchor-none";
			anchorStyle.textContent = "[data-conversation-scroll]{overflow-anchor:none}";
			document.head.appendChild(anchorStyle);
			mountDebugGlobal();
			ctx.effect(() => {
				debugLog("install", "effect-start", {});
				const install = installScrollFlow(document, syncInstallOptions(), policy.typewriterEnabled.getSnapshot(), policy.typewriterMode.getSnapshot());
				const disposeFollow = policy.followMode.subscribe(() => {
					install.setOptions({ follow: followOptionsForMode(policy.followMode.getSnapshot()) });
					if (policy.followMode.getSnapshot() === "off") install.setOptions({ follow: null });
				});
				const disposeBounce = policy.bounceEnabled.subscribe(() => {
					install.setOptions({ bounce: policy.bounceEnabled.getSnapshot() ? void 0 : null });
				});
				const disposeTypewriter = policy.typewriterEnabled.subscribe(() => {
					install.setTypewriterEnabled(policy.typewriterEnabled.getSnapshot());
				});
				const disposeTypewriterMode = policy.typewriterMode.subscribe(() => {
					install.setTypewriterMode(policy.typewriterMode.getSnapshot());
				});
				return () => {
					disposeFollow();
					disposeBounce();
					disposeTypewriter();
					disposeTypewriterMode();
					thinkStyle.remove();
					anchorStyle.remove();
					debugLog("install", "effect-stop", {});
					install.dispose();
				};
			});
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "scroll-flow",
				order: 30,
				inject: () => ({
					hooks: {
						followMode: policy.followMode,
						bounceEnabled: policy.bounceEnabled,
						typewriterEnabled: policy.typewriterEnabled,
						typewriterMode: policy.typewriterMode
					},
					setFollowMode: (mode) => {
						policy.setFollowMode(mode);
					},
					setBounceEnabled: (enabled) => {
						policy.setBounceEnabled(enabled);
					},
					setTypewriterEnabled: (enabled) => {
						policy.setTypewriterEnabled(enabled);
					},
					setTypewriterMode: (mode) => {
						policy.setTypewriterMode(mode);
					}
				})
			}, ScrollFlowSettingsRow));
		}
		//#endregion
		exports.SCROLLPORT_SELECTOR = SCROLLPORT_SELECTOR;
		exports.apply = apply;
		exports.inject = inject;
		exports.installScrollFlow = installScrollFlow;
		exports.name = name;
		return module.exports;
	}
});

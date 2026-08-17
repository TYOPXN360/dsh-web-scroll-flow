window.__ModuleLoader__.load({
	id: "dsh-web-scroll-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		let react = require("react");
		//#region src/client/scroll-flow-controller.ts
		const DEFAULT_FOLLOW = { duration: 200 };
		const DEFAULT_BOUNCE = {
			amplitude: 24,
			stiffness: 160,
			damping: 12,
			sensitivity: 140,
			releaseDelay: 120
		};
		/** 视为"同一目标"的容差（px），避免 scroll 事件触发的重复跟随写入重启动画。 */
		const SAME_TARGET_TOLERANCE = 1;
		/** 弹簧 / 拉伸收敛阈值（px）。 */
		const REST_EPSILON = .05;
		/** 贴底小增量 vs 大距离跳转的分界（px）。 */
		const ENTRY_FOLLOW_DISTANCE = 48;
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
			/** 边缘回弹状态：跟手位移（px，顶边缘为正/向下拉，底边缘为负/向上拉）。 */
			bounceOffset = 0;
			bounceVelocity = 0;
			releasing = false;
			lastWheelAt = 0;
			bounceFrameAt = 0;
			bounceTarget = null;
			/** flow 高度监视：检测内容收回（高度减小）时清位移，避免与浏览器 clamp 叠加成"撞墙回弹"。 */
			flowObserver = null;
			lastFlowHeight = 0;
			/** rAF 调度：非 0 表示有未决帧。 */
			frameId = 0;
			disposed = false;
			reducedMotion = false;
			/** 滚轮：用户手动滚动 → 打断动画；边缘继续向外滚时跟手拉动（无上限），
			*  滚轮停止 releaseDelay 后松手释放弹簧回中。 */
			onWheel = (event) => {
				this.cancelAnimation();
				this.cancelEntry();
				if (this.bounce === null || this.disposed || this.reducedMotion || event.defaultPrevented || event.deltaY === 0) return;
				if (this.eventConsumedByChildScroll(event)) return;
				if (this.resolveBounceTarget() === null) return;
				const real = this.nativeGet();
				const floor = Math.max(0, this.element.scrollHeight - this.element.clientHeight);
				const atTop = real <= 0;
				const atBottom = floor - real <= 1;
				if (!(event.deltaY < 0 && atTop || event.deltaY > 0 && atBottom)) {
					this.beginRelease();
					return;
				}
				if (event.cancelable) event.preventDefault();
				this.lastWheelAt = performance.now();
				const direction = event.deltaY < 0 ? 1 : -1;
				const unit = Math.abs(event.deltaY) / this.bounce.sensitivity * this.bounce.amplitude;
				const gain = 1 / (1 + Math.abs(this.bounceOffset) / Math.max(1, this.bounce.amplitude));
				this.bounceOffset += direction * unit * gain;
				this.bounceVelocity = 0;
				this.bounceFrameAt = performance.now();
				this.releasing = false;
				this.ensureFrame();
			};
			/** 目标与容器之间是否存在能在滚动方向上继续滚动的子滚动元素。 */
			eventConsumedByChildScroll(event) {
				const target = event.target instanceof Element ? event.target : null;
				if (target === null || !this.element.contains(target)) return false;
				let el = target;
				while (el !== null && el !== this.element) {
					if (el.scrollHeight > el.clientHeight) {
						const style = getComputedStyle(el);
						if (style.overflowY === "auto" || style.overflowY === "scroll") {
							if (event.deltaY < 0 && el.scrollTop > 0) return true;
							const floor = el.scrollHeight - el.clientHeight;
							if (event.deltaY > 0 && el.scrollTop < floor - 1) return true;
						}
					}
					el = el.parentElement;
				}
				return false;
			}
			/** 触摸开始：用户接管滚动，打断动画并清掉残留拉伸。 */
			onTouchStart = () => {
				this.cancelAll();
			};
			/** 点击：非滚动交互（展开消息等），清掉残留位移避免重排时误显。 */
			onClick = () => {
				this.cancelAll();
			};
			/** 按下（滚动条拖动、触摸板点击等）：用户接管，打断动画。 */
			onPointerDown = () => {
				this.cancelAll();
			};
			/** 键盘滚动（PageUp/PageDown/方向键等）：用户接管，打断动画。 */
			onKeyDown = (event) => {
				if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End" || event.key === " ") this.cancelAll();
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
					this.cancelAnimation();
					this.cancelEntry();
				}
				if (this.bounce === null) {
					this.resetBounce();
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
						this.cancelAnimation();
						this.cancelEntry();
						this.resetBounce();
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
				this.cancelAll();
				this.flowObserver?.disconnect();
				this.flowObserver = null;
				delete this.element.scrollTop;
				this.element.removeEventListener("wheel", this.onWheel, { capture: true });
				this.element.removeEventListener("touchstart", this.onTouchStart, { capture: true });
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
					this.cancelAll();
					this.nativeSet(value);
					this.reportedTop = this.nativeGet();
					return;
				}
				if (floor - real > ENTRY_FOLLOW_DISTANCE) {
					this.cancelEntry();
					this.startFollowAnimation(floor);
					return;
				}
				this.cancelAnimation();
				this.nativeSet(value);
				this.startEntryPush();
			}
			startFollowAnimation(target) {
				this.animating = true;
				this.animStart = this.nativeGet();
				this.animTarget = target;
				const maxDuration = Math.max(1, this.follow?.duration ?? 1);
				const distance = Math.abs(target - this.animStart);
				this.animDuration = Math.max(16, Math.min(maxDuration, maxDuration * (distance / 200)));
				this.animStartTime = performance.now();
				this.reportedTop = target;
				this.ensureFrame();
			}
			/** 贴底入场推升：整列先下压 ENTRY_PUSH_PX，再平滑回位（ChatAnimation 式）。 */
			startEntryPush() {
				if (this.resolveBounceTarget() === null || this.follow === null) return;
				if (performance.now() < this.suppressEntryUntil) return;
				const now = performance.now();
				if (this.entryActive && now - this.lastEntryStartAt < ENTRY_MIN_INTERVAL) return;
				this.entryActive = true;
				this.entryPush = ENTRY_PUSH_PX;
				this.entryDuration = Math.max(16, this.follow.duration);
				this.entryStartTime = now;
				this.lastEntryStartAt = now;
				this.ensureFrame();
			}
			cancelAnimation() {
				if (!this.animating) return;
				this.animating = false;
				this.reportedTop = this.nativeGet();
			}
			cancelEntry() {
				if (!this.entryActive) return;
				this.entryActive = false;
				this.entryOffset = 0;
				this.applyFlowTransform();
			}
			/** 用户输入 / 关闭设置：取消全部动画并清理位移。 */
			cancelAll() {
				this.cancelAnimation();
				this.cancelEntry();
				this.resetBounce();
			}
			/** 清除回弹状态（触控 / 关闭设置等用户操作，瞬时清干净）。 */
			resetBounce() {
				this.bounceOffset = 0;
				this.bounceVelocity = 0;
				this.releasing = false;
				this.bounceFrameAt = 0;
				this.applyFlowTransform();
			}
			/** 松手释放：进入弹簧回中模式（offset 保留不回零，弹簧带回）。 */
			beginRelease() {
				if (Math.abs(this.bounceOffset) <= REST_EPSILON) {
					this.resetBounce();
					return;
				}
				this.releasing = true;
				this.bounceVelocity = 0;
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
				if (this.reducedMotion) this.cancelAll();
			};
			/** 惰性解析内容列：视图切换（chat ↔ trajectory）后下次动画重新查找。 */
			resolveBounceTarget() {
				if (this.bounceTarget !== null && this.bounceTarget.isConnected) return this.bounceTarget;
				this.bounceTarget = this.element.querySelector(this.bounceSelector);
				return this.bounceTarget;
			}
			/**
			* 统一渲染内容列位移：入场推升 + 回弹拉伸叠加到 transform。
			* 内容列内所有元素保持原有相对布局，不单独改写状态行位置。
			*/
			applyFlowTransform() {
				const target = this.resolveBounceTarget();
				if (target === null) return;
				const offset = this.entryOffset + (Math.abs(this.bounceOffset) > REST_EPSILON ? this.bounceOffset : 0);
				const transform = Math.abs(offset) > REST_EPSILON ? `translateY(${offset.toFixed(2)}px)` : "";
				target.style.transform = transform;
				target.style.willChange = transform === "" ? "" : "transform";
			}
			resetFlowTransform() {
				const target = this.resolveBounceTarget();
				if (target === null) return;
				target.style.transform = "";
				target.style.willChange = "";
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
					} else active = true;
				}
				if (this.bounce !== null && this.resolveBounceTarget() !== null) {
					if (now - this.lastWheelAt > this.bounce.releaseDelay && !this.releasing && Math.abs(this.bounceOffset) > REST_EPSILON) this.beginRelease();
					if (this.releasing) {
						const dt = this.bounceFrameAt === 0 ? .016 : clamp((now - this.bounceFrameAt) / 1e3, .001, .05);
						this.bounceFrameAt = now;
						this.bounceVelocity += -this.bounceOffset * this.bounce.stiffness * dt;
						this.bounceVelocity *= Math.exp(-this.bounce.damping * dt);
						this.bounceOffset += this.bounceVelocity * dt;
						if (Math.abs(this.bounceOffset) <= REST_EPSILON && Math.abs(this.bounceVelocity) <= REST_EPSILON) {
							this.bounceOffset = 0;
							this.bounceVelocity = 0;
							this.releasing = false;
						} else active = true;
					} else if (Math.abs(this.bounceOffset) > REST_EPSILON) active = true;
				}
				this.applyFlowTransform();
				if (active) this.ensureFrame();
			};
		};
		//#endregion
		//#region src/client/native-typewriter.ts
		/**
		* NativeTypewriterController（原生模式）— 直接在原始 Markdown 文本节点上做
		* 逐字打字机，不再叠加覆盖层。
		*
		* 原理：DSH 流式时 React 会把 Markdown 的完整文本渲染进 DOM；本控制器
		* 用 MutationObserver 捕获这次写入，立即把原始文本节点截断为"已打字前缀"
		* （未显示的字符清空），浏览器实际绘制的是前缀 + 闪烁光标。下一次流式
		* chunk 到达时再重复"React 写全量 → 我们截前缀"的循环。打字结束后恢复
		* 完整文本并移除光标。
		*
		* 好处：
		* - 没有覆盖层、没有双份 DOM、没有位置 / 行距 / 光标锚定问题。
		* - 段落结构就是原始 Markdown 结构，段落间距天然一致。
		* - 打字中原始元素高度 = 已显示前缀高度，不预留整段空白。
		*/
		/** 兼容旧名：光标与样式标记仍使用该 class 前缀。 */
		const TYPEWRITER_OVERLAY_CLASS$1 = "dsh-scroll-flow-typewriter-overlay";
		const DEFAULT_OPTIONS$1 = {
			baseSpeed: .06,
			settleDelay: 500,
			cursorHold: 900,
			loadGrace: 1200
		};
		const CURSOR_CLASS = `${TYPEWRITER_OVERLAY_CLASS$1}-cursor`;
		const CURSOR_STYLE$1 = {
			display: "inline-block",
			width: "2px",
			height: "1em",
			verticalAlign: "text-bottom",
			marginLeft: "1px",
			background: "currentColor",
			opacity: "0.85",
			animation: "dsh-typewriter-blink 1s steps(1) infinite"
		};
		const BLINK_KEYFRAMES$1 = `
@keyframes dsh-typewriter-blink {
  50% { opacity: 0; }
}
`;
		/** 消息 Markdown 容器选择器：Markdown 渲染根（hash class 前缀不固定，按特征匹配）。 */
		const MARKDOWN_SELECTOR$1 = "[class*=\"_markdown_\"], [data-dsh-markdown], .markdown";
		/** 文档序收集一个容器内的所有文本节点（含空节点，保持与目标文本切片对齐）。 */
		function collectTextNodes(root) {
			const nodes = [];
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node !== null) {
				nodes.push(node);
				node = walker.nextNode();
			}
			return nodes;
		}
		/**
		* 一个内容列的原生打字机控制器。构造后 {@link attach} 生效，
		* {@link dispose} 完整清理。
		*/
		var NativeTypewriterController = class {
			flow;
			options;
			observer = null;
			sessions = /* @__PURE__ */ new Map();
			/** attach 时已存在的 Markdown（历史消息），宽限期只保护这些。 */
			baselineMarkdowns = /* @__PURE__ */ new Set();
			/** 每个 Markdown 当前可见文本：区分"React 全量写入"与"我们自己的截断"。 */
			lastSeenByMarkdown = /* @__PURE__ */ new Map();
			loadedAt = performance.now();
			disposed = false;
			constructor(flow, options = {}) {
				this.flow = flow;
				this.options = {
					...DEFAULT_OPTIONS$1,
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
				if (this.disposed) throw new Error("NativeTypewriterController: 已销毁的控制器不能重新挂载");
				this.ensureStyleTag();
				for (const markdown of this.markdowns()) {
					this.baselineMarkdowns.add(markdown);
					this.lastSeenByMarkdown.set(markdown, markdown.textContent ?? "");
				}
				this.observer = new MutationObserver(() => {
					this.scheduleFlush();
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
				return Array.from(this.flow.querySelectorAll(MARKDOWN_SELECTOR$1));
			}
			flushScheduled = false;
			/** Mutation 回调时立即拍的快照：此时 React 刚写入完整文本，节点长度可信。 */
			pendingLengths = /* @__PURE__ */ new Map();
			pendingText = /* @__PURE__ */ new Map();
			/**
			* 合并同一帧内的多次 mutation，用微任务统一处理：React commit 在同步
			* 微任务链里完成，queueMicrotask 会在打字 interval（宏任务）之前截断，
			* 避免 interval 把 React 完整写入覆盖成已显示前缀，导致丢字。
			*/
			scheduleFlush() {
				if (this.disposed) return;
				for (const markdown of this.markdowns()) {
					const text = markdown.textContent ?? "";
					if (text === this.lastSeenByMarkdown.get(markdown)) continue;
					this.pendingLengths.set(markdown, collectTextNodes(markdown).map((node) => node.data?.length ?? 0));
					this.pendingText.set(markdown, text);
				}
				if (this.flushScheduled) return;
				this.flushScheduled = true;
				queueMicrotask(() => {
					this.flushScheduled = false;
					if (!this.disposed) this.onFlowChanged();
					this.pendingLengths.clear();
					this.pendingText.clear();
				});
			}
			onFlowChanged() {
				if (this.disposed) return;
				const markdowns = this.markdowns();
				const live = new Set(markdowns);
				const loading = performance.now() - this.loadedAt < this.options.loadGrace;
				const running = this.hasRunningTurn();
				for (const markdown of markdowns) {
					const text = markdown.textContent ?? "";
					const isNewNode = !this.baselineMarkdowns.has(markdown);
					const lastSeen = this.lastSeenByMarkdown.get(markdown);
					if (text === lastSeen) continue;
					const growth = lastSeen !== void 0 && text.length > lastSeen.length && text.startsWith(lastSeen);
					const existing = this.sessions.get(markdown);
					if (existing !== void 0) {
						const snapshotText = this.pendingText.get(markdown) ?? text;
						const snapshotLengths = this.pendingLengths.get(markdown) ?? collectTextNodes(markdown).map((node) => node.data?.length ?? 0);
						const extension = snapshotText.length > existing.targetText.length && snapshotText.startsWith(existing.targetText);
						const sameTarget = snapshotText === existing.targetText;
						if (extension) {
							existing.targetText = snapshotText;
							existing.lastGrowthAt = performance.now();
							if (existing.shownChars >= existing.targetText.length) existing.shownChars = Math.max(0, existing.targetText.length - 1);
							existing.textLengths = snapshotLengths;
						} else if (sameTarget) existing.textLengths = snapshotLengths;
						else {
							this.abandonSession(existing, snapshotText);
							continue;
						}
						this.applyPrefix(existing);
						this.ensureStreaming(existing);
						continue;
					}
					this.lastSeenByMarkdown.set(markdown, text);
					if (text.length === 0) continue;
					if (!running) continue;
					if (loading) continue;
					if (isNewNode) {
						if (this.tryMigrateSession(markdown, text)) continue;
						this.startSession(markdown, text);
						continue;
					}
					if (this.tryMigrateSession(markdown, text)) continue;
					if (!growth) continue;
					this.startSession(markdown, text);
				}
				for (const [markdown, session] of this.sessions) if (!markdown.isConnected || !live.has(markdown)) this.teardownSession(session);
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
				return Array.from(container.querySelectorAll(MARKDOWN_SELECTOR$1)).indexOf(el);
			}
			/** 同一消息内 markdown 节点被替换且文本延续时，迁移打字机 session。 */
			tryMigrateSession(next, text) {
				const nextContainer = this.messageContainerOf(next);
				const nextIndex = this.markdownIndexOf(next);
				for (const [oldMarkdown, session] of this.sessions) {
					if (oldMarkdown === next) continue;
					if (session.messageContainer === null || session.messageContainer !== nextContainer) continue;
					if (session.markdownIndex !== nextIndex) continue;
					if (!text.startsWith(session.targetText)) continue;
					this.migrateSession(session, next, text);
					return true;
				}
				return false;
			}
			migrateSession(session, next, text) {
				this.sessions.delete(session.markdown);
				session.markdown = next;
				session.messageContainer = this.messageContainerOf(next);
				session.markdownIndex = this.markdownIndexOf(next);
				session.targetText = text;
				session.textLengths = collectTextNodes(next).map((node) => node.data?.length ?? 0);
				session.lastGrowthAt = performance.now();
				if (session.shownChars >= text.length) session.shownChars = Math.max(0, text.length - 1);
				this.sessions.set(next, session);
				this.applyPrefix(session);
				this.ensureStreaming(session);
			}
			startSession(markdown, text) {
				const session = {
					markdown,
					messageContainer: this.messageContainerOf(markdown),
					markdownIndex: this.markdownIndexOf(markdown),
					targetText: text,
					textLengths: collectTextNodes(markdown).map((node) => node.data?.length ?? 0),
					shownChars: 0,
					lastGrowthAt: performance.now(),
					lastEmitAt: 0,
					settleTimer: void 0,
					holdTimer: void 0
				};
				this.sessions.set(markdown, session);
				this.applyPrefix(session);
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
			emitStep(session, now) {
				const delta = session.lastEmitAt === 0 ? 16 : Math.max(0, now - session.lastEmitAt);
				session.lastEmitAt = now;
				const speed = this.effectiveSpeed(session.targetText.length);
				const charsToAdd = Math.max(1, Math.floor(delta * speed));
				session.shownChars = Math.min(session.targetText.length, session.shownChars + charsToAdd);
				this.applyPrefix(session);
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
			* 原生截断：把原始 Markdown 的文本节点内容按 shownChars 前缀重建，
			* 未显示的字符清空；光标插到最后一个文本节点之后。React 下一次全量
			* 写入会被 onFlowChanged 捕获并再次截回。
			*/
			applyPrefix(session) {
				const markdown = session.markdown;
				const target = session.targetText;
				const shown = session.shownChars;
				const lengths = session.textLengths;
				const nodes = collectTextNodes(markdown);
				if (nodes.length !== lengths.length) return;
				let offset = 0;
				let lastTextNode = null;
				for (let i = 0; i < nodes.length && i < lengths.length; i++) {
					const node = nodes[i];
					const length = lengths[i] ?? 0;
					if (offset >= shown || length === 0) node.data = "";
					else {
						const take = Math.min(length, shown - offset);
						node.data = target.slice(offset, offset + take);
						lastTextNode = node;
					}
					offset += length;
				}
				markdown.querySelector(`.${CURSOR_CLASS}`)?.remove();
				const cursor = document.createElement("span");
				cursor.className = CURSOR_CLASS;
				cursor.style.cssText = Object.entries(CURSOR_STYLE$1).map(([k, v]) => `${k}:${v}`).join(";");
				if (lastTextNode !== null) lastTextNode.parentElement?.insertBefore(cursor, lastTextNode.nextSibling);
				else markdown.appendChild(cursor);
				this.lastSeenByMarkdown.set(markdown, target.slice(0, shown));
			}
			/** 流式稳定：结束打字，保留光标一小段时间后移除。 */
			settle(session) {
				if (session.settleTimer === void 0) return;
				clearTimeout(session.settleTimer);
				session.settleTimer = void 0;
				if (session.shownChars < session.targetText.length) session.shownChars = session.targetText.length;
				this.applyPrefix(session);
				session.holdTimer = setTimeout(() => {
					this.teardownSession(session);
				}, this.options.cursorHold);
			}
			abandonSession(session, currentText) {
				clearTimeout(session.settleTimer);
				clearTimeout(session.holdTimer);
				session.settleTimer = void 0;
				session.holdTimer = void 0;
				this.options.onRestore?.();
				session.markdown.querySelector(`.${CURSOR_CLASS}`)?.remove();
				this.sessions.delete(session.markdown);
				this.lastSeenByMarkdown.set(session.markdown, currentText);
			}
			teardownSession(session) {
				clearTimeout(session.settleTimer);
				clearTimeout(session.holdTimer);
				session.settleTimer = void 0;
				session.holdTimer = void 0;
				this.options.onRestore?.();
				this.restoreText(session);
				session.markdown.querySelector(`.${CURSOR_CLASS}`)?.remove();
				this.sessions.delete(session.markdown);
			}
			restoreText(session) {
				const nodes = collectTextNodes(session.markdown);
				if (nodes.length !== session.textLengths.length) {
					session.markdown.textContent = session.targetText;
					this.lastSeenByMarkdown.set(session.markdown, session.targetText);
					return;
				}
				let offset = 0;
				for (let i = 0; i < nodes.length; i++) {
					const length = session.textLengths[i] ?? 0;
					nodes[i].data = session.targetText.slice(offset, offset + length);
					offset += length;
				}
				this.lastSeenByMarkdown.set(session.markdown, session.targetText);
			}
			ensureStyleTag() {
				if (document.querySelector("#dsh-typewriter-style") !== null) return;
				const style = document.createElement("style");
				style.id = "dsh-typewriter-style";
				style.textContent = BLINK_KEYFRAMES$1;
				document.head.appendChild(style);
			}
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
		/** 覆盖层继承的文本排版样式，保证与最终 Markdown 的文字位置一致。 */
		const INHERITED_TEXT_STYLES = [
			"fontFamily",
			"fontSize",
			"fontWeight",
			"fontStyle",
			"lineHeight",
			"letterSpacing",
			"wordSpacing",
			"whiteSpace"
		];
		/** 消息 Markdown 容器选择器：Markdown 渲染根（hash class 前缀不固定，按特征匹配）。 */
		const MARKDOWN_SELECTOR = "[class*=\"_markdown_\"], [data-dsh-markdown], .markdown";
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
					this.lastSeenByMarkdown.set(markdown, markdown.textContent ?? "");
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
				return Array.from(this.flow.querySelectorAll(MARKDOWN_SELECTOR));
			}
			onFlowChanged() {
				if (this.disposed) return;
				const markdowns = this.markdowns();
				const live = new Set(markdowns);
				const loading = performance.now() - this.loadedAt < this.options.loadGrace;
				const running = this.hasRunningTurn();
				for (const markdown of markdowns) {
					const text = markdown.textContent ?? "";
					const isNewNode = !this.baselineMarkdowns.has(markdown);
					const lastSeen = this.lastSeenByMarkdown.get(markdown);
					if (text === lastSeen) continue;
					const growth = lastSeen !== void 0 && text.length > lastSeen.length && text.startsWith(lastSeen);
					const existing = this.sessions.get(markdown);
					if (existing !== void 0) {
						if (text.length >= existing.targetText.length && text.startsWith(existing.targetText)) {
							existing.targetText = text;
							existing.lastGrowthAt = performance.now();
							this.lastSeenByMarkdown.set(markdown, text);
							if (existing.shownChars >= existing.targetText.length) existing.shownChars = Math.max(0, existing.targetText.length - 1);
						} else {
							this.teardownSession(existing);
							this.lastSeenByMarkdown.set(markdown, text);
							continue;
						}
						this.ensureStreaming(existing);
						continue;
					}
					this.lastSeenByMarkdown.set(markdown, text);
					if (!running) continue;
					if (loading) continue;
					if (isNewNode) {
						if (this.tryMigrateSession(markdown, text)) continue;
						this.startSession(markdown, text);
						continue;
					}
					if (this.tryMigrateSession(markdown, text)) continue;
					if (!growth) continue;
					this.startSession(markdown, text);
				}
				for (const [markdown, session] of this.sessions) if (!markdown.isConnected || !live.has(markdown)) this.teardownSession(session);
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
				return Array.from(container.querySelectorAll(MARKDOWN_SELECTOR)).indexOf(el);
			}
			/** 同一消息内 markdown 节点被替换且文本延续时，迁移打字机 session。 */
			tryMigrateSession(next, text) {
				const nextContainer = this.messageContainerOf(next);
				const nextIndex = this.markdownIndexOf(next);
				for (const [oldMarkdown, session] of this.sessions) {
					if (oldMarkdown === next) continue;
					if (session.messageContainer === null || session.messageContainer !== nextContainer) continue;
					if (session.markdownIndex !== nextIndex) continue;
					if (!text.startsWith(session.targetText)) continue;
					this.migrateSession(session, next, text);
					return true;
				}
				return false;
			}
			migrateSession(session, next, text) {
				const oldMarkdown = session.markdown;
				const oldShell = session.shell;
				const newShell = next.parentElement;
				if (oldMarkdown.style.display === "none") oldMarkdown.style.display = "";
				if (session.overlay !== null && newShell !== null && oldShell !== newShell) {
					oldShell?.removeChild(session.overlay);
					newShell.insertBefore(session.overlay, next);
				}
				this.sessions.delete(oldMarkdown);
				session.markdown = next;
				session.messageContainer = this.messageContainerOf(next);
				session.markdownIndex = this.markdownIndexOf(next);
				session.shell = newShell;
				session.targetText = text;
				session.lastGrowthAt = performance.now();
				if (session.shownChars >= text.length) session.shownChars = Math.max(0, text.length - 1);
				next.style.display = "none";
				this.sessions.set(next, session);
				this.renderOverlay(session);
				this.ensureStreaming(session);
			}
			startSession(markdown, text) {
				const session = {
					markdown,
					messageContainer: this.messageContainerOf(markdown),
					markdownIndex: this.markdownIndexOf(markdown),
					shell: markdown.parentElement,
					overlay: null,
					paragraphEls: [],
					paragraphGap: 0,
					targetText: text,
					shownChars: 0,
					lastGrowthAt: performance.now(),
					lastEmitAt: 0,
					settleTimer: void 0,
					holdTimer: void 0
				};
				this.sessions.set(markdown, session);
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
			emitStep(session, now) {
				if (session.overlay === null) return;
				const delta = session.lastEmitAt === 0 ? 16 : Math.max(0, now - session.lastEmitAt);
				session.lastEmitAt = now;
				const speed = this.effectiveSpeed(session.targetText.length);
				const charsToAdd = Math.max(1, Math.floor(delta * speed));
				session.shownChars = Math.min(session.targetText.length, session.shownChars + charsToAdd);
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
			installOverlay(session) {
				const markdown = session.markdown;
				const shell = session.shell;
				if (shell === null) return;
				const overlay = document.createElement("div");
				overlay.className = TYPEWRITER_OVERLAY_CLASS;
				overlay.style.cssText = Object.entries({
					margin: "0",
					padding: "0",
					minHeight: "1em",
					pointerEvents: "none",
					fontSize: "inherit",
					lineHeight: "inherit",
					color: "inherit",
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
					wordBreak: "break-word"
				}).map(([k, v]) => `${k}:${v}`).join(";");
				const style = getComputedStyle(markdown);
				for (const prop of INHERITED_TEXT_STYLES) {
					const value = style[prop];
					if (typeof value === "string" && value !== "") overlay.style.setProperty(String(prop), value);
				}
				const firstParagraph = markdown.querySelector("p, li, pre, blockquote");
				if (firstParagraph !== null) session.paragraphGap = parseFloat(getComputedStyle(firstParagraph).marginBottom) || 0;
				shell.insertBefore(overlay, markdown);
				session.overlay = overlay;
				markdown.style.display = "none";
				this.renderOverlay(session);
			}
			/**
			* 按段落渲染：目标文本用空行（\n\n）分隔段落。复用已有段落 div，只
			* 更新文本与段距；段落数变化时才增删节点，避免高频流式下每帧重建
			* DOM（手机端卡顿 / 发热主因）。
			*/
			renderOverlay(session) {
				const overlay = session.overlay;
				if (overlay === null) return;
				const cursor = overlay.querySelector(`.dsh-scroll-flow-typewriter-overlay-cursor`) ?? this.createCursor();
				if (cursor.parentElement !== null && cursor.parentElement !== overlay) overlay.appendChild(cursor);
				const paragraphs = session.targetText.slice(0, session.shownChars).split("\n\n").filter((segment) => segment !== "" || session.shownChars === 0);
				const els = session.paragraphEls;
				paragraphs.forEach((paragraph, index) => {
					if (paragraph === "") return;
					let p = els[index];
					if (p === void 0 || p.parentElement !== overlay) {
						p = document.createElement("div");
						els[index] = p;
						overlay.appendChild(p);
					}
					p.textContent = paragraph;
					p.style.margin = index < paragraphs.length - 1 ? `0 0 ${session.paragraphGap}px` : "";
				});
				for (let i = paragraphs.length; i < els.length; i++) {
					const extra = els[i];
					if (extra !== void 0) extra.remove();
				}
				els.length = paragraphs.length;
				const lastParagraph = els.length > 0 ? els[els.length - 1] ?? null : null;
				const anchor = lastParagraph === null ? overlay : lastParagraph;
				if (cursor.parentElement !== anchor) anchor.appendChild(cursor);
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
				clearTimeout(session.settleTimer);
				session.settleTimer = void 0;
				if (session.shownChars < session.targetText.length) session.shownChars = session.targetText.length;
				this.renderOverlay(session);
				session.holdTimer = setTimeout(() => {
					this.teardownSession(session);
				}, this.options.cursorHold);
			}
			teardownSession(session) {
				clearTimeout(session.settleTimer);
				clearTimeout(session.holdTimer);
				session.settleTimer = void 0;
				session.holdTimer = void 0;
				this.options.onRestore?.();
				if (session.markdown.style.display === "none") session.markdown.style.display = "";
				if (session.overlay !== null) {
					session.overlay.remove();
					session.overlay = null;
				}
				session.paragraphEls = [];
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
			}, option.label)))), (0, react.createElement)("div", { style: rowStyle }, (0, react.createElement)("div", { style: textStyle }, (0, react.createElement)("div", { style: titleStyle }, "边缘回弹"), (0, react.createElement)("div", { style: descStyle }, "手动滚动到顶部 / 底部时的弹簧回弹效果")), renderCheckbox("边缘回弹", bounceEnabled, setBounceEnabled)), (0, react.createElement)("div", { style: rowStyle }, (0, react.createElement)("div", { style: textStyle }, (0, react.createElement)("div", { style: titleStyle }, "打字机效果"), (0, react.createElement)("div", { style: descStyle }, "流式输出时以字为单位逐字显示，并带闪烁光标")), renderCheckbox("打字机效果", typewriterEnabled, setTypewriterEnabled)), (0, react.createElement)("div", { style: rowStyle }, (0, react.createElement)("div", { style: textStyle }, (0, react.createElement)("div", { style: titleStyle }, "打字机模式"), (0, react.createElement)("div", { style: descStyle }, "原生：直接截断原始 Markdown；覆盖层：叠加模拟层")), (0, react.createElement)("select", {
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
		function createTypewriter(element, mode, controller) {
			const flow = element.querySelector("[data-chat-flow]") ?? element;
			const onRestore = () => {
				controller.suppressEntryFor(600);
			};
			return mode === "native" ? new NativeTypewriterController(flow, { onRestore }).attach() : new TypewriterController(flow, { onRestore }).attach();
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
			ctx.effect(() => {
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

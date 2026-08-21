window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-scroll-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region src/client/locales.ts
		/** `scrollFlow` namespace dictionaries. */
		/** Dictionary namespace owned by this plugin. */
		const NS = "scrollFlow";
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"section.nav": "滚动动画",
			"settings.title": "流式滚动动画",
			"settings.description": "模型输出时自动跟随最新内容，滚动平滑过渡（含未展开的思考摘要）",
			"settings.debugTitle": "调试日志",
			"settings.debugDescription": "记录插件事件与帧率（约 2 万条环形上限，经 window.__DSH_SCROLL_FLOW_DEBUG__ 查看）"
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"section.nav": "Scroll animation",
			"settings.title": "Streaming scroll animation",
			"settings.description": "Smoothly follow the latest content while the model streams, including collapsed thinking summaries",
			"settings.debugTitle": "Debug logs",
			"settings.debugDescription": "Buffer plugin events and frame rate (ring of ~20k entries; inspect via window.__DSH_SCROLL_FLOW_DEBUG__)"
		};
		//#endregion
		//#region src/client/debug-logger.ts
		/**
		* Debug observability for the streaming scroll animation: a fixed-capacity
		* ring buffer of plugin events plus a frame-rate / jank tracker. Everything
		* is gated by `setDebugLogging` — driven by the General-settings Debug switch
		* — so with the switch off each call site costs only a boolean check. The
		* buffer is exposed on `window.__DSH_SCROLL_FLOW_DEBUG__` for live inspection
		* (devtools or automation), e.g. while reproducing an animation issue.
		*/
		/** Ring capacity: ~20k entries covers a continuous streaming session. */
		const DEBUG_LOG_CAPACITY = 2e4;
		let active = false;
		const ring = new Array(DEBUG_LOG_CAPACITY);
		let head = 0;
		let count = 0;
		/** Turn debug logging on/off (General-settings Debug switch). */
		function setDebugLogging(next) {
			if (active === next) return;
			active = next;
			if (next) {
				fpsFrames = 0;
				fpsWindowStart = null;
				lastFrameAt = null;
				logDebug("state", "debug on");
			} else logDebug("state", "debug off");
		}
		/** Append one event; once the ring is full the oldest entry is dropped. */
		function logDebug(type, detail) {
			if (!active) return;
			ring[head] = {
				t: Date.now(),
				type,
				detail
			};
			head = (head + 1) % DEBUG_LOG_CAPACITY;
			if (count < 2e4) count += 1;
		}
		/** Chronological snapshot of the ring (oldest first). */
		function dumpDebugLogs() {
			if (count < 2e4) return ring.slice(0, count);
			return [...ring.slice(head), ...ring.slice(0, head)];
		}
		/** Drop all buffered entries. */
		function clearDebugLogs() {
			head = 0;
			count = 0;
		}
		/** Per-type counters over the current buffer plus the total count. */
		function debugLogStats() {
			const byType = {};
			for (const entry of dumpDebugLogs()) byType[entry.type] = (byType[entry.type] ?? 0) + 1;
			return {
				...byType,
				total: count
			};
		}
		let fpsFrames = 0;
		let fpsWindowStart = null;
		let lastFrameAt = null;
		/** Feed one animation frame (called from the behavior's rAF tick). Reports a
		*  rolling frame rate once per second and flags frame gaps over 200ms — jank,
		*  or a frozen / backgrounded tab. */
		function tickDebugFrame() {
			if (!active) return;
			const now = performance.now();
			if (fpsWindowStart === null) fpsWindowStart = now;
			fpsFrames += 1;
			if (lastFrameAt !== null) {
				const gap = now - lastFrameAt;
				if (gap > 200) logDebug("jank", `${Math.round(gap)}ms`);
			}
			lastFrameAt = now;
			const elapsed = now - fpsWindowStart;
			if (elapsed >= 1e3) {
				logDebug("fps", `${Math.round(fpsFrames * 1e3 / elapsed)}`);
				fpsFrames = 0;
				fpsWindowStart = null;
			}
		}
		const PROBE_KEY = "__DSH_SCROLL_FLOW_DEBUG__";
		/** Expose the ring on `window` for live inspection (devtools / automation). */
		function installDebugProbe() {
			if (typeof window === "undefined") return;
			const probe = {
				active: () => active,
				logs: dumpDebugLogs,
				clear: clearDebugLogs,
				stats: debugLogStats,
				capacity: DEBUG_LOG_CAPACITY
			};
			try {
				Object.defineProperty(window, PROBE_KEY, {
					configurable: true,
					value: probe
				});
			} catch {
				window[PROBE_KEY] = probe;
			}
		}
		//#endregion
		//#region src/client/policy.ts
		/**
		* Live preference policy for the streaming scroll animation. Preferences are
		* persisted to browser localStorage (the Host settings transport turned out to
		* be a dead end for these per-user UI toggles — writes never reached the
		* document, so a refresh lost the switch state). localStorage is the single
		* durable source of truth; the snapshot stores mirror its `enabled` and
		* `debug` fields so both registered surfaces (the settings section and the
		* dock behavior) subscribe through one stable source, and writes flow back
		* through `saveLocal`. The `debug` mirror also drives the debug-logger gate.
		*/
		/** localStorage key holding the JSON { enabled, debug } preference blob. */
		const STORAGE_KEY = "ui-scroll-flow";
		/** Read the persisted preference blob; returns {} on absence or corruption. */
		function loadLocal() {
			if (typeof window === "undefined") return {};
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				return typeof parsed === "object" && parsed !== null ? parsed : {};
			} catch {
				return {};
			}
		}
		/** Persist both preferences; a failing write (private mode, quota) only costs
		*  this session's persistence — the in-memory stores still hold the state. */
		function saveLocal(value) {
			if (typeof window === "undefined") return;
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
			} catch {}
		}
		/**
		* Preference policy: localStorage-backed mirror of the two switches.
		*/
		var ScrollFlowPolicy = class {
			/** Live `enabled` mirror (stable observable source for both slots). */
			enabled;
			/** Live `debug` mirror (settings-section Debug switch). */
			debug;
			constructor() {
				const saved = loadLocal();
				this.enabled = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(typeof saved.enabled === "boolean" ? saved.enabled : true);
				this.debug = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(typeof saved.debug === "boolean" ? saved.debug : false);
				setDebugLogging(this.debug.getSnapshot());
			}
			/** Turn the streaming scroll animation on or off. */
			setEnabled(enabled) {
				if (this.enabled.getSnapshot() === enabled) return;
				this.enabled.set(enabled);
				saveLocal({
					enabled,
					debug: this.debug.getSnapshot()
				});
			}
			/** Turn the debug logger on or off. */
			setDebug(debug) {
				if (this.debug.getSnapshot() === debug) return;
				this.debug.set(debug);
				setDebugLogging(debug);
				saveLocal({
					enabled: this.enabled.getSnapshot(),
					debug
				});
			}
		};
		//#endregion
		//#region node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region \0dsh-css:/mnt/TY/dsh/dsh-web-scroll-flow/src/client/ScrollFlowSection.module.css.mjs
		const css$1 = ".C0W3VW_section{flex-direction:column;gap:16px;width:100%;padding:8px 0;display:flex}.C0W3VW_heading{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}.C0W3VW_rows{flex-direction:column;display:flex}.C0W3VW_row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.C0W3VW_rows>:last-child{border-bottom:none}.C0W3VW_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.C0W3VW_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.C0W3VW_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.C0W3VW_switch{cursor:pointer;background:0 0;border:none;border-radius:14px;flex:none;justify-content:center;align-items:center;width:40px;height:28px;padding:0;display:inline-flex}.C0W3VW_switch:hover .C0W3VW_track{background:var(--dsw-alias-interactive-bg-hover)}.C0W3VW_track{background:var(--dsw-alias-border-l2);width:36px;height:20px;transition:background-color .12s var(--ds-ease-in-out);border-radius:10px;flex:none;display:inline-block;position:relative}.C0W3VW_thumb{background:var(--dsw-alias-bg-layer-1);width:14px;height:14px;transition:transform .12s var(--ds-ease-in-out);border-radius:50%;position:absolute;top:3px;left:3px;box-shadow:0 1px 2px #0000003d}.C0W3VW_trackOn{background:var(--dsw-alias-state-business-primary)}.C0W3VW_trackOn .C0W3VW_thumb{transform:translate(16px)}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-scroll-flow/ScrollFlowSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-scroll-flow";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var ScrollFlowSection_module_css_default = {
			"title": "C0W3VW_title",
			"switch": "C0W3VW_switch",
			"row": "C0W3VW_row",
			"rowText": "C0W3VW_rowText",
			"section": "C0W3VW_section",
			"rows": "C0W3VW_rows",
			"heading": "C0W3VW_heading",
			"desc": "C0W3VW_desc",
			"track": "C0W3VW_track",
			"trackOn": "C0W3VW_trackOn",
			"thumb": "C0W3VW_thumb"
		};
		//#endregion
		//#region src/client/ScrollFlowSection.tsx
		/**
		* Scroll-flow settings section: one dedicated menu entry under Settings that
		* hosts the streaming scroll animation switch and the Debug-log switch. The
		* section renders its own page chrome (heading + rows); the nav label arrives
		* from the registrant via `section.nav`.
		*/
		/** One preference row: copy pair plus the switch control. */
		function SwitchRow({ checked, title, description, onToggle }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ScrollFlowSection_module_css_default.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ScrollFlowSection_module_css_default.rowText,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: ScrollFlowSection_module_css_default.title,
						children: title
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: ScrollFlowSection_module_css_default.desc,
						children: description
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "switch",
					"aria-checked": checked,
					className: ScrollFlowSection_module_css_default.switch,
					onClick: onToggle,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: clsx(ScrollFlowSection_module_css_default.track, checked && ScrollFlowSection_module_css_default.trackOn),
						"aria-hidden": "true",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: ScrollFlowSection_module_css_default.thumb })
					})
				})]
			});
		}
		/**
		* Render the scroll-flow settings page: heading plus the animation and
		* Debug-log switches.
		* @param props - composed Settings slot props.
		* @returns the settings section.
		*/
		function ScrollFlowSection({ useEnabled, useDebug, setEnabled, setDebug, t }) {
			const enabled = useEnabled((value) => value);
			const debug = useDebug((value) => value);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ScrollFlowSection_module_css_default.section,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: ScrollFlowSection_module_css_default.heading,
					children: t("section.nav")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ScrollFlowSection_module_css_default.rows,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
						checked: enabled,
						title: t("settings.title"),
						description: t("settings.description"),
						onToggle: () => {
							setEnabled(!enabled);
						}
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
						checked: debug,
						title: t("settings.debugTitle"),
						description: t("settings.debugDescription"),
						onToggle: () => {
							setDebug(!debug);
						}
					})]
				})]
			});
		}
		//#endregion
		//#region \0dsh-css:/mnt/TY/dsh/dsh-web-scroll-flow/src/client/ScrollFlowBehavior.module.css.mjs
		const css = ".Q_EsIG_anchor{display:none}[data-conversation-scroll][data-scroll-flow]{scroll-behavior:smooth}[data-conversation-scroll][data-scroll-flow] [data-follow-end]{scroll-behavior:auto}[data-conversation-scroll][data-scroll-flow] [data-chat-flow]>[role=status]{order:1}@media (prefers-reduced-motion:reduce){[data-conversation-scroll][data-scroll-flow]{scroll-behavior:auto}}";
		const tagId = "@deepseek-ai/dsh-client-ui-scroll-flow/ScrollFlowBehavior.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-scroll-flow";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ScrollFlowBehavior_module_css_default = { "anchor": "Q_EsIG_anchor" };
		//#endregion
		//#region src/client/ScrollFlowBehavior.tsx
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
		/** The conversation scrollport tag ConversationRoot paints on its scrollBody. */
		const SCROLLPORT_SELECTOR = "[data-conversation-scroll]";
		/** The tag this plugin toggles on the resolved scrollport. */
		const SCROLL_FLOW_ATTRIBUTE = "data-scroll-flow";
		/** The flow column inside the scrollport; new messages, tool calls, and
		* reasoning rows are its direct or descendant children. */
		const FLOW_COLUMN_SELECTOR = "[data-chat-flow]";
		/** ChatView counts the scrollport as pinned at the bottom within this gap
		* (FOLLOW_THRESHOLD + 1); a glide with a larger gap is the flip condition. */
		const AT_BOTTOM_GAP = 25;
		/** CSS selector for the running-turn status label inside the flow column. */
		const STATUS_SELECTOR = "[data-chat-flow] > [role=\"status\"]";
		/** Maximum visual pin compensation, px. A high-refresh (600Hz) display makes
		*  the CSS smooth glide's fixed ~500ms duration lag behind content that grows
		*  faster than one commit per animation — steady-state lag of 30–60px on large
		*  streams. The cap covers that range while the view is following; beyond it
		*  (reader territory) the pin is released entirely (followingRef gates it), so
		*  the label moves naturally instead of being yanked. */
		const PIN_CAP = 80;
		/** Sub-pixel dead zone: lags ≤ this get no transform at all, so label-text
		*  churn (the Deep-diving elapsed-time counter re-renders every second, and
		*  pending labels swap in) cannot toggle a 1px pin on and off. */
		const PIN_DEAD_ZONE = .5;
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
		function pinStatusLabel(scrollport) {
			const lag = scrollport.scrollHeight - scrollport.clientHeight - scrollport.scrollTop;
			if (lag <= PIN_DEAD_ZONE) return "";
			return `translateY(${-Math.min(lag, PIN_CAP)}px)`;
		}
		/** The collapsed Think summary's line-end follow element (ReasoningRow paints
		* this while its block is the streaming tail). */
		const FOLLOW_SELECTOR = "[data-follow-end]";
		/** Fade-in duration for newly mounted flow rows. */
		const FADE_IN_DURATION = 220;
		/** Markdown block tags MarkdownText paints as independent rows (a paragraph,
		* list item, fence, quote, heading, table, footnote section, …). Together
		* with the two data markers they define "one row" for the fade-in. */
		const ROW_LEVEL_TAGS = /* @__PURE__ */ new Set([
			"P",
			"LI",
			"PRE",
			"BLOCKQUOTE",
			"H1",
			"H2",
			"H3",
			"H4",
			"H5",
			"H6",
			"UL",
			"OL",
			"TABLE",
			"FIGURE",
			"SECTION",
			"HR"
		]);
		/** One row of the chat flow: a flow item (message / tool call), a collapsed
		* reasoning row, or a Markdown block row inside a message. Inline bits
		* (spans, icons, code internals) are not rows and never animate. Expanded
		* thinking bodies are deliberately NOT rows: their text is one bare node
		* that React rewrites on every streaming chunk, so any DOM we insert there
		* is deleted immediately (visible flicker) — they stay plain. The observer
		* only reports insertions inside the flow column, so no out-of-tree guard is
		* needed here. */
		function isRowLevel(el) {
			if (el.hasAttribute("data-chat-flow-key") || el.hasAttribute("data-follow-end")) return true;
			return ROW_LEVEL_TAGS.has(el.tagName);
		}
		/** The innermost content container of an expanded Think: the deepest DIV
		* inside `[data-variant="think"]` (not the Think root, not a nested flow
		* item). Some thinks render their body as bare text, others as Markdown
		* rows — both live in the deepest div, which is what the streaming bottom
		* shadow is applied to. The body's DOM is never restructured here, so
		* React's per-chunk text rewrites are safe. Collapsed thinks carry their
		* summary in a `[data-follow-end]` span and have no body — they return null
		* so they never get a shadow (or a split). */
		function findExpandedThinkBody(think) {
			if (think.querySelector("[data-follow-end]") !== null) return null;
			let best = null;
			for (const d of think.querySelectorAll("div")) {
				if (d === think) continue;
				if (d.hasAttribute("data-chat-flow-key")) continue;
				if (d.closest("[data-variant=\"think\"]") !== think) continue;
				best = d;
			}
			return best;
		}
		const thinkExpandedOnce = /* @__PURE__ */ new WeakSet();
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
		function animateThinkExpandHeight(body) {
			if (thinkExpandedOnce.has(body)) return;
			thinkExpandedOnce.add(body);
			if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
			const target = body.scrollHeight;
			if (target <= 0) return;
			body.style.height = "0px";
			body.style.overflow = "hidden";
			body.offsetHeight;
			const anim = body.animate([{ height: "0px" }, { height: `${target}px` }], {
				duration: 220,
				easing: "ease-out"
			});
			anim.onfinish = () => {
				body.style.height = "";
				body.style.overflow = "";
			};
		}
		/** Lightweight slide-in for a streaming expanded Think: content keeps
		* growing, so a fixed-height animation would clip it — a transform slide is
		* layout-free and safe. */
		function animateThinkSlideIn(body) {
			if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
			body.animate([{
				opacity: 0,
				transform: "translateY(12px)"
			}, {
				opacity: 1,
				transform: "translateY(0)"
			}], {
				duration: 200,
				easing: "ease-out"
			});
		}
		/** One-shot fade-in of a freshly mounted row via the Web Animations API
		* (no CSS keyframes needed, so a plain module stylesheet never leaks). The
		* element keeps its layout box from the first frame — history is pushed up
		* while the new row fades in. Reduced-motion users get a plain insert. */
		function fadeIn(el, delayMs = 0) {
			if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
			try {
				el.animate([{ opacity: 0 }, { opacity: 1 }], {
					duration: FADE_IN_DURATION,
					easing: "ease-out",
					delay: delayMs,
					fill: "both"
				});
				const tag = el.tagName;
				logDebug("fade", `row ${tag}${el.hasAttribute("data-follow-end") ? " fe" : el.hasAttribute("data-chat-flow-key") ? " flow" : ""}`);
			} catch {}
		}
		/** Row-by-row reveal of an expanded thinking body once it settles. The body
		* is one bare text node (no DOM rows), so the text is split into one element
		* per line and every line fades in from the top, one after another (30ms
		* apart). The split only runs while the Think is settled (`data-state="ok"`):
		* while streaming, React rewrites the body's text node on every chunk and
		* deletes any rows we insert (visible flicker), so streaming expansions get
		* the bottom shadow instead and the split runs once the turn finishes. */
		function revealThinkBodyLines(el) {
			if (el.querySelector("[data-scroll-flow-row]") !== null) return;
			const lines = (el.textContent ?? "").split("\n");
			if (lines.length <= 1) return;
			logDebug("fade", `think split lines=${lines.length}`);
			el.textContent = "";
			for (const [i, line] of lines.entries()) {
				const row = document.createElement("div");
				row.setAttribute("data-scroll-flow-row", "");
				row.style.flex = "0 0 100%";
				row.style.whiteSpace = "pre-wrap";
				row.style.boxSizing = "border-box";
				row.textContent = line ?? "";
				el.appendChild(row);
				fadeOnce(row, Math.min(i, 40) * 30);
			}
		}
		/** Fade target for a row marker: a collapsed reasoning summary's line-end
		* marker lives on an inline span — fade the whole Think row (icon + title +
		* summary) instead, so the "one line" fades as a unit. */
		function fadeRowTarget(el) {
			if (el.hasAttribute("data-follow-end")) return el.closest("[data-variant=\"think\"]") ?? el;
			return el;
		}
		/** An element only fades in once per short window, ever: a batch insert
		* reports the same row both as an added node and as a descendant of another
		* added node, and a frozen markdown block can appear in several mutation
		* entries while the message streams around it. Replaying the animation within
		* that window is what made collapsed reasoning rows strobe. A hard
		* "only once per lifetime" rule is too strict, though — React can re-mount a
		* row a moment later (moving it reports an insertion), and then a fresh row
		* appearing after the window must be allowed to fade in again. */
		const FADE_DEDUP_WINDOW_MS = 500;
		const fadedAt = /* @__PURE__ */ new WeakMap();
		function fadeOnce(el, delayMs = 0) {
			const last = fadedAt.get(el) ?? -Infinity;
			if (performance.now() - last < FADE_DEDUP_WINDOW_MS) return;
			fadedAt.set(el, performance.now());
			fadeIn(el, delayMs);
		}
		/** Time constant (ms) for the follow easing toward a small target delta — the
		* per-token increments. 30ms gives a visible ~90ms glide per write at any
		* refresh rate (easing is time-based, so a 600Hz panel animates just as
		* smoothly as 60Hz; a frame-count easing would finish in ~5ms there and look
		* like the old instant jump). */
		const FOLLOW_TAU_SLOW = 30;
		/** Time constant (ms) for large deltas (a whole line/paragraph landed at once):
		* catch up fast instead of trailing. */
		const FOLLOW_TAU_FAST = 10;
		/** |target - current| above which the fast time constant applies. */
		const FOLLOW_TAU_THRESHOLD = 100;
		/** Clamp the frame delta so a backgrounded tab's resumed first frame cannot
		* jump the easing to completion. */
		const FOLLOW_DT_MAX = 100;
		/** Monotonic time of the last follow advance (time-based easing needs dt). */
		let lastFollowAt = 0;
		const followStates = /* @__PURE__ */ new WeakMap();
		/** Debug sampling: log follow progress every N animation frames — one line of
		*  streaming per few frames would otherwise flood the 20k ring. */
		const FOLLOW_LOG_EVERY = 30;
		let followFrames = 0;
		/** Install an instance-level `scrollLeft` that records ReasoningRow's line-end
		* writes as a pending target instead of applying them. The element's own
		* programmatic writes (which scroll the summary in a real browser) keep
		* working through the saved native accessors, so nothing else is affected;
		* instance shadowing restores the prototype accessor on release. Returns null
		* when the platform exposes no accessor (nothing to intercept). */
		function interceptFollowScroll(el) {
			const existing = followStates.get(el);
			if (existing !== void 0) return existing;
			const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
			if (desc === void 0 || !("get" in desc) || !("set" in desc)) return null;
			const getter = desc.get;
			const setter = desc.set;
			const state = {
				read: () => getter.call(el),
				write: (value) => setter.call(el, value),
				pending: getter.call(el)
			};
			Object.defineProperty(el, "scrollLeft", {
				configurable: true,
				get: () => getter.call(el),
				set: (value) => {
					state.pending = value;
				}
			});
			followStates.set(el, state);
			lastFollowAt = 0;
			logDebug("follow", `intercept on (pos=${Math.round(state.pending)})`);
			return state;
		}
		/** Drop the instance shadow so ReasoningRow's writes land natively again
		* (instant end-of-stream reset, the pre-plugin behavior). */
		function releaseFollowScroll(el) {
			if (followStates.delete(el)) {
				delete el.scrollLeft;
				logDebug("follow", "intercept off");
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
		function advanceFollowScroll(el) {
			const state = interceptFollowScroll(el);
			if (state === null) return null;
			const current = state.read();
			const target = state.pending;
			if (Math.abs(target - current) <= .5) return current;
			const now = performance.now();
			const dt = lastFollowAt === 0 ? 16.7 : Math.min(now - lastFollowAt, FOLLOW_DT_MAX);
			lastFollowAt = now;
			const tau = Math.abs(target - current) > FOLLOW_TAU_THRESHOLD ? FOLLOW_TAU_FAST : FOLLOW_TAU_SLOW;
			const next = current + (target - current) * (1 - Math.exp(-dt / tau));
			state.write(next);
			followFrames += 1;
			if (followFrames % FOLLOW_LOG_EVERY === 0) logDebug("follow", `anim pos=${Math.round(next)} target=${Math.round(target)} dt=${Math.round(dt)}`);
			return next;
		}
		/**
		* Toggle the smooth-scroll tag on the owning conversation scrollport while
		* streaming is active and the preference is enabled, and shield the chat
		* view's follow ledger from its own glide events.
		* @param props - composed dock slot props.
		* @returns a hidden anchor element (no visible UI).
		*/
		function ScrollFlowBehavior({ useEnabled, useSession }) {
			const enabled = useEnabled((value) => value);
			const running = useSession((snapshot) => snapshot.running);
			const anchorRef = (0, react.useRef)(null);
			const scrollportRef = (0, react.useRef)(null);
			const activeRef = (0, react.useRef)(false);
			activeRef.current = enabled && running;
			const suppressRef = (0, react.useRef)(false);
			const lastTopRef = (0, react.useRef)(0);
			/** Whether the user is (still) following the growing content at the bottom.
			* Reader scroll-up clears it; landing at the bottom sets it. The label pin
			* and the large-lag snap both gate on it, so a reader who scrolled away is
			* never yanked back down. */
			const followingRef = (0, react.useRef)(true);
			/** True while a snap-initiated glide is still in flight (lag is falling).
			* Re-snapping every frame would restart the smooth animation forever and the
			* scrollTop would never advance; snapping only when the lag stops falling
			* (stalled or growing) lets the glide land. */
			const snappingRef = (0, react.useRef)(false);
			const prevLagRef = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const anchor = anchorRef.current;
				if (anchor === null) return;
				const scrollport = anchor.closest(SCROLLPORT_SELECTOR);
				if (scrollport === null) return;
				const active = enabled && running;
				scrollport.toggleAttribute(SCROLL_FLOW_ATTRIBUTE, active);
				logDebug("state", `tag ${active ? "on" : "off"} (enabled=${enabled} running=${running})`);
				if (scrollportRef.current !== scrollport) {
					scrollportRef.current = scrollport;
					suppressRef.current = false;
					followingRef.current = true;
					lastTopRef.current = scrollport.scrollTop;
					snappingRef.current = false;
					prevLagRef.current = null;
					logDebug("state", "scrollport changed");
				}
				const observer = new MutationObserver((entries) => {
					for (const entry of entries) {
						if (entry.type === "attributes" && entry.attributeName === "data-state") continue;
						for (const node of entry.addedNodes) {
							if (node.nodeType !== 1) continue;
							const el = node;
							const handleThink = (t) => {
								const body = findExpandedThinkBody(t);
								logDebug("fade", `think ${t.getAttribute("data-state")} body=${body !== null}`);
								if (body === null) return;
								if (t.getAttribute("data-state") === "running") animateThinkSlideIn(body);
								else {
									if (body.querySelector("p, li, pre, [data-follow-end]") === null && body.children.length === 0) revealThinkBodyLines(body);
									animateThinkExpandHeight(body);
								}
							};
							if (el.getAttribute("data-variant") === "think") handleThink(el);
							else {
								const inside = el.closest("[data-variant=\"think\"]");
								if (inside !== null) handleThink(inside);
							}
							el.querySelectorAll("[data-variant=\"think\"]").forEach((n) => {
								handleThink(n);
							});
							if (isRowLevel(el)) fadeOnce(fadeRowTarget(el));
							el.querySelectorAll("*").forEach((n) => {
								const row = n;
								if (!isRowLevel(row)) return;
								fadeOnce(fadeRowTarget(row));
							});
						}
					}
				});
				const flow = scrollport.querySelector(FLOW_COLUMN_SELECTOR);
				if (enabled && flow !== null) observer.observe(flow, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["data-state"]
				});
				let raf = 0;
				let lastTransform = "";
				const tick = () => {
					raf = requestAnimationFrame(tick);
					tickDebugFrame();
					const port = scrollportRef.current;
					if (port === null) return;
					const floor = port.scrollHeight - port.clientHeight;
					const lag = floor - port.scrollTop;
					if (followingRef.current && lag > PIN_CAP) {
						if (!snappingRef.current || prevLagRef.current !== null && lag >= prevLagRef.current - .5) {
							port.scrollTop = floor;
							snappingRef.current = true;
							logDebug("snap", `floor=${floor} lag=${Math.round(lag)}`);
						}
						prevLagRef.current = lag;
					} else {
						snappingRef.current = false;
						prevLagRef.current = null;
					}
					const label = port.querySelector(STATUS_SELECTOR);
					if (label !== null) {
						const next = followingRef.current ? pinStatusLabel(port) : "";
						if (next !== lastTransform) {
							label.style.transform = next;
							lastTransform = next;
							logDebug("pin", next === "" ? "release" : next);
						}
					}
					const follow = port.querySelector(FOLLOW_SELECTOR);
					if (follow !== null) advanceFollowScroll(follow);
				};
				if (active) raf = requestAnimationFrame(tick);
				return () => {
					observer.disconnect();
					cancelAnimationFrame(raf);
					const label = scrollport.querySelector(STATUS_SELECTOR);
					if (label !== null) label.style.transform = "";
					const follow = scrollport.querySelector(FOLLOW_SELECTOR);
					if (follow !== null) releaseFollowScroll(follow);
					scrollport.removeAttribute(SCROLL_FLOW_ATTRIBUTE);
				};
			}, [enabled, running]);
			(0, react.useEffect)(() => {
				const scrollport = scrollportRef.current;
				if (scrollport === null) return;
				lastTopRef.current = scrollport.scrollTop;
				const onScroll = (event) => {
					const port = scrollportRef.current;
					if (port === null || event.target !== port) return;
					if (!activeRef.current && !suppressRef.current) return;
					const top = port.scrollTop;
					const gap = port.scrollHeight - port.clientHeight - top;
					if (top < lastTopRef.current - .5) followingRef.current = false;
					if (gap <= AT_BOTTOM_GAP) followingRef.current = true;
					if (suppressRef.current) {
						if (top < lastTopRef.current - .5 || gap <= AT_BOTTOM_GAP) {
							suppressRef.current = false;
							logDebug("guard", `release (gap=${Math.round(gap)})`);
						} else {
							lastTopRef.current = top;
							event.stopImmediatePropagation();
							return;
						}
					} else if (gap > AT_BOTTOM_GAP && top > lastTopRef.current + .5) {
						suppressRef.current = true;
						lastTopRef.current = top;
						event.stopImmediatePropagation();
						logDebug("guard", `engage (gap=${Math.round(gap)})`);
						return;
					}
					lastTopRef.current = top;
				};
				window.addEventListener("scroll", onScroll, {
					capture: true,
					passive: true
				});
				return () => {
					window.removeEventListener("scroll", onScroll, { capture: true });
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				ref: anchorRef,
				className: ScrollFlowBehavior_module_css_default.anchor,
				"aria-hidden": "true"
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services for locale registration and the two slot contributions. */
		const inject = ["slots", "locale"];
		/**
		* Client plugin body: build the localStorage-backed preference policy,
		* register dictionaries, and contribute the settings section plus the dock
		* behavior.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const policy = new ScrollFlowPolicy();
			installDebugProbe();
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-scroll-flow: dictionaries");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "scroll-flow",
				order: 100,
				label: () => t("section.nav"),
				locale: NS,
				inject: () => ({
					hooks: {
						enabled: policy.enabled,
						debug: policy.debug
					},
					setEnabled: (enabled) => {
						policy.setEnabled(enabled);
					},
					setDebug: (debug) => {
						policy.setDebug(debug);
					}
				})
			}, ScrollFlowSection));
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "scroll-flow",
				order: 10,
				locale: NS,
				inject: () => ({ hooks: { enabled: policy.enabled } })
			}, ScrollFlowBehavior));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
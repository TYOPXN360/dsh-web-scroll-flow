import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
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
export declare function pinStatusLabel(scrollport: HTMLElement): string;
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
export declare function advanceFollowScroll(el: HTMLElement): number | null;
/** Registration-side behavior face (the enabled hook rides the shared policy). */
export interface ScrollFlowBehaviorInjected {
    hooks: {
        /** Persisted streaming-animation preference bound as useEnabled. */
        enabled: SnapshotStore<boolean>;
    };
}
/** Full dock-entry props. */
export type ScrollFlowBehaviorProps = PropsRuntime<'conversation.composer.dock'> & InjectFace<ScrollFlowBehaviorInjected>;
/**
 * Toggle the smooth-scroll tag on the owning conversation scrollport while
 * streaming is active and the preference is enabled, and shield the chat
 * view's follow ledger from its own glide events.
 * @param props - composed dock slot props.
 * @returns a hidden anchor element (no visible UI).
 */
export declare function ScrollFlowBehavior({ useEnabled, useSession }: ScrollFlowBehaviorProps): import("react").JSX.Element;
//# sourceMappingURL=ScrollFlowBehavior.d.ts.map
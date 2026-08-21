/**
 * Streaming scroll animation preferences, persisted to browser localStorage
 * (see client/policy.ts). This module owns the wire shape and defaults; the
 * old Host-settings-scope binding was removed because its writes never
 * reached the user-settings document — a reload lost the switch state.
 */
/** Field carrying the streaming scroll animation switch. */
export declare const ENABLED_FIELD = "enabled";
/** Field carrying the Debug logging switch. */
export declare const DEBUG_FIELD = "debug";
/** Durable scroll-flow preference blob (JSON in localStorage). */
export interface ScrollFlowSettings {
    /** Whether streaming output animates the chat view's bottom-follow scroll. */
    enabled: boolean;
    /** Whether plugin events and frame rate are buffered for inspection. */
    debug: boolean;
}
/** Default keeps the animation on until the user opts out. */
export declare const DEFAULT_ENABLED = true;
/** Default keeps debug logging off. */
export declare const DEFAULT_DEBUG = false;
//# sourceMappingURL=settings.d.ts.map
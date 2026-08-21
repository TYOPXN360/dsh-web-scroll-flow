/**
 * Streaming scroll animation preferences, persisted to browser localStorage
 * (see client/policy.ts). This module owns the wire shape and defaults; the
 * old Host-settings-scope binding was removed because its writes never
 * reached the user-settings document — a reload lost the switch state.
 */
/** Field carrying the streaming scroll animation switch. */
export const ENABLED_FIELD = 'enabled';
/** Field carrying the Debug logging switch. */
export const DEBUG_FIELD = 'debug';
/** Default keeps the animation on until the user opts out. */
export const DEFAULT_ENABLED = true;
/** Default keeps debug logging off. */
export const DEFAULT_DEBUG = false;
//# sourceMappingURL=settings.js.map
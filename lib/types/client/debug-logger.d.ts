/**
 * Debug observability for the streaming scroll animation: a fixed-capacity
 * ring buffer of plugin events plus a frame-rate / jank tracker. Everything
 * is gated by `setDebugLogging` — driven by the General-settings Debug switch
 * — so with the switch off each call site costs only a boolean check. The
 * buffer is exposed on `window.__DSH_SCROLL_FLOW_DEBUG__` for live inspection
 * (devtools or automation), e.g. while reproducing an animation issue.
 */
/** Ring capacity: ~20k entries covers a continuous streaming session. */
export declare const DEBUG_LOG_CAPACITY = 20000;
/** One buffered plugin event. */
export interface DebugLogEntry {
    /** wall-clock timestamp (Date.now()). */
    t: number;
    /** event type: state | guard | pin | follow | snap | fade | fps | jank. */
    type: string;
    /** human-readable detail (may be absent). */
    detail: string | undefined;
}
/** Turn debug logging on/off (General-settings Debug switch). */
export declare function setDebugLogging(next: boolean): void;
/** Append one event; once the ring is full the oldest entry is dropped. */
export declare function logDebug(type: string, detail?: string): void;
/** Chronological snapshot of the ring (oldest first). */
export declare function dumpDebugLogs(): DebugLogEntry[];
/** Drop all buffered entries. */
export declare function clearDebugLogs(): void;
/** Per-type counters over the current buffer plus the total count. */
export declare function debugLogStats(): Record<string, number> & {
    total: number;
};
/** Feed one animation frame (called from the behavior's rAF tick). Reports a
 *  rolling frame rate once per second and flags frame gaps over 200ms — jank,
 *  or a frozen / backgrounded tab. */
export declare function tickDebugFrame(): void;
/** Probe surface exposed on `window.__DSH_SCROLL_FLOW_DEBUG__`. */
export interface ScrollFlowDebugProbe {
    /** Whether the Debug switch is currently on (logging active). */
    active: () => boolean;
    /** Chronological log snapshot (oldest first). */
    logs: () => DebugLogEntry[];
    /** Drop all buffered entries. */
    clear: () => void;
    /** Per-type counters plus total. */
    stats: () => ReturnType<typeof debugLogStats>;
    /** Ring capacity. */
    capacity: number;
}
/** Expose the ring on `window` for live inspection (devtools / automation). */
export declare function installDebugProbe(): void;
//# sourceMappingURL=debug-logger.d.ts.map
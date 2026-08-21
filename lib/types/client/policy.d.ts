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
import { type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
/**
 * Preference policy: localStorage-backed mirror of the two switches.
 */
export declare class ScrollFlowPolicy {
    /** Live `enabled` mirror (stable observable source for both slots). */
    readonly enabled: SnapshotStore<boolean>;
    /** Live `debug` mirror (settings-section Debug switch). */
    readonly debug: SnapshotStore<boolean>;
    constructor();
    /** Turn the streaming scroll animation on or off. */
    setEnabled(enabled: boolean): void;
    /** Turn the debug logger on or off. */
    setDebug(debug: boolean): void;
}
//# sourceMappingURL=policy.d.ts.map
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** Registration-side preference face shared by the section and the behavior. */
export interface ScrollFlowSectionInjected {
    hooks: {
        /** Persisted streaming-animation preference bound as useEnabled. */
        enabled: SnapshotStore<boolean>;
        /** Persisted Debug-logging preference bound as useDebug. */
        debug: SnapshotStore<boolean>;
    };
    /** Change the streaming-animation preference. */
    setEnabled: (enabled: boolean) => void;
    /** Change the Debug-logging preference. */
    setDebug: (enabled: boolean) => void;
}
/** Full Settings-section props. */
export type ScrollFlowSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'scrollFlow'> & InjectFace<ScrollFlowSectionInjected>;
/**
 * Render the scroll-flow settings page: heading plus the animation and
 * Debug-log switches.
 * @param props - composed Settings slot props.
 * @returns the settings section.
 */
export declare function ScrollFlowSection({ useEnabled, useDebug, setEnabled, setDebug, t }: ScrollFlowSectionProps): import("react").JSX.Element;
//# sourceMappingURL=ScrollFlowSection.d.ts.map
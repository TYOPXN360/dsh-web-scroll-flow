import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** Registration-side preference face shared by the rows and the behavior. */
export interface ScrollFlowRowInjected {
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
/** Full Settings-row props. */
export type ScrollFlowRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'scrollFlow'> & InjectFace<ScrollFlowRowInjected>;
/**
 * Render the streaming scroll animation switch row and the Debug-log switch.
 * @param props - composed Settings slot props.
 * @returns the preference rows.
 */
export declare function ScrollFlowRow({ useEnabled, useDebug, setEnabled, setDebug, t }: ScrollFlowRowProps): import("react").JSX.Element;
//# sourceMappingURL=ScrollFlowRow.d.ts.map
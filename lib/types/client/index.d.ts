/**
 * Streaming scroll transition plugin, browser half: contributes a dedicated
 * Settings section (streaming scroll animation + Debug-log switches) and the
 * dock behavior that toggles smooth bottom-follow while a model streams. Both
 * surfaces share one preference policy persisted to browser localStorage.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type ScrollFlowKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Streaming scroll animation copy. */
        scrollFlow: ScrollFlowKey;
    }
}
export type { ScrollFlowSectionProps } from './ScrollFlowSection.tsx';
/** Required services for locale registration and the two slot contributions. */
export declare const inject: string[];
/**
 * Client plugin body: build the localStorage-backed preference policy,
 * register dictionaries, and contribute the settings section plus the dock
 * behavior.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map
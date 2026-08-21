import { en, NS, zh } from "./locales.js";
import { ScrollFlowPolicy } from "./policy.js";
import { installDebugProbe } from "./debug-logger.js";
import { ScrollFlowSection } from "./ScrollFlowSection.js";
import { ScrollFlowBehavior, } from "./ScrollFlowBehavior.js";
/** Required services for locale registration and the two slot contributions. */
export const inject = ['slots', 'locale'];
/**
 * Client plugin body: build the localStorage-backed preference policy,
 * register dictionaries, and contribute the settings section plus the dock
 * behavior.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    const policy = new ScrollFlowPolicy();
    installDebugProbe();
    const t = ctx.locale.bind(NS);
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-scroll-flow: dictionaries');
    // One dedicated Settings menu entry hosting both switches.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'scroll-flow',
        // After General (order 0); sections stack in nav order.
        order: 100,
        label: () => t('section.nav'),
        locale: NS,
        inject: () => ({
            hooks: { enabled: policy.enabled, debug: policy.debug },
            setEnabled: (enabled) => { policy.setEnabled(enabled); },
            setDebug: (debug) => { policy.setDebug(debug); },
        }),
    }, ScrollFlowSection));
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        // After the stats line; this entry renders no visible UI, so order only
        // keeps it out of the stats row's neighborhood.
        id: 'scroll-flow',
        order: 10,
        locale: NS,
        inject: () => ({
            hooks: { enabled: policy.enabled },
        }),
    }, ScrollFlowBehavior));
}
//# sourceMappingURL=index.js.map
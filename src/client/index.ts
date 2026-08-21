/**
 * Streaming scroll transition plugin, browser half: contributes a dedicated
 * Settings section (streaming scroll animation + Debug-log switches) and the
 * dock behavior that toggles smooth bottom-follow while a model streams. Both
 * surfaces share one preference policy persisted to browser localStorage.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: loads the ui-settings SlotMap declarations ('settings.section')
// and the ui-conversation SlotMap declarations ('conversation.composer.dock').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh, type ScrollFlowKey } from './locales.ts'
import { ScrollFlowPolicy } from './policy.ts'
import { installDebugProbe } from './debug-logger.ts'
import { ScrollFlowSection, type ScrollFlowSectionInjected } from './ScrollFlowSection.tsx'
import {
  ScrollFlowBehavior, type ScrollFlowBehaviorInjected,
} from './ScrollFlowBehavior.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Streaming scroll animation copy. */
    scrollFlow: ScrollFlowKey
  }
}

export type { ScrollFlowSectionProps } from './ScrollFlowSection.tsx'

/** Required services for locale registration and the two slot contributions. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: build the localStorage-backed preference policy,
 * register dictionaries, and contribute the settings section plus the dock
 * behavior.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const policy = new ScrollFlowPolicy()
  installDebugProbe()
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-scroll-flow: dictionaries')

  // One dedicated Settings menu entry hosting both switches.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'scroll-flow',
    // After General (order 0); sections stack in nav order.
    order: 100,
    label: () => t('section.nav'),
    locale: NS,
    inject: (): ScrollFlowSectionInjected => ({
      hooks: { enabled: policy.enabled, debug: policy.debug },
      setEnabled: (enabled) => { policy.setEnabled(enabled) },
      setDebug: (debug) => { policy.setDebug(debug) },
    }),
  }, ScrollFlowSection))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    // After the stats line; this entry renders no visible UI, so order only
    // keeps it out of the stats row's neighborhood.
    id: 'scroll-flow',
    order: 10,
    locale: NS,
    inject: (): ScrollFlowBehaviorInjected => ({
      hooks: { enabled: policy.enabled },
    }),
  }, ScrollFlowBehavior))
}

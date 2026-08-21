/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-scroll-flow`.
 * @module @deepseek-ai/dsh-client-ui-scroll-flow/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-scroll-flow'

/** Cordis companion plugin name. */
export const name = 'client-ui-scroll-flow-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns one persisted preference
 * (streaming scroll animation) and two slot registrations; both prove their
 * disposal through the HMR-safety spec, and the preference rides the
 * settings-scope transport with no cross-plugin mutable state of its own.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

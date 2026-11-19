/**
 * magpie's provider allowances inside DeepSeek Harness.
 *
 * magpie is the local model router this Harness may already be pointed at: it
 * owns the model choice of every agent on the machine, and it reads each
 * agent's subscription and API allowance. This plugin surfaces just that
 * allowance, in one place: a page in the right sidebar listing every account
 * and every allowance window, with when it resets and — where magpie reports
 * one — when it expires.
 *
 * The plugin registers **no agent tool and no prompt section**. It answers no
 * question the model asks; it answers one the person glances at. Nothing here
 * writes to magpie, so every control magpie offers (changing DSH's model,
 * applying a profile) still happens through magpie's own app.
 *
 * The Host half exists only to serve the browser: it makes one read of magpie's
 * loopback gateway on the panel's behalf and projects the response into a shape
 * the page renders without knowing magpie's format.
 *
 * @module dsh-magpie-quota
 */

import { resolveConfig } from './src/config.js'
import { buildRoutes } from './src/routes.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'magpie-quota'

/**
 * Required services: none.
 *
 * `connection` is needed only for the browser panel, so it is requested
 * dynamically below. A profile with no web carrier loads this plugin and
 * registers nothing, which is the correct outcome — there is no surface to
 * serve.
 */
export const inject = []

/**
 * Register the panel's route when the profile serves a browser.
 * @param ctx - Plugin context.
 * @param raw - The loader row's `config`, if any.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  if (!config.enabled) return
  ctx.inject(['connection'], connectionCtx => {
    for (const route of buildRoutes(config)) {
      connectionCtx.effect(
        () => connectionCtx.connection.fetch.register(route),
        `magpie-quota: ${route.path}`,
      )
    }
  })
}

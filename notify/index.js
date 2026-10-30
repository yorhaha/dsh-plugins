/**
 * PushPlus push notifications for DeepSeek Harness.
 *
 * Gives the agent one tool that pushes a message to the user's phone, ships the
 * Plugins-page row configuration that manages the PushPlus tokens it delivers
 * to, and provides the `notify` service other bundles use for the same delivery.
 * Tokens are secrets, so they live in the harness credential store rather than in
 * configuration, and any number of them may be configured: every message goes to
 * every target.
 *
 * The tool and the service share one send path (`src/service.js`), so a message
 * the calendar composes is truncated, fanned out, and reported exactly like one
 * the model composes.
 *
 * Ported from yorha's `core/yorha/notify.py`, including its property that a token
 * never reaches an error message, a log line, or a result.
 *
 * @module dsh-notify
 */

import { buildSettingsApi, registerBridge } from './src/bridge.js'
import { resolveConfig } from './src/config.js'
import { createNotifyService } from './src/service.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'notify'

/**
 * The service this plugin provides. Declared so the Loader and dependents can see
 * it without guessing; the value itself is registered by {@link apply}.
 */
export const provide = 'notify'

/** Services this plugin cannot run without. */
export const inject = ['tools', 'credentials']

/**
 * Register the plugin: provide the delivery service, expose the notification
 * tool over it, then the settings route.
 *
 * @param ctx - Plugin context.
 * @param raw - The loader row's `config`, if any.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  const notify = createNotifyService({ provider: ctx.credentials, config, logger: ctx.logger })
  // Owned by this plugin's fiber: a disabled or unloaded notify bundle removes
  // the service, and dependents that look it up at delivery time fall back.
  ctx.provide('notify', notify)
  for (const tool of buildTools({ notify, config })) {
    ctx.tools.register(tool)
  }
  // Owned by this plugin's fiber: the route appears whenever Connection mounts,
  // and goes away with the plugin.
  registerBridge(ctx, buildSettingsApi({ provider: ctx.credentials, config, logger: ctx.logger }))
}

/**
 * DeepXiv research access for DeepSeek Harness.
 *
 * Gives the agent two tools over the full-text corpora behind
 * `https://data.rag.ac.cn`: hybrid retrieval across arXiv, bioRxiv, and medRxiv,
 * and progressive reading of one arXiv or PMC paper. It ships the Plugins-page
 * row configuration that manages the DeepXiv token the requests authenticate
 * with. The token lives in the harness credential store rather than in
 * configuration, and it never reaches a tool result or a log line; that page
 * shows it in the clear.
 *
 * @module dsh-deepxiv
 */

import { DeepXivClient } from './src/api.js'
import { buildSettingsApi, registerBridge } from './src/bridge.js'
import { resolveConfig } from './src/config.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'deepxiv'

/** Services this plugin cannot run without. */
export const inject = ['tools', 'credentials']

/**
 * Register the plugin: expose the two research tools, then the settings route.
 * @param ctx - Plugin context.
 * @param raw - The loader row's `config`, if any.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  const client = new DeepXivClient(config)
  for (const tool of buildTools({ client, provider: ctx.credentials, config, logger: ctx.logger })) {
    ctx.tools.register(tool)
  }
  // Owned by this plugin's fiber: the route appears whenever Connection mounts,
  // and goes away with the plugin.
  registerBridge(ctx, buildSettingsApi({ client, provider: ctx.credentials, config, logger: ctx.logger }))
}

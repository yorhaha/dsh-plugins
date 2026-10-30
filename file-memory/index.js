/**
 * Pure-filesystem memory for DeepSeek Harness.
 *
 * Two audiences need to be told that memory exists, and each needs a different
 * mechanism:
 *
 * - **The model** gets one constant prompt section naming the memory directory
 *   and how to search it. The section is registered globally rather than per
 *   agent, because its text depends only on configuration. It deliberately
 *   lists no memories: enumeration is the model's own `glob`/`grep` work.
 * - **The user** gets a browser panel, served through two exact Fetch routes on
 *   the shared API channel. The panel is why this plugin has a Host half at all.
 *
 * The plugin registers NO agent tool. Reading, searching, writing, and editing
 * memory all go through the ordinary file tools the harness already provides —
 * a dedicated memory tool would only re-wrap the filesystem, and the browser's
 * file operations travel over HTTP rather than through the model's tool surface.
 *
 * The route registration is optional: a profile without a `connection` service
 * still gets the prompt section, because the panel is not what makes the model
 * aware of memory.
 *
 * @module dsh-file-memory
 */

import { mkdirSync } from 'node:fs'

import { resolveConfig } from './src/config.js'
import { memoryGuidance } from './src/guidance.js'
import { buildRoutes } from './src/routes.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'file-memory'

/**
 * Required services.
 *
 * `systemPrompt` is declared here rather than reached through `ctx.inject`,
 * because injecting the prompt section IS this plugin's purpose: without the
 * service there is nothing to degrade to, and a load that silently registered
 * nothing would look like a working install while the model never learns that
 * memory exists.
 *
 * `connection` is deliberately absent. It is needed only for the browser panel,
 * so it is requested dynamically below, and a profile without it still gets the
 * prompt section.
 */
export const inject = ['systemPrompt']

// This plugin declares no schemastery `Config` (it carries no dependencies), so
// `resolveConfig` validates the row's `config` itself and fails the load on a
// bad value. The row's accepted keys and their defaults are documented in
// `cordis.patch.yml`.

/**
 * Register the prompt section, then the browser routes when a connection exists.
 * @param ctx - Plugin context.
 * @param raw - The loader row's `config`, if any.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  if (!config.enabled) return

  // A fresh profile has no memory directory yet. The panel cannot save its first
  // note until the root exists, so create it at load and fail loudly if it cannot
  // be created rather than serving a page that cannot bootstrap.
  mkdirSync(config.root, { recursive: true })

  // Constant text: it depends only on the root resolved above, so the
  // assembled prompt is byte-identical between turns and never invalidates the
  // prefix cache. `section()` registers its own effect and returns the disposer,
  // so no outer `ctx.effect` is needed here.
  //
  // Placed just after the tool sections, because the guidance tells the model
  // which tools to reach for and reads as a footnote to them. The order table
  // has no memory slot of its own, so the offset is from the nearest one.
  ctx.systemPrompt.section({
    name: 'file-memory',
    order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS') + 10,
    text: memoryGuidance(config.root),
  })

  // Routes are optional: the section above is what makes memory discoverable,
  // and it must keep working in a profile that serves no browser.
  ctx.inject(['connection'], connectionCtx => {
    for (const route of buildRoutes(config)) {
      connectionCtx.effect(
        () => connectionCtx.connection.fetch.register(route),
        `file-memory: ${route.path}`,
      )
    }
  })
}

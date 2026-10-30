/**
 * WeChat export batches for DeepSeek Harness.
 *
 * Imports the batches the WeChat exporter writes on this machine — one JSONL
 * file per conversation plus `export_meta.json` — into a local SQLite corpus
 * that survives restarts, exposes the messages to the agent as search over
 * conversations and time, and ships the plugin page that reports where the
 * pipeline stands and imports a batch.
 *
 * Ported from yorha's `core/yorha/connectors/wechat`: the batch contract, the
 * validation rules, the two identity strategies, the read-only pipeline probe,
 * and its signal vocabulary are kept. The persistence layer is not — see the
 * README — and neither is the runs table, the raw object store, or the
 * materialized contacts index, none of which have a job here.
 *
 * @module dsh-wechat
 */

import { registerBridge } from './src/bridge.js'
import { Config, resolveOptions, validate } from './src/config.js'
import { errorCode } from './src/errors.js'
import { WechatImporter } from './src/importer.js'
import { ensureTask, recreateTask, scheduleOf, taskState } from './src/schedule.js'
import { pipelineStatus } from './src/status.js'
import { openStore } from './src/store.js'
import { LocalClock } from './src/time.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wechat'

/** Services this plugin cannot run without. */
export const inject = ['tools']

export { Config }

/**
 * Register the plugin: open the corpus, then expose it to the agent and to this
 * bundle's row page.
 *
 * @param ctx - Plugin context.
 * @param config - The loader row's configuration.
 * @returns the effect that releases the corpus when the plugin unloads.
 */
export function apply(ctx, config) {
  validate(config)
  return ctx.effect(async () => {
    const options = resolveOptions(config)
    const clock = new LocalClock(options.timeZone)
    const logger = ctx.logger
    const store = await openStore({ path: options.databasePath, logger })
    let importer
    try {
      importer = new WechatImporter({ store, options, clock, logger })
      /** The last finished import, for the page's result panel. */
      let lastResult = null

      for (const tool of buildTools({ ctx, store, importer, options, clock, jobs: ctx.get('jobs'), logger })) {
        ctx.tools.register(tool)
      }

      /**
       * Everything the plugin page may ask for. Values and states only: the page
       * receives no message body, no key value, and no conversation list, and the
       * only mutations it can make are starting an import of a batch that is
       * already in the archive and restoring the recurring import task.
       */
      const settingsApi = {
        status: async () => ({
          pipeline: pipelineStatus({ store, options, clock, batches: importer.listBatches() }),
          batches: importer.listBatches().map((row) => ({
            batch: row.batch,
            state: row.state,
            exportTime: row.exportTime,
            chatCount: row.chatCount,
            totalMessages: row.totalMessages,
            invalid: row.invalid,
            importedAt: row.importedAt,
            includeGroups: row.includeGroups,
            storedMessages: row.storedMessages,
            groupSkipped: row.groupSkipped,
            generated: row.generated,
            updated: row.updated,
            unchanged: row.unchanged,
            suspectedReplacements: row.suspectedReplacements,
          })),
          config: {
            exporterDir: options.exporterDir,
            exportDir: options.exportDir,
            keysFile: options.keysFile,
            batchesDir: options.batchesDir,
            databasePath: options.databasePath,
            wechatDbParent: options.wechatDbParent,
            wechatDbDir: options.wechatDbDir,
            includeGroups: options.includeGroups,
            inlineImportLimit: options.inlineImportLimit,
            timeZone: options.timeZone,
          },
          import: {
            running: importer.busy,
            progress: importer.progress,
            lastResult,
          },
          schedule: await taskState(ctx),
        }),
        startImport: async (request) => {
          if (importer.closed) return { started: false, reason: 'closing' }
          if (importer.busy) return { started: false, reason: 'busy' }
          const batch = typeof request?.batch === 'string' ? request.batch : ''
          if (batch === '') return { started: false, reason: 'batch_required' }
          const includeGroups = request?.includeGroups === true
          void importer
            .queue(() =>
              importer.run({
                batch,
                includeGroups,
                onProgress: (event) => {
                  lastResult = { ...lastResult, progress: event }
                },
              }),
            )
            .then((result) => {
              lastResult = { ...result, progress: null, finishedAt: clock.nowIso() }
            })
            .catch((error) => {
              const code = errorCode(error)
              logger?.warn?.(`wechat: import of ${batch} failed: ${code}`)
              lastResult = {
                ok: false,
                status: 'failed',
                batch,
                reason: `${code}: ${error.message}`,
                finishedAt: clock.nowIso(),
                progress: null,
              }
            })
          return { started: true }
        },
        /**
         * The conversation the task reports into.
         *
         * The page cannot know a Session id and the schedule service requires
         * one, so the newest conversation stands in when the caller names none
         * — the same rule the agent tool applies, taken from the agent instead
         * of the page.
         *
         * @param requested - a Session id the page supplied, if any.
         * @returns the session id.
         * @throws when no conversation can be resolved.
         */
        sessionFor: async (requested) => {
          if (typeof requested === 'string' && requested !== '') return requested
          const controller = ctx.get('sessionController')
          if (controller === undefined) {
            throw Object.assign(new Error('wechat: no conversation is available to bind the task to'), { code: 'no_conversation_available' })
          }
          const { items } = await controller.list({}, undefined)
          const newest = items?.[0]?.sessionId
          if (typeof newest !== 'string' || newest === '') {
            throw Object.assign(new Error('wechat: no conversation is available to bind the task to'), { code: 'no_conversation_available' })
          }
          return newest
        },
        ensureSchedule: async (sessionId) => {
          if (scheduleOf(ctx) === undefined) return { status: 'unavailable', reason: 'schedule_unavailable' }
          const task = await ensureTask(ctx, sessionId, options)
          return { status: 'created', taskId: String(task.id), nextRunAt: task.scheduledAt }
        },
        recreateSchedule: async (sessionId) => {
          if (scheduleOf(ctx) === undefined) return { status: 'unavailable', reason: 'schedule_unavailable' }
          const task = await recreateTask(ctx, sessionId, options)
          return { status: 'recreated', taskId: String(task.id), nextRunAt: task.scheduledAt }
        },
      }

      // Owned by this plugin's fiber: the route appears whenever Connection
      // mounts, and goes away with the plugin.
      registerBridge(ctx, settingsApi)
    } catch (error) {
      // Registration can fail when the fiber unloads during async setup; the
      // corpus was already opened, so release it before the failure escapes.
      store.close()
      throw error
    }

    return async () => {
      // Stop accepting imports, then let one already running finish while the
      // corpus is still open. Closing it underneath an import aborts the
      // staging transaction and reports a failure that a re-run has to repair.
      importer.dispose()
      await importer.drained()
      store.close()
    }
  }, 'wechat:lifecycle')
}

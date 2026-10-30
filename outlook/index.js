/**
 * Outlook mail for DeepSeek Harness.
 *
 * Captures this account's own Outlook messages into a local SQLite corpus that
 * survives restarts, exposes it to the agent as search over time, and ships the
 * Plugins-page row configuration that manages the Azure app registration, the
 * sign-in, and the recurring capture.
 *
 * @module dsh-outlook
 */

import z from '@deepseek-ai/schemastery'

import { GraphAuth } from './src/auth.js'
import { registerBridge } from './src/bridge.js'
import { DEFAULT_CRON, ensureTask, recreateTask, taskState } from './src/schedule.js'
import { openStore } from './src/store.js'
import { OutlookSyncer } from './src/sync.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'outlook'

/** Services this plugin cannot run without. */
export const inject = ['tools', 'credentials']

/** Scopes removed from the request, because the sign-in client adds them itself. */
const RESERVED_SCOPES = new Set(['offline_access', 'openid', 'profile'])

/**
 * Plugin configuration.
 *
 * `clientId` and `tenant` are volatile: the Plugins page edits them through the
 * settings service, which writes them into the profile entry, so a deployment
 * that has not registered an application yet can still load the plugin and fill
 * them in. Both carry the shape the page also checks, so a refused value can
 * never be stored. Everything else is an ordinary field, because changing it
 * changes what is captured rather than only how the next request authenticates.
 */
export const Config = z.object({
  /** Credential-record slot under the plugin's own scope; one per account. */
  accountId: z.string().default('default').pattern(/^[a-z][a-z0-9-]*$/),
  /** Azure app registration client id; empty means "not configured yet". */
  clientId: z
    .string()
    .default('')
    .pattern(/^$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
    .volatile(),
  /** Authority tenant; `common` serves personal and work accounts. */
  tenant: z.string().default('common').pattern(/^[A-Za-z0-9.-]+$/).volatile(),
  /** Delegated Graph scopes to request. */
  scopes: z.array(z.string()).default(['Mail.Read']),
  /** Absolute path of the SQLite corpus. */
  databasePath: z.string().required(),
  /** Recurrence of the capture task, in the host's own time zone. */
  scheduleCron: z.string().default(DEFAULT_CRON),
  /** Days of mail the first capture takes; 0 means everything. */
  mailInitialDays: z.number().min(0).default(90),
  /** Folders a mail capture never stores, by Graph well-known alias or display name. */
  mailExcludeFolders: z.array(z.string()).default(['junkemail']),
  /** Days before the cursor that each capture re-reads. */
  reconcileDays: z.number().min(0).default(3),
  /** Pages one forward mail capture may walk. */
  mailMaxPages: z.number().min(1).default(60),
  /** Pages one `backfill` run may walk. */
  backfillMaxPages: z.number().min(1).default(20),
  /** Ceiling on the stored and indexed body of one record. */
  bodyMaxBytes: z.number().min(1024).default(262_144),
  /** Deadline of one Graph request, so a stalled connection cannot hang a capture. */
  requestTimeoutMs: z.number().min(1_000).default(30_000),
  /** IANA zone a search bound without an offset is read in; empty uses the host's. */
  timeZone: z.string().default(''),
  /** How long a device-code challenge stays usable while the user types it. */
  loginTimeoutSeconds: z.number().min(30).default(300),
})

/**
 * Reject configuration that the schema cannot express.
 *
 * The plugin loads either way, so this runs at load and fails there: a database
 * path that is empty, a scope list the sign-in client would reject, or a zone
 * name no formatter knows are all self-contained mistakes.
 *
 * @param config - Validated configuration.
 * @throws when a field is present but unusable.
 */
function validate(config) {
  if (typeof config.databasePath !== 'string' || config.databasePath.trim() === '') {
    throw new Error('outlook: config.databasePath must be a non-empty path')
  }
  if (config.scopes.filter((scope) => !RESERVED_SCOPES.has(scope.toLowerCase())).length === 0) {
    throw new Error('outlook: config.scopes must name at least one Graph scope besides offline_access, openid, and profile')
  }
  if (config.scheduleCron.trim().split(/\s+/).length !== 5) {
    throw new Error('outlook: config.scheduleCron must be a five-field cron expression')
  }
  if (config.timeZone !== '') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
    } catch {
      throw new Error(`outlook: config.timeZone "${config.timeZone}" is not an IANA zone name`)
    }
  }
}

/**
 * The host's own zone, so a deployment does not state what the machine knows.
 * @returns an IANA zone name.
 */
function hostTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * Register the plugin: open the corpus, then expose it to the agent and to this
 * bundle's row page.
 * @param ctx - Plugin context.
 * @param config - Validated plugin configuration.
 * @returns the effect that releases the corpus when the plugin unloads.
 */
export function apply(ctx, config) {
  validate(config)
  return ctx.effect(async () => {
    const store = await openStore({ path: config.databasePath, clock: Date.now, logger: ctx.logger })
    /** The zone times are asked for and written in, stated once for both. */
    const pluginZone = () => (config.timeZone === '' ? hostTimeZone() : config.timeZone)
    /** Authentication inputs, read live because the plugin page edits them. */
    const authSettings = () => ({
      clientId: config.clientId.get().trim(),
      tenant: config.tenant.get().trim() === '' ? 'common' : config.tenant.get().trim(),
      scopes: config.scopes,
      loginTimeoutSeconds: config.loginTimeoutSeconds,
    })
    /** Capture inputs, also live: a corpus window edit applies to the next run. */
    const captureSettings = () => ({
      ...authSettings(),
      bodyMaxBytes: config.bodyMaxBytes,
      initialDays: config.mailInitialDays,
      excludeFolders: config.mailExcludeFolders,
      reconcileDays: config.reconcileDays,
      mailMaxPages: config.mailMaxPages,
      backfillMaxPages: config.backfillMaxPages,
      requestTimeoutMs: config.requestTimeoutMs,
    })
    const auth = new GraphAuth({
      credentials: ctx.credentials,
      accountId: config.accountId,
      settings: authSettings,
      logger: ctx.logger,
      onSignedIn: async () => {
        await store.updateStatus({ authRequired: false })
      },
      onSignedOut: async () => {
        await store.updateStatus({ authRequired: false })
      },
    })
    const syncer = new OutlookSyncer({
      store,
      auth,
      settings: captureSettings,
      logger: ctx.logger,
    })

    // A capture can outlive the page that started it. The plugin owns this
    // signal so unloading stops the run before waiting for it to drain.
    const shutdown = new AbortController()

    for (const tool of buildTools({
      ctx,
      store,
      syncer,
      auth,
      jobs: ctx.get('jobs'),
      config,
      // A search bound names a day the way the user reads it, so the tool reads
      // it in the zone this deployment states rather than in UTC.
      zone: pluginZone,
      logger: ctx.logger,
      shutdownSignal: shutdown.signal,
    })) {
      try {
        ctx.tools.register(tool)
      } catch (error) {
        store.close()
        throw error
      }
    }

    /**
     * Everything the page may ask for. Values only: a page never receives a
     * token, and the two live fields are written through the settings service
     * rather than here.
     */
    const settingsApi = {
      status: () => describe(),
      beginLogin: () => auth.beginLogin(),
      loginState: () => auth.loginState(),
      cancelLogin: async () => {
        await auth.cancelLogin()
        return auth.loginState()
      },
      signOut: async () => {
        await auth.signOut()
      },
      sync: (options) => syncer.run({
        backfill: options?.backfill === true,
        trigger: 'manual',
        signal: options?.signal === undefined
          ? shutdown.signal
          : AbortSignal.any([options.signal, shutdown.signal]),
        onProgress: options?.onProgress,
      }),
      syncing: () => syncer.busy,
      syncReady: async () => {
        if (!auth.configured) return 'not_configured'
        try {
          return (await auth.authorized()) ? null : 'auth_required'
        } catch {
          // A record this plugin did not write is unusable, not fatal.
          return 'auth_required'
        }
      },
      // The only honest way to know whether the stored sign-in covers the
      // configured scopes: no call reports them, and the requested scope list
      // says only what a sign-in would ask for.
      grantedScopes: () => auth.grantedScopes(),
      ensureSchedule: async (sessionId) => {
        const task = await ensureTask(ctx, sessionId, config.scheduleCron, hostTimeZone())
        return { id: String(task.id), nextRunAt: task.scheduledAt }
      },
      recreateSchedule: async (sessionId) => {
        const task = await recreateTask(ctx, sessionId, config.scheduleCron, hostTimeZone())
        return { id: String(task.id), nextRunAt: task.scheduledAt }
      },
    }

    /**
     * Everything the plugin page displays.
     * @returns the settings-page view of this plugin.
     */
    async function describe() {
      const cursor = store.mailState()
      return {
        accountId: config.accountId,
        configured: auth.configured,
        config: {
          clientId: authSettings().clientId,
          tenant: authSettings().tenant,
          scopes: config.scopes,
          databasePath: config.databasePath,
          scheduleCron: config.scheduleCron,
          mailInitialDays: config.mailInitialDays,
        },
        authorized: await auth.authorized(),
        account: await auth.account(),
        sync: { ...store.status(), running: syncer.busy, progress: syncer.progress },
        mail: {
          count: store.count(),
          lastSuccessAt: cursor?.lastSuccessAt ?? null,
          lastErrorCode: cursor?.lastErrorCode ?? null,
          snapshotComplete: cursor?.snapshotComplete ?? null,
        },
        database: { path: store.path, bytes: await store.databaseBytes() },
        schedule: await taskState(ctx),
      }
    }

    // Owned by this plugin's fiber: the route appears whenever Connection
    // mounts, and goes away with the plugin.
    try {
      registerBridge(ctx, settingsApi)
    } catch (error) {
      store.close()
      throw error
    }

    return async () => {
      // Stop a capture the page or an agent started before waiting for it; a
      // run with no signal would otherwise hold unload for its whole page budget.
      shutdown.abort()
      // A pending challenge holds no database handle, but it does hold a timer
      // in the sign-in client, and it must not outlive the plugin.
      await auth.cancelLogin()
      await syncer.drained()
      store.close()
    }
  }, 'outlook:lifecycle')
}

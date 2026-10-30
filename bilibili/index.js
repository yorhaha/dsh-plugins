/**
 * Bilibili account data for DeepSeek Harness.
 *
 * Captures the signed-in account's own activity — watch history, watch later,
 * favorites, following, and own dynamics — into a local corpus that survives
 * restarts, exposes it to the agent as search over time, and ships the settings
 * page that manages the account and the recurring capture.
 *
 * @module dsh-bilibili
 */

import { registerBridge } from './src/bridge.js'
import { utcNowIso } from './src/client.js'
import { clearCookies, readCookies, writeCookies } from './src/credentials.js'
import { assertCron } from './src/cron.js'
import { QrLogin } from './src/login.js'
import { qrSvgDataUrl } from './src/qr.js'
import { DEFAULT_CRON, ensureTask, recreateTask, taskState } from './src/schedule.js'
import { STALE_AFTER_MS, openStore } from './src/store.js'
import { BilibiliSyncer } from './src/sync.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bilibili'

/** Services this plugin cannot run without. */
export const inject = ['tools', 'credentials', 'storageDomain']

/** Every configurable value with its default. */
const DEFAULT_CONFIG = {
  accountId: 'default',
  scheduleCron: DEFAULT_CRON,
  loginTimeoutSeconds: 180,
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/**
 * Resolve and validate the loader row's `config`.
 *
 * The plugin declares no schema library, so it validates its own row and fails
 * the load on a bad value rather than silently falling back to a default.
 *
 * @param raw - The `config` value the loader passed to `apply`, if any.
 * @returns the complete option set.
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('bilibili: config must be a mapping')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`bilibili: unknown config key "${key}"`)
  }
  const accountId = config.accountId ?? DEFAULT_CONFIG.accountId
  if (typeof accountId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(accountId)) {
    throw new Error('bilibili: config.accountId must be a lowercase credential-key segment')
  }
  const scheduleCron = assertCron(config.scheduleCron ?? DEFAULT_CONFIG.scheduleCron)
  const loginTimeoutSeconds = config.loginTimeoutSeconds ?? DEFAULT_CONFIG.loginTimeoutSeconds
  if (!Number.isInteger(loginTimeoutSeconds) || loginTimeoutSeconds < 30) {
    throw new Error('bilibili: config.loginTimeoutSeconds must be an integer of at least 30')
  }
  return { accountId, scheduleCron, loginTimeoutSeconds }
}

/**
 * Register the plugin: open the corpus, then expose it to the agent and to this
 * bundle's row page.
 * @param ctx - Plugin context.
 * @param raw - The loader row's `config`, if any.
 * @returns the effect that releases the corpus when the plugin unloads.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  return ctx.effect(async () => {
    const store = await openStore(ctx.storageDomain)
    const syncer = new BilibiliSyncer({
      store,
      readCredential: () => readCookies(ctx.credentials, config.accountId),
      logger: ctx.logger,
    })
    const login = new QrLogin({
      saveCookies: async (cookies) => {
        await writeCookies(ctx.credentials, config.accountId, cookies)
        // Sign-in already validated this session against upstream, so record the
        // identity it proved. Without this the account stays unknown until a
        // capture runs, and a page that gates capture on a known account could
        // never start one.
        const mid = typeof cookies.dedeuserid === 'string' && cookies.dedeuserid !== '' ? cookies.dedeuserid : null
        if (mid !== null) {
          await store.updateStatus({
            account: { mid, name: null, avatarUrl: null, checkedAt: utcNowIso() },
            authRequired: false,
            lastErrorCode: null,
          })
        }
      },
      timeoutSeconds: config.loginTimeoutSeconds,
      logger: ctx.logger,
    })

    for (const tool of buildTools({
      ctx,
      store,
      syncer,
      jobs: ctx.get('jobs'),
      logger: ctx.logger,
      config,
    })) {
      ctx.tools.register(tool)
    }

    /**
     * Everything the plugin page may ask for. Values only: a page never
     * receives a cookie, and cancelling a login is the only mutation a page can
     * make that this object does not also expose to the agent.
     */
    const settingsApi = {
      status: async () => ({
        account: store.status().account,
        authorized: (await readCookies(ctx.credentials, config.accountId).catch(() => undefined)) !== undefined,
        sync: syncStatus(store, syncer),
        datasets: datasetStatus(store),
        schedule: await taskState(ctx),
      }),
      beginLogin: async () => withQrImage(await login.begin()),
      loginState: () => withQrImage(login.snapshot),
      cancelLogin: () => login.cancel(),
      signOut: async () => {
        await login.cancel()
        // Stop a capture that still holds the credential read at its start, and
        // let it settle before the record disappears; otherwise its success
        // status would write the signed-out account back into the corpus.
        syncer.abort()
        await syncer.drained()
        await clearCookies(ctx.credentials, config.accountId)
        await store.updateStatus({ account: null, authRequired: false, lastErrorCode: null })
      },
      sync: async (options) => {
        const outcome = await syncer.run({
          datasets: options?.datasets,
          backfill: options?.backfill === true,
          trigger: 'manual',
          signal: options?.signal,
          onProgress: options?.onProgress,
        })
        return outcome
      },
      syncing: () => syncer.busy,
      ensureSchedule: async (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('bilibili: a conversation is required to create the sync task')
        }
        const task = await ensureTask(ctx, sessionId, config.scheduleCron, timeZone())
        return { id: String(task.id), nextRunAt: task.scheduledAt }
      },
      recreateSchedule: async (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('bilibili: a conversation is required to create the sync task')
        }
        const task = await recreateTask(ctx, sessionId, config.scheduleCron, timeZone())
        return { id: String(task.id), nextRunAt: task.scheduledAt }
      },
    }

    // Owned by this plugin's fiber: the route appears whenever Connection
    // mounts, and goes away with the plugin.
    registerBridge(ctx, settingsApi)

    return async () => {
      await login.cancel()
      // Accepted writes must land before the domain rejects new ones.
      await syncer.drained()
      await store.close()
    }
  }, 'bilibili:lifecycle')
}

/**
 * The zone the cron expression is evaluated in, taken from the host so a
 * deployment does not have to state what the machine already knows.
 * @returns an IANA zone name.
 */
function timeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * Attach the scannable image for a login challenge.
 *
 * The page cannot encode a QR code and the plugin carries no encoder for the
 * browser, so the Host renders one. A challenge the encoder refuses (an
 * implausibly long URL) still reaches the page with its URL intact, and the page
 * shows the URL instead of the image.
 *
 * @param snapshot - A login snapshot from {@link QrLogin}.
 * @returns the snapshot plus a `qrImage` data URL or null.
 */
function withQrImage(snapshot) {
  if (snapshot.url === null) return { ...snapshot, qrImage: null }
  try {
    return { ...snapshot, qrImage: qrSvgDataUrl(snapshot.url) }
  } catch {
    return { ...snapshot, qrImage: null }
  }
}

/**
 * Freshness block for the plugin page.
 * @param store - The corpus handle.
 * @param syncer - The sync runner.
 * @returns the sync state.
 */
function syncStatus(store, syncer) {
  const status = store.status()
  const lastSuccessAt = store.latestSuccessAt()
  return {
    lastRunAt: status.lastRunAt,
    lastRunStatus: status.lastRunStatus,
    lastErrorCode: status.lastErrorCode,
    authRequired: status.authRequired,
    retryNotBefore: status.retryNotBefore,
    stale: lastSuccessAt === null || Date.now() - Date.parse(lastSuccessAt) > STALE_AFTER_MS,
    running: syncer.busy,
    progress: syncer.progress,
  }
}

/**
 * Per-dataset capture state for the plugin page.
 * @param store - The corpus handle.
 * @returns one row per dataset.
 */
function datasetStatus(store) {
  const counts = store.stats().byDataset
  return Object.entries(counts).map(([dataset, count]) => {
    const cursor = store.cursor(dataset)
    return {
      dataset,
      count,
      lastSuccessAt: cursor?.lastSuccessAt ?? null,
      lastErrorCode: cursor?.lastErrorCode ?? null,
      snapshotComplete: cursor?.snapshotComplete ?? null,
    }
  })
}

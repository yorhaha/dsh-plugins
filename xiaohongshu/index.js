/**
 * Xiaohongshu reading for DeepSeek Harness.
 *
 * The bundle stores one Xiaohongshu web cookie in the credential store, exposes
 * keyword search, note detail, comments, user profiles, and an on-demand local
 * corpus as Host tools, and ships the page that manages the cookie, the pacing
 * state, and the downloaded-image corpus.
 *
 * Every upstream request is serialized, paced, budgeted, cached, and paused
 * after a refusal; the search endpoint has its own tighter budget. The cookie
 * never crosses the page channel and never appears in a tool result.
 *
 * @module dsh-xiaohongshu
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerBridge } from './src/bridge.js'
import { XhsClient } from './src/client.js'
import { resolveConfig } from './src/config.js'
import { CookieError, describeCookie, parseCookie } from './src/cookie.js'
import { clearCredential, readCredential, writeCredential } from './src/credentials.js'
import { createDeviceProfile } from './src/signing.js'
import { defaultPaths, openStore } from './src/store.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'xiaohongshu'

/** Services this plugin cannot run without. */
export const inject = ['tools', 'credentials']

/**
 * Resolve the Harness home directory.
 * @returns the absolute home path.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Register the plugin.
 *
 * @param ctx - plugin context.
 * @param raw - the loader row's `config`, if any.
 * @returns the effect that releases the corpus when the plugin unloads.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  const paths = defaultPaths(dshHome())

  return ctx.effect(async () => {
    const store = await openStore({ databasePath: paths.databasePath, mediaRoot: paths.mediaRoot, logger: ctx.logger })
    const client = new XhsClient({
      config,
      readCredential: () => readCredential(ctx.credentials, config.accountId),
      logger: ctx.logger,
    })
    client.attachStore(store)

    /**
     * Prove and store a candidate cookie. The proof happens before the write,
     * so a mistyped or expired cookie never replaces a working one.
     * @param cookie - the Cookie header the user pasted.
     * @param signal - caller cancellation.
     * @returns the account and save instant.
     */
    async function connect(cookie, signal) {
      const parsed = parseCookie(cookie)
      const device = createDeviceProfile(parsed.values, config.userAgent, 'https://www.xiaohongshu.com/explore')
      const candidate = {
        cookie: parsed.header,
        values: parsed.values,
        device,
        account: null,
        saved_at: null,
      }
      const { account } = await client.verifyWith(candidate, { signal })
      const saved = await writeCredential(ctx.credentials, config.accountId, {
        cookie: parsed.header,
        account,
        device,
      })
      client.clearCache()
      store.updateStatus({ auth_required: false, last_error_code: null })
      return { account, saved_at: saved.saved_at }
    }

    /**
     * Forget the stored cookie and every derived cache entry.
     */
    async function disconnect() {
      await clearCredential(ctx.credentials, config.accountId)
      client.clearCache()
    }

    for (const tool of buildTools({
      client,
      store,
      config,
      connect,
      disconnect,
      jobs: ctx.get('jobs'),
      logger: ctx.logger,
    })) {
      ctx.tools.register(tool)
    }

    /**
     * Everything the plugin page may ask for. The page receives no cookie, no
     * token, and no note body; it gets counts and states only.
     */
    const settingsApi = {
      status: async () => {
        let credential
        let credentialError = null
        try {
          credential = await readCredential(ctx.credentials, config.accountId)
        } catch (error) {
          credentialError = error instanceof CookieError ? error.message : String(error?.message ?? error)
        }
        const stats = client.stats()
        const corpus = store.stats()
        return {
          connected: credential !== undefined,
          saved_at: credential?.saved_at ?? null,
          account: credential?.account ?? null,
          cookie: describeCookie(credential?.cookie),
          credential_error: credentialError,
          auth_required: store.getStatus().auth_required,
          pacing: stats,
          corpus,
          config: {
            accountId: config.accountId,
            minIntervalMs: config.minIntervalMs,
            hourlyBudget: config.hourlyBudget,
            dailyBudget: config.dailyBudget,
            searchHourlyBudget: config.searchHourlyBudget,
            searchDailyBudget: config.searchDailyBudget,
            cacheTtlMs: config.cacheTtlMs,
            contentChars: config.contentChars,
            downloadMedia: config.downloadMedia,
          },
        }
      },
      connect: async (cookie) => connect(cookie),
      disconnect: async () => {
        await disconnect()
        return { cleared: true }
      },
      clearCorpus: async () => {
        store.clear()
        return store.stats()
      },
    }

    registerBridge(ctx, settingsApi)
    return () => {
      store.close()
    }
  })
}

/**
 * Zhihu reading for DeepSeek Harness.
 *
 * The bundle stores one Zhihu web cookie in the credential store, exposes
 * question, answer, article, person, comment, and hot-list reads as Host tools,
 * and ships the page that manages the cookie. Every upstream request is
 * serialized, paced, budgeted, cached, and paused after a refusal, because
 * Zhihu's risk control reacts to rate: see `src/client.js` for those mechanisms
 * and `README.md` for what is reachable with a cookie alone.
 *
 * @module dsh-zhihu
 */

import { registerBridge } from './src/bridge.js'
import { ZhihuClient } from './src/client.js'
import { resolveConfig } from './src/config.js'
import { describeCookie, isUsableCookie } from './src/cookie.js'
import { clearCookie, readCookie, writeCookie } from './src/credentials.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'zhihu'

/** Services this plugin cannot run without. */
export const inject = ['tools', 'credentials']

/**
 * Register the plugin.
 *
 * @param ctx - plugin context.
 * @param raw - the loader row's `config`, if any.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)

  /**
   * What the page and the tools learned from the last successful account read.
   * The page shows it until the user explicitly verifies again, so opening the
   * page never costs an upstream request.
   */
  const state = { lastAccount: null, lastVerifiedAt: null }

  const client = new ZhihuClient({
    config,
    readCookie: () => readCookie(ctx.credentials, config.accountId),
  })

  for (const tool of buildTools({
    client,
    config,
    saveCookie: async (cookie) => {
      const saved = await writeCookie(ctx.credentials, config.accountId, cookie)
      client.clearCache()
      return saved
    },
    clearCookie: async () => {
      await clearCookie(ctx.credentials, config.accountId)
      client.clearCache()
    },
  })) {
    ctx.tools.register(tool)
  }

  /**
   * The connection state the page renders.
   * @returns the state, with no cookie material.
   */
  async function status() {
    let stored
    let cookieError = null
    try {
      stored = await readCookie(ctx.credentials, config.accountId)
    } catch (error) {
      cookieError = error instanceof Error ? error.message : String(error)
    }
    return {
      connected: stored !== undefined && isUsableCookie(stored.cookie),
      saved_at: stored?.saved_at ?? null,
      cookie: describeCookie(stored?.cookie),
      cookie_error: cookieError,
      account: state.lastAccount,
      verified_at: state.lastVerifiedAt,
      stats: client.stats(),
      config: {
        minIntervalMs: config.minIntervalMs,
        hourlyBudget: config.hourlyBudget,
        cacheTtlMs: config.cacheTtlMs,
        contentChars: config.contentChars,
        listDefaultLimit: config.listDefaultLimit,
        listMaxLimit: config.listMaxLimit,
        commentsDefaultLimit: config.commentsDefaultLimit,
        commentsMaxLimit: config.commentsMaxLimit,
        requestTimeoutMs: config.requestTimeoutMs,
        toolTimeoutMs: config.toolTimeoutMs,
      },
    }
  }

  registerBridge(ctx, {
    status,
    connect: async (cookie) => {
      const account = await client.verifyCookie(cookie)
      const saved = await writeCookie(ctx.credentials, config.accountId, cookie)
      client.clearCache()
      state.lastAccount = account
      state.lastVerifiedAt = saved.saved_at
      return { account, saved_at: saved.saved_at, status: await status() }
    },
    verify: async () => {
      const { account, snapshot } = await client.me({ fresh: true })
      state.lastAccount = account
      state.lastVerifiedAt = snapshot.fetched_at
      return { account, verified_at: snapshot.fetched_at, status: await status() }
    },
    disconnect: async () => {
      await clearCookie(ctx.credentials, config.accountId)
      client.clearCache()
      state.lastAccount = null
      state.lastVerifiedAt = null
      return { status: await status() }
    },
  })
}

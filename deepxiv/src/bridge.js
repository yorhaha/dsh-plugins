/**
 * The settings page's Host surface, served over the harness's own connection
 * channel.
 *
 * A profile-installed bundle cannot declare a Remote namespace — client
 * namespaces come from a fixed list compiled into the web application — so the
 * page reaches this plugin through a registered fetch route instead. That route
 * lives under `/api`, which means the harness's Host/Origin fence and browser
 * authentication already ran before the handler is reached; this module adds no
 * authentication of its own and must not be mounted outside that channel.
 *
 * The page may store, replace, or delete the token, and reads the stored one
 * back through `status` to show it in the clear. A failure names its cause; the
 * request body and the stored token are never quoted in one, and the quota
 * answer withholds any upstream body that echoes the token.
 *
 * @module dsh-deepxiv/src/bridge
 */

import { DeepXivError } from './api.js'
import { clearToken, readToken, writeToken } from './credentials.js'
import { defineCodeError, errorCode, readJsonBody, sendJson } from '../../shared/route.js'

/** Path the settings page posts to, below the authenticated `/api` channel. */
export const BRIDGE_PATH = '/api/plugin-deepxiv'

/** Bounded body for a settings request; a larger one is not a settings request. */
const MAX_BODY_BYTES = 32 * 1024

/** Failure codes that mean the request was malformed, rather than the action failed. */
const REQUEST_DEFECTS = new Set(['invalid_token', 'invalid_body'])

/** The codes a body reader may raise; each one is the page's fault. */
const BodyError = defineCodeError('DeepXivBridgeBodyError')

/**
 * Dispatch one settings request.
 * @param api - The settings page's Host surface.
 * @param request - The incoming request.
 * @returns the response.
 */
async function dispatch(api, request) {
  const url = new URL(request.url)
  let body
  try {
    body = request.method === 'GET' ? {} : await readJsonBody(request, MAX_BODY_BYTES, BodyError)
  } catch (error) {
    const code = errorCode(error)
    return sendJson(code === 'body_too_large' ? 413 : 400, {
      ok: false,
      error: { code, message: error?.message ?? '' },
    })
  }
  const action = typeof body.action === 'string' ? body.action : (url.searchParams.get('action') ?? 'status')
  // A GET must stay a read: a link, prefetch, or top-level navigation to this
  // route would otherwise replace or delete the stored token.
  if (request.method === 'GET' && action !== 'status') {
    return sendJson(405, {
      ok: false,
      error: { code: 'method_not_allowed', message: 'Use POST for this action.' },
    })
  }
  try {
    switch (action) {
      case 'status':
        return sendJson(200, { ok: true, value: await api.status() })
      case 'token.save':
        await api.saveToken({ token: body.token })
        return sendJson(200, { ok: true, value: await api.status() })
      case 'token.delete':
        await api.deleteToken()
        return sendJson(200, { ok: true, value: await api.status() })
      case 'token.verify':
        return sendJson(200, { ok: true, value: await api.verifyToken() })
      default:
        return sendJson(400, { ok: false, error: { code: 'unknown_action', message: action } })
    }
  } catch (error) {
    const code = errorCode(error)
    return sendJson(REQUEST_DEFECTS.has(code) ? 400 : 500, {
      ok: false,
      error: { code, message: error?.message ?? '' },
    })
  }
}

/**
 * Build the settings page's Host surface.
 *
 * @param options - Host inputs.
 * @param options.client - The DeepXiv client.
 * @param options.provider - The credentials service.
 * @param options.config - The resolved plugin configuration.
 * @param options.logger - Harness logger.
 * @returns the actions the page may ask for.
 */
export function buildSettingsApi({ client, provider, config, logger }) {
  /** What the page displays: the stored token, when it was added, and the configuration it cannot edit. */
  const status = async () => {
    const stored = await readToken(provider)
    return {
      configured: stored.ok,
      ...stored.ok ? { token: stored.token, addedAt: stored.addedAt } : { reason: stored.reason },
      config: {
        baseUrl: config.baseUrl,
        requestTimeoutMs: config.requestTimeoutMs,
        toolTimeoutMs: config.toolTimeoutMs,
        queryMaxChars: config.queryMaxChars,
        searchDefaultTopK: config.searchDefaultTopK,
        searchMaxTopK: config.searchMaxTopK,
        previewDefaultChars: config.previewDefaultChars,
        previewMaxChars: config.previewMaxChars,
        fullMaxChars: config.fullMaxChars,
      },
    }
  }

  return {
    status,
    saveToken: async ({ token }) => {
      // The store trims and bounds the token in one place; checking it again
      // here would only let the two rules disagree about what is acceptable.
      await writeToken(provider, token)
    },
    deleteToken: async () => {
      await clearToken(provider)
    },
    verifyToken: async () => {
      const stored = await readToken(provider)
      if (!stored.ok) {
        return {
          ok: false,
          error: {
            code: stored.reason === 'record_missing' ? 'token_missing' : 'unusable_token',
            message: stored.reason === 'record_missing'
              ? 'deepxiv: no token is stored yet'
              : `deepxiv: the stored token cannot be read: ${stored.reason}`,
          },
        }
      }
      try {
        return { ok: true, ...await client.quota({ token: stored.token }) }
      } catch (error) {
        if (error instanceof DeepXivError) {
          logger?.warn?.(`deepxiv: verifying the stored token failed: ${error.code}`)
          return { ok: false, error: { code: error.code, message: error.message } }
        }
        throw error
      }
    },
  }
}

/**
 * Register the settings route.
 *
 * The Connection service mounts asynchronously while the Loader settles its
 * sibling rows, so reading it once during `apply` can miss it and drop the route
 * with no error the page can distinguish from a wrong URL. Wait for the service
 * instead: a composition that mounts no Connection channel simply never
 * registers, and a later one still gets the route.
 *
 * @param ctx - Plugin context.
 * @param api - The settings page's Host surface.
 * @returns the registration fiber.
 */
export function registerBridge(ctx, api) {
  return ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () =>
        connectionCtx.connection.fetch.register({
          path: BRIDGE_PATH,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: (request) => dispatch(api, request),
        }),
      'deepxiv: settings route',
    )
  })
}

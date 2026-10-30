/**
 * The plugin page's Host surface, served over the Harness's own connection
 * channel.
 *
 * A profile-installed bundle cannot declare a Remote namespace, so the page
 * reaches this plugin through a registered fetch route under the authenticated
 * `/api` channel. The page receives whether a cookie is stored, when it was
 * saved, the account the last verification proved, and the current pacing
 * state — never the cookie itself.
 *
 * Opening the page reads no upstream resource: a page load must not spend a
 * request against the hourly budget or the risk-control margin. Only the
 * explicit "connect" and "verify" actions do.
 *
 * @module dsh-zhihu/src/bridge
 */

import { defineCodeError, errorCode, readJsonBody, sendJson } from '../../shared/route.js'
import { CookieError } from './cookie.js'

/** Path the plugin page posts to, below the authenticated `/api` channel. */
export const BRIDGE_PATH = '/api/plugin-zhihu'

/** Browser-relative form of {@link BRIDGE_PATH}. */
export const BRIDGE_ROUTE = BRIDGE_PATH.slice(1)

/** Bounded body; a cookie is at most 16 KiB, so anything larger is not this page. */
const MAX_BODY_BYTES = 32 * 1024

/** The codes the body reader may raise; each is the page's fault. */
const BodyError = defineCodeError('ZhihuBridgeBodyError')

/**
 * Dispatch one settings request.
 *
 * @param api - the page's Host surface.
 * @param request - the incoming request.
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
  try {
    switch (action) {
      case 'status':
        return sendJson(200, { ok: true, value: await api.status() })
      case 'connect': {
        if (typeof body.cookie !== 'string' || body.cookie.trim() === '') {
          return sendJson(400, { ok: false, error: { code: 'cookie_missing', message: 'the request carries no cookie' } })
        }
        return sendJson(200, { ok: true, value: await api.connect(body.cookie) })
      }
      case 'verify':
        return sendJson(200, { ok: true, value: await api.verify() })
      case 'disconnect':
        return sendJson(200, { ok: true, value: await api.disconnect() })
      default:
        return sendJson(400, { ok: false, error: { code: 'unknown_action', message: action } })
    }
  } catch (error) {
    if (error instanceof CookieError) {
      return sendJson(200, { ok: false, error: { code: error.code, message: error.message } })
    }
    // A closed plugin failure is an expected answer, not a server fault: the
    // page renders its code and retry instant. Anything else is a bug and is
    // reported as such.
    const closed = typeof error?.code === 'string' && error.code !== ''
    return sendJson(closed ? 200 : 500, {
      ok: false,
      error: {
        code: closed ? error.code : `internal_${error?.constructor?.name ?? 'Error'}`,
        message: error?.message ?? '',
        ...(typeof error?.retryAt === 'number' ? { retry_at: new Date(error.retryAt).toISOString().replace(/\.\d{3}Z$/, 'Z') } : {}),
      },
    })
  }
}

/**
 * Register the settings route.
 *
 * The Connection service mounts asynchronously while the Loader settles its
 * sibling rows, so the registration waits for the service rather than reading
 * it once during `apply`.
 *
 * @param ctx - plugin context.
 * @param api - the plugin page's Host surface.
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
      'zhihu: settings route',
    )
  })
}

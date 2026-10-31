/**
 * The plugin page's Host surface.
 *
 * A profile-installed bundle cannot declare a Remote namespace, so the page
 * reaches this plugin through a fetch route under the authenticated `/api`
 * channel. The page receives whether a cookie is stored, when it was saved, the
 * account the last verification proved, the current pacing state, and corpus
 * counts — never the cookie itself.
 *
 * Opening the page performs no upstream request. Only the explicit connect and
 * disconnect actions touch the credential store; clearing the corpus touches
 * only local SQLite.
 *
 * @module dsh-xiaohongshu/src/bridge
 */

import { defineCodeError, errorCode, readJsonBody, sendJson } from '../../shared/route.js'
import { CookieError, MAX_COOKIE_CHARS } from './cookie.js'

/** Path the plugin page posts to, below the authenticated `/api` channel. */
export const BRIDGE_PATH = '/api/plugin-xiaohongshu'

/** Bounded body; a cookie is at most 16 KiB, so anything larger is not this page. */
const MAX_BODY_BYTES = MAX_COOKIE_CHARS * 2 + 4096

/** The codes the body reader may raise; each is the page's fault. */
const BodyError = defineCodeError('XhsBridgeBodyError')

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
      case 'disconnect':
        return sendJson(200, { ok: true, value: await api.disconnect() })
      case 'clear_corpus':
        return sendJson(200, { ok: true, value: await api.clearCorpus() })
      default:
        return sendJson(400, { ok: false, error: { code: 'unknown_action', message: action } })
    }
  } catch (error) {
    if (error instanceof CookieError) {
      return sendJson(200, { ok: false, error: { code: error.code, message: error.message } })
    }
    const closed = typeof error?.code === 'string' && error.code !== ''
    return sendJson(closed ? 200 : 500, {
      ok: false,
      error: {
        code: closed ? error.code : `internal_${error?.constructor?.name ?? 'Error'}`,
        message: error?.message ?? '',
        ...(typeof error?.retryAt === 'number'
          ? { retry_at: new Date(error.retryAt).toISOString().replace(/\.\d{3}Z$/, 'Z') }
          : {}),
      },
    })
  }
}

/**
 * Register the settings route.
 *
 * `connection` is awaited through `ctx.inject` because the Loader mounts it
 * while settling sibling rows; reading it once in `apply` would see nothing and
 * leave the page with a 404.
 *
 * @param ctx - plugin context.
 * @param api - the page's Host surface.
 * @returns the injection fiber.
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
      'xiaohongshu: settings route',
    )
  })
}

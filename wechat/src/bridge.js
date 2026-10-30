/**
 * The plugin page's Host surface, served over the harness's own connection
 * channel.
 *
 * A profile-installed bundle cannot declare a Remote namespace — client
 * namespaces come from a fixed list compiled into the web application — so the
 * page reaches this plugin through a registered fetch route instead. That route
 * lives under `/api`, which means the harness's Host/Origin fence and browser
 * authentication already ran before the handler is reached; this module adds no
 * authentication of its own and must not be mounted outside that channel.
 *
 * The page receives pipeline states, counts, and paths. No message body, no
 * conversation list, and no key value crosses this boundary.
 *
 * @module dsh-wechat/src/bridge
 */

import { defineCodeError, errorCode, readJsonBody, sendJson } from '../../shared/route.js'

/** Path the plugin page posts to, below the authenticated `/api` channel. */
export const BRIDGE_PATH = '/api/plugin-wechat'

/**
 * Browser-relative form of {@link BRIDGE_PATH}. The page resolves it against
 * `document.baseURI`, so a Harness mounted under a sub-path still reaches the
 * route the Host registered at the server root.
 */
export const BRIDGE_ROUTE = BRIDGE_PATH.slice(1)

/** Bounded body for a settings request; a larger one is not a settings request. */
const MAX_BODY_BYTES = 32 * 1024

/** The codes a body reader may raise; each one is the page's fault. */
const BodyError = defineCodeError('WechatBridgeBodyError')

/**
 * Dispatch one settings request.
 * @param api - The plugin page's Host surface.
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
  try {
    switch (action) {
      case 'status':
        return sendJson(200, { ok: true, value: await api.status() })
      case 'import.start': {
        const value = await api.startImport({ batch: body.batch, includeGroups: body.includeGroups === true })
        return sendJson(200, { ok: true, value })
      }
      case 'schedule.ensure':
      case 'schedule.recreate': {
        // The task belongs to one conversation, and the page knows neither the
        // id nor which one is current; the Host resolves it the same way the
        // agent tool does.
        const sessionId = await api.sessionFor(body.sessionId)
        const value = action === 'schedule.ensure'
          ? await api.ensureSchedule(sessionId)
          : await api.recreateSchedule(sessionId)
        return sendJson(200, { ok: true, value: { ...value, sessionId, schedule: (await api.status()).schedule } })
      }
      default:
        return sendJson(400, { ok: false, error: { code: 'unknown_action', message: action } })
    }
  } catch (error) {
    return sendJson(500, { ok: false, error: { code: errorCode(error), message: error?.message ?? '' } })
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
 * @param api - The plugin page's Host surface.
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
      'wechat: settings route',
    )
  })
}

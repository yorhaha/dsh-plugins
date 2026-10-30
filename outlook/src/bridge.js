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
 * No token ever crosses this boundary. The page receives the device code it must
 * show the user, the account identity, capture counters, and login state.
 *
 * @module dsh-outlook/src/bridge
 */

import { defineCodeError, errorCode, readJsonBody, sendJson } from '../../shared/route.js'

/** Path the plugin page posts to, below the authenticated `/api` channel. */
export const BRIDGE_PATH = '/api/plugin-outlook'

/**
 * Browser-relative form of {@link BRIDGE_PATH}. The page resolves it against
 * `document.baseURI`, so a harness mounted under a sub-path still reaches the
 * route the Host registered at the server root.
 */
export const BRIDGE_ROUTE = BRIDGE_PATH.slice(1)

/** Bounded body for a settings request; a larger one is not a settings request. */
const MAX_BODY_BYTES = 32 * 1024

/** The codes a body reader may raise; each one is the page's fault. */
const BodyError = defineCodeError('OutlookBridgeBodyError')

/**
 * Resolve the conversation a task should report into.
 *
 * The page cannot know a Session id, and a scheduled task must belong to one, so
 * the newest conversation is used when the caller names none.
 *
 * @param ctx - Plugin context.
 * @param requested - Session id the caller supplied, if any.
 * @returns the session id.
 * @throws when no conversation can be resolved.
 */
async function resolveSession(ctx, requested) {
  if (typeof requested === 'string' && requested !== '') return requested
  const controller = ctx.get('sessionController')
  if (controller === undefined) {
    throw Object.assign(new Error('no_conversation_available'), { code: 'no_conversation_available' })
  }
  const { items } = await controller.list({}, new AbortController().signal)
  const newest = items?.[0]?.sessionId
  if (typeof newest !== 'string' || newest === '') {
    throw Object.assign(new Error('no_conversation_available'), { code: 'no_conversation_available' })
  }
  return newest
}

/**
 * Dispatch one settings request.
 * @param ctx - Plugin context.
 * @param api - The plugin page's Host surface.
 * @param request - The incoming request.
 * @returns the response.
 */
async function dispatch(ctx, api, request) {
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
      case 'login.begin':
        return sendJson(200, { ok: true, value: { state: await api.beginLogin() } })
      case 'login.state':
        return sendJson(200, { ok: true, value: { state: api.loginState() } })
      case 'login.cancel':
        return sendJson(200, { ok: true, value: { state: await api.cancelLogin() } })
      case 'signout':
        await api.signOut()
        return sendJson(200, { ok: true, value: await api.status() })
      case 'sync.start': {
        if (api.syncing()) return sendJson(200, { ok: true, value: { started: false, reason: 'busy' } })
        const reason = await api.syncReady()
        if (reason !== null) return sendJson(200, { ok: true, value: { started: false, reason } })
        void api.sync({ backfill: body.backfill === true }).catch(() => {})
        return sendJson(200, { ok: true, value: { started: true } })
      }
      case 'scopes.granted':
        return sendJson(200, { ok: true, value: { scopes: await api.grantedScopes() } })
      case 'schedule.ensure':
      case 'schedule.recreate': {
        const sessionId = await resolveSession(ctx, body.sessionId)
        const value =
          action === 'schedule.ensure'
            ? await api.ensureSchedule(sessionId)
            : await api.recreateSchedule(sessionId)
        return sendJson(200, { ok: true, value: { ...value, sessionId, schedule: await api.status().then((state) => state.schedule) } })
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
          fetch: (request) => dispatch(connectionCtx, api, request),
        }),
      'outlook: settings route',
    )
  })
}

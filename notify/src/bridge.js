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
 * The page may store, replace, or delete a target's token, and reads the stored
 * ones back through `status` to show them in the clear. A failure names its
 * cause; the request body and the stored token are never quoted in one.
 *
 * @module dsh-notify/src/bridge
 */

import { NotifyError, send } from './pushplus.js'
import { clearTarget, isTargetName, listTargets, writeTarget } from './targets.js'
import { defineCodeError, errorCode, readJsonBody, sendJson } from '../../shared/route.js'

/** Path the plugin page posts to, below the authenticated `/api` channel. */
export const BRIDGE_PATH = '/api/plugin-notify'

/** Bounded body for a settings request; a larger one is not a settings request. */
const MAX_BODY_BYTES = 32 * 1024

/** Failure codes that mean the request was malformed, rather than the action failed. */
const REQUEST_DEFECTS = new Set(['invalid_target_name', 'invalid_token', 'invalid_body'])

/** The codes a body reader may raise; each one is the page's fault. */
const BodyError = defineCodeError('NotifyBridgeBodyError')

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
      case 'target.save':
        await api.saveTarget({ name: body.name, token: body.token })
        return sendJson(200, { ok: true, value: await api.status() })
      case 'target.delete':
        await api.deleteTarget({ name: body.name })
        return sendJson(200, { ok: true, value: await api.status() })
      case 'target.test':
        return sendJson(200, { ok: true, value: await api.testTarget({ name: body.name, title: body.title, content: body.content }) })
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
 * Build the plugin page's Host surface.
 *
 * @param options - Host inputs.
 * @param options.provider - The credentials service.
 * @param options.config - The resolved plugin configuration.
 * @param options.logger - Harness logger.
 * @returns the actions the page may ask for.
 */
export function buildSettingsApi({ provider, config, logger }) {
  /** What the page displays: names, their stored tokens, and the configuration it cannot edit. */
  const status = async () => ({
    targets: (await listTargets(provider)).map((target) =>
      target.status === 'ready'
        ? { name: target.name, status: 'ready', token: target.token, addedAt: target.addedAt }
        : { name: target.name, status: 'unusable', reason: target.reason },
    ),
    config: {
      baseUrl: config.baseUrl,
      template: config.template,
      defaultTitle: config.defaultTitle,
      titleMaxChars: config.titleMaxChars,
      contentMaxChars: config.contentMaxChars,
    },
  })

  return {
    status,
    saveTarget: async ({ name, token }) => {
      await writeTarget(provider, readName(name), readToken(token))
    },
    deleteTarget: async ({ name }) => {
      await clearTarget(provider, readName(name))
    },
    testTarget: async ({ name, title, content }) => {
      const wanted = readName(name)
      const body = readTestContent(content, config)
      const target = (await listTargets(provider)).find((entry) => entry.name === wanted)
      if (target === undefined) {
        return { ok: false, error: { code: 'unknown_target', message: `notify: no target is named "${wanted}"` } }
      }
      if (target.status !== 'ready') {
        return { ok: false, error: { code: 'unusable_target', message: `notify: this target is unusable: ${target.reason}` } }
      }
      try {
        const messageId = await send({
          baseUrl: config.baseUrl,
          template: config.template,
          token: target.token,
          title: readTestTitle(title, config),
          content: body,
          timeoutMs: config.requestTimeoutMs,
        })
        return { ok: true, messageId }
      } catch (error) {
        const code = error instanceof NotifyError ? error.code : 'internal'
        const message = error instanceof NotifyError ? error.message : 'The send failed'
        logger?.warn?.(`notify: test to "${target.name}" failed: ${code} ${message}`)
        return { ok: false, error: { code, message } }
      }
    },
  }
}

/**
 * Read a target name from a page request.
 * @param value - Raw field.
 * @returns the trimmed name in the form the record grammar accepts.
 * @throws when the field is not a string or does not name a target.
 */
function readName(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!isTargetName(name)) {
    throw Object.assign(new Error('notify: a target name is lowercase letters, digits, and hyphens, up to 32 characters'), {
      code: 'invalid_target_name',
    })
  }
  return name
}

/**
 * Read a token from a page request.
 * @param value - Raw field.
 * @returns the trimmed token.
 * @throws when the field is not a non-empty string.
 */
function readToken(value) {
  const token = typeof value === 'string' ? value.trim() : ''
  if (token === '') {
    throw Object.assign(new Error('notify: a token is required'), { code: 'invalid_token' })
  }
  return token
}

/**
 * Read the title of a test message, falling back to the configured default.
 * @param value - Raw field.
 * @param config - The resolved plugin configuration.
 * @returns the title within the configured bound.
 */
function readTestTitle(value, config) {
  const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : config.defaultTitle
  return text.slice(0, config.titleMaxChars)
}

/**
 * Read the body of a test message.
 * @param value - Raw field.
 * @param config - The resolved plugin configuration.
 * @returns the body within the configured bound.
 * @throws when the field is not a non-empty string.
 */
function readTestContent(value, config) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') {
    throw Object.assign(new Error('notify: a test message needs content'), { code: 'invalid_body' })
  }
  return text.slice(0, config.contentMaxChars)
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
      'notify: settings route',
    )
  })
}

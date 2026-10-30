/**
 * The panel's Host surface, served over the Harness's own connection channel.
 *
 * A profile-installed bundle cannot declare a Remote namespace — client
 * namespaces come from a fixed list compiled into the web application — so the
 * panel reaches this plugin through a registered fetch route instead. That route
 * lives under `/api`, so the Harness's Host/Origin fence and browser
 * authentication have already run before the handler is reached; this module
 * adds no authentication of its own and must not be mounted outside that
 * channel.
 *
 * Reads are `GET`; every action that changes the list is a `POST`. Without that
 * split a link, a prefetch, or an image tag could carry `?action=remove` and
 * edit durable user data, so the route refuses a read method for a mutation
 * action before it looks at the action at all.
 *
 * A read carries its arguments in the query string, which is the only place a
 * `GET` can put them: the dispatcher merges the query into the body for read
 * methods, so one handler signature serves both. The merge is one-directional —
 * a body always wins — so a `GET` still cannot smuggle in a write.
 *
 * Mutations write with `lastWriter: 'user'`, which is what lets a tool result
 * and the panel tell a person's edit from an agent's. The response carries the accepted
 * items, so the panel renders a write from the round trip that made it instead
 * of guessing at the result.
 *
 * @module dsh-user-todo/src/route
 */

import { resolveWindow } from './agenda.js'
import { describeRule } from './recurrence.js'
import { TodoError } from './store.js'
import { formatInstant } from './zone.js'
import { defineCodeError, errorCode, readJsonBody, sendJson } from '../../shared/route.js'

/** Path the panel reads and posts to, below the authenticated `/api` channel. */
export const ROUTE_PATH = '/api/user-todo'

/** Bounded body for a panel request; the configured title and note limits stay far below it. */
const MAX_BODY_BYTES = 64 * 1024

/** Actions that only read. Every other action changes the list and therefore requires `POST`. */
const READ_ACTIONS = new Set(['list', 'agenda', 'prefs'])

/** Codes that mean the request was malformed rather than that the action failed. */
const REQUEST_DEFECTS = new Set([
  'invalid_body',
  'invalid_json',
  'invalid_title',
  'invalid_note',
  'invalid_due_at',
  'invalid_priority',
  'invalid_status',
  'invalid_key',
  'invalid_recurrence',
  'unsupported_rule',
  'invalid_remind',
  'invalid_prefs',
  'invalid_occurrence',
  'invalid_window',
  'window_too_large',
  'not_recurring',
  'batch_too_large',
  'too_many_items',
])

/** The codes a body reader may raise; each one is the page's fault. */
const BodyError = defineCodeError('TodoBodyError')

/** A query string carries booleans as text; read the ones a read action accepts. */
function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return fallback
}

/**
 * Read the item list of one create request.
 *
 * @param value - the raw field.
 * @param max - most items one request accepts.
 * @returns the entries.
 * @throws {TodoError} `invalid_body` or `batch_too_large`.
 */
function readEntries(value, max) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TodoError('invalid_body', 'user-todo: `items` must be a non-empty array')
  }
  if (value.length > max) throw new TodoError('batch_too_large', `user-todo: at most ${max} items per request`)
  return value
}

/**
 * Read the change list of one update request.
 *
 * @param value - the raw field.
 * @param max - most changes one request accepts.
 * @returns the changes.
 * @throws {TodoError} `invalid_body` or `batch_too_large`.
 */
function readChanges(value, max) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TodoError('invalid_body', 'user-todo: `changes` must be a non-empty array')
  }
  if (value.length > max) throw new TodoError('batch_too_large', `user-todo: at most ${max} changes per request`)
  return value
}

/**
 * Build the actions the panel may ask for.
 *
 * @param store - the open list.
 * @param config - the resolved feature bounds.
 * @returns the actions.
 */
export function buildPanelApi(store, config) {
  // The panel renders the stored item and one derived value: the next occurrence,
  // which only the Host can compute. Sending it with every state means a
  // repeating row's checkbox knows which occurrence it completes without the
  // browser owning a second expansion.
  const state = () => {
    const now = Date.now()
    return {
      items: store.items().map(item => ({
        ...item,
        nextAt: store.nextOf(item, { after: now })?.startAt ?? null,
      })),
    }
  }
  return {
    list: async () => state(),
    agenda: async (body) => {
      const now = Date.now()
      const { from, to } = resolveWindow(
        { from: body.from, to: body.to },
        { now, timeZone: store.timeZone, maxSpanDays: config.agendaMaxSpanDays },
      )
      // The panel shows what happened, so a finished occurrence stays in its cell
      // struck through instead of vanishing the moment it is ticked. An explicit
      // field still narrows the read; a GET carries it as a string.
      const occurrences = store.agenda({
        from,
        to,
        includeDone: asBool(body.include_done ?? body.includeDone, true),
        limit: config.agendaMaxOccurrences,
      }).map(entry => ({
        occurrenceId: entry.occurrenceId,
        itemId: entry.itemId,
        title: entry.title,
        note: entry.note,
        allDay: entry.allDay,
        startAt: entry.startAt,
        date: entry.date,
        done: entry.done,
        status: entry.status,
        recurrence: entry.recurrence,
        recurrenceText: describeRule(entry.recurrence),
        remindBeforeMin: entry.remindBeforeMin,
        lastWriter: entry.lastWriter,
      }))
      return {
        from: formatInstant(from),
        to: formatInstant(to),
        timeZone: store.timeZone,
        now: formatInstant(now),
        occurrences,
      }
    },
    prefs: async () => ({ prefs: store.prefs() }),
    setPrefs: async (body) => {
      const { prefs } = await store.setPrefs(body.prefs ?? {})
      return { prefs, state: state() }
    },
    create: async (body) => {
      const { added, skipped } = await store.create(readEntries(body.items, config.maxCreateBatch), 'user')
      return { outcome: { added, skipped }, state: state() }
    },
    update: async (body) => {
      const { changed, results } = await store.update(readChanges(body.changes, config.maxUpdateBatch), 'user')
      return { outcome: { changed, results }, state: state() }
    },
    completeOccurrence: async (body) => {
      const { item } = await store.completeOccurrence(body.id, body.occurrenceId ?? body.occurrence_id, 'user')
      return { outcome: { item }, state: state() }
    },
    excludeOccurrence: async (body) => {
      const { item } = await store.excludeOccurrence(body.id, body.occurrenceId ?? body.occurrence_id)
      return { outcome: { item }, state: state() }
    },
    remove: async (body) => {
      // `completed: true` without ids is the panel's "clear finished": it names
      // no item, so there is nothing an id-shaped read of this route could
      // reach that would widen it.
      const clearDone = asBool(body.completed, false) === true && body.ids === undefined
      if (!clearDone && (!Array.isArray(body.ids) || body.ids.length === 0)) {
        throw new TodoError('invalid_body', 'user-todo: `ids` must be a non-empty array, or pass completed: true')
      }
      const outcome = clearDone ? await store.removeFinished() : await store.remove(body.ids)
      return { outcome, state: state() }
    },
  }
}

/**
 * Dispatch one panel request.
 *
 * @param api - the panel surface.
 * @param request - the incoming request.
 * @returns the response.
 */
async function dispatch(api, request) {
  const url = new URL(request.url)
  let body
  try {
    body = request.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJsonBody(request, MAX_BODY_BYTES, BodyError)
  } catch (error) {
    const code = errorCode(error)
    return sendJson(code === 'body_too_large' ? 413 : 400, { ok: false, error: { code, message: error?.message ?? '' } })
  }
  // A body that names an action, or a query that does; a request naming none is
  // the panel's plain read.
  const named = typeof body.action === 'string' ? body.action : url.searchParams.get('action')
  const action = named ?? 'list'
  if (!Object.hasOwn(api, action)) {
    return sendJson(400, { ok: false, error: { code: 'unknown_action', message: action } })
  }
  if (request.method === 'GET' && !READ_ACTIONS.has(action)) {
    return sendJson(405, { ok: false, error: { code: 'method_not_allowed', message: `${action} is a POST action` } })
  }
  try {
    return sendJson(200, { ok: true, value: await api[action](body) })
  } catch (error) {
    const code = errorCode(error)
    const defect = REQUEST_DEFECTS.has(code) || code === 'not_found' || code === 'unknown_action'
    return sendJson(defect ? 400 : 500, { ok: false, error: { code, message: error?.message ?? '' } })
  }
}

/**
 * Register the panel route.
 *
 * The Connection service mounts asynchronously while the Loader settles its
 * sibling rows, so reading it once during `apply` can miss it and drop the route
 * with no error the panel can distinguish from a wrong URL. Wait for the service
 * instead: a composition that mounts no Connection channel simply never
 * registers, and a later one still gets the route.
 *
 * @param ctx - the plugin context.
 * @param api - the panel surface.
 * @returns the registration fiber.
 */
export function registerRoute(ctx, api) {
  return ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: request => dispatch(api, request),
      }),
      'user-todo: panel route',
    )
  })
}

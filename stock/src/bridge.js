/**
 * The watchlist panel's Host surface, served over the harness's own connection
 * channel.
 *
 * A profile-installed bundle cannot declare a Remote namespace — client
 * namespaces come from a fixed list compiled into the web application — so the
 * panel reaches this plugin through a registered fetch route instead. That route
 * lives under `/api`, which means the harness's Host/Origin fence and browser
 * authentication already ran before the handler is reached; this module adds no
 * authentication of its own and must not be mounted outside that channel.
 *
 * Every quote the panel shows is read through the plugin's one process-local
 * client, so a panel poll queues behind the same pacing and backoff as an agent
 * tool call instead of racing it from the browser. A read that fails is reported
 * beside the list, never instead of it: the user can still add, reorder, and
 * remove entries while the quote endpoints are unreachable.
 *
 * @module dsh-stock/src/bridge
 */

import { createSparklineCache } from './sparkline.js'
import { SCOPES } from './watchlist.js'
import { defineCodeError, errorCode, readJsonBody, sendJson } from '../../shared/route.js'

/** Path the panel reads and posts to, below the authenticated `/api` channel. */
export const BRIDGE_PATH = '/api/plugin-stock/watchlist'

/** Bounded body for a panel request; a larger one is not a panel request. */
const MAX_BODY_BYTES = 32 * 1024

/** Failure codes that mean the request was malformed, rather than the action failed. */
const REQUEST_DEFECTS = new Set([
  'invalid_body',
  'invalid_json',
  'invalid_code',
  'invalid_keyword',
  'invalid_position',
  'invalid_position_value',
  'invalid_scope',
  'unknown_action',
  'body_too_large',
  'confirmation_required',
])

/** Actions that only read; every other action mutates and therefore requires POST. */
const READ_ACTIONS = new Set(['status', 'search', 'sparklines'])

/** The codes a body reader may raise; each one is the page's fault. */
const BodyError = defineCodeError('StockBridgeBodyError')

/**
 * Project one quote item onto the fields the panel draws — the price and change
 * it shows, and the session's open, high, low, and previous close behind the
 * day's line — so a poll of a long list carries neither an order book nor a
 * valuation per row. The row's own figures are all it keeps: the day's amount,
 * turnover rate, volume, and the quote's clock belong to the `stock_quote` card,
 * which reads them from the tool result rather than from here.
 *
 * @param item - one item from the client's quote payload.
 * @returns the compact row.
 */
function panelQuote(item) {
  return {
    code: item.code,
    name: item.name,
    price: item.price,
    change: item.change,
    change_pct: item.change_pct,
    open: item.open,
    high: item.high,
    low: item.low,
    prev_close: item.prev_close,
    // A marked position states its value and profit in the security's own
    // currency, so the row needs the code the quote already carries.
    currency: item.currency,
  }
}

/**
 * Project the watchlist state onto what the panel draws. The panel shows a
 * price and a change per row, so a poll of a long list must not carry an order
 * book and a valuation per entry; the agent's tool result keeps the full items.
 *
 * @param state - the watchlist state from {@link buildWatchlistApi}.
 * @returns the panel-facing value.
 */
function panelValue(state) {
  return {
    ...state,
    quotes: {
      items: state.quotes.items.map(panelQuote),
      missing: state.quotes.missing,
      failed: state.quotes.failed,
    },
  }
}

/**
 * Split codes into the batches one quote request accepts.
 *
 * @param codes - canonical codes, in list order.
 * @param size - the client's largest accepted code count.
 * @returns the batches.
 */
function batches(codes, size) {
  const groups = []
  for (let index = 0; index < codes.length; index += size) groups.push(codes.slice(index, index + size))
  return groups
}

/**
 * Build the watchlist surface both the panel and the agent tool read.
 *
 * @param options - Host inputs.
 * @param options.store - the open watchlist store.
 * @param options.client - the shared process-local market client.
 * @param options.config - the resolved plugin configuration.
 * @param options.parseCode - the plugin's code parser; throws on an unusable code.
 * @param options.marketSession - reports which markets are inside a trading window now.
 * @param options.snapshot - the instant this process issued the read.
 * @param options.logger - harness logger.
 * @returns the actions the panel may ask for.
 */
export function buildWatchlistApi({ store, client, config, parseCode, marketSession, snapshot, logger }) {
  const series = createSparklineCache({ client, config })

  /**
   * Read both lists and the latest quote for every entry.
   *
   * A stored code this plugin cannot parse — a hand-edited medium is the only
   * way one appears — is reported as invalid instead of failing the read, and a
   * failed batch is reported beside the rows that did arrive. One code in both
   * lists is quoted once, and serves both rows.
   *
   * @param signal - cancels the quote reads; a caller that has gone away does not need them.
   * @returns the panel's complete state.
   */
  const status = async (signal) => {
    const listed = [...store.list('watchlist'), ...store.list('index')]
    const markets = new Map()
    const invalid = []
    for (const entry of listed) {
      try {
        markets.set(entry.code, parseCode(entry.code).market)
      } catch {
        invalid.push(entry.code)
      }
    }
    const unusable = new Set(invalid)
    const requested = [...new Set(listed.map(entry => entry.code))].filter(code => !unusable.has(code))
    const items = []
    const missing = []
    const failed = []
    for (const batch of batches(requested, config.quoteMaxCodes)) {
      const payload = await client.quote(batch, signal)
      if (payload.ok) {
        for (const item of payload.items) items.push(item)
        for (const entry of payload.missing) missing.push(entry.code)
      } else {
        failed.push({ codes: batch, error: payload.error })
      }
    }
    const names = new Map(items.map(item => [item.code, item.name]))
    if (names.size > 0) {
      await store.rememberNames('watchlist', names)
      await store.rememberNames('index', names)
    }
    return {
      ok: true,
      entries: store.list('watchlist'),
      indices: store.list('index'),
      invalid,
      quotes: { items, missing, failed },
      market: marketSession([...markets.values()]),
      panel: {
        refreshMs: config.panelRefreshMs,
        updatedAt: store.updatedAt(),
      },
      snapshot: snapshot(),
    }
  }

  /**
   * Resolve one canonical code.
   * @param value - the raw field.
   * @returns the canonical code.
   * @throws when the field is not a code this plugin serves.
   */
  const readCode = (value) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw Object.assign(new Error('stock: a code is required'), { code: 'invalid_code' })
    }
    try {
      return parseCode(value.trim()).code
    } catch (error) {
      throw Object.assign(new Error(error?.message ?? 'stock: unusable code'), { code: 'invalid_code' })
    }
  }

  /**
   * Search the market for securities to add.
   * @param keyword - the raw keyword field.
   * @param signal - cancels the search.
   * @returns the matches and the keyword that produced them.
   * @throws when the keyword is not a usable search term.
   */
  const search = async (keyword, signal) => {
    const trimmed = typeof keyword === 'string' ? keyword.trim() : ''
    if (trimmed === '' || trimmed.length > config.keywordMaxChars) {
      throw Object.assign(new Error(`stock: the keyword must be 1 to ${config.keywordMaxChars} characters`), {
        code: 'invalid_keyword',
      })
    }
    const payload = await client.search(trimmed, signal)
    return { keyword: trimmed, search: payload }
  }

  /**
   * Read the intraday series the panel draws beside the followed securities.
   *
   * The series arrive separately from the list, because one of them costs an
   * upstream read and the list must not wait for them. A code the plugin cannot
   * parse is a defect of the request; a code upstream has no series for is
   * reported beside the series that did arrive.
   *
   * @param codes - the canonical codes the panel lists.
   * @param signal - cancels the reads; a panel that has gone away does not need them.
   * @returns the ready series by code, the failures, the pending codes, and the instant of the read.
   */
  const sparklines = async (codes, signal) => {
    const parsed = [...new Set(codes.map(readCode))]
    return { ok: true, ...(await series.read(parsed, signal)), snapshot: snapshot() }
  }

  const add = async (scope, codes, signal) => {
    const wanted = codes.map(readCode)
    if (scope === 'index') {
      for (const code of wanted) {
        const parsed = parseCode(code)
        if (!parsed.isIndex || parsed.market === 'hk' || parsed.market === 'us') {
          throw Object.assign(new Error('stock: the index row takes mainland index codes only'), { code: 'invalid_code' })
        }
      }
    }
    const outcome = await store.add(scope, wanted)
    if (outcome.full.length > 0) {
      logger?.warn?.(`stock: ${scope} is full at ${store.maxEntries(scope)} entries; ${outcome.full.length} code(s) were not added`)
    }
    return { outcome: { ...outcome, added: outcome.added.map(entry => entry.code) }, state: await status(signal) }
  }

  const remove = async (scope, codes, signal) => {
    const outcome = await store.remove(scope, codes.map(readCode))
    return { outcome, state: await status(signal) }
  }

  const move = async (scope, code, to, signal) => {
    if (!Number.isInteger(to) || to < 1) {
      throw Object.assign(new Error('stock: a position is a 1-based whole number'), { code: 'invalid_position' })
    }
    const outcome = await store.move(scope, readCode(code), to)
    return { outcome, state: await status(signal) }
  }

  const clear = async (scope, signal) => {
    const outcome = await store.clear(scope)
    return { outcome, state: await status(signal) }
  }

  /**
   * Mark one followed security as held, or update the figures recorded for it.
   *
   * Only the watchlist holds positions: the index row is a market gauge, not a
   * portfolio, so addressing it is a defect of the request rather than an
   * outcome the user could act on.
   *
   * @param scope - the list the request addressed; must be `watchlist`.
   * @param code - the raw code field.
   * @param fields - `cost` and `quantity`, with null clearing a stored figure.
   * @param signal - cancels the quote reads.
   * @returns the mark outcome and the state it produced.
   */
  const mark = async (scope, code, fields, signal) => {
    if (scope !== 'watchlist') {
      throw Object.assign(new Error('stock: only the watchlist can hold positions'), { code: 'invalid_scope' })
    }
    const outcome = await store.mark('watchlist', readCode(code), fields)
    return { outcome, state: await status(signal) }
  }

  /**
   * Clear the holding mark of one followed security.
   *
   * @param scope - the list the request addressed; must be `watchlist`.
   * @param code - the raw code field.
   * @param signal - cancels the quote reads.
   * @returns the unmark outcome and the state it produced.
   */
  const unmark = async (scope, code, signal) => {
    if (scope !== 'watchlist') {
      throw Object.assign(new Error('stock: only the watchlist can hold positions'), { code: 'invalid_scope' })
    }
    const outcome = await store.unmark('watchlist', readCode(code))
    return { outcome, state: await status(signal) }
  }

  return { status, search, sparklines, add, remove, move, clear, mark, unmark }
}

/**
 * Read the list a panel request addresses.
 *
 * @param value - the raw field.
 * @returns the scope, defaulting to the followed securities.
 * @throws when the field is not a scope this plugin stores.
 */
function readScope(value) {
  if (value === undefined || value === null || value === '') return 'watchlist'
  if (!SCOPES.includes(value)) {
    throw Object.assign(new Error(`stock: scope must be one of ${SCOPES.join(', ')}`), { code: 'invalid_scope' })
  }
  return value
}

/**
 * Read one optional position figure from a panel request.
 *
 * An absent field keeps the stored figure and null clears it, so an emptied
 * input and an omitted one stay distinguishable. Zero, a negative number, and
 * a non-number are rejected before the store sees them.
 *
 * @param body - the parsed request body.
 * @param key - `cost` or `quantity`.
 * @returns the figure, null to clear it, or undefined when the field is absent.
 * @throws when the field is neither a positive finite number nor null.
 */
function readPositionField(body, key) {
  const value = body[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error(`stock: ${key} must be a positive number or null`), { code: 'invalid_position_value' })
  }
  return value
}

/**
 * Shape one mutation's answer: what the action did, then the state it produced,
 * so the panel renders the new list from the round trip that changed it.
 *
 * @param result - a mutation result from {@link buildWatchlistApi}.
 * @returns the response value.
 */
function mutationValue(result) {
  return { outcome: result.outcome, state: panelValue(result.state) }
}

/**
 * Dispatch one panel request.
 *
 * A read is a `GET`; every other action is a `POST` carrying `action`. A
 * mutation answers with the state it produced, so the panel renders the new list
 * from the same round trip that changed it.
 *
 * @param api - the watchlist surface.
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
    return sendJson(code === 'body_too_large' ? 413 : 400, { ok: false, error: { code, message: error?.message ?? '' } })
  }
  const action = typeof body.action === 'string' ? body.action : (url.searchParams.get('action') ?? 'status')
  const signal = request.signal
  // Reads are GETs and mutations are POSTs. Without this, a GET carrying
  // `?action=clear` would let a link or a prefetch wipe durable user state.
  if (request.method === 'GET' && !READ_ACTIONS.has(action)) {
    return sendJson(405, {
      ok: false,
      error: { code: 'method_not_allowed', message: `${action} is a POST action` },
    })
  }
  try {
    switch (action) {
      case 'status':
        return sendJson(200, { ok: true, value: panelValue(await api.status(signal)) })
      case 'search':
        return sendJson(200, { ok: true, value: await api.search(body.keyword, signal) })
      case 'sparklines':
        return sendJson(200, { ok: true, value: await api.sparklines(readCodeList(body.codes), signal) })
      case 'add':
        return sendJson(200, { ok: true, value: mutationValue(await api.add(readScope(body.scope), readCodeList(body.codes), signal)) })
      case 'remove':
        return sendJson(200, { ok: true, value: mutationValue(await api.remove(readScope(body.scope), readCodeList(body.codes), signal)) })
      case 'move':
        return sendJson(200, { ok: true, value: mutationValue(await api.move(readScope(body.scope), body.code, body.to, signal)) })
      case 'mark':
        return sendJson(200, {
          ok: true,
          value: mutationValue(await api.mark(readScope(body.scope), body.code, {
            cost: readPositionField(body, 'cost'),
            quantity: readPositionField(body, 'quantity'),
          }, signal)),
        })
      case 'unmark':
        return sendJson(200, { ok: true, value: mutationValue(await api.unmark(readScope(body.scope), body.code, signal)) })
      case 'clear': {
        if (body.confirm !== true) {
          throw Object.assign(new Error('stock: clear deletes every entry; pass confirm: true to run it'), {
            code: 'confirmation_required',
          })
        }
        return sendJson(200, { ok: true, value: mutationValue(await api.clear(readScope(body.scope), signal)) })
      }
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
 * Read the code list of one panel request.
 * @param value - the raw field.
 * @returns the codes, as sent; each is parsed and canonicalized downstream.
 * @throws when the field is not a non-empty array of strings.
 */
function readCodeList(value) {
  const codes = typeof value === 'string' ? [value] : value
  if (!Array.isArray(codes) || codes.length === 0 || codes.length > 64 || !codes.every(code => typeof code === 'string')) {
    throw Object.assign(new Error('stock: codes must be a non-empty array of strings'), { code: 'invalid_body' })
  }
  return codes
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
 * @param ctx - Plugin context.
 * @param api - the watchlist surface.
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
      'stock: watchlist route',
    )
  })
}

/**
 * v2ex — read-only V2EX public-API queries exposed as five Host tools.
 *
 * Each tool issues one HTTP request against one of four whitelisted public
 * endpoints, trims the response to a bounded model-facing value, and returns
 * it. An expected request failure (transport, timeout, 5xx, 403, 429, or a
 * response that violates the endpoint contract) comes back as an `ok: false`
 * payload carrying a closed `error.code`, so the model reads the failure and
 * its retry time instead of losing the call; only argument validation throws.
 *
 * Requests are serialized, spaced by a minimum interval, and backed off after
 * a transport, 5xx, 403, or 429 failure. That state — serialization chain,
 * last request time, backoff deadline, and the last rate-limit header — lives
 * in this plugin instance only and disappears when the process exits or the
 * plugin reloads, so saving this file clears any backoff in force. It writes no
 * session data beyond the ordinary tool call and result the registry logs.
 *
 * @module dsh-v2ex
 */

import {
  RequestFailure,
  characterCount,
  createPacer,
  defineUsageError,
  intHeader,
  isCallerAbort,
  isTimeout,
  isoSeconds as sharedIsoSeconds,
  readBoundedBody,
  retryAfterMs,
  sendRequest,
  sleep,
  toFailurePayload,
  truncate,
} from '../shared/http.js'

/**
 * Cordis plugin name used by loader diagnostics.
 */
export const name = 'v2ex'

/**
 * The tool registry this plugin contributes to.
 */
export const inject = ['tools']

// ── protocol constants (fixed: they describe the remote API, not a tunable) ──

/** Origin every request is built from; the path whitelist below is relative to it. */
const BASE_URL = 'https://www.v2ex.com'

/** Public endpoint returning the topics V2EX currently ranks as hot. */
const HOT_PATH = '/api/topics/hot.json'

/** Public endpoint returning the most recently created topics. */
const LATEST_PATH = '/api/topics/latest.json'

/** Public endpoint serving one topic by id, or a node's first page by name. */
const SHOW_PATH = '/api/topics/show.json'

/** Public endpoint serving every reply of one topic. */
const REPLIES_PATH = '/api/replies/show.json'

/**
 * Path → the query-parameter keys a request to it may carry. A path absent
 * from this map is not requestable at all.
 */
const ALLOWED_PARAMS = new Map([
  [HOT_PATH, new Set()],
  [LATEST_PATH, new Set()],
  [SHOW_PATH, new Set(['node_name', 'page', 'id'])],
  [REPLIES_PATH, new Set(['topic_id'])],
])

/** V2EX node slugs: lowercase ASCII letters, digits, and hyphens. */
const NODE_NAME_PATTERN = /^[a-z0-9-]{1,32}$/

/** Caveat attached when a reply list comes back empty. */
const EMPTY_REPLIES_NOTE = 'The public API cannot distinguish a topic that does not exist from one that has no replies.'

// ── configuration ───────────────────────────────────────────────────────────

/**
 * Every configurable value with its default. The plugin declares no
 * schemastery `Config` (it carries no dependencies), so {@link resolveConfig}
 * validates the row's `config` itself and fails the load on a bad value.
 */
const DEFAULT_CONFIG = {
  userAgent: 'dsh-v2ex/0.1',
  requestTimeoutMs: 10_000,
  responseLimitBytes: 1_048_576,
  minIntervalMs: 1_000,
  retryDelayMs: 1_000,
  pauseNetworkMs: 60_000,
  pauseForbiddenMs: 3_600_000,
  pauseDefaultMs: 3_600_000,
  rateLimitWatermark: 60,
  listDefaultLimit: 20,
  listMaxLimit: 50,
  replyDefaultLimit: 30,
  replyMaxLimit: 100,
  excerptChars: 500,
  topicContentChars: 20_000,
  replyContentChars: 1_000,
  toolTimeoutMs: 60_000,
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/**
 * Read one positive-integer config field, falling back to its default.
 *
 * @param config - the row's raw `config` object.
 * @param key - field name, also used in the failure message.
 * @returns the configured value, or the default when the field is absent.
 */
function configInteger(config, key) {
  const value = config[key]
  if (value === undefined) return DEFAULT_CONFIG[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`v2ex: config.${key} must be a positive integer`)
  }
  return value
}

/**
 * Resolve and validate the row's `config` into the complete option set.
 *
 * Fails loud at load on an unknown key, a non-positive integer, an empty
 * `userAgent`, a reply cap above its default limit, or a list cap above its
 * default limit: each would otherwise surface later as a confusing runtime
 * failure.
 *
 * @param raw - the `config` value the Loader passed to `apply`, if any.
 * @returns every option resolved to a concrete value.
 */
function resolveConfig(raw) {
  const config = raw === undefined || raw === null ? {} : raw
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('v2ex: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`v2ex: unknown config key "${key}"`)
  }
  const resolved = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === 'userAgent') continue
    resolved[key] = configInteger(config, key)
  }
  const userAgent = config.userAgent ?? DEFAULT_CONFIG.userAgent
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) {
    throw new Error('v2ex: config.userAgent must be a non-empty string')
  }
  resolved.userAgent = userAgent
  if (resolved.listDefaultLimit > resolved.listMaxLimit) {
    throw new Error('v2ex: config.listDefaultLimit must not exceed config.listMaxLimit')
  }
  if (resolved.replyDefaultLimit > resolved.replyMaxLimit) {
    throw new Error('v2ex: config.replyDefaultLimit must not exceed config.replyMaxLimit')
  }
  return resolved
}

// ── failures ────────────────────────────────────────────────────────────────

/** Local argument-validation failure. No request is issued. */
const UsageError = defineUsageError('V2exUsageError')

/**
 * Convert a caught error into the model-facing failure value.
 *
 * @param error - the caught value.
 * @returns the failure payload.
 */
function failurePayload(error) {
  return toFailurePayload(error, 'v2ex')
}

// ── response coercion ───────────────────────────────────────────────────────

/**
 * Format an epoch-second timestamp as `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * @param epochSeconds - the remote timestamp.
 * @returns the UTC instant.
 */
function isoSeconds(epochSeconds) {
  return sharedIsoSeconds(epochSeconds, 'A V2EX')
}

/**
 * Coerce a remote numeric field: it accepts a non-negative integer or its
 * decimal string form and rejects booleans, negatives, and anything else.
 *
 * @param value - the raw JSON field.
 * @param field - field name used in the failure message.
 * @param kind - noun for the expected quantity, used in the failure message.
 * @returns the number.
 */
function asInteger(value, field, kind = 'number') {
  const message = `V2EX response field ${field} is not a valid ${kind}.`
  if (typeof value === 'boolean') throw new RequestFailure('invalid_response', message)
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value)
  throw new RequestFailure('invalid_response', message)
}

/**
 * Coerce a remote boolean flag, which V2EX sends as 0/1 or "0"/"1".
 *
 * @param value - the raw JSON field.
 * @param field - field name used in the failure message.
 * @returns the flag.
 */
function asFlag(value, field) {
  const number = asInteger(value, field)
  if (number !== 0 && number !== 1) {
    throw new RequestFailure('invalid_response', `V2EX response field ${field} is not a valid flag.`)
  }
  return number === 1
}

/**
 * Require a remote string field.
 *
 * @param value - the raw JSON field.
 * @param field - field name used in the failure message.
 * @returns the text.
 */
function asText(value, field) {
  if (typeof value === 'string') return value
  throw new RequestFailure('invalid_response', `V2EX response field ${field} is not text.`)
}

/**
 * Read a nullable content field; V2EX omits the body of a deleted topic.
 *
 * @param value - the raw JSON field.
 * @returns the body, or an empty string when absent.
 */
function asContent(value) {
  if (value === undefined || value === null) return ''
  return asText(value, 'content')
}

/**
 * Project the node object nested in a topic.
 *
 * @param node - the raw JSON field.
 * @returns the `{ name, title }` pair, or null when V2EX omits it.
 */
function nodePair(node) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return null
  const { name, title } = node
  if (typeof name !== 'string' || typeof title !== 'string') return null
  return { name, title }
}

/**
 * Project the member object nested in a topic or reply.
 *
 * @param member - the raw JSON field.
 * @returns the `{ username, id? }` pair, or null for a deleted account.
 */
function authorPair(member) {
  if (typeof member !== 'object' || member === null || Array.isArray(member)) return null
  const username = member.username
  if (typeof username !== 'string') return null
  const author = { username }
  if (member.id !== undefined && member.id !== null) author.id = String(asInteger(member.id, 'member.id'))
  return author
}

/**
 * Project one topic from a list endpoint.
 *
 * @param item - one raw topic object.
 * @param excerptChars - character budget for the body excerpt.
 * @returns the trimmed topic.
 */
function topicBrief(item, excerptChars) {
  const id = asInteger(item.id, 'id')
  const content = asContent(item.content)
  const excerpt = truncate(content, excerptChars)
  return {
    id: String(id),
    title: asText(item.title, 'title'),
    url: `${BASE_URL}/t/${id}`,
    node: nodePair(item.node),
    author: authorPair(item.member),
    replies: asInteger(item.replies, 'replies'),
    last_touched: isoSeconds(asInteger(item.last_touched, 'last_touched', 'timestamp')),
    content_excerpt: excerpt,
    content_chars: characterCount(content),
    content_truncated: excerpt !== content,
  }
}

/**
 * Project the single topic returned by the id form of the show endpoint.
 *
 * @param item - the raw topic object.
 * @param topicContentChars - character budget for the body.
 * @returns the trimmed topic detail.
 */
function topicDetail(item, topicContentChars) {
  const id = asInteger(item.id, 'id')
  const content = asContent(item.content)
  const body = truncate(content, topicContentChars)
  const lastReplyBy = item.last_reply_by
  const deleted = item.deleted === undefined || item.deleted === null
    ? false
    : asFlag(item.deleted, 'deleted')
  return {
    found: true,
    id: String(id),
    title: asText(item.title, 'title'),
    url: `${BASE_URL}/t/${id}`,
    node: nodePair(item.node),
    author: authorPair(item.member),
    replies: asInteger(item.replies, 'replies'),
    last_reply_by: typeof lastReplyBy === 'string' ? lastReplyBy : null,
    created: isoSeconds(asInteger(item.created, 'created', 'timestamp')),
    last_modified: isoSeconds(asInteger(item.last_modified, 'last_modified', 'timestamp')),
    last_touched: isoSeconds(asInteger(item.last_touched, 'last_touched', 'timestamp')),
    deleted,
    content: body,
    content_chars: characterCount(content),
    content_truncated: body !== content,
  }
}

/**
 * Sort key for one reply: creation time, then id.
 *
 * @param item - one raw reply object.
 * @returns the comparable pair.
 */
function replyKeys(item) {
  return [asInteger(item.created, 'created', 'timestamp'), asInteger(item.id, 'id')]
}

/**
 * Project one reply.
 *
 * @param item - one raw reply object.
 * @param replyContentChars - character budget for the reply body.
 * @returns the trimmed reply.
 */
function replyValue(item, replyContentChars) {
  const id = asInteger(item.id, 'id')
  const content = asContent(item.content)
  const body = truncate(content, replyContentChars)
  return {
    id: String(id),
    topic_id: String(asInteger(item.topic_id, 'topic_id')),
    author: authorPair(item.member),
    created: isoSeconds(asInteger(item.created, 'created', 'timestamp')),
    last_modified: isoSeconds(asInteger(item.last_modified, 'last_modified', 'timestamp')),
    content: body,
    content_chars: characterCount(content),
    content_truncated: body !== content,
  }
}

/**
 * Order replies by `(created, id)` and take one window of them.
 *
 * @param items - every raw reply object.
 * @param limit - window size.
 * @param order - `latest` for the newest window, `oldest` for the earliest.
 * @returns the selected raw replies, newest first for `latest`.
 */
function selectReplies(items, limit, order) {
  const ordered = [...items].sort((left, right) => {
    const [leftCreated, leftId] = replyKeys(left)
    const [rightCreated, rightId] = replyKeys(right)
    return leftCreated - rightCreated || leftId - rightId
  })
  return order === 'latest' ? ordered.slice(-limit).reverse() : ordered.slice(0, limit)
}

/**
 * Parse a response body as JSON.
 *
 * @param bytes - the decoded-by-fetch response bytes.
 * @returns the parsed value.
 */
function loadJson(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new RequestFailure('invalid_response', 'The V2EX response is not valid UTF-8.')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new RequestFailure('invalid_response', 'The V2EX response is not valid JSON.')
  }
}

/** The three cache states a snapshot reports: fresh, cached with a positive age, or unstated. */
const CACHE_STATUSES = ['fresh', 'cached', 'unknown']

/**
 * Classify a response's `Age` header. A missing header is `unknown`, not
 * `fresh`: V2EX not reporting an age says nothing about how old the value is.
 *
 * @param age - the parsed `Age` header, or null when the response omits it.
 * @returns one of {@link CACHE_STATUSES}.
 */
function cacheStatusOf(age) {
  if (age === null) return 'unknown'
  return age > 0 ? 'cached' : 'fresh'
}

/**
 * Build the cache state and rate-limit account attached to a successful value.
 *
 * @param headers - the response headers.
 * @param warning - an optional rate-limit warning to include.
 * @returns the snapshot object.
 */
function snapshotValue(headers, warning) {
  const age = intHeader(headers.get('age'))
  const snapshot = {
    cache_age_seconds: age,
    cache_status: cacheStatusOf(age),
    rate_limit_remaining: intHeader(headers.get('x-rate-limit-remaining')),
    rate_limit_reset_at: intHeader(headers.get('x-rate-limit-reset')),
  }
  if (warning !== null) snapshot.warning = warning
  return snapshot
}

/**
 * Coerce a response array into its object elements.
 *
 * @param data - the parsed response body.
 * @returns the elements.
 */
function objectItems(data) {
  if (!Array.isArray(data) || data.some(item => typeof item !== 'object' || item === null || Array.isArray(item))) {
    throw new RequestFailure('invalid_response', 'The V2EX response structure does not match the endpoint contract.')
  }
  return data
}

// ── client ──────────────────────────────────────────────────────────────────

/**
 * One process-local V2EX client. All five queries share its serialization
 * chain and backoff state, so concurrent tool calls cannot exceed the pacing
 * the remote API tolerates.
 */
class V2exClient {
  /**
   * @param config - the resolved plugin options.
   */
  constructor(config) {
    this._config = config
    this._tail = Promise.resolve()
    // The interval is measured with a monotonic clock: a system clock jump must
    // not make the next request look either free or overdue. The backoff instant
    // a caller reads is wall-clock, which is what the pacer tracks beside it.
    this._pacer = createPacer({ label: 'V2EX', config, now: () => performance.now() })
  }

  /**
   * Run one task after every previously queued task settled. Queueing, rather
   * than rejecting, keeps one failed call from cancelling the others.
   *
   * @param task - the request task.
   * @returns the task's outcome.
   */
  _serialize(task) {
    const result = this._tail.then(task, task)
    this._tail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * List the topics V2EX currently ranks as hot.
   *
   * @param limit - maximum number of topics to return.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  hot(limit, signal) {
    return this._list(HOT_PATH, 'hot', limit, {}, null, signal)
  }

  /**
   * List the most recently created topics.
   *
   * @param limit - maximum number of topics to return.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  latest(limit, signal) {
    return this._list(LATEST_PATH, 'latest', limit, {}, null, signal)
  }

  /**
   * List the newest topics of one node. These endpoints expose only the node's
   * first page, so the result is one snapshot.
   *
   * @param nodeName - the node slug.
   * @param limit - maximum number of topics to return.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  node(nodeName, limit, signal) {
    return this._list(
      SHOW_PATH,
      'node',
      limit,
      { node_name: nodeName, page: 1 },
      'The V2EX node does not exist or is not publicly visible.',
      signal,
    )
  }

  /**
   * Run one list query and trim its topics.
   *
   * @param path - the whitelisted endpoint path.
   * @param query - the value's `query` discriminator.
   * @param limit - maximum number of topics to return.
   * @param params - the endpoint's query parameters.
   * @param notFoundMessage - the 404 message, when the endpoint defines one.
   * @param signal - caller cancellation.
   * @returns the success or failure payload.
   */
  async _list(path, query, limit, params, notFoundMessage, signal) {
    try {
      const { data, headers, warning } = await this._request(path, params, notFoundMessage, signal)
      const available = objectItems(data)
      const items = available.slice(0, limit).map(item => topicBrief(item, this._config.excerptChars))
      return {
        ok: true,
        source: 'v2ex',
        query,
        available_count: available.length,
        returned_count: items.length,
        items,
        snapshot: snapshotValue(headers, warning),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read one topic by id.
   *
   * @param topicId - the numeric topic id.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async topic(topicId, signal) {
    try {
      const { data, headers, warning } = await this._request(
        SHOW_PATH,
        { id: topicId },
        'The V2EX topic does not exist or is not publicly visible.',
        signal,
      )
      const items = objectItems(data)
      if (items.length === 0) {
        throw new RequestFailure('not_found', 'The V2EX topic does not exist or is not publicly visible.')
      }
      if (items.length !== 1) {
        throw new RequestFailure('invalid_response', 'The V2EX response structure does not match the endpoint contract.')
      }
      return {
        ok: true,
        source: 'v2ex',
        query: 'topic',
        ...topicDetail(items[0], this._config.topicContentChars),
        snapshot: snapshotValue(headers, warning),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read a window of one topic's replies.
   *
   * @param topicId - the numeric topic id.
   * @param limit - window size.
   * @param order - `latest` for the newest window, `oldest` for the earliest.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async replies(topicId, limit, order, signal) {
    try {
      const { data, headers, warning } = await this._request(
        REPLIES_PATH,
        { topic_id: topicId },
        'The V2EX topic does not exist or is not publicly visible.',
        signal,
      )
      const available = objectItems(data)
      const items = selectReplies(available, limit, order)
        .map(item => replyValue(item, this._config.replyContentChars))
      const payload = {
        ok: true,
        source: 'v2ex',
        query: 'replies',
        available_count: available.length,
        returned_count: items.length,
        order,
        items,
        snapshot: snapshotValue(headers, warning),
      }
      if (available.length === 0) payload.note = EMPTY_REPLIES_NOTE
      return payload
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Issue one whitelisted GET, retrying once after a transport failure, a
   * timeout, or a 5xx before backing this process off.
   *
   * @param path - the endpoint path, which must be in the whitelist.
   * @param params - the query parameters, which must be allowed for the path.
   * @param notFoundMessage - the message a 404 maps to, when the endpoint defines one.
   * @param signal - caller cancellation.
   * @returns the parsed body, the response headers, and any rate-limit warning.
   */
  _request(path, params, notFoundMessage, signal) {
    authorize(path, params)
    return this._serialize(async () => {
      await this._gate()
      let attempt = 0
      for (;;) {
        let response
        try {
          response = await this._read(path, params, signal)
        } catch (error) {
          if (error instanceof RequestFailure) throw error
          if (isCallerAbort(signal)) throw error
          if (isTimeout(error)) {
            if (attempt === 0) {
              attempt = 1
              await sleep(this._config.retryDelayMs)
              continue
            }
            throw this._pauseFailure('timeout', 'The V2EX request timed out. Try again later.', this._config.pauseNetworkMs)
          }
          if (attempt === 0) {
            attempt = 1
            await sleep(this._config.retryDelayMs)
            continue
          }
          throw this._pauseFailure('network_error', 'The V2EX request could not be completed. Try again later.', this._config.pauseNetworkMs)
        }
        const { status, headers, bytes } = response
        if (status === 200) {
          return { data: loadJson(bytes), headers, warning: this._noteRateAndWatermark(headers) }
        }
        if (status === 404 && notFoundMessage !== null) throw new RequestFailure('not_found', notFoundMessage)
        if (status === 429) {
          throw this._pauseFailure(
            'rate_limited',
            'The V2EX query allowance is temporarily exhausted. Try again later.',
            this._retryAfterMs(headers),
          )
        }
        if (status === 403) {
          throw this._pauseFailure(
            'access_denied',
            'V2EX is temporarily refusing requests from this process. Try again later.',
            this._config.pauseForbiddenMs,
          )
        }
        if (status >= 500 && status <= 599) {
          if (attempt === 0) {
            attempt = 1
            await sleep(this._config.retryDelayMs)
            continue
          }
          throw this._pauseFailure(
            'upstream_unavailable',
            'The V2EX service is temporarily unavailable. Try again later.',
            this._config.pauseNetworkMs,
          )
        }
        throw new RequestFailure('invalid_response', 'V2EX returned an unexpected response status.')
      }
    })
  }

  /**
   * Perform one GET and read at most `responseLimitBytes` of its body.
   *
   * @param path - the endpoint path.
   * @param params - the query parameters.
   * @param signal - caller cancellation.
   * @returns the status, headers, and body bytes.
   */
  async _read(path, params, signal) {
    this._pacer.start()
    const url = new URL(`${BASE_URL}${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    const response = await sendRequest(url, {
      method: 'GET',
      headers: { 'user-agent': this._config.userAgent, accept: 'application/json' },
    }, { config: this._config, signal })
    return readBoundedBody(response, this._config.responseLimitBytes, 'V2EX')
  }

  /**
   * Apply the backoff and minimum-interval pacing. Runs inside the
   * serialization chain, so the state it reads cannot change underneath it.
   *
   * @returns once this process may issue the request.
   */
  async _gate() {
    return this._pacer.gate()
  }

  /**
   * Extend the process-local backoff, never shortening an existing one.
   *
   * @param ms - the pause length in milliseconds.
   */
  _block(ms) {
    this._pacer.block(ms)
  }

  /**
   * Back this process off and build the matching failure.
   *
   * @param code - the closed failure code.
   * @param message - the model-facing explanation.
   * @param ms - the pause length in milliseconds.
   * @returns the failure to throw.
   */
  _pauseFailure(code, message, ms) {
    return this._pacer.pause(code, message, ms)
  }

  /**
   * Warn once the remaining allowance is low, and pause this process until the
   * allowance resets so later calls cannot spend the last of it.
   *
   * @param headers - the successful response's headers.
   * @returns the warning to attach, or null when the allowance is comfortable.
   */
  _noteRateAndWatermark(headers) {
    const remaining = intHeader(headers.get('x-rate-limit-remaining'))
    if (remaining === null || remaining > this._config.rateLimitWatermark) return null
    const reset = intHeader(headers.get('x-rate-limit-reset'))
    const nowSeconds = Date.now() / 1000
    if (reset !== null && reset > nowSeconds) this._block(reset * 1000 - Date.now())
    else this._block(this._config.pauseDefaultMs)
    return 'The V2EX query allowance is low, so this process issues no further requests until the allowance resets.'
  }

  /**
   * Read the pause a 429 asks for, from `Retry-After` then the rate-limit reset.
   *
   * @param headers - the 429 response's headers.
   * @returns the pause length in milliseconds.
   */
  _retryAfterMs(headers) {
    return retryAfterMs(headers, this._config.pauseDefaultMs, 'x-rate-limit-reset')
  }
}

/**
 * Second check of the request whitelist: the path is known, every parameter
 * key is allowed for it, and the show endpoint's two forms stay mutually
 * exclusive.
 *
 * @param path - the requested endpoint path.
 * @param params - the requested query parameters.
 */
function authorize(path, params) {
  const allowed = ALLOWED_PARAMS.get(path)
  const keys = Object.keys(params).sort()
  if (allowed === undefined || keys.some(key => !allowed.has(key))) {
    throw new UsageError('The request is not in the V2EX endpoint whitelist.')
  }
  if (path === SHOW_PATH) {
    const form = keys.join(',')
    if (form !== 'id' && form !== 'node_name,page') {
      throw new UsageError('The V2EX request parameter combination is not supported.')
    }
  }
}

// ── tool value schemas ──────────────────────────────────────────────────────

/** A timestamp or counter that V2EX may omit, mapped to null. */
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

/** A nullable string field. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** The node a topic belongs to, or null when V2EX omits it. */
const NODE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['name', 'title'],
      properties: { name: { type: 'string' }, title: { type: 'string' } },
      additionalProperties: false,
    },
    { type: 'null' },
  ],
}

/** The member who wrote a topic or reply, or null for a deleted account. */
const AUTHOR_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['username'],
      properties: { username: { type: 'string' }, id: { type: 'string' } },
      additionalProperties: false,
    },
    { type: 'null' },
  ],
}

/** Cache state and rate-limit account of one successful response. */
const SNAPSHOT_SCHEMA = {
  type: 'object',
  required: ['cache_age_seconds', 'cache_status', 'rate_limit_remaining', 'rate_limit_reset_at'],
  properties: {
    cache_age_seconds: NULLABLE_INTEGER,
    cache_status: { type: 'string', enum: CACHE_STATUSES },
    rate_limit_remaining: NULLABLE_INTEGER,
    rate_limit_reset_at: NULLABLE_INTEGER,
    warning: { type: 'string' },
  },
  additionalProperties: false,
}

/** One topic as the list endpoints return it. */
const TOPIC_BRIEF_SCHEMA = {
  type: 'object',
  required: [
    'id', 'title', 'url', 'node', 'author', 'replies',
    'last_touched', 'content_excerpt', 'content_chars', 'content_truncated',
  ],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    node: NODE_SCHEMA,
    author: AUTHOR_SCHEMA,
    replies: { type: 'integer' },
    last_touched: { type: 'string' },
    content_excerpt: { type: 'string' },
    content_chars: { type: 'integer' },
    content_truncated: { type: 'boolean' },
  },
  additionalProperties: false,
}

/** One reply. */
const REPLY_SCHEMA = {
  type: 'object',
  required: ['id', 'topic_id', 'author', 'created', 'last_modified', 'content', 'content_chars', 'content_truncated'],
  properties: {
    id: { type: 'string' },
    topic_id: { type: 'string' },
    author: AUTHOR_SCHEMA,
    created: { type: 'string' },
    last_modified: { type: 'string' },
    content: { type: 'string' },
    content_chars: { type: 'integer' },
    content_truncated: { type: 'boolean' },
  },
  additionalProperties: false,
}

/** The closed failure value every tool returns instead of throwing. */
const ERROR_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'error'],
  properties: {
    ok: { type: 'boolean', const: false },
    source: { type: 'string', const: 'v2ex' },
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        retry_at: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

/** A trimmed topic list from `hot`, `latest`, or a node. */
const TOPIC_LIST_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'query', 'available_count', 'returned_count', 'items', 'snapshot'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'v2ex' },
    query: { type: 'string' },
    available_count: { type: 'integer' },
    returned_count: { type: 'integer' },
    items: { type: 'array', items: TOPIC_BRIEF_SCHEMA },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** One trimmed topic detail. */
const TOPIC_SUCCESS_SCHEMA = {
  type: 'object',
  required: [
    'ok', 'source', 'query', 'found', 'id', 'title', 'url', 'node', 'author', 'replies',
    'last_reply_by', 'created', 'last_modified', 'last_touched', 'deleted', 'content',
    'content_chars', 'content_truncated', 'snapshot',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'v2ex' },
    query: { type: 'string' },
    found: { type: 'boolean' },
    id: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    node: NODE_SCHEMA,
    author: AUTHOR_SCHEMA,
    replies: { type: 'integer' },
    last_reply_by: NULLABLE_STRING,
    created: { type: 'string' },
    last_modified: { type: 'string' },
    last_touched: { type: 'string' },
    deleted: { type: 'boolean' },
    content: { type: 'string' },
    content_chars: { type: 'integer' },
    content_truncated: { type: 'boolean' },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** A window of one topic's replies. */
const REPLIES_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'query', 'available_count', 'returned_count', 'order', 'items', 'snapshot'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'v2ex' },
    query: { type: 'string' },
    available_count: { type: 'integer' },
    returned_count: { type: 'integer' },
    order: { type: 'string', enum: ['latest', 'oldest'] },
    items: { type: 'array', items: REPLY_SCHEMA },
    note: { type: 'string' },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** Output contract of the three list tools. */
const TOPIC_LIST_OUTPUT = { oneOf: [TOPIC_LIST_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the topic tool. */
const TOPIC_OUTPUT = { oneOf: [TOPIC_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the replies tool. */
const REPLIES_OUTPUT = { oneOf: [REPLIES_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

// ── tool arguments ──────────────────────────────────────────────────────────

/**
 * Read an optional `limit` argument.
 *
 * @param args - the raw tool arguments.
 * @param name - the argument name, also used in the failure message.
 * @param fallback - the value used when the argument is absent.
 * @param maximum - the largest accepted value.
 * @returns the accepted limit.
 */
function readLimit(args, name, fallback, maximum) {
  const raw = readArg(args, name)
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > maximum) {
    throw new UsageError(`${name} must be an integer from 1 to ${maximum}.`)
  }
  return raw
}

/**
 * Read the required numeric topic id.
 *
 * @param args - the raw tool arguments.
 * @returns the accepted id.
 */
function readTopicId(args) {
  const raw = readArg(args, 'topic_id')
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new UsageError('topic_id must be a positive integer, as it appears in the topic URL /t/<id>.')
  }
  return raw
}

/**
 * Read the required node slug.
 *
 * @param args - the raw tool arguments.
 * @returns the accepted slug.
 */
function readNodeName(args) {
  const raw = readArg(args, 'node_name')
  if (typeof raw !== 'string' || !NODE_NAME_PATTERN.test(raw)) {
    throw new UsageError('node_name must be 1-32 lowercase letters, digits, or hyphens, as it appears in the node URL /go/<name>.')
  }
  return raw
}

/**
 * Read the optional reply ordering.
 *
 * @param args - the raw tool arguments.
 * @returns `latest` or `oldest`.
 */
function readOrder(args) {
  const raw = readArg(args, 'order')
  if (raw === undefined) return 'latest'
  if (raw !== 'latest' && raw !== 'oldest') throw new UsageError('order must be either "latest" or "oldest".')
  return raw
}

/**
 * Read one argument from possibly non-object arguments.
 *
 * @param args - the raw tool arguments.
 * @param key - the argument name.
 * @returns the value, or undefined when absent.
 */
function readArg(args, key) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  return args[key]
}

/**
 * Build the `limit` parameter declaration shared by the list tools.
 *
 * @param maximum - the largest accepted value.
 * @param fallback - the value used when the argument is absent.
 * @returns the parameter schema.
 */
function limitParameter(maximum, fallback) {
  return {
    type: 'integer',
    description: `Maximum number of topics to return, from 1 to ${maximum}. Defaults to ${fallback}.`,
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

/**
 * Render one tool value as the single JSON text block the model reads.
 *
 * @param _args - the executed arguments; unused.
 * @param value - the validated tool value.
 * @returns the rendered content.
 */
function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Build each tool's pending-call presentation.
 *
 * @param title - the card title.
 * @param kind - the call kind shown in the UI.
 * @param rawInput - the arguments worth showing, when any.
 * @returns the presentation.
 */
function present(title, kind = 'fetch', rawInput = undefined) {
  return rawInput === undefined
    ? { card: 'generic', title, kind }
    : { card: 'generic', title, kind, rawInput }
}

/**
 * Describe one topic id argument.
 */
const TOPIC_ID_PARAMETER = {
  type: 'integer',
  description: 'Numeric V2EX topic id, as it appears in the topic URL /t/<id>.',
}

/**
 * Build the object-rooted parameter schema for one tool.
 *
 * @param properties - the declared arguments.
 * @param required - the argument names the model must supply.
 * @returns the parameter schema.
 */
function parameters(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...required.length > 0 ? { required } : {},
    additionalProperties: false,
  }
}

/**
 * Build the five tool definitions bound to one client.
 *
 * @param client - the shared process-local client.
 * @param config - the resolved plugin options.
 * @returns the tool definitions, in registration order.
 */
function buildTools(client, config) {
  const listLimit = () => limitParameter(config.listMaxLimit, config.listDefaultLimit)
  const card = (title, args) => present(title, 'fetch', args)
  return [
    {
      name: 'v2ex_hot',
      description: 'List the topics V2EX currently ranks as hot. Returns the trimmed snapshot the public API serves, ranked by V2EX; the list has no pagination.',
      parameters: parameters({ limit: listLimit() }),
      output: { schema: TOPIC_LIST_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: () => card('V2EX hot topics'),
      execute: (args, exec) => client.hot(
        readLimit(args, 'limit', config.listDefaultLimit, config.listMaxLimit),
        exec?.signal,
      ),
    },
    {
      name: 'v2ex_latest',
      description: 'List the most recently created V2EX topics. Returns the trimmed snapshot the public API serves; the list has no pagination.',
      parameters: parameters({ limit: listLimit() }),
      output: { schema: TOPIC_LIST_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: () => card('V2EX latest topics'),
      execute: (args, exec) => client.latest(
        readLimit(args, 'limit', config.listDefaultLimit, config.listMaxLimit),
        exec?.signal,
      ),
    },
    {
      name: 'v2ex_node',
      description: 'List the newest topics in one V2EX node, a topic category such as "python", "apple", "jobs", or "qna". Returns the trimmed snapshot the public API serves; only the node\'s first page is available.',
      parameters: parameters({
        node_name: {
          type: 'string',
          description: 'Node slug, as it appears in the node URL /go/<name>: 1-32 lowercase letters, digits, or hyphens.',
        },
        limit: listLimit(),
      }, ['node_name']),
      output: { schema: TOPIC_LIST_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => card('V2EX node topics', presentableArgs(args, 'node_name')),
      execute: (args, exec) => client.node(
        readNodeName(args),
        readLimit(args, 'limit', config.listDefaultLimit, config.listMaxLimit),
        exec?.signal,
      ),
    },
    {
      name: 'v2ex_topic',
      description: `Read one V2EX topic by numeric id: its title, node, author, timestamps, and body. The body is cut at ${config.topicContentChars} characters when longer, while content_chars reports the full length.`,
      parameters: parameters({ topic_id: TOPIC_ID_PARAMETER }, ['topic_id']),
      output: { schema: TOPIC_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => card('V2EX topic', presentableArgs(args, 'topic_id')),
      execute: (args, exec) => client.topic(readTopicId(args), exec?.signal),
    },
    {
      name: 'v2ex_replies',
      description: `Read replies to one V2EX topic by numeric id, choosing either the newest or the earliest of them. Each body is cut at ${config.replyContentChars} characters when longer, while content_chars reports its full length. The API returns every reply of a topic in one response, so there is no pagination; limit selects a window from that complete set. An empty result cannot distinguish a missing topic from a topic with no replies.`,
      parameters: parameters({
        topic_id: TOPIC_ID_PARAMETER,
        limit: {
          type: 'integer',
          description: `Maximum number of replies to return, from 1 to ${config.replyMaxLimit}. Defaults to ${config.replyDefaultLimit}.`,
        },
        order: {
          type: 'string',
          enum: ['latest', 'oldest'],
          description: 'Which replies to return: "latest" for the newest ones, "oldest" for the earliest. Defaults to "latest".',
        },
      }, ['topic_id']),
      output: { schema: REPLIES_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => card('V2EX topic replies', presentableArgs(args, 'topic_id')),
      execute: (args, exec) => client.replies(
        readTopicId(args),
        readLimit(args, 'limit', config.replyDefaultLimit, config.replyMaxLimit),
        readOrder(args),
        exec?.signal,
      ),
    },
  ]
}

/**
 * Project the arguments worth showing on a call card. Presentation runs on
 * playback of arbitrary logged arguments, so it never throws.
 *
 * @param args - the raw tool arguments.
 * @param key - the argument name to show.
 * @returns the projected arguments, or undefined when there is nothing to show.
 */
function presentableArgs(args, key) {
  const value = readArg(args, key)
  return typeof value === 'string' || typeof value === 'number' ? { [key]: value } : undefined
}

/**
 * Register the five V2EX query tools. Each registration is fiber-scoped, so
 * unloading the plugin removes every tool it added.
 *
 * @param ctx - the plugin context, which must expose the tool registry.
 * @param config - the row's `config`, validated here.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const client = new V2exClient(resolved)
  for (const tool of buildTools(client, resolved)) ctx.tools.register(tool)
}

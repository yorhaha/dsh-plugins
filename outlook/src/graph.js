/**
 * The Microsoft Graph REST client: one authenticated request path with bounded
 * retries, paging, and the plugin's stable error codes.
 *
 * Graph throttles per mailbox and per tenant, so a refusal is an expected
 * outcome rather than a failure: `429`, `503`, and `504` are retried after the
 * delay the service asks for, capped so a capture cannot hang for minutes. A
 * refused token is retried exactly once against a freshly acquired one, because
 * the common cause is a token that expired between two pages.
 *
 * A `@odata.nextLink` is followed only when it stays on the configured Graph
 * origin, so a response can never forward this client's bearer token elsewhere.
 *
 * @module dsh-outlook/src/graph
 */

/** Graph endpoint every request is resolved against. */
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/** Attempts one request makes before it gives up. */
const MAX_ATTEMPTS = 4

/** Longest single `Retry-After` pause, in milliseconds. */
const MAX_RETRY_SLEEP_MS = 60_000

/** Statuses Graph asks callers to retry. */
const RETRY_STATUSES = new Set([429, 503, 504])

/**
 * A Graph failure carrying a stable code the model sees.
 */
export class GraphError extends Error {
  /**
   * @param code - Stable machine code.
   * @param message - Detail for the log.
   * @param options - Optional HTTP facts about the failure.
   * @param options.status - Response status, when there was a response.
   * @param options.retryAfterMs - Delay the service asked for, when it named one.
   */
  constructor(code, message, { status, retryAfterMs } = {}) {
    super(message)
    this.name = 'GraphError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Pause for a duration.
 * @param ms - Milliseconds to wait.
 * @returns resolution after the wait.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** One authenticated Graph client. */
export class GraphClient {
  #auth
  #fetch
  #sleep
  #base
  #origin
  #logger
  #signal
  #timeoutMs
  #token = null
  #forceRefresh = false

  /**
   * @param options - Construction options.
   * @param options.auth - Token source; `accessToken({ force })` resolves a bearer token.
   * @param options.baseUrl - Graph endpoint root.
   * @param options.fetchImpl - `fetch` implementation, for tests.
   * @param options.sleep - Delay function, for tests.
   * @param options.signal - Cancellation signal for every request this client makes.
   * @param options.timeoutMs - Deadline of one request, in milliseconds.
   * @param options.logger - Plugin logger.
   */
  constructor({ auth, baseUrl = GRAPH_BASE, fetchImpl = globalThis.fetch, sleep = defaultSleep, signal, timeoutMs = 30_000, logger }) {
    this.#auth = auth
    this.#fetch = fetchImpl
    this.#sleep = sleep
    this.#base = baseUrl
    this.#origin = new URL(baseUrl).origin
    this.#signal = signal
    this.#timeoutMs = timeoutMs
    this.#logger = logger
  }

  /**
   * Perform one GET and return its JSON body.
   * @param path - Path below the endpoint root, or an absolute `@odata.nextLink`.
   * @param options - Request options.
   * @param options.params - Query parameters.
   * @param options.headers - Extra request headers.
   * @returns the parsed body, or null when the response carried none.
   * @throws {GraphError} with a stable code.
   */
  async get(path, { params, headers } = {}) {
    return this.#send('GET', path, { params, headers })
  }

  /**
   * Perform one POST and return its parsed JSON body.
   *
   * A write is not idempotent: the shared policy deliberately does not repeat a
   * POST whose transport failed or whose reply was an uncertain 503/504, because
   * the mailbox may already have acted on it. A 429 that names "nothing was
   * processed" is still retried, and a 401 refreshes the token once.
   *
   * @param path - Path below the endpoint root.
   * @param options - Request options.
   * @param options.params - Query parameters.
   * @param options.headers - Extra request headers.
   * @param options.body - Value serialized as the JSON request body.
   * @returns the parsed body, or null when the response carried none.
   * @throws {GraphError} with a stable code.
   */
  async post(path, { params, headers, body } = {}) {
    return this.#send('POST', path, { params, headers, body })
  }

  /**
   * Perform one authenticated request, under the retry and refresh policy every
   * verb shares.
   * @param method - HTTP method.
   * @param path - Path below the endpoint root, or an absolute `@odata.nextLink`.
   * @param options - Request options.
   * @param options.params - Query parameters.
   * @param options.headers - Extra request headers.
   * @param options.body - Value serialized as the request body.
   * @returns the parsed body, or null when the response carried none.
   * @throws {GraphError} with a stable code.
   */
  async #send(method, path, { params, headers, body } = {}) {
    const url = this.#resolve(path, params)
    const extra = body === undefined ? headers : { 'content-type': 'application/json', ...headers }
    // A GET is safe to repeat. A POST or PATCH that failed in transport may
    // already have been applied, so retrying it could apply the same change
    // twice.
    const idempotent = method === 'GET'
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (this.#signal?.aborted === true) {
        throw new GraphError('cancelled', 'Graph request cancelled')
      }
      // Resolved outside the transport's try: a sign-in that cannot produce a
      // token is not a network failure, and retrying it four times would report
      // `network_error` for what is really `auth_required`.
      const requestHeaders = await this.#headers(extra)
      // Every attempt gets its own deadline. Without one, a connection that
      // stops answering holds the capture, and teardown waits for it, forever.
      const timeout = AbortSignal.timeout(this.#timeoutMs)
      const signal = this.#signal === undefined ? timeout : AbortSignal.any([this.#signal, timeout])
      let response
      try {
        response = await this.#fetch(url, {
          method,
          headers: requestHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        })
      } catch (error) {
        if (this.#signal?.aborted === true) throw new GraphError('cancelled', 'Graph request cancelled')
        if (error?.name === 'TimeoutError') {
          if (!idempotent || attempt === MAX_ATTEMPTS - 1) {
            throw new GraphError('timeout', `Graph did not answer within ${this.#timeoutMs} ms`)
          }
          await this.#wait(backoffMs(attempt))
          continue
        }
        if (error?.name === 'AbortError') throw new GraphError('cancelled', 'Graph request cancelled')
        if (!idempotent || attempt === MAX_ATTEMPTS - 1) {
          throw new GraphError('network_error', `Graph request failed: ${String(error?.message ?? error)}`)
        }
        await this.#wait(backoffMs(attempt))
        continue
      }
      if (response.status === 401 && attempt === 0) {
        // The cached token may simply have expired between two pages. Force a
        // silent refresh: `accessToken()` would hand back the same cached token
        // while it is still outside the expiry margin.
        this.#token = null
        this.#forceRefresh = true
        continue
      }
      if (RETRY_STATUSES.has(response.status)) {
        const retryAfterMs = retryAfter(response.headers)
        // 429 means nothing was processed, but 503/504 on a write leaves its
        // outcome unknown, so only a GET may repeat that attempt.
        if (!idempotent && response.status !== 429) {
          throw await this.#failure(response, retryAfterMs)
        }
        /* v8 ignore next -- the last attempt raises below instead of sleeping */
        if (attempt === MAX_ATTEMPTS - 1) throw await this.#failure(response, retryAfterMs)
        this.#logger?.debug?.(`outlook: Graph ${response.status}; retrying in ${retryAfterMs} ms`)
        await this.#wait(retryAfterMs)
        continue
      }
      if (!response.ok) throw await this.#failure(response, retryAfter(response.headers))
      return await this.#json(response)
    }
    /* v8 ignore next -- the loop either returns or throws on its last attempt */
    throw new GraphError('network_error', `Graph request retried ${MAX_ATTEMPTS} times without an answer`)
  }

  /**
   * Read the body of a successful response.
   *
   * A delete answers 204 and a write may answer 200 with nothing in it; neither
   * is an error, so an absent body is null rather than an `invalid_json`.
   *
   * @param response - The successful response.
   * @returns the parsed body, or null when there was none.
   * @throws {GraphError} with code `invalid_json` when a non-empty body does not parse.
   */
  async #json(response) {
    const text = await response.text()
    if (text.trim() === '') return null
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new GraphError('invalid_json', `Graph returned a body that is not JSON: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Walk one collection, following `@odata.nextLink` to the end.
   * @param path - Collection path below the endpoint root.
   * @param options - Request options.
   * @param options.params - Query parameters for the first request.
   * @param options.headers - Extra request headers.
   * @param options.maxPages - Stop after this many pages and report the shortfall.
   * @yields one page payload per request.
   */
  async *pages(path, { params, headers, maxPages = Number.POSITIVE_INFINITY } = {}) {
    let next = path
    let query = params
    let pages = 0
    while (next !== null) {
      const payload = await this.get(next, { params: query, headers })
      pages += 1
      yield payload
      next = typeof payload?.['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null
      query = undefined
      if (next !== null && pages >= maxPages) return
    }
  }

  /**
   * Wait out a retry delay, stopping as soon as the caller cancels.
   * @param ms - Milliseconds Graph asked for.
   * @returns resolution after the wait, or rejection with `cancelled`.
   */
  async #wait(ms) {
    if (this.#signal === undefined) {
      await this.#sleep(ms)
      return
    }
    if (this.#signal.aborted) throw new GraphError('cancelled', 'Graph request cancelled')
    let listener
    try {
      await Promise.race([
        this.#sleep(ms),
        new Promise((_resolve, reject) => {
          listener = () => reject(new GraphError('cancelled', 'Graph request cancelled'))
          this.#signal.addEventListener('abort', listener, { once: true })
        }),
      ])
    } finally {
      if (listener !== undefined) this.#signal.removeEventListener('abort', listener)
    }
  }

  /**
   * Authenticated headers for one request.
   * @param extra - Caller-supplied headers, which win over the defaults.
   * @returns the header map.
   */
  async #headers(extra) {
    if (this.#token === null) {
      this.#token = await this.#auth.accessToken(this.#forceRefresh ? { force: true } : undefined)
      this.#forceRefresh = false
    }
    const headers = {
      authorization: `Bearer ${this.#token}`,
      accept: 'application/json',
      // Bodies arrive as plain text: smaller than HTML and directly searchable.
      prefer: 'outlook.body-content-type="text"',
    }
    for (const [key, value] of Object.entries(extra ?? {})) headers[key.toLowerCase()] = value
    return headers
  }

  /**
   * Absolute URL for a path or a next link.
   * @param path - Relative path or absolute link.
   * @param params - Query parameters for a relative path.
   * @returns the absolute URL.
   * @throws {GraphError} when an absolute link leaves the configured origin.
   */
  #resolve(path, params) {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path)
      if (url.origin !== this.#origin) {
        throw new GraphError('invalid_envelope', `Graph paging left the configured origin: ${url.origin}`)
      }
      return url.toString()
    }
    const url = new URL(`${this.#base}${path.startsWith('/') ? path : `/${path}`}`)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /**
   * Build the failure one response stands for.
   * @param response - The failed response.
   * @param retryAfterMs - Delay the service asked for, when it named one.
   * @returns the error to throw.
   */
  async #failure(response, retryAfterMs) {
    const detail = await safeText(response)
    const code = codeFor(response.status)
    return new GraphError(code, `Graph ${response.status}: ${detail}`, { status: response.status, retryAfterMs })
  }
}

/**
 * Stable code for an HTTP status Graph returned.
 * @param status - Response status.
 * @returns the code.
 */
function codeFor(status) {
  if (status === 401) return 'auth_required'
  if (status === 403) return 'auth_required'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'upstream_5xx'
  return `http_${status}`
}

/**
 * Read a bounded, single-line excerpt of a failed response body.
 * @param response - The failed response.
 * @returns the excerpt, or an empty string.
 */
async function safeText(response) {
  try {
    const text = await response.text()
    return text.slice(0, 300).replace(/\s+/g, ' ').trim()
  } catch {
    // A body that cannot be read does not change the status this failure reports.
    return ''
  }
}

/**
 * Delay Graph asked for, in milliseconds.
 * @param headers - Response headers.
 * @returns the delay, defaulting to five seconds and capped.
 */
function retryAfter(headers) {
  const raw = headers?.get?.('retry-after')
  if (typeof raw === 'string' && raw !== '') {
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_SLEEP_MS)
    const date = Date.parse(raw)
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_SLEEP_MS)
  }
  return 5000
}

/**
 * Exponential backoff for a transport failure, which carries no `Retry-After`.
 * @param attempt - Zero-based attempt number.
 * @returns the delay in milliseconds.
 */
function backoffMs(attempt) {
  return Math.min(500 * 2 ** attempt, MAX_RETRY_SLEEP_MS)
}

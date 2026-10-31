/**
 * The HTTP client core shared by the taobao, v2ex, zhihu, and xiaohongshu
 * bundles.
 *
 * taobao and v2ex talk to one public upstream with one process-local client:
 * requests are serialized, paced by a minimum interval, retried once on a
 * transport failure, and backed off process-wide after a 429 or a refusal. The
 * two had a copy of that machinery each, identical down to the wording except
 * for the service name, and the copies had already drifted on which clock they
 * measured the interval with.
 *
 * zhihu and xiaohongshu keep their own endpoints, signing, and budgets, but
 * both reuse the bounded response reader, retry timing, and failure-payload
 * helpers below; zhihu also uses the pacer and text helpers.
 *
 * What stays in each bundle is what actually differs: the endpoint, the request
 * shape, the status ladder (which status means "not found" here), and how a
 * successful body is read. Everything below is the part that must behave the
 * same wherever it is used.
 *
 * The bundles reach this file by relative path; see `shared/schedule.js` for
 * why that is acceptable here.
 *
 * @module dsh-plugins/shared/http
 */

/**
 * Expected failure of a request that was issued (or that process-local backoff
 * refused before issuing). It carries the closed error code and, for a backoff,
 * the wall-clock instant at which this process may request again.
 */
export class RequestFailure extends Error {
  /**
   * @param code - closed failure code rendered into the payload.
   * @param message - model-facing explanation.
   * @param options - `retryable` and the epoch-millisecond `retryAt`, if any.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'RequestFailure'
    this.code = code
    this.retryable = options.retryable === true
    this.retryAt = options.retryAt ?? null
  }

  /**
   * The model-facing failure value.
   * @param source - the plugin's source tag, such as `taobao`.
   * @returns the failure payload.
   */
  payload(source) {
    const error = { code: this.code, message: this.message, retryable: this.retryable }
    if (this.retryAt !== null) error.retry_at = isoSeconds(Math.floor(this.retryAt / 1000), 'The retry instant')
    return { ok: false, source, error }
  }
}

/**
 * Build a bundle's local-argument error class.
 *
 * Each bundle keeps its own name because that name is what a caller sees when
 * an argument is refused, and the checks assert it.
 *
 * @param name - the class name to report, such as `TaobaoUsageError`.
 * @returns the error class.
 */
export function defineUsageError(name) {
  return class extends Error {
    /** @param message - what the caller got wrong. */
    constructor(message) {
      super(message)
      this.name = name
    }
  }
}

/**
 * Turn a caught error into a failure payload, or rethrow when it is not one.
 * @param error - the caught value.
 * @param source - the plugin's source tag.
 * @returns the failure payload.
 * @throws the original error when it carries no closed code.
 */
export function toFailurePayload(error, source) {
  if (error instanceof RequestFailure) return error.payload(source)
  throw error
}

/**
 * Whether the caller cancelled, rather than the request timing out.
 * @param signal - the caller's signal, if any.
 * @returns true when the caller aborted.
 */
export function isCallerAbort(signal) {
  return signal !== undefined && signal !== null && signal.aborted === true
}

/**
 * Whether a transport failure is this request's own timeout.
 * @param error - the thrown value.
 * @returns true for an aborted fetch.
 */
export function isTimeout(error) {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * Wait without a rejection path.
 * @param ms - milliseconds.
 * @returns resolution after the delay.
 */
export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Read one non-negative integer header.
 * @param value - the header value, or null.
 * @returns the number, or null when absent or not an integer.
 */
export function intHeader(value) {
  if (value === null || value === undefined) return null
  const stripped = value.trim()
  return /^[0-9]+$/.test(stripped) ? Number(stripped) : null
}

/**
 * Cut text to a number of code points, keeping surrogate pairs whole.
 * @param text - the text.
 * @param maximum - the longest accepted code-point count.
 * @returns the text, or its prefix.
 */
export function truncate(text, maximum) {
  if (text.length <= maximum) return text
  let units = 0
  let count = 0
  for (const character of text) {
    if (count === maximum) break
    units += character.length
    count += 1
  }
  return text.slice(0, units)
}

/**
 * Count code points, so a Chinese reply costs what a reader sees.
 * @param text - the text.
 * @returns the code-point count.
 */
export function characterCount(text) {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/**
 * Format an epoch-second timestamp as `YYYY-MM-DDTHH:MM:SSZ`.
 * @param epochSeconds - the instant.
 * @param service - the source named in the failure, when the value is unusable.
 * @returns the UTC instant.
 * @throws {RequestFailure} when the value is outside the representable range.
 */
export function isoSeconds(epochSeconds, service) {
  const date = new Date(epochSeconds * 1000)
  if (Number.isNaN(date.getTime())) {
    throw new RequestFailure('invalid_response', `${service} response timestamp is outside the representable range.`)
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Issue one request with the caller's signal combined with the request timeout.
 * @param url - the absolute URL.
 * @param init - fetch options without `signal` or `redirect`.
 * @param options - `config` for the timeout, and the caller's `signal`.
 * @returns the response.
 */
export function sendRequest(url, init, { config, signal }) {
  const timeout = AbortSignal.timeout(config.requestTimeoutMs)
  const combined = signal === undefined || signal === null ? timeout : AbortSignal.any([signal, timeout])
  return fetch(url, { ...init, redirect: 'manual', signal: combined })
}

/**
 * Read at most `limit` bytes of a response body.
 * @param response - the response.
 * @param limit - the byte ceiling.
 * @param service - the source named in the failure.
 * @returns the status, headers, and body bytes.
 * @throws {RequestFailure} `response_too_large` when the body exceeds the ceiling.
 */
export async function readBoundedBody(response, limit, service) {
  const chunks = []
  let total = 0
  const reader = response.body === null ? null : response.body.getReader()
  if (reader !== null) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new RequestFailure(
          'response_too_large',
          `The ${service} response exceeds the single-read limit, so no data was returned.`,
        )
      }
      chunks.push(value)
    }
  }
  return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks) }
}

/**
 * Read the pause a 429 asks for.
 * @param headers - the response headers.
 * @param fallbackMs - the pause used when the response says nothing usable.
 * @param resetHeader - a rate-limit reset header to fall back on, when the API has one.
 * @returns the pause length in milliseconds.
 */
export function retryAfterMs(headers, fallbackMs, resetHeader = null) {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null) {
    const stripped = retryAfter.trim()
    if (/^[0-9]+$/.test(stripped)) return Math.max(Number(stripped) * 1000, 1000)
  }
  if (resetHeader !== null) {
    const reset = intHeader(headers.get(resetHeader))
    if (reset !== null) return Math.max(reset * 1000 - Date.now(), 1000)
  }
  return fallbackMs
}

/**
 * The process-local pacing and backoff every request goes through.
 *
 * `now` is the clock the interval is measured with; it may be monotonic, which
 * is why a wall-clock instant is tracked beside it for the value a caller reads.
 *
 * @param options - pacing options.
 * @param options.label - service name used in the "temporarily paused" message.
 * @param options.config - resolved options carrying `minIntervalMs`.
 * @param options.now - monotonic clock in milliseconds; defaults to `Date.now`.
 * @param options.wallNow - wall clock in milliseconds for the reported instant.
 * @returns the pacer.
 */
export function createPacer({ label, config, now = Date.now, wallNow = Date.now }) {
  let lastRequestAt = null
  let blockedUntil = null
  let blockedWall = null

  /**
   * Extend the process-local backoff, never shortening an existing one.
   * @param ms - the pause length in milliseconds.
   */
  const block = (ms) => {
    const until = now() + ms
    if (blockedUntil === null || until > blockedUntil) {
      blockedUntil = until
      blockedWall = wallNow() + ms
    }
  }

  return {
    /**
     * Record that a request is being issued now, so the next one waits its interval.
     */
    start() {
      lastRequestAt = now()
    },

    /**
     * Apply the backoff and minimum-interval pacing. Call inside the
     * serialization chain, so the state it reads cannot change underneath it.
     * @returns resolution once this process may issue the request.
     * @throws {RequestFailure} `temporarily_blocked` while a backoff is running.
     */
    async gate() {
      const current = now()
      if (blockedUntil !== null) {
        if (current < blockedUntil) {
          throw new RequestFailure(
            'temporarily_blocked',
            `${label} requests are temporarily paused in this process. Try again later.`,
            { retryable: true, retryAt: blockedWall },
          )
        }
        blockedUntil = null
        blockedWall = null
      }
      if (lastRequestAt !== null) {
        const wait = lastRequestAt + config.minIntervalMs - current
        if (wait > 0) await sleep(wait)
      }
    },

    /**
     * Extend the backoff from outside the request path, such as a low-allowance warning.
     * @param ms - the pause length in milliseconds.
     */
    block,

    /**
     * Back this process off and build the matching failure.
     * @param code - the closed failure code.
     * @param message - the model-facing explanation.
     * @param ms - the pause length in milliseconds.
     * @returns the failure to throw.
     */
    pause(code, message, ms) {
      block(ms)
      return new RequestFailure(code, message, { retryable: true, retryAt: blockedWall })
    },
  }
}

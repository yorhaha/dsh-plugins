/**
 * QR-code sign-in.
 *
 * The host owns the whole exchange: it asks the passport service for a QR
 * challenge, polls that challenge on a timer, validates the session the code
 * produces, and writes the credential record. A client only renders the URL and
 * reads the state, so closing the page mid-scan neither cancels nor corrupts the
 * login, and no cookie ever crosses to the browser.
 *
 * @module dsh-bilibili/src/login
 */

import { BilibiliClient, COOKIE_NAMES, HEADERS, PASSPORT_BASE, QR_GENERATE_PATH, QR_POLL_PATH, CredentialUnavailableError, utcNowIso } from './client.js'

/** Default window a QR challenge stays usable, matching the upstream key lifetime. */
const DEFAULT_TIMEOUT_SECONDS = 180

/** Delay between challenge polls. */
const DEFAULT_POLL_INTERVAL_MS = 2000

/** Deadline of one passport request, so a stalled call cannot outlive the challenge window. */
const REQUEST_TIMEOUT_MS = 30_000

/** Login states a caller can observe. */
export const LOGIN_STATES = Object.freeze([
  'idle',
  'waiting',
  'scanned',
  'confirmed',
  'expired',
  'failed',
])

/** Upstream poll codes for a challenge that is not finished yet. */
const POLL_PENDING = 86101
const POLL_SCANNED = 86090
const POLL_EXPIRED = 86038

/**
 * Decode one passport response envelope.
 * @param response - The fetch response.
 * @returns the envelope's `data` object.
 * @throws when the response is an error or its envelope is not a success.
 */
async function decodeLoginResponse(response) {
  if (response.status >= 400) {
    const error = new Error(`login_http_${response.status}`)
    error.code = error.message
    throw error
  }
  let envelope
  try {
    envelope = await response.json()
  } catch {
    const error = new Error('login_invalid_json')
    error.code = error.message
    throw error
  }
  if (typeof envelope !== 'object' || envelope === null || envelope.code !== 0) {
    const error = new Error('login_api_error')
    error.code = error.message
    throw error
  }
  const data = envelope.data
  if (typeof data !== 'object' || data === null) {
    const error = new Error('login_invalid_envelope')
    error.code = error.message
    throw error
  }
  return data
}

/**
 * Read one cookie from a response's `Set-Cookie` headers.
 * @param response - The fetch response.
 * @param name - Cookie name.
 * @returns the cookie value, or undefined.
 */
function cookieFromHeaders(response, name) {
  const headers =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
  for (const header of headers) {
    const [pair] = header.split(';')
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    if (pair.slice(0, separator).trim().toLowerCase() === name.toLowerCase()) {
      return pair.slice(separator + 1).trim()
    }
  }
  return undefined
}

/**
 * Build the cookie bag from a confirmed challenge.
 *
 * The confirmation carries the session either as query parameters on a redirect
 * URL or as `Set-Cookie` headers, and which one an account sees is not
 * predictable, so both are read.
 *
 * @param redirectUrl - The `url` the poll response carried.
 * @param response - The poll response itself.
 * @returns the cookie bag, including the `saved_at` stamp.
 * @throws when the session cookie is absent from both carriers.
 */
function parseLoginCredential(redirectUrl, response) {
  const query = new Map()
  try {
    for (const [key, value] of new URL(redirectUrl).searchParams) {
      query.set(key.toLowerCase(), value)
    }
  } catch {
    // A malformed redirect URL is not fatal: the headers may still carry the session.
  }
  const bag = {}
  for (const [field, cookieName] of Object.entries(COOKIE_NAMES)) {
    const value = query.get(cookieName.toLowerCase()) ?? cookieFromHeaders(response, cookieName)
    if (typeof value === 'string' && value !== '') bag[field] = value
  }
  if (bag.sessdata === undefined) throw new CredentialUnavailableError()
  bag.saved_at = utcNowIso()
  return bag
}

/**
 * One QR sign-in attempt, owned by the host.
 */
export class QrLogin {
  #saveCookies
  #timeoutSeconds
  #pollIntervalMs
  #sleep
  #clock
  #fetch
  #logger
  #state = 'idle'
  #url = null
  #expiresAt = null
  #error = null
  #controller = null
  #attempt = null

  /**
   * @param options - Construction options.
   * @param options.saveCookies - Persists a completed cookie bag.
   * @param options.timeoutSeconds - Window the challenge stays usable.
   * @param options.pollIntervalMs - Delay between challenge polls.
   * @param options.sleep - Timer, injected for tests.
   * @param options.clock - Current instant in milliseconds, injected for tests.
   * @param options.fetchImpl - Fetch implementation, injected for tests.
   * @param options.logger - Sink for login progress; optional.
   */
  constructor({
    saveCookies,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clock = Date.now,
    fetchImpl = globalThis.fetch,
    logger,
  }) {
    this.#saveCookies = saveCookies
    this.#timeoutSeconds = timeoutSeconds
    this.#pollIntervalMs = pollIntervalMs
    this.#sleep = sleep
    this.#clock = clock
    this.#fetch = fetchImpl
    this.#logger = logger
  }

  /** @returns the observable login state; never carries a cookie value. */
  get snapshot() {
    return { state: this.#state, url: this.#url, expiresAt: this.#expiresAt, error: this.#error }
  }

  /**
   * Start an attempt, or return the running one.
   * @returns the attempt's observable state.
   */
  async begin() {
    if (this.#state === 'waiting' || this.#state === 'scanned') return this.snapshot
    if (this.#attempt !== null) await this.#attempt.catch(() => {})
    this.#state = 'idle'
    this.#url = null
    this.#error = null
    this.#expiresAt = null
    const controller = new AbortController()
    this.#controller = controller
    const deadline = this.#clock() + this.#timeoutSeconds * 1000
    this.#attempt = this.#run(controller, deadline)
    // The exchange continues after this call returns; the caller reads `snapshot`.
    await Promise.race([this.#attempt, this.#firstChallenge(controller, deadline)])
    return this.snapshot
  }

  /**
   * Abandon the running attempt. The upstream challenge is left to expire.
   * @returns resolution after the polling loop has stopped.
   */
  async cancel() {
    this.#controller?.abort()
    await this.#attempt?.catch(() => {})
    if (this.#state === 'waiting' || this.#state === 'scanned') {
      this.#state = 'idle'
      this.#url = null
      this.#expiresAt = null
    }
  }

  /** Wait until the challenge URL is known, the attempt ended, or its window closed. */
  async #firstChallenge(controller, deadline) {
    while (this.#url === null && !controller.signal.aborted && this.#clock() < deadline) {
      if (this.#state === 'expired' || this.#state === 'failed' || this.#state === 'confirmed') return
      await this.#sleep(20)
    }
  }

  /**
   * The cancellation signal of one passport request: the attempt's own abort,
   * bounded by both the per-request deadline and the challenge's remaining window.
   * @param controller - the attempt's cancellation.
   * @param deadline - the challenge window's end, in milliseconds.
   * @returns the combined signal.
   */
  #requestSignal(controller, deadline) {
    const remaining = Math.max(1, deadline - this.#clock())
    return AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
    ])
  }

  async #run(controller, deadline) {
    try {
      const generated = await decodeLoginResponse(
        await this.#fetch(`${PASSPORT_BASE}${QR_GENERATE_PATH}?source=main-fe-header`, {
          headers: HEADERS,
          redirect: 'manual',
          signal: this.#requestSignal(controller, deadline),
        }),
      )
      const url = generated.url
      const qrKey = generated.qrcode_key
      if (typeof url !== 'string' || typeof qrKey !== 'string') {
        throw Object.assign(new Error('login_invalid_envelope'), { code: 'login_invalid_envelope' })
      }
      this.#url = url
      this.#state = 'waiting'
      this.#expiresAt = new Date(deadline).toISOString()
      this.#logger?.debug?.('bilibili: QR challenge issued')

      while (!controller.signal.aborted && this.#clock() < deadline) {
        await this.#sleep(this.#pollIntervalMs)
        if (controller.signal.aborted) break
        const response = await this.#fetch(
          `${PASSPORT_BASE}${QR_POLL_PATH}?qrcode_key=${encodeURIComponent(qrKey)}&source=main-fe-header`,
          { headers: HEADERS, redirect: 'manual', signal: this.#requestSignal(controller, deadline) },
        )
        const polled = await decodeLoginResponse(response)
        const code = polled.code
        if (code === 0) {
          const cookies = parseLoginCredential(String(polled.url ?? ''), response)
          const validator = new BilibiliClient(cookies, { fetchImpl: this.#fetch })
          let mid
          try {
            mid = await validator.validateSession()
          } finally {
            validator.close()
          }
          await this.#saveCookies({ ...cookies, dedeuserid: cookies.dedeuserid ?? mid })
          this.#state = 'confirmed'
          this.#logger?.info?.('bilibili: sign-in confirmed')
          return
        }
        if (code === POLL_EXPIRED) {
          this.#state = 'expired'
          return
        }
        if (code === POLL_SCANNED) {
          this.#state = 'scanned'
          continue
        }
        if (code !== POLL_PENDING) {
          this.#state = 'failed'
          this.#error = 'login_unknown_state'
          return
        }
      }
      if (!controller.signal.aborted && this.#state !== 'confirmed') this.#state = 'expired'
    } catch (error) {
      if (controller.signal.aborted) return
      this.#state = 'failed'
      this.#error = error?.name === 'TimeoutError'
        ? 'login_timeout'
        : typeof error?.code === 'string' ? error.code : 'login_failed'
      this.#logger?.warn?.(`bilibili: sign-in failed (${this.#error})`)
    }
  }
}

/**
 * The one HTTP client every Xiaohongshu tool shares.
 *
 * Four things keep the account out of trouble: every request goes through one
 * queue, two requests are at least `minIntervalMs` apart with random jitter,
 * separate rolling budgets cap all requests and the more sensitive search
 * endpoint, and a refusal puts the whole process on a long pause instead of
 * retrying. A small response cache answers repeated reads without touching the
 * upstream.
 *
 * The signer is local and does not call a browser. `x-s` is produced in the
 * legacy `XYS_` format first and retried once with `XYW_` when the upstream
 * answers 406; the winning format is remembered per endpoint.
 * A 406 is a signature rejection, not a rate signal, so it is the only case
 * where a second request is allowed without a human deciding to.
 *
 * @module dsh-xiaohongshu/src/client
 */

import {
  RequestFailure,
  isCallerAbort,
  isTimeout,
  readBoundedBody,
  retryAfterMs,
  sleep,
} from '../../shared/http.js'
import { buildGetUri, createDeviceProfile, signMainApi } from './signing.js'
import { parseJsonPreservingIds } from './json.js'
import {
  accountFrom,
  commentsFrom,
  noteDetailFrom,
  noteUrl,
  searchNotesFrom,
  userFrom,
  userNotesFrom,
} from './mapping.js'

/** API origin. */
const ORIGIN = 'https://edith.xiaohongshu.com'

/** Page origin, sent as Origin and Referer. */
const PAGE_ORIGIN = 'https://www.xiaohongshu.com'

/** One rolling hour. */
const HOUR_MS = 3_600_000

/** One rolling day. */
const DAY_MS = 86_400_000

/** Longest accepted search keyword, in characters. */
const MAX_KEYWORD_CHARS = 100

/**
 * Format an epoch-millisecond instant as `YYYY-MM-DDTHH:MM:SSZ`.
 * @param epochMs - the instant.
 * @returns the ISO text.
 */
function isoOfEpoch(epochMs) {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Generate the search id the web client sends; a base-36 timestamp plus a
 * random suffix is enough for the endpoint and stable in shape.
 * @returns the search id.
 */
function searchId() {
  let number = (BigInt(Date.now()) << 64n) + BigInt(Math.floor(Math.random() * 2_147_483_646))
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let text = ''
  while (number > 0n) {
    text = alphabet[Number(number % 36n)] + text
    number /= 36n
  }
  return text
}

/**
 * Build the provenance block every success value carries.
 * @param fetchedAt - wall-clock instant.
 * @param cached - whether the value came from the cache.
 * @param cacheAgeSeconds - age of the cached value.
 * @returns the snapshot.
 */
function snapshotOf(fetchedAt, cached, cacheAgeSeconds = 0) {
  return { fetched_at: fetchedAt, cached: cached === true, cache_age_seconds: cacheAgeSeconds }
}

/** The process-local Xiaohongshu client. */
export class XhsClient {
  #config

  #readCredential

  #fetch

  #wallNow

  #monotonicNow

  #queue = Promise.resolve()

  #cache = new Map()

  #inflight = new Map()

  #cacheEpoch = 0

  #requestTimes = []

  #dayTimes = []

  #searchTimes = []

  #searchDayTimes = []

  #lastRequestAt = null

  #lastMonotonicAt = null

  #totalRequests = 0

  #pausedUntil = null

  #pauseReason = null

  #lastError = null

  #formats = new Map()

  #tokens = new Map()

  #devices = new Map()

  /**
   * @param options - injection points.
   * @param options.config - resolved plugin options.
   * @param options.readCredential - reads the stored session or undefined.
   * @param options.fetchImpl - transport; defaults to the global `fetch`.
   * @param options.wallNow - wall clock in milliseconds.
   * @param options.monotonicNow - interval clock in milliseconds.
   * @param options.logger - plugin logger.
   */
  constructor({
    config,
    readCredential,
    fetchImpl = (...args) => globalThis.fetch(...args),
    wallNow = Date.now,
    monotonicNow = () => performance.now(),
    logger,
  }) {
    this.#config = config
    this.#readCredential = readCredential
    this.#fetch = fetchImpl
    this.#wallNow = wallNow
    this.#monotonicNow = monotonicNow
    this.logger = logger
  }

  /** Drop the response cache and every remembered token. */
  clearCache() {
    this.#cache.clear()
    this.#inflight.clear()
    this.#tokens.clear()
    this.#cacheEpoch += 1
  }

  /**
   * Remember the `xsec_token` a search result carried for a note.
   * @param note - a mapped note.
   */
  rememberNote(note) {
    if (note?.note_id && typeof note.xsec_token === 'string' && note.xsec_token !== '') {
      this.#tokens.set(note.note_id, { token: note.xsec_token, source: note.xsec_source ?? 'pc_search' })
    }
  }

  /**
   * Read a remembered token.
   * @param noteId - note id.
   * @returns the token record, or undefined.
   */
  tokenFor(noteId) {
    return this.#tokens.get(noteId)
  }

  /**
   * Read the stored session, or throw the closed `not_connected` failure.
   * @returns the credential record.
   */
  async #credential() {
    const credential = await this.#readCredential()
    if (credential === undefined) {
      throw new RequestFailure('not_connected', 'No Xiaohongshu cookie is stored. Connect one first.')
    }
    return credential
  }

  /**
   * The device profile for a credential, generated once per process when the
   * record predates profile storage.
   * @param credential - stored session.
   * @returns the frozen fingerprint.
   */
  #deviceFor(credential) {
    if (credential.device && typeof credential.device === 'object') return credential.device
    const key = credential.values?.a1 ?? 'default'
    let device = this.#devices.get(key)
    if (device === undefined) {
      device = createDeviceProfile(credential.values, this.#config.userAgent, `${PAGE_ORIGIN}/explore`)
      this.#devices.set(key, device)
    }
    return device
  }

  /**
   * Whether a request of this class is allowed right now.
   * @param search - whether the request hits the search endpoint.
   * @param now - wall clock.
   * @returns the budget exhaustion failure, or null.
   */
  #budgetFailure(search, now) {
    this.#requestTimes = this.#requestTimes.filter((at) => at > now - HOUR_MS)
    this.#dayTimes = this.#dayTimes.filter((at) => at > now - DAY_MS)
    this.#searchTimes = this.#searchTimes.filter((at) => at > now - HOUR_MS)
    this.#searchDayTimes = this.#searchDayTimes.filter((at) => at > now - DAY_MS)
    if (this.#requestTimes.length >= this.#config.hourlyBudget) {
      return new RequestFailure('request_budget_exhausted', 'The hourly Xiaohongshu request budget is used up.', {
        retryable: true,
        retryAt: this.#requestTimes[0] + HOUR_MS,
      })
    }
    if (this.#dayTimes.length >= this.#config.dailyBudget) {
      return new RequestFailure('request_budget_exhausted', 'The daily Xiaohongshu request budget is used up.', {
        retryable: true,
        retryAt: this.#dayTimes[0] + DAY_MS,
      })
    }
    if (search && this.#searchTimes.length >= this.#config.searchHourlyBudget) {
      return new RequestFailure('request_budget_exhausted', 'The hourly search budget is used up.', {
        retryable: true,
        retryAt: this.#searchTimes[0] + HOUR_MS,
      })
    }
    if (search && this.#searchDayTimes.length >= this.#config.searchDailyBudget) {
      return new RequestFailure('request_budget_exhausted', 'The daily search budget is used up.', {
        retryable: true,
        retryAt: this.#searchDayTimes[0] + DAY_MS,
      })
    }
    return null
  }

  /**
   * Wait for the process pause and the minimum interval.
   * @param search - whether this is a search request.
   * @param signal - caller cancellation.
   */
  async #waitForTurn(search, signal) {
    if (signal?.aborted) throw new RequestFailure('aborted', 'The request was cancelled.')
    const now = this.#wallNow()
    if (this.#pausedUntil !== null && now < this.#pausedUntil) {
      throw new RequestFailure('temporarily_blocked', `Xiaohongshu is paused: ${this.#pauseReason ?? 'risk control'}.`, {
        retryable: true,
        retryAt: this.#pausedUntil,
      })
    }
    const exhausted = this.#budgetFailure(search, now)
    if (exhausted !== null) throw exhausted

    if (this.#lastMonotonicAt !== null) {
      const interval = this.#config.minIntervalMs * (1 + Math.random() * this.#config.jitterRatio)
      const wait = this.#lastMonotonicAt + interval - this.#monotonicNow()
      if (wait > 0) await sleep(wait)
    }
    if (signal?.aborted) throw new RequestFailure('aborted', 'The request was cancelled.')
  }

  /**
   * Account for one issued request.
   * @param search - whether it was a search request.
   * @param now - wall clock.
   */
  #markRequest(search, now) {
    this.#requestTimes.push(now)
    this.#dayTimes.push(now)
    if (search) {
      this.#searchTimes.push(now)
      this.#searchDayTimes.push(now)
    }
    this.#lastRequestAt = now
    this.#lastMonotonicAt = this.#monotonicNow()
    this.#totalRequests += 1
  }

  /**
   * Put the process on a pause.
   * @param ms - pause length.
   * @param reason - human-readable reason for the page.
   */
  #pause(ms, reason) {
    const until = this.#wallNow() + ms
    if (this.#pausedUntil === null || until > this.#pausedUntil) {
      this.#pausedUntil = until
      this.#pauseReason = reason
    }
  }

  /**
   * Map one API body's `success: false` into a closed failure.
   * @param body - parsed body.
   * @param status - HTTP status.
   * @returns the failure.
   */
  #apiFailure(body, status) {
    const code = Number(body?.code)
    const message = typeof body?.msg === 'string' && body.msg !== '' ? body.msg : 'Xiaohongshu refused the request.'
    if (code === -100 || code === -101) {
      try {
        this.#store?.updateStatus?.({ auth_required: true, last_error_code: 'auth_expired' })
      } catch {
        // The credential state is still the authoritative failure.
      }
      return new RequestFailure('auth_expired', 'Xiaohongshu no longer treats this cookie as signed in.', {
        retryable: false,
      })
    }
    if (code === -104) {
      return new RequestFailure(
        'search_permission_denied',
        'This account has no Xiaohongshu search permission. That is an account-level limit, not a cookie or signature problem.',
        { retryable: false },
      )
    }
    if (code === 300011) {
      this.#pause(this.#config.pauseRiskMs, 'account restricted (300011)')
      return new RequestFailure(
        'account_restricted',
        'Xiaohongshu reports the account as abnormal and asks for another account. The plugin is paused.',
        { retryable: false, retryAt: this.#pausedUntil },
      )
    }
    if (code === 300012) {
      this.#pause(this.#config.pauseRiskMs, 'IP blocked (300012)')
      return new RequestFailure('ip_blocked', 'Xiaohongshu blocked this IP. The plugin is paused.', {
        retryable: false,
        retryAt: this.#pausedUntil,
      })
    }
    if (code === 300015) {
      this.#pause(this.#config.pauseSignatureMs, 'signature rejected (300015)')
      return new RequestFailure('signature_outdated', 'Xiaohongshu rejected the request signature.', {
        retryable: false,
        retryAt: this.#pausedUntil,
      })
    }
    return new RequestFailure('upstream_error', `Xiaohongshu error ${code || status}: ${message}`, {
      retryable: status >= 500,
    })
  }

  /**
   * Map one HTTP status into a closed failure.
   * @param status - HTTP status.
   * @param headers - response headers.
   * @returns the failure.
   */
  #httpFailure(status, headers) {
    if (status === 461 || status === 471) {
      this.#pause(this.#config.pauseRiskMs, `verification required (${status})`)
      return new RequestFailure('risk_control', 'Xiaohongshu asks for verification. The plugin is paused for a day.', {
        retryable: false,
        retryAt: this.#pausedUntil,
      })
    }
    if (status === 406) {
      return new RequestFailure('signature_rejected', 'Xiaohongshu rejected the request signature with 406.', {
        retryable: false,
      })
    }
    if (status === 429) {
      const wait = retryAfterMs(headers, this.#config.pauseRateLimitMs)
      this.#pause(wait, 'rate limited (429)')
      return new RequestFailure('rate_limited', 'Xiaohongshu rate-limited the request.', {
        retryable: true,
        retryAt: this.#pausedUntil,
      })
    }
    if (status === 403) {
      this.#pause(this.#config.pauseRiskMs, 'forbidden (403)')
      return new RequestFailure('forbidden', 'Xiaohongshu refused the request with 403.', {
        retryable: false,
        retryAt: this.#pausedUntil,
      })
    }
    if (status >= 500) {
      this.#pause(this.#config.pauseNetworkMs, `upstream ${status}`)
      return new RequestFailure('upstream_unavailable', `Xiaohongshu answered ${status}.`, {
        retryable: true,
        retryAt: this.#pausedUntil,
      })
    }
    return new RequestFailure('http_status', `Xiaohongshu answered HTTP ${status}.`, { retryable: false })
  }

  /**
   * Issue one signed request and return its parsed body.
   * @param options - request shape.
   * @returns the parsed body and timing.
   */
  async #issue({ method, path, params, payload, search, format, signal, credentialOverride }) {
    await this.#waitForTurn(search === true, signal)
    const credential = credentialOverride ?? await this.#credential()
    const now = this.#wallNow()
    this.#markRequest(search === true, now)
    const device = this.#deviceFor(credential)
    let headers
    try {
      headers = signMainApi(method, path, credential.values, params, payload, undefined, `${PAGE_ORIGIN}/explore`, format, device)
    } catch (error) {
      throw new RequestFailure('signature_unavailable', `The local signer could not build headers: ${String(error)}`)
    }
    // Use the signer's own query builder: its escaping is part of the signed
    // content string, and `URLSearchParams` would encode commas differently.
    const url = method === 'GET' && params ? `${ORIGIN}${buildGetUri(path, params)}` : `${ORIGIN}${path}`
    const timeout = AbortSignal.timeout(this.#config.requestTimeoutMs)
    const combined = signal === undefined || signal === null ? timeout : AbortSignal.any([signal, timeout])
    let response
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          'user-agent': this.#config.userAgent,
          'content-type': 'application/json;charset=UTF-8',
          origin: PAGE_ORIGIN,
          referer: `${PAGE_ORIGIN}/`,
          cookie: credential.cookie,
          ...headers,
        },
        body: method === 'POST' ? JSON.stringify(payload ?? {}) : undefined,
        redirect: 'manual',
        signal: combined,
      })
    } catch (error) {
      this.#pause(this.#config.pauseNetworkMs, 'network error')
      const code = isTimeout(error) ? 'timeout' : isCallerAbort(signal) ? 'aborted' : 'network_error'
      throw new RequestFailure(code, `Could not reach Xiaohongshu: ${String(error)}`, {
        retryable: code !== 'aborted',
        retryAt: this.#pausedUntil,
      })
    }

    let read
    try {
      read = await readBoundedBody(response, this.#config.responseLimitBytes, 'Xiaohongshu')
    } catch (error) {
      if (error instanceof RequestFailure) throw error
      throw new RequestFailure('network_error', `Reading the Xiaohongshu response failed: ${String(error)}`)
    }

    if (read.status !== 200) {
      const failure = this.#httpFailure(read.status, read.headers)
      this.#lastError = { code: failure.code, message: failure.message, retry_at: failure.retryAt ? isoOfEpoch(failure.retryAt) : null }
      this.logRequest({ path, status: read.status, code: failure.code })
      throw failure
    }

    let body
    try {
      body = parseJsonPreservingIds(Buffer.from(read.bytes).toString('utf8'))
    } catch {
      this.#lastError = { code: 'invalid_response', message: 'Xiaohongshu answered something that is not JSON.', retry_at: null }
      throw new RequestFailure('invalid_response', 'Xiaohongshu answered something that is not JSON.')
    }
    const refused = body?.success === false
      || (body?.success !== true && body?.code !== undefined && Number(body.code) !== 0)
    if (refused) {
      const failure = this.#apiFailure(body, read.status)
      this.#lastError = { code: failure.code, message: failure.message, retry_at: failure.retryAt ? isoOfEpoch(failure.retryAt) : null }
      this.logRequest({ path, status: read.status, code: failure.code, detail: typeof body.msg === 'string' ? body.msg : null })
      throw failure
    }
    this.logRequest({ path, status: read.status, code: null })
    return { body, fetchedAt: isoOfEpoch(now) }
  }

  /**
   * Log one request without letting a logging failure break the read.
   * @param entry - log fields.
   */
  logRequest(entry) {
    try {
      this.#store?.logRequest?.(entry)
    } catch {
      // The audit trail is useful, not worth failing a read over.
    }
  }

  /** @type {object|null} */
  #store = null

  /**
   * Attach the corpus store so request outcomes reach its audit log.
   * @param store - the corpus store.
   */
  attachStore(store) {
    this.#store = store
  }

  /**
   * Perform a request with cache, single-flight, and one 406 format fallback.
   * @param options - request shape.
   * @returns the parsed body and snapshot.
   */
  async #request({ method, path, params, payload, search = false, cache = true, signal, credentialOverride }) {
    const cacheKey = cache
      ? `${this.#cacheEpoch}|${method}|${path}|${JSON.stringify(params ?? null)}|${JSON.stringify(payload ?? null)}`
      : null
    if (cacheKey !== null) {
      const hit = this.#cache.get(cacheKey)
      if (hit !== undefined && hit.expiresAt > this.#wallNow()) {
        return { ...hit.value, cached: true, cacheAgeSeconds: Math.max(0, Math.round((this.#wallNow() - hit.storedAt) / 1000)) }
      }
      const inflight = this.#inflight.get(cacheKey)
      if (inflight !== undefined) return inflight
    }

    const run = async () => {
      let format = this.#formats.get(path) ?? 'xys'
      let result
      try {
        result = await this.#issue({ method, path, params, payload, search, format, signal, credentialOverride })
      } catch (error) {
        if (error instanceof RequestFailure && error.code === 'signature_rejected' && format === 'xys') {
          format = 'xyw'
          try {
            result = await this.#issue({ method, path, params, payload, search, format, signal, credentialOverride })
            this.#formats.set(path, 'xyw')
          } catch (second) {
            if (second instanceof RequestFailure && second.code === 'signature_rejected') {
              this.#pause(this.#config.pauseSignatureMs, 'signature rejected in both formats')
              throw new RequestFailure('signature_outdated', 'Xiaohongshu rejected both signature formats; the local signer needs an update.', {
                retryable: false,
                retryAt: this.#pausedUntil,
              })
            }
            throw second
          }
        } else {
          throw error
        }
      }
      if (this.#formats.get(path) === undefined) this.#formats.set(path, format)
      const value = {
        body: result.body,
        fetchedAt: result.fetchedAt,
        cached: false,
        cacheAgeSeconds: 0,
      }
      if (cacheKey !== null) {
        this.#cache.set(cacheKey, { value, storedAt: this.#wallNow(), expiresAt: this.#wallNow() + this.#config.cacheTtlMs })
        while (this.#cache.size > this.#config.cacheMaxEntries) {
          const oldest = this.#cache.keys().next().value
          if (oldest === undefined) break
          this.#cache.delete(oldest)
        }
      }
      return value
    }

    const promise = this.#enqueue(run)
    if (cacheKey !== null) this.#inflight.set(cacheKey, promise)
    try {
      return await promise
    } finally {
      if (cacheKey !== null) this.#inflight.delete(cacheKey)
    }
  }

  /**
   * Serialize one operation behind every earlier operation.
   * @param task - the operation.
   * @returns its result.
   */
  #enqueue(task) {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Verify the stored cookie and read its account.
   * @param options - `signal` for cancellation.
   * @returns the account and snapshot.
   */
  async verify({ fresh = false, signal } = {}) {
    const result = await this.#request({
      method: 'GET',
      path: '/api/sns/web/v2/user/me',
      params: undefined,
      payload: undefined,
      cache: !fresh,
      signal,
    })
    try {
      this.#store?.updateStatus?.({ auth_required: false, last_error_code: null })
    } catch {
      // A page status flag must never fail a successful account read.
    }
    return { account: accountFrom(result.body), snapshot: snapshotOf(result.fetchedAt, result.cached, result.cacheAgeSeconds) }
  }

  /**
   * Prove a candidate cookie before it is written to the credential store.
   * The request shares this client's queue and budgets, so a failed connect
   * cannot bypass the account's pacing.
   * @param credential - candidate session with cookie, values and device.
   * @param options - `signal` for cancellation.
   * @returns the account and snapshot.
   */
  async verifyWith(credential, { signal } = {}) {
    const result = await this.#request({
      method: 'GET',
      path: '/api/sns/web/v2/user/me',
      params: undefined,
      payload: undefined,
      cache: false,
      signal,
      credentialOverride: credential,
    })
    return { account: accountFrom(result.body), snapshot: snapshotOf(result.fetchedAt, result.cached, result.cacheAgeSeconds) }
  }

  /**
   * Search notes by keyword.
   * @param options - query, page, limit, sort, note type, signal.
   * @returns the notes, paging, and snapshot.
   */
  async search({ query, page = 1, limit, sort = 'general', noteType = 0, signal }) {
    const keyword = String(query ?? '').trim()
    if (keyword === '') throw new RequestFailure('invalid_query', 'Search needs a non-empty keyword.')
    if (keyword.length > MAX_KEYWORD_CHARS) throw new RequestFailure('invalid_query', `Search keywords are limited to ${MAX_KEYWORD_CHARS} characters.`)
    if (page < 1 || page > this.#config.searchMaxPages) {
      throw new RequestFailure('invalid_query', `Search pages are limited to 1 through ${this.#config.searchMaxPages}.`)
    }
    const pageSize = Math.min(limit ?? this.#config.searchDefaultLimit, this.#config.searchMaxLimit)
    const payload = {
      keyword,
      page,
      page_size: pageSize,
      search_id: searchId(),
      sort,
      note_type: noteType,
    }
    const result = await this.#request({
      method: 'POST',
      path: '/api/sns/web/v1/search/notes',
      payload,
      search: true,
      cache: false,
      signal,
    })
    const notes = searchNotesFrom(result.body)
    for (const note of notes) this.rememberNote(note)
    const data = result.body?.data ?? {}
    return {
      query: keyword,
      notes,
      page,
      has_more: data?.has_more === true || data?.hasMore === true,
      snapshot: snapshotOf(result.fetchedAt, result.cached, result.cacheAgeSeconds),
    }
  }

  /**
   * Read one note's detail.
   * @param options - note id, optional token/source, signal.
   * @returns the note and snapshot.
   */
  async note({ noteId, xsecToken, xsecSource, signal }) {
    const remembered = this.tokenFor(noteId)
    const token = typeof xsecToken === 'string' && xsecToken !== '' ? xsecToken : remembered?.token
    if (typeof token !== 'string' || token === '') {
      throw new RequestFailure(
        'missing_xsec_token',
        'This note needs the xsec_token that a search result or share URL carries. Search for it first or paste the full URL.',
      )
    }
    const source = typeof xsecSource === 'string' && xsecSource !== '' ? xsecSource : (remembered?.source ?? 'pc_feed')
    const result = await this.#request({
      method: 'POST',
      path: '/api/sns/web/v1/feed',
      payload: {
        source_note_id: noteId,
        image_formats: ['jpg', 'webp', 'avif'],
        extra: { need_body_topic: 1 },
        xsec_source: source,
        xsec_token: token,
      },
      signal,
    })
    const note = noteDetailFrom(result.body)
    if (note === null) {
      throw new RequestFailure('not_found', 'Xiaohongshu returned no note for that id.')
    }
    note.url = noteUrl(note.note_id, token, source)
    this.rememberNote(note)
    return { note, snapshot: snapshotOf(result.fetchedAt, result.cached, result.cacheAgeSeconds) }
  }

  /**
   * Read the first page (or a cursor page) of a note's comments.
   * @param options - note id, cursor, token/source, signal.
   * @returns comments, cursor, and snapshot.
   */
  async comments({ noteId, cursor = '', xsecToken, xsecSource, signal }) {
    const remembered = this.tokenFor(noteId)
    const token = typeof xsecToken === 'string' && xsecToken !== '' ? xsecToken : (remembered?.token ?? '')
    const source = typeof xsecSource === 'string' && xsecSource !== '' ? xsecSource : (remembered?.source ?? 'pc_feed')
    const result = await this.#request({
      method: 'GET',
      path: '/api/sns/web/v2/comment/page',
      params: {
        note_id: noteId,
        cursor,
        image_formats: 'jpg,webp,avif',
        xsec_token: token,
        xsec_source: source,
      },
      signal,
    })
    const page = commentsFrom(result.body)
    return { ...page, snapshot: snapshotOf(result.fetchedAt, result.cached, result.cacheAgeSeconds) }
  }

  /**
   * Read one user's profile.
   * @param options - user id, token/source, signal.
   * @returns the profile and snapshot.
   */
  async user({ userId, xsecToken, xsecSource, signal }) {
    const result = await this.#request({
      method: 'GET',
      path: '/api/sns/web/v1/user/otherinfo',
      params: {
        target_user_id: userId,
        xsec_token: xsecToken ?? '',
        xsec_source: xsecSource ?? '',
      },
      signal,
    })
    const user = userFrom(result.body)
    if (user === null) throw new RequestFailure('not_found', 'Xiaohongshu returned no profile for that user id.')
    return { user, snapshot: snapshotOf(result.fetchedAt, result.cached, result.cacheAgeSeconds) }
  }

  /**
   * Read one user's recent notes.
   * @param options - user id, cursor, token/source, signal.
   * @returns notes, cursor, and snapshot.
   */
  async userNotes({ userId, cursor = '', xsecToken, xsecSource, signal }) {
    let result
    try {
      result = await this.#request({
        method: 'GET',
        path: '/api/sns/web/v2/user_posted',
        params: {
          num: 30,
          cursor,
          user_id: userId,
          image_formats: 'jpg,webp,avif',
          xsec_token: xsecToken ?? '',
          xsec_source: xsecSource ?? '',
        },
        signal,
      })
    } catch (error) {
      if (!(error instanceof RequestFailure) || error.code !== 'upstream_error') throw error
      result = await this.#request({
        method: 'GET',
        path: '/api/sns/web/v1/user_posted',
        params: {
          num: 30,
          cursor,
          user_id: userId,
          image_formats: 'jpg,webp,avif',
          xsec_token: xsecToken ?? '',
          xsec_source: xsecSource ?? '',
        },
        signal,
      })
    }
    const page = userNotesFrom(result.body)
    for (const note of page.notes) this.rememberNote(note)
    return { ...page, snapshot: snapshotOf(result.fetchedAt, result.cached, result.cacheAgeSeconds) }
  }

  /**
   * The pacing state the plugin page and search results report.
   * @returns counters and pause instants.
   */
  stats() {
    const now = this.#wallNow()
    this.#requestTimes = this.#requestTimes.filter((at) => at > now - HOUR_MS)
    this.#dayTimes = this.#dayTimes.filter((at) => at > now - DAY_MS)
    this.#searchTimes = this.#searchTimes.filter((at) => at > now - HOUR_MS)
    this.#searchDayTimes = this.#searchDayTimes.filter((at) => at > now - DAY_MS)
    return {
      requests_last_hour: this.#requestTimes.length,
      hourly_budget: this.#config.hourlyBudget,
      requests_last_day: this.#dayTimes.length,
      daily_budget: this.#config.dailyBudget,
      searches_last_hour: this.#searchTimes.length,
      search_hourly_budget: this.#config.searchHourlyBudget,
      searches_last_day: this.#searchDayTimes.length,
      search_daily_budget: this.#config.searchDailyBudget,
      budget_reset_at: this.#requestTimes.length > 0 ? isoOfEpoch(this.#requestTimes[0] + HOUR_MS) : null,
      paused_until: this.#pausedUntil !== null && this.#pausedUntil > now ? isoOfEpoch(this.#pausedUntil) : null,
      pause_reason: this.#pausedUntil !== null && this.#pausedUntil > now ? this.#pauseReason : null,
      cache_entries: this.#cache.size,
      total_requests: this.#totalRequests,
      last_request_at: this.#lastRequestAt === null ? null : isoOfEpoch(this.#lastRequestAt),
      last_error: this.#lastError,
    }
  }
}

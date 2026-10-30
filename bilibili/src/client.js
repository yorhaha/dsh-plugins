/**
 * Bilibili HTTP client: fixed hosts and paths, no redirects, bounded retries,
 * and WBI request signing.
 *
 * Credentials reach this module only as a constructor argument and leave it
 * only through the outgoing `Cookie` header. No failure carries a credential, a
 * request parameter, or an upstream response body: every error reports a stable
 * code instead.
 *
 * @module dsh-bilibili/src/client
 */

import { createHash } from 'node:crypto'
import { asDict, remoteId } from './mapping.js'

/** Data-source name shared by every record this connector captures. */
export const SOURCE = 'bilibili'

/** Host serving the account, history, favorite, relation, and dynamic endpoints. */
export const API_BASE = 'https://api.bilibili.com'

/** Host serving the login and QR-code endpoints. */
export const PASSPORT_BASE = 'https://passport.bilibili.com'

/** Signed-in account state, including the WBI keys used to sign other requests. */
export const NAV_PATH = '/x/web-interface/nav'

/** One page of the signed-in account's watch history. */
export const HISTORY_PATH = '/x/web-interface/history/cursor'

/** Every favorite folder of the signed-in account. */
export const FAVORITE_FOLDERS_PATH = '/x/v3/fav/folder/created/list-all'

/** One page of one favorite folder's contents. */
export const FAVORITE_CONTENT_PATH = '/x/v3/fav/resource/list'

/** One page of the accounts the signed-in user follows. */
export const FOLLOWINGS_PATH = '/x/relation/followings'

/** The signed-in account's watch-later list. */
export const WATCH_LATER_PATH = '/x/v2/history/toview'

/** One page of the signed-in account's own dynamic timeline. */
export const SELF_DYNAMIC_PATH = '/x/polymer/web-dynamic/v1/feed/space'

/** Starts a QR-code login; the response carries the key to poll with. */
export const QR_GENERATE_PATH = '/x/passport-login/web/qrcode/generate'

/** Polls one QR-code login attempt. */
export const QR_POLL_PATH = '/x/passport-login/web/qrcode/poll'

/** Headers sent with every request. */
export const HEADERS = Object.freeze({
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bilibili.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Safari/537.36',
})

/** Stored credential field to the cookie name it is sent as. */
export const COOKIE_NAMES = Object.freeze({
  sessdata: 'SESSDATA',
  dedeuserid: 'DedeUserID',
  buvid3: 'buvid3',
  buvid4: 'buvid4',
})

/**
 * The paths `get` may request; any other path is a caller bug.
 * @type {ReadonlySet<string>}
 */
export const API_PATHS = Object.freeze(
  new Set([
    NAV_PATH,
    HISTORY_PATH,
    FAVORITE_FOLDERS_PATH,
    FAVORITE_CONTENT_PATH,
    FOLLOWINGS_PATH,
    WATCH_LATER_PATH,
    SELF_DYNAMIC_PATH,
  ]),
)

/** Positions of the WBI mixin key inside the concatenated key-image stems. */
const WBI_MIXIN_ORDER = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
])

/** Characters stripped from every signed parameter value. */
const WBI_FILTER_RE = /[!'()*]/g

/** Transport retry delays, waited before the second and third attempt. */
const RETRY_DELAYS_MS = Object.freeze([5000, 30000])

/** Minimum spacing between two page requests, enforced by {@link BilibiliClient#pause}. */
const PAGE_INTERVAL_MS = 2000

/** Per-attempt request timeout. */
const REQUEST_TIMEOUT_MS = 30000

/** A URL reduced to its path: scheme, authority, query, and fragment removed. */
const URL_PATH_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?(?:\/\/[^/?#]*)?([^?#]*)/

/** Trailing timezone designator of an HTTP date, such as `GMT` or `+0800`. */
const TIMEZONE_SUFFIX_RE = /(?:[A-Za-z]{1,5}|[+-]\d{4})$/

/**
 * Current instant.
 * @returns the instant as an ISO-8601 UTC string with milliseconds.
 */
export function utcNowIso() {
  return new Date().toISOString()
}

/**
 * Percent-encode one query component: the unreserved characters stay literal, a
 * space becomes `+`, and every other UTF-8 byte becomes uppercase percent hex.
 * @param text - Component to encode.
 * @returns the encoded component.
 */
function encodeComponent(text) {
  let out = ''
  for (const byte of Buffer.from(text, 'utf8')) {
    if (byte === 0x20) out += '+'
    else if (isUnreservedByte(byte)) out += String.fromCharCode(byte)
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/**
 * Report whether one UTF-8 byte survives percent-encoding.
 * @param byte - Byte value.
 * @returns whether the byte is an ASCII letter, digit, `_`, `.`, `-`, or `~`.
 */
function isUnreservedByte(byte) {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x5f ||
    byte === 0x2e ||
    byte === 0x2d ||
    byte === 0x7e
  )
}

/**
 * Render one parameter value as text; `null` and `undefined` render empty.
 * @param value - Parameter value.
 * @returns the text sent in the query string.
 */
function paramText(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * Build a query string in parameter order.
 * @param params - Parameter object.
 * @returns the encoded query string, without a leading `?`.
 */
function encodeQuery(params) {
  const parts = []
  for (const [key, value] of Object.entries(params)) {
    parts.push(`${encodeComponent(key)}=${encodeComponent(paramText(value))}`)
  }
  return parts.join('&')
}

/**
 * Sign request parameters with the account's WBI mixin key.
 *
 * Values have `!`, `'`, `(`, `)`, and `*` removed before signing; `w_rid` and
 * `wts` present in `params` are replaced rather than signed. The signature is
 * the MD5 of the key-sorted, percent-encoded query string followed by the mixin
 * key.
 *
 * @param params - Parameter object to sign; values render as text.
 * @param mixinKey - Mixin key derived from the account's nav payload.
 * @param timestamp - Unix seconds recorded as `wts`.
 * @returns the signed parameters, including `wts` and `w_rid`.
 */
export function wbiSign(params, mixinKey, timestamp) {
  const values = new Map()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined || key === 'w_rid' || key === 'wts') continue
    values.set(key, String(value).replace(WBI_FILTER_RE, ''))
  }
  values.set('wts', String(timestamp))
  const query = [...values.keys()]
    .sort()
    .map((key) => `${encodeComponent(key)}=${encodeComponent(values.get(key))}`)
    .join('&')
  const signature = createHash('md5').update(`${query}${mixinKey}`, 'utf8').digest('hex')
  return Object.fromEntries([...values, ['w_rid', signature]])
}

/**
 * Base failure of this connector: a stable code and nothing else.
 *
 * The message is the code, so no log line or wrapped cause can carry a
 * credential, a request parameter, or an upstream response body.
 */
export class BilibiliError extends Error {
  /**
   * Stable failure code.
   * @type {string}
   */
  code = 'bilibili_error'

  /**
   * @param code - Replacement code; a subclass passes its own and ignores this.
   */
  constructor(code = null) {
    super(code ?? 'bilibili_error')
    if (code !== null && code !== undefined && code !== '') this.code = code
    this.name = new.target.name
  }
}

/** The stored credential carries no usable session cookie. */
export class CredentialUnavailableError extends BilibiliError {
  constructor() {
    super('credential_unavailable')
  }
}

/** Upstream refused the session and the caller must sign in again. */
export class AuthRequiredError extends BilibiliError {
  constructor() {
    super('auth_required')
  }
}

/** Upstream answered with a risk-control rejection. */
export class RiskControlError extends BilibiliError {
  constructor() {
    super('risk_control')
  }
}

/** Upstream rate-limited the caller for a stated period. */
export class RateLimitedError extends BilibiliError {
  /**
   * Whole seconds to wait before retrying; never negative.
   * @type {number}
   */
  retryAfter

  /**
   * @param retryAfter - Seconds advertised by the response.
   */
  constructor(retryAfter) {
    super('rate_limited')
    this.retryAfter = Math.max(0, Number.isFinite(retryAfter) ? Math.trunc(retryAfter) : 0)
  }
}

/** The WBI signature was rejected and re-signing with a fresh key did not help. */
export class WbiSignatureError extends BilibiliError {
  constructor() {
    super('wbi_signature_failed')
  }
}

/** Upstream answered with a non-zero envelope code. */
export class BilibiliApiError extends BilibiliError {
  /**
   * The upstream code, or `unknown` when it is not a plain integer literal.
   * @type {string}
   */
  apiCode

  /**
   * @param apiCode - Envelope `code` value.
   */
  constructor(apiCode) {
    const text = String(apiCode ?? '').trim()
    const stable = /^-?\d{1,10}$/.test(text) ? text : 'unknown'
    super(`api_${stable}`)
    this.apiCode = stable
  }
}

/**
 * Delay one retry.
 * @param ms - Milliseconds to wait.
 * @returns resolution after the timer fires.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Retry delay advertised by a 429 response.
 *
 * `Retry-After` is read as delta-seconds first, then as an HTTP date measured
 * against the wall clock; an absent or unreadable value means one hour.
 *
 * @param headers - Response headers.
 * @returns whole seconds to wait, never negative.
 */
function retryAfterSeconds(headers) {
  const value = headers.get('Retry-After')
  if (!value) return 3600
  const text = value.trim()
  if (/^[+-]?\d+$/.test(text)) {
    const seconds = Number(text)
    if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds))
  }
  const stamp = Date.parse(TIMEZONE_SUFFIX_RE.test(text) ? text : `${text} GMT`)
  if (Number.isNaN(stamp)) return 3600
  return Math.max(0, Math.trunc((stamp - Date.now()) / 1000))
}

/**
 * Path component of a URL.
 * @param url - Absolute, scheme-relative, or relative URL.
 * @returns the path, without query or fragment.
 */
function urlPath(url) {
  const match = URL_PATH_RE.exec(url)
  return match === null ? '' : match[1]
}

/**
 * File-name stem of a URL: its last path segment without the final extension
 * and without a trailing slash.
 * @param url - Key-image URL from a nav payload.
 * @returns the stem, empty when the path carries no named last segment.
 */
function pathStem(url) {
  let path = urlPath(url)
  while (path.endsWith('/')) path = path.slice(0, -1)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name
}

/**
 * Derive the WBI mixin key from a nav payload.
 * @param nav - Parsed nav payload.
 * @returns the 32-character mixin key.
 * @throws {BilibiliError} with code `wbi_key_unavailable` when the payload carries no usable key images.
 */
function mixinKeyFromNav(nav) {
  const wbi = asDict(nav.wbi_img)
  const pieces = []
  for (const field of ['img_url', 'sub_url']) {
    const url = wbi[field]
    if (typeof url !== 'string' || url === '') throw new BilibiliError('wbi_key_unavailable')
    const stem = pathStem(url)
    if (stem === '') throw new BilibiliError('wbi_key_unavailable')
    pieces.push(stem)
  }
  const source = pieces.join('')
  if (source.length < WBI_MIXIN_ORDER.length) throw new BilibiliError('wbi_key_unavailable')
  return WBI_MIXIN_ORDER.map((index) => source[index]).join('').slice(0, 32)
}

/**
 * Read-only API client for one stored session.
 *
 * Every request goes to {@link API_BASE} on a path from {@link API_PATHS},
 * follows no redirect, retries a transport failure or a 5xx twice with fixed
 * delays, and reports every failure as a stable code. An instance holds the
 * cookie header derived from its credential and the cached WBI mixin key; it
 * writes nothing.
 */
export class BilibiliClient {
  #cookieHeader
  #fetchImpl
  #sleep
  #clock
  #mixinKey = null

  /**
   * @param credential - Stored credential fields; only non-empty strings are sent as cookies.
   * @param credential.sessdata - `SESSDATA` cookie value; required.
   * @param credential.dedeuserid - `DedeUserID` cookie value.
   * @param credential.buvid3 - `buvid3` cookie value.
   * @param credential.buvid4 - `buvid4` cookie value.
   * @param options - Test seams; production callers pass none.
   * @param options.sleep - Delay in milliseconds, awaited between attempts and by {@link BilibiliClient#pause}.
   * @param options.clock - Clock in seconds, read for the `wts` signature field.
   * @param options.fetchImpl - Request implementation, called as `fetch(url, init)`.
   * @throws {CredentialUnavailableError} when `sessdata` is absent, not a string, or empty.
   */
  constructor(credential, options = {}) {
    const sessdata = credential?.sessdata
    if (typeof sessdata !== 'string' || sessdata === '') {
      throw new CredentialUnavailableError()
    }
    const cookies = []
    for (const [storedName, cookieName] of Object.entries(COOKIE_NAMES)) {
      const value = credential[storedName]
      if (typeof value === 'string' && value !== '') cookies.push(`${cookieName}=${value}`)
    }
    this.#cookieHeader = cookies.join('; ')
    this.#sleep = options.sleep ?? defaultSleep
    this.#clock = options.clock ?? (() => Date.now() / 1000)
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  /**
   * Release the client's resources.
   *
   * `fetch` holds no connection pool this instance owns, so there is nothing to
   * release; the method exists so every connector's call sites stay symmetric.
   * @returns nothing.
   */
  close() {
    return undefined
  }

  /**
   * Wait one page interval before the next page request.
   * @returns resolution after the interval.
   */
  async pause() {
    await this.#sleep(PAGE_INTERVAL_MS)
  }

  /**
   * Perform one whitelisted request and unwrap its envelope.
   *
   * A transport failure or a 5xx is retried twice, then reported as
   * `network_error` or `upstream_5xx`. `412` is a risk-control rejection, `429`
   * carries the advertised retry delay, any other `>= 400` becomes
   * `http_<status>`, an unparseable body becomes `invalid_json`, and an
   * envelope without a usable `code` becomes `invalid_envelope`.
   *
   * @param path - Path from {@link API_PATHS}.
   * @param params - Query parameters.
   * @returns the envelope's `data` member.
   * @throws {Error} `bilibili_path_not_allowed` when `path` is not whitelisted.
   */
  async #requestEnvelope(path, params = null) {
    if (!API_PATHS.has(path)) throw new Error('bilibili_path_not_allowed')
    const query = encodeQuery(params ?? {})
    const url = query === '' ? `${API_BASE}${path}` : `${API_BASE}${path}?${query}`
    const headers = { ...HEADERS }
    if (this.#cookieHeader !== '') headers.Cookie = this.#cookieHeader
    let response = null
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        response = await this.#fetchImpl(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        response = null
        if (attempt < RETRY_DELAYS_MS.length) {
          await this.#sleep(RETRY_DELAYS_MS[attempt])
          continue
        }
        throw new BilibiliError('network_error')
      }
      if (response.status < 500 || response.status >= 600) break
      if (attempt < RETRY_DELAYS_MS.length) {
        await this.#sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw new BilibiliError('upstream_5xx')
    }
    if (response === null) throw new BilibiliError('network_error')
    if (response.status === 412) throw new RiskControlError()
    if (response.status === 429) throw new RateLimitedError(retryAfterSeconds(response.headers))
    if (response.status >= 400) throw new BilibiliError(`http_${response.status}`)
    let envelope = null
    try {
      envelope = await response.json()
    } catch {
      throw new BilibiliError('invalid_json')
    }
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      throw new BilibiliError('invalid_envelope')
    }
    const code = envelope.code
    if (code === null || code === undefined) throw new BilibiliError('invalid_envelope')
    if (code === -412 || code === -352) throw new RiskControlError()
    if (code === -101) throw new AuthRequiredError()
    if (code !== 0) throw new BilibiliApiError(code)
    return { data: envelope.data ?? null }
  }

  /**
   * Refresh the cached WBI mixin key from the nav endpoint.
   * @returns resolution after the key is cached.
   * @throws {BilibiliError} with code `wbi_key_unavailable` when the payload carries no usable key images.
   */
  async #refreshWbiKey() {
    const nav = await this.#requestEnvelope(NAV_PATH)
    this.#mixinKey = mixinKeyFromNav(asDict(nav.data))
  }

  /**
   * Request one path and unwrap its envelope.
   *
   * With `signed`, the parameters are WBI-signed and the cached mixin key is
   * refreshed once when upstream answers `-403`; a second rejection is a
   * signature failure. Without it, no account key is used.
   *
   * @param path - Path from {@link API_PATHS}.
   * @param params - Query parameters.
   * @param options - Request options.
   * @param options.signed - Whether to sign the parameters with the account's WBI key.
   * @returns the envelope's `data` member.
   * @throws {Error} `bilibili_path_not_allowed` when `path` is not whitelisted.
   */
  async get(path, params = null, options = {}) {
    if (options.signed !== true) return this.#requestEnvelope(path, params)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.#mixinKey === null) await this.#refreshWbiKey()
      const signed = wbiSign(params ?? {}, this.#mixinKey, Math.trunc(this.#clock()))
      try {
        return await this.#requestEnvelope(path, signed)
      } catch (error) {
        if (!(error instanceof BilibiliApiError)) throw error
        if (error.apiCode !== '-403' || attempt === 1) {
          if (error.apiCode === '-403') throw new WbiSignatureError()
          throw error
        }
        this.#mixinKey = null
      }
    }
    throw new WbiSignatureError()
  }

  /**
   * Read the signed-in account from the nav endpoint and cache its WBI key.
   * @returns the account `mid`.
   * @throws {AuthRequiredError} when the session is not signed in or the payload carries no account id.
   */
  async validateSession() {
    const nav = asDict((await this.get(NAV_PATH)).data)
    if (nav.isLogin !== true) throw new AuthRequiredError()
    const mid = remoteId(nav.mid)
    if (!mid) throw new AuthRequiredError()
    try {
      this.#mixinKey = mixinKeyFromNav(nav)
    } catch (error) {
      if (!(error instanceof BilibiliError)) throw error
      this.#mixinKey = null
    }
    return mid
  }
}

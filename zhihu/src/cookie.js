/**
 * The cookie bag this plugin stores and sends.
 *
 * Zhihu's web session is a cookie string, not a token: the plugin keeps the
 * whole string verbatim (minus duplicates and stray whitespace) so the user can
 * paste exactly what the browser shows in a request header. Two names are
 * required — `z_c0` proves the signed-in session, and `d_c0` is the device id
 * every API request is attributed to — and a missing one is refused before any
 * request is issued.
 *
 * @module dsh-zhihu/src/cookie
 */

/** Longest cookie string accepted, in UTF-16 code units. */
const MAX_COOKIE_CHARS = 16_384

/** A cookie name, per RFC 6265's token grammar narrowed to what Zhihu uses. */
const COOKIE_NAME = /^[A-Za-z0-9_.\-]+$/

/** The names a signed-in session cannot work without. */
const REQUIRED_NAMES = ['z_c0', 'd_c0']

/** Local failure for a cookie that cannot be used; carries no network semantics. */
export class CookieError extends Error {
  /**
   * @param message - what the user has to fix.
   */
  constructor(message) {
    super(message)
    this.name = 'ZhihuCookieError'
    this.code = 'cookie_invalid'
  }
}

/**
 * Parse a cookie string into name/value pairs.
 *
 * A pasted `Cookie:` header prefix is tolerated because that is how browsers
 * show it in a request inspector. Repeats keep the last value, which is what a
 * browser sends when a domain and a path define the same name.
 *
 * @param text - the pasted cookie string.
 * @returns the pairs, in first-seen order.
 * @throws {CookieError} when the string is empty, malformed, or carries no
 *   session or device cookie.
 */
export function parseCookieString(text) {
  if (typeof text !== 'string') throw new CookieError('the Zhihu cookie must be a string')
  const trimmed = text.trim().replace(/^cookie:\s*/i, '')
  if (trimmed === '') throw new CookieError('the Zhihu cookie is empty')
  if (trimmed.length > MAX_COOKIE_CHARS) {
    throw new CookieError(`the Zhihu cookie is longer than ${MAX_COOKIE_CHARS} characters`)
  }
  if (/[\r\n\0]/.test(trimmed)) {
    throw new CookieError('the Zhihu cookie contains a newline or NUL, which no Cookie header may carry')
  }

  const pairs = new Map()
  for (const rawPart of trimmed.split(';')) {
    const part = rawPart.trim()
    if (part === '') continue
    const equals = part.indexOf('=')
    if (equals <= 0) {
      throw new CookieError('a cookie segment is not a name=value pair')
    }
    const name = part.slice(0, equals).trim()
    const value = part.slice(equals + 1).trim()
    if (!COOKIE_NAME.test(name)) {
      throw new CookieError(`the cookie name "${name.slice(0, 24)}" is not a valid cookie name`)
    }
    if (value === '') throw new CookieError(`the cookie "${name}" has an empty value`)
    pairs.set(name, value)
  }

  for (const name of REQUIRED_NAMES) {
    if (!pairs.has(name)) {
      throw new CookieError(
        `the Zhihu cookie has no "${name}". Copy the whole Cookie request header from a signed-in zhihu.com page.`,
      )
    }
  }
  return pairs
}

/**
 * Normalize a cookie string to the one form this plugin stores and sends.
 *
 * @param text - the pasted cookie string.
 * @returns the pairs joined with `; `, with the `Cookie:` prefix and duplicates removed.
 * @throws {CookieError} under the same conditions as {@link parseCookieString}.
 */
export function normalizeCookie(text) {
  return [...parseCookieString(text)]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/**
 * Whether a stored string still names both required cookies.
 *
 * @param cookie - a normalized cookie string.
 * @returns true when the string can authenticate a request.
 */
export function isUsableCookie(cookie) {
  try {
    parseCookieString(cookie)
    return true
  } catch {
    return false
  }
}

/**
 * Describe a cookie without revealing it, for the plugin page.
 *
 * @param cookie - a normalized cookie string, or null when none is stored.
 * @returns the count of cookies and whether the session pair is present.
 */
export function describeCookie(cookie) {
  if (typeof cookie !== 'string' || cookie === '') return { present: false, names: 0, session: false }
  try {
    const pairs = parseCookieString(cookie)
    return { present: true, names: pairs.size, session: true }
  } catch {
    return { present: true, names: 0, session: false }
  }
}

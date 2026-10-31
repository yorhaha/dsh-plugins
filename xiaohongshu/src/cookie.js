/**
 * Parsing and shape checks for the Xiaohongshu web cookie.
 *
 * The credential is the exact `Cookie` request header copied from a signed-in
 * browser. Only `a1` and `web_session` are mandatory: `a1` is the device key
 * the request signature is derived from, and `web_session` is the server-side
 * session that cannot be forged. The other fields are kept because the web
 * client sends them and dropping them makes the request look less like the
 * browser that produced the cookie.
 *
 * @module dsh-xiaohongshu/src/cookie
 */

/** Maximum accepted length of a Cookie header; real ones are under 4 KiB. */
export const MAX_COOKIE_CHARS = 16_384

/** Cookie names the web client needs for a session. */
export const REQUIRED_COOKIE_NAMES = Object.freeze(['a1', 'web_session'])

/** A malformed or incomplete cookie. */
export class CookieError extends Error {
  /**
   * @param code - closed failure code rendered to the caller.
   * @param message - model-facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'CookieError'
    this.code = code
  }
}

/**
 * Parse a `Cookie` header into an ordered name/value map.
 *
 * The parser keeps the first occurrence of a name, ignores empty segments and
 * segments without `=`, and refuses control characters outright. It does not
 * decode percent escapes: the header is transmitted exactly as written.
 *
 * @param raw - the Cookie header text.
 * @returns the normalized header and its values.
 * @throws {CookieError} `cookie_invalid` when the text is missing, oversized, or malformed.
 */
export function parseCookie(raw) {
  if (typeof raw !== 'string') throw new CookieError('cookie_invalid', 'The cookie must be a string.')
  const text = raw.trim()
  if (text === '') throw new CookieError('cookie_invalid', 'The cookie is empty.')
  if (text.length > MAX_COOKIE_CHARS) {
    throw new CookieError('cookie_invalid', `The cookie is longer than ${MAX_COOKIE_CHARS} characters.`)
  }
  if (/[\r\n\u0000]/.test(text)) {
    throw new CookieError('cookie_invalid', 'The cookie contains a line break or control character.')
  }

  const values = Object.create(null)
  const pairs = []
  for (const segment of text.split(';')) {
    const part = segment.trim()
    if (part === '') continue
    const equals = part.indexOf('=')
    if (equals <= 0) continue
    const name = part.slice(0, equals).trim()
    const value = part.slice(equals + 1).trim()
    if (name === '' || value === '') continue
    if (values[name] === undefined) {
      values[name] = value
      pairs.push(`${name}=${value}`)
    }
  }

  const missing = REQUIRED_COOKIE_NAMES.filter((name) => values[name] === undefined)
  if (missing.length > 0) {
    throw new CookieError(
      'cookie_invalid',
      `The cookie is missing ${missing.join(' and ')}. Copy the whole Cookie request header from a signed-in xiaohongshu.com page.`,
    )
  }

  return { header: pairs.join('; '), values: { ...values } }
}

/**
 * Describe a stored cookie without exposing it.
 *
 * @param raw - the stored Cookie header, when one exists.
 * @returns names present, character length, and whether the required fields exist.
 */
export function describeCookie(raw) {
  if (typeof raw !== 'string' || raw === '') {
    return { present: false, names: [], chars: 0, usable: false }
  }
  let parsed
  try {
    parsed = parseCookie(raw)
  } catch (error) {
    if (error instanceof CookieError) {
      return { present: true, names: [], chars: raw.length, usable: false }
    }
    throw error
  }
  return {
    present: true,
    names: Object.keys(parsed.values),
    chars: raw.length,
    usable: true,
  }
}

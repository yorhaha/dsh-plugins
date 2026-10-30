/**
 * The JSON route core shared by every bundle that serves a page.
 *
 * A profile-installed bundle cannot declare a Remote namespace, so bilibili,
 * deepxiv, file-memory, notify, outlook, stock, user-todo, and
 * wechat each register a fetch route under the harness's authenticated `/api`
 * channel and answer it with JSON. Every one of them had its own `sendJson`,
 * `errorCode`, and body reader — identical down to the cache header, and
 * identical where it mattered: a thrown value becomes a closed code, a body
 * over its bound is refused, and no response is ever cached.
 *
 * Not every bundle needs all three: `file-memory` answers with `sendJson` alone,
 * because its own reader must also honour a declared `content-length`.
 *
 * What stays in each bundle is what actually differs: the path, the action
 * table, which codes are the caller's fault rather than a failed action, and
 * the body bound each page needs.
 *
 * The bundles reach this file by relative path; see `shared/schedule.js` for
 * why that is acceptable here.
 *
 * @module dsh-plugins/shared/route
 */

/** Content type every JSON answer is served with. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/**
 * Build one bundle's request-defect factory.
 *
 * Each bundle keeps its own projection of a defect, because a bundle that
 * declares a domain still recognises its own error type by name. The factory
 * supplies the two properties every one of them shares: the closest standard
 * class and a statement that it is the caller's fault. It returns a builder
 * rather than a class because `readJsonBody` is handed the builder and called
 * like a function; a class would make that call a `TypeError` instead of a
 * refusal.
 *
 * @param name - the name to report, such as `TodoBodyError`.
 * @returns a builder called as `(code, message)` that returns the error.
 */
export function defineCodeError(name) {
  return (code, message) => Object.assign(new Error(message), { name, code })
}

/**
 * One JSON response.
 *
 * `no-store` is not decoration: every one of these routes answers with state
 * the user just changed, or with a stored secret shown in the clear, and a
 * cached copy would outlive the change that invalidated it.
 *
 * @param status - HTTP status.
 * @param payload - the body value.
 * @returns the response.
 */
export function sendJson(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store' },
  })
}

/**
 * Stable error code for any thrown value.
 *
 * A value that carries its own closed code is reported as it is; anything else
 * is named by its constructor so a bug stays visible as `internal_TypeError`
 * instead of being flattened into one opaque failure.
 *
 * @param error - the thrown value.
 * @returns the code.
 */
export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code !== '') return error.code
  return `internal_${error?.constructor?.name ?? 'Error'}`
}

/**
 * Read and validate a JSON object body.
 *
 * The whole body is decoded first and the bound is then checked on the decoded
 * text, rather than on a declared `content-length`, because a request that
 * declares nothing can still carry a large body. Nothing is parsed until the
 * bound has passed. An empty body is `{}`: a read arrives without one, and a
 * POST that names its action in the query string may too.
 *
 * The length compared is a string's `.length`, which counts UTF-16 code units,
 * not bytes: for non-ASCII text it undercounts the wire size by up to half. That
 * is deliberate and safe, because every bound here is generous for its page; a
 * bundle whose limit must be exact in bytes should check `content-length` or the
 * encoded body itself instead of relying on this one.
 *
 * @param request - the incoming request.
 * @param limitBytes - the largest decoded body accepted, in UTF-16 code units.
 * @param createError - builds the bundle's own error from `(code, message)`.
 * @returns the parsed body.
 * @throws the error `createError` built, with code `body_too_large`,
 *   `invalid_json`, or `invalid_body`.
 */
export async function readJsonBody(request, limitBytes, createError) {
  const text = await request.text()
  if (text.length > limitBytes) {
    throw createError('body_too_large', 'the request body is too large')
  }
  if (text === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw createError('invalid_json', 'the request body is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw createError('invalid_body', 'the request body must be a JSON object')
  }
  return parsed
}

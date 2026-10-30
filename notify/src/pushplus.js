/**
 * The PushPlus send call — the port of yorha's `core/yorha/notify.py`.
 *
 * One function posts one message to one token. The body is minimized by the
 * caller; this module owns the property that the token never leaves the request
 * body — not into an error message, not into a log line, not into a result.
 *
 * PushPlus contract: `POST {baseUrl}/send` with JSON
 * `{token, title, content, template}`, answered by
 * `{"code": 200, "msg": ..., "data": ...}`; any other `code` is a rejection.
 *
 * @module dsh-notify/src/pushplus
 */

/** Longest upstream message kept in a failure, so a hostile body cannot flood a log. */
const MESSAGE_MAX_CHARS = 200

/** A refused or failed send; `message` never contains the token. */
export class NotifyError extends Error {
  /**
   * @param code - Closed failure code.
   * @param message - Human-readable reason, with the token already removed.
   */
  constructor(code, message) {
    super(message)
    this.name = 'NotifyError'
    this.code = code
  }
}

/**
 * Remove every occurrence of a secret from a text bound for a human.
 * @param text - Candidate text.
 * @param token - The secret to remove.
 * @returns the text with each occurrence replaced by `<token>`.
 */
export function redact(text, token) {
  if (typeof text !== 'string' || text === '') return ''
  // Replace before bounding: a token longer than the bound would otherwise be
  // cut out of the text before the search could find it, leaking its prefix.
  let sanitized = text
  if (typeof token === 'string' && token !== '') {
    // A JSON response may echo the token with its characters escaped.
    const escaped = JSON.stringify(token).slice(1, -1)
    for (const form of new Set([token, escaped])) {
      if (form !== '') sanitized = sanitized.split(form).join('<token>')
    }
  }
  return sanitized.length > MESSAGE_MAX_CHARS ? `${sanitized.slice(0, MESSAGE_MAX_CHARS)}…` : sanitized
}

/** Largest response body this client reads before refusing it. */
const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * Read a response body without buffering an unbounded one.
 *
 * @param response - The response whose body is read.
 * @param limit - Largest accepted byte count.
 * @returns the decoded text.
 * @throws {NotifyError} `response_too_large` above the limit.
 */
async function readBoundedText(response, limit) {
  const reader = response.body === null ? null : response.body.getReader()
  if (reader === null) return ''
  const decoder = new TextDecoder()
  const chunks = []
  let total = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    total += step.value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new NotifyError('response_too_large', `PushPlus answered more than ${limit} bytes`)
    }
    chunks.push(step.value)
  }
  let text = ''
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

/**
 * Send one message to one token.
 *
 * @param options - Send inputs.
 * @param options.baseUrl - Endpoint the send path is built from, without a trailing slash.
 * @param options.template - PushPlus template name.
 * @param options.token - The target's PushPlus token.
 * @param options.title - Message title.
 * @param options.content - Message body.
 * @param options.timeoutMs - Ceiling on one request.
 * @param options.signal - Cancellation of the enclosing tool call, if any.
 * @param options.fetchImpl - Transport, replaceable by tests.
 * @returns the PushPlus `data` value, which names the sent message upstream.
 * @throws {NotifyError} when the message was not accepted.
 */
export async function send({
  baseUrl,
  template,
  token,
  title,
  content,
  timeoutMs,
  signal,
  fetchImpl = fetch,
}) {
  // The token travels in the body, never in the URL, so a transport failure
  // that quotes the URL has nothing to leak; only the error's own name is kept
  // anyway.
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  let response
  try {
    response = await fetchImpl(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token, title, content, template }),
      // The token travels in the body, and a 307/308 redirect would resend it
      // to whatever origin `Location` names. Refuse the redirect instead.
      redirect: 'error',
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted === true) throw new NotifyError('aborted', 'The call was cancelled before PushPlus answered')
    const name = error instanceof Error ? error.name : 'Error'
    throw new NotifyError('request_failed', `PushPlus request failed (${name})`)
  }

  if (response.status !== 200) {
    throw new NotifyError('http_status', `PushPlus answered HTTP ${response.status}`)
  }

  let body
  try {
    body = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES))
  } catch (error) {
    if (error instanceof NotifyError) throw error
    // The body is read only to report a rejection; a send that already left is
    // not repeated on a parse failure.
    throw new NotifyError('invalid_response', 'PushPlus answered a body that is not JSON')
  }
  if (typeof body !== 'object' || body === null) {
    throw new NotifyError('invalid_response', 'PushPlus answered a JSON body that is not an object')
  }
  if (body.code !== 200) {
    throw new NotifyError(
      'rejected',
      `PushPlus rejected the message (code ${String(body.code)}): ${redact(body.msg, token)}`,
    )
  }
  const data = body.data
  return data === undefined || data === null ? '' : String(data)
}

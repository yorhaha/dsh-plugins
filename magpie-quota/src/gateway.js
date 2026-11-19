/**
 * The one HTTP call this plugin makes: magpie's own quota read.
 *
 * magpie serves a loopback HTTP gateway (its tray, window, and OpenAI-compatible
 * proxy share one port) and exposes the quota listing on it. The panel reaches
 * that endpoint **through the Host**, not from the browser: the page is served
 * from the Harness origin, so a direct cross-origin `fetch` to magpie's port
 * would be decided by magpie's CORS policy rather than by the Harness, and the
 * gateway address belongs on the Host side either way.
 *
 * Nothing here trusts magpie's response. A body over the configured bound is
 * refused before it is parsed, an unreadable one is reported as such, and a
 * failure carries a closed code the panel maps to text rather than a message
 * that would leak the endpoint or the response.
 *
 * @module dsh-magpie-quota/gateway
 */

/** magpie's quota listing, relative to the configured gateway origin. */
const QUOTAS_PATH = '/v1/magpie/quotas'

/** A failed read, named by a code the client can map to text. */
export class GatewayError extends Error {
  /**
   * @param code - one of `unreachable`, `timeout`, `bad_status`, `too_large`,
   *   or `bad_json`.
   * @param detail - what happened, for the Harness log rather than the page.
   */
  constructor(code, detail) {
    super(`magpie-quota: ${code}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'GatewayError'
    this.code = code
  }
}

/**
 * Classify a thrown transport failure.
 *
 * An abort is the timeout this module armed; anything else is magpie not being
 * there, which is the ordinary state when the tray is not running.
 *
 * @param error - the thrown value.
 * @returns the error to rethrow.
 */
function transportError(error) {
  if (error?.name === 'AbortError') return new GatewayError('timeout')
  return new GatewayError('unreachable', error?.cause?.code ?? error?.code ?? error?.name)
}

/**
 * Read the quota listing.
 *
 * The timeout covers the body read as well as the response headers, because a
 * gateway that answers and then stalls would otherwise hold the request open
 * for as long as it liked.
 *
 * @param config - the resolved plugin configuration.
 * @returns the decoded body.
 * @throws {GatewayError} when magpie cannot be read.
 */
export async function fetchQuotas(config) {
  const endpoint = new URL(QUOTAS_PATH, config.gateway)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    let response
    try {
      response = await fetch(endpoint, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
    } catch (error) {
      throw transportError(error)
    }
    if (!response.ok) throw new GatewayError('bad_status', String(response.status))
    let text
    try {
      text = await response.text()
    } catch (error) {
      throw transportError(error)
    }
    if (text.length > config.maxBytes) throw new GatewayError('too_large', String(text.length))
    try {
      return JSON.parse(text)
    } catch {
      throw new GatewayError('bad_json')
    }
  } finally {
    clearTimeout(timer)
  }
}

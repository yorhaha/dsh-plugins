/**
 * Every tunable of the Zhihu bundle, with its default, and the load-time
 * validation of a row's `config`.
 *
 * The plugin declares no schema library, so this module is the one place a
 * default lives and the one place a mistyped row fails loudly. Nothing here
 * talks to the network; the values land in `client.js`, which reads them.
 *
 * The defaults are deliberately slow. Zhihu answers a burst of ordinary
 * requests with a 403 risk-control page, and a paused cookie costs far more
 * than a few seconds of waiting, so one request every three seconds, no more
 * than sixty an hour, and a fifteen-minute pause after a refusal are the
 * shipped behaviour.
 *
 * @module dsh-zhihu/src/config
 */

/** Every configurable value with its default. */
export const DEFAULT_CONFIG = {
  /** Credential-record slot, so one profile can hold more than one account. */
  accountId: 'default',
  /** Browser identity sent with every request; Zhihu rejects some minimal UAs. */
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  /** One request's own deadline. */
  requestTimeoutMs: 20_000,
  /** Largest response body read; the biggest question page seen is about 1 MB. */
  responseLimitBytes: 4_194_304,
  /** Minimum spacing between two upstream requests. */
  minIntervalMs: 3_000,
  /** Wait before the single transport retry. */
  retryDelayMs: 2_000,
  /** Transport retries per request; a refusal is never retried. */
  retryAttempts: 1,
  /** Pause after a transport failure or a 5xx. */
  pauseNetworkMs: 60_000,
  /** Pause after Zhihu signals risk control (a captcha or verification page). */
  pauseRiskMs: 900_000,
  /** Pause after a 429 when it names no delay. */
  pauseRateLimitMs: 600_000,
  /** Pause after an endpoint answers "a signature is required". */
  pauseSignatureMs: 3_600_000,
  /** Upstream requests allowed in any rolling hour. */
  hourlyBudget: 60,
  /** How long a successful response may answer an identical request. */
  cacheTtlMs: 600_000,
  /** Most parsed responses kept in the process-local cache. */
  cacheMaxEntries: 32,
  /** Default and maximum page sizes for list tools. */
  listDefaultLimit: 10,
  listMaxLimit: 20,
  /** Default and maximum comment page sizes. */
  commentsDefaultLimit: 10,
  commentsMaxLimit: 20,
  /** Characters of answer/article/comment content kept per item. */
  contentChars: 20_000,
  commentChars: 1_000,
  excerptChars: 500,
  /** Tool deadline, which must cover queueing, pacing, and the request itself. */
  toolTimeoutMs: 120_000,
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/** A field that must be a positive integer. */
const INTEGER_FLOOR = {
  requestTimeoutMs: 1_000,
  responseLimitBytes: 65_536,
  minIntervalMs: 1,
  retryDelayMs: 1,
  pauseNetworkMs: 1_000,
  pauseRiskMs: 60_000,
  pauseRateLimitMs: 60_000,
  pauseSignatureMs: 60_000,
  hourlyBudget: 1,
  cacheTtlMs: 1_000,
  cacheMaxEntries: 1,
  listDefaultLimit: 1,
  listMaxLimit: 1,
  commentsDefaultLimit: 1,
  commentsMaxLimit: 1,
  contentChars: 200,
  commentChars: 100,
  excerptChars: 100,
  toolTimeoutMs: 10_000,
}

/**
 * Read one bounded integer config field.
 *
 * @param config - the row's raw `config` object.
 * @param key - field name, also used in the failure message.
 * @returns the configured value, or the default when the field is absent.
 * @throws when the value is not an integer at or above the field's floor.
 */
function configInteger(config, key) {
  const value = config[key]
  if (value === undefined) return DEFAULT_CONFIG[key]
  const floor = INTEGER_FLOOR[key] ?? 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < floor) {
    throw new Error(`zhihu: config.${key} must be an integer of at least ${floor}`)
  }
  return value
}

/**
 * Resolve and validate a row's `config` into the complete option set.
 *
 * @param raw - the `config` value the Loader passed to `apply`, if any.
 * @returns every option resolved to a concrete value.
 * @throws when the row names an unknown key or a value outside its range.
 */
export function resolveConfig(raw) {
  const config = raw === undefined || raw === null ? {} : raw
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('zhihu: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`zhihu: unknown config key "${key}"`)
  }

  const resolved = { accountId: config.accountId ?? DEFAULT_CONFIG.accountId }
  if (typeof resolved.accountId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(resolved.accountId)) {
    throw new Error('zhihu: config.accountId must be a lowercase credential-key segment')
  }
  const userAgent = config.userAgent ?? DEFAULT_CONFIG.userAgent
  if (typeof userAgent !== 'string' || userAgent.trim().length < 16) {
    throw new Error('zhihu: config.userAgent must be a browser-like user agent of at least 16 characters')
  }
  resolved.userAgent = userAgent
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === 'accountId' || key === 'userAgent') continue
    resolved[key] = configInteger(config, key)
  }
  // A retry count of zero is meaningful ("never retry") but is not positive,
  // so it is validated separately from the floored fields.
  const retryAttempts = config.retryAttempts ?? DEFAULT_CONFIG.retryAttempts
  if (!Number.isInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 3) {
    throw new Error('zhihu: config.retryAttempts must be an integer from 0 to 3')
  }
  resolved.retryAttempts = retryAttempts

  if (resolved.listDefaultLimit > resolved.listMaxLimit) {
    throw new Error('zhihu: config.listDefaultLimit must not exceed config.listMaxLimit')
  }
  if (resolved.commentsDefaultLimit > resolved.commentsMaxLimit) {
    throw new Error('zhihu: config.commentsDefaultLimit must not exceed config.commentsMaxLimit')
  }
  if (resolved.toolTimeoutMs <= resolved.requestTimeoutMs + resolved.minIntervalMs) {
    throw new Error('zhihu: config.toolTimeoutMs must exceed requestTimeoutMs plus minIntervalMs')
  }
  return resolved
}

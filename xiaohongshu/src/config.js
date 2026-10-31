/**
 * Every tunable of the Xiaohongshu bundle, with its default, and the load-time
 * validation of a row's `config`.
 *
 * Xiaohongshu is far less tolerant of automation than a public API: the search
 * endpoint is the first thing an unhealthy account loses, and a burst of reads
 * can turn into a verification page that lasts hours. The defaults here are
 * deliberately slow. One request per twelve seconds, twenty per hour and sixty
 * per day is enough for personal reading and leaves a wide margin around the
 * account.
 *
 * @module dsh-xiaohongshu/src/config
 */

import { USER_AGENT } from './signing.js'

/** Every configurable value with its default. */
export const DEFAULT_CONFIG = {
  /** Credential-record slot, so one profile can hold more than one account. */
  accountId: 'default',
  /** Browser identity sent with every request and frozen into the device profile. */
  userAgent: USER_AGENT,
  /** One request's own deadline. */
  requestTimeoutMs: 20_000,
  /** Largest API response body read, in bytes. */
  responseLimitBytes: 4_194_304,
  /** Minimum spacing between two upstream API requests. */
  minIntervalMs: 12_000,
  /** Fraction of `minIntervalMs` added as random jitter, 0 to 1. */
  jitterRatio: 0.3,
  /** Upstream API requests allowed in any rolling hour. */
  hourlyBudget: 20,
  /** Upstream API requests allowed in any rolling day. */
  dailyBudget: 60,
  /** Search requests allowed in any rolling hour. */
  searchHourlyBudget: 6,
  /** Search requests allowed in any rolling day. */
  searchDailyBudget: 20,
  /** Wait before the single transport retry. */
  retryDelayMs: 3_000,
  /** Transport retries per request; a refusal is never retried. */
  retryAttempts: 1,
  /** Pause after a transport failure or a 5xx. */
  pauseNetworkMs: 300_000,
  /** Pause after Xiaohongshu signals risk control (461/471 or a verification page). */
  pauseRiskMs: 86_400_000,
  /** Pause after a 429 when it names no delay. */
  pauseRateLimitMs: 1_800_000,
  /** Pause after the signature is rejected; a retry cannot fix it. */
  pauseSignatureMs: 86_400_000,
  /** How long a successful API response may answer an identical request. */
  cacheTtlMs: 600_000,
  /** Most parsed API responses kept in the process-local cache. */
  cacheMaxEntries: 64,
  /** Default and maximum page sizes for search. */
  searchDefaultLimit: 20,
  searchMaxLimit: 20,
  /** Most result pages one search call may walk. */
  searchMaxPages: 3,
  /** Default and maximum comment page sizes. */
  commentsDefaultLimit: 20,
  commentsMaxLimit: 50,
  /** Characters kept per note body, comment, and search excerpt. */
  contentChars: 20_000,
  commentChars: 800,
  excerptChars: 300,
  /** Notes one capture keeps the card of, when the caller names no limit. */
  captureDefaultNotes: 10,
  captureMaxNotes: 20,
  /** Notes one capture fetches the full body of, when the caller names no limit. */
  detailDefaultLimit: 5,
  detailMaxLimit: 10,
  /** Download image files while capturing a note. */
  downloadMedia: true,
  /** Largest image file accepted, in bytes. */
  mediaMaxBytes: 10_485_760,
  /** Image downloads issued at once. */
  mediaConcurrency: 2,
  /** One image download's deadline. */
  mediaTimeoutMs: 30_000,
  /** Tool deadline, which must cover queueing, pacing, and the request itself. */
  toolTimeoutMs: 240_000,
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/** A field that must be a positive integer. */
const INTEGER_FLOOR = {
  requestTimeoutMs: 1_000,
  responseLimitBytes: 65_536,
  minIntervalMs: 1_000,
  jitterRatio: 0,
  hourlyBudget: 1,
  dailyBudget: 1,
  searchHourlyBudget: 1,
  searchDailyBudget: 1,
  retryDelayMs: 1,
  pauseNetworkMs: 1_000,
  pauseRiskMs: 60_000,
  pauseRateLimitMs: 60_000,
  pauseSignatureMs: 60_000,
  cacheTtlMs: 1_000,
  cacheMaxEntries: 1,
  searchDefaultLimit: 1,
  searchMaxLimit: 1,
  searchMaxPages: 1,
  commentsDefaultLimit: 1,
  commentsMaxLimit: 1,
  contentChars: 200,
  commentChars: 100,
  excerptChars: 40,
  captureDefaultNotes: 1,
  captureMaxNotes: 1,
  detailDefaultLimit: 1,
  detailMaxLimit: 1,
  mediaMaxBytes: 1_024,
  mediaConcurrency: 1,
  mediaTimeoutMs: 1_000,
  toolTimeoutMs: 10_000,
}

/** A field that must be a positive number (fractions allowed). */
const NUMBER_FLOOR = {
  jitterRatio: 0,
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
    throw new Error(`xiaohongshu: config.${key} must be an integer of at least ${floor}`)
  }
  return value
}

/**
 * Read one bounded number config field.
 *
 * @param config - the row's raw `config` object.
 * @param key - field name, also used in the failure message.
 * @returns the configured value, or the default when the field is absent.
 * @throws when the value is not a number at or above the field's floor.
 */
function configNumber(config, key) {
  const value = config[key]
  if (value === undefined) return DEFAULT_CONFIG[key]
  const floor = NUMBER_FLOOR[key] ?? 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < floor) {
    throw new Error(`xiaohongshu: config.${key} must be a number of at least ${floor}`)
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
    throw new Error('xiaohongshu: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`xiaohongshu: unknown config key "${key}"`)
  }

  const resolved = { accountId: config.accountId ?? DEFAULT_CONFIG.accountId }
  if (typeof resolved.accountId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(resolved.accountId)) {
    throw new Error('xiaohongshu: config.accountId must be a lowercase credential-key segment')
  }

  const userAgent = config.userAgent ?? DEFAULT_CONFIG.userAgent
  if (typeof userAgent !== 'string' || userAgent.trim().length < 16) {
    throw new Error('xiaohongshu: config.userAgent must be a browser-like user agent of at least 16 characters')
  }
  resolved.userAgent = userAgent

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === 'accountId' || key === 'userAgent') continue
    if (key === 'jitterRatio') {
      resolved[key] = configNumber(config, key)
      continue
    }
    if (key === 'downloadMedia') {
      const value = config[key] ?? DEFAULT_CONFIG.downloadMedia
      if (typeof value !== 'boolean') throw new Error('xiaohongshu: config.downloadMedia must be a boolean')
      resolved[key] = value
      continue
    }
    resolved[key] = configInteger(config, key)
  }

  const retryAttempts = config.retryAttempts ?? DEFAULT_CONFIG.retryAttempts
  if (!Number.isInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 3) {
    throw new Error('xiaohongshu: config.retryAttempts must be an integer from 0 to 3')
  }
  resolved.retryAttempts = retryAttempts

  if (resolved.jitterRatio > 1) {
    throw new Error('xiaohongshu: config.jitterRatio must not exceed 1')
  }
  if (resolved.searchDefaultLimit > resolved.searchMaxLimit) {
    throw new Error('xiaohongshu: config.searchDefaultLimit must not exceed config.searchMaxLimit')
  }
  if (resolved.commentsDefaultLimit > resolved.commentsMaxLimit) {
    throw new Error('xiaohongshu: config.commentsDefaultLimit must not exceed config.commentsMaxLimit')
  }
  if (resolved.captureDefaultNotes > resolved.captureMaxNotes) {
    throw new Error('xiaohongshu: config.captureDefaultNotes must not exceed config.captureMaxNotes')
  }
  if (resolved.detailDefaultLimit > resolved.detailMaxLimit) {
    throw new Error('xiaohongshu: config.detailDefaultLimit must not exceed config.detailMaxLimit')
  }
  if (resolved.searchHourlyBudget > resolved.hourlyBudget) {
    throw new Error('xiaohongshu: config.searchHourlyBudget must not exceed config.hourlyBudget')
  }
  if (resolved.searchDailyBudget > resolved.dailyBudget) {
    throw new Error('xiaohongshu: config.searchDailyBudget must not exceed config.dailyBudget')
  }
  if (resolved.toolTimeoutMs <= resolved.requestTimeoutMs + resolved.minIntervalMs) {
    throw new Error('xiaohongshu: config.toolTimeoutMs must exceed requestTimeoutMs plus minIntervalMs')
  }
  return resolved
}

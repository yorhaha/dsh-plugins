/**
 * The one place this plugin's defaults live.
 *
 * The bundle declares no schema library, so `resolveConfig` validates the
 * Loader row itself and fails the load on a bad value rather than falling back
 * to a default that silently reads the wrong endpoint. `cordis.patch.yml`
 * documents the accepted keys.
 *
 * @module dsh-magpie-quota/config
 */

/** Largest response body accepted from magpie's gateway, in characters. */
const MAX_BODY_LIMIT = 4 * 1024 * 1024

/** Most allowance windows one deployment may hide. */
const MAX_HIDDEN_WINDOWS = 100

/** Longest single `provider/window` entry. */
const MAX_HIDDEN_CHARS = 200

/**
 * Every option at its default.
 *
 * `gateway` is magpie's own address as it reports it in
 * `~/.config/magpie/gateway.json`, not a value this plugin invents: magpie
 * serves the tray, the window, and this gateway on one loopback port, so a
 * deployment that moved it changes this key alone.
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  gateway: 'http://127.0.0.1:3425',
  timeoutMs: 4000,
  maxBytes: 512 * 1024,
  /**
   * Allowance windows this page never shows, as `provider/window name`.
   *
   * The default drops WorkBuddy's `Total credits`, which is `Credits` plus
   * `Extra credits` and carries the same expiry as one of them: three rows for
   * two facts. Nothing is hidden silently — the rule is a visible list here and
   * in `cordis.patch.yml`, so a deployment that wants the row back deletes one
   * line, and one that wants another gone adds one.
   */
  hiddenWindows: ['workbuddy/Total credits'],
}

/** A configuration value the deployment must fix before the plugin can load. */
export class ConfigError extends Error {
  /**
   * @param key - the offending top-level key.
   * @param reason - what is wrong with it, without quoting a secret.
   */
  constructor(key, reason) {
    super(`magpie-quota: config.${key} ${reason}`)
    this.name = 'ConfigError'
  }
}

/**
 * Read a whole number inside a range.
 * @param key - the key being read, for the refusal message.
 * @param value - the raw value.
 * @param min - smallest accepted value.
 * @param max - largest accepted value.
 * @param fallback - the default used when the key is absent.
 * @returns the number.
 */
function readInteger(key, value, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(key, 'must be a whole number')
  }
  if (value < min || value > max) {
    throw new ConfigError(key, `must be between ${min} and ${max}`)
  }
  return value
}

/**
 * Read the gateway's base URL.
 *
 * Only `http` and `https` are accepted, and the URL must carry no path beyond
 * `/`: a base with a path would silently re-root the two known route suffixes
 * and read a 404 as "magpie is not running".
 *
 * @param value - the raw value.
 * @returns the base URL without a trailing slash.
 * @throws {ConfigError} when it is not an absolute http(s) URL.
 */
function readGateway(value) {
  if (value === undefined || value === null) return DEFAULT_CONFIG.gateway
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError('gateway', 'must be a non-empty string')
  }
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new ConfigError('gateway', 'must be an absolute URL such as http://127.0.0.1:3425')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('gateway', 'must use http or https')
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new ConfigError('gateway', 'must be an origin with no path, query, or fragment')
  }
  return parsed.origin
}

/**
 * Read the list of allowance windows to leave out.
 *
 * Each entry is `provider/window name`, split on the FIRST `/` because provider
 * ids never contain one while a window name may. Matching is exact and
 * case-sensitive: both halves are strings magpie reports, not patterns, so a
 * typo hides nothing rather than hiding the wrong row.
 *
 * @param value - the raw value.
 * @returns the entries, de-duplicated.
 * @throws {ConfigError} when an entry is not a `provider/window` string.
 */
function readHiddenWindows(value) {
  if (value === undefined || value === null) return DEFAULT_CONFIG.hiddenWindows
  if (!Array.isArray(value)) throw new ConfigError('hiddenWindows', 'must be a list of provider/window strings')
  if (value.length > MAX_HIDDEN_WINDOWS) {
    throw new ConfigError('hiddenWindows', `must hold at most ${MAX_HIDDEN_WINDOWS} entries`)
  }
  const seen = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError('hiddenWindows', 'must hold non-empty strings')
    }
    const trimmed = entry.trim()
    if (trimmed.length > MAX_HIDDEN_CHARS) {
      throw new ConfigError('hiddenWindows', `entries must be at most ${MAX_HIDDEN_CHARS} characters`)
    }
    const slash = trimmed.indexOf('/')
    if (slash <= 0 || slash === trimmed.length - 1) {
      throw new ConfigError('hiddenWindows', `entry ${JSON.stringify(trimmed)} must be provider/window`)
    }
    if (!seen.includes(trimmed)) seen.push(trimmed)
  }
  return seen
}

/**
 * Resolve and validate one Loader row's `config`.
 *
 * A row's `config` replaces the whole default block, so an omitted key falls
 * back here rather than to the patch file's copy of it.
 *
 * @param raw - the Loader row's `config`, if any.
 * @returns the resolved configuration.
 * @throws {ConfigError} on an unknown key or an out-of-range value.
 */
export function resolveConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('config', 'must be an object')
  }
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
      throw new ConfigError(key, 'is not a known option')
    }
  }
  const enabled = raw.enabled === undefined ? DEFAULT_CONFIG.enabled : raw.enabled
  if (typeof enabled !== 'boolean') throw new ConfigError('enabled', 'must be true or false')
  return {
    enabled,
    gateway: readGateway(raw.gateway),
    timeoutMs: readInteger('timeoutMs', raw.timeoutMs, 100, 30000, DEFAULT_CONFIG.timeoutMs),
    maxBytes: readInteger('maxBytes', raw.maxBytes, 4096, MAX_BODY_LIMIT, DEFAULT_CONFIG.maxBytes),
    hiddenWindows: readHiddenWindows(raw.hiddenWindows),
  }
}

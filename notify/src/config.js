/**
 * Plugin configuration: the accepted keys, their defaults, and the load-time
 * checks that every value is usable before anything registers.
 *
 * The plugin declares no schema library, so it validates its own loader row and
 * fails the load on a bad value rather than silently falling back to a default.
 *
 * @module dsh-notify/src/config
 */

/** PushPlus templates this plugin may ask for. */
const TEMPLATES = Object.freeze(['txt', 'html', 'markdown'])

/** Every configurable value with its default. */
const DEFAULT_CONFIG = Object.freeze({
  baseUrl: 'https://www.pushplus.plus',
  template: 'txt',
  defaultTitle: 'DeepSeek Harness',
  requestTimeoutMs: 15_000,
  toolTimeoutMs: 60_000,
  titleMaxChars: 100,
  contentMaxChars: 4_000,
})

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/**
 * Resolve and validate the loader row's `config`.
 *
 * @param raw - The `config` value the loader passed to `apply`, if any.
 * @returns the complete option set.
 * @throws when a key is unknown or a value is unusable.
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('notify: config must be a mapping')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`notify: unknown config key "${key}"`)
  }

  const baseUrl = resolveBaseUrl(config.baseUrl ?? DEFAULT_CONFIG.baseUrl)

  const template = config.template ?? DEFAULT_CONFIG.template
  if (typeof template !== 'string' || !TEMPLATES.includes(template)) {
    throw new Error(`notify: config.template must be one of ${TEMPLATES.join(', ')}`)
  }

  const titleMaxChars = resolveBoundInt(config.titleMaxChars, DEFAULT_CONFIG.titleMaxChars, 'titleMaxChars', 1, 500)
  const contentMaxChars = resolveBoundInt(
    config.contentMaxChars,
    DEFAULT_CONFIG.contentMaxChars,
    'contentMaxChars',
    1,
    20_000,
  )

  const defaultTitle = config.defaultTitle ?? DEFAULT_CONFIG.defaultTitle
  if (typeof defaultTitle !== 'string' || defaultTitle.trim() === '') {
    throw new Error('notify: config.defaultTitle must be a non-empty string')
  }

  const requestTimeoutMs = resolveBoundInt(
    config.requestTimeoutMs,
    DEFAULT_CONFIG.requestTimeoutMs,
    'requestTimeoutMs',
    1_000,
    120_000,
  )
  const toolTimeoutMs = resolveBoundInt(
    config.toolTimeoutMs,
    DEFAULT_CONFIG.toolTimeoutMs,
    'toolTimeoutMs',
    1_000,
    600_000,
  )
  // A tool call covers one request per target, so a tool timeout below the
  // request timeout could not let even a single send finish.
  if (toolTimeoutMs < requestTimeoutMs) {
    throw new Error('notify: config.toolTimeoutMs must be at least config.requestTimeoutMs')
  }

  return {
    baseUrl,
    template,
    defaultTitle,
    requestTimeoutMs,
    toolTimeoutMs,
    titleMaxChars,
    contentMaxChars,
  }
}

/**
 * Accept an absolute http(s) endpoint and drop its trailing slashes.
 * @param value - The configured endpoint.
 * @returns the endpoint the send path is built from.
 * @throws when the value is not an absolute http(s) URL.
 */
function resolveBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('notify: config.baseUrl must be a non-empty URL')
  }
  const trimmed = value.trim().replace(/\/+$/, '')
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`notify: config.baseUrl is not an absolute URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('notify: config.baseUrl must use http or https')
  }
  return trimmed
}

/**
 * Accept a whole number inside a range.
 * @param value - The configured value, or undefined for the default.
 * @param fallback - The default.
 * @param field - Field name, named in the failure.
 * @param min - Smallest accepted value.
 * @param max - Largest accepted value.
 * @returns the accepted value.
 * @throws when the value is not a whole number in range.
 */
function resolveBoundInt(value, fallback, field, min, max) {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`notify: config.${field} must be an integer from ${min} to ${max}`)
  }
  return resolved
}

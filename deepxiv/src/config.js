/**
 * Plugin configuration: the accepted keys, their defaults, and the load-time
 * checks that every value is usable before anything registers.
 *
 * The plugin declares no schema library, so it validates its own loader row and
 * fails the load on a bad value rather than silently falling back to a default.
 *
 * @module dsh-deepxiv/src/config
 */

/** Every configurable value with its default. */
const DEFAULT_CONFIG = Object.freeze({
  baseUrl: 'https://data.rag.ac.cn',
  requestTimeoutMs: 30_000,
  toolTimeoutMs: 90_000,
  responseLimitBytes: 4 * 1024 * 1024,
  queryMaxChars: 500,
  searchDefaultTopK: 10,
  searchMaxTopK: 50,
  titleMaxChars: 300,
  tldrMaxChars: 800,
  abstractMaxChars: 1_500,
  previewDefaultChars: 10_000,
  previewMaxChars: 100_000,
  sectionMaxChars: 20_000,
  fullMaxChars: 200_000,
  authorsMax: 20,
  orgsMax: 10,
  categoriesMax: 10,
  keywordsMax: 20,
  sectionsMax: 50,
  userAgent: 'dsh-deepxiv/0.1',
})

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/** Largest query the retrieval endpoint accepts, in characters. */
export const QUERY_CEILING = 2_000

/** Largest retrieval size the endpoint accepts. */
export const TOP_K_CEILING = 100

/** Largest preview the endpoint accepts, in characters. */
export const PREVIEW_CEILING = 100_000

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
    throw new Error('deepxiv: config must be a mapping')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`deepxiv: unknown config key "${key}"`)
  }

  const baseUrl = resolveBaseUrl(config.baseUrl ?? DEFAULT_CONFIG.baseUrl)

  const requestTimeoutMs = resolveBoundInt(
    config.requestTimeoutMs,
    DEFAULT_CONFIG.requestTimeoutMs,
    'requestTimeoutMs',
    1_000,
    300_000,
  )
  const toolTimeoutMs = resolveBoundInt(
    config.toolTimeoutMs,
    DEFAULT_CONFIG.toolTimeoutMs,
    'toolTimeoutMs',
    1_000,
    900_000,
  )
  // A whole tool call may wait on more than one request, so a tool timeout below
  // the request timeout could not let even the first one finish.
  if (toolTimeoutMs < requestTimeoutMs) {
    throw new Error('deepxiv: config.toolTimeoutMs must be at least config.requestTimeoutMs')
  }

  const searchDefaultTopK = resolveBoundInt(
    config.searchDefaultTopK,
    DEFAULT_CONFIG.searchDefaultTopK,
    'searchDefaultTopK',
    1,
    TOP_K_CEILING,
  )
  const searchMaxTopK = resolveBoundInt(
    config.searchMaxTopK,
    DEFAULT_CONFIG.searchMaxTopK,
    'searchMaxTopK',
    1,
    TOP_K_CEILING,
  )
  if (searchDefaultTopK > searchMaxTopK) {
    throw new Error('deepxiv: config.searchDefaultTopK must not exceed config.searchMaxTopK')
  }

  const previewDefaultChars = resolveBoundInt(
    config.previewDefaultChars,
    DEFAULT_CONFIG.previewDefaultChars,
    'previewDefaultChars',
    100,
    PREVIEW_CEILING,
  )
  const previewMaxChars = resolveBoundInt(
    config.previewMaxChars,
    DEFAULT_CONFIG.previewMaxChars,
    'previewMaxChars',
    100,
    PREVIEW_CEILING,
  )
  if (previewDefaultChars > previewMaxChars) {
    throw new Error('deepxiv: config.previewDefaultChars must not exceed config.previewMaxChars')
  }

  const userAgent = config.userAgent ?? DEFAULT_CONFIG.userAgent
  if (typeof userAgent !== 'string' || userAgent.trim() === '') {
    throw new Error('deepxiv: config.userAgent must be a non-empty string')
  }

  return {
    baseUrl,
    requestTimeoutMs,
    toolTimeoutMs,
    responseLimitBytes: resolveBoundInt(
      config.responseLimitBytes,
      DEFAULT_CONFIG.responseLimitBytes,
      'responseLimitBytes',
      1_024,
      64 * 1024 * 1024,
    ),
    queryMaxChars: resolveBoundInt(config.queryMaxChars, DEFAULT_CONFIG.queryMaxChars, 'queryMaxChars', 1, QUERY_CEILING),
    searchDefaultTopK,
    searchMaxTopK,
    titleMaxChars: resolveBoundInt(config.titleMaxChars, DEFAULT_CONFIG.titleMaxChars, 'titleMaxChars', 1, 2_000),
    tldrMaxChars: resolveBoundInt(config.tldrMaxChars, DEFAULT_CONFIG.tldrMaxChars, 'tldrMaxChars', 1, 20_000),
    abstractMaxChars: resolveBoundInt(
      config.abstractMaxChars,
      DEFAULT_CONFIG.abstractMaxChars,
      'abstractMaxChars',
      1,
      50_000,
    ),
    previewDefaultChars,
    previewMaxChars,
    sectionMaxChars: resolveBoundInt(
      config.sectionMaxChars,
      DEFAULT_CONFIG.sectionMaxChars,
      'sectionMaxChars',
      1,
      1_000_000,
    ),
    fullMaxChars: resolveBoundInt(config.fullMaxChars, DEFAULT_CONFIG.fullMaxChars, 'fullMaxChars', 1, 2_000_000),
    authorsMax: resolveBoundInt(config.authorsMax, DEFAULT_CONFIG.authorsMax, 'authorsMax', 1, 200),
    orgsMax: resolveBoundInt(config.orgsMax, DEFAULT_CONFIG.orgsMax, 'orgsMax', 1, 100),
    categoriesMax: resolveBoundInt(config.categoriesMax, DEFAULT_CONFIG.categoriesMax, 'categoriesMax', 1, 100),
    keywordsMax: resolveBoundInt(config.keywordsMax, DEFAULT_CONFIG.keywordsMax, 'keywordsMax', 1, 200),
    sectionsMax: resolveBoundInt(config.sectionsMax, DEFAULT_CONFIG.sectionsMax, 'sectionsMax', 1, 500),
    userAgent: userAgent.trim(),
  }
}

/**
 * Accept an absolute http(s) endpoint and drop its trailing slashes.
 * @param value - The configured endpoint.
 * @returns the endpoint every request path is resolved against.
 * @throws when the value is not an absolute http(s) URL.
 */
function resolveBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('deepxiv: config.baseUrl must be a non-empty URL')
  }
  const trimmed = value.trim().replace(/\/+$/, '')
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`deepxiv: config.baseUrl is not an absolute URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('deepxiv: config.baseUrl must use http or https')
  }
  // A path prefix is kept and appended to; a query or fragment would be glued
  // to the route path and produce a request the API cannot answer.
  if (url.search !== '' || url.hash !== '') {
    throw new Error('deepxiv: config.baseUrl must not carry a query or fragment')
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
    throw new Error(`deepxiv: config.${field} must be an integer from ${min} to ${max}`)
  }
  return resolved
}

export { DEFAULT_CONFIG }

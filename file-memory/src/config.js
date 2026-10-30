/**
 * Loader config for the file-memory plugin.
 *
 * Every deployment-varying value lives here so a deployment overrides it in its
 * own patch layer instead of editing this package. The root is resolved to
 * absolute form ONCE, at load, and never again: the plugin is mounted without a
 * session, so `process.cwd()` at request time is not the workspace a user means.
 *
 * The default root is `$DSH_HOME/memory`, and a RELATIVE root is refused rather
 * than resolved. The launch directory is not the workspace: `dsh web` from a
 * checkout and the desktop application from its profile directory resolve the
 * same relative spelling to different directories, and the second one looks like
 * a working install whose memory is simply empty. A default that moves with the
 * launcher is the defect this rule removes.
 *
 * A defect fails the load rather than falling back. A silently defaulted memory
 * root would make the browser read and write the wrong directory.
 *
 * @module dsh-file-memory/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Values a deployment may change. */
export const DEFAULTS = Object.freeze({
  maxDepth: 5,
  maxFileBytes: 1024 * 1024,
})

/** Environment variable that relocates the Harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Keys accepted in the loader row; anything else is a typo, not a feature. */
const KNOWN_KEYS = new Set(['enabled', 'root', 'maxDepth', 'maxFileBytes'])

/** Largest depth that still terminates the walk in bounded time. */
const MAX_DEPTH_CEILING = 32

/** Largest accepted single-file size. */
const MAX_FILE_BYTES_CEILING = 64 * 1024 * 1024

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 * @param value - the path to expand.
 * @returns the expanded path, absolute when the input was.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the Harness home.
 *
 * The precedence is the one `@deepseek-ai/dsh-home-paths` owns — a non-blank
 * `$DSH_HOME`, otherwise `~/.dsh` — restated here because this plugin carries no
 * dependencies. A blank override is treated as unset, so it can never resolve
 * the home to the working directory.
 * @returns the absolute Harness home.
 */
function dshHome() {
  const fromEnv = process.env[DSH_HOME_ENV]
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(expandHome(selected))
}

/**
 * The default memory directory: one folder under the Harness home, so it is the
 * same directory whatever directory launched the harness and whichever profile
 * is running.
 * @returns the absolute default memory root.
 */
export function defaultRoot() {
  return join(dshHome(), 'memory')
}

/**
 * Resolve the configured root to an absolute path.
 *
 * `~` is expanded because a deployment may point the root at a home directory.
 * A root that is empty, whitespace, or relative is a defect: the relative form
 * carries no meaning the plugin can honour, because the directory it would
 * resolve against belongs to the launcher.
 * @param value - the configured value.
 * @returns the absolute path.
 * @throws {TypeError} when the value is absent, blank, relative, or not a string.
 */
function resolveRoot(value) {
  if (typeof value !== 'string') throw new TypeError('file-memory: root must be a string')
  const trimmed = value.trim()
  if (trimmed === '') throw new TypeError('file-memory: root must not be empty')
  const expanded = expandHome(trimmed)
  if (!isAbsolute(expanded)) {
    throw new TypeError(
      `file-memory: root must be absolute or start with "~", got "${trimmed}". `
      + 'A relative root would resolve against the launch directory, which differs between '
      + '`dsh web` and the desktop application and is not the workspace either of them serves.',
    )
  }
  return expanded
}

/**
 * Read a bounded integer field.
 * @param value - the configured value, or `undefined` for the default.
 * @param label - config key name, for the diagnostic.
 * @param fallback - value used when absent.
 * @param ceiling - largest accepted value.
 * @returns the validated integer.
 */
function boundedInteger(value, label, fallback, ceiling) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new TypeError(`file-memory: ${label} must be an integer in 1..${String(ceiling)}`)
  }
  return value
}

/**
 * Validate one loader row.
 * @param raw - the row's `config`, if any.
 * @returns the resolved configuration, with an absolute `root`.
 * @throws {TypeError} when a value is absent, malformed, or unknown.
 */
export function resolveConfig(raw) {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new TypeError('file-memory: config must be a mapping')
  }
  const config = raw ?? {}
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) throw new TypeError(`file-memory: unknown config key "${key}"`)
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new TypeError('file-memory: enabled must be a boolean')
  }
  return {
    enabled: config.enabled ?? true,
    root: resolveRoot(config.root ?? defaultRoot()),
    maxDepth: boundedInteger(config.maxDepth, 'maxDepth', DEFAULTS.maxDepth, MAX_DEPTH_CEILING),
    maxFileBytes: boundedInteger(
      config.maxFileBytes, 'maxFileBytes', DEFAULTS.maxFileBytes, MAX_FILE_BYTES_CEILING,
    ),
  }
}

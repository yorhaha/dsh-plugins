/**
 * Plugin configuration: the schema, the load-time checks the schema cannot
 * express, and the single place a configured value becomes an absolute path.
 *
 * Nothing downstream defaults anything: {@link resolveOptions} is the explicit
 * resolution step, and every consumer reads its result.
 *
 * @module dsh-wechat/src/config
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { resolveZone } from './time.js'

/**
 * Plugin configuration.
 *
 * Every field is an ordinary value: nothing here is edited from the settings
 * page, so a change means editing the loader row and reloading. Paths may use
 * `~`; they are expanded once in {@link resolveOptions}.
 */
export const Config = z.object({
  /** Exporter project holding `export.py`, `.venv`, and `meta/wechat-keys.json`. */
  exporterDir: z.string().default(''),
  /** Where the exporter writes batches; empty means `<exporterDir>/data`. */
  exportDir: z.string().default(''),
  /** The exporter's key file; empty means `<exporterDir>/meta/wechat-keys.json`. */
  keysFile: z.string().default(''),
  /** Parent of the signed-in account's `db_storage` directory. */
  wechatDbParent: z
    .string()
    .default('~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'),
  /** Explicit `db_storage` path; empty discovers one below the parent. */
  wechatDbDir: z.string().default(''),
  /** Batch archive root. Batches are imported in place and never deleted. */
  batchesDir: z.string().required(),
  /** Absolute path of the SQLite corpus. */
  databasePath: z.string().required(),
  /** Import scope used when a caller does not ask for one. */
  defaultIncludeGroups: z.boolean().default(false),
  /** Messages at or below which an import runs inside the tool call. */
  inlineImportLimit: z.number().min(0).default(5000),
  /** Zone for naive export times and date-only bounds; empty follows the host. */
  localTimeZone: z.string().default(''),
  /** Five-field cron the recurring import task runs on. */
  scheduleCron: z.string().default('0 9 * * 1'),
  /** Days of history the recurring task's export covers. */
  scheduleExportDays: z.number().min(0).default(7),
})

/**
 * Reject a configuration the plugin cannot run with, naming the field.
 *
 * These are the checks a schema cannot express: whether a path is absolute
 * (a relative one would resolve against whatever directory the host started in)
 * and whether the configured zone exists.
 *
 * @param config - The loader row's configuration.
 * @throws when a value is unusable.
 */
export function validate(config) {
  for (const [field, value] of [
    ['batchesDir', config.batchesDir],
    ['databasePath', config.databasePath],
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`wechat: config.${field} must be a non-empty path`)
    }
    if (!isAbsolute(expandHome(value))) {
      throw new Error(`wechat: config.${field} must be an absolute path`)
    }
  }
  if (!Number.isInteger(config.inlineImportLimit) || config.inlineImportLimit < 0) {
    throw new Error('wechat: config.inlineImportLimit must be a whole count of messages')
  }
  if (!isCronExpression(config.scheduleCron)) {
    throw new Error(`wechat: config.scheduleCron must be a five-field cron expression: ${config.scheduleCron}`)
  }
  if (!Number.isInteger(config.scheduleExportDays) || config.scheduleExportDays < 0) {
    throw new Error('wechat: config.scheduleExportDays must be a whole number of days')
  }
  if (resolveZone(config.localTimeZone) === null) {
    throw new Error(`wechat: config.localTimeZone is not a known zone: ${config.localTimeZone}`)
  }
  for (const field of ['exporterDir', 'exportDir', 'keysFile', 'wechatDbDir']) {
    const value = config[field]
    if (typeof value === 'string' && value.trim() !== '' && !isAbsolute(expandHome(value))) {
      throw new Error(`wechat: config.${field} must be an absolute path or empty`)
    }
  }
}

/**
 * Resolve the configuration into the concrete paths this plugin uses.
 * @param config - A validated configuration.
 * @returns every resolved value, with no further defaulting downstream.
 */
export function resolveOptions(config) {
  const exporterDir = expandHome(config.exporterDir).trim()
  const databasePath = expandHome(config.databasePath)
  const timeZone = resolveZone(config.localTimeZone)
  if (timeZone === null) {
    throw new Error(`wechat: config.localTimeZone is not a known zone: ${config.localTimeZone}`)
  }
  return {
    exporterDir,
    exportDir:
      expandHome(config.exportDir).trim() ||
      (exporterDir === '' ? '' : join(exporterDir, 'data')),
    keysFile:
      expandHome(config.keysFile).trim() ||
      (exporterDir === '' ? '' : join(exporterDir, 'meta', 'wechat-keys.json')),
    wechatDbParent: expandHome(config.wechatDbParent).trim(),
    wechatDbDir: expandHome(config.wechatDbDir).trim(),
    batchesDir: expandHome(config.batchesDir),
    databasePath,
    lockPath: join(dirname(databasePath), 'import.lock'),
    includeGroups: config.defaultIncludeGroups === true,
    inlineImportLimit: config.inlineImportLimit,
    scheduleCron: config.scheduleCron.trim(),
    scheduleExportDays: config.scheduleExportDays,
    timeZone,
  }
}

/**
 * Whether a value is a five-field cron expression.
 *
 * The fields are passed to the schedule service unchanged, which validates them
 * again; this only rejects what is plainly not an expression, so a typo in the
 * loader row fails at load instead of at the task's first run.
 *
 * @param value - A configured expression.
 * @returns whether it has five non-empty fields of cron characters.
 */
function isCronExpression(value) {
  if (typeof value !== 'string') return false
  const fields = value.trim().split(/\s+/)
  return fields.length === 5 && fields.every((field) => /^[0-9*/,\-]+$/.test(field))
}

/**
 * Expand a leading `~` into the home directory.
 * @param value - A configured path.
 * @returns the path with `~` expanded; anything else is returned unchanged.
 */
export function expandHome(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

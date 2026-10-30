/**
 * The read-only pipeline probe: the port of yorha's `connectors/wechat/status.py`.
 *
 * It answers one question — where does this pipeline stand right now — by
 * looking at five things and never changing any of them: the WeChat database
 * files on this machine, the exporter's key file (names only, never values), the
 * exporter's newest batch, the archive, and the last import.
 *
 * Nothing here writes. No path, conversation name, or message body leaves the
 * probe: the plugin page and the model see states, counts, and signals.
 *
 * @module dsh-wechat/src/status
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readExportSummary } from './parser.js'

/** Message shards, as the exporter's key file names them. */
const MESSAGE_KEY_RE = /^message_\d+$/

/** Message shard files, including their write-ahead logs. */
const MESSAGE_SHARD_RE = /^message_\d+\.db$/

/** Shard file names a batch may claim to have processed. */
const SHARD_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,100}\.db$/

/**
 * Collect the whole pipeline state.
 *
 * A section that cannot be read reports that in its own status; only a failure
 * of the probe itself would make the caller see an error.
 *
 * @param options - Probe inputs.
 * @param options.store - The open corpus.
 * @param options.options - Resolved plugin options.
 * @param options.clock - The zone-bound clock.
 * @param options.batches - Batch rows from the importer's listing.
 * @returns the status document.
 */
export function pipelineStatus({ store, options, clock, batches }) {
  const database = databaseSection(options)
  const keys = keysSection(options)
  annotateKeyCoverage(keys, database)
  const exporter = exportSection(options, clock)
  const archive = batchSection(batches)
  const importSection = importState(store, database)
  const counts = store.counts()
  const corpus = {
    messages: counts.messages,
    chats: counts.chats,
    database_path: store.path,
    database_bytes: store.databaseBytes(),
    kinds: store.kinds(),
  }
  const signals = deriveSignals({ database, keys, exporter, archive, importSection })
  const status = deriveStatus({ database, keys, exporter, archive, importSection })
  return {
    ok: true,
    status,
    database,
    keys,
    export: exporter,
    batches: archive,
    import: importSection,
    corpus,
    signals,
  }
}

/**
 * The freshness block every read result carries.
 *
 * It is built without touching the message table: the facts it reports are one
 * meta row, the state of WeChat's own files, and which batches are waiting. A
 * corpus-wide count here would put a full scan behind every search.
 *
 * @param options - Inputs.
 * @param options.store - The open corpus.
 * @param options.options - Resolved plugin options.
 * @param options.batches - Batch rows from the importer's listing.
 * @returns the freshness fields.
 */
export function freshness({ store, options, batches }) {
  const lastImportedAt = store.meta('last_import_at') ?? null
  const lastError = store.meta('last_error_code') ?? ''
  const database = databaseSection(options)
  return {
    lastImportedAt,
    pendingBatches: batches.filter((row) => row.state === 'pending').length,
    databaseNewerThanImport:
      database.status === 'ok' &&
      typeof database.latest_change_at === 'string' &&
      typeof lastImportedAt === 'string' &&
      database.latest_change_at > lastImportedAt,
    importFailed: lastError !== '',
  }
}

/**
 * Find the signed-in account's message shards and report how recently WeChat
 * itself touched them.
 *
 * SQLite is never opened: this reads directory entries and modification times,
 * so the probe works while WeChat holds its own database, and reports the newest
 * file change rather than claiming it means a new message.
 *
 * @param options - Resolved plugin options.
 * @returns the section.
 */
function databaseSection(options) {
  const discovery = discoverDatabaseDir(options)
  if (discovery.status !== 'ok') return { status: discovery.status }
  const dbDir = discovery.dir
  const shardDir = isDirectory(join(dbDir, 'message')) ? join(dbDir, 'message') : dbDir
  const shards = new Set()
  let latest = null
  let entries
  try {
    entries = readdirSync(shardDir, { withFileTypes: true })
  } catch (error) {
    if (isPermissionError(error)) return { status: 'unreadable' }
    return { status: 'not_found' }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const stem = entry.name.replace(/-wal$/, '')
    if (!MESSAGE_SHARD_RE.test(stem)) continue
    shards.add(stem)
    try {
      const mtime = statSync(join(shardDir, entry.name)).mtimeMs
      if (latest === null || mtime > latest) latest = mtime
    } catch (error) {
      if (isPermissionError(error)) return { status: 'unreadable' }
    }
  }
  if (shards.size === 0) return { status: 'not_found' }
  return {
    status: 'ok',
    shard_count: shards.size,
    shards: [...shards].sort(),
    latest_change_at: latest === null ? null : new Date(latest).toISOString(),
  }
}

/**
 * Locate the account's `db_storage` directory.
 * @param options - Resolved plugin options.
 * @returns the directory and how confident the discovery is.
 */
function discoverDatabaseDir(options) {
  try {
    if (options.wechatDbDir !== '') {
      return isDirectory(options.wechatDbDir)
        ? { status: 'ok', dir: options.wechatDbDir }
        : { status: 'not_found', dir: null }
    }
    if (!isDirectory(options.wechatDbParent)) return { status: 'not_found', dir: null }
    const candidates = readdirSync(options.wechatDbParent)
      .map((name) => join(options.wechatDbParent, name, 'db_storage'))
      .filter(isDirectory)
      .sort()
    if (candidates.length === 1) return { status: 'ok', dir: candidates[0] }
    if (candidates.length === 0) return { status: 'not_found', dir: null }
    return { status: 'ambiguous', dir: null }
  } catch (error) {
    if (isPermissionError(error)) return { status: 'unreadable', dir: null }
    return { status: 'not_found', dir: null }
  }
}

/**
 * Report the exporter's key file by its field names only.
 *
 * The coverage question — do the keys cover the shards that exist — is what the
 * user needs to answer; the key material itself is never read into this result.
 *
 * @param options - Resolved plugin options.
 * @returns the section.
 */
function keysSection(options) {
  if (options.keysFile === '') {
    return { status: 'unconfigured', file_updated_at: null, message_keys: [], contact_key: false, session_key: false }
  }
  let text
  let updated = null
  try {
    text = readFileSync(options.keysFile, 'utf8')
    updated = new Date(statSync(options.keysFile).mtimeMs).toISOString()
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', file_updated_at: null, message_keys: [], contact_key: false, session_key: false }
    if (isPermissionError(error)) return { status: 'unreadable', file_updated_at: null, message_keys: [], contact_key: false, session_key: false }
    return { status: 'unreadable', file_updated_at: null, message_keys: [], contact_key: false, session_key: false }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { status: 'invalid', file_updated_at: updated, message_keys: [], contact_key: false, session_key: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', file_updated_at: updated, message_keys: [], contact_key: false, session_key: false }
  }
  const names = Object.keys(parsed)
  return {
    status: 'ok',
    file_updated_at: updated,
    message_keys: [...new Set(names.filter((name) => MESSAGE_KEY_RE.test(name)))].sort(),
    contact_key: names.includes('contact'),
    session_key: names.includes('session'),
  }
}

/**
 * Find the newest complete batch the exporter wrote.
 * @param options - Resolved plugin options.
 * @param clock - The zone-bound clock.
 * @returns the section.
 */
function exportSection(options, clock) {
  const section = {
    status: 'not_found',
    batch: null,
    export_time: null,
    timezone_assumed: false,
    shards_processed: [],
    chat_count: null,
    total_messages: null,
    invalid_batches: 0,
    text_only_batches: 0,
  }
  if (options.exportDir === '') return { ...section, status: 'unconfigured' }
  const candidates = []
  let entries
  try {
    entries = readdirSync(options.exportDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return section
    return { ...section, status: 'unreadable' }
  }
  const consider = (dir, batch) => {
    const summary = readExportSummary(dir, clock)
    if (!summary.ok) {
      if (summary.reason !== 'incomplete') section.invalid_batches += 1
      return
    }
    // `--format text` leaves no JSONL behind: the directory is complete, and
    // holds nothing this importer can read. It is counted apart from a broken
    // batch and never becomes the export the status page points at.
    if (summary.jsonlFiles === 0) {
      section.text_only_batches += 1
      return
    }
    candidates.push({ batch, summary, instant: summary.exportInstant ?? 0 })
  }
  consider(options.exportDir, null)
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    consider(join(options.exportDir, entry.name), entry.name)
  }
  if (candidates.length === 0) return section
  candidates.sort((left, right) => {
    if (right.instant !== left.instant) return right.instant - left.instant
    return (left.batch ?? '') < (right.batch ?? '') ? 1 : -1
  })
  const newest = candidates[0]
  const meta = newest.summary.meta
  return {
    status: 'ok',
    batch: newest.batch,
    export_time: clock.instantOf(meta.export_time) === null ? null : new Date(clock.instantOf(meta.export_time)).toISOString(),
    timezone_assumed: newest.summary.zoneAssumed,
    shards_processed: meta.shards_processed.filter((name) => SHARD_NAME_RE.test(name)).sort(),
    chat_count: meta.chat_count,
    total_messages: meta.total_messages,
    invalid_batches: section.invalid_batches,
    text_only_batches: section.text_only_batches,
  }
}

/**
 * Summarize the archive: what is waiting, what is in, and what could not be read.
 * @param batches - Rows from the importer's listing.
 * @returns the section.
 */
function batchSection(batches) {
  const pending = batches.filter((row) => row.state === 'pending').map((row) => row.batch)
  const imported = batches.filter((row) => row.state === 'imported' || row.state === 'partial').map((row) => row.batch)
  const invalid = batches
    .filter((row) => row.state === 'invalid' || row.state === 'unreadable')
    .map((row) => ({ batch: row.batch, reason: row.invalid }))
  let status = 'empty'
  if (invalid.length > 0 && pending.length === 0) status = 'invalid'
  else if (pending.length > 0) status = 'pending'
  else if (imported.length > 0) status = 'ok'
  return { status, pending, imported, invalid, total: batches.length }
}

/**
 * Summarize the last import attempt.
 * @param store - The open corpus.
 * @param database - The database section, for the newer-than-import comparison.
 * @returns the section.
 */
function importState(store, database) {
  const latest = store.latestImport()
  const lastError = store.meta('last_error_code') ?? ''
  const section = {
    status: latest === undefined ? 'none' : 'ok',
    last_success_at: latest?.imported_at ?? store.meta('last_import_at') ?? null,
    batch: latest?.import_id ?? null,
    imported_at: latest?.imported_at ?? null,
    export_time: latest?.export_time ?? null,
    messages: latest === undefined ? null : Number(latest.total_messages) - Number(latest.group_skipped),
    generated: latest?.generated ?? null,
    updated: latest?.updated ?? null,
    unchanged: latest?.unchanged ?? null,
    group_skipped: latest?.group_skipped ?? null,
    suspected_replacements: latest?.suspected_replacements ?? null,
    last_error_code: lastError === '' ? null : lastError,
    database_newer_than_import: false,
  }
  if (lastError !== '') section.status = 'failed'
  if (
    database.status === 'ok' &&
    typeof database.latest_change_at === 'string' &&
    typeof section.last_success_at === 'string'
  ) {
    section.database_newer_than_import = database.latest_change_at > section.last_success_at
  }
  return section
}

/**
 * Whether the exporter holds an export newer than the last successful import.
 *
 * The exporter's default output is the export directory itself, which has no
 * batch directory name; that export is compared by time alone rather than
 * skipped for lacking one.
 *
 * @param exporter - The export section.
 * @param importSection - The import section.
 * @returns whether the export has not been imported.
 */
function hasUnimportedExport(exporter, importSection) {
  if (exporter.status !== 'ok' || typeof exporter.export_time !== 'string') return false
  if (typeof importSection.last_success_at === 'string' && exporter.export_time <= importSection.last_success_at) {
    return false
  }
  if (exporter.batch === null) return true
  return typeof exporter.batch === 'string' && exporter.batch !== importSection.batch
}

/**
 * The signals a reader should act on; several can be present at once.
 * @param sections - Every section.
 * @returns the signal list.
 */
function deriveSignals({ database, keys, exporter, archive, importSection }) {
  const signals = []
  if (keys.status === 'missing') signals.push({ code: 'keys_missing' })
  else if (keys.status === 'invalid') signals.push({ code: 'keys_invalid' })
  else if (keys.status === 'unreadable') signals.push({ code: 'keys_unreadable' })
  if (importSection.status === 'failed') {
    signals.push({ code: 'import_failed', error: importSection.last_error_code })
  }
  if (archive.pending.length > 0) {
    signals.push({ code: 'unimported_batch', batches: archive.pending })
  }
  // An export the importer has never taken. It is invisible to the archive,
  // because importing `latest` reads the batch where the exporter left it.
  if (hasUnimportedExport(exporter, importSection)) {
    signals.push({ code: 'unimported_export', batch: exporter.batch })
  }
  if (archive.invalid.length > 0) {
    signals.push({ code: 'invalid_archive_batches', count: archive.invalid.length })
  }
  const databaseNewer =
    database.status === 'ok' &&
    exporter.status === 'ok' &&
    typeof database.latest_change_at === 'string' &&
    typeof exporter.export_time === 'string' &&
    database.latest_change_at > exporter.export_time
  if (databaseNewer) signals.push({ code: 'database_newer' })
  if (
    keys.status === 'ok' &&
    typeof keys.message_shards_total === 'number' &&
    keys.message_shards_covered !== keys.message_shards_total
  ) {
    signals.push({
      code: 'keys_incomplete',
      covered: keys.message_shards_covered,
      total: keys.message_shards_total,
    })
  }
  if (exporter.status === 'ok' && database.status === 'ok' && Array.isArray(database.shards)) {
    const discovered = new Set(database.shards)
    const processed = new Set(exporter.shards_processed)
    const covered = [...discovered].filter((name) => processed.has(name)).length
    if (covered < discovered.size) {
      signals.push({ code: 'export_shards_incomplete', covered, total: discovered.size })
    }
  }
  if (exporter.status === 'ok' && exporter.invalid_batches > 0) {
    signals.push({ code: 'invalid_export_batches', count: exporter.invalid_batches })
  }
  if (exporter.text_only_batches > 0) {
    signals.push({ code: 'text_only_export', count: exporter.text_only_batches })
  }
  return signals
}

/**
 * The one status a reader sees first, in yorha's order of precedence.
 * @param sections - Every section.
 * @returns the status name.
 */
function deriveStatus({ database, keys, exporter, archive, importSection }) {
  if (keys.status === 'missing' || keys.status === 'invalid' || importSection.status === 'failed') {
    return 'action_required'
  }
  if (archive.pending.length > 0) return 'import_pending'
  if (hasUnimportedExport(exporter, importSection)) return 'import_pending'
  if (importSection.database_newer_than_import) return 'updates_available'
  if (
    keys.status === 'ok' &&
    typeof keys.message_shards_total === 'number' &&
    keys.message_shards_covered !== keys.message_shards_total
  ) {
    return 'notice'
  }
  if (exporter.text_only_batches > 0) return 'notice'
  if (keys.status === 'unreadable' || database.status === 'ambiguous' || database.status === 'unreadable') {
    return 'unreadable'
  }
  if (database.status === 'not_found' && exporter.status !== 'ok' && archive.total === 0) return 'empty'
  return 'ok'
}

/**
 * Count how many of the machine's shards the key file covers.
 * @param keys - The keys section.
 * @param database - The database section.
 * @returns nothing; the counts are written onto the keys section.
 */
export function annotateKeyCoverage(keys, database) {
  if (keys.status !== 'ok' || database.status !== 'ok' || !Array.isArray(database.shards)) return
  const covered = database.shards.filter((name) => keys.message_keys.includes(name.replace(/\.db$/, '')))
  keys.message_shards_total = database.shards.length
  keys.message_shards_covered = covered.length
}

/**
 * Whether a path is a directory.
 * @param path - Path to test.
 * @returns true when it is a directory this process can see.
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether a filesystem failure was a permission problem.
 * @param error - The thrown value.
 * @returns true for the permission codes.
 */
function isPermissionError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM'
}

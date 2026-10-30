/**
 * Batch reading, validation, and identity: the port of yorha's
 * `connectors/wechat/parser.py`.
 *
 * A batch is a directory the exporter wrote: `export_meta.json` at its root, one
 * JSONL file per conversation, and — for group chats exported with images — a
 * directory per conversation holding `images/` and its caches. Everything here
 * is read-only, and every failure names the file and line that caused it.
 *
 * Two passes share this module. {@link parseBatch} walks the batch once, calling
 * a collector per storable message; the importer calls it first with a collector
 * that only counts and stages, then again with one that writes. Nothing is held
 * between the passes, so a large full-history batch never has to
 * fit in memory.
 *
 * @module dsh-wechat/src/parser
 */

import { createReadStream, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

import { fail } from './errors.js'
import {
  contentHash,
  fallbackBase,
  fallbackSourceId,
  localSourceId,
  sha256Hex,
  sourceFilesHash,
} from './hash.js'
import { LocalClock } from './time.js'

/** The corpus this plugin imports into. */
export const SOURCE = 'wechat'

/** Batch names: yorha's rule, kept so old batch directories stay importable. */
const IMPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Record fields every exporter version has written. */
const REQUIRED_RECORD_FIELDS = [
  'timestamp',
  'datetime',
  'chat_id',
  'chat_name',
  'msg_type',
  'msg_type_label',
  'is_group',
  'real_sender_id',
  'is_self',
  'direction',
  'sender_id',
  'sender_name',
  'content',
]

/** Directions the exporter emits. */
const DIRECTIONS = new Set(['inbound', 'outbound', 'system', 'unknown'])

/** Keys `export_meta.json` must carry. */
const REQUIRED_META_FIELDS = [
  'export_time',
  'time_range',
  'shards_processed',
  'total_messages',
  'total_text_messages',
  'chat_count',
  'chats_exported',
  'self_sender_id',
  'per_chat_files',
]

/** Longest instant a JavaScript date can represent, in milliseconds. */
const MAX_DATE_MS = 8.64e15

/**
 * Reject a batch name that could escape its directory or that the status probe
 * could not list back.
 * @param importId - Candidate batch name.
 * @throws when the name is not a single safe path segment.
 */
export function validateImportId(importId) {
  if (typeof importId !== 'string' || !IMPORT_ID_RE.test(importId)) {
    fail('unsupported_batch_name', 'a batch name may hold only letters, digits, dots, underscores, and hyphens (1-128 characters)')
  }
  if (importId === '.' || importId === '..') {
    fail('unsupported_batch_name', 'a batch name cannot be a path special entry')
  }
}

/**
 * A batch name derived from an export instant, for a source directory whose own
 * name is not usable as one (a Chinese conversation directory, for instance).
 * @param clock - The zone-bound clock.
 * @param millis - Export instant in milliseconds.
 * @returns a name matching the batch rule.
 */
export function deriveImportId(clock, millis) {
  return `wechat-${clock.wallOf(millis).replace(/[-:]/g, '').replace('T', '-')}`
}

/**
 * Count the conversation files directly inside a batch directory.
 *
 * A run without `--format jsonl` writes the human-readable text and then deletes
 * the JSONL, which leaves a directory whose meta file looks complete and which
 * this importer can read nothing from.
 *
 * @param dir - Batch directory.
 * @returns how many `*.jsonl` regular files it holds.
 */
function countJsonl(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).length
  } catch {
    return 0
  }
}

/**
 * Read one batch's `export_meta.json` without walking the rest of it.
 *
 * This is the cheap check the batch list uses: a batch is complete exactly when
 * the exporter has written its meta file, which it writes last.
 *
 * @param root - Batch directory.
 * @param clock - The zone-bound clock.
 * @returns the parsed summary, or a description of why it is unusable.
 */
export function readExportSummary(root, clock) {
  let text
  try {
    text = readFileSync(join(root, 'export_meta.json'), 'utf8')
  } catch (error) {
    return { ok: false, reason: error.code === 'ENOENT' ? 'incomplete' : 'unreadable', message: error.message }
  }
  let meta
  try {
    meta = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: 'invalid', message: `export_meta.json is not valid JSON: ${error.message}` }
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { ok: false, reason: 'invalid', message: 'export_meta.json must be a JSON object' }
  }
  try {
    validateExportMeta(meta, clock)
  } catch (error) {
    return { ok: false, reason: 'invalid', message: error.message }
  }
  const instant = clock.instantOf(meta.export_time)
  return {
    ok: true,
    meta,
    exportTime: meta.export_time,
    exportInstant: instant,
    jsonlFiles: countJsonl(root),
    zoneAssumed: meta.export_time !== null && !/(Z|[+-]\d{2}:?\d{2})$/.test(meta.export_time),
    totalMessages: meta.total_messages,
    chatCount: meta.chat_count,
  }
}

/**
 * Validate `export_meta.json` against the exporter's own contract.
 * @param meta - Parsed meta object.
 * @param clock - The zone-bound clock, used to check the times.
 * @throws when a required field is missing or has the wrong type.
 */
export function validateExportMeta(meta, clock) {
  const missing = REQUIRED_META_FIELDS.filter((field) => !(field in meta))
  if (missing.length > 0) throw new Error(`export_meta is missing fields: ${missing.join(', ')}`)
  if (typeof meta.export_time !== 'string' || meta.export_time === '') {
    throw new Error('export_meta.export_time must be a non-empty string')
  }
  if (clock.instantOf(meta.export_time) === null) {
    throw new Error(`export_meta.export_time is not an ISO time: ${meta.export_time}`)
  }
  const range = meta.time_range
  if (typeof range !== 'object' || range === null || Array.isArray(range) || !('start' in range) || !('end' in range)) {
    throw new Error('export_meta.time_range must carry start and end')
  }
  for (const name of ['start', 'end']) {
    const value = range[name]
    if (value === null || value === undefined) continue
    if (typeof value !== 'string') throw new Error(`export_meta.time_range.${name} must be a string or null`)
    if (value !== '' && clock.instantOf(value) === null) {
      throw new Error(`export_meta.time_range.${name} is not an ISO time: ${value}`)
    }
  }
  for (const name of ['total_messages', 'total_text_messages', 'chat_count']) {
    const value = meta[name]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`export_meta.${name} must be a non-negative whole number`)
    }
  }
  for (const name of ['shards_processed', 'chats_exported']) {
    const value = meta[name]
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`export_meta.${name} must be an array of strings`)
    }
  }
  if (typeof meta.per_chat_files !== 'boolean') {
    throw new Error('export_meta.per_chat_files must be a boolean')
  }
}

/**
 * Every regular file below a batch root, hashed.
 *
 * A symlink is refused rather than followed: a batch is a directory someone
 * copied onto this machine, and following one would let it read files outside
 * itself. The digest of this list is the batch's identity, which is what makes
 * reusing a batch name for different content a loud failure instead of a silent
 * mixture.
 *
 * @param root - Batch directory.
 * @returns the files in path order, plus their total size and digest.
 */
export function readSourceFiles(root) {
  let rootStat
  try {
    rootStat = lstatSync(root)
  } catch {
    fail('batch_not_found', `the batch directory does not exist: ${root}`)
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail('batch_invalid', `a batch must be a plain directory: ${root}`)
  }
  const files = []
  walk(root, '', files)
  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1))
  if (files.length === 0) fail('batch_invalid', 'the batch directory is empty')
  let bytes = 0
  for (const file of files) bytes += file.size
  return { files, bytes, digest: sourceFilesHash(files) }
}

/**
 * Walk one directory level, refusing anything that is not a regular file or a
 * directory.
 * @param root - Batch root, for the relative path.
 * @param relative - Current directory relative to the root.
 * @param files - Accumulator.
 */
function walk(root, relative, files) {
  const directory = relative === '' ? root : join(root, relative)
  const entries = readdirSync(directory, { withFileTypes: true })
  entries.sort((left, right) => (left.name < right.name ? -1 : 1))
  for (const entry of entries) {
    const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) fail('batch_invalid', `a batch must not contain symbolic links: ${childRelative}`)
    if (entry.isDirectory()) {
      walk(root, childRelative, files)
      continue
    }
    if (!entry.isFile()) fail('batch_invalid', `a batch must not contain special files: ${childRelative}`)
    const absolutePath = join(root, childRelative)
    const stat = lstatSync(absolutePath)
    files.push({
      relativePath: childRelative,
      absolutePath,
      size: stat.size,
      sha256: sha256Hex(readFileSync(absolutePath)),
    })
  }
}

/**
 * Parse a batch, calling a collector once per storable message.
 *
 * @param options - Parse options.
 * @param options.root - Batch directory.
 * @param options.importId - Batch name.
 * @param options.clock - The zone-bound clock.
 * @param options.includeGroups - Whether group messages are collected too.
 *   Group messages are always parsed and always counted; skipping only decides
 *   whether the collector sees them, exactly as the yorha importer worked.
 * @param options.files - An already-read file list, to avoid hashing twice.
 * @param options.onRecord - Called for each collected message; may be async.
 * @param options.onProgress - Called with `{phase, processed, total}` as lines are read.
 * @returns the batch summary, including what the counts were checked against.
 * @throws a coded {@link import('./errors.js').WechatError} when the batch is unusable.
 */
export async function parseBatch({
  root,
  importId,
  clock,
  includeGroups,
  files: knownFiles,
  onRecord,
  onProgress,
}) {
  validateImportId(importId)
  const inventory = knownFiles === undefined ? readSourceFiles(root) : { files: knownFiles }
  const byPath = new Map(inventory.files.map((file) => [file.relativePath, file]))
  const metaFile = byPath.get('export_meta.json')
  if (metaFile === undefined) fail('batch_invalid', 'the batch root has no export_meta.json')
  let exportMeta
  try {
    exportMeta = JSON.parse(readFileSync(metaFile.absolutePath, 'utf8'))
  } catch (error) {
    fail('batch_invalid', `export_meta.json is not valid UTF-8 JSON: ${error.message}`)
  }
  try {
    validateExportMeta(exportMeta, clock)
  } catch (error) {
    fail('batch_invalid', error.message)
  }

  const jsonlFiles = inventory.files.filter((file) => file.relativePath.toLowerCase().endsWith('.jsonl'))
  if (jsonlFiles.length === 0) fail('batch_invalid', 'the batch has no JSONL conversation files')

  const state = {
    records: 0,
    collected: 0,
    groupRecords: 0,
    collisions: 0,
    chatIds: new Set(),
    chatFiles: new Map(),
  }
  for (const file of jsonlFiles) {
    await parseJsonlFile({ file, byPath, importId, clock, includeGroups, onRecord, onProgress, state })
  }

  if (state.records !== exportMeta.total_messages) {
    fail(
      'batch_invalid',
      `the JSONL message count disagrees with export_meta.total_messages: ${state.records} != ${exportMeta.total_messages}`,
    )
  }
  if (state.chatIds.size !== exportMeta.chat_count) {
    fail(
      'batch_invalid',
      `the conversation count disagrees with export_meta.chat_count: ${state.chatIds.size} != ${exportMeta.chat_count}`,
    )
  }
  return {
    exportMeta,
    files: inventory.files,
    bytes: inventory.bytes ?? inventory.files.reduce((total, file) => total + file.size, 0),
    digest: sourceFilesHash(inventory.files),
    records: state.records,
    collected: state.collected,
    groupRecords: state.groupRecords,
    skipped: state.records - state.collected,
    collisions: state.collisions,
    chatIds: [...state.chatIds],
    exportInstant: clock.instantOf(exportMeta.export_time),
    zoneAssumed: !/(Z|[+-]\d{2}:?\d{2})$/.test(exportMeta.export_time),
  }
}

/**
 * Parse one conversation file.
 *
 * The duplicate counter is per file, which is also per conversation: a repeated
 * fingerprint only ever collides inside the conversation it came from, so a
 * full-history batch holds one conversation's fingerprints at a time instead of
 * every batch's.
 *
 * @param options - File parse options.
 * @param options.file - The JSONL source file.
 * @param options.byPath - Every file in the batch, for media resolution.
 * @param options.importId - Batch name.
 * @param options.clock - The zone-bound clock.
 * @param options.includeGroups - Whether group messages are collected.
 * @param options.onRecord - Collector.
 * @param options.onProgress - Progress callback.
 * @param options.state - Running counters.
 */
async function parseJsonlFile({ file, byPath, importId, clock, includeGroups, onRecord, onProgress, state }) {
  const duplicates = new Map()
  let fileChatId = null
  await forEachLine(file, async (line, lineNumber) => {
    if (line.trim() === '') return
    const context = `${file.relativePath}:${lineNumber}`
    let value
    try {
      value = JSON.parse(line)
    } catch (error) {
      fail('batch_invalid', `${context} is not valid JSON: ${error.message}`)
    }
    const record = validateRecord(value, context)
    if (fileChatId === null) {
      fileChatId = String(record.chat_id)
      const known = state.chatFiles.get(fileChatId)
      // A conversation is one JSONL file. Splitting it would restart the
      // per-file duplicate counter and give two messages the same source id,
      // which the store would then collapse without reporting a collision.
      if (known !== undefined && known !== file.relativePath) {
        fail(
          'batch_invalid',
          `${file.relativePath} repeats the chat_id of ${known}; a conversation must be one JSONL file`,
        )
      }
      state.chatFiles.set(fileChatId, file.relativePath)
    } else if (String(record.chat_id) !== fileChatId) {
      fail('batch_invalid', `${file.relativePath} mixes several chat_id values`)
    }
    state.records += 1
    state.chatIds.add(String(record.chat_id))
    if (record.is_group) state.groupRecords += 1
    if (record.is_group && !includeGroups) return

    const built = buildRecord({
      record,
      context,
      lineNumber,
      file,
      byPath,
      importId,
      clock,
      duplicates,
      state,
    })
    state.collected += 1
    await onRecord(built)
    if (onProgress !== undefined && state.records % 5000 === 0) {
      onProgress({ phase: 'validating', processed: state.records, total: null })
    }
  })
}

/**
 * Turn one exporter record into the stored message.
 *
 * @param options - Build options.
 * @param options.record - The validated exporter record.
 * @param options.context - `file:line`, for failure messages.
 * @param options.lineNumber - Line the record was read from.
 * @param options.file - The source file.
 * @param options.byPath - Every file in the batch.
 * @param options.importId - Batch name.
 * @param options.clock - The zone-bound clock.
 * @param options.duplicates - This conversation's fingerprint counters.
 * @param options.state - Running counters.
 * @returns the message as the corpus stores it.
 */
function buildRecord({ record, context, lineNumber, file, byPath, importId, clock, duplicates, state }) {
  const chatId = String(record.chat_id)
  let content = typeof record.content === 'string' ? record.content : ''
  content = appendEnrichment(content, 'OCR', record.ocr_text)
  content = appendEnrichment(content, '语音转录', record.voice_transcription)

  const media = []
  if (record.image_file !== undefined && record.image_file !== null) {
    const relative = imageRelativePath(file, record.image_file)
    const image = byPath.get(relative)
    if (image === undefined) fail('batch_invalid', `${context} refers to an image that is not in the batch: ${relative}`)
    media.push({ type: 'image', path: relative, sha256: image.sha256, size: image.size })
  }
  if (record.voice_meta !== undefined && record.voice_meta !== null) {
    media.push({ type: 'voice', metadata: record.voice_meta })
  }

  const recordContentHash = contentHash(content, media)
  const localId = record.local_id === undefined || record.local_id === null || record.local_id === '' ? null : record.local_id
  let sourceId
  let base = null
  let duplicateIndex = 0
  if (localId !== null) {
    sourceId = localSourceId(chatId, localId)
  } else {
    base = fallbackBase({
      chatId,
      timestamp: record.timestamp,
      senderId: record.sender_id,
      msgType: record.msg_type,
    })
    const counterKey = `${base}\u0000${recordContentHash}`
    duplicateIndex = duplicates.get(counterKey) ?? 0
    duplicates.set(counterKey, duplicateIndex + 1)
    if (duplicateIndex > 0) state.collisions += 1
    sourceId = fallbackSourceId(base, recordContentHash, duplicateIndex)
  }

  const millis = LocalClock.toMillis(record.timestamp)
  if (!Number.isFinite(millis) || Math.abs(millis) > MAX_DATE_MS) {
    fail('batch_invalid', `${context}.timestamp is outside the representable range`)
  }

  // Only what the typed columns on the same row do not already carry: where in
  // the export this record came from, the exporter's local id when it wrote
  // one, and the quote this message replies to. Repeating chat_id, msg_type,
  // direction and the rest here would store every message twice.
  const metadata = {
    source_file: file.relativePath,
    source_line: lineNumber,
  }
  if (localId !== null) metadata.local_id = localId
  for (const name of ['quote_sender_name', 'quote_sender_id', 'quote_content']) {
    if (name in record) metadata[name] = record[name]
  }

  return {
    sourceId,
    contentHash: recordContentHash,
    fallbackBase: base,
    duplicateIndex,
    importId,
    kind: record.msg_type_label,
    ts: LocalClock.isoOf(millis),
    tsUnix: record.timestamp,
    localDay: clock.dayOf(millis),
    chatId,
    chatName: record.chat_name,
    isGroup: record.is_group,
    msgType: record.msg_type,
    direction: record.direction,
    isSelf: record.is_self,
    realSenderId: record.real_sender_id,
    senderId: record.sender_id,
    senderName: record.sender_name,
    content,
    actors: actorsOf(record, chatId),
    media,
    metadata,
  }
}

/**
 * The parties of one message: its sender and its conversation.
 * @param record - The exporter record.
 * @param chatId - Conversation id.
 * @returns the actor list.
 */
function actorsOf(record, chatId) {
  const senderRole = record.is_self === true ? 'self' : record.direction === 'system' ? 'system' : 'sender'
  return [
    {
      id: record.sender_id === null || record.sender_id === undefined ? null : String(record.sender_id),
      name: record.sender_name ?? null,
      role: senderRole,
      direction: record.direction,
      real_sender_id: record.real_sender_id,
    },
    {
      id: chatId,
      name: record.chat_name,
      role: 'conversation',
      is_group: record.is_group,
    },
  ]
}

/**
 * Append an enrichment block to a message body, once.
 * @param content - Body so far.
 * @param label - Block label, such as `OCR`.
 * @param value - Enrichment text, when the exporter produced one.
 * @returns the body with the block appended, or unchanged.
 */
function appendEnrichment(content, label, value) {
  if (typeof value !== 'string' || value.trim() === '' || content.includes(value)) return content
  const suffix = `[${label}]\n${value.trim()}`
  return content.trim() === '' ? suffix : `${content.replace(/\s+$/, '')}\n\n${suffix}`
}

/**
 * Resolve an image reference to a path inside the batch.
 *
 * The exporter names images by message id inside `<conversation>/images/`, and
 * the yorha importer refused anything that looked like a path. Keeping that
 * check means a batch can never point the corpus at a file outside itself.
 *
 * @param file - The JSONL file the reference came from.
 * @param imageFile - The reference as written.
 * @returns the batch-relative path.
 * @throws when the reference is not a plain file name.
 */
function imageRelativePath(file, imageFile) {
  if (typeof imageFile !== 'string' || imageFile === '') {
    fail('batch_invalid', `${file.relativePath}.image_file must be a file name`)
  }
  if (imageFile.includes('/') || imageFile.includes('\\') || imageFile === '.' || imageFile === '..') {
    fail('batch_invalid', `${file.relativePath}.image_file must not contain a directory: ${imageFile}`)
  }
  const stem = file.relativePath.replace(/\.jsonl$/i, '')
  return `${stem}/images/${imageFile}`
}

/**
 * Validate one exporter record.
 * @param value - The parsed JSON line.
 * @param context - `file:line`, for failure messages.
 * @returns the record.
 * @throws when a required field is missing or mistyped.
 */
function validateRecord(value, context) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('batch_invalid', `${context} must be a JSON object`)
  }
  const missing = REQUIRED_RECORD_FIELDS.filter((field) => !(field in value))
  if (missing.length > 0) fail('batch_invalid', `${context} is missing fields: ${missing.join(', ')}`)
  if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) {
    fail('batch_invalid', `${context}.timestamp must be a Unix timestamp`)
  }
  for (const field of ['datetime', 'chat_id', 'chat_name', 'msg_type_label', 'direction']) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      fail('batch_invalid', `${context}.${field} must be a non-empty string`)
    }
  }
  if (!DIRECTIONS.has(value.direction)) fail('batch_invalid', `${context}.direction is not supported`)
  if (typeof value.is_group !== 'boolean') fail('batch_invalid', `${context}.is_group must be a boolean`)
  if (value.is_self !== null && typeof value.is_self !== 'boolean') {
    fail('batch_invalid', `${context}.is_self must be a boolean or null`)
  }
  if (value.content !== null && typeof value.content !== 'string') {
    fail('batch_invalid', `${context}.content must be a string or null`)
  }
  for (const field of ['sender_id', 'sender_name']) {
    if (value[field] !== null && typeof value[field] !== 'string' && typeof value[field] !== 'number') {
      fail('batch_invalid', `${context}.${field} has an unsupported type`)
    }
  }
  if (
    value.local_id !== undefined &&
    value.local_id !== null &&
    value.local_id !== '' &&
    typeof value.local_id !== 'string' &&
    typeof value.local_id !== 'number'
  ) {
    fail('batch_invalid', `${context}.local_id must be a string or a number`)
  }
  for (const field of ['ocr_text', 'voice_transcription']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') {
      fail('batch_invalid', `${context}.${field} must be a string or null`)
    }
  }
  if (value.voice_meta !== undefined && value.voice_meta !== null && typeof value.voice_meta !== 'object') {
    fail('batch_invalid', `${context}.voice_meta must be an object or null`)
  }
  return value
}

/**
 * Call a function for every line of a file, splitting on LF only.
 *
 * `String.prototype.split(/\r?\n/)` and `readline` both treat Unicode line
 * separators as line breaks; a JSON string may contain them legally, and
 * `json.dumps` writes them unescaped, so splitting on anything but LF would cut
 * a valid record in half. Invalid UTF-8 is a failure, not a replacement.
 *
 * @param file - Source file with `absolutePath` and `relativePath`.
 * @param onLine - Called with `(line, lineNumber)`, without its terminator.
 * @throws when the file is not valid UTF-8.
 */
export async function forEachLine(file, onLine) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let lineNumber = 0
  // A callback failure is a corpus write failure, not a malformed file. Keep
  // it out of the decoder's `batch_invalid` diagnosis.
  const invoke = async (line) => {
    try {
      await onLine(line, lineNumber)
    } catch (error) {
      if (error?.name === 'WechatError') throw error
      fail('db_unavailable', `storing ${file.relativePath} failed: ${error.message}`)
    }
  }
  try {
    for await (const chunk of createReadStream(file.absolutePath)) {
      pending += decoder.decode(chunk, { stream: true })
      let index = pending.indexOf('\n')
      while (index !== -1) {
        lineNumber += 1
        await invoke(pending.slice(0, index))
        pending = pending.slice(index + 1)
        index = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
  } catch (error) {
    if (error?.name === 'WechatError') throw error
    fail('batch_invalid', `${file.relativePath} is not valid UTF-8 JSONL: ${error.message}`)
  }
  if (pending !== '') {
    lineNumber += 1
    await invoke(pending)
  }
}

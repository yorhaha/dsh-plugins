/**
 * The durable Xiaohongshu corpus.
 *
 * A note is upserted by `note_id`; a later detail read fills in the body fields
 * a search card could not provide, while a later card read never erases the
 * body. The FTS index is maintained explicitly beside each note write because
 * the table is standalone: there is no trigger whose behaviour a future SQLite
 * version could change silently.
 *
 * @module dsh-xiaohongshu/src/store
 */

import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STATUS_INITIAL, STATUS_SINGLETON, applySchema } from './schema.js'
import { characterCount, segmentForIndex, toMatchExpression } from './text.js'

/**
 * Current instant as `YYYY-MM-DDTHH:MM:SSZ`.
 * @returns the instant.
 */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** An open corpus handle. Construct through {@link openStore}. */
export class XhsStore {
  #db
  #databasePath
  #mediaRoot

  /**
   * @param db - the opened database handle; this instance owns its lifecycle.
   * @param options - paths the page reports.
   */
  constructor(db, { databasePath, mediaRoot }) {
    this.#db = db
    this.#databasePath = databasePath
    this.#mediaRoot = mediaRoot
  }

  /** @returns the database file path. */
  get databasePath() {
    return this.#databasePath
  }

  /** @returns the directory downloaded images live under. */
  get mediaRoot() {
    return this.#mediaRoot
  }

  /**
   * Run a function in one transaction, rolling back on any throw.
   * @param fn - the work to run.
   * @returns the function's value.
   */
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        // The original error is the one worth reporting.
      }
      throw error
    }
  }

  /**
   * Re-index one note by rowid from its stored values.
   *
   * Indexing the stored row rather than the incoming value matters when a
   * search card follows a detail read: the card carries no body, and must not
   * erase the body indexed earlier.
   * @param rowid - the note's rowid.
   */
  #indexNote(rowid) {
    const row = this.#db
      .prepare('SELECT title, body, author_id, author_name, tags_json FROM notes WHERE rowid = ?')
      .get(rowid)
    const author = [row?.author_name, row?.author_id].filter(Boolean).join(' ')
    const tags = parseTags(row?.tags_json).join(' ')
    this.#db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(rowid)
    this.#db
      .prepare('INSERT INTO notes_fts (rowid, title, body, author, tags) VALUES (?, ?, ?, ?, ?)')
      .run(
        rowid,
        segmentForIndex(row?.title ?? ''),
        segmentForIndex(row?.body ?? ''),
        segmentForIndex(author),
        segmentForIndex(tags),
      )
  }

  /**
   * Insert or update one note and its FTS row.
   * @param note - a value from `mapping.js`.
   * @param meta - capture provenance.
   * @returns the stored rowid.
   */
  upsertNote(note, meta = {}) {
    const capturedAt = meta.capturedAt ?? nowIso()
    const updatedAt = nowIso()
    const tagsJson = JSON.stringify(Array.isArray(note.tags) ? note.tags : [])
    const author = note.author ?? {}
    this.#db
      .prepare(
        `INSERT INTO notes (
          note_id, type, title, body, author_id, author_name, author_avatar,
          tags_json, cover_url, video_url, published_at, captured_at, updated_at,
          liked_count, collected_count, comment_count, share_count, ip_location,
          xsec_token, xsec_source, url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(note_id) DO UPDATE SET
          type = excluded.type,
          title = COALESCE(excluded.title, notes.title),
          body = COALESCE(excluded.body, notes.body),
          author_id = COALESCE(excluded.author_id, notes.author_id),
          author_name = COALESCE(excluded.author_name, notes.author_name),
          author_avatar = COALESCE(excluded.author_avatar, notes.author_avatar),
          tags_json = CASE WHEN excluded.tags_json = '[]' THEN notes.tags_json ELSE excluded.tags_json END,
          cover_url = COALESCE(excluded.cover_url, notes.cover_url),
          video_url = COALESCE(excluded.video_url, notes.video_url),
          published_at = COALESCE(excluded.published_at, notes.published_at),
          updated_at = excluded.updated_at,
          liked_count = COALESCE(excluded.liked_count, notes.liked_count),
          collected_count = COALESCE(excluded.collected_count, notes.collected_count),
          comment_count = COALESCE(excluded.comment_count, notes.comment_count),
          share_count = COALESCE(excluded.share_count, notes.share_count),
          ip_location = COALESCE(excluded.ip_location, notes.ip_location),
          xsec_token = COALESCE(excluded.xsec_token, notes.xsec_token),
          xsec_source = COALESCE(excluded.xsec_source, notes.xsec_source),
          url = COALESCE(excluded.url, notes.url)`,
      )
      .run(
        note.note_id,
        note.type ?? 'normal',
        note.title ?? null,
        note.body ?? null,
        author.user_id ?? null,
        author.nickname ?? null,
        author.avatar_url ?? null,
        tagsJson,
        note.cover_url ?? null,
        note.video_url ?? null,
        note.published_at ?? null,
        capturedAt,
        updatedAt,
        note.liked_count ?? null,
        note.collected_count ?? null,
        note.comment_count ?? null,
        note.share_count ?? null,
        note.ip_location ?? null,
        note.xsec_token ?? null,
        note.xsec_source ?? null,
        note.url ?? null,
      )
    const row = this.#db.prepare('SELECT rowid FROM notes WHERE note_id = ?').get(note.note_id)
    this.#indexNote(row.rowid)
    return row.rowid
  }

  /**
   * Insert or update a batch of notes in one transaction.
   * @param notes - normalized notes.
   * @param meta - capture provenance.
   * @returns the number of notes written.
   */
  upsertNotes(notes, meta = {}) {
    return this.#transaction(() => {
      let written = 0
      for (const note of notes) {
        this.upsertNote(note, meta)
        written += 1
      }
      return written
    })
  }

  /**
   * Insert or update a note's comments.
   * @param noteId - owning note.
   * @param comments - normalized comments.
   * @param capturedAt - capture instant.
   * @returns the number written.
   */
  insertComments(noteId, comments, capturedAt = nowIso()) {
    return this.#transaction(() => {
      const statement = this.#db.prepare(
        `INSERT INTO comments (
          comment_id, note_id, parent_comment_id, author_id, author_name, author_avatar,
          content, like_count, created_at, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(comment_id) DO UPDATE SET
          content = excluded.content,
          like_count = COALESCE(excluded.like_count, comments.like_count),
          captured_at = excluded.captured_at`,
      )
      for (const comment of comments) {
        const author = comment.author ?? {}
        statement.run(
          comment.comment_id,
          noteId,
          comment.parent_comment_id ?? null,
          author.user_id ?? null,
          author.nickname ?? null,
          author.avatar_url ?? null,
          comment.content ?? '',
          comment.like_count ?? null,
          comment.created_at ?? null,
          capturedAt,
        )
      }
      return comments.length
    })
  }

  /**
   * Record that a run captured a note.
   * @param runId - capture run identifier.
   * @param noteId - note id.
   * @param source - `search` or `note`.
   * @param keyword - search keyword, when the source was a search.
   */
  recordCapture(runId, noteId, source, keyword) {
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO captures (run_id, note_id, source, keyword, captured_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(runId, noteId, source, keyword ?? null, nowIso())
  }

  /**
   * Record one downloaded image.
   * @param noteId - owning note.
   * @param position - zero-based image position.
   * @param image - URL, dimensions, local path, and byte size.
   */
  saveMedia(noteId, position, image) {
    this.#db
      .prepare(
        `INSERT INTO media (note_id, position, url, local_path, width, height, bytes, downloaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id, position) DO UPDATE SET
           url = excluded.url,
           local_path = COALESCE(excluded.local_path, media.local_path),
           width = COALESCE(excluded.width, media.width),
           height = COALESCE(excluded.height, media.height),
           bytes = COALESCE(excluded.bytes, media.bytes),
           downloaded_at = COALESCE(excluded.downloaded_at, media.downloaded_at)`,
      )
      .run(
        noteId,
        position,
        image.url,
        image.local_path ?? null,
        image.width ?? null,
        image.height ?? null,
        image.bytes ?? null,
        image.local_path ? nowIso() : null,
      )
  }

  /**
   * Read one note with its comments and media rows.
   * @param noteId - note id.
   * @returns the row bundle, or null.
   */
  getNote(noteId) {
    const row = this.#db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId)
    if (row === undefined) return null
    const comments = this.#db
      .prepare('SELECT * FROM comments WHERE note_id = ? ORDER BY like_count DESC, rowid ASC')
      .all(noteId)
    const media = this.#db.prepare('SELECT * FROM media WHERE note_id = ? ORDER BY position ASC').all(noteId)
    return { ...row, tags: parseTags(row.tags_json), comments, media }
  }

  /**
   * Number of rows in the full-text index; used by tests and the page's
   * integrity check.
   * @returns the count.
   */
  ftsCount() {
    return this.#db.prepare('SELECT COUNT(*) AS count FROM notes_fts').get().count
  }

  /**
   * Search the corpus.
   *
   * A query uses the FTS5 index and returns a snippet; an empty query walks the
   * notes table in capture order, which is what the page's browse view needs.
   *
   * @param options - query, time bounds, author filter, limit and offset.
   * @returns the total and the matching notes.
   */
  searchNotes({ query, since, until, author, limit, offset }) {
    const where = []
    const params = []
    let from = 'FROM notes i'
    const expression = typeof query === 'string' ? toMatchExpression(query) : null
    if (expression !== null) {
      from = 'FROM notes_fts f JOIN notes i ON i.rowid = f.rowid'
      where.push('notes_fts MATCH ?')
      params.push(expression)
    }
    if (typeof since === 'string' && since !== '') {
      where.push('i.published_at IS NOT NULL AND i.published_at >= ?')
      params.push(since)
    }
    if (typeof until === 'string' && until !== '') {
      where.push('i.published_at IS NOT NULL AND i.published_at < ?')
      params.push(until)
    }
    if (typeof author === 'string' && author !== '') {
      where.push('(i.author_id = ? OR i.author_name LIKE ?)')
      params.push(author, `%${author}%`)
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    const total = this.#db.prepare(`SELECT COUNT(*) AS total ${from}${clause}`).get(...params).total
    const snippet = expression !== null ? "snippet(notes_fts, 1, '‹', '›', '…', 20) AS snippet, " : ''
    const rows = this.#db
      .prepare(
        `SELECT ${snippet}i.* ${from}${clause} ORDER BY i.published_at DESC, i.captured_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
    return { total, notes: rows.map(noteSummary) }
  }

  /**
   * Corpus counts and file size for the plugin page.
   * @returns the statistics.
   */
  stats() {
    const notes = this.#db.prepare('SELECT COUNT(*) AS count FROM notes').get().count
    const comments = this.#db.prepare('SELECT COUNT(*) AS count FROM comments').get().count
    const media = this.#db.prepare('SELECT COUNT(*) AS count FROM media WHERE local_path IS NOT NULL').get().count
    const status = this.getStatus()
    let bytes = 0
    try {
      bytes = statSync(this.#databasePath).size
    } catch {
      bytes = 0
    }
    return {
      note_count: notes,
      comment_count: comments,
      media_count: media,
      database_bytes: bytes,
      database_path: this.#databasePath,
      last_capture_at: status.last_capture_at,
    }
  }

  /** @returns the status row with camelCase fields. */
  getStatus() {
    const row = this.#db
      .prepare('SELECT last_capture_at, last_error_code, auth_required, note_count FROM status WHERE singleton = 1')
      .get()
    return {
      last_capture_at: row?.last_capture_at ?? STATUS_INITIAL.last_capture_at,
      last_error_code: row?.last_error_code ?? STATUS_INITIAL.last_error_code,
      auth_required: row?.auth_required === 1,
      note_count: row?.note_count ?? STATUS_INITIAL.note_count,
    }
  }

  /**
   * Merge a status patch into the singleton row.
   * @param patch - fields to change.
   */
  updateStatus(patch) {
    const current = this.getStatus()
    const next = {
      last_capture_at: patch.last_capture_at ?? current.last_capture_at,
      last_error_code: patch.last_error_code === undefined ? current.last_error_code : patch.last_error_code,
      auth_required: patch.auth_required === undefined ? current.auth_required : patch.auth_required,
      note_count: patch.note_count ?? current.note_count,
    }
    this.#db
      .prepare(
        'UPDATE status SET last_capture_at = ?, last_error_code = ?, auth_required = ?, note_count = ? WHERE singleton = 1',
      )
      .run(next.last_capture_at, next.last_error_code, next.auth_required ? 1 : 0, next.note_count)
  }

  /**
   * Append one request to the audit log.
   * @param entry - endpoint, status, closed code, and a short detail.
   */
  logRequest(entry) {
    this.#db
      .prepare('INSERT INTO request_log (ts, endpoint, status, code, detail) VALUES (?, ?, ?, ?, ?)')
      .run(nowIso(), entry.endpoint, entry.status ?? null, entry.code ?? null, entry.detail ?? null)
    this.#db.prepare("DELETE FROM request_log WHERE datetime(ts) < datetime('now', '-30 days')").run()
  }

  /** Delete every note, comment, media row, and capture record. */
  clear() {
    this.#transaction(() => {
      this.#db.exec('DELETE FROM notes_fts')
      this.#db.exec('DELETE FROM captures')
      this.#db.exec('DELETE FROM media')
      this.#db.exec('DELETE FROM comments')
      this.#db.exec('DELETE FROM notes')
      this.#db.exec('DELETE FROM request_log')
      this.#db
        .prepare('UPDATE status SET last_capture_at = NULL, last_error_code = NULL, auth_required = 0, note_count = 0 WHERE singleton = 1')
        .run()
    })
  }

  /** Close the database handle. */
  close() {
    this.#db.close()
  }
}

/**
 * Read a stored note row into the search-result shape.
 * @param row - a `notes` row.
 * @returns the summary.
 */
function noteSummary(row) {
  return {
    note_id: row.note_id,
    type: row.type,
    title: row.title,
    author_id: row.author_id,
    author_name: row.author_name,
    author_avatar: row.author_avatar,
    tags: parseTags(row.tags_json),
    cover_url: row.cover_url,
    published_at: row.published_at,
    captured_at: row.captured_at,
    liked_count: row.liked_count,
    collected_count: row.collected_count,
    comment_count: row.comment_count,
    share_count: row.share_count,
    url: row.url,
    snippet: typeof row.snippet === 'string' ? row.snippet : null,
    content_chars: characterCount(row.body ?? ''),
  }
}

/**
 * Parse a stored tags JSON column.
 * @param value - JSON text.
 * @returns the tags, or an empty list.
 */
function parseTags(value) {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === 'string') : []
  } catch {
    return []
  }
}

/**
 * Open the corpus, creating its directory and file on first use.
 * @param options - database path, media root, and logger.
 * @returns the open store.
 */
export async function openStore({ databasePath, mediaRoot, logger }) {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  mkdirSync(mediaRoot, { recursive: true, mode: 0o700 })
  const fd = openSync(databasePath, 'a', 0o600)
  closeSync(fd)
  try {
    chmodSync(databasePath, 0o600)
  } catch (error) {
    logger?.warn?.(`xiaohongshu: tightening the corpus file mode failed: ${String(error)}`)
  }
  const { DatabaseSync } = await import('node:sqlite')
  let db
  try {
    db = new DatabaseSync(databasePath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    applySchema(db)
  } catch (error) {
    if (db !== undefined) {
      try {
        db.close()
      } catch {
        // Nothing else to do; the open failure is the reportable one.
      }
    }
    throw error
  }
  return new XhsStore(db, { databasePath, mediaRoot })
}

/**
 * Default corpus path under the Harness home.
 * @param dshHome - the Harness home directory.
 * @returns the database path and media root.
 */
export function defaultPaths(dshHome) {
  const root = join(dshHome, 'storages', 'xiaohongshu')
  return { databasePath: join(root, 'xhs.db'), mediaRoot: join(root, 'media') }
}

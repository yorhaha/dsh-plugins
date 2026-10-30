/**
 * The local corpus: an open SQLite database, its statements, and the queries
 * the tools run against it.
 *
 * Everything here is synchronous once the database is open — `node:sqlite` has
 * no asynchronous surface — so a network capture collects its records first and
 * then commits them inside one transaction. That is what makes the corpus and
 * its cursor advance together: a crash between the two cannot happen, and a
 * failed commit leaves both where they were.
 *
 * The module is loaded on first use rather than at plugin load, because
 * importing `node:sqlite` prints an experimental warning that a Host which
 * never touches this corpus should not have to carry.
 *
 * @module dsh-outlook/src/store
 */

import { chmod, mkdir, open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MAIL_STATE_SINGLETON, STATUS_INITIAL, STATUS_SINGLETON, applySchema } from './schema.js'
import { actorText, segmentForIndex, sha256Hex, snippetAround, toMatchExpression, truncateBytes } from './text.js'

/** How old the newest successful capture may be before the corpus is stale. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** Characters of a query of one or two letters that a snippet is centred on. */
const SNIPPET_CHARACTERS = 200

/**
 * Open the corpus, creating its directory and schema when they are absent.
 * @param options - Open options.
 * @param options.path - Absolute path of the SQLite file.
 * @param options.clock - Current instant in milliseconds.
 * @param options.logger - Plugin logger, for a compaction that could not run.
 * @returns the open store.
 */
export async function openStore({ path, clock = Date.now, logger }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // The corpus holds mail bodies. SQLite would create it with the process
  // umask; create it owner-only first, as session storage does.
  const created = await open(path, 'a', 0o600)
  await created.close()
  // The mode above only applies to a file this process created. A corpus that
  // already existed keeps whatever mode it had, so tighten it explicitly; the
  // WAL and shared-memory files SQLite creates then inherit this one.
  try {
    await chmod(path, 0o600)
  } catch (chmodError) {
    logger?.warn?.(`outlook: tightening the corpus file mode failed: ${String(chmodError)}`)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    const { migrated } = applySchema(db)
    if (migrated) {
      // The table rebuild leaves the old pages behind. Compact once, here, so the
      // corpus actually shrinks instead of carrying the replaced rows forever.
      try {
        db.exec('VACUUM')
        // See the same step in dsh-wechat: a WAL-mode VACUUM leaves the rewritten
        // pages in the log, so truncate it or the corpus stays doubled on disk.
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch (vacuumError) {
        logger?.warn?.(`outlook: compacting a migrated corpus failed: ${String(vacuumError)}`)
      }
    }
  } catch (error) {
    db.close()
    throw error
  }
  return new Store({ db, path, clock })
}

/** One open corpus. */
class Store {
  #db
  #path
  #clock
  #marker = null
  #closed = false

  /**
   * @param options - Open handles.
   * @param options.db - The open database.
   * @param options.path - Path the database was opened from.
   * @param options.clock - Current instant in milliseconds.
   */
  constructor({ db, path, clock }) {
    this.#db = db
    this.#path = path
    this.#clock = clock
    this.#db
      .prepare(
        `INSERT INTO status (singleton, last_run_at, last_run_status, last_error_code, auth_required, retry_not_before)
         VALUES (?, NULL, NULL, NULL, 0, NULL)
         ON CONFLICT(singleton) DO NOTHING`,
      )
      .run(STATUS_SINGLETON)
    this.#db
      .prepare('INSERT INTO mail_state (singleton) VALUES (?) ON CONFLICT(singleton) DO NOTHING')
      .run(MAIL_STATE_SINGLETON)
  }

  /** Path of the SQLite file backing this corpus. */
  get path() {
    return this.#path
  }

  /**
   * Current instant as ISO-8601 UTC, the format every stored instant uses.
   *
   * Successive calls are strictly increasing even within one millisecond: a
   * capture marker is what tells a later run which rows it did not see, so two
   * commits in the same tick must still order.
   * @returns the marker for this commit.
   */
  now() {
    const raw = new Date(this.#clock()).toISOString()
    this.#marker = this.#marker !== null && raw <= this.#marker
      ? new Date(Date.parse(this.#marker) + 1).toISOString()
      : raw
    return this.#marker
  }

  /**
   * Platform-level sync state.
   * @returns the status row.
   */
  status() {
    const row = this.#db.prepare('SELECT * FROM status WHERE singleton = ?').get(STATUS_SINGLETON)
    if (row === undefined) return { ...STATUS_INITIAL }
    return {
      lastRunAt: row.last_run_at ?? null,
      lastRunStatus: row.last_run_status ?? null,
      lastErrorCode: row.last_error_code ?? null,
      authRequired: row.auth_required === 1,
      retryNotBefore: row.retry_not_before ?? null,
    }
  }

  /**
   * Merge fields into the status row.
   * @param patch - Fields to write; absent fields keep their stored value.
   * @returns resolution after the write is durable.
   */
  async updateStatus(patch) {
    const next = { ...this.status(), ...patch }
    this.#db
      .prepare(
        `UPDATE status SET last_run_at = ?, last_run_status = ?, last_error_code = ?, auth_required = ?, retry_not_before = ?
         WHERE singleton = ?`,
      )
      .run(
        next.lastRunAt ?? null,
        next.lastRunStatus ?? null,
        next.lastErrorCode ?? null,
        next.authRequired === true ? 1 : 0,
        next.retryNotBefore ?? null,
        STATUS_SINGLETON,
      )
  }

  /**
   * Resumption state the mail fetcher owns, plus its last outcome.
   * @returns the cursor row; empty state and null success before the first capture.
   */
  mailState() {
    const row = this.#db.prepare('SELECT * FROM mail_state WHERE singleton = ?').get(MAIL_STATE_SINGLETON)
    if (row === undefined) return undefined
    return {
      state: JSON.parse(row.state),
      lastSuccessAt: row.last_success_at ?? null,
      lastErrorCode: row.last_error_code ?? null,
      itemCount: Number(row.item_count),
      snapshotComplete: row.snapshot_complete === null || row.snapshot_complete === undefined
        ? null
        : row.snapshot_complete === 1,
    }
  }

  /**
   * Record a capture that produced no commit, so the failure is visible and the
   * previous position is kept.
   * @param outcome - The cursor fields to store.
   * @returns resolution after the write is durable.
   */
  async writeMailState(outcome) {
    this.#db
      .prepare(
        `UPDATE mail_state SET state = ?, last_success_at = ?, last_error_code = ?, item_count = ?, snapshot_complete = ?
         WHERE singleton = ?`,
      )
      .run(
        JSON.stringify(outcome.state ?? {}),
        outcome.lastSuccessAt ?? null,
        outcome.lastErrorCode ?? null,
        Number.isInteger(outcome.itemCount) ? outcome.itemCount : 0,
        outcome.snapshotComplete === null || outcome.snapshotComplete === undefined
          ? null
          : outcome.snapshotComplete === true ? 1 : 0,
        MAIL_STATE_SINGLETON,
      )
  }

  /**
   * Write one capture's records, its deletions, and its cursor in one transaction.
   *
   * A record whose fingerprint matches the stored one only advances
   * `last_seen_at`: the upstream source re-sends unchanged rows, and rewriting
   * them would churn the index for nothing.
   *
   * @param options - Commit options.
   * @param options.records - Mapped records produced by the mail mapper.
   * @param options.removed - Upstream message ids that no longer exist.
   * @param options.dropFolders - Upstream folder ids whose stored rows this capture drops.
   * @param options.seenAt - Instant this capture observed every record at.
   * @param options.bodyMaxBytes - Ceiling on the stored and indexed body text.
   * @param options.cursor - Cursor fields to store with the records.
   * @returns counts of written, unchanged, and removed rows.
   */
  async commitMail({ records, removed = [], dropFolders = [], seenAt, bodyMaxBytes, cursor }) {
    const selectRow = this.#db.prepare('SELECT rowid, content_hash FROM items WHERE id = ?')
    const touchRow = this.#db.prepare('UPDATE items SET last_seen_at = ? WHERE id = ?')
    const insertRow = this.#db.prepare(
      `INSERT INTO items (id, kind, ts, title, sender, body, actors, metadata, content_key, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const updateRow = this.#db.prepare(
      `UPDATE items SET kind = ?, ts = ?, title = ?, sender = ?, body = ?, actors = ?, metadata = ?, content_key = ?, content_hash = ?, last_seen_at = ?
       WHERE id = ?`,
    )
    const insertIndex = this.#db.prepare(
      'INSERT INTO items_fts (rowid, title, body, actors) VALUES (?, ?, ?, ?)',
    )
    const dropIndex = this.#db.prepare('DELETE FROM items_fts WHERE rowid = ?')
    const dropRow = this.#db.prepare('DELETE FROM items WHERE id = ?')

    let written = 0
    let unchanged = 0
    let removedCount = 0
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const record of records) {
        const id = record.sourceId
        const body = truncateBytes(record.body ?? '', bodyMaxBytes)
        const actors = JSON.stringify(record.actors ?? [])
        const metadata = JSON.stringify(record.metadata ?? {})
        const fingerprint = sha256Hex(JSON.stringify([
          record.sourceId, record.kind, record.ts,
          record.title ?? null, record.sender ?? null, body, actors, metadata, record.contentKey ?? null,
        ]))
        const existing = selectRow.get(id)
        if (existing !== undefined && existing.content_hash === fingerprint) {
          touchRow.run(seenAt, id)
          unchanged += 1
          continue
        }
        if (existing !== undefined) {
          updateRow.run(
            record.kind, record.ts ?? null, record.title ?? null,
            record.sender ?? null, body, actors, metadata, record.contentKey ?? null,
            fingerprint, seenAt, id,
          )
          dropIndex.run(existing.rowid)
          insertIndex.run(
            existing.rowid, segmentForIndex(record.title), segmentForIndex(body),
            segmentForIndex(actorText(record.actors)),
          )
        } else {
          const inserted = insertRow.run(
            id, record.kind, record.ts ?? null,
            record.title ?? null, record.sender ?? null, body, actors, metadata,
            record.contentKey ?? null, fingerprint, seenAt, seenAt,
          )
          insertIndex.run(
            Number(inserted.lastInsertRowid), segmentForIndex(record.title), segmentForIndex(body),
            segmentForIndex(actorText(record.actors)),
          )
        }
        written += 1
      }
      for (const sourceId of removed) {
        const existing = selectRow.get(sourceId)
        if (existing === undefined) continue
        dropIndex.run(existing.rowid)
        dropRow.run(sourceId)
        removedCount += 1
      }
      if (dropFolders.length > 0) {
        // A message files its folder in the record metadata, which is where a
        // folder added to the exclusion list after the fact is found again.
        const marks = dropFolders.map(() => '?').join(', ')
        for (const row of this.#db
          .prepare(`SELECT rowid, id FROM items WHERE json_extract(metadata, '$.parentFolderId') IN (${marks})`)
          .all(...dropFolders)) {
          dropIndex.run(row.rowid)
          dropRow.run(row.id)
          removedCount += 1
        }
      }
      this.#db
        .prepare(
          `UPDATE mail_state SET state = ?, last_success_at = ?, last_error_code = NULL, item_count = ?, snapshot_complete = ?
           WHERE singleton = ?`,
        )
        .run(
          JSON.stringify(cursor.state ?? {}),
          cursor.lastSuccessAt ?? null,
          Number.isInteger(cursor.itemCount) ? cursor.itemCount : records.length,
          cursor.snapshotComplete === null || cursor.snapshotComplete === undefined
            ? null
            : cursor.snapshotComplete === true ? 1 : 0,
          MAIL_STATE_SINGLETON,
        )
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return { written, unchanged, removed: removedCount }
  }

  /**
   * Run one search over the corpus.
   * @param request - The search request.
   * @param request.query - Text to match; empty browses by the other filters.
   * @param request.since - Inclusive lower bound on the received time, ISO-8601.
   * @param request.until - Exclusive upper bound on the received time, ISO-8601.
   * @param request.from - Substring of a participant name or address.
   * @param request.limit - Rows to return.
   * @param request.offset - Rows to skip.
   * @returns the matching count and the requested page.
   */
  search({ query, since, until, from, limit, offset }) {
    const expression = toMatchExpression(query)
    const clauses = []
    const params = []
    if (since !== undefined && since !== null) {
      clauses.push('i.ts IS NOT NULL AND i.ts >= ?')
      params.push(since)
    }
    if (until !== undefined && until !== null) {
      clauses.push('i.ts IS NOT NULL AND i.ts < ?')
      params.push(until)
    }
    if (from !== undefined && from !== null && from !== '') {
      clauses.push("(i.sender LIKE ? ESCAPE '\\' OR i.actors LIKE ? ESCAPE '\\')")
      const needle = `%${escapeLike(from)}%`
      params.push(needle, needle)
    }
    const where = clauses.length === 0 ? '' : ` AND ${clauses.join(' AND ')}`
    const total = expression === null
      ? Number(this.#db.prepare(`SELECT COUNT(*) AS total FROM items i WHERE 1 = 1${where}`).get(...params).total)
      : Number(
        this.#db
          .prepare(
            `SELECT COUNT(*) AS total FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ?${where}`,
          )
          .get(expression, ...params).total,
      )
    const columns = 'i.id, i.kind, i.ts, i.title, i.sender, i.actors, i.metadata, i.content_key, i.body'
    const rows = expression === null
      ? this.#db
        .prepare(`SELECT ${columns} FROM items i WHERE 1 = 1${where} ORDER BY i.ts DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset)
      : this.#db
        .prepare(
          `SELECT ${columns} FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ?${where} ORDER BY i.ts DESC LIMIT ? OFFSET ?`,
        )
        .all(expression, ...params, limit, offset)
    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        ts: row.ts ?? null,
        title: row.title ?? null,
        sender: row.sender ?? null,
        actors: JSON.parse(row.actors),
        metadata: JSON.parse(row.metadata),
        contentKey: row.content_key ?? null,
        snippet: snippetAround(row.body, query, SNIPPET_CHARACTERS),
      })),
    }
  }

  /**
   * Read one record in full.
   * @param id - Corpus id a search returned.
   * @returns the record, or undefined when no row carries that id.
   */
  item(id) {
    const row = this.#db.prepare('SELECT * FROM items WHERE id = ?').get(id)
    if (row === undefined) return undefined
    return {
      id: row.id,
      kind: row.kind,
      ts: row.ts ?? null,
      title: row.title ?? null,
      sender: row.sender ?? null,
      body: row.body ?? null,
      actors: JSON.parse(row.actors),
      metadata: JSON.parse(row.metadata),
      contentKey: row.content_key ?? null,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }
  }

  /**
   * Stored row count.
   * @returns the number of messages in the corpus.
   */
  count() {
    return Number(this.#db.prepare('SELECT COUNT(*) AS total FROM items').get().total)
  }

  /**
   * Size of the database file on disk, excluding its write-ahead log.
   * @returns the size in bytes, or 0 when the file is not there.
   */
  async databaseBytes() {
    try {
      return (await stat(this.#path)).size
    } catch (error) {
      if (error?.code === 'ENOENT') return 0
      throw error
    }
  }

  /** Release the database handle. Idempotent. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}

/**
 * Neutralize LIKE wildcards in caller-supplied text.
 * @param value - Raw filter text.
 * @returns the text with `\`, `%`, and `_` escaped.
 */
function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

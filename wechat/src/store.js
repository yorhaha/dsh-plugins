/**
 * The durable corpus: one SQLite file holding every imported message, one row
 * per imported batch, and the facts that belong to neither.
 *
 * Reads are ordinary SQL over the file, so the corpus never has to fit in
 * memory: a full-history batch is hundreds of thousands of messages, and the
 * search that matters most — one conversation, or one window of time — is
 * answered from an index. A whole-corpus substring scan is the slow path, and it
 * is still a few hundred milliseconds at the largest batch this exporter has
 * produced.
 *
 * This module owns every statement. The importer owns orchestration, the tools
 * own presentation, and neither of them writes SQL.
 *
 * @module dsh-wechat/src/store
 */

import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { WechatError } from './errors.js'
import { applySchema } from './schema.js'

/** Messages written per statement batch. */
const CHUNK = 1000

/** Columns every item projection reads, in one place. */
const ITEM_COLUMNS = `source_id, content_hash, fallback_base, duplicate_index, import_id,
  kind, ts, ts_unix, local_day, chat_id, chat_name, is_group, msg_type, direction, is_self,
  real_sender_id, sender_id, sender_name, content, actors_json, metadata_json, media_json,
  first_seen_at, last_seen_at`

/** One imported batch, as the tools and the status probe report it. */
const BATCH_COLUMNS = `import_id, dir, export_time, total_messages, include_groups, state,
  imported_at, generated, updated, unchanged, group_skipped, collisions,
  suspected_replacements, source_files_hash`

/** An open corpus handle. Construct through {@link openStore}. */
export class WechatStore {
  #db
  #path
  #closed = false
  #staging = false

  /**
   * @param db - The open SQLite handle; this instance owns its lifecycle.
   * @param path - Absolute path of the corpus file.
   */
  constructor(db, path) {
    this.#db = db
    this.#path = path
  }

  /** @returns the absolute path of the corpus file. */
  get path() {
    return this.#path
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Close the corpus.
   *
   * Idempotent, so a lifecycle teardown that runs after a failed open does not
   * throw a second failure over the first.
   */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  /**
   * Size of the corpus on disk, including the write-ahead log.
   * @returns the byte count of whichever files exist.
   */
  databaseBytes() {
    let total = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += statSync(`${this.#path}${suffix}`).size
      } catch {
        // A missing companion file is the normal case outside a write.
      }
    }
    return total
  }

  // ── batches ───────────────────────────────────────────────────────────────

  /**
   * Read one batch row.
   * @param importId - Batch name.
   * @returns the row, or undefined when the batch was never imported.
   */
  batch(importId) {
    return this.#db.prepare(`SELECT ${BATCH_COLUMNS} FROM batches WHERE import_id = ?`).get(importId)
  }

  /**
   * Every imported batch, most recently imported first.
   * @returns the rows.
   */
  batches() {
    return this.#db
      .prepare(`SELECT ${BATCH_COLUMNS} FROM batches ORDER BY imported_at DESC, import_id ASC`)
      .all()
  }

  /**
   * The batch of the most recent import.
   * @returns the row, or undefined when nothing was ever imported.
   */
  latestImport() {
    return this.#db
      .prepare(`SELECT ${BATCH_COLUMNS} FROM batches ORDER BY imported_at DESC, import_id ASC LIMIT 1`)
      .get()
  }

  /**
   * Write or replace one batch row.
   *
   * The row is the batch's current state, not a log: importing the same batch
   * again with group messages adds them and replaces the counters, which is why
   * this is a replace rather than yorha's write-once manifest.
   *
   * @param row - Every batch column.
   */
  putBatch(row) {
    this.#db
      .prepare(
        `INSERT INTO batches (${BATCH_COLUMNS}) VALUES (${placeholders(BATCH_COLUMNS)})
         ON CONFLICT(import_id) DO UPDATE SET
           dir = excluded.dir, export_time = excluded.export_time,
           total_messages = excluded.total_messages,
           source_files_hash = excluded.source_files_hash,
           include_groups = excluded.include_groups, state = excluded.state,
           imported_at = excluded.imported_at, generated = excluded.generated,
           updated = excluded.updated, unchanged = excluded.unchanged,
           group_skipped = excluded.group_skipped, collisions = excluded.collisions,
           suspected_replacements = excluded.suspected_replacements`,
      )
      .run(...batchValues(row))
  }

  /**
   * Read one meta value.
   * @param key - Meta key.
   * @returns the value, or undefined.
   */
  meta(key) {
    return this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
  }

  /**
   * Write one meta value.
   * @param key - Meta key.
   * @param value - Text to store.
   */
  setMeta(key, value) {
    this.#db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /**
   * Corpus totals.
   * @returns message and conversation counts.
   */
  counts() {
    const messages = Number(this.#db.prepare('SELECT COUNT(*) AS c FROM items').get().c)
    const chats = Number(this.#db.prepare('SELECT COUNT(*) AS c FROM chats').get().c)
    return { messages, chats }
  }

  /**
   * Resolve a conversation id or name fragment to the ids it names.
   *
   * The lookup reads the derived conversations table, which holds one row per
   * conversation, so a name filter narrows the message scan through the chat
   * index instead of forcing a scan of every message to find which conversation
   * a name belongs to.
   *
   * @param text - Conversation id, or part of a name.
   * @returns the matching ids, in no particular order.
   */
  chatIdsMatching(text) {
    const needle = text.trim().toLowerCase()
    return this.#db
      .prepare("SELECT chat_id FROM chats WHERE chat_id = ? OR instr(lower(COALESCE(name, '')), ?) > 0")
      .all(text.trim(), needle)
      .map((row) => row.chat_id)
  }

  /**
   * Recompute the derived row for each touched conversation.
   *
   * Called at the end of an import, for the conversations that import wrote to,
   * which is what keeps the derived table in step without a full rebuild.
   *
   * @param chatIds - Conversations to refresh.
   * @param nowIso - Instant of this refresh.
   */
  refreshChats(chatIds, nowIso) {
    if (chatIds.length === 0) return
    const aggregate = this.#db.prepare(
      `SELECT chat_id, is_group, COUNT(*) AS message_count,
              SUM(CASE WHEN kind = 'text' THEN 1 ELSE 0 END) AS text_count,
              COUNT(DISTINCT local_day) AS active_days, MIN(ts) AS first_at, MAX(ts) AS last_at,
              (SELECT latest.chat_name FROM items AS latest
                WHERE latest.chat_id = items.chat_id AND latest.chat_name IS NOT NULL
                ORDER BY latest.ts_unix DESC LIMIT 1) AS latest_name
         FROM items WHERE chat_id = ? GROUP BY chat_id`,
    )
    const upsert = this.#db.prepare(
      `INSERT INTO chats (chat_id, name, is_group, message_count, text_count, active_days, first_at, last_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         name = excluded.name, is_group = excluded.is_group, message_count = excluded.message_count,
         text_count = excluded.text_count, active_days = excluded.active_days,
         first_at = excluded.first_at, last_at = excluded.last_at, updated_at = excluded.updated_at`,
    )
    for (const chatId of chatIds) {
      const row = aggregate.get(chatId)
      if (row === undefined) {
        this.#db.prepare('DELETE FROM chats WHERE chat_id = ?').run(chatId)
        continue
      }
      upsert.run(
        row.chat_id,
        row.latest_name ?? null,
        Number(row.is_group),
        Number(row.message_count),
        Number(row.text_count),
        Number(row.active_days),
        row.first_at,
        row.last_at,
        nowIso,
      )
    }
  }

  /**
   * Rebuild every derived conversation row from the messages.
   *
   * The derived table is disposable, so this is the repair for a corpus whose
   * table is missing rows an interrupted import never refreshed.
   *
   * @param nowIso - Instant of this rebuild.
   * @returns how many conversations were written.
   */
  rebuildChats(nowIso) {
    const rows = this.#db
      .prepare(
        `SELECT chat_id, is_group, COUNT(*) AS message_count,
                SUM(CASE WHEN kind = 'text' THEN 1 ELSE 0 END) AS text_count,
                COUNT(DISTINCT local_day) AS active_days, MIN(ts) AS first_at, MAX(ts) AS last_at,
                (SELECT latest.chat_name FROM items AS latest
                  WHERE latest.chat_id = items.chat_id AND latest.chat_name IS NOT NULL
                  ORDER BY latest.ts_unix DESC LIMIT 1) AS latest_name
           FROM items GROUP BY chat_id`,
      )
      .all()
    this.#db.exec('DELETE FROM chats')
    const upsert = this.#db.prepare(
      `INSERT INTO chats (chat_id, name, is_group, message_count, text_count, active_days, first_at, last_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of rows) {
      upsert.run(
        row.chat_id,
        row.latest_name ?? null,
        Number(row.is_group),
        Number(row.message_count),
        Number(row.text_count),
        Number(row.active_days),
        row.first_at,
        row.last_at,
        nowIso,
      )
    }
    return rows.length
  }

  /**
   * Every recorded batch directory, so a caller can resolve a media reference
   * and explain one whose batch is gone.
   * @returns import id and directory pairs.
   */
  batchDirs() {
    return this.#db.prepare('SELECT import_id, dir FROM batches').all()
  }

  // ── import ────────────────────────────────────────────────────────────────

  /**
   * Run a function inside one write transaction.
   *
   * The whole import commits or rolls back together: messages, the batch row,
   * and the meta facts. yorha committed items and the manifest separately and
   * bilibili's domain has no transaction at all, so this closes a gap neither
   * had.
   *
   * @param work - Called with this handle; its return value is returned.
   * @returns whatever `work` returned.
   * @throws whatever `work` threw, after rolling back.
   */
  transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Create the staging table that holds this import's identities.
   *
   * Staging is what makes the suspected-replacement count answerable without
   * keeping a full-history batch's fingerprints in memory: the query joins the
   * staging table against the corpus as it was before the first write.
   */
  openStaging() {
    this.#db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS batch_items (
         source_id TEXT PRIMARY KEY, fallback_base TEXT, content_hash TEXT, import_id TEXT
       ) STRICT`,
    )
    this.#db.exec('DELETE FROM batch_items')
    this.#staging = true
  }

  /**
   * Record one message's identity for the suspected-replacement query.
   *
   * @param record - A parsed message carrying its identity and content hash.
   * @param record.sourceId - The message's source id.
   * @param record.fallbackBase - Its fingerprint base, or null with a local id.
   * @param record.contentHash - Its content hash.
   * @param record.importId - The batch this import writes under.
   */
  stageItem({ sourceId, fallbackBase, contentHash, importId }) {
    this.#db
      .prepare('INSERT OR IGNORE INTO batch_items (source_id, fallback_base, content_hash, import_id) VALUES (?, ?, ?, ?)')
      .run(sourceId, fallbackBase, contentHash, importId)
  }

  /** Drop the staging table. Safe to call whether or not it exists. */
  closeStaging() {
    this.#db.exec('DROP TABLE IF EXISTS batch_items')
    this.#staging = false
  }

  /** @returns whether the staging table is currently populated. */
  get staging() {
    return this.#staging
  }

  /**
   * Count the messages this batch shares with an earlier import under a
   * different identity.
   *
   * A message is counted when the corpus holds an identical message — same
   * fingerprint base, same content hash — under another id, and holds nothing
   * under this message's own id. That is a message whose duplicate index moved
   * between exports, so the corpus now files it twice.
   *
   * The three near misses are all left out: a message that still exists under
   * its own id (an ordinary re-import), a batch's own repeated records, which
   * share a base and a content hash by construction and are reported as
   * collisions instead, and a message whose base matches but whose content
   * differs, which is a different message sent in the same second by the same
   * sender.
   *
   * The count is a warning, never a merge: the earlier copy stays.
   *
   * @returns the count, computed against the corpus as it is right now.
   */
  suspectedReplacements() {
    if (!this.#staging) return 0
    return Number(
      this.#db
        .prepare(
          `SELECT COUNT(*) AS c FROM batch_items AS b
            WHERE b.fallback_base IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM items AS own WHERE own.source_id = b.source_id)
              AND EXISTS (
                SELECT 1 FROM items AS twin
                 WHERE twin.fallback_base = b.fallback_base
                   AND twin.content_hash = b.content_hash
                   AND twin.import_id <> b.import_id
              )`,
        )
        .get().c,
    )
  }

  /**
   * Write one chunk of parsed messages, counting what each write did.
   *
   * A message whose fingerprint is unchanged is not touched at all: no column
   * moves, including `last_seen_at`, which is what yorha's upsert did and what
   * makes re-importing an overlapping export a true no-op.
   *
   * @param records - Parsed messages, each carrying `sourceId` and `contentHash`.
   * @param nowIso - Instant of this import, for first/last seen.
   * @returns counts of newly stored, updated, and untouched messages, plus the
   *   conversations whose derived aggregates this chunk invalidated.
   */
  writeChunk(records, nowIso) {
    const existing = this.#existingItems(records.map((record) => record.sourceId))
    const insert = this.#db.prepare(
      `INSERT INTO items (${ITEM_COLUMNS}) VALUES (${placeholders(ITEM_COLUMNS)})
       ON CONFLICT(source_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         fallback_base = excluded.fallback_base, duplicate_index = excluded.duplicate_index,
         import_id = excluded.import_id, kind = excluded.kind, ts = excluded.ts,
         ts_unix = excluded.ts_unix, local_day = excluded.local_day, chat_id = excluded.chat_id,
         chat_name = excluded.chat_name, is_group = excluded.is_group, msg_type = excluded.msg_type,
         direction = excluded.direction, is_self = excluded.is_self,
         real_sender_id = excluded.real_sender_id, sender_id = excluded.sender_id,
         sender_name = excluded.sender_name, content = excluded.content,
         actors_json = excluded.actors_json, metadata_json = excluded.metadata_json,
         media_json = excluded.media_json, last_seen_at = excluded.last_seen_at`,
    )
    let generated = 0
    let updated = 0
    let unchanged = 0
    const touched = new Set()
    for (const record of records) {
      const previous = existing.get(record.sourceId)
      if (previous === record.contentHash) {
        unchanged += 1
        continue
      }
      insert.run(...itemValues(record, nowIso))
      if (previous === undefined) generated += 1
      else updated += 1
      touched.add(record.chatId)
    }
    return { generated, updated, unchanged, touched: [...touched] }
  }

  // ── queries ───────────────────────────────────────────────────────────────

  /**
   * Search the corpus.
   *
   * Every filter is optional and they combine conjunctively. `query` is a
   * case-insensitive substring of the text a reader sees plus the upstream
   * fields, so a word from a message, a participant's name, or an id all work
   * without the caller knowing which column holds it. Tokenization would recall
   * less: Chinese has no word boundaries a tokenizer here could trust.
   *
   * @param options - Search options.
   * @param options.query - Substring to match, or undefined to match everything.
   * @param options.chat - Conversation id or a substring of its name.
   * @param options.kind - Restrict to one message class.
   * @param options.direction - Restrict to `inbound`, `outbound`, or `system`.
   * @param options.sender - Substring of a sender's name or id.
   * @param options.since - Inclusive lower bound in seconds since the epoch.
   * @param options.until - Exclusive upper bound in seconds since the epoch.
   * @param options.limit - Maximum rows to return.
   * @param options.offset - Rows to skip after ordering.
   * @returns the matched total and the requested window, newest first.
   */
  search(options = {}) {
    const { query, chat, kind, direction, sender, since, until, limit = 20, offset = 0 } = options
    const where = []
    const params = []
    if (typeof query === 'string' && query.trim() !== '') {
      // LIKE folds ASCII case on the fly, where lower() would build a copy of
      // every column of every row; the two agree exactly, because SQLite's
      // lower() is ASCII-only too. Wildcards in the needle stay data.
      const pattern = `%${escapeLike(query.trim())}%`
      const columns = ['content', 'chat_name', 'chat_id', 'sender_name', 'sender_id', 'metadata_json', 'source_id']
      where.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
      for (let index = 0; index < columns.length; index += 1) params.push(pattern)
    }
    if (typeof chat === 'string' && chat.trim() !== '') {
      const ids = this.chatIdsMatching(chat)
      if (ids.length === 0) where.push('0')
      else {
        where.push(`chat_id IN (${ids.map(() => '?').join(',')})`)
        params.push(...ids)
      }
    }
    if (typeof kind === 'string' && kind.trim() !== '') {
      where.push('kind = ?')
      params.push(kind.trim())
    }
    if (typeof direction === 'string' && direction.trim() !== '') {
      where.push('direction = ?')
      params.push(direction.trim())
    }
    if (typeof sender === 'string' && sender.trim() !== '') {
      const pattern = `%${escapeLike(sender.trim())}%`
      where.push("(sender_name LIKE ? ESCAPE '\\' OR sender_id LIKE ? ESCAPE '\\')")
      params.push(pattern, pattern)
    }
    if (typeof since === 'number') {
      where.push('ts_unix >= ?')
      params.push(since)
    }
    if (typeof until === 'number') {
      where.push('ts_unix < ?')
      params.push(until)
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    // A plain count and a separate page: `COUNT(*) OVER ()` would materialize
    // every match to answer both in one statement, which at corpus scale costs
    // more than the second scan.
    const total = Number(this.#db.prepare(`SELECT COUNT(*) AS c FROM items${clause}`).get(...params).c)
    const page = this.#db
      .prepare(
        `SELECT source_id, ts, ts_unix, local_day, chat_id, chat_name, is_group, kind, direction,
                sender_name, content, media_json
           FROM items${clause}
          ORDER BY ts_unix DESC, source_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
    return { total, rows: page.map(toSearchRow) }
  }

  /**
   * Read one message in full.
   * @param sourceId - The id a search returned.
   * @returns the stored message, or undefined.
   */
  item(sourceId) {
    const row = this.#db.prepare(`SELECT ${ITEM_COLUMNS} FROM items WHERE source_id = ?`).get(sourceId)
    return row === undefined ? undefined : toItem(row)
  }

  /**
   * Per-conversation aggregates.
   *
   * This is what the yorha contacts index materialized. Nothing consumes a
   * stored index here — the assistant asks, and one indexed group-by answers —
   * so there is no derived table to keep in step with the messages.
   *
   * @param options - Aggregate options.
   * @param options.chat - Conversation id or a substring of its name.
   * @param options.since - Inclusive lower bound in seconds since the epoch.
   * @param options.until - Exclusive upper bound in seconds since the epoch.
   * @param options.limit - Maximum conversations to return.
   * @returns one row per conversation, most recently active first.
   */
  chats(options = {}) {
    const { chat, since, until, limit = 50 } = options
    const where = []
    const params = []
    if (typeof chat === 'string' && chat.trim() !== '') {
      const ids = this.chatIdsMatching(chat)
      if (ids.length === 0) where.push('0')
      else {
        where.push(`chat_id IN (${ids.map(() => '?').join(',')})`)
        params.push(...ids)
      }
    }
    if (typeof since === 'number' || typeof until === 'number') {
      // A window changes the aggregates, so it is answered from the messages of
      // the conversations the filter left, not from the stored whole-history row.
      return this.#chatsInWindow({ chat, since, until, limit })
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    return this.#db
      .prepare(
        `SELECT chat_id, name, is_group, message_count, text_count, active_days, first_at, last_at
           FROM chats${clause} ORDER BY last_at DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(toChatRow)
  }

  /**
   * Aggregates over a window of time, computed from the messages.
   * @param options - Window options.
   * @param options.chat - Conversation id or name fragment.
   * @param options.since - Inclusive lower bound in seconds.
   * @param options.until - Exclusive upper bound in seconds.
   * @param options.limit - Maximum conversations.
   * @returns one row per conversation.
   */
  #chatsInWindow({ chat, since, until, limit }) {
    const where = []
    const params = []
    if (typeof chat === 'string' && chat.trim() !== '') {
      const ids = this.chatIdsMatching(chat)
      if (ids.length === 0) where.push('0')
      else {
        where.push(`chat_id IN (${ids.map(() => '?').join(',')})`)
        params.push(...ids)
      }
    }
    if (typeof since === 'number') {
      where.push('ts_unix >= ?')
      params.push(since)
    }
    if (typeof until === 'number') {
      where.push('ts_unix < ?')
      params.push(until)
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    return this.#db
      .prepare(
        `SELECT chat_id, is_group, COUNT(*) AS message_count,
                SUM(CASE WHEN kind = 'text' THEN 1 ELSE 0 END) AS text_count,
                COUNT(DISTINCT local_day) AS active_days, MIN(ts) AS first_at, MAX(ts) AS last_at,
                (SELECT latest.chat_name FROM items AS latest
                  WHERE latest.chat_id = items.chat_id AND latest.chat_name IS NOT NULL
                  ORDER BY latest.ts_unix DESC LIMIT 1) AS latest_name
           FROM items${clause} GROUP BY chat_id ORDER BY last_at DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((row) => toChatRow({ ...row, name: row.latest_name }))
  }

  /**
   * Message classes present in the corpus, most common first, so a caller can
   * discover what `wechat_search`'s `kind` filter accepts.
   * @returns one row per class.
   */
  kinds() {
    return this.#db
      .prepare('SELECT kind, COUNT(*) AS c FROM items GROUP BY kind ORDER BY c DESC')
      .all()
      .map((row) => ({ kind: row.kind, count: Number(row.c) }))
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Look up the stored fingerprint of each id, in chunks the statement can hold.
   * @param sourceIds - Ids to look up.
   * @returns id to content hash.
   */
  #existingItems(sourceIds) {
    const found = new Map()
    for (let start = 0; start < sourceIds.length; start += CHUNK) {
      const chunk = sourceIds.slice(start, start + CHUNK)
      if (chunk.length === 0) continue
      const statement = this.#db.prepare(
        `SELECT source_id, content_hash FROM items WHERE source_id IN (${chunk.map(() => '?').join(',')})`,
      )
      for (const row of statement.all(...chunk)) found.set(row.source_id, row.content_hash)
    }
    return found
  }
}

/**
 * Open the corpus, creating the file and its directory on first use.
 *
 * The `node:sqlite` import is dynamic so that a Harness which never loads this
 * plugin never loads the experimental module; the driver is synchronous, which
 * is why every read here returns a value rather than a promise.
 *
 * @param options - Open options.
 * @param options.path - Absolute path of the corpus file.
 * @param options.logger - Plugin logger, for the close-after-failed-open case.
 * @returns the open handle.
 * @throws a `db_unavailable` {@link WechatError} when the file cannot be opened.
 */
export async function openStore({ path, logger }) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // The corpus holds private conversations. SQLite would create it with the
  // process umask; create it owner-only first, as session storage does.
  const fd = openSync(path, 'a', 0o600)
  closeSync(fd)
  // The mode above only applies to a file this process created. A corpus that
  // already existed keeps whatever mode it had, so tighten it explicitly; the
  // WAL and shared-memory files SQLite creates then inherit this one.
  try {
    chmodSync(path, 0o600)
  } catch (chmodError) {
    logger?.warn?.(`wechat: tightening the corpus file mode failed: ${String(chmodError)}`)
  }
  const { DatabaseSync } = await import('node:sqlite')
  let db
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    const { migrated } = applySchema(db)
    if (migrated) {
      // A dropped column leaves its pages behind. Compact once, here, so the
      // corpus actually shrinks instead of carrying the removed bytes forever.
      try {
        db.exec('VACUUM')
        // VACUUM in WAL mode leaves the rewritten pages in the write-ahead log:
        // the file is smaller, but the corpus on disk is not, until the log is
        // truncated. Nothing else holds this connection, so that can happen now.
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch (vacuumError) {
        logger?.warn?.(`wechat: compacting a migrated corpus failed: ${String(vacuumError)}`)
      }
    }
  } catch (error) {
    if (db !== undefined) {
      try {
        db.close()
      } catch (closeError) {
        logger?.warn?.(`wechat: closing a corpus that failed to open also failed: ${String(closeError)}`)
      }
    }
    throw new WechatError('db_unavailable', `wechat: could not open the corpus at ${path}: ${error.message}`)
  }
  return new WechatStore(db, path)
}

/**
 * A statement's placeholders for a column list.
 * @param columns - Comma-separated column names.
 * @returns the placeholder list.
 */
function placeholders(columns) {
  return columns
    .split(',')
    .map(() => '?')
    .join(', ')
}

/**
 * The stored columns of one message, in {@link ITEM_COLUMNS} order.
 * @param record - A parsed message.
 * @param nowIso - Instant of this import.
 * @returns the bound values.
 */
function itemValues(record, nowIso) {
  return [
    record.sourceId,
    record.contentHash,
    record.fallbackBase ?? null,
    record.duplicateIndex ?? 0,
    record.importId,
    record.kind,
    record.ts,
    record.tsUnix,
    record.localDay,
    record.chatId,
    record.chatName ?? null,
    record.isGroup ? 1 : 0,
    record.msgType ?? null,
    record.direction,
    record.isSelf === null || record.isSelf === undefined ? null : record.isSelf ? 1 : 0,
    record.realSenderId ?? null,
    record.senderId === null || record.senderId === undefined ? null : String(record.senderId),
    record.senderName ?? null,
    record.content ?? null,
    JSON.stringify(record.actors ?? []),
    JSON.stringify(record.metadata ?? {}),
    JSON.stringify(record.media ?? []),
    nowIso,
    nowIso,
  ]
}

/**
 * The batch columns of one row, in {@link BATCH_COLUMNS} order.
 * @param row - A batch row.
 * @returns the bound values.
 */
function batchValues(row) {
  return [
    row.import_id,
    row.dir,
    row.export_time ?? null,
    row.total_messages ?? null,
    row.include_groups ? 1 : 0,
    row.state,
    row.imported_at,
    row.generated,
    row.updated,
    row.unchanged,
    row.group_skipped,
    row.collisions,
    row.suspected_replacements,
    row.source_files_hash,
  ]
}

/**
 * Escape the wildcards a LIKE pattern would otherwise honour.
 * @param text - Raw needle.
 * @returns the needle with `\\`, `%`, and `_` escaped.
 */
function escapeLike(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * One conversation row.
 * @param row - A chats row.
 * @returns the row with camelCase fields.
 */
function toChatRow(row) {
  return {
    chatId: row.chat_id,
    name: row.name ?? null,
    isGroup: Number(row.is_group) === 1,
    messageCount: Number(row.message_count),
    textCount: Number(row.text_count),
    activeDays: Number(row.active_days),
    firstAt: row.first_at,
    lastAt: row.last_at,
  }
}

/**
 * One search row, as the tools report it.
 * @param row - A search projection row.
 * @returns the row with camelCase fields.
 */
function toSearchRow(row) {
  let media = []
  try {
    media = JSON.parse(row.media_json)
  } catch {
    media = []
  }
  return {
    sourceId: row.source_id,
    ts: row.ts,
    localDay: row.local_day,
    chatId: row.chat_id,
    chatName: row.chat_name ?? null,
    isGroup: Number(row.is_group) === 1,
    kind: row.kind,
    direction: row.direction,
    senderName: row.sender_name ?? null,
    content: row.content ?? '',
    mediaTypes: media.map((ref) => ref.type),
  }
}

/**
 * How a message id was derived, which its own prefix states.
 * @param sourceId - A stored message id.
 * @returns `local_id` for an exporter id, `fingerprint` for a constructed one.
 */
function identityOf(sourceId) {
  return sourceId.startsWith('local:') ? 'local_id' : 'fingerprint'
}

/**
 * One stored message, with every field the import kept.
 * @param row - An items row.
 * @returns the message in camelCase.
 */
function toItem(row) {
  return {
    sourceId: row.source_id,
    contentHash: row.content_hash,
    identity: identityOf(row.source_id),
    fallbackBase: row.fallback_base ?? null,
    duplicateIndex: Number(row.duplicate_index),
    importId: row.import_id,
    kind: row.kind,
    ts: row.ts,
    tsUnix: Number(row.ts_unix),
    localDay: row.local_day,
    chatId: row.chat_id,
    chatName: row.chat_name ?? null,
    isGroup: Number(row.is_group) === 1,
    msgType: row.msg_type === null ? null : Number(row.msg_type),
    direction: row.direction,
    isSelf: row.is_self === null ? null : Number(row.is_self) === 1,
    realSenderId: row.real_sender_id === null ? null : Number(row.real_sender_id),
    senderId: row.sender_id ?? null,
    senderName: row.sender_name ?? null,
    content: row.content ?? null,
    actors: parseJson(row.actors_json, []),
    metadata: parseJson(row.metadata_json, {}),
    media: parseJson(row.media_json, []),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }
}

/**
 * Parse a stored JSON column, treating an unreadable one as empty.
 * @param text - The stored text.
 * @param fallback - Value to use when it does not parse.
 * @returns the parsed value.
 */
function parseJson(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

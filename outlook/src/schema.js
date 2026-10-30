/**
 * SQLite schema for the local Microsoft Graph corpus.
 *
 * One database per plugin (one file, no server, no driver dependency: Node's
 * built-in `node:sqlite` is the medium). The schema is versioned with SQLite's
 * own `PRAGMA user_version`, which is monotonic: a database written by a newer
 * build is refused rather than read with the wrong meaning, and an older
 * generation is migrated in place.
 *
 * `items` is the corpus; `items_fts` is a separate full-text index over the
 * same rows, keyed by `items.rowid`. Keeping the index in its own table (rather
 * than an external-content table over `items`) means an update is a plain
 * delete/insert pair with no trigger to keep in step, and the indexed column
 * values are the tokenized text rather than the display text.
 *
 * Generation 2 replaced the derived primary key — `sha256(dataset, source_id)`,
 * truncated, with the pair stored right next to it under a `UNIQUE` constraint —
 * with the pair itself, and dropped the `id` column of the index, which no query
 * ever read.
 *
 * Generation 3 is mail-only. The calendar dataset is gone, so the corpus has no
 * `dataset` column, no `ts_end` (an event's end), and one `mail_state` row
 * instead of a `cursors` table keyed by dataset name. A row's key is the Graph
 * message id itself. Migrating rewrites the corpus and drops every calendar row
 * with it, which is the point: a calendar capture no longer exists to refresh
 * or prune them.
 *
 * @module dsh-outlook/src/schema
 */

import { actorText, segmentForIndex } from './text.js'

/** Schema generation this build writes and understands. */
export const SCHEMA_VERSION = 3

/** One mail record row; `id` is the Graph message id. */
function itemsDdl(table) {
  return `CREATE TABLE ${table} (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    ts            TEXT,
    title         TEXT,
    sender        TEXT,
    body          TEXT,
    actors        TEXT NOT NULL DEFAULT '[]',
    metadata      TEXT NOT NULL DEFAULT '{}',
    content_key   TEXT,
    content_hash  TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
  ) STRICT`
}

/** Indexes over `items`, recreated after a table rebuild. */
const ITEMS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS items_ts ON items (ts DESC)',
  'CREATE INDEX IF NOT EXISTS items_content_key ON items (content_key)',
  'CREATE INDEX IF NOT EXISTS items_seen ON items (last_seen_at)',
]

/** The full-text index: tokenized title, body, and participants per rowid. */
const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title,
  body,
  actors,
  tokenize = 'unicode61 remove_diacritics 2'
)`

/**
 * The one mail cursor row. A capture has a single position, so this is a
 * singleton like `status` rather than a table keyed by dataset.
 */
const MAIL_STATE_DDL = `CREATE TABLE IF NOT EXISTS mail_state (
  singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
  state             TEXT NOT NULL DEFAULT '{}',
  last_success_at   TEXT,
  last_error_code   TEXT,
  item_count        INTEGER NOT NULL DEFAULT 0,
  snapshot_complete INTEGER
) STRICT`

/** Tables that live next to the corpus. */
const AUXILIARY_TABLES = [
  MAIL_STATE_DDL,
  `CREATE TABLE IF NOT EXISTS status (
    singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
    last_run_at      TEXT,
    last_run_status  TEXT,
    last_error_code  TEXT,
    auth_required    INTEGER NOT NULL DEFAULT 0,
    retry_not_before TEXT
  ) STRICT`,
]

/**
 * Statements creating generation 3 from nothing. Every statement is idempotent,
 * so applying them to a database of the same generation is a no-op.
 */
const STATEMENTS = [itemsDdl('items'), ...ITEMS_INDEXES, FTS_DDL, ...AUXILIARY_TABLES]

/** The single row every read and write of `status` and `mail_state` addresses. */
export const STATUS_SINGLETON = 1

/** The single mail-cursor row. */
export const MAIL_STATE_SINGLETON = STATUS_SINGLETON

/** Initial `status` row values: nothing has run, nothing is known. */
export const STATUS_INITIAL = Object.freeze({
  lastRunAt: null,
  lastRunStatus: null,
  lastErrorCode: null,
  authRequired: false,
  retryNotBefore: null,
})

/**
 * Create or migrate the schema in an open database.
 *
 * @param db - An open `node:sqlite` database handle.
 * @returns whether an existing corpus was migrated, so the caller can compact it.
 * @throws when the database carries a newer generation than this build writes,
 * naming both generations so the mismatch is actionable.
 */
export function applySchema(db) {
  const current = readUserVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `outlook: this corpus was written by a newer build (schema ${current}, this build writes ${SCHEMA_VERSION}); update the plugin or point databasePath at another file`,
    )
  }
  if (current === SCHEMA_VERSION) return { migrated: false }
  db.exec('BEGIN IMMEDIATE')
  try {
    if (current === 0) {
      for (const statement of STATEMENTS) db.exec(statement)
    } else {
      migrateMailOnly(db)
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { migrated: current !== 0 }
}

/**
 * Read the schema generation recorded in the database.
 * @param db - An open `node:sqlite` database handle.
 * @returns the recorded generation, or 0 for a database this plugin never wrote.
 */
export function readUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const value = row?.user_version
  return typeof value === 'number' ? value : 0
}

/**
 * Bring a generation-1 or generation-2 corpus to mail-only generation 3.
 *
 * Both older shapes key a mail row by the pair in `dataset` and `source_id`, and
 * both carry every column this build keeps, so one rewrite serves them: the
 * calendar rows are dropped rather than carried into a table that can no longer
 * describe them, and a mail row takes its Graph message id as the key.
 *
 * The index is rebuilt from `items` because the rowids are renumbered by the
 * rewrite and its values are tokenized in JavaScript — SQL alone cannot
 * re-segment CJK text. The mail cursor moves out of its row in `cursors` into
 * the `mail_state` singleton; a calendar cursor row has nowhere to go and goes
 * with its dataset.
 *
 * @param db - An open generation-1 or generation-2 database handle inside a
 *   transaction.
 */
function migrateMailOnly(db) {
  db.exec(itemsDdl('items_next'))
  db.exec(`INSERT INTO items_next
    (id, kind, ts, title, sender, body, actors, metadata, content_key, content_hash, first_seen_at, last_seen_at)
    SELECT source_id, kind, ts, title, sender, body, actors, metadata, content_key, content_hash, first_seen_at, last_seen_at
      FROM items
      WHERE dataset = 'mail'`)
  db.exec('DROP TABLE items')
  db.exec('ALTER TABLE items_next RENAME TO items')
  for (const statement of ITEMS_INDEXES) db.exec(statement)
  rebuildIndex(db)

  db.exec(MAIL_STATE_DDL)
  db.exec(`INSERT INTO mail_state (singleton, state, last_success_at, last_error_code, item_count, snapshot_complete)
    SELECT 1, state, last_success_at, last_error_code, item_count, snapshot_complete
      FROM cursors
      WHERE dataset = 'mail'`)
  db.exec('DROP TABLE cursors')
}

/**
 * Rebuild `items_fts` from `items`, re-tokenizing every column.
 * @param db - An open database handle inside a transaction.
 */
function rebuildIndex(db) {
  db.exec('DROP TABLE IF EXISTS items_fts')
  db.exec(FTS_DDL)
  const insert = db.prepare('INSERT INTO items_fts (rowid, title, body, actors) VALUES (?, ?, ?, ?)')
  for (const row of db.prepare('SELECT rowid, title, body, actors FROM items').iterate()) {
    insert.run(row.rowid, segmentForIndex(row.title), segmentForIndex(row.body), segmentForIndex(actorText(actorsOf(row.actors))))
  }
}

/**
 * Parse a stored actors column, treating an unreadable one as no participants.
 * @param text - The stored JSON.
 * @returns the participants.
 */
function actorsOf(text) {
  try {
    return JSON.parse(text)
  } catch {
    return []
  }
}

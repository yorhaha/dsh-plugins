/**
 * The SQLite schema of the Xiaohongshu corpus.
 *
 * One database holds three kinds of rows: notes, their comments, and the media
 * files downloaded for a note. A standalone FTS5 table indexes notes by rowid,
 * so a note update is a delete-and-insert in the index rather than a trigger
 * the reader has to trust.
 *
 * @module dsh-xiaohongshu/src/schema
 */

/** DDL for the note corpus. */
const NOTES_DDL = `CREATE TABLE IF NOT EXISTS notes (
  rowid            INTEGER PRIMARY KEY,
  note_id          TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL DEFAULT 'normal',
  title            TEXT,
  body             TEXT,
  author_id        TEXT,
  author_name      TEXT,
  author_avatar    TEXT,
  tags_json        TEXT NOT NULL DEFAULT '[]',
  cover_url        TEXT,
  video_url        TEXT,
  published_at     TEXT,
  captured_at      TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  liked_count      INTEGER,
  collected_count  INTEGER,
  comment_count    INTEGER,
  share_count      INTEGER,
  ip_location      TEXT,
  xsec_token       TEXT,
  xsec_source      TEXT,
  url              TEXT
) STRICT`

/** DDL for comments captured with a note. */
const COMMENTS_DDL = `CREATE TABLE IF NOT EXISTS comments (
  rowid             INTEGER PRIMARY KEY,
  comment_id        TEXT NOT NULL UNIQUE,
  note_id           TEXT NOT NULL,
  parent_comment_id TEXT,
  author_id         TEXT,
  author_name       TEXT,
  author_avatar     TEXT,
  content           TEXT NOT NULL,
  like_count        INTEGER,
  created_at        TEXT,
  captured_at       TEXT NOT NULL
) STRICT`

/** DDL for downloaded image files. */
const MEDIA_DDL = `CREATE TABLE IF NOT EXISTS media (
  note_id      TEXT NOT NULL,
  position     INTEGER NOT NULL,
  url          TEXT NOT NULL,
  local_path   TEXT,
  width        INTEGER,
  height       INTEGER,
  bytes        INTEGER,
  downloaded_at TEXT,
  PRIMARY KEY (note_id, position)
) STRICT`

/** DDL for capture provenance: which query or note produced this row. */
const CAPTURES_DDL = `CREATE TABLE IF NOT EXISTS captures (
  run_id      TEXT NOT NULL,
  note_id     TEXT NOT NULL,
  source      TEXT NOT NULL,
  keyword     TEXT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (run_id, note_id)
) STRICT`

/** DDL for the single status row the page and search report. */
const STATUS_DDL = `CREATE TABLE IF NOT EXISTS status (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_capture_at TEXT,
  last_error_code TEXT,
  auth_required   INTEGER NOT NULL DEFAULT 0,
  note_count      INTEGER NOT NULL DEFAULT 0
) STRICT`

/** DDL for the bounded request audit log. */
const REQUEST_LOG_DDL = `CREATE TABLE IF NOT EXISTS request_log (
  id       INTEGER PRIMARY KEY,
  ts       TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status   INTEGER,
  code     TEXT,
  detail   TEXT
) STRICT`

/** DDL for the note full-text index. */
const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  body,
  author,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
)`

/** Secondary indexes, recreated idempotently. */
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS notes_published ON notes (published_at DESC)',
  'CREATE INDEX IF NOT EXISTS notes_captured ON notes (captured_at DESC)',
  'CREATE INDEX IF NOT EXISTS notes_author ON notes (author_id)',
  'CREATE INDEX IF NOT EXISTS comments_note ON comments (note_id)',
  'CREATE INDEX IF NOT EXISTS request_log_ts ON request_log (ts DESC)',
]

/** Every statement that creates the current schema. */
const STATEMENTS = [
  NOTES_DDL,
  COMMENTS_DDL,
  MEDIA_DDL,
  CAPTURES_DDL,
  STATUS_DDL,
  REQUEST_LOG_DDL,
  FTS_DDL,
  ...INDEXES,
]

/** The singleton key every status read and write addresses. */
export const STATUS_SINGLETON = 1

/** The status row the page shows before anything was captured. */
export const STATUS_INITIAL = Object.freeze({
  last_capture_at: null,
  last_error_code: null,
  auth_required: 0,
  note_count: 0,
})

/**
 * Create every table and index that does not exist yet.
 * @param db - an open `node:sqlite` database handle.
 */
export function applySchema(db) {
  for (const statement of STATEMENTS) db.exec(statement)
  db.prepare(
    'INSERT OR IGNORE INTO status (singleton, last_capture_at, last_error_code, auth_required, note_count) VALUES (?, ?, ?, ?, ?)',
  ).run(STATUS_SINGLETON, null, null, 0, 0)
}

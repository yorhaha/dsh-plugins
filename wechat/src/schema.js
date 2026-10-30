/**
 * The corpus schema, created once and stamped with `PRAGMA user_version`.
 *
 * Four tables: the messages themselves, one derived row per conversation, one
 * row per imported batch (yorha's immutable manifest, now a row that the next
 * import of the same batch replaces), and a small key/value table for the facts
 * that belong to neither.
 *
 * The conversations table is yorha's `contacts` index: derived, rebuildable from
 * the messages, and refreshed for the conversations an import touched. It exists
 * because "which conversation is this name" has to be answered without scanning
 * every message, both for the aggregate tool and for a search filtered by
 * conversation name.
 *
 * Generation 2 removed the columns that only restated another column of the same
 * row (`items.title` was always the chat name, `items.identity` is the prefix of
 * `source_id`) and the batch columns nothing read back — the batch directory's
 * `export_meta.json` is the record of what the exporter wrote. A corpus written
 * by generation 1 is migrated in place; only a generation this build does not
 * know is refused, because reinterpreting it would be worse than an error.
 *
 * @module dsh-wechat/src/schema
 */

/** Generation of the corpus layout in this build. */
export const SCHEMA_VERSION = 2

/** Every statement that creates generation {@link SCHEMA_VERSION}. */
const STATEMENTS = [
  `CREATE TABLE items (
    source_id       TEXT PRIMARY KEY,
    content_hash    TEXT NOT NULL,
    fallback_base   TEXT,
    duplicate_index INTEGER NOT NULL,
    import_id       TEXT NOT NULL,
    kind            TEXT NOT NULL,
    ts              TEXT NOT NULL,
    ts_unix         REAL NOT NULL,
    local_day       TEXT NOT NULL,
    chat_id         TEXT NOT NULL,
    chat_name       TEXT,
    is_group        INTEGER NOT NULL,
    msg_type        INTEGER,
    direction       TEXT NOT NULL,
    is_self         INTEGER,
    real_sender_id  INTEGER,
    sender_id       TEXT,
    sender_name     TEXT,
    content         TEXT,
    actors_json     TEXT NOT NULL,
    metadata_json   TEXT NOT NULL,
    media_json      TEXT NOT NULL,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX items_chat_ts ON items (chat_id, ts_unix DESC)',
  'CREATE INDEX items_ts ON items (ts_unix DESC)',
  'CREATE INDEX items_fallback_base ON items (fallback_base) WHERE fallback_base IS NOT NULL',
  `CREATE TABLE batches (
    import_id        TEXT PRIMARY KEY,
    dir              TEXT NOT NULL,
    export_time      TEXT,
    total_messages   INTEGER,
    include_groups   INTEGER NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('imported', 'partial')),
    imported_at      TEXT NOT NULL,
    generated        INTEGER NOT NULL,
    updated          INTEGER NOT NULL,
    unchanged        INTEGER NOT NULL,
    group_skipped    INTEGER NOT NULL,
    collisions       INTEGER NOT NULL,
    suspected_replacements INTEGER NOT NULL,
    source_files_hash TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE chats (
    chat_id       TEXT PRIMARY KEY,
    name          TEXT,
    is_group      INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    text_count    INTEGER NOT NULL,
    active_days   INTEGER NOT NULL,
    first_at      TEXT NOT NULL,
    last_at       TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX chats_last_at ON chats (last_at DESC)',
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
]

/**
 * Columns generation 2 removed from `batches`: each repeated a fact of the
 * batch's own `export_meta.json`, and no read path ever used the copy.
 */
const RETIRED_BATCH_COLUMNS = [
  'shards_json',
  'chats_json',
  'files',
  'bytes',
  'range_start',
  'range_end',
  'text_messages',
  'self_sender_id',
  'chat_count',
  'importer_version',
]

/** `metadata_json` keys generation 2 stopped repeating from the row's columns. */
const RETIRED_METADATA_KEYS = [
  'import_id',
  'chat_id',
  'chat_name',
  'is_group',
  'msg_type',
  'direction',
  'is_self',
  'real_sender_id',
  'identity',
  'fallback_base',
  'duplicate_index',
]

/**
 * Create or migrate the schema.
 * @param db - An open SQLite database handle.
 * @returns whether an existing corpus was migrated, so the caller can compact it.
 * @throws when the file was written by a generation this build does not know.
 */
export function applySchema(db) {
  const stored = Number(db.prepare('PRAGMA user_version').get().user_version)
  if (stored === SCHEMA_VERSION) return { migrated: false }
  if (stored > SCHEMA_VERSION) {
    throw new Error(
      `wechat: the corpus at this path uses schema generation ${stored}, this build writes ${SCHEMA_VERSION}; ` +
        'import the batches again with a build that understands it',
    )
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    if (stored === 0) {
      for (const statement of STATEMENTS) db.exec(statement)
    } else {
      migrateFromOne(db)
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { migrated: stored !== 0 }
}

/**
 * Bring a generation-1 corpus to generation 2 in place.
 *
 * Both changes are narrowing, so nothing has to be recomputed: dropping the
 * duplicate columns loses no fact, and removing the blob keys keeps the three
 * that live nowhere else (`source_file`, `source_line`, `local_id`) plus the
 * quote fields.
 *
 * @param db - An open generation-1 database handle.
 */
function migrateFromOne(db) {
  const keys = RETIRED_METADATA_KEYS.map((key) => `'$.${key}'`).join(', ')
  db.exec(`UPDATE items SET metadata_json = json_remove(metadata_json, ${keys})`)
  db.exec('ALTER TABLE items DROP COLUMN identity')
  db.exec('ALTER TABLE items DROP COLUMN title')
  for (const column of RETIRED_BATCH_COLUMNS) db.exec(`ALTER TABLE batches DROP COLUMN ${column}`)
  db.exec("DELETE FROM meta WHERE key IN ('last_import_batch', 'last_error_at')")
}

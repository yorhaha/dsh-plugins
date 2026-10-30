/**
 * The model-facing surface: list what can be imported, import one batch, search
 * the corpus, read one message in full, aggregate conversations, and report the
 * pipeline state.
 *
 * Search, item, conversations, and status are reads over the corpus and return
 * at once. An import is seconds of parsing and writing, so above a configured
 * message count it becomes a background job and the tool returns its id; the
 * agent collects the outcome with `job_output` instead of holding the turn open.
 *
 * @module dsh-wechat/src/tools
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { errorCode } from './errors.js'
import { ensureTask, listTasks, recreateTask, scheduleOf, taskState } from './schedule.js'
import { freshness, pipelineStatus } from './status.js'

/** Default rows a search returns. */
const DEFAULT_LIMIT = 20

/** Largest rows a search returns. */
const MAX_LIMIT = 50

/** Default conversations an aggregate returns. */
const DEFAULT_CHAT_LIMIT = 30

/** Largest conversations an aggregate returns. */
const MAX_CHAT_LIMIT = 200

/** Characters of context a snippet carries around a match. */
const SNIPPET_CHARS = 200

/** Deadline for the read-only tools; none of them touches the network. */
const READ_TIMEOUT_MS = 15_000

/** Deadline for an import that runs inside the tool call. */
const IMPORT_TIMEOUT_MS = 240_000

/** Nullable scalar, as the harness's enforced JSON Schema subset expresses it. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** Nullable count. */
const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] }

/** One search row. */
const SEARCH_ROW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Message identity; pass it to wechat_item for the whole record.' },
    ts: { type: 'string', description: 'Message time, ISO-8601 UTC.' },
    localDay: { type: 'string', description: 'Calendar day in the configured zone.' },
    chatId: { type: 'string' },
    chatName: NULLABLE_STRING,
    isGroup: { type: 'boolean' },
    kind: { type: 'string', description: 'Message class, such as text, image, voice, or quote.' },
    direction: { type: 'string', enum: ['inbound', 'outbound', 'system', 'unknown'] },
    sender: NULLABLE_STRING,
    snippet: { type: 'string', description: 'Text around the match, or the start of the body.' },
    media: { type: 'array', items: { type: 'string' }, description: 'Media kinds this message refers to.' },
  },
  required: ['id', 'ts', 'localDay', 'chatId', 'isGroup', 'kind', 'direction', 'snippet', 'media'],
  additionalProperties: false,
}

/** Freshness of the corpus, attached to every read result. */
const STATE_SCHEMA = {
  type: 'object',
  properties: {
    lastImportedAt: {
      ...NULLABLE_STRING,
      description: 'When a batch was last imported successfully.',
    },
    pendingBatches: {
      type: 'number',
      description: 'Complete batches in the archive that no import has taken yet.',
    },
    databaseNewerThanImport: {
      type: 'boolean',
      description: 'True when WeChat itself changed after the last import, so a fresh export would add messages.',
    },
    importFailed: { type: 'boolean', description: 'True when the last import attempt failed.' },
  },
  required: ['lastImportedAt', 'pendingBatches', 'databaseNewerThanImport', 'importFailed'],
  additionalProperties: false,
}

/** One stored message with its media resolved. */
const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    sourceId: { type: 'string' },
    importId: { type: 'string', description: 'Batch this message was last written by.' },
    identity: { type: 'string', enum: ['local_id', 'fingerprint'] },
    ts: { type: 'string' },
    localDay: { type: 'string' },
    chatId: { type: 'string' },
    chatName: NULLABLE_STRING,
    isGroup: { type: 'boolean' },
    kind: { type: 'string' },
    msgType: NULLABLE_NUMBER,
    direction: { type: 'string' },
    isSelf: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
    senderId: NULLABLE_STRING,
    senderName: NULLABLE_STRING,
    content: { type: 'string' },
    actors: { type: 'array' },
    metadata: { type: 'object' },
    media: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          sha256: NULLABLE_STRING,
          size: NULLABLE_NUMBER,
          path: NULLABLE_STRING,
          absolutePath: { ...NULLABLE_STRING, description: 'Read this path to look at the image itself.' },
          available: { type: 'boolean' },
          metadata: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        },
        required: ['type', 'available'],
        additionalProperties: false,
      },
    },
    contentHash: { type: 'string' },
    firstSeenAt: { type: 'string' },
    lastSeenAt: { type: 'string' },
  },
  required: ['sourceId', 'importId', 'identity', 'ts', 'localDay', 'chatId', 'isGroup', 'kind', 'direction', 'content'],
  additionalProperties: false,
}

/** One batch row. */
const BATCH_ROW_SCHEMA = {
  type: 'object',
  properties: {
    batch: { type: 'string' },
    dir: { type: 'string' },
    state: {
      type: 'string',
      description: 'pending, imported, partial (private messages only), invalid, or incomplete.',
    },
    exportTime: NULLABLE_STRING,
    chatCount: NULLABLE_NUMBER,
    totalMessages: NULLABLE_NUMBER,
    invalid: NULLABLE_STRING,
    importedAt: NULLABLE_STRING,
    includeGroups: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
    storedMessages: NULLABLE_NUMBER,
    groupSkipped: NULLABLE_NUMBER,
    generated: NULLABLE_NUMBER,
    updated: NULLABLE_NUMBER,
    unchanged: NULLABLE_NUMBER,
    suspectedReplacements: NULLABLE_NUMBER,
  },
  required: ['batch', 'dir', 'state'],
  additionalProperties: false,
}

/** Render a tool value as the single JSON text block the model reads. */
function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Build the object-rooted parameter schema for one tool.
 * @param properties - Declared arguments.
 * @param required - Argument names the model must supply.
 * @returns the parameter schema.
 */
function parameters(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

/**
 * Read one string argument.
 * @param args - Raw tool arguments.
 * @param key - Argument name.
 * @returns the value, or undefined when absent or not a usable string.
 */
function readString(args, key) {
  const value = args?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Clamp a requested row count into the accepted window.
 * @param value - Raw argument.
 * @param max - Largest accepted value.
 * @param fallback - Value to use when the argument is absent or unusable.
 * @returns the row count.
 */
function clampLimit(value, max, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(Math.max(value, 1), max)
}

/**
 * Clamp a requested offset.
 * @param value - Raw argument.
 * @returns the offset.
 */
function clampOffset(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0
  return value
}

/**
 * Window of body text around the first match.
 * @param body - The stored content.
 * @param needle - Lowercase query, or null when there is none.
 * @returns the snippet.
 */
function snippetOf(body, needle) {
  const text = typeof body === 'string' ? body : ''
  if (text === '') return ''
  const at = needle === null ? -1 : text.toLowerCase().indexOf(needle)
  const start = at === -1 ? 0 : Math.max(0, at - Math.floor(SNIPPET_CHARS / 3))
  const end = Math.min(text.length, start + SNIPPET_CHARS)
  const window = text.slice(start, end).replaceAll('\n', ' / ')
  return `${start > 0 ? '…' : ''}${window}${end < text.length ? '…' : ''}`
}

/**
 * Build the six tool definitions.
 * @param options - Construction options.
 * @param options.store - The corpus handle.
 * @param options.importer - The import runner.
 * @param options.options - Resolved plugin options.
 * @param options.clock - The zone-bound clock.
 * @param options.jobs - The job registry, when the composition provides one.
 * @param options.logger - Plugin logger.
 * @returns the tool definitions, in registration order.
 */
export function buildTools({ ctx, store, importer, options, clock, jobs, logger }) {
  /** The full probe, for `wechat_status` and the plugin page. */
  const statusNow = () => pipelineStatus({ store, options, clock, batches: importer.listBatches() })
  /** The freshness block read results carry; it never scans the messages. */
  const stateNow = () => freshness({ store, options, batches: importer.listBatches() })

  /**
   * Resolve stored media against the batch that wrote the record.
   * @param item - A stored message.
   * @param batchDirs - Import id to directory.
   * @returns the media references, with a readable path when the file is there.
   */
  const resolveMedia = (item, batchDirs) => {
    const dir = batchDirs.get(item.importId) ?? null
    return item.media.map((ref) => {
      if (ref.type !== 'image') {
        return { type: ref.type, available: true, metadata: ref.metadata ?? null }
      }
      const absolutePath = dir === null || typeof ref.path !== 'string' ? null : join(dir, ref.path)
      return {
        type: 'image',
        sha256: ref.sha256 ?? null,
        size: ref.size ?? null,
        path: ref.path ?? null,
        absolutePath,
        available: absolutePath !== null && existsSync(absolutePath),
        metadata: null,
      }
    })
  }

  /** Batch directories, read once per call that resolves media. */
  const batchDirMap = () => new Map(store.batchDirs().map((row) => [row.import_id, row.dir]))

  return [
    {
      name: 'wechat_batches',
      description:
        'List the WeChat export batches on this machine: the archive of batches already imported and the batches the exporter has written but no import has taken yet. '
        + 'A batch is a directory holding export_meta.json; state pending means it is complete and waiting, partial means only private conversations were imported, invalid or incomplete means the exporter has not finished it or its metadata is unusable. '
        + 'Pass a batch name to wechat_import to import it.',
      parameters: parameters({}),
      output: {
        schema: {
          type: 'object',
          properties: {
            batches: { type: 'array', items: BATCH_ROW_SCHEMA },
            state: STATE_SCHEMA,
          },
          required: ['batches', 'state'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: 'WeChat batches', kind: 'read', rawInput: args }),
      execute: () => ({
        batches: importer.listBatches().map((row) => ({
          batch: row.batch,
          dir: row.dir,
          state: row.state,
          exportTime: row.exportTime,
          chatCount: row.chatCount,
          totalMessages: row.totalMessages,
          invalid: row.invalid,
          importedAt: row.importedAt,
          includeGroups: row.includeGroups,
          storedMessages: row.storedMessages,
          groupSkipped: row.groupSkipped,
          generated: row.generated,
          updated: row.updated,
          unchanged: row.unchanged,
          suspectedReplacements: row.suspectedReplacements,
        })),
        state: stateNow(),
      }),
    },
    {
      name: 'wechat_import',
      description:
        'Import one WeChat export batch into the local corpus. Name a batch from wechat_batches, pass an absolute path to a batch directory, or pass "latest" to take the newest complete batch the exporter wrote. '
        + 'A batch is imported in place and kept: the directory is the raw record, and importing the same batch again is a no-op that only adds what is new. '
        + 'Private conversations are imported by default; group messages are the bulk of a real export and need includeGroups. '
        + 'A large batch imports as a background job that returns a job id immediately; read the job for the outcome.',
      parameters: parameters({
        batch: { type: 'string', description: 'Batch name from wechat_batches.' },
        source: {
          type: 'string',
          description: 'An absolute path to a batch directory, or "latest" for the newest complete batch the exporter wrote.',
        },
        includeGroups: { type: 'boolean', description: 'Import group messages too, not only private conversations.' },
        copy: {
          type: 'boolean',
          description: 'Copy an outside batch into the archive root under its own name before importing it. Defaults to false: the batch is imported where it is.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            status: { type: 'string', enum: ['started', 'completed', 'failed', 'skipped'] },
            jobId: { ...NULLABLE_STRING, description: 'Background job to read for the outcome, when the import did not run inline.' },
            reason: NULLABLE_STRING,
            batch: NULLABLE_STRING,
            dir: NULLABLE_STRING,
            copied: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
            outsideArchive: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
            firstImport: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
            includeGroups: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
            state: NULLABLE_STRING,
            files: NULLABLE_NUMBER,
            bytes: NULLABLE_NUMBER,
            messages: NULLABLE_NUMBER,
            groupSkipped: NULLABLE_NUMBER,
            collisions: NULLABLE_NUMBER,
            suspectedReplacements: NULLABLE_NUMBER,
            generated: NULLABLE_NUMBER,
            updated: NULLABLE_NUMBER,
            unchanged: NULLABLE_NUMBER,
            chatCount: NULLABLE_NUMBER,
            totalMessages: NULLABLE_NUMBER,
            exportTime: NULLABLE_STRING,
            elapsedMs: NULLABLE_NUMBER,
          },
          required: ['ok', 'status', 'jobId', 'reason'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: IMPORT_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      presentCall: (args) => ({ card: 'generic', title: 'WeChat import', kind: 'write', rawInput: args }),
      execute: (args, exec) => startImport({ importer, options, jobs, logger, args, exec }),
    },
    {
      name: 'wechat_search',
      description:
        'Search the locally imported WeChat messages: what was said in a conversation, by a participant, or in a window of time. '
        + 'The match is a case-insensitive substring of the message text and of the stored upstream fields, so a name, a phrase, a number, or an id all work. '
        + 'Every result reports the freshness of the corpus, so a stale or pending batch is visible where the model is already looking.',
      parameters: parameters({
        query: {
          type: 'string',
          description: 'Text to match anywhere in a message: its body, its conversation, a participant, or an upstream field. Omit it to browse by the other filters.',
        },
        chat: { type: 'string', description: 'Conversation id, or part of a conversation name.' },
        kind: { type: 'string', description: 'Restrict to one message class, such as text, image, voice, quote, link, or system.' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'system', 'unknown'], description: 'Restrict to one direction.' },
        sender: { type: 'string', description: 'Part of a sender name or id.' },
        since: { type: 'string', description: 'Earliest message time, as an ISO-8601 date or date-time. A date means local midnight.' },
        until: { type: 'string', description: 'Exclusive upper bound on the message time, same forms as since.' },
        limit: { type: 'integer', description: `Rows to return, from 1 to ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.` },
        offset: { type: 'integer', description: 'Rows to skip after ordering, for reading past the first page.' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'number', description: 'Messages matching every filter, before the window.' },
            returned: { type: 'number' },
            items: { type: 'array', items: SEARCH_ROW_SCHEMA },
            state: STATE_SCHEMA,
          },
          required: ['total', 'returned', 'items', 'state'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: 'WeChat search', kind: 'search', rawInput: args }),
      execute: (args) => {
        const query = readString(args, 'query')
        const needle = query === undefined ? null : query.toLowerCase()
        const result = store.search({
          query,
          chat: readString(args, 'chat'),
          kind: readString(args, 'kind'),
          direction: readString(args, 'direction'),
          sender: readString(args, 'sender'),
          since: instantArg(clock, readString(args, 'since')),
          until: instantArg(clock, readString(args, 'until')),
          limit: clampLimit(args?.limit, MAX_LIMIT, DEFAULT_LIMIT),
          offset: clampOffset(args?.offset),
        })
        return {
          total: result.total,
          returned: result.rows.length,
          items: result.rows.map((row) => ({
            id: row.sourceId,
            ts: row.ts,
            localDay: row.localDay,
            chatId: row.chatId,
            chatName: row.chatName,
            isGroup: row.isGroup,
            kind: row.kind,
            direction: row.direction,
            sender: row.senderName,
            snippet: snippetOf(row.content, needle),
            media: row.mediaTypes,
          })),
          state: stateNow(),
        }
      },
    },
    {
      name: 'wechat_item',
      description:
        'Read one imported WeChat message in full, including every field the import kept and the media it refers to. Use the id a search returned; for an image, the absolute path can be read to look at the picture itself.',
      parameters: parameters({ id: { type: 'string', description: 'The message id a search returned.' } }, ['id']),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            item: { oneOf: [{ type: 'null' }, ITEM_SCHEMA] },
          },
          required: ['found', 'item'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: 'WeChat message', kind: 'read', rawInput: args }),
      execute: (args) => {
        const id = readString(args, 'id')
        const item = id === undefined ? undefined : store.item(id)
        if (item === undefined) return { found: false, item: null }
        return {
          found: true,
          item: {
            sourceId: item.sourceId,
            importId: item.importId,
            identity: item.identity,
            ts: item.ts,
            localDay: item.localDay,
            chatId: item.chatId,
            chatName: item.chatName,
            isGroup: item.isGroup,
            kind: item.kind,
            msgType: item.msgType,
            direction: item.direction,
            isSelf: item.isSelf,
            senderId: item.senderId,
            senderName: item.senderName,
            content: item.content ?? '',
            actors: item.actors,
            metadata: item.metadata,
            media: resolveMedia(item, batchDirMap()),
            contentHash: item.contentHash,
            firstSeenAt: item.firstSeenAt,
            lastSeenAt: item.lastSeenAt,
          },
        }
      },
    },
    {
      name: 'wechat_chats',
      description:
        'Aggregate the imported WeChat conversations: how many messages each holds, how many days it was active, and when it started and last moved. '
        + 'Use it to find who to search in; it filters conversations by name or id rather than by message text. '
        + 'For one conversation it also returns a digest of its messages, for deciding whether a summary written earlier is still current.',
      parameters: parameters({
        chat: { type: 'string', description: 'Conversation id, or part of a conversation name.' },
        since: { type: 'string', description: 'Count only messages at or after this time.' },
        until: { type: 'string', description: 'Count only messages before this time.' },
        limit: { type: 'integer', description: `Conversations to return, from 1 to ${MAX_CHAT_LIMIT}. Defaults to ${DEFAULT_CHAT_LIMIT}.` },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            chats: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  chatId: { type: 'string' },
                  name: NULLABLE_STRING,
                  isGroup: { type: 'boolean' },
                  messageCount: { type: 'number' },
                  textCount: { type: 'number' },
                  activeDays: { type: 'number' },
                  firstAt: { type: 'string' },
                  lastAt: { type: 'string' },
                },
                required: ['chatId', 'isGroup', 'messageCount', 'textCount', 'activeDays', 'firstAt', 'lastAt'],
                additionalProperties: false,
              },
            },
            state: STATE_SCHEMA,
          },
          required: ['chats', 'state'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: 'WeChat conversations', kind: 'search', rawInput: args }),
      execute: (args) => {
        const chat = readString(args, 'chat')
        const rows = store.chats({
          chat,
          since: instantArg(clock, readString(args, 'since')),
          until: instantArg(clock, readString(args, 'until')),
          limit: clampLimit(args?.limit, MAX_CHAT_LIMIT, DEFAULT_CHAT_LIMIT),
        })
        return { chats: rows, state: stateNow() }
      },
    },
    {
      name: 'wechat_status',
      description:
        'Report where the WeChat import pipeline stands: the machine\'s WeChat database and how recently it changed, whether the exporter\'s key file covers it, the newest batch the exporter wrote, what the archive holds, and how the last import went. '
        + 'Read-only: it never writes, and it reports key field names but never key values.',
      parameters: parameters({}),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            status: {
              type: 'string',
              description: 'action_required, import_pending, updates_available, notice, unreadable, empty, or ok.',
            },
            database: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                shard_count: NULLABLE_NUMBER,
                shards: { type: 'array', items: { type: 'string' } },
                latest_change_at: NULLABLE_STRING,
              },
              required: ['status'],
              additionalProperties: false,
            },
            keys: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                file_updated_at: NULLABLE_STRING,
                message_keys: { type: 'array', items: { type: 'string' } },
                contact_key: { type: 'boolean' },
                session_key: { type: 'boolean' },
                message_shards_total: NULLABLE_NUMBER,
                message_shards_covered: NULLABLE_NUMBER,
              },
              required: ['status'],
              additionalProperties: false,
            },
            export: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                batch: NULLABLE_STRING,
                export_time: NULLABLE_STRING,
                timezone_assumed: { type: 'boolean' },
                shards_processed: { type: 'array', items: { type: 'string' } },
                chat_count: NULLABLE_NUMBER,
                total_messages: NULLABLE_NUMBER,
                invalid_batches: { type: 'number' },
                text_only_batches: { type: 'number' },
              },
              required: ['status'],
              additionalProperties: false,
            },
            batches: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                pending: { type: 'array', items: { type: 'string' } },
                imported: { type: 'array', items: { type: 'string' } },
                invalid: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { batch: { type: 'string' }, reason: NULLABLE_STRING },
                    required: ['batch'],
                    additionalProperties: false,
                  },
                },
                total: { type: 'number' },
              },
              required: ['status'],
              additionalProperties: false,
            },
            import: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                last_success_at: NULLABLE_STRING,
                batch: NULLABLE_STRING,
                imported_at: NULLABLE_STRING,
                export_time: NULLABLE_STRING,
                messages: NULLABLE_NUMBER,
                generated: NULLABLE_NUMBER,
                updated: NULLABLE_NUMBER,
                unchanged: NULLABLE_NUMBER,
                group_skipped: NULLABLE_NUMBER,
                suspected_replacements: NULLABLE_NUMBER,
                last_error_code: NULLABLE_STRING,
                database_newer_than_import: { type: 'boolean' },
              },
              required: ['status'],
              additionalProperties: false,
            },
            corpus: {
              type: 'object',
              properties: {
                messages: { type: 'number' },
                chats: { type: 'number' },
                database_path: { type: 'string' },
                database_bytes: { type: 'number' },
                kinds: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { kind: { type: 'string' }, count: { type: 'number' } },
                    required: ['kind', 'count'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['messages', 'chats', 'database_path', 'database_bytes', 'kinds'],
              additionalProperties: false,
            },
            signals: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  covered: NULLABLE_NUMBER,
                  total: NULLABLE_NUMBER,
                  count: NULLABLE_NUMBER,
                  error: NULLABLE_STRING,
                  batches: { type: 'array', items: { type: 'string' } },
                  batch: NULLABLE_STRING,
                },
                required: ['code'],
                additionalProperties: false,
              },
            },
          },
          required: ['ok', 'status', 'database', 'keys', 'export', 'batches', 'import', 'corpus', 'signals'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: 'WeChat pipeline', kind: 'read', rawInput: args }),
      execute: () => statusNow(),
    },
    {
      name: 'wechat_schedule',
      description:
        'Set up, or restore, the recurring WeChat import in the Automation tasks list. '
        + "The task belongs to the conversation that creates it and reports back there, so it resumes that conversation to run the exporter and import what it wrote. "
        + 'A user who deletes the task there does not get it back automatically; call this again to restore it.',
      parameters: parameters({
        recreate: {
          type: 'boolean',
          description: 'Replace the existing import task with a fresh one. Leave it unset to keep an existing task as it is.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            status: { type: 'string', enum: ['created', 'exists', 'recreated', 'unavailable', 'failed'] },
            taskId: NULLABLE_STRING,
            nextRunAt: { ...NULLABLE_STRING, description: 'When the task next runs.' },
            reason: { ...NULLABLE_STRING, description: 'Why the task could not be set up.' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'string', enum: ['active', 'inactive'] },
                  kind: { type: 'string' },
                  nextRunAt: { type: 'string' },
                },
                required: ['id', 'title', 'status'],
                additionalProperties: false,
              },
            },
          },
          required: ['ok', 'status', 'tasks'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      presentCall: (args) => ({ card: 'generic', title: 'WeChat import task', kind: 'write', rawInput: args }),
      execute: (args, exec) => setUpSchedule({ ctx, options, args, exec }),
    },
  ]
}

/**
 * Create or restore the recurring import task.
 *
 * @param run - Run options.
 * @param run.ctx - Plugin context.
 * @param run.options - Resolved plugin options.
 * @param run.args - Raw tool arguments.
 * @param run.exec - Tool execution context.
 * @returns the tool value.
 */
async function setUpSchedule({ ctx, options, args, exec }) {
  const sessionId = exec?.agent?.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, status: 'unavailable', taskId: null, nextRunAt: null, reason: 'no_session', tasks: [] }
  }
  if (scheduleOf(ctx) === undefined) {
    return { ok: false, status: 'unavailable', taskId: null, nextRunAt: null, reason: 'schedule_unavailable', tasks: [] }
  }
  const before = await listTasks(ctx)
  const recreate = args?.recreate === true
  try {
    const task = recreate ? await recreateTask(ctx, sessionId, options) : await ensureTask(ctx, sessionId, options)
    const state = await taskState(ctx)
    return {
      ok: true,
      status: recreate ? 'recreated' : before.length > 0 ? 'exists' : 'created',
      taskId: String(task.id),
      nextRunAt: task.scheduledAt,
      reason: null,
      tasks: state.tasks,
    }
  } catch (error) {
    return { ok: false, status: 'failed', taskId: null, nextRunAt: null, reason: errorCode(error), tasks: [] }
  }
}

/**
 * Convert an ISO argument into seconds since the epoch.
 * @param clock - The zone-bound clock.
 * @param text - The argument, or undefined.
 * @returns the instant in seconds, or undefined when absent or unreadable.
 */
function instantArg(clock, text) {
  if (text === undefined) return undefined
  const millis = clock.instantOf(text)
  return millis === null ? undefined : millis / 1000
}

/**
 * Start an import, as a background job when the composition provides a registry
 * and the batch is large, and inline otherwise.
 * @param options - Run options.
 * @param options.importer - The import runner.
 * @param options.options - Resolved plugin options.
 * @param options.jobs - The job registry, when present.
 * @param options.logger - Plugin logger.
 * @param options.args - Raw tool arguments.
 * @param options.exec - Tool execution context.
 * @returns the tool value.
 */
async function startImport({ importer, options, jobs, logger, args, exec }) {
  const request = {
    batch: readString(args, 'batch'),
    source: readString(args, 'source'),
    copy: args?.copy === true,
    includeGroups: args?.includeGroups === undefined ? undefined : args.includeGroups === true,
  }
  let planned
  try {
    planned = importer.plan(request)
  } catch (error) {
    return failedImport(errorCode(error), error.message)
  }
  const large = jobs !== undefined && (planned.totalMessages ?? 0) > options.inlineImportLimit
  if (!large) {
    try {
      const result = await importer.queue(() => importer.run({ ...request, signal: exec?.signal }))
      return summarise(result)
    } catch (error) {
      logger?.warn?.(`wechat: import failed: ${errorCode(error)}`)
      return failedImport(errorCode(error), error.message)
    }
  }
  const id = jobs.start({
    kind: 'wechat-import',
    label: `WeChat import (${planned.importId})`,
    ...(exec?.agent ? { owner: exec.agent.id } : {}),
    run: (job) => {
      const controller = new AbortController()
      job.updateProgress('starting')
      const done = importer
        .queue(() =>
          importer.run({
            ...request,
            signal: controller.signal,
            onProgress: (event) => job.updateProgress(event.message),
          }),
        )
        .then((result) => {
          job.append(`${JSON.stringify(summarise(result))}\n`)
          return {
            // A skipped run imported nothing; reporting it as completed would
            // let a lock held by another process look like a finished import.
            status: result.skipped === true || result.ok !== true ? 'failed' : 'completed',
            detail: result.skipped === true ? `skipped: ${result.reason}` : undefined,
            result: JSON.stringify(summarise(result)),
          }
        })
        .catch((error) => {
          logger?.warn?.(`wechat: import job failed: ${String(error)}`)
          return { status: 'failed', detail: errorCode(error) }
        })
      return { done, cancel: () => controller.abort() }
    },
  })
  return { ok: true, status: 'started', jobId: String(id), reason: null, batch: planned.importId }
}

/**
 * Project an import result into the tool value.
 * @param result - The runner's return value.
 * @returns the tool value.
 */
function summarise(result) {
  if (result.skipped === true) {
    return { ok: false, status: 'skipped', jobId: null, reason: result.reason, batch: null }
  }
  return {
    ok: true,
    status: 'completed',
    jobId: null,
    reason: null,
    batch: result.batch,
    dir: result.dir,
    copied: result.copied,
    outsideArchive: result.outsideArchive,
    firstImport: result.firstImport,
    includeGroups: result.includeGroups,
    state: result.state,
    files: result.files,
    bytes: result.bytes,
    messages: result.messages,
    groupSkipped: result.groupSkipped,
    collisions: result.collisions,
    suspectedReplacements: result.suspectedReplacements,
    generated: result.generated,
    updated: result.updated,
    unchanged: result.unchanged,
    chatCount: result.chatCount,
    totalMessages: result.totalMessages,
    exportTime: result.exportTime,
    elapsedMs: result.elapsedMs,
  }
}

/**
 * A failure the model can act on, with every field its schema declares.
 * @param code - Stable failure code.
 * @param message - Actionable text.
 * @returns the tool value.
 */
function failedImport(code, message) {
  return { ok: false, status: 'failed', jobId: null, reason: `${code}: ${message}`, batch: null }
}

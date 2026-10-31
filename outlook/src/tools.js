/**
 * The model-facing surface: start a capture, search the corpus, read one record
 * in full, and manage the recurring capture task.
 *
 * Search and item are reads over the local corpus and return at once. A capture
 * is minutes of rate-limited upstream calls, so where the composition provides a
 * job registry the tool registers a background job and returns its id; the agent
 * collects the outcome from the job instead of holding the turn open.
 *
 * Every search result carries the corpus's freshness, so "what was captured last
 * is a day old" appears where the model is already looking rather than requiring
 * a second call to discover.
 *
 * @module dsh-outlook/src/tools
 */

import { ensureTask, listTasks, recreateTask, scheduleOf, taskState } from './schedule.js'
import { composeMessage, sendMail } from './send.js'
import { STALE_AFTER_MS } from './store.js'
import { errorCode } from './sync.js'
import { parseGraphDateTime } from './time.js'

/** Default rows a search returns. */
const DEFAULT_LIMIT = 20

/** Largest rows a search returns. */
const MAX_LIMIT = 50

/** Deadline for the read-only tools, which never touch the network. */
const READ_TIMEOUT_MS = 15_000

/** Deadline for the sync tool; the background path returns immediately. */
const SYNC_TIMEOUT_MS = 240_000

/** Deadline for sending one message: a single Graph request. */
const SEND_TIMEOUT_MS = 60_000

/** Nullable scalar, as the harness's enforced JSON Schema subset expresses it. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** One search row. */
const ITEM_ROW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Corpus identity; pass it to outlook_item for the full record.' },
    ts: { ...NULLABLE_STRING, description: 'When the message was received, ISO-8601 UTC.' },
    title: NULLABLE_STRING,
    sender: { ...NULLABLE_STRING, description: 'Who sent the message.' },
    url: { ...NULLABLE_STRING, description: 'Web page for the message in Outlook, when the capture recorded one.' },
    snippet: { ...NULLABLE_STRING, description: 'Text around the match, when the query matched the body.' },
    thread: { ...NULLABLE_STRING, description: 'The conversation id shared by every message in the thread.' },
  },
  required: ['id'],
  additionalProperties: false,
}

/** Freshness of the corpus, attached to every search result. */
const SYNC_STATE_SCHEMA = {
  type: 'object',
  properties: {
    lastRunAt: { ...NULLABLE_STRING, description: 'When the last capture attempt started.' },
    stale: { type: 'boolean', description: 'True when the newest successful capture is over a day old, or none ever ran.' },
    running: { type: 'boolean', description: 'True while a capture is in progress.' },
    configured: { type: 'boolean', description: 'True when an Azure app client id is set. False means no capture can run until one is.' },
    authRequired: { type: 'boolean', description: 'True when a capture was refused because no usable sign-in is stored.' },
  },
  required: ['stale', 'running', 'configured', 'authRequired'],
  additionalProperties: false,
}

/**
 * Render a tool value as the single JSON text block the model reads.
 * @param _args - Raw tool arguments, unused.
 * @param value - The tool value.
 * @returns the content blocks.
 */
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
 * @returns the value, or undefined when absent or not a string.
 */
function readString(args, key) {
  const value = args?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Normalize a search bound to the ISO-8601 UTC form the corpus stores.
 *
 * A bound that carries an offset or `Z` is an instant and is taken as written. A
 * bare date is that day's midnight in `zone`, and a bare reading is that wall
 * clock in `zone`: the corpus compares instants, so a local day has to be
 * resolved into one here rather than compared as text.
 *
 * @param value - Raw argument.
 * @param zone - IANA zone a bound without an offset is read in.
 * @returns the instant, or undefined when absent.
 * @throws when the value is present but is not a date or date-time.
 */
function instantOf(value, zone) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new Error('a search bound must be an ISO-8601 date or date-time')
  }
  const instant = parseGraphDateTime(value, zone)
  if (instant === null) {
    throw new Error(`"${value}" is not an ISO-8601 date or date-time`)
  }
  return instant
}

/**
 * Compact one stored record into a search row.
 * @param row - A row from the corpus search.
 * @returns the row the model reads.
 */
function toRow(row) {
  return {
    id: row.id,
    ts: row.ts,
    title: row.title,
    sender: row.sender,
    url: row.metadata?.webLink ?? null,
    snippet: row.snippet,
    thread: row.contentKey,
  }
}

/**
 * Freshness block attached to search results.
 * @param store - The corpus handle.
 * @param syncer - The capture runner.
 * @param configured - Whether an Azure app client id is set.
 * @param now - Current instant in milliseconds.
 * @returns the sync state.
 */
function syncState(store, syncer, configured, now) {
  const status = store.status()
  const lastSuccessAt = latestSuccess(store)
  return {
    lastRunAt: status.lastRunAt,
    // Freshness follows the last capture that actually stored something: a run
    // that failed leaves the corpus exactly as old as it already was.
    stale: lastSuccessAt === null || now - Date.parse(lastSuccessAt) > STALE_AFTER_MS,
    running: syncer.busy,
    configured,
    authRequired: status.authRequired,
  }
}

/**
 * Most recent successful capture.
 * @param store - The corpus handle.
 * @returns the ISO-8601 instant, or null when no capture ever succeeded.
 */
function latestSuccess(store) {
  const at = store.mailState()?.lastSuccessAt
  return typeof at === 'string' ? at : null
}

/**
 * Clamp a requested row count into the accepted window.
 * @param value - Raw argument.
 * @returns the row count.
 */
function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_LIMIT
  return Math.min(Math.max(value, 1), MAX_LIMIT)
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
 * The zone a cron expression is evaluated in, read from the host so the caller
 * never has to state what the machine already knows.
 * @returns an IANA zone name.
 */
function pluginTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * Build the tool definitions.
 * @param options - Construction options.
 * @param options.ctx - Plugin context, for the schedule service.
 * @param options.store - The corpus handle.
 * @param options.syncer - The capture runner.
 * @param options.auth - Sign-in state.
 * @param options.jobs - The job registry, when the composition provides one.
 * @param options.config - Live plugin configuration.
 * @param options.createClient - Builds an authenticated Graph client for one request.
 * @param options.clock - Current instant in milliseconds.
 * @param options.zone - IANA zone a time argument without an offset is read in.
 * @param options.logger - Plugin logger.
 * @returns the tool definitions, in registration order.
 */
export function buildTools({ ctx, store, syncer, auth, jobs, config, createClient, clock = Date.now, zone = pluginTimeZone, logger, shutdownSignal }) {
  return [
    {
      name: 'outlook_sync',
      description:
        'Capture this account\'s Outlook mail into the local corpus. '
        + 'Incremental from the last capture. '
        + 'Rate-limited, so a run may continue as a background job.',
      parameters: parameters({
        backfill: {
          type: 'boolean',
          description: 'Walk backwards before the oldest captured message instead of forwards from the newest. Set it for a first deep capture or a long gap; each run walks a bounded number of pages.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            status: { type: 'string', enum: ['started', 'completed', 'failed', 'skipped'] },
            jobId: { ...NULLABLE_STRING, description: 'Background job to read for progress and the final outcome.' },
            reason: { ...NULLABLE_STRING, description: 'Why a skipped or failed run captured nothing.' },
            pages: { type: 'number', description: 'Pages of messages this run walked.' },
            written: { type: 'number', description: 'Messages this run stored or updated.' },
            unchanged: { type: 'number', description: 'Messages re-read that had not changed.' },
            removed: { type: 'number', description: 'Stored messages this run dropped, such as one filed in an excluded folder.' },
            errorCodes: { type: 'array', items: { type: 'string' } },
          },
          required: ['ok', 'status'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: SYNC_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: 'Outlook sync',
        kind: 'fetch',
        rawInput: args,
      }),
      execute: (args, exec) => startSync({ syncer, jobs, logger, auth, args, exec, shutdownSignal }),
    },
    {
      name: 'outlook_search',
      description:
        'Search the locally captured Outlook mail. '
        + 'Matches are word- or phrase-level over subject, body, and participants; Chinese text matches on any run of characters. '
        + 'Results are newest first and report corpus freshness.',
      parameters: parameters({
        query: {
          type: 'string',
          description: 'Text to match in the subject, body, or participants. Omit it to browse by the other filters.',
        },
        since: {
          type: 'string',
          description:
            'Earliest received time to include, as an ISO-8601 date or date-time. '
            + 'A date means that day\'s midnight in the zone this plugin reads times in (config.timeZone, or the host\'s own zone), and a date-time without an offset is read there too; '
            + 'a value carrying an offset or Z is taken as written. Messages without a received time are excluded.',
        },
        until: {
          type: 'string',
          description: 'Exclusive upper bound on the received time, read the same way as since.',
        },
        from: {
          type: 'string',
          description: 'Substring of a participant name or address to require, such as a sender or a recipient.',
        },
        limit: {
          type: 'integer',
          description: `Rows to return, from 1 to ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
        },
        offset: {
          type: 'integer',
          description: 'Rows to skip after ordering, for reading past the first page.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'number', description: 'Records matching every filter, before the window.' },
            returned: { type: 'number' },
            items: { type: 'array', items: ITEM_ROW_SCHEMA },
            sync: SYNC_STATE_SCHEMA,
          },
          required: ['total', 'returned', 'items', 'sync'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: 'Outlook search',
        kind: 'search',
        rawInput: args,
      }),
      execute: (args) => {
        const result = store.search({
          query: readString(args, 'query'),
          since: instantOf(args?.since, zone()),
          until: instantOf(args?.until, zone()),
          from: readString(args, 'from'),
          limit: clampLimit(args?.limit),
          offset: clampOffset(args?.offset),
        })
        return {
          total: result.total,
          returned: result.rows.length,
          items: result.rows.map(toRow),
          sync: syncState(store, syncer, auth.configured, clock()),
        }
      },
    },
    {
      name: 'outlook_item',
      description:
        'Read one captured Outlook message in full, with its body and stored fields.',
      parameters: parameters(
        {
          id: { type: 'string', description: 'The item id a search returned.' },
        },
        ['id'],
      ),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            item: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    kind: { type: 'string' },
                    ts: NULLABLE_STRING,
                    title: NULLABLE_STRING,
                    sender: NULLABLE_STRING,
                    body: NULLABLE_STRING,
                    url: NULLABLE_STRING,
                    actors: { type: 'array', items: { type: 'object' } },
                    metadata: { type: 'object' },
                    thread: NULLABLE_STRING,
                    firstSeenAt: { type: 'string' },
                    lastSeenAt: { type: 'string' },
                  },
                  required: ['id', 'kind'],
                  additionalProperties: false,
                },
              ],
            },
          },
          required: ['found'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: 'Outlook item',
        kind: 'read',
        rawInput: args,
      }),
      execute: (args) => {
        const id = readString(args, 'id')
        const item = id === undefined ? undefined : store.item(id)
        if (item === undefined) return { found: false, item: null }
        return {
          found: true,
          item: {
            id: item.id,
            kind: item.kind,
            ts: item.ts,
            title: item.title,
            sender: item.sender,
            body: item.body,
            url: item.metadata?.webLink ?? null,
            actors: item.actors,
            metadata: item.metadata,
            thread: item.contentKey,
            firstSeenAt: item.firstSeenAt,
            lastSeenAt: item.lastSeenAt,
          },
        }
      },
    },
    {
      name: 'outlook_send',
      description:
        'Send an email as the signed-in Outlook account. '
        + 'This is irreversible. Call it without confirm to receive a preview, show that preview to the user, and call it again with confirm: true only after they approve the exact recipients, subject, and body. '
        + 'Requires the Mail.Send scope.',
      parameters: parameters({
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Primary recipients, as email addresses.',
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'Carbon-copy recipients, as email addresses.',
        },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: 'Blind-carbon-copy recipients, as email addresses.',
        },
        subject: {
          type: 'string',
          description: 'Subject line. May be empty.',
        },
        body: {
          type: 'string',
          description: 'The message body, in the format bodyType names.',
        },
        bodyType: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'Body format. Defaults to text.',
        },
        importance: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Message importance. Defaults to normal.',
        },
        saveToSentItems: {
          type: 'boolean',
          description: 'Keep a copy in Sent Items. Defaults to true.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually send. Omit or pass false to receive a preview without sending.',
        },
      }, ['to', 'subject', 'body']),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            status: { type: 'string', enum: ['sent', 'needs_confirmation', 'skipped', 'failed'] },
            to: { type: 'array', items: { type: 'string' } },
            cc: { type: 'array', items: { type: 'string' } },
            bcc: { type: 'array', items: { type: 'string' } },
            subject: { type: 'string' },
            bodyType: { type: 'string', enum: ['text', 'html'] },
            importance: NULLABLE_STRING,
            saveToSentItems: { type: 'boolean' },
            messageId: { ...NULLABLE_STRING, description: 'The sent message id, when Graph reports one.' },
            reason: { ...NULLABLE_STRING, description: 'Why the message was not sent.' },
            errorCode: { ...NULLABLE_STRING, description: 'Stable code for a skipped or failed send.' },
          },
          required: ['ok', 'status', 'to', 'subject', 'bodyType', 'saveToSentItems'],
          additionalProperties: false,
        },
        render: renderValue,
      },
      timeoutMs: SEND_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: 'Outlook send',
        kind: 'write',
        rawInput: args,
      }),
      execute: (args, exec) => sendMessage({ auth, createClient, args, exec, shutdownSignal, logger }),
    },
    {
      name: 'outlook_schedule',
      description:
        'Set up or restore the recurring Outlook capture in the Automation tasks list. '
        + 'The task belongs to the conversation that creates it and resumes it to run a capture. '
        + 'Deleting it there does not restore it; call this again to put it back.',
      parameters: parameters({
        recreate: {
          type: 'boolean',
          description: 'Replace the existing capture task with a fresh one. Leave it unset to keep an existing task as it is.',
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
      presentCall: (args) => ({
        card: 'generic',
        title: 'Outlook capture task',
        kind: 'write',
        rawInput: args,
      }),
      execute: (args, exec) => setUpSchedule({ ctx, config, args, exec }),
    },
  ]
}

/**
 * Start a capture, as a background job when the composition provides a registry
 * and inline otherwise.
 * @param options - Run options.
 * @param options.syncer - The capture runner.
 * @param options.jobs - The job registry, when present.
 * @param options.auth - Sign-in state.
 * @param options.logger - Plugin logger.
 * @param options.args - Raw tool arguments.
 * @param options.exec - Tool execution context.
 * @param options.shutdownSignal - The plugin's lifetime signal, when provided.
 * @returns the tool value.
 */
async function startSync({ syncer, jobs, auth, logger, args, exec, shutdownSignal }) {
  const backfill = args?.backfill === true
  const idle = { pages: 0, written: 0, unchanged: 0, removed: 0 }
  if (!auth.configured) {
    return { ok: false, status: 'skipped', jobId: null, reason: 'not_configured', ...idle, errorCodes: [] }
  }
  if (jobs === undefined) {
    const outcome = await syncer.run({
      backfill,
      trigger: 'agent',
      signal: stopSignal(shutdownSignal, exec?.signal),
    })
    return summarise(outcome)
  }
  const id = jobs.start({
    kind: 'outlook-sync',
    label: `Outlook mail sync${backfill ? ' (backfill)' : ''}`,
    ...(exec?.agent ? { owner: exec.agent.id } : {}),
    run: (job) => {
      const controller = new AbortController()
      job.updateProgress('starting')
      const done = syncer
        .run({
          backfill,
          trigger: 'agent',
          signal: stopSignal(shutdownSignal, controller.signal),
          onProgress: (event) => job.updateProgress(event.message),
        })
        .then((outcome) => {
          job.append(`${JSON.stringify(summarise(outcome))}\n`)
          return {
            status: outcome.ok ? 'completed' : 'failed',
            detail: outcome.ok ? undefined : (outcome.reason ?? outcome.errorCodes?.join(',')),
            result: JSON.stringify(summarise(outcome)),
          }
        })
        .catch((error) => {
          logger?.warn?.(`outlook: sync job failed: ${String(error)}`)
          return { status: 'failed', detail: 'internal_error' }
        })
      return { done, cancel: () => controller.abort() }
    },
  })
  return { ok: true, status: 'started', jobId: String(id), ...idle, errorCodes: [] }
}

/**
 * Cancel a capture when either the caller or the plugin unloading asks to.
 * @param shutdownSignal - The plugin's lifetime signal, when one is provided.
 * @param callerSignal - The caller's cancellation, when one was supplied.
 * @returns the signal the capture runs under.
 */
function stopSignal(shutdownSignal, callerSignal) {
  if (shutdownSignal === undefined) return callerSignal
  return callerSignal === undefined ? shutdownSignal : AbortSignal.any([callerSignal, shutdownSignal])
}

/**
 * Project a capture outcome into the tool value.
 * @param outcome - The runner's return value.
 * @returns the tool value.
 */
function summarise(outcome) {
  const counts = {
    pages: outcome.pages ?? 0,
    written: outcome.written ?? 0,
    unchanged: outcome.unchanged ?? 0,
    removed: outcome.removed ?? 0,
  }
  if (outcome.skipped === true) {
    return { ok: false, status: 'skipped', jobId: null, reason: outcome.reason, ...counts, errorCodes: [] }
  }
  return {
    ok: outcome.ok === true,
    status: outcome.ok === true ? 'completed' : 'failed',
    jobId: null,
    reason: outcome.reason ?? (outcome.errorCodes?.join(',') || null),
    ...counts,
    errorCodes: outcome.errorCodes ?? [],
  }
}

/**
 * Create or restore the recurring capture task.
 * @param options - Run options.
 * @param options.ctx - Plugin context.
 * @param options.config - Live plugin configuration.
 * @param options.args - Raw tool arguments.
 * @param options.exec - Tool execution context.
 * @returns the tool value.
 */
async function setUpSchedule({ ctx, config, args, exec }) {
  const sessionId = exec?.agent?.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, status: 'unavailable', taskId: null, nextRunAt: null, reason: 'no_session', tasks: [] }
  }
  if (scheduleOf(ctx) === undefined) {
    return {
      ok: false,
      status: 'unavailable',
      taskId: null,
      nextRunAt: null,
      reason: 'schedule_unavailable',
      tasks: [],
    }
  }
  const before = await listTasks(ctx)
  const recreate = args?.recreate === true
  try {
    const task = recreate
      ? await recreateTask(ctx, sessionId, config.scheduleCron, pluginTimeZone())
      : await ensureTask(ctx, sessionId, config.scheduleCron, pluginTimeZone())
    const state = await taskState(ctx)
    const status = recreate ? 'recreated' : before.length > 0 ? 'exists' : 'created'
    return {
      ok: true,
      status,
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
 * Send one email, refusing to touch the network until the caller has explicitly
 * confirmed and the sign-in is known to carry `Mail.Send`.
 *
 * The three gates run in order and each leaves the mailbox untouched: an
 * unconfirmed call returns a preview, an unconfigured plugin reports
 * `not_configured`, and a granted-scope set that lacks `Mail.Send` reports
 * `scope_missing` rather than letting Graph's 403 read as an expired sign-in.
 *
 * @param options - Run options.
 * @param options.auth - Sign-in state.
 * @param options.createClient - Builds an authenticated Graph client for one request.
 * @param options.args - Raw tool arguments.
 * @param options.exec - Tool execution context.
 * @param options.shutdownSignal - The plugin's lifetime signal, when provided.
 * @param options.logger - Plugin logger.
 * @returns the tool value.
 */
async function sendMessage({ auth, createClient, args, exec, shutdownSignal, logger }) {
  const { message, summary } = composeMessage(args)
  const saveToSentItems = args?.saveToSentItems !== false
  const base = {
    ok: false,
    status: 'skipped',
    ...summary,
    saveToSentItems,
    messageId: null,
    reason: null,
    errorCode: null,
  }
  // Nothing leaves the machine until the caller confirms the exact message.
  if (args?.confirm !== true) {
    return { ...base, status: 'needs_confirmation', reason: 'confirm_required' }
  }
  if (!auth.configured) {
    return { ...base, reason: 'not_configured', errorCode: 'not_configured' }
  }
  let granted = []
  try {
    granted = await auth.grantedScopes()
  } catch {
    granted = []
  }
  if (!granted.some((scope) => scope.toLowerCase() === 'mail.send')) {
    // No stored sign-in at all is a sign-in problem, not a scope problem; say so
    // instead of asking the user to re-consent to a permission they never gave.
    if (granted.length === 0) {
      return { ...base, reason: 'auth_required', errorCode: 'auth_required' }
    }
    return { ...base, reason: 'scope_missing', errorCode: 'scope_missing' }
  }
  const client = createClient({
    signal: stopSignal(shutdownSignal, exec?.signal),
    timeoutMs: SEND_TIMEOUT_MS,
  })
  try {
    const sent = await sendMail({ client, message, saveToSentItems })
    return {
      ...base,
      ok: true,
      status: 'sent',
      messageId: typeof sent?.id === 'string' ? sent.id : null,
    }
  } catch (error) {
    const code = errorCode(error)
    logger?.warn?.(`outlook: sending mail failed: ${code}`)
    return { ...base, status: 'failed', reason: code, errorCode: code }
  }
}

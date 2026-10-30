/**
 * The model-facing surface: start a sync, search the captured corpus, and read
 * one record in full.
 *
 * Search and item are pure reads over the in-memory corpus and return at once.
 * A sync is minutes of rate-limited upstream calls, so with a job registry it
 * registers a background job and returns its id; the agent collects the outcome
 * from the job instead of holding the turn open.
 *
 * @module dsh-bilibili/src/tools
 */

import { ARTICLE_BUSINESS, EPISODE_BUSINESS, LIVE_BUSINESS, VIDEO_BUSINESS } from './mapping.js'
import { ensureTask, listTasks, recreateTask, scheduleOf, taskState } from './schedule.js'
import { DATASETS } from './spec.js'
import { STALE_AFTER_MS } from './store.js'
import { errorCode } from './sync.js'
import { instantOf } from './time.js'

/** Default rows a search returns. */
const DEFAULT_LIMIT = 20

/** Largest rows a search returns. */
const MAX_LIMIT = 50

/** Characters of context a snippet carries around a match. */
const SNIPPET_CHARS = 160

/** Deadline for the read-only tools, which never touch the network. */
const READ_TIMEOUT_MS = 15_000

/** Deadline for the sync tool; the background path returns immediately. */
const SYNC_TIMEOUT_MS = 240_000

/** Nullable scalar, as the harness's enforced JSON Schema subset expresses it. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** One search row. */
const ITEM_ROW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Upstream identity; pass it to bilibili_item for the full record.' },
    dataset: { type: 'string', enum: [...DATASETS] },
    ts: { ...NULLABLE_STRING, description: 'Upstream event time, ISO-8601 UTC.' },
    title: NULLABLE_STRING,
    url: { ...NULLABLE_STRING, description: 'Public page for the item, when its metadata identifies one.' },
    author: NULLABLE_STRING,
    snippet: { ...NULLABLE_STRING, description: 'Text around the match, when the query matched the body.' },
    contentKey: { ...NULLABLE_STRING, description: 'Shared by records denoting the same upstream work.' },
  },
  required: ['id', 'dataset'],
  additionalProperties: false,
}

/** Freshness of the corpus, attached to every search result. */
const SYNC_STATE_SCHEMA = {
  type: 'object',
  properties: {
    lastRunAt: { ...NULLABLE_STRING, description: 'When the last sync attempt started.' },
    stale: { type: 'boolean', description: 'True when the last successful capture is over a day old, or none ever ran.' },
    running: { type: 'boolean', description: 'True while a sync is in progress.' },
    authRequired: { type: 'boolean', description: 'True when upstream rejected the stored session.' },
  },
  required: ['stale', 'running', 'authRequired'],
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
 * @returns the value, or undefined when absent or not a string.
 */
function readString(args, key) {
  const value = args?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read one time bound as the canonical ISO-8601 UTC form the corpus stores.
 *
 * The store compares instants as strings, so a bound carrying an offset must be
 * resolved before it reaches the store; a raw `+08:00` value is a different
 * string from the equal `Z` instant and would filter the wrong rows.
 *
 * @param args - Raw tool arguments.
 * @param key - Argument name.
 * @returns the canonical bound, or undefined when absent.
 * @throws when a supplied value is not an ISO-8601 date or date-time.
 */
function readBound(args, key) {
  const raw = readString(args, key)
  if (raw === undefined) return undefined
  const instant = instantOf(raw)
  if (instant === null) {
    throw new Error(`${key} must be an ISO-8601 date or date-time; "${raw}" is not one`)
  }
  return instant
}

/**
 * Public page for one item, derived from the fields its mapper captured.
 * @param item - A stored record.
 * @returns the URL, or null when the metadata identifies no page.
 */
function publicUrl(item) {
  const metadata = item.metadata ?? {}
  const asString = (value) => (typeof value === 'string' && value !== '' ? value : null)
  switch (item.dataset) {
    case 'history': {
      const business = asString(metadata.business)
      const oid = asString(metadata.oid)
      if (business !== null && EPISODE_BUSINESS.has(business)) {
        const epid = asString(metadata.epid)
        if (epid !== null) return `https://www.bilibili.com/bangumi/play/ep${epid}`
        return oid === null ? null : `https://www.bilibili.com/bangumi/play/ss${oid}`
      }
      if (business !== null && LIVE_BUSINESS.has(business)) {
        return oid === null ? null : `https://live.bilibili.com/${oid}`
      }
      if (business !== null && ARTICLE_BUSINESS.has(business)) {
        return oid === null ? null : `https://www.bilibili.com/read/cv${oid}`
      }
      // A business this plugin does not recognise has no page it can name from
      // the id alone; a video URL built from it would point at unrelated
      // content.
      if (business !== null && !VIDEO_BUSINESS.has(business)) return null
      const bvid = asString(metadata.bvid)
      if (bvid !== null) return `https://www.bilibili.com/video/${bvid}`
      const aid = asString(metadata.aid) ?? oid
      return aid === null ? null : `https://www.bilibili.com/video/av${aid}`
    }
    case 'watch_later': {
      const bvid = asString(metadata.bvid)
      if (bvid !== null) return `https://www.bilibili.com/video/${bvid}`
      const aid = asString(metadata.aid) ?? asString(metadata.oid)
      return aid === null ? null : `https://www.bilibili.com/video/av${aid}`
    }
    case 'favorites': {
      const bvid = asString(metadata.bvid)
      if (bvid !== null) return `https://www.bilibili.com/video/${bvid}`
      const resourceType = asString(metadata.resource_type)
      const resourceId = asString(metadata.resource_id)
      if (resourceId === null) return null
      if (resourceType === '12') return `https://www.bilibili.com/read/cv${resourceId}`
      if (resourceType === '2') return `https://www.bilibili.com/video/av${resourceId}`
      return null
    }
    case 'following': {
      const mid = asString(metadata.mid)
      return mid === null ? null : `https://space.bilibili.com/${mid}`
    }
    case 'self_dynamic': {
      const dynamicId = asString(metadata.dynamic_id)
      return dynamicId === null ? null : `https://t.bilibili.com/${dynamicId}`
    }
    default:
      return null
  }
}

/**
 * First actor, which every mapper that records one treats as the owner.
 * @param item - A stored record.
 * @returns the actor name, or null.
 */
function authorOf(item) {
  return item.actors?.find((actor) => actor.name !== null)?.name ?? null
}

/**
 * Window of body text around the first match.
 * @param item - A stored record.
 * @param needle - Lowercase query.
 * @returns the snippet, or null when the body does not carry the match.
 */
function snippetOf(item, needle) {
  const body = item.content
  if (needle === null || typeof body !== 'string') return null
  const at = body.toLowerCase().indexOf(needle)
  if (at === -1) return null
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3))
  const end = Math.min(body.length, start + SNIPPET_CHARS)
  const window = body.slice(start, end).replaceAll('\n', ' / ')
  return `${start > 0 ? '…' : ''}${window}${end < body.length ? '…' : ''}`
}

/**
 * Compact a stored record into one search row.
 * @param item - A stored record.
 * @param needle - Lowercase query, for the snippet.
 * @returns the row.
 */
function toRow(item, needle) {
  return {
    id: item.sourceId,
    dataset: item.dataset,
    ts: item.ts,
    title: item.title,
    url: publicUrl(item),
    author: authorOf(item),
    snippet: snippetOf(item, needle),
    contentKey: item.contentKey,
  }
}

/**
 * Freshness block attached to search results.
 * @param store - The corpus handle.
 * @param syncer - The sync runner.
 * @param now - Current instant in milliseconds.
 * @returns the sync state.
 */
function syncState(store, syncer, now) {
  const status = store.status()
  const lastSuccessAt = store.latestSuccessAt()
  return {
    lastRunAt: status.lastRunAt,
    // Freshness follows the last capture that actually stored something: a run
    // that failed leaves the corpus exactly as old as it already was.
    stale: lastSuccessAt === null || now - Date.parse(lastSuccessAt) > STALE_AFTER_MS,
    running: syncer.busy,
    authRequired: status.authRequired,
  }
}

/**
 * Build the three tool definitions.
 * @param options - Construction options.
 * @param options.ctx - Plugin context, for the schedule service.
 * @param options.store - The corpus handle.
 * @param options.syncer - The sync runner.
 * @param options.jobs - The job registry, when the composition provides one.
 * @param options.config - Resolved plugin options.
 * @param options.clock - Current instant in milliseconds.
 * @param options.logger - Plugin logger.
 * @returns the tool definitions, in registration order.
 */
export function buildTools({ ctx, store, syncer, jobs, config, clock = Date.now, logger }) {
  return [
    {
      name: 'bilibili_sync',
      description:
        'Capture the signed-in account\'s Bilibili activity into the local corpus: watch history, watch later, favorites, following, and own dynamics. '
        + 'Capture is rate-limited, so it runs as a background job that returns a job id immediately; read the job to collect the per-dataset outcome. '
        + 'Search results report whether the corpus has gone stale, which is when a sync is worth starting.',
      parameters: parameters({
        datasets: {
          type: 'array',
          items: { type: 'string', enum: [...DATASETS] },
          description: `Datasets to capture. Defaults to all of ${DATASETS.join(', ')}.`,
        },
        backfill: {
          type: 'boolean',
          description: 'Spend the larger page budget walking history backwards. Set it for a first capture or a long gap; leave it unset for a routine sync.',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            status: { type: 'string', enum: ['started', 'completed', 'failed', 'skipped'] },
            jobId: { ...NULLABLE_STRING, description: 'Background job to read for progress and the final per-dataset outcome.' },
            reason: { ...NULLABLE_STRING, description: 'Why a skipped or failed run did not capture anything.' },
            datasets: {
              type: 'object',
              description: 'Per-dataset outcome, keyed by dataset name; each value carries status, added (records new to the corpus), updated, unchanged, and error.',
            },
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
        title: 'Bilibili sync',
        kind: 'fetch',
        rawInput: args,
      }),
      execute: (args, exec) => startSync({ syncer, jobs, logger, args, exec }),
    },
    {
      name: 'bilibili_search',
      description:
        'Search the locally captured Bilibili data: what the account watched, put in watch later, favorited, followed, or posted. '
        + 'The corpus is a local capture, so it only holds what a previous sync stored and it ages; the result reports that state.',
      parameters: parameters({
        query: {
          type: 'string',
          description: 'Text to match, case-insensitively, anywhere in an item: title, body, uploader, or upstream fields such as a BV id. Omit it to browse by the other filters.',
        },
        dataset: {
          type: 'string',
          enum: [...DATASETS],
          description: 'Restrict to one dataset. Omit it to search all of them.',
        },
        since: {
          type: 'string',
          description: 'Earliest upstream event time to include, as an ISO-8601 date or date-time. A date means that day\'s midnight in the host\'s time zone, and a date-time without an offset is read there too; a value carrying an offset or Z is taken as written. Items without an event time are excluded.',
        },
        until: {
          type: 'string',
          description: 'Exclusive upper bound on the upstream event time, as an ISO-8601 date or date-time, read the same way as since.',
        },
        seenSince: {
          type: 'string',
          description: 'Earliest capture time to include, as an ISO-8601 date or date-time read the same way as since: matches records this corpus last confirmed at or after it, whether they were added or changed. Unlike `since` and `until`, which filter the upstream event time, this answers what a capture wrote: pass the `sync.lastRunAt` from a search result to list exactly what the capture behind that result added or updated. Records a capture merely re-confirmed are not matched.',
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
            total: { type: 'number', description: 'Items matching every filter, before the window.' },
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
        title: 'Bilibili search',
        kind: 'search',
        rawInput: args,
      }),
      execute: (args) => {
        const query = readString(args, 'query')
        // `store.search` trims its needle; the snippet must look for the same
        // text or a padded query matches but shows no excerpt.
        const trimmed = query?.trim() ?? ''
        const needle = trimmed === '' ? null : trimmed.toLowerCase()
        const result = store.search({
          query,
          dataset: readString(args, 'dataset'),
          since: readBound(args, 'since'),
          until: readBound(args, 'until'),
          seenSince: readBound(args, 'seenSince'),
          limit: clampLimit(args?.limit),
          offset: clampOffset(args?.offset),
        })
        return {
          total: result.total,
          returned: result.rows.length,
          items: result.rows.map((item) => toRow(item, needle)),
          sync: syncState(store, syncer, clock()),
        }
      },
    },
    {
      name: 'bilibili_item',
      description:
        'Read one captured Bilibili item in full, including every field the capture stored. Use the id a search returned.',
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
                    sourceId: { type: 'string' },
                    dataset: { type: 'string', enum: [...DATASETS] },
                    kind: { type: 'string' },
                    ts: NULLABLE_STRING,
                    title: NULLABLE_STRING,
                    content: NULLABLE_STRING,
                    url: NULLABLE_STRING,
                    actors: { type: 'array' },
                    metadata: { type: 'object' },
                    contentKey: NULLABLE_STRING,
                    firstSeenAt: { type: 'string' },
                    lastSeenAt: { type: 'string' },
                  },
                  required: ['sourceId', 'dataset', 'kind'],
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
        title: 'Bilibili item',
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
            sourceId: item.sourceId,
            dataset: item.dataset,
            kind: item.kind,
            ts: item.ts,
            title: item.title,
            content: item.content,
            url: publicUrl(item),
            actors: item.actors,
            metadata: item.metadata,
            contentKey: item.contentKey,
            firstSeenAt: item.firstSeenAt,
            lastSeenAt: item.lastSeenAt,
          },
        }
      },
    },
    {
      name: 'bilibili_schedule',
      description:
        'Set up, or restore, the recurring Bilibili capture in the Automation tasks list. '
        + 'The task belongs to the conversation that creates it and reports back there, so it resumes that conversation to run a capture. '
        + 'A user who deletes the task there does not get it back automatically; call this again to restore it.',
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
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: 'Bilibili capture task',
        kind: 'write',
        rawInput: args,
      }),
      execute: (args, exec) => setUpSchedule({ ctx, config, args, exec }),
    },
  ]
}

/**
 * Create or restore the recurring capture task.
 * @param options - Run options.
 * @param options.ctx - Plugin context.
 * @param options.config - Resolved plugin options.
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
    return {
      ok: false,
      status: 'failed',
      taskId: null,
      nextRunAt: null,
      reason: errorCode(error),
      tasks: [],
    }
  }
}

/**
 * The zone the cron expression is evaluated in, read from the host so the
 * caller never has to state what the machine already knows.
 * @returns an IANA zone name.
 */
function pluginTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
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
 * Start a sync, as a background job when the composition provides a registry
 * and inline otherwise.
 * @param options - Run options.
 * @param options.syncer - The sync runner.
 * @param options.jobs - The job registry, when present.
 * @param options.logger - Plugin logger.
 * @param options.args - Raw tool arguments.
 * @param options.exec - Tool execution context.
 * @returns the tool value.
 */
async function startSync({ syncer, jobs, logger, args, exec }) {
  const datasets = readDatasets(args)
  const backfill = args?.backfill === true
  if (jobs === undefined) {
    const outcome = await syncer.run({ datasets, backfill, trigger: 'agent', signal: exec?.signal })
    return summarise(outcome)
  }
  const id = jobs.start({
    kind: 'bilibili-sync',
    label: `Bilibili sync (${datasets.join(', ')}${backfill ? ', backfill' : ''})`,
    ...(exec?.agent ? { owner: exec.agent.id } : {}),
    run: (job) => {
      const controller = new AbortController()
      job.updateProgress('starting')
      const done = syncer
        .run({
          datasets,
          backfill,
          trigger: 'agent',
          signal: controller.signal,
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
          logger?.warn?.(`bilibili: sync job failed: ${String(error)}`)
          return { status: 'failed', detail: 'internal_error' }
        })
      return { done, cancel: () => controller.abort() }
    },
  })
  return { ok: true, status: 'started', jobId: String(id), datasets: {} }
}

/**
 * Read the requested datasets, defaulting to all of them.
 * @param args - Raw tool arguments.
 * @returns the dataset names.
 */
function readDatasets(args) {
  const requested = args?.datasets
  if (!Array.isArray(requested)) return [...DATASETS]
  const unknown = requested.filter((name) => !DATASETS.includes(name))
  // An empty or misspelt selection used to fall back to every dataset, spending
  // the rate-limited page budget on a capture the caller did not ask for.
  if (unknown.length > 0 || requested.length === 0) {
    throw new Error(`datasets must name one or more of ${DATASETS.join(', ')}`)
  }
  return DATASETS.filter((name) => requested.includes(name))
}

/**
 * Project a sync outcome into the tool value.
 * @param outcome - The runner's return value.
 * @returns the tool value.
 */
function summarise(outcome) {
  if (outcome.skipped === true) {
    return { ok: false, status: 'skipped', jobId: null, reason: outcome.reason, datasets: {}, errorCodes: [] }
  }
  return {
    ok: outcome.ok === true,
    status: outcome.ok === true ? 'completed' : 'failed',
    jobId: null,
    reason: outcome.errorCodes?.join(',') ?? null,
    datasets: outcome.datasets ?? {},
    errorCodes: outcome.errorCodes ?? [],
  }
}

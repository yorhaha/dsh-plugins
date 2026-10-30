/**
 * The agent-facing half: five tools over the user's own todo list.
 *
 * `list_user_todos` reads the list, `create_user_todos` appends items,
 * `update_user_todos` changes the items the model names by id,
 * `delete_user_todos` removes items the person no longer wants at all, and
 * `list_user_agenda` reads what happens inside a window. All five share the one
 * document the Calendar & Todos panel edits, so a change either surface makes is visible
 * to the other immediately — and an item's `source` in the result says whether
 * the person or the agent wrote it.
 *
 * This is not the agent's own task list. Task progress for the work in hand
 * belongs to `todo_write`, which is session-scoped and replaced wholesale. These
 * items outlive the conversation, belong to the person, and are only changed
 * one item at a time.
 *
 * Time is the one place the model is trusted with less than it looks like it can
 * do. A deadline is accepted as a date, as a local wall-clock reading, or as a
 * UTC instant, and every result echoes `now` and `time_zone`, so the model never
 * has to convert "tomorrow at three" into UTC by hand — the failure mode with
 * the best track record of being wrong by exactly the zone offset.
 *
 * An expected failure — unknown id, a field outside its bound, an occurrence
 * that does not belong to the item — comes back as an `ok: false` value with a
 * closed `error.code`, so the model reads what happened instead of losing the
 * call. Argument validation throws before any write, so a batch is accepted or
 * refused whole.
 *
 * @module dsh-user-todo/src/tools
 */

import { resolveWindow } from './agenda.js'
import { instant, ITEM_JSON_SCHEMA, RECURRENCE_JSON_SCHEMA, STATUSES } from './item.js'
import { describeRule } from './recurrence.js'
import { TodoError } from './store.js'
import { formatInstant } from './zone.js'

/** Render one tool value for the transcript. */
function renderValue(_args, value) {
  if (value?.ok === false) {
    return [{ type: 'text', text: `user todos: ${value.error.code} — ${value.error.message}` }]
  }
  const lines = []
  if (typeof value.count === 'number' && Array.isArray(value.items)) {
    lines.push(`${value.count} item${value.count === 1 ? '' : 's'} in the user's todo list.`)
  }
  if (Array.isArray(value.items) && value.items.length > 0) {
    for (const item of value.items) {
      const mark = item.status === 'done' ? 'x' : ' '
      const due = item.due_at === null ? '' : ` (due ${item.due_at}${item.all_day ? ', all day' : ''})`
      const repeat = item.repeat === null ? '' : ` ↻ ${describeRule(item.repeat)}`
      const next = item.next_at === null || item.status === 'done' ? '' : ` · next ${item.next_at}`
      lines.push(`- [${mark}] ${item.title}${due}${repeat}${next} · ${item.source} · ${item.id}`)
    }
  }
  if (Array.isArray(value.occurrences)) {
    lines.push(`${value.count} occurrence${value.count === 1 ? '' : 's'} between ${value.from} and ${value.to} (${value.time_zone}).`)
    for (const entry of value.occurrences) {
      const when = entry.all_day ? `${entry.date} (all day)` : entry.start_at
      const repeat = entry.repeat === null ? '' : ` ↻ ${describeRule(entry.repeat)}`
      lines.push(`- ${when} · ${entry.title}${repeat} · ${entry.status} · ${entry.occurrence_id}`)
    }
  }
  if (Array.isArray(value.skipped) && value.skipped.length > 0) {
    lines.push(`Skipped: ${value.skipped.map(entry => `${entry.title} (${entry.reason})`).join(', ')}.`)
  }
  if (Array.isArray(value.results) && value.results.length > 0) {
    const refused = value.results.filter(entry => entry.code !== 'changed' && entry.code !== 'unchanged')
    if (refused.length > 0) lines.push(`Refused: ${refused.map(entry => `${entry.id} (${entry.code})`).join(', ')}.`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * One nullable scalar, in the registry's schema subset: `null` is its own
 * branch, because a node carries one type and there is no type array.
 *
 * @param type - the non-null type.
 * @returns the schema node.
 */
function nullable(type) {
  return { oneOf: [{ type }, { type: 'null' }] }
}

/**
 * One nullable schema node: `null` is its own branch, because a node carries one
 * type and the registry's subset has no type array.
 *
 * @param schema - the non-null branch.
 * @returns the schema node.
 */
function orNull(schema) {
  return { oneOf: [schema, { type: 'null' }] }
}

/** JSON Schema of one projected item, as the tools publish it. */
const PRESENTED_ITEM_SCHEMA = {
  type: 'object',
  required: [
    'id', 'status', 'title', 'note', 'due_at', 'due_date', 'all_day', 'time_zone',
    'repeat', 'remind_before_min', 'next_at', 'created_at', 'updated_at', 'completed_at', 'source',
  ],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: STATUSES },
    title: { type: 'string' },
    note: nullable('string'),
    due_at: nullable('string'),
    due_date: nullable('string'),
    all_day: { type: 'boolean' },
    time_zone: nullable('string'),
    repeat: orNull(RECURRENCE_JSON_SCHEMA),
    remind_before_min: { type: 'array', items: { type: 'integer' } },
    next_at: nullable('string'),
    created_at: ITEM_JSON_SCHEMA.properties.createdAt,
    updated_at: ITEM_JSON_SCHEMA.properties.updatedAt,
    completed_at: nullable('string'),
    source: ITEM_JSON_SCHEMA.properties.lastWriter,
  },
  additionalProperties: false,
}

/** A closed failure, shared by every tool. */
const FAILURE_SCHEMA = {
  type: 'object',
  required: ['ok', 'error'],
  properties: {
    ok: { type: 'boolean', const: false },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

/** The read result. */
const LIST_OK_SCHEMA = {
  type: 'object',
  required: ['ok', 'count', 'open', 'done', 'items'],
  properties: {
    ok: { type: 'boolean', const: true },
    count: { type: 'integer' },
    open: { type: 'integer' },
    done: { type: 'integer' },
    items: { type: 'array', items: PRESENTED_ITEM_SCHEMA },
  },
  additionalProperties: false,
}

/** The create result. */
const CREATE_OK_SCHEMA = {
  type: 'object',
  required: ['ok', 'items', 'skipped', 'count'],
  properties: {
    ok: { type: 'boolean', const: true },
    items: { type: 'array', items: PRESENTED_ITEM_SCHEMA },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'reason'],
        properties: { title: { type: 'string' }, reason: { type: 'string', enum: ['duplicate', 'list_full'] } },
        additionalProperties: false,
      },
    },
    count: { type: 'integer' },
  },
  additionalProperties: false,
}

/** The update result. */
const UPDATE_OK_SCHEMA = {
  type: 'object',
  required: ['ok', 'items', 'results', 'count'],
  properties: {
    ok: { type: 'boolean', const: true },
    items: { type: 'array', items: PRESENTED_ITEM_SCHEMA },
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'code'],
        properties: {
          id: { type: 'string' },
          code: { type: 'string', enum: ['changed', 'unchanged', 'not_found', 'invalid_occurrence', 'not_recurring', 'invalid_recurrence'] },
          message: { type: 'string' },
          current: PRESENTED_ITEM_SCHEMA,
        },
        additionalProperties: false,
      },
    },
    count: { type: 'integer' },
  },
  additionalProperties: false,
}

/** The delete result: what went, and what the call named but the list did not hold. */
const DELETE_OK_SCHEMA = {
  type: 'object',
  required: ['ok', 'removed', 'absent', 'count', 'remaining'],
  properties: {
    ok: { type: 'boolean', const: true },
    removed: { type: 'array', items: PRESENTED_ITEM_SCHEMA },
    absent: { type: 'array', items: { type: 'string' } },
    count: { type: 'integer' },
    remaining: { type: 'integer', description: 'How many items the list holds afterwards.' },
  },
  additionalProperties: false,
}

/** One occurrence, as the agenda tool publishes it. */
const OCCURRENCE_SCHEMA = {
  type: 'object',
  required: ['occurrence_id', 'item_id', 'title', 'all_day', 'start_at', 'date', 'status', 'repeat'],
  properties: {
    occurrence_id: { type: 'string' },
    item_id: { type: 'string' },
    title: { type: 'string' },
    all_day: { type: 'boolean' },
    start_at: { type: 'string' },
    date: { type: 'string' },
    status: { type: 'string', enum: STATUSES },
    repeat: orNull(RECURRENCE_JSON_SCHEMA),
  },
  additionalProperties: false,
}

/** The agenda result. */
const AGENDA_OK_SCHEMA = {
  type: 'object',
  required: ['ok', 'now', 'time_zone', 'from', 'to', 'count', 'occurrences'],
  properties: {
    ok: { type: 'boolean', const: true },
    now: { type: 'string' },
    time_zone: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    count: { type: 'integer' },
    occurrences: { type: 'array', items: OCCURRENCE_SCHEMA },
  },
  additionalProperties: false,
}

/** The one create argument shape, named once for both the schema and the copy. */
const CREATE_ITEM_PROPERTIES = {
  title: { type: 'string', description: 'What the task is, in one short line.' },
  due_at: {
    type: 'string',
    description: 'When it is due: "2026-11-02" for an all-day date, "2026-11-02T15:00" for local wall-clock time, '
      + 'or "2026-11-02T07:00:00Z" for an exact instant. Prefer the local-time form; do not convert to UTC by hand.',
  },
  time_zone: { type: 'string', description: 'IANA zone the due time is written in, such as Asia/Shanghai. Defaults to the calendar zone.' },
  remind_before_min: {
    oneOf: [
      { type: 'integer' },
      { type: 'array', items: { type: 'integer' } },
    ],
    description: 'Minutes before the due moment to send a push reminder; 0 means at the due moment. '
      + 'A list asks for several. For an all-day item the clock time comes from the settings (09:00 by default).',
  },
  repeat: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'], description: 'Repeat frequency. Omit for a one-off item.' },
  repeat_by_weekday: {
    type: 'array',
    items: { type: 'integer' },
    description: 'For a weekly repeat: weekdays to repeat on, 1 = Monday through 7 = Sunday.',
  },
  repeat_interval: { type: 'integer', description: 'Repeat every N periods; defaults to 1.' },
  repeat_count: { type: 'integer', description: 'Total occurrences the series produces.' },
  repeat_until: { type: 'string', description: 'Last date the series may fall on, as a UTC instant or a date.' },
  note: { type: 'string', description: 'Optional detail.' },
}

/**
 * Build the repeat rule one create entry asks for.
 *
 * The flat argument names (`repeat`, `repeat_by_weekday`, …) are what the model
 * sees because a nested object with four optional keys is where a model
 * produces the wrong shape; they are assembled into the one stored rule here.
 *
 * @param entry - one create entry.
 * @returns the rule, or null when the entry does not repeat.
 * @throws {TodoError} `invalid_recurrence` when the fields do not form a rule.
 */
function repeatOf(entry) {
  if (entry.repeat === undefined || entry.repeat === null) {
    if (entry.repeat_by_weekday !== undefined || entry.repeat_interval !== undefined
      || entry.repeat_count !== undefined || entry.repeat_until !== undefined) {
      throw new TodoError('invalid_recurrence', 'todo: `repeat` names a frequency; the other repeat_* fields only refine it')
    }
    return null
  }
  return {
    freq: entry.repeat,
    interval: entry.repeat_interval ?? 1,
    byWeekday: entry.repeat_by_weekday ?? [],
    count: entry.repeat_count ?? null,
    until: entry.repeat_until ?? null,
    dtstart: null,
  }
}

/**
 * Project one create request entry onto the store's field names. Both spellings
 * of the three-letter fields are accepted, because the model often carries one
 * over from another tool result; the declared schema uses snake_case.
 *
 * @param entry - the request entry.
 * @returns the create request.
 */
function createEntry(entry) {
  const request = { title: entry.title }
  const dueAt = entry.due_at ?? entry.dueAt
  if (dueAt !== undefined) request.due = { dueAt, dueDate: entry.due_date ?? entry.dueDate, timeZone: entry.time_zone ?? entry.timeZone }
  if (entry.note !== undefined) request.note = entry.note
  const repeat = repeatOf(entry)
  if (repeat !== null) request.recurrence = repeat
  const remind = entry.remind_before_min ?? entry.remindBeforeMin
  if (remind !== undefined) request.remindBeforeMin = remind
  return request
}

/**
 * The model-facing projection of one item.
 *
 * @param item - the stored item.
 * @param context - the clock, the zone, and the next-occurrence lookup.
 * @param context.now - epoch milliseconds.
 * @param context.timeZone - zone used when the item names none.
 * @param context.nextOf - the agenda's next-occurrence function.
 * @returns the projected item.
 */
function present(item, { now, timeZone, nextOf }) {
  const next = nextOf(item, { after: now, timeZone })
  return {
    id: item.id,
    status: item.status,
    title: item.title,
    note: item.note,
    due_at: item.dueAt,
    due_date: item.dueDate,
    all_day: item.dueDate !== null,
    time_zone: item.timeZone,
    repeat: item.recurrence,
    remind_before_min: item.remindBeforeMin,
    next_at: next === null ? null : next.startAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    completed_at: item.completedAt,
    source: item.lastWriter,
  }
}

/**
 * Whether one write from `agent` is refused by configuration.
 *
 * @param config - resolved feature bounds.
 * @param agent - the calling agent, when the call came from one.
 * @param delegationDepthOf - delegation accounting; a child session is deeper than zero.
 * @returns true when the write must be refused.
 */
function refusesSubagent(config, agent, delegationDepthOf) {
  return config.allowSubagentWrites === false && agent !== undefined && delegationDepthOf(agent) > 0
}

/**
 * Project one refusal onto the tool failure value.
 *
 * Any error carrying a string `code` speaks the same closed vocabulary, whether
 * it came from the store, the repeat rule, or the window resolver; everything
 * else is an internal failure the model cannot act on.
 *
 * @param error - the thrown value.
 * @returns the failure value.
 */
function failure(error) {
  const code = typeof error?.code === 'string' && error.code !== ''
    ? error.code
    : `internal_${error?.constructor?.name ?? 'Error'}`
  return { ok: false, error: { code, message: error?.message ?? '' } }
}

/**
 * Build the five tools bound to this plugin instance.
 *
 * @param options - tool inputs.
 * @param options.store - the open list.
 * @param options.config - the resolved feature bounds.
 * @param options.delegationDepthOf - delegation accounting for the subagent policy.
 * @param options.agenda - projection helpers for the agenda tool.
 * @param options.agenda.nextOf - next-occurrence lookup.
 * @param options.agenda.now - clock, epoch milliseconds.
 * @returns the tool definitions, in registration order.
 */
export function buildTools({ store, config, delegationDepthOf }) {
  const subagentRefusal = agent => refusesSubagent(config, agent, delegationDepthOf)
  const context = () => ({ now: Date.now(), timeZone: store.timeZone, nextOf: store.nextOf.bind(store) })

  return [
    {
      name: config.toolNames.list,
      description:
        "List the user's own todo items — the durable list they keep in the Calendar & Todos panel, shared with them across every "
        + 'session. This is not this session\'s task list: for the progress of the work in hand use todo_write instead. '
        + 'Call it before changing an item so you name the id the list actually holds. Each item reports its deadline, '
        + 'whether it is an all-day date, its repeat rule, its reminder offsets, and the next occurrence.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'done', 'all'],
            description: 'Which items to return. Defaults to `open`: done items are kept but rarely need reading.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: { oneOf: [LIST_OK_SCHEMA, FAILURE_SCHEMA] }, render: renderValue },
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: 'Read the user\'s todos' }),
      execute: async (args) => {
        const status = args.status === undefined ? 'open' : args.status
        const all = store.items()
        const shown = context()
        const items = all
          .filter(item => status === 'all' || item.status === status)
          .map(item => present(item, shown))
        return {
          ok: true,
          count: items.length,
          open: all.filter(item => item.status === 'open').length,
          done: all.filter(item => item.status === 'done').length,
          items,
        }
      },
    },
    {
      name: config.toolNames.create,
      description:
        "Add one or more items to the user's own todo list — the durable list they see in the Calendar & Todos panel. "
        + 'A due time may be a date ("2026-11-02", all day), a local wall-clock reading ("2026-11-02T15:00", read in '
        + '`time_zone`), or a UTC instant. It may also repeat and carry push reminders. '
        + 'This is not this session\'s task list: use todo_write for the steps of the work you are doing. '
        + 'An item whose title already names an open item is skipped, so retrying a batch never duplicates the list.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: `The items to add, at most ${config.maxCreateBatch} per call.`,
            items: { type: 'object', additionalProperties: false, required: ['title'], properties: CREATE_ITEM_PROPERTIES },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      output: { schema: { oneOf: [CREATE_OK_SCHEMA, FAILURE_SCHEMA] }, render: renderValue },
      timeoutMs: 15_000,
      presentCall: args => ({ card: 'generic', title: 'Add to the user\'s todos', rawInput: args.items }),
      execute: async (args, exec) => {
        if (subagentRefusal(exec.agent)) {
          return { ok: false, error: { code: 'subagent_denied', message: 'user-todo: writes from a delegated child session are disabled' } }
        }
        try {
          const { added, skipped } = await store.create(args.items.map(createEntry), 'agent', { dedupe: true })
          const shown = context()
          return { ok: true, items: added.map(item => present(item, shown)), skipped, count: added.length }
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      name: config.toolNames.update,
      description:
        "Change items in the user's own todo list by id — mark them done or open again, rename them, change their "
        + 'deadline, repeat rule, reminders, or note. Completing one occurrence of a repeating item takes '
        + '`complete_occurrence` (its occurrence_id from list_user_agenda); skipping one takes `exclude_occurrence`. '
        + 'The last accepted write wins, so re-read the list if another surface may have changed the item first.',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            description: `The changes to apply, at most ${config.maxUpdateBatch} per call.`,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id'],
              properties: {
                id: { type: 'string', description: 'The item id a list returned.' },
                status: { type: 'string', enum: STATUSES, description: 'Mark the item open or done.' },
                title: { type: 'string' },
                due_at: {
                  type: 'string',
                  description: 'A date, a local wall-clock time, or a UTC instant — or null to clear the deadline and its repeat.',
                },
                time_zone: { type: 'string', description: 'IANA zone the due time is written in.' },
                remind_before_min: {
                  oneOf: [{ type: 'integer' }, { type: 'null' }],
                  description: 'Minutes before the due moment to remind at, or null to clear reminders.',
                },
                repeat: {
                  oneOf: [{ type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] }, { type: 'null' }],
                  description: 'Repeat frequency, or null to stop repeating.',
                },
                repeat_by_weekday: { type: 'array', items: { type: 'integer' }, description: 'Weekdays for a weekly repeat.' },
                repeat_interval: { type: 'integer', description: 'Every N periods; defaults to 1.' },
                repeat_count: { type: 'integer' },
                repeat_until: { type: 'string' },
                complete_occurrence: { type: 'string', description: 'An occurrence_id to mark done; a series stays open and advances.' },
                exclude_occurrence: { type: 'string', description: 'An occurrence_id to skip without completing it.' },
                note: { type: 'string', description: 'Replacement detail, or null to clear it.' },
              },
            },
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
      output: { schema: { oneOf: [UPDATE_OK_SCHEMA, FAILURE_SCHEMA] }, render: renderValue },
      timeoutMs: 15_000,
      presentCall: args => ({ card: 'generic', title: 'Update the user\'s todos', rawInput: args.changes }),
      execute: async (args, exec) => {
        if (subagentRefusal(exec.agent)) {
          return { ok: false, error: { code: 'subagent_denied', message: 'user-todo: writes from a delegated child session are disabled' } }
        }
        try {
          const plain = []
          /** @type {Array<object>} */
          const occurrenceResults = []
          for (const change of args.changes) {
            if (typeof change.complete_occurrence === 'string' || typeof change.exclude_occurrence === 'string') {
              const kind = typeof change.complete_occurrence === 'string' ? 'complete' : 'exclude'
              const occurrenceId = kind === 'complete' ? change.complete_occurrence : change.exclude_occurrence
              try {
                const { item } = kind === 'complete'
                  ? await store.completeOccurrence(change.id, occurrenceId, 'agent')
                  : await store.excludeOccurrence(change.id, occurrenceId)
                occurrenceResults.push({ id: change.id, code: 'changed', item })
              } catch (error) {
                occurrenceResults.push({ id: change.id, code: error instanceof TodoError ? error.code : 'not_found' })
              }
              continue
            }
            plain.push(change)
          }
          const outcome = plain.length > 0 ? await store.update(plain.map(changesEntry), 'agent') : { changed: [], results: [] }
          const shown = context()
          const results = [
            ...outcome.results.map(result => describeResult(result, shown)),
            ...occurrenceResults.map(entry => (entry.item === undefined
              ? { id: entry.id, code: entry.code }
              : { id: entry.id, code: entry.code, current: present(entry.item, shown) })),
          ]
          const items = [
            ...outcome.changed.map(item => present(item, shown)),
            ...occurrenceResults.filter(entry => entry.item !== undefined).map(entry => present(entry.item, shown)),
          ]
          return { ok: true, items, results, count: items.length }
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      name: config.toolNames.agenda,
      description:
        'List what falls inside one window of the user\'s calendar — their dated and repeating todo items expanded into '
        + 'occurrences. Use it for "what is on today", "this week", or "what did I miss". Dates are read in the calendar '
        + 'zone; an all-day item reports its date, a timed one its instant. The result also carries `now` and '
        + '`time_zone`, so relative dates can be worked out without guessing.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Window start as a date (2026-11-02) or a UTC instant. Defaults to today.' },
          to: { type: 'string', description: 'Exclusive window end, same forms. Defaults to seven days after the start.' },
          include_done: { type: 'boolean', description: 'Include occurrences already completed. Defaults to false.' },
        },
        additionalProperties: false,
      },
      output: { schema: { oneOf: [AGENDA_OK_SCHEMA, FAILURE_SCHEMA] }, render: renderValue },
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      presentCall: args => ({ card: 'generic', title: 'Read the user\'s agenda', rawInput: args }),
      execute: async (args) => {
        try {
          const now = Date.now()
          const { from, to } = resolveWindow(
            { from: args.from, to: args.to },
            { now, timeZone: store.timeZone, maxSpanDays: config.agendaMaxSpanDays },
          )
          const occurrences = store.agenda({
            from,
            to,
            includeDone: args.include_done === true,
            limit: config.agendaMaxOccurrences,
          }).map(entry => ({
            occurrence_id: entry.occurrenceId,
            item_id: entry.itemId,
            title: entry.title,
            all_day: entry.allDay,
            start_at: entry.startAt,
            date: entry.date,
            status: entry.status,
            repeat: entry.recurrence,
          }))
          return {
            ok: true,
            now: instant(new Date(now)),
            time_zone: store.timeZone,
            from: formatInstant(from),
            to: formatInstant(to),
            count: occurrences.length,
            occurrences,
          }
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      name: config.toolNames.remove,
      description:
        "Delete items from the user's own todo list for good, by the id a list returned, or every finished item at once. "
        + 'Marking an item done keeps it; deleting drops it, its repeat rule, and the reminders that named it. '
        + 'Prefer marking done unless the person asked to get rid of the item: a completed item is still history, a deleted one is not. '
        + '`open_only` refuses to delete an item that is still open, which is the guard for "clear the finished ones" without ids. '
        + 'An id the list does not hold comes back in `absent` instead of failing the whole call.',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: `The item ids to delete, at most ${config.maxDeleteBatch} per call. Omit to delete every finished item.`,
          },
          open_only: {
            type: 'boolean',
            description: 'Refuse to delete an item that is still open, and report it in `absent`. Defaults to false.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: { oneOf: [DELETE_OK_SCHEMA, FAILURE_SCHEMA] }, render: renderValue },
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      presentCall: args => ({ card: 'generic', title: 'Delete from the user\'s todos', rawInput: args.ids ?? '(finished items)' }),
      execute: async (args, exec) => {
        if (subagentRefusal(exec.agent)) {
          return { ok: false, error: { code: 'subagent_denied', message: 'user-todo: writes from a delegated child session are disabled' } }
        }
        try {
          const ids = args.ids === undefined ? null : args.ids
          if (ids !== null) {
            if (ids.length === 0) throw new TodoError('invalid_body', 'todo: `ids` must name at least one item')
            if (ids.length > config.maxDeleteBatch) {
              throw new TodoError('batch_too_large', `todo: at most ${config.maxDeleteBatch} deletions per call`)
            }
          }
          // `open_only` narrows the request before the write: the store deletes
          // what it is given, so an open item it was not given stays.
          const refused = new Set()
          let wanted = ids
          if (args.open_only === true) {
            const open = new Set(store.items().filter(item => item.status === 'open').map(item => item.id))
            if (wanted === null) {
              if (open.size > 0) {
                throw new TodoError(
                  'open_items_present',
                  `todo: ${open.size} item${open.size === 1 ? ' is' : 's are'} still open; pass their ids or mark them done first`,
                )
              }
            } else {
              wanted = []
              for (const id of ids) {
                if (open.has(id)) refused.add(id)
                else wanted.push(id)
              }
            }
          }
          const shown = context()
          const before = new Map(store.items().map(item => [item.id, item]))
          const { removed, absent } = wanted === null ? await store.removeFinished() : await store.remove(wanted)
          return {
            ok: true,
            removed: removed.map(id => present(before.get(id), shown)),
            absent: [...absent, ...refused],
            count: removed.length,
            remaining: store.items().length,
          }
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}

/**
 * Project one patch entry onto the store's change request.
 *
 * `due_at` and `time_zone` together replace the item's time; `repeat` and its
 * refinements replace the rule. A field the caller omitted keeps its stored
 * value.
 *
 * @param change - the model's change entry.
 * @returns the store change.
 */
function changesEntry(change) {
  const patch = {}
  if (change.status !== undefined) patch.status = change.status
  if (change.title !== undefined) patch.title = change.title
  const dueAt = change.due_at ?? change.dueAt
  if (dueAt !== undefined) {
    patch.due = dueAt === null ? null : { dueAt, timeZone: change.time_zone ?? change.timeZone }
  }
  if (change.note !== undefined) patch.note = change.note
  const repeat = repeatOf(change)
  if (repeat !== null) patch.recurrence = repeat
  else if (change.repeat === null) patch.recurrence = null
  const remind = change.remind_before_min ?? change.remindBeforeMin
  if (remind !== undefined) patch.remindBeforeMin = remind
  return { id: change.id, patch }
}

/**
 * Project one store result as the tool's result entry.
 *
 * @param result - the store's per-entry result.
 * @param shown - the projection context.
 * @returns the projected result.
 */
function describeResult(result, shown) {
  // A refusal that says why is one the model can fix; the code alone often just
  // invites the same call again.
  const why = typeof result.message === 'string' && result.message !== '' ? { message: result.message } : {}
  if (result.item !== undefined) return { id: result.id, code: result.code, ...why, current: present(result.item, shown) }
  if (result.current !== undefined) return { id: result.id, code: result.code, ...why, current: present(result.current, shown) }
  return { id: result.id, code: result.code, ...why }
}

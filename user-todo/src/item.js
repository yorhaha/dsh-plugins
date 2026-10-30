/**
 * One item of the user's todo list, exactly as the medium holds it.
 *
 * A JSON Schema description rather than an assertion library: the Host checks a
 * stored item with zod, the panel checks its own edits in the browser, and the
 * tools name the same fields in their output schemas. Types are written in
 * JSDoc so an editor follows them without a build step.
 *
 * The instant is `YYYY-MM-DDTHH:MM:SSZ`. Second precision keeps the stored
 * document readable by hand; two edits inside one second share the same stamp.
 *
 * Time comes in two shapes, and the shape is the type: a timed item carries
 * `dueAt`, an all-day item carries `dueDate`. An all-day item also keeps a
 * `dueAt`, but it is derived — local midnight of `dueDate` in the item's zone —
 * and exists only so ordering and reminders have one sortable instant. Nothing
 * may read a date back out of it: in another zone that instant is the previous
 * afternoon, which is exactly the bug the two-field model avoids.
 *
 * @module dsh-user-todo/src/item
 */

import { FREQS } from './recurrence.js'

/** How one item moves through the list. Two states only: progress belongs to the agent's own `todo_write` list. */
export const STATUSES = ['open', 'done']

/** Which surface last wrote an item. */
export const SOURCES = ['user', 'agent']

/**
 * An instant the list records.
 *
 * @param now - the instant to stamp, or nothing for the current clock.
 * @returns the stamped instant.
 */
export function instant(now = new Date()) {
  return `${now.toISOString().slice(0, 19)}Z`
}

/**
 * @typedef {object} Recurrence
 * @property {'daily' | 'weekly' | 'monthly' | 'yearly'} freq - how often the series repeats.
 * @property {number} interval - every N periods.
 * @property {number[]} byWeekday - weekdays (1 = Monday) for a weekly rule; empty means the start date's weekday.
 * @property {number | null} count - most occurrences the series produces, or null.
 * @property {string | null} until - last start instant the series may produce, or null.
 * @property {string | null} dtstart - first start instant, or null for the item's own due value.
 */

/**
 * @typedef {object} Item
 * @property {string} id - stable identity, `todo-` plus a UUID; the writer names it in every later change.
 * @property {'open' | 'done'} status - lifecycle state; marking `done` stamps `completedAt`, marking `open` clears it.
 * @property {string} title - the one-line subject.
 * @property {string | null} note - optional detail.
 * @property {string | null} dueAt - the timed due instant; for an all-day item, derived local midnight.
 * @property {string | null} dueDate - the all-day calendar date, or null for a timed item.
 * @property {string | null} timeZone - IANA zone the item was authored in, or null for the deployment default.
 * @property {Recurrence | null} recurrence - the repeat rule, or null.
 * @property {string | null} recurrenceDoneThrough - last completed occurrence start in a repeated series.
 * @property {string[]} exdates - occurrence starts this series skips.
 * @property {number[]} remindBeforeMin - minutes before the due moment to remind at.
 * @property {string} createdAt - when the item was added.
 * @property {string} updatedAt - when it last changed.
 * @property {string | null} completedAt - when it was last marked done.
 * @property {'user' | 'agent'} lastWriter - who made the latest change; the panel shows it on agent edits.
 */

/**
 * One change to one item. A key that is absent keeps the stored value; `null`
 * clears an optional field. That difference is what lets a panel that emptied a
 * date input mean "clear" while a tool that omitted a date argument means
 * "keep".
 *
 * `due` carries the whole time decision rather than three independent fields,
 * because "timed or all-day" is one choice: a patch either keeps it, clears it,
 * or replaces it, and it cannot leave a date with no instant or the reverse.
 *
 * @typedef {object} Patch
 * @property {string} [title] - replacement subject.
 * @property {string | null} [note] - replacement detail, or null to clear.
 * @property {{ dueAt?: string | null, dueDate?: string | null, timeZone?: string | null } | null} [due] - replacement time, or null to clear.
 * @property {Recurrence | null} [recurrence] - replacement rule, or null to clear.
 * @property {number[] | null} [remindBeforeMin] - replacement reminder offsets, or null to clear.
 * @property {'open' | 'done'} [status] - replacement state.
 */

/** JSON Schema of one repeat rule, as a tool result publishes it. */
export const RECURRENCE_JSON_SCHEMA = {
  type: 'object',
  required: ['freq', 'interval', 'byWeekday', 'count', 'until', 'dtstart'],
  properties: {
    freq: { type: 'string', enum: FREQS },
    interval: { type: 'integer' },
    byWeekday: { type: 'array', items: { type: 'integer' } },
    count: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    until: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    dtstart: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
  additionalProperties: false,
}

/**
 * JSON Schema of one stored item, as a tool result publishes it. An absent
 * optional value is published as null; the registry's schema subset has one
 * type per node, so a nullable field is a `oneOf` with a null branch rather
 * than a type array.
 */
export const ITEM_JSON_SCHEMA = {
  type: 'object',
  required: [
    'id', 'status', 'title', 'note',
    'dueAt', 'dueDate', 'timeZone', 'recurrence', 'recurrenceDoneThrough', 'exdates', 'remindBeforeMin',
    'createdAt', 'updatedAt', 'completedAt', 'lastWriter',
  ],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: STATUSES },
    title: { type: 'string' },
    note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    dueAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    dueDate: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timeZone: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    recurrence: { oneOf: [RECURRENCE_JSON_SCHEMA, { type: 'null' }] },
    recurrenceDoneThrough: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    exdates: { type: 'array', items: { type: 'string' } },
    remindBeforeMin: { type: 'array', items: { type: 'integer' } },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    completedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    lastWriter: { type: 'string', enum: SOURCES },
  },
  additionalProperties: false,
}

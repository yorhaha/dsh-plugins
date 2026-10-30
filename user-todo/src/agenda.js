/**
 * The agenda: which occurrences of which items fall inside a window.
 *
 * This is the projection every dated surface reads — the month grid, the day
 * list, the `list_user_agenda` tool, and the reminder planner. It owns two rules
 * that would otherwise be repeated (and eventually disagree) in four places:
 * what an occurrence is called, and whether that occurrence is done.
 *
 * An occurrence id is derived, never stored: `item id` plus the occurrence's
 * start instant. That makes it stable across restarts, checkable by hand, and
 * unaffected by whether the occurrence is currently materialized anywhere.
 *
 * @module dsh-user-todo/src/agenda
 */

import { MAX_OCCURRENCES, anchorOf, describeRule, expandOccurrences, nextOccurrence } from './recurrence.js'
import { DATE_PATTERN, formatInstant, instantOfLocalMidnight, localDateOf, parseInstant } from './zone.js'

/** Most occurrences one agenda answers; the caller may ask for fewer. */
export { MAX_OCCURRENCES }

/**
 * A refused window, carrying a closed code.
 */
export class AgendaError extends Error {
  /**
   * @param {'invalid_window' | 'window_too_large'} code - closed failure code.
   * @param {string} message - diagnostic naming the field.
   */
  constructor(code, message) {
    super(message)
    this.name = 'AgendaError'
    this.code = code
  }
}

/**
 * The identity of one occurrence.
 *
 * @param itemId - the item it belongs to.
 * @param millis - the occurrence's start instant.
 * @returns the derived id.
 */
export function occurrenceIdOf(itemId, millis) {
  return `${itemId}@${formatInstant(millis)}`
}

/**
 * Whether one occurrence of an item has been completed.
 *
 * A repeated item is finished one occurrence at a time: `recurrenceDoneThrough`
 * is the watermark of the last completed start, so everything at or before it is
 * done and the series itself stays open. A single item has only its status.
 *
 * @param item - the stored item.
 * @param millis - the occurrence's start instant.
 * @returns true when that occurrence is done.
 */
export function isOccurrenceDone(item, millis) {
  if (item.recurrence !== null && item.recurrence !== undefined) {
    if (item.status === 'done') return true
    if (item.recurrenceDoneThrough === null || item.recurrenceDoneThrough === undefined) return false
    const watermark = parseInstant(item.recurrenceDoneThrough)
    return !Number.isNaN(watermark) && millis <= watermark
  }
  return item.status === 'done'
}

/**
 * One occurrence, as every surface reads it.
 *
 * @typedef {object} Occurrence
 * @property {string} occurrenceId - derived identity, `todo-…@<instant>`.
 * @property {string} itemId - the item it belongs to.
 * @property {string} title - the item's title.
 * @property {string | null} note - the item's detail.
 * @property {boolean} allDay - whether the date, not the instant, is what a reader uses.
 * @property {string} startAt - the occurrence's start instant.
 * @property {string} date - the calendar date in the item's zone.
 * @property {boolean} done - whether this occurrence is complete.
 * @property {'open' | 'done'} status - the same value as a status name.
 * @property {object | null} recurrence - the stored rule, or null.
 * @property {string} recurrenceText - short English description of the rule.
 * @property {number[]} remindBeforeMin - reminder offsets the item asks for.
 * @property {'user' | 'agent'} lastWriter - who last changed the item.
 */

/**
 * Project one expansion result as an occurrence.
 *
 * @param item - the stored item.
 * @param found - one entry from the expansion.
 * @param recurrenceText - the rule's description.
 * @returns the occurrence.
 */
function present(item, found, recurrenceText) {
  const done = isOccurrenceDone(item, found.millis)
  return {
    occurrenceId: occurrenceIdOf(item.id, found.millis),
    itemId: item.id,
    title: item.title,
    note: item.note ?? null,
    allDay: found.allDay,
    startAt: formatInstant(found.millis),
    date: found.date,
    done,
    status: done ? 'done' : 'open',
    recurrence: item.recurrence ?? null,
    recurrenceText,
    remindBeforeMin: Array.isArray(item.remindBeforeMin) ? [...item.remindBeforeMin] : [],
    lastWriter: item.lastWriter,
  }
}

/**
 * Every occurrence inside a window, ascending.
 *
 * Undated items are absent by construction: an agenda is about when things
 * happen, and the undated list already has its own view.
 *
 * @param items - the stored items.
 * @param options - the window and the zone.
 * @param options.from - inclusive window start, epoch milliseconds.
 * @param options.to - exclusive window end, epoch milliseconds.
 * @param options.timeZone - zone used by items that name none.
 * @param options.includeDone - keep completed occurrences; defaults to false.
 * @param options.limit - most occurrences to return.
 * @param options.describe - rule description function; defaults to the model-facing one.
 * @returns the occurrences in display order.
 */
export function buildAgenda(items, options) {
  const { from, to, timeZone, includeDone = false, limit = MAX_OCCURRENCES } = options
  /** @type {Occurrence[]} */
  const collected = []
  const describe = options.describe ?? describeRule
  for (const item of items) {
    if (anchorOf(item, typeof item.timeZone === 'string' ? item.timeZone : timeZone) === null) continue
    const recurrenceText = describe(item.recurrence ?? null)
    const found = expandOccurrences(item, { from, to, timeZone, limit })
    for (const entry of found) {
      if (!includeDone && isOccurrenceDone(item, entry.millis)) continue
      collected.push(present(item, entry, recurrenceText))
    }
  }
  collected.sort((left, right) => {
    if (left.startAt !== right.startAt) return left.startAt < right.startAt ? -1 : 1
    return left.itemId.localeCompare(right.itemId)
  })
  return collected.length > limit ? collected.slice(0, limit) : collected
}

/**
 * The next occurrence of one item at or after a moment.
 *
 * "Next" means the next one that is not already done, so a daily item completed
 * this morning points at tomorrow. Because completion is a watermark, the search
 * can start just past it instead of walking a year of finished occurrences.
 *
 * @param item - the stored item.
 * @param options - the moment to search from and the zone.
 * @param options.after - inclusive lower bound, epoch milliseconds.
 * @param options.timeZone - zone used when the item names none.
 * @returns the occurrence, or null when the series has no more.
 */
export function nextOf(item, { after, timeZone }) {
  const recurring = item.recurrence !== null && item.recurrence !== undefined
  if (item.status === 'done') return null
  if (!recurring) {
    const anchor = anchorOf(item, typeof item.timeZone === 'string' ? item.timeZone : timeZone)
    if (anchor === null || anchor.millis < after) return null
    return present(item, anchor, describeRule(item.recurrence ?? null))
  }
  const watermark = item.recurrenceDoneThrough === null || item.recurrenceDoneThrough === undefined
    ? Number.NaN
    : parseInstant(item.recurrenceDoneThrough)
  const from = Number.isNaN(watermark) || watermark < after ? after : watermark + 1000
  const found = nextOccurrence(item, { after: from, timeZone })
  return found === null ? null : present(item, found, describeRule(item.recurrence))
}

/**
 * Read one window endpoint: a calendar date means local midnight, an instant
 * means itself.
 *
 * @param value - the endpoint as written.
 * @param timeZone - the zone a bare date is read in.
 * @returns epoch milliseconds, or NaN when the value is neither form.
 */
export function parseWindowPoint(value, timeZone) {
  if (typeof value !== 'string') return Number.NaN
  if (DATE_PATTERN.test(value)) return instantOfLocalMidnight(value, timeZone)
  return parseInstant(value)
}

/**
 * Resolve a requested window, filling the default of "today, then seven days".
 *
 * @param request - the raw `from` and `to` the caller wrote.
 * @param options - the clock, the zone, and the accepted span.
 * @param options.now - the current instant, epoch milliseconds.
 * @param options.timeZone - the zone bare dates are read in.
 * @param options.maxSpanDays - longest accepted span in days.
 * @returns the resolved window as epoch milliseconds.
 * @throws {AgendaError} `invalid_window` or `window_too_large`.
 */
export function resolveWindow(request, { now, timeZone, maxSpanDays }) {
  const today = localDateOf(now, timeZone)
  const defaultFrom = instantOfLocalMidnight(today, timeZone)
  const DAY = 24 * 60 * 60 * 1000
  const from = request?.from === undefined || request.from === null || request.from === ''
    ? defaultFrom
    : parseWindowPoint(request.from, timeZone)
  const to = request?.to === undefined || request.to === null || request.to === ''
    ? from + 7 * DAY
    : parseWindowPoint(request.to, timeZone)
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new AgendaError('invalid_window', 'todo: `from` and `to` must be a date (2026-11-02) or a UTC instant')
  }
  if (to <= from) throw new AgendaError('invalid_window', 'todo: the window must end after it starts')
  if (to - from > maxSpanDays * DAY) {
    throw new AgendaError('window_too_large', `todo: the window must not span more than ${maxSpanDays} days`)
  }
  return { from, to }
}

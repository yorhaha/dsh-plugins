/**
 * Recurrence rules and the expansion of a repeated item into occurrences.
 *
 * The stored rule is a small structured object rather than an RFC 5545 `RRULE`
 * string. The reasoning is in `docs/calendar-plan.md`: a structured rule is
 * validated field by field when it is written, and `.ics` export compiles it to
 * a standard `RRULE` at the edge instead of parsing one in the middle. The
 * supported subset is the one this bundle documents, and anything outside it is
 * refused by name rather than silently dropped.
 *
 * Expansion is a pure function of the item and a window: no clock, no I/O. It is
 * the only place a repeated item becomes concrete dates, so the panel, the tools,
 * and the reminder scheduler cannot disagree about when something happens.
 *
 * @module dsh-user-todo/src/recurrence
 */

import {
  addLocalDays,
  daysBetween,
  daysInMonth,
  dateString,
  formatInstant,
  instantFromParts,
  instantOfLocalMidnight,
  localDateOf,
  parseInstant,
  startOfWeek,
  weekdayOf,
  zonedParts,
} from './zone.js'

/** Frequencies this subset supports. */
export const FREQS = ['daily', 'weekly', 'monthly', 'yearly']

/** Longest accepted `interval`; a larger step is a data error, not a plan. */
export const MAX_INTERVAL = 100

/** Most occurrences one series may declare; keeps a `COUNT=10^6` off the list. */
export const MAX_COUNT = 2000

/** Most occurrences one expansion returns, whatever the window asked for. */
export const MAX_OCCURRENCES = 400

/**
 * A refused rule, carrying a closed code so every surface reports it the same
 * way.
 */
export class RecurrenceError extends Error {
  /**
   * @param {'invalid_recurrence' | 'unsupported_rule'} code - closed failure code.
   * @param {string} message - diagnostic naming the field.
   */
  constructor(code, message) {
    super(message)
    this.name = 'RecurrenceError'
    this.code = code
  }
}

/**
 * Read one day number of the week.
 *
 * @param value - candidate.
 * @returns the number, or null when it is not an integer 1–7.
 */
function weekdayOfValue(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 7 ? value : null
}

/**
 * Validate one rule and fill its defaults.
 *
 * A rule that is absent is `null`; a rule that is present must be usable as
 * written, because a quietly repaired rule would move someone's schedule.
 *
 * @param {unknown} raw - the value a writer supplied.
 * @returns {{ freq: string, interval: number, byWeekday: number[], count: number | null, until: string | null, dtstart: string | null } | null} the normalized rule.
 * @throws {RecurrenceError} `invalid_recurrence` or `unsupported_rule`.
 */
export function normalizeRecurrence(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RecurrenceError('invalid_recurrence', 'todo: `repeat` must be an object or null')
  }
  const rule = /** @type {Record<string, unknown>} */ (raw)
  for (const key of Object.keys(rule)) {
    if (!['freq', 'interval', 'byWeekday', 'count', 'until', 'dtstart'].includes(key)) {
      throw new RecurrenceError('invalid_recurrence', `todo: \`repeat.${key}\` is not a supported field`)
    }
  }
  const freq = rule.freq
  if (typeof freq !== 'string' || !FREQS.includes(freq)) {
    throw new RecurrenceError('invalid_recurrence', `todo: \`repeat.freq\` must be one of ${FREQS.join(', ')}`)
  }
  const interval = rule.interval ?? 1
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > MAX_INTERVAL) {
    throw new RecurrenceError('invalid_recurrence', `todo: \`repeat.interval\` must be an integer from 1 to ${MAX_INTERVAL}`)
  }
  const rawDays = rule.byWeekday ?? []
  if (!Array.isArray(rawDays)) {
    throw new RecurrenceError('invalid_recurrence', 'todo: `repeat.byWeekday` must be an array of weekdays')
  }
  const byWeekday = []
  for (const value of rawDays) {
    const day = weekdayOfValue(value)
    if (day === null) {
      throw new RecurrenceError('invalid_recurrence', 'todo: `repeat.byWeekday` accepts integers 1 (Monday) through 7 (Sunday)')
    }
    if (!byWeekday.includes(day)) byWeekday.push(day)
  }
  byWeekday.sort((left, right) => left - right)
  if (byWeekday.length > 0 && freq !== 'weekly') {
    // Nth-weekday-of-month and yearly BYDAY are part of RFC 5545 and outside this
    // subset. Refusing is honest; accepting and ignoring would move the series.
    throw new RecurrenceError('unsupported_rule', 'todo: `repeat.byWeekday` is only supported with `freq: "weekly"`')
  }
  const count = rule.count ?? null
  if (count !== null && (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT)) {
    throw new RecurrenceError('invalid_recurrence', `todo: \`repeat.count\` must be an integer from 1 to ${MAX_COUNT}, or null`)
  }
  const until = rule.until ?? null
  if (until !== null && Number.isNaN(parseInstant(until))) {
    throw new RecurrenceError('invalid_recurrence', 'todo: `repeat.until` must be a UTC instant, or null')
  }
  const dtstart = rule.dtstart ?? null
  if (dtstart !== null && Number.isNaN(parseInstant(dtstart))) {
    throw new RecurrenceError('invalid_recurrence', 'todo: `repeat.dtstart` must be a UTC instant, or null')
  }
  return { freq, interval, byWeekday, count, until, dtstart }
}

/** Weekday names in the order the rule numbers them. */
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * One short English sentence naming a rule. Used where the model reads the
 * result; the panel has its own localized copy.
 *
 * @param rule - the normalized rule.
 * @returns the description.
 */
export function describeRule(rule) {
  if (rule === null) return 'does not repeat'
  switch (rule.freq) {
    case 'daily':
      return rule.interval === 1 ? 'every day' : `every ${rule.interval} days`
    case 'weekly': {
      const days = rule.byWeekday.length === 0 ? [] : rule.byWeekday.map(day => WEEKDAY_NAMES[day - 1])
      const tail = days.length === 0 ? '' : ` on ${days.join(', ')}`
      return rule.interval === 1 ? `every week${tail}` : `every ${rule.interval} weeks${tail}`
    }
    case 'monthly':
      return rule.interval === 1 ? 'every month' : `every ${rule.interval} months`
    case 'yearly':
      return rule.interval === 1 ? 'every year' : `every ${rule.interval} years`
    default:
      return 'repeats'
  }
}

/**
 * The one time anchor an item has, whether it is timed or all-day.
 *
 * @param item - the stored item.
 * @param timeZone - the zone to read a timed item's date in.
 * @returns the anchor, or null when the item carries no time.
 */
export function anchorOf(item, timeZone) {
  if (typeof item.dueDate === 'string') {
    const date = item.dueDate
    return { millis: instantOfLocalMidnight(date, timeZone), date, allDay: true }
  }
  if (typeof item.dueAt === 'string') {
    const millis = parseInstant(item.dueAt)
    if (Number.isNaN(millis)) return null
    return { millis, date: localDateOf(millis, timeZone), allDay: false }
  }
  return null
}

/**
 * The first period index worth visiting when a window starts long after the
 * series did. Only used when the rule has no `count`, because a counted series
 * has to be walked from its first occurrence to know which one it is on.
 *
 * @param rule - the normalized rule.
 * @param startDate - the series' first local date.
 * @param fromDate - the window's first local date.
 * @returns the period index, never negative.
 */
function fastForwardIndex(rule, startDate, fromDate) {
  const { freq, interval } = rule
  const span = daysBetween(startDate, fromDate)
  let periods
  switch (freq) {
    case 'daily': periods = span
      break
    case 'weekly': periods = Math.floor(daysBetween(startOfWeek(startDate), startOfWeek(fromDate)) / 7)
      break
    case 'monthly': {
      const [startYear, startMonth] = startDate.split('-').map(Number)
      const [fromYear, fromMonth] = fromDate.split('-').map(Number)
      periods = (fromYear - startYear) * 12 + (fromMonth - startMonth)
      break
    }
    case 'yearly': periods = Number(fromDate.slice(0, 4)) - Number(startDate.slice(0, 4))
      break
    default: periods = 0
  }
  // One period back: a weekly rule's period may already be in the window.
  return Math.max(0, Math.floor(periods / interval) - 1)
}

/**
 * The local dates one period of a rule produces.
 *
 * A month without the series' day of month is skipped rather than clamped:
 * a rule on the 31st does not fire on the 30th of a short month, which is what
 * RFC 5545 asks for and what a person expects.
 *
 * @param rule - the normalized rule.
 * @param startDate - the series' first local date.
 * @param index - the period index.
 * @returns the dates in that period, ascending.
 */
function periodDates(rule, startDate, index) {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number)
  const step = index * rule.interval
  switch (rule.freq) {
    case 'daily':
      return [addLocalDays(startDate, step)]
    case 'weekly': {
      const weekStart = addLocalDays(startOfWeek(startDate), step * 7)
      const days = rule.byWeekday.length === 0 ? [weekdayOf(startDate)] : rule.byWeekday
      return days.map(day => addLocalDays(weekStart, day - 1))
    }
    case 'monthly': {
      const months = startMonth - 1 + step
      const year = startYear + Math.floor(months / 12)
      const month = (months % 12) + 1
      return startDay > daysInMonth(year, month) ? [] : [dateString(year, month, startDay)]
    }
    case 'yearly': {
      const year = startYear + step
      const monthLength = daysInMonth(year, startMonth)
      // A series that starts on 29 February skips non-leap years.
      return startDay > monthLength ? [] : [dateString(year, startMonth, startDay)]
    }
    default:
      return []
  }
}

/**
 * Expand one item into the occurrences that fall inside a window.
 *
 * @param item - the stored item.
 * @param options - the window and the zone a timed item is read in.
 * @param options.from - inclusive window start, epoch milliseconds.
 * @param options.to - exclusive window end, epoch milliseconds.
 * @param options.timeZone - zone used when the item names none.
 * @param options.limit - most occurrences to return; defaults to {@link MAX_OCCURRENCES}.
 * @returns the occurrences, ascending, each `{ millis, date, allDay }`.
 */
export function expandOccurrences(item, { from, to, timeZone, limit = MAX_OCCURRENCES }) {
  const zone = typeof item.timeZone === 'string' ? item.timeZone : timeZone
  const rule = item.recurrence
  if (rule === null || rule === undefined) {
    const anchor = anchorOf(item, zone)
    if (anchor === null) return []
    return anchor.millis >= from && anchor.millis < to ? [anchor] : []
  }
  if (to <= from) return []
  const anchor = anchorOf(item, zone)
  const startMillis = rule.dtstart === null ? anchor?.millis : parseInstant(rule.dtstart)
  if (startMillis === undefined || startMillis === null || Number.isNaN(startMillis)) return []
  const startDate = localDateOf(startMillis, zone)
  const clock = zonedParts(startMillis, zone)
  const until = rule.until === null ? null : parseInstant(rule.until)
  const exdates = new Set(Array.isArray(item.exdates) ? item.exdates : [])
  const fromDate = localDateOf(from, zone)

  /** @type {Array<{ millis: number, date: string, allDay: boolean }>} */
  const found = []
  let index = rule.count === null ? fastForwardIndex(rule, startDate, fromDate) : 0
  let produced = 0
  // A counted series is walked from its first occurrence; an open one starts
  // near the window. Either way the loop is bounded, so a malformed rule cannot
  // spin: no rule needs more than a few periods to leave one 366-day window.
  const guard = Math.min(MAX_OCCURRENCES * 8, 20_000)
  for (let visited = 0; visited < guard; visited += 1) {
    const dates = periodDates(rule, startDate, index)
    for (const date of dates) {
      const [year, month, day] = date.split('-').map(Number)
      const millis = instantFromParts({ year, month, day, hour: clock.hour, minute: clock.minute }, zone)
      if (millis < startMillis) continue
      if (rule.count !== null) {
        produced += 1
        if (produced > rule.count) return found
      }
      if (until !== null && millis > until) return found
      if (millis >= to) return found
      if (millis < from) continue
      if (exdates.has(formatInstant(millis))) continue
      found.push({ millis, date: item.dueDate == null ? localDateOf(millis, zone) : date, allDay: item.dueDate != null })
      if (found.length >= limit) return found
    }
    index += 1
    // Without a count, a series that never reaches the window must still end
    // here; the guard does that. With a count, `produced` handles it.
  }
  return found
}

/**
 * The next occurrence at or after one instant, within a year.
 *
 * Used by the list view's "next time" line and by the reminder planner, both of
 * which need one answer rather than a window.
 *
 * @param item - the stored item.
 * @param options - the instant to search from and the zone.
 * @param options.after - inclusive lower bound, epoch milliseconds.
 * @param options.timeZone - zone used when the item names none.
 * @returns the first occurrence, or null when the series has no more.
 */
export function nextOccurrence(item, { after, timeZone }) {
  const DAY = 24 * 60 * 60 * 1000
  const found = expandOccurrences(item, { from: after, to: after + 366 * DAY, timeZone, limit: 1 })
  return found.length === 0 ? null : found[0]
}

/**
 * Local wall-clock arithmetic over the platform's own time-zone database.
 *
 * Everything the calendar does with a "local time" — a deadline typed as
 * `2026-11-02T15:00`, an all-day date, a recurrence that must stay at 09:00
 * across a daylight-saving change — is two conversions: an instant to the
 * wall-clock parts a person reads, and back. Node ships full ICU, so
 * `Intl.DateTimeFormat` is the authority; the standard library has no
 * zone-aware constructor and `Temporal` is not on by default, so the two-pass
 * conversion below is written out rather than imported.
 *
 * `Temporal` is deliberately not a dependency: this bundle runs inside the
 * Harness's own Node, and a polyfill would be a runtime cost paid on every
 * load for two functions.
 *
 * Instants are epoch milliseconds inside this module. The stored form is the
 * second-precision UTC string the rest of the bundle uses ({@link formatInstant}).
 *
 * @module dsh-user-todo/src/zone
 */

/** A stored instant: second precision, UTC, the form every timestamp uses. */
export const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** A calendar date with no time of day. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** A local wall-clock date and time, minutes precision. */
const LOCAL_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** One formatter per zone; building one is the expensive part of a conversion. */
const FORMATTERS = new Map()

/**
 * The formatter for one zone, with the fields read back as numbers.
 *
 * @param timeZone - IANA zone name.
 * @returns the cached formatter.
 */
function formatterOf(timeZone) {
  let formatter = FORMATTERS.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Whether a string names a zone this runtime knows.
 *
 * @param value - candidate IANA name.
 * @returns true when `Intl` accepts it.
 */
export function isTimeZone(value) {
  if (typeof value !== 'string' || value === '') return false
  try {
    formatterOf(value)
    return true
  } catch {
    return false
  }
}

/**
 * The zone this process runs in, used when an item names none.
 *
 * @returns the IANA name.
 */
export function systemTimeZone() {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof resolved === 'string' && resolved !== '' ? resolved : 'UTC'
}

/**
 * The wall-clock fields one instant has in one zone.
 *
 * @param millis - the instant.
 * @param timeZone - IANA zone name.
 * @returns the parts, seconds precision.
 */
export function zonedParts(millis, timeZone) {
  /** @type {Record<string, string>} */
  const fields = {}
  for (const part of formatterOf(timeZone).formatToParts(new Date(millis))) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
    second: Number(fields.second),
  }
}

/**
 * The zone's offset from UTC at one instant, in minutes.
 *
 * @param millis - the instant.
 * @param timeZone - IANA zone name.
 * @returns minutes east of UTC.
 */
export function offsetMinutes(millis, timeZone) {
  const parts = zonedParts(millis, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - millis) / MINUTE)
}

/**
 * Whether two wall-clock readings name the same minute.
 *
 * @param left - one reading.
 * @param right - the other.
 * @returns true when every field matches.
 */
function sameMinute(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute
}

/**
 * The instant one wall-clock reading names in one zone.
 *
 * A zone's offset can change inside the ±12 hours the two-pass lookup samples,
 * which is exactly the daylight-saving case. Two rules decide the edges, both
 * stated here because a silent default would drift a recurring item by an hour:
 *
 * - an hour that occurs twice (autumn overlap) resolves to the **earlier**
 *   instant, matching RFC 5545's guidance for ambiguous local times;
 * - an hour that does not exist (spring gap) **shifts forward** past the gap,
 *   because the alternative is dropping the occurrence.
 *
 * @param parts - year, month (1-based), day, hour, minute, and optional second.
 * @param timeZone - IANA zone name.
 * @returns the instant in epoch milliseconds.
 */
export function instantFromParts(parts, timeZone) {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0)
  const wanted = { ...parts, second: parts.second ?? 0 }
  const offsets = new Set([
    offsetMinutes(naive - 12 * HOUR, timeZone),
    offsetMinutes(naive, timeZone),
    offsetMinutes(naive + 12 * HOUR, timeZone),
  ])
  /** @type {number[]} */
  const matches = []
  for (const offset of offsets) {
    const candidate = naive - offset * MINUTE
    if (sameMinute(zonedParts(candidate, timeZone), wanted)) matches.push(candidate)
  }
  if (matches.length > 0) return Math.min(...matches)
  // No offset maps back: this local time fell into a spring-forward gap. The
  // pre-transition offset lands after the gap, which is the "shift forward"
  // rule, and keeps the occurrence instead of losing it.
  return naive - offsetMinutes(naive - 12 * HOUR, timeZone) * MINUTE
}

/**
 * The instant local midnight of one date has in one zone.
 *
 * Midnight can itself be skipped where a zone moves its clock at 00:00; the
 * shift-forward rule in {@link instantFromParts} covers that.
 *
 * @param date - `YYYY-MM-DD`.
 * @param timeZone - IANA zone name.
 * @returns the instant in epoch milliseconds.
 */
export function instantOfLocalMidnight(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number)
  return instantFromParts({ year, month, day, hour: 0, minute: 0 }, timeZone)
}

/**
 * The calendar date one instant falls on in one zone.
 *
 * @param millis - the instant.
 * @param timeZone - IANA zone name.
 * @returns `YYYY-MM-DD`.
 */
export function localDateOf(millis, timeZone) {
  const parts = zonedParts(millis, timeZone)
  return dateString(parts.year, parts.month, parts.day)
}

/**
 * The clock time one instant has in one zone.
 *
 * @param millis - the instant.
 * @param timeZone - IANA zone name.
 * @returns `HH:MM`.
 */
export function localClockOf(millis, timeZone) {
  const parts = zonedParts(millis, timeZone)
  return `${pad(parts.hour)}:${pad(parts.minute)}`
}

/**
 * One date written the stored way.
 *
 * @param year - four-digit year.
 * @param month - 1-based month.
 * @param day - day of month.
 * @returns `YYYY-MM-DD`.
 */
export function dateString(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

/**
 * Zero-pad a number to two digits.
 *
 * @param value - the number.
 * @returns the padded text.
 */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * A date shifted by whole days, on the calendar rather than the clock.
 *
 * Uses UTC fields so the arithmetic never meets a local zone rule.
 *
 * @param date - `YYYY-MM-DD`.
 * @param days - signed day count.
 * @returns the shifted `YYYY-MM-DD`.
 */
export function addLocalDays(date, days) {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return dateString(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

/**
 * The ISO weekday of one date: Monday is 1 and Sunday is 7.
 *
 * @param date - `YYYY-MM-DD`.
 * @returns the weekday number.
 */
export function weekdayOf(date) {
  const [year, month, day] = date.split('-').map(Number)
  const sundayBased = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return sundayBased === 0 ? 7 : sundayBased
}

/**
 * How many days a month has.
 *
 * @param year - four-digit year.
 * @param month - 1-based month.
 * @returns the day count.
 */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The whole days from one date to another.
 *
 * @param from - `YYYY-MM-DD`.
 * @param to - `YYYY-MM-DD`.
 * @returns signed day count.
 */
export function daysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY)
}

/**
 * The Monday that starts one date's week.
 *
 * @param date - `YYYY-MM-DD`.
 * @returns that week's Monday as `YYYY-MM-DD`.
 */
export function startOfWeek(date) {
  return addLocalDays(date, 1 - weekdayOf(date))
}

/**
 * A stored instant for one epoch reading.
 *
 * @param millis - the instant.
 * @returns `YYYY-MM-DDTHH:MM:SSZ`.
 */
export function formatInstant(millis) {
  return `${new Date(millis).toISOString().slice(0, 19)}Z`
}

/**
 * The epoch reading a stored instant names.
 *
 * @param text - `YYYY-MM-DDTHH:MM:SSZ`.
 * @returns the milliseconds, or NaN when the text is not that form.
 */
export function parseInstant(text) {
  if (typeof text !== 'string' || !INSTANT_PATTERN.test(text)) return Number.NaN
  return Date.parse(text)
}

/**
 * Split a local wall-clock reading.
 *
 * @param text - `YYYY-MM-DDTHH:MM`.
 * @returns the date and the hour and minute, or null when the text is not that form.
 */
export function parseLocal(text) {
  const found = typeof text === 'string' ? LOCAL_PATTERN.exec(text) : null
  if (found === null) return null
  const hour = Number(found[2])
  const minute = Number(found[3])
  if (hour > 23 || minute > 59) return null
  return { date: found[1], hour, minute }
}

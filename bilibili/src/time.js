/**
 * Reading the ISO-8601 bounds the search tool accepts.
 *
 * The corpus stores every instant as canonical ISO-8601 UTC, and search compares
 * the bounds to those strings directly. An offset-bearing bound such as
 * `2026-10-19T11:00:00+08:00` is the same instant as `2026-10-19T03:00:00Z`, but
 * it is a different string, so comparing the raw text would silently include or
 * exclude the wrong rows. Every bound is therefore resolved to the canonical
 * form here, before the store sees it.
 *
 * A bound without an offset is a wall-clock reading in the host's time zone,
 * which is the zone a user writing a date means; a bare date is that day's local
 * midnight. A bound carrying `Z` or an offset is already an instant and is taken
 * as written.
 *
 * @module dsh-bilibili/src/time
 */

/** A date, or a date-time with optional seconds, fraction, and offset. */
const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * Resolve one search bound to the canonical ISO-8601 UTC form the corpus stores.
 *
 * @param value - the bound text, if the caller supplied one.
 * @returns the canonical instant, or null when the text is not a usable bound.
 */
export function instantOf(value) {
  if (typeof value !== 'string') return null
  const match = INSTANT_PATTERN.exec(value.trim())
  if (match === null) return null
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, offset] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = hourText === undefined ? 0 : Number(hourText)
  const minute = minuteText === undefined ? 0 : Number(minuteText)
  const second = secondText === undefined ? 0 : Number(secondText)
  const millisecond = fractionText === undefined
    ? 0
    : Number(fractionText.slice(0, 3).padEnd(3, '0'))
  // Prove the date exists before interpreting it: the Date constructors
  // normalize February 30 into March rather than rejecting it.
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond))
  if (
    utc.getUTCFullYear() !== year
    || utc.getUTCMonth() !== month - 1
    || utc.getUTCDate() !== day
    || utc.getUTCHours() !== hour
    || utc.getUTCMinutes() !== minute
    || utc.getUTCSeconds() !== second
  ) {
    return null
  }
  if (offset === undefined) {
    // No offset names an instant: read the fields in the host's zone, so a bare
    // date is local midnight and the result follows that zone's DST rules.
    const local = new Date(year, month - 1, day, hour, minute, second, millisecond)
    return local.toISOString()
  }
  if (offset === 'Z') return utc.toISOString()
  const sign = offset.startsWith('-') ? -1 : 1
  const offsetHours = Number(offset.slice(1, 3))
  const offsetMinutes = Number(offset.slice(-2))
  if (offsetHours > 23 || offsetMinutes > 59) return null
  return new Date(utc.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000).toISOString()
}

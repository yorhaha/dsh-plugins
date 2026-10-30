/**
 * Conversion between the instants the corpus stores and the readings a caller
 * writes.
 *
 * A stored time is always an instant. A search bound may be written as a bare
 * date or wall-clock reading, which carries no offset: resolving it against the
 * zone the deployment reads times in is what makes "today" mean the local day
 * rather than a UTC one. The zone side of that conversion lives here so the
 * offset is evaluated once, in one place.
 *
 * @module dsh-outlook/src/time
 */

/**
 * Offset of one zone at one instant, in minutes east of UTC.
 * @param zone - IANA zone name.
 * @param instantMs - The instant to evaluate.
 * @returns the offset in minutes, or 0 when the zone reports none.
 */
export function zoneOffsetMinutes(zone, instantMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(instantMs))
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(name)
  if (match?.groups?.sign === undefined) return 0
  const magnitude = Number(match.groups.hours) * 60 + Number(match.groups.minutes ?? 0)
  return match.groups.sign === '-' ? -magnitude : magnitude
}

/**
 * Convert one Graph time value, or any ISO-8601 date or reading a caller wrote,
 * to an instant.
 *
 * A value that already carries an offset or `Z` is taken as written; a bare
 * wall-clock value is interpreted in `zone`, with the offset re-evaluated once
 * at the resulting instant so a daylight-saving boundary lands correctly.
 *
 * @param value - Graph `dateTime` string, ISO-8601 date, or wall-clock reading.
 * @param zone - IANA zone a value without an offset is read in.
 * @returns the instant as ISO-8601 UTC, or null when unparseable.
 */
export function parseGraphDateTime(value, zone) {
  if (typeof value !== 'string' || value === '') return null
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  const trimmed = value.replace(/(\.\d{3})\d+/, '$1')
  const asUtc = Date.parse(`${trimmed}Z`)
  if (Number.isNaN(asUtc)) return null
  let offset = zoneOffsetMinutes(zone, asUtc)
  let instant = asUtc - offset * 60_000
  const refined = zoneOffsetMinutes(zone, instant)
  if (refined !== offset) {
    offset = refined
    instant = asUtc - offset * 60_000
  }
  return new Date(instant).toISOString()
}

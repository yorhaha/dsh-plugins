/**
 * Time conversion between the exporter's naive local timestamps, the corpus's
 * UTC instants, and the local calendar day a conversation was active on.
 *
 * The corpus stores one instant per message (`ts`, ISO-8601 UTC, sortable) and
 * one local day (`local_day`, `YYYY-MM-DD` in the configured zone), because
 * "how many days did we talk" is a local-calendar question and answering it in
 * SQL from UTC timestamps would be wrong for every zone with an offset.
 *
 * @module dsh-wechat/src/time
 */

/** Milliseconds in one day. */

/**
 * A zone-bound clock.
 *
 * One instance per plugin, built from the configured zone. `Intl` formatting is
 * the only DST-correct way to answer these questions without a dependency, and
 * it costs about 0.7 microseconds per call, which is why the day of every
 * message can be computed during import instead of being approximated.
 */
export class LocalClock {
  #zone
  #dayFormat
  #wallFormat

  /**
   * @param zone - An IANA zone name.
   */
  constructor(zone) {
    this.#zone = zone
    this.#dayFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    this.#wallFormat = new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }

  /** @returns the IANA zone this clock reads and writes in. */
  get zone() {
    return this.#zone
  }

  /**
   * Current instant.
   * @returns ISO-8601 UTC with milliseconds.
   */
  nowIso() {
    return new Date().toISOString()
  }

  /**
   * Convert an upstream second-resolution timestamp.
   * @param unixSeconds - Seconds since the epoch, as the exporter wrote them.
   * @returns the instant in milliseconds.
   */
  static toMillis(unixSeconds) {
    return Math.round(unixSeconds * 1000)
  }

  /**
   * The instant as stored.
   * @param millis - Milliseconds since the epoch.
   * @returns ISO-8601 UTC with milliseconds.
   */
  static isoOf(millis) {
    return new Date(millis).toISOString()
  }

  /**
   * The local calendar day an instant falls on.
   * @param millis - Milliseconds since the epoch.
   * @returns `YYYY-MM-DD` in this clock's zone.
   */
  dayOf(millis) {
    return this.#dayFormat.format(new Date(millis))
  }

  /**
   * Read a bound the model or the plugin page wrote.
   *
   * A date is that day's local midnight; a date-time with an offset is taken
   * literally; a date-time without one is read in this clock's zone, which is
   * what the exporter's own `export_time` needs.
   *
   * @param text - `YYYY-MM-DD` or an ISO-8601 date-time.
   * @returns the instant in milliseconds, or null when the text is not a bound.
   */
  instantOf(text) {
    if (typeof text !== 'string') return null
    const value = text.trim()
    if (value === '') return null
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(value)
    if (dateOnly !== null) return this.#instantOfWall(`${value}T00:00:00`)
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)) return null
    const normalized = value.replace(' ', 'T')
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(normalized)) {
      const literal = Date.parse(normalized)
      return Number.isNaN(literal) ? null : literal
    }
    return this.#instantOfWall(normalizeSeconds(normalized))
  }

  /**
   * The local wall clock reading of an instant.
   * @param millis - Milliseconds since the epoch.
   * @returns `YYYY-MM-DDTHH:mm:ss` in this clock's zone.
   */
  wallOf(millis) {
    return this.#wallFormat.format(new Date(millis)).replace(' ', 'T')
  }

  /**
   * The instant a local wall-clock reading denotes.
   *
   * The zone's offset is sampled at instants around the reading, and every
   * offset that reproduces the reading exactly is a candidate; the earliest one
   * wins, which is how a scheduler reads a wall time repeated by a fall-back.
   * A reading that no offset reproduces — the hour a spring-forward skips — is
   * read with the offset in force at that moment, so it lands on the instant the
   * clock jumps to.
   *
   * @param wall - `YYYY-MM-DDTHH:mm:ss` with no offset.
   * @returns milliseconds since the epoch, or null when the text is not a time.
   */
  #instantOfWall(wall) {
    const asUtc = Date.parse(`${wall}Z`)
    if (Number.isNaN(asUtc)) return null
    const offsets = new Set()
    for (const probe of [asUtc - 86_400_000, asUtc - 43_200_000, asUtc, asUtc + 43_200_000, asUtc + 86_400_000]) {
      offsets.add(probe - Date.parse(`${this.wallOf(probe)}Z`))
    }
    const candidates = []
    for (const offset of offsets) {
      const candidate = asUtc + offset
      if (this.wallOf(candidate) === wall) candidates.push(candidate)
    }
    if (candidates.length > 0) return Math.min(...candidates)
    return asUtc + (asUtc - Date.parse(`${this.wallOf(asUtc)}Z`))
  }
}

/**
 * Pad a date-time that carries no seconds, so it parses as wall-clock text.
 * @param value - ISO-8601 text with a `T` separator.
 * @returns the same text with seconds.
 */
function normalizeSeconds(value) {
  return /[T ]\d{2}:\d{2}$/.test(value) ? `${value}:00` : value
}

/**
 * Resolve a configured zone name, falling back to the host's own zone.
 * @param requested - Configured IANA zone, or an empty string.
 * @returns the zone name, or null when the requested zone is unknown.
 */
export function resolveZone(requested) {
  if (typeof requested === 'string' && requested.trim() !== '') {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: requested })
      return requested.trim()
    } catch {
      return null
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

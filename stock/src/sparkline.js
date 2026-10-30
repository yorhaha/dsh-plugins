/**
 * The intraday price series the watchlist panel draws beside each followed
 * security.
 *
 * One series costs one upstream minute read, and this plugin's client serializes
 * and paces every request, so a long watchlist cannot be refetched on each poll:
 * this module keeps the last outcome per code and, per request, refetches a
 * bounded number of the stalest codes. An outcome is either the drawn series or
 * the failure that stood in for it, so a code upstream has no intraday data for
 * is asked once per refresh window instead of on every poll.
 *
 * The cache belongs to one mounted plugin and dies with it. It holds series as
 * the panel draws them — an evenly thinned list of prices in time order — never
 * the rows upstream returned, and it is never written to storage.
 *
 * @module dsh-stock/src/sparkline
 */

/** Fewest points a drawn series can carry; one point is not a line. */
export const MIN_POINTS = 2

/**
 * Thin one price series to at most `limit` points, keeping the first and the last
 * so the line still spans the session it describes.
 *
 * @param points - every price of the series, in time order.
 * @param limit - largest number of points to keep, at least {@link MIN_POINTS}.
 * @returns the thinned series.
 */
function thin(points, limit) {
  if (points.length <= limit) return points
  const step = (points.length - 1) / (limit - 1)
  const out = []
  for (let index = 0; index < limit; index += 1) out.push(points[Math.round(index * step)])
  return out
}

/**
 * Build the panel's intraday series cache.
 *
 * @param options - Host inputs.
 * @param options.client - the shared process-local market client.
 * @param options.config - the resolved plugin configuration.
 * @param options.now - reads the current instant, so a check can move the clock.
 * @returns the reader the panel route calls.
 */
export function createSparklineCache({ client, config, now = () => Date.now() }) {
  /** Last outcome per code: `{ at, series }` or `{ at, failure }`. */
  const held = new Map()
  /** Reads already in flight, so two panels asking for one code fetch it once. */
  const inflight = new Map()

  const isFresh = (entry, at) => entry !== undefined && at - entry.at < config.sparklineRefreshMs

  /**
   * Read one code, sharing a read another caller already started.
   *
   * @param code - the canonical code.
   * @param signal - cancels the read.
   * @returns the series, or the failure the client reported in its place.
   */
  const readOne = (code, signal) => {
    const started = inflight.get(code)
    if (started !== undefined) return started
    const work = (async () => {
      const payload = await client.minute(code, signal)
      if (!payload.ok) return { failure: payload.error }
      return { series: { date: payload.date, points: thin(payload.rows.map(row => row.price), config.sparklinePoints) } }
    })()
    // The entry is dropped whatever the outcome, so one failed read cannot pin a
    // rejected promise in place of the next attempt.
    const tracked = work.finally(() => { inflight.delete(code) })
    inflight.set(code, tracked)
    return tracked
  }

  return {
    /**
     * Read the series of every code, refetching the stalest ones within the
     * configured budget.
     *
     * The codes beyond that budget are reported as pending rather than dropped,
     * and the stalest are refetched first, so a list longer than one request can
     * cover rotates instead of starving its tail. A code whose read failed keeps
     * its failure for one refresh window and is reported beside the series that
     * did arrive.
     *
     * @param codes - canonical codes, in the order the panel lists them.
     * @param signal - cancels the reads; a panel that has gone away does not need them.
     * @returns the ready series by code, the failures, and the codes left for a later request.
     */
    async read(codes, signal) {
      const wanted = [...new Set(codes)]
      const at = now()
      const stale = wanted.filter(code => !isFresh(held.get(code), at))
      stale.sort((left, right) => (held.get(left)?.at ?? 0) - (held.get(right)?.at ?? 0))
      let budget = config.sparklineMaxFetches
      const pending = []
      for (const code of stale) {
        if (budget === 0) {
          pending.push(code)
          continue
        }
        budget -= 1
        const outcome = await readOne(code, signal)
        held.set(code, { at: now(), ...outcome })
      }
      const series = {}
      const failed = []
      for (const code of wanted) {
        const entry = held.get(code)
        if (entry?.series !== undefined) series[code] = entry.series
        else if (entry?.failure !== undefined) failed.push({ code, error: entry.failure })
      }
      return { series, failed, pending }
    },
  }
}

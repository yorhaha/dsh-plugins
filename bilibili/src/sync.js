/**
 * The sync core: fetch each dataset, commit it, and record the outcome.
 *
 * This module owns no user interface. The agent tool drives it inside a
 * background job and the plugin page drives it from a Remote call, so both
 * share one implementation and one progress stream.
 *
 * Concurrency is process-local on purpose. The durable layer serializes
 * individual writes but not a whole sync, and nothing in the harness excludes a
 * second process from the same storage medium. A single in-flight guard is what
 * this plugin can actually enforce, and its absence is the reason a second
 * concurrent run is refused rather than queued.
 *
 * @module dsh-bilibili/src/sync
 */

import { AuthRequiredError, RateLimitedError, RiskControlError, WbiSignatureError, BilibiliClient, utcNowIso } from './client.js'
import { fetchFavorites, fetchFollowing, fetchHistory, fetchSelfDynamic, fetchWatchLater } from './fetch.js'
import { DATASETS } from './spec.js'

/** Risk-control backoff, indexed by consecutive rejection count. */
const RISK_BACKOFF_HOURS = [6, 24, 72]

/** Failures that stop the whole run because they apply to every dataset. */
const PLATFORM_FAILURES = [AuthRequiredError, RiskControlError, RateLimitedError, WbiSignatureError]

/**
 * Stable error code for any thrown value: a client error already carries one,
 * and anything else is reported by its class so a stack-free code still
 * identifies the failure.
 * @param error - The thrown value.
 * @returns the stable code.
 */
export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code !== '') return error.code
  return `internal_${error?.constructor?.name ?? 'Error'}`
}

/**
 * Instant before which the next sync attempt is pointless, given the recorded
 * platform state.
 * @param status - The domain's platform status.
 * @param now - Current instant in milliseconds.
 * @returns the deadline in milliseconds, or null when no backoff is active.
 */
export function retryDeadline(status, now) {
  if (status.retryNotBefore === null) return null
  const parsed = Date.parse(status.retryNotBefore)
  return Number.isNaN(parsed) || parsed <= now ? null : parsed
}

/**
 * Compute the platform-state patch for one platform-level failure.
 * @param status - The current platform status.
 * @param error - The failure.
 * @param now - Current instant in milliseconds.
 * @returns the fields to merge into the status.
 */
function platformFailurePatch(status, error, now) {
  const patch = { lastErrorCode: errorCode(error) }
  if (error instanceof AuthRequiredError) {
    patch.authRequired = true
  } else if (error instanceof RiskControlError) {
    const consecutive = Math.min(status.riskConsecutive + 1, RISK_BACKOFF_HOURS.length)
    patch.riskConsecutive = consecutive
    patch.retryNotBefore = new Date(now + RISK_BACKOFF_HOURS[consecutive - 1] * 3600_000).toISOString()
  } else if (error instanceof RateLimitedError) {
    patch.retryNotBefore = new Date(now + error.retryAfter * 1000).toISOString()
  }
  return patch
}

/**
 * Runs one sync at a time and reports progress to whoever started it.
 */
export class BilibiliSyncer {
  #store
  #readCredential
  #clock
  #logger
  #inFlight = null
  #abort = null
  #progress = null
  #onProgress = null

  /**
   * @param options - Construction options.
   * @param options.store - The open corpus handle.
   * @param options.readCredential - Resolves the stored cookie bag, or undefined when the account is not authorized.
   * @param options.clock - Returns the current instant in milliseconds.
   * @param options.logger - Sink for progress lines; optional.
   */
  constructor({ store, readCredential, clock = Date.now, logger }) {
    this.#store = store
    this.#readCredential = readCredential
    this.#clock = clock
    this.#logger = logger
  }

  /** @returns whether a sync is currently running. */
  get busy() {
    return this.#inFlight !== null
  }

  /** @returns the progress of the running sync, or null when idle. */
  get progress() {
    return this.#progress
  }

  /**
   * Resolve once the running sync settles. Used by teardown so the domain is
   * never closed under an in-flight write.
   * @returns resolution after the current run, if any, settles.
   */
  async drained() {
    while (this.#inFlight !== null) await this.#inFlight.catch(() => {})
  }

  /**
   * Run one sync.
   *
   * A run already in flight is refused rather than queued; the caller decides
   * whether that is an error or a no-op.
   *
   * @param options - Run options.
   * @param options.datasets - Datasets to capture, defaulting to all of them in order.
   * @param options.backfill - Spend the larger page budget on history backfill.
   * @param options.trigger - What asked for this run, for the progress line.
   * @param options.signal - Ends the run after the dataset in flight, so a cancelled caller leaves a consistent cursor.
   * @param options.onProgress - Receives one event per phase change.
   * @returns the per-dataset outcome.
   */
  async run({ datasets = DATASETS, backfill = false, trigger = 'manual', signal, onProgress } = {}) {
    if (this.#inFlight !== null) return { ok: false, skipped: true, reason: 'busy' }
    const abort = new AbortController()
    const combined = signal === undefined || signal === null
      ? abort.signal
      : AbortSignal.any([signal, abort.signal])
    const run = this.#run({ datasets, backfill, trigger, signal: combined })
    this.#inFlight = run
    this.#abort = abort
    this.#onProgress = onProgress ?? null
    try {
      return await run
    } finally {
      if (this.#abort === abort) this.#abort = null
      this.#inFlight = null
      this.#progress = null
      this.#onProgress = null
    }
  }

  /**
   * Stop the run in flight at its next dataset boundary, which sign-out uses so
   * a capture started under the removed credential cannot write its success
   * status afterwards.
   */
  abort() {
    this.#abort?.abort()
  }

  async #run({ datasets, backfill, trigger, signal }) {
    const startedAt = utcNowIso()
    const now = this.#clock()
    const status = this.#store.status()
    const deadline = retryDeadline(status, now)
    if (deadline !== null) {
      await this.#store.updateStatus({ lastRunAt: startedAt, lastRunStatus: 'skipped', lastErrorCode: status.lastErrorCode })
      return {
        ok: false,
        skipped: true,
        reason: 'retry_not_before',
        retryNotBefore: new Date(deadline).toISOString(),
      }
    }

    let credential
    try {
      credential = await this.#readCredential()
    } catch (error) {
      return this.#failRun(startedAt, errorCode(error), {}, null)
    }
    if (credential === undefined) {
      return this.#failRun(startedAt, 'credential_unavailable', {}, null)
    }

    const api = new BilibiliClient(credential)
    const outcomes = {}
    const failures = []
    let accountMid = null
    let platformError = null
    try {
      this.#report({ phase: 'account', message: 'verifying session' })
      accountMid = await api.validateSession()
      for (const dataset of datasets) {
        if (signal?.aborted === true) {
          failures.push('aborted')
          break
        }
        this.#report({ phase: 'dataset', dataset, message: `${dataset}: fetching` })
        await api.pause()
        try {
          const batch = await this.#fetchOnce(api, dataset, { backfill, userMid: accountMid })
          const result = await this.#store.commitBatch(dataset, batch, utcNowIso())
          outcomes[dataset] = { status: 'succeeded', ...result }
          this.#report({
            phase: 'dataset',
            dataset,
            added: result.added,
            updated: result.updated,
            unchanged: result.unchanged,
            message: `${dataset}: ${result.added} new, ${result.updated} updated, ${result.unchanged} unchanged`,
          })
        } catch (error) {
          const code = errorCode(error)
          failures.push(code)
          outcomes[dataset] = { status: 'failed', error: code }
          await this.#store.recordFailure(dataset, code)
          this.#report({ phase: 'dataset', dataset, error: code, message: `${dataset}: failed ${code}` })
          if (PLATFORM_FAILURES.some((type) => error instanceof type)) {
            platformError = error
            break
          }
        }
      }
    } catch (error) {
      platformError = error
      failures.push(errorCode(error))
    } finally {
      api.close()
    }

    const finishedAt = utcNowIso()
    if (failures.length > 0) {
      const patch = platformError === null ? {} : platformFailurePatch(this.#store.status(), platformError, this.#clock())
      const code = failures.join(',')
      await this.#store.updateStatus({
        lastRunAt: startedAt,
        lastRunStatus: Object.keys(outcomes).length === 0 ? 'failed' : 'partial',
        lastErrorCode: patch.lastErrorCode ?? code,
        ...patch,
      })
      return { ok: false, errorCodes: [...new Set(failures)], datasets: outcomes, finishedAt }
    }

    await this.#store.updateStatus({
      lastRunAt: startedAt,
      lastRunStatus: 'succeeded',
      lastErrorCode: null,
      authRequired: false,
      riskConsecutive: 0,
      retryNotBefore: null,
      account: this.#account(accountMid),
    })
    this.#report({ phase: 'done', message: 'sync complete' })
    this.#logger?.info?.(`bilibili: sync ${trigger} finished with ${Object.keys(outcomes).length} datasets`)
    return { ok: true, datasets: outcomes, finishedAt }
  }

  async #failRun(startedAt, code, datasets, platformError) {
    const patch = platformError === null ? {} : platformFailurePatch(this.#store.status(), platformError, this.#clock())
    await this.#store.updateStatus({
      lastRunAt: startedAt,
      lastRunStatus: 'failed',
      lastErrorCode: code,
      ...patch,
    })
    return { ok: false, errorCodes: [code], datasets }
  }

  /**
   * Read the signed-in account recorded for this run. The display name and
   * avatar come from the plugin page's live lookup, which only runs while a
   * page is open; this keeps the stored identity useful offline.
   * @param mid - The account id validated for this run.
   * @returns the account record.
   */
  #account(mid) {
    return { mid, name: null, avatarUrl: null, checkedAt: utcNowIso() }
  }

  async #fetchOnce(api, dataset, { backfill, userMid }) {
    const state = this.#store.cursor(dataset)?.state ?? {}
    switch (dataset) {
      case 'history':
        return fetchHistory(api, state, { backfill })
      case 'watch_later':
        return fetchWatchLater(api, state)
      case 'favorites':
        return fetchFavorites(api, state, { userMid })
      case 'following':
        return fetchFollowing(api, state, { userMid })
      case 'self_dynamic':
        return fetchSelfDynamic(api, state, { userMid })
      default: {
        const error = new Error(`bilibili: unknown dataset ${dataset}`)
        error.code = 'unknown_dataset'
        throw error
      }
    }
  }

  #report(event) {
    this.#progress = { ...event, at: utcNowIso() }
    this.#onProgress?.(this.#progress)
    this.#logger?.debug?.(`bilibili: ${event.message}`)
  }
}

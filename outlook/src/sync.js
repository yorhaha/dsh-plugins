/**
 * Capture orchestration: one mail run, with its cursor, the backoff window, and
 * the status row that everything else reads.
 *
 * One sync runs at a time. A second request while a capture is in flight is
 * refused rather than queued: the caller is a tool or a plugin page that can
 * ask again, and two captures racing over the same cursor would only spend the
 * mailbox's request budget twice.
 *
 * A failed capture records its code against the corpus so the next run knows
 * what it is retrying, and keeps the position the last successful one reached.
 *
 * @module dsh-outlook/src/sync
 */

import { GraphClient } from './graph.js'
import { fetchMail } from './mail.js'

/** Backoff applied after throttling that named no delay. */
const THROTTLE_BACKOFF_MS = 15 * 60 * 1000

/**
 * Stable code for any thrown value.
 * @param error - The thrown value.
 * @returns the code the caller reports.
 */
export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code !== '') return error.code
  return `internal_${error?.constructor?.name ?? 'Error'}`
}

/** The capture runner shared by the tools and the plugin page. */
export class OutlookSyncer {
  #store
  #auth
  #settings
  #logger
  #clock
  #createClient
  #running = null
  #progress = null

  /**
   * @param options - Construction options.
   * @param options.store - The corpus.
   * @param options.auth - Sign-in state, for the configured check.
   * @param options.settings - Reads the live capture settings.
   * @param options.createClient - Builds a Graph client for one run.
   * @param options.logger - Plugin logger.
   * @param options.clock - Current instant in milliseconds.
   */
  constructor({ store, auth, settings, createClient, logger, clock = Date.now }) {
    this.#store = store
    this.#auth = auth
    this.#settings = settings
    this.#logger = logger
    this.#clock = clock
    this.#createClient = createClient ?? (({ signal, timeoutMs }) => new GraphClient({ auth, logger, signal, timeoutMs }))
  }

  /** Whether a capture is in flight. */
  get busy() {
    return this.#running !== null
  }

  /** Last progress line a capture reported, if any. */
  get progress() {
    return this.#progress
  }

  /**
   * Capture the mailbox.
   * @param request - Run request.
   * @param request.backfill - Walk mail history further back instead of forward.
   * @param request.trigger - What asked for this run, recorded in the status row.
   * @param request.signal - Cancellation signal.
   * @param request.onProgress - Progress reporter.
   * @returns the run outcome.
   */
  async run({ backfill = false, trigger = 'manual', signal, onProgress } = {}) {
    if (this.#running !== null) {
      return { ok: false, skipped: true, reason: 'busy', errorCodes: [] }
    }
    const running = this.#execute({ backfill, trigger, signal, onProgress })
    this.#running = running
    try {
      return await running
    } finally {
      if (this.#running === running) this.#running = null
    }
  }

  /** Wait for an in-flight capture to finish. */
  async drained() {
    await this.#running?.catch(() => {})
  }

  /**
   * One capture, already reserved against the single-flight guard.
   * @param request - Run request.
   * @returns the run outcome.
   */
  async #execute({ backfill, trigger, signal, onProgress }) {
    const settings = this.#settings()
    if (!this.#auth.configured) {
      return { ok: false, skipped: true, reason: 'not_configured', errorCodes: [] }
    }
    const before = this.#store.status()
    if (trigger !== 'manual' && before.retryNotBefore !== null && Date.parse(before.retryNotBefore) > this.#clock()) {
      return { ok: false, skipped: true, reason: 'backoff', errorCodes: [] }
    }
    // Re-running a capture Microsoft already refused, on a schedule, only spends
    // the request budget; the plugin page can still ask for one by hand.
    if (trigger !== 'manual' && before.authRequired) {
      return { ok: false, skipped: true, reason: 'auth_required', errorCodes: [] }
    }
    const startedAt = this.#store.now()
    await this.#store.updateStatus({ lastRunAt: startedAt, lastRunStatus: null, lastErrorCode: null })
    const client = this.#createClient({ signal, timeoutMs: settings.requestTimeoutMs })
    const cursor = this.#store.mailState()
    const seenAt = this.#store.now()
    try {
      const fetched = await fetchMail({
        client,
        cursor,
        now: this.#clock(),
        settings,
        backfill,
        onProgress: (event) => {
          this.#progress = typeof event?.message === 'string' ? event.message : null
          onProgress?.(event)
        },
      })
      const counts = await this.#store.commitMail({
        records: fetched.records,
        removed: fetched.removed,
        dropFolders: fetched.excludedFolderIds ?? [],
        seenAt,
        bodyMaxBytes: settings.bodyMaxBytes,
        cursor: { ...fetched.cursor, lastSuccessAt: seenAt },
      })
      await this.#store.updateStatus({
        lastRunStatus: 'succeeded',
        lastErrorCode: null,
        // A capture that got through clears the flag a refusal had set.
        authRequired: false,
        retryNotBefore: null,
      })
      return {
        ok: true,
        skipped: false,
        reason: null,
        status: 'succeeded',
        pages: fetched.pages,
        ...counts,
        errorCodes: [],
      }
    } catch (error) {
      const code = errorCode(error)
      // The user or the plugin unloading stopped this run; nothing upstream
      // happened, so the corpus and its cursor stay exactly as they were.
      if (code === 'cancelled') {
        await this.#store.updateStatus({
          lastRunStatus: 'skipped',
          lastErrorCode: null,
          authRequired: before.authRequired,
          retryNotBefore: null,
        })
        return { ok: false, skipped: true, reason: 'cancelled', errorCodes: [] }
      }
      await this.#store.writeMailState({
        state: cursor?.state ?? {},
        lastSuccessAt: cursor?.lastSuccessAt ?? null,
        lastErrorCode: code,
        itemCount: cursor?.itemCount ?? 0,
        snapshotComplete: cursor?.snapshotComplete ?? null,
      })
      const retryNotBefore = code === 'rate_limited'
        ? new Date(this.#clock() + (error?.retryAfterMs ?? THROTTLE_BACKOFF_MS)).toISOString()
        : null
      await this.#store.updateStatus({
        lastRunStatus: 'failed',
        lastErrorCode: code,
        authRequired: code === 'auth_required' || before.authRequired,
        retryNotBefore,
      })
      this.#logger?.warn?.(`outlook: mail capture failed: ${code}`)
      return {
        ok: false,
        skipped: false,
        reason: code,
        status: 'failed',
        pages: 0,
        written: 0,
        unchanged: 0,
        removed: 0,
        errorCodes: [code],
      }
    }
  }
}

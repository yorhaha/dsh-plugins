/**
 * Fan-out of one message across every configured target.
 *
 * Each target is attempted once, in parallel, with its own timeout and its own
 * outcome: one account's failure never hides another account's delivery. Every
 * target is attempted, including one whose stored record is unreadable — that is
 * a delivery that failed, not a target to skip silently.
 *
 * @module dsh-notify/src/deliver
 */

import { NotifyError, send } from './pushplus.js'
import { listTargets } from './targets.js'

/** Why a stored record could not be used, in words the user can act on. */
const UNUSABLE_REASONS = Object.freeze({
  record_missing: 'the stored record is gone',
  not_a_target: 'the stored record is not a notification target',
  unknown_channel: 'the stored record belongs to another notification channel',
  no_token: 'the stored record carries no token',
})

/** Failure codes a caller may retry unchanged. */
const RETRYABLE = new Set(['request_failed', 'http_status', 'aborted'])

/**
 * Deliver one message to every configured target.
 *
 * @param options - Delivery inputs.
 * @param options.provider - The credentials service.
 * @param options.config - The resolved plugin configuration.
 * @param options.title - Message title.
 * @param options.content - Message body.
 * @param options.signal - Cancellation of the enclosing tool call, if any.
 * @param options.fetchImpl - Transport, replaceable by tests.
 * @param options.logger - Harness logger; receives target names and codes only.
 * @returns per-target outcomes, the delivered count, and the target count.
 */
export async function deliver({ provider, config, title, content, signal, fetchImpl, logger }) {
  const targets = await listTargets(provider)
  const results = await Promise.all(
    targets.map(async (target) => {
      if (target.status !== 'ready') {
        const reason = UNUSABLE_REASONS[target.reason] ?? target.reason
        logger?.warn?.(`notify: target "${target.name}" is unusable: ${target.reason}`)
        return { target: target.name, ok: false, code: 'unusable_target', message: `This target cannot be used: ${reason}`, retryable: false }
      }
      try {
        const messageId = await send({
          baseUrl: config.baseUrl,
          template: config.template,
          token: target.token,
          title,
          content,
          timeoutMs: config.requestTimeoutMs,
          signal,
          fetchImpl,
        })
        return { target: target.name, ok: true, messageId }
      } catch (error) {
        const code = error instanceof NotifyError ? error.code : 'internal'
        const message = error instanceof NotifyError ? error.message : `The send failed (${nameOf(error)})`
        logger?.warn?.(`notify: target "${target.name}" failed: ${code} ${message}`)
        return { target: target.name, ok: false, code, message, retryable: RETRYABLE.has(code) }
      }
    }),
  )
  return {
    total: results.length,
    delivered: results.filter((result) => result.ok).length,
    results,
  }
}

/**
 * Name one thrown value without quoting its message.
 * @param error - The thrown value.
 * @returns the constructor name.
 */
function nameOf(error) {
  return error instanceof Error ? error.constructor.name : 'Error'
}

/**
 * The programmable half of the notification plugin: one `send` and one `status`,
 * exposed as the `notify` service.
 *
 * The tool and any other bundle in the profile reach PushPlus through this same
 * function, so a message composed by the calendar is truncated, fanned out,
 * timed, and reported exactly like one composed by the model. Two delivery paths
 * would eventually disagree about a limit, and the one nobody watched would win.
 *
 * The service is stateless on purpose. Idempotency, quiet hours, rate limiting,
 * and coalescing belong to the caller: it is the only side that knows what a
 * repeated message means (a reminder of the same occurrence is a duplicate; a
 * human repeating themselves is not).
 *
 * A result never carries a token or a stored record: the caller is told how many
 * targets accepted the message, which failed, and why.
 *
 * @module dsh-notify/src/service
 */

import { deliver } from './deliver.js'
import { listTargets } from './targets.js'

/**
 * Cut a text to a character ceiling, marking the cut inside it.
 *
 * @param text - The text to bound.
 * @param max - Largest accepted length, which the result never exceeds.
 * @returns the text and whether it was cut.
 */
function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max - 1)}…`, truncated: true }
}

/**
 * Build the service one plugin instance provides.
 *
 * @param options - Host inputs.
 * @param options.provider - The credentials service.
 * @param options.config - The resolved plugin configuration.
 * @param options.logger - Harness logger.
 * @returns the service value registered as `notify`.
 */
export function createNotifyService({ provider, config, logger }) {
  return {
    /**
     * Deliver one message to every configured target.
     *
     * @param request - the message.
     * @param request.title - subject line; defaults to the configured one.
     * @param request.content - body; a blank one is refused.
     * @param request.signal - cancellation of the enclosing call, if any.
     * @returns the delivery outcome, with a closed `code` when nothing was delivered as asked.
     */
    async send({ title, content, signal } = {}) {
      const raw = typeof content === 'string' ? content : ''
      if (raw.trim() === '') {
        return { ok: false, code: 'invalid_content', message: 'a notification needs a non-empty content field', delivered: 0, total: 0 }
      }
      const body = truncate(raw, config.contentMaxChars)
      const subject = truncate(
        typeof title === 'string' && title.trim() !== '' ? title.trim() : config.defaultTitle,
        config.titleMaxChars,
      )
      const outcome = await deliver({
        provider,
        config,
        title: subject.text,
        content: body.text,
        signal,
        logger,
      })
      if (outcome.total === 0) {
        return { ok: false, code: 'not_configured', message: 'no notification target is configured', delivered: 0, total: 0 }
      }
      const failures = outcome.results
        .filter(result => !result.ok)
        .map(result => ({ target: result.target, code: result.code, message: result.message, retryable: result.retryable }))
      return {
        ok: failures.length === 0,
        ...(failures.length === 0 ? {} : { code: outcome.delivered > 0 ? 'partial' : 'failed' }),
        delivered: outcome.delivered,
        total: outcome.total,
        ...(failures.length === 0 ? {} : { failures }),
        title_truncated: subject.truncated,
        content_truncated: body.truncated,
      }
    },

    /**
     * Report the configured targets without revealing any token.
     *
     * @returns the counts a caller needs to explain why a send did nothing.
     */
    async status() {
      const targets = await listTargets(provider)
      return {
        total: targets.length,
        ready: targets.filter(target => target.status === 'ready').length,
      }
    },
  }
}

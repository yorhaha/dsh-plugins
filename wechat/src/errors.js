/**
 * Stable failures with a closed code vocabulary.
 *
 * A code is what a tool result, a bridge response, and the batch row carry, so
 * the model and the plugin page can react without parsing prose. Messages are
 * local and actionable: a batch's own validation message names the file and the
 * line, and nothing here ever carries a key value.
 *
 * @module dsh-wechat/src/errors
 */

/** Every code this plugin returns. */
export const CODES = Object.freeze([
  'batch_not_found',
  'batch_incomplete',
  'batch_exists',
  'batch_invalid',
  'batch_changed',
  'unsupported_batch_name',
  'source_missing',
  'copy_failed',
  'busy',
  'db_unavailable',
  'cancelled',
  'internal_error',
])

/** A failure carrying one code from {@link CODES}. */
export class WechatError extends Error {
  /**
   * @param code - One of {@link CODES}.
   * @param message - Actionable local text.
   */
  constructor(code, message) {
    super(message)
    this.name = 'WechatError'
    this.code = code
  }
}

/**
 * Throw a coded failure.
 * @param code - One of {@link CODES}.
 * @param message - Actionable local text.
 * @returns never; the return type only lets callers write `return fail(...)`.
 */
export function fail(code, message) {
  throw new WechatError(code, message)
}

/**
 * The stable code for any thrown value.
 * @param error - The thrown value.
 * @returns its code, or `internal_error` for anything uncoded.
 */
export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code !== '') return error.code
  return 'internal_error'
}

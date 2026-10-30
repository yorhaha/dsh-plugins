/**
 * The stored Zhihu cookie, held as one credential record.
 *
 * The credential seam stores a record's payload verbatim and never interprets
 * it, so the cookie string is this plugin's own format. The record is written
 * only by a connection that already proved the cookie against `/api/v4/me`, and
 * the plugin page never receives the string back.
 *
 * @module dsh-zhihu/src/credentials
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { normalizeCookie } from './cookie.js'

/** Credential-record scope; the seam requires a lowercase segment owned by this plugin. */
export const CREDENTIAL_SCOPE = 'zhihu'

/**
 * Credential record key for one account slot.
 * @param accountId - the slot configured for this plugin.
 * @returns the record key.
 */
export function keyFor(accountId) {
  return credentialKey(CREDENTIAL_SCOPE, accountId)
}

/**
 * Read the stored cookie.
 *
 * @param provider - the credentials service.
 * @param accountId - the slot configured for this plugin.
 * @returns the normalized cookie and its save instant, or undefined when none is stored.
 * @throws when the record exists but is not a cookie record this plugin wrote.
 */
export async function readCookie(provider, accountId) {
  const key = keyFor(accountId)
  const record = await provider.readRecord(key)
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw Object.assign(new Error(`the credential record "${key}" is not a Zhihu cookie record`), {
      code: 'credential_invalid',
    })
  }
  const { cookie, saved_at: savedAt } = record.payload
  if (typeof cookie !== 'string') {
    throw Object.assign(new Error(`the credential record "${key}" carries no cookie`), {
      code: 'credential_invalid',
    })
  }
  const normalized = normalizeCookie(cookie)
  return { cookie: normalized, saved_at: savedAtText(savedAt) }
}

/**
 * Render the stored save instant as text.
 *
 * A YAML store may hand an unquoted ISO timestamp back as a `Date` rather than
 * a string, so both are accepted; anything else is reported as unknown rather
 * than as a wrong time.
 *
 * @param value - the stored `saved_at` field.
 * @returns the instant, or null when it is absent or unusable.
 */
function savedAtText(value) {
  if (typeof value === 'string' && value !== '') return value
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  return null
}

/**
 * Replace the stored cookie.
 *
 * @param provider - the credentials service.
 * @param accountId - the slot configured for this plugin.
 * @param cookie - the cookie string that upstream already accepted.
 * @returns the stored record, with the save instant it was given.
 */
export async function writeCookie(provider, accountId, cookie) {
  const normalized = normalizeCookie(cookie)
  const saved = {
    cookie: normalized,
    saved_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  await provider.modifyRecord(keyFor(accountId), () => Promise.resolve({ kind: 'grant', payload: saved }))
  return saved
}

/**
 * Forget the stored cookie, leaving the record absent.
 *
 * @param provider - the credentials service.
 * @param accountId - the slot configured for this plugin.
 * @returns resolution once the record is removed.
 */
export async function clearCookie(provider, accountId) {
  await provider.deleteRecord(keyFor(accountId))
}

/**
 * The stored Bilibili session, held as one credential record.
 *
 * The seam stores a record's payload verbatim and never interprets it, so the
 * cookie bag is this plugin's own format. It is written only through
 * `modifyRecord`, which serializes read-modify-write under the provider's
 * cross-process lock, and only by the login flow — a sync never writes it.
 *
 * @module dsh-bilibili/src/credentials
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Credential-record scope; the seam requires a lowercase segment owned by this plugin. */
export const CREDENTIAL_SCOPE = 'bilibili'

/** The catalogued cookies a signed-in session needs, keyed as the client reads them. */
export const COOKIE_FIELDS = Object.freeze(['sessdata', 'dedeuserid', 'buvid3', 'buvid4'])

/**
 * Credential record key for one account.
 * @param accountId - Account slot configured for this plugin.
 * @returns the record key.
 */
export function keyFor(accountId) {
  return credentialKey(CREDENTIAL_SCOPE, accountId)
}

/**
 * Read the stored cookie bag.
 * @param provider - The credentials service.
 * @param accountId - Account slot configured for this plugin.
 * @returns the cookie bag, or undefined when the account was never authorized.
 * @throws when the stored record exists but is not a cookie bag this plugin wrote.
 */
export async function readCookies(provider, accountId) {
  const record = await provider.readRecord(keyFor(accountId))
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error(`bilibili: credential record "${keyFor(accountId)}" is not a cookie bag`)
  }
  return assertCookies(record.payload, keyFor(accountId))
}

/**
 * Replace the stored cookie bag.
 * @param provider - The credentials service.
 * @param accountId - Account slot configured for this plugin.
 * @param cookies - The bag a completed login produced.
 * @returns resolution after the record is durable.
 */
export async function writeCookies(provider, accountId, cookies) {
  const payload = assertCookies(cookies, keyFor(accountId))
  await provider.modifyRecord(keyFor(accountId), () =>
    Promise.resolve({ kind: 'grant', payload }),
  )
}

/**
 * Forget the stored cookie bag, leaving the record absent.
 * @param provider - The credentials service.
 * @param accountId - Account slot configured for this plugin.
 * @returns resolution after the record is removed.
 */
export async function clearCookies(provider, accountId) {
  await provider.deleteRecord(keyFor(accountId))
}

/**
 * Validate a cookie bag and keep only the fields a session needs.
 * @param value - Candidate payload.
 * @param source - Record key, named in the failure.
 * @returns the validated bag.
 * @throws when the session cookie is missing.
 */
function assertCookies(value, source) {
  const bag = {}
  for (const field of COOKIE_FIELDS) {
    const entry = value[field]
    if (typeof entry === 'string' && entry !== '') bag[field] = entry
  }
  if (bag.sessdata === undefined) {
    throw new Error(`bilibili: credential record "${source}" carries no session cookie`)
  }
  if (typeof value.saved_at === 'string') bag.saved_at = value.saved_at
  return bag
}

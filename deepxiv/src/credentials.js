/**
 * The DeepXiv token this plugin authenticates with, held as one credential
 * record.
 *
 * The record id is fixed: one DeepXiv account token is all this plugin
 * addresses, so the store reads it back as `deepxiv/default`. Its payload holds
 * the token rather than configuration: the credential seam stores a payload
 * verbatim and never interprets it, and `modifyRecord` — the only write path —
 * serializes read-modify-write under the provider's lock.
 *
 * The record is a `grant` because an `api-key` record admits only a key and an
 * environment map, and this payload carries the channel that tells a later
 * version which service a stored token belongs to.
 *
 * @module dsh-deepxiv/src/credentials
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Credential-record scope; the seam requires a segment this plugin owns. */
export const CREDENTIAL_SCOPE = 'deepxiv'

/** The one record id this plugin addresses. */
export const TOKEN_ID = 'default'

/** Channel every record this module writes describes. */
const CHANNEL = 'deepxiv'

/** Longest accepted token; a longer paste is not a DeepXiv token. */
const TOKEN_MAX_CHARS = 512

/**
 * Credential record key of the stored token.
 * @returns the record key.
 */
export function keyFor() {
  return credentialKey(CREDENTIAL_SCOPE, TOKEN_ID)
}

/**
 * Read the stored token.
 *
 * A record this plugin cannot read is reported by reason rather than treated as
 * absent: it is a token that will fail every request, and the settings page
 * needs to show it so the user can replace it.
 *
 * @param provider - The credentials service.
 * @returns the token and the instant it was stored, or the reason it is unusable.
 */
export async function readToken(provider) {
  const record = await provider.readRecord(keyFor())
  return readPayload(record)
}

/**
 * Store a token, keeping the instant the record was first written.
 * @param provider - The credentials service.
 * @param token - The DeepXiv token.
 * @returns resolution after the record is durable.
 * @throws TypeError when the token is empty or over the bound.
 */
export async function writeToken(provider, token) {
  const value = assertToken(token)
  await provider.modifyRecord(keyFor(), async (current) => {
    const previous = readPayload(current)
    const addedAt = previous.ok ? previous.addedAt : new Date().toISOString()
    return { kind: 'grant', payload: { channel: CHANNEL, token: value, addedAt } }
  })
}

/**
 * Forget the stored token, leaving the record absent.
 * @param provider - The credentials service.
 * @returns resolution after the record is removed.
 */
export async function clearToken(provider) {
  await provider.deleteRecord(keyFor())
}

/**
 * Validate a token.
 * @param value - Candidate token.
 * @returns the trimmed token.
 * @throws TypeError when the token is unusable.
 */
function assertToken(value) {
  const token = typeof value === 'string' ? value.trim() : ''
  if (token === '') {
    throw Object.assign(new TypeError('deepxiv: a token is required'), { code: 'invalid_token' })
  }
  if (token.length > TOKEN_MAX_CHARS) {
    throw Object.assign(new TypeError(`deepxiv: a token is at most ${TOKEN_MAX_CHARS} characters`), {
      code: 'invalid_token',
    })
  }
  return token
}

/**
 * Read a stored record as a token payload.
 * @param record - The stored record, if any.
 * @returns the token and add time, or the reason the record is unusable.
 */
function readPayload(record) {
  if (record === undefined) return { ok: false, reason: 'record_missing' }
  if (record.kind !== 'grant') return { ok: false, reason: 'not_a_token' }
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'not_a_token' }
  if (payload.channel !== CHANNEL) return { ok: false, reason: 'unknown_channel' }
  if (typeof payload.token !== 'string' || payload.token.trim() === '') return { ok: false, reason: 'no_token' }
  return {
    ok: true,
    token: payload.token.trim(),
    addedAt: typeof payload.addedAt === 'string' ? payload.addedAt : new Date().toISOString(),
  }
}

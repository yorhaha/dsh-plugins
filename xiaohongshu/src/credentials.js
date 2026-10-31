/**
 * The stored Xiaohongshu session, held as one credential record.
 *
 * The credential seam stores a record's payload verbatim and never interprets
 * it. This module defines the record's own shape: the Cookie header, when it
 * was saved, the account the connection proof returned, and the frozen device
 * profile used for every signature of that account.
 *
 * @module dsh-xiaohongshu/src/credentials
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { CookieError, MAX_COOKIE_CHARS, parseCookie } from './cookie.js'

/** Credential-record scope; the seam requires a lowercase segment owned by this plugin. */
export const CREDENTIAL_SCOPE = 'xiaohongshu'

/**
 * Credential record key for one account slot.
 * @param accountId - the slot configured for this plugin.
 * @returns the record key.
 */
export function keyFor(accountId) {
  return credentialKey(CREDENTIAL_SCOPE, accountId)
}

/**
 * Convert an unknown value from a YAML-backed record to ISO-8601 text.
 * @param value - candidate instant.
 * @returns the instant, or null when absent or unusable.
 */
export function instantText(value) {
  if (typeof value === 'string' && value !== '') return value
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  return null
}

/**
 * Validate the account block of a record.
 * @param value - candidate account block.
 * @returns the account block, with unknown fields dropped.
 */
function accountOf(value) {
  if (typeof value !== 'object' || value === null) {
    return { user_id: null, nickname: null, avatar_url: null, red_id: null }
  }
  const text = (field) => (typeof value[field] === 'string' && value[field] !== '' ? value[field] : null)
  return {
    user_id: text('user_id'),
    nickname: text('nickname'),
    avatar_url: text('avatar_url'),
    red_id: text('red_id'),
  }
}

/**
 * Read the stored session.
 *
 * @param provider - the credentials service.
 * @param accountId - the slot configured for this plugin.
 * @returns the normalized cookie, account, device profile and save instant, or undefined.
 * @throws {Error} `credential_invalid` when the record exists but is not one this plugin wrote.
 */
export async function readCredential(provider, accountId) {
  const key = keyFor(accountId)
  const record = await provider.readRecord(key)
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw Object.assign(new Error(`the credential record "${key}" is not a Xiaohongshu session record`), {
      code: 'credential_invalid',
    })
  }
  const { cookie, saved_at: savedAt, account, device } = record.payload
  if (typeof cookie !== 'string') {
    throw Object.assign(new Error(`the credential record "${key}" carries no cookie`), {
      code: 'credential_invalid',
    })
  }
  let parsed
  try {
    parsed = parseCookie(cookie)
  } catch (error) {
    if (error instanceof CookieError) {
      throw Object.assign(new Error(`the credential record "${key}" carries an unusable cookie`), {
        code: 'credential_invalid',
      })
    }
    throw error
  }
  return {
    cookie: parsed.header,
    values: parsed.values,
    saved_at: instantText(savedAt),
    account: accountOf(account),
    device: device && typeof device === 'object' ? device : null,
  }
}

/**
 * Replace the stored session.
 *
 * @param provider - the credentials service.
 * @param accountId - the slot configured for this plugin.
 * @param session - the normalized cookie, account proof, and device profile.
 * @returns the stored record shape.
 */
export async function writeCredential(provider, accountId, session) {
  const parsed = parseCookie(session.cookie)
  if (parsed.header.length > MAX_COOKIE_CHARS) {
    throw new CookieError('cookie_invalid', 'The cookie is too long to store.')
  }
  const payload = {
    cookie: parsed.header,
    saved_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    account: accountOf(session.account),
    device: session.device ?? null,
  }
  await provider.modifyRecord(keyFor(accountId), () => Promise.resolve({ kind: 'grant', payload }))
  return payload
}

/**
 * Forget the stored session, leaving the record absent.
 * @param provider - the credentials service.
 * @param accountId - the slot configured for this plugin.
 * @returns resolution once the record is removed.
 */
export async function clearCredential(provider, accountId) {
  await provider.deleteRecord(keyFor(accountId))
}

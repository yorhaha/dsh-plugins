/**
 * The notification targets this plugin holds, one credential record each.
 *
 * A target is a PushPlus account the user wants messages delivered to. Its name
 * is the record id, so the store addresses it as `notify/<name>`, and its token
 * lives in the record payload rather than in configuration: the credential seam
 * stores a payload verbatim and never interprets it, and `modifyRecord` — the
 * only write path — serializes read-modify-write under the provider's lock.
 *
 * The record is a `grant` because an `api-key` record admits only a key and an
 * environment map, and this payload carries the channel that tells a later
 * version which service a stored token belongs to.
 *
 * @module dsh-notify/src/targets
 */

import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'

/** Credential-record scope; the seam requires a segment this plugin owns. */
export const CREDENTIAL_SCOPE = 'notify'

/** Channel every record this module writes describes. */
const CHANNEL = 'pushplus'

/** Longest accepted target name. */
const TARGET_NAME_MAX_CHARS = 32

/** Target-name grammar: the credential-key id segment, bounded in length. */
const TARGET_NAME_PATTERN = new RegExp(`^[a-z][a-z0-9-]{0,${TARGET_NAME_MAX_CHARS - 1}}$`)

/**
 * Whether a raw string could name a target at all.
 * @param value - Candidate name.
 * @returns true when the name has the accepted form.
 */
export function isTargetName(value) {
  return typeof value === 'string' && TARGET_NAME_PATTERN.test(value)
}

/**
 * Credential record key for one target.
 * @param name - Target name.
 * @returns the record key.
 * @throws TypeError when the name is not a credential-key id segment.
 */
export function keyFor(name) {
  return credentialKey(CREDENTIAL_SCOPE, name)
}

/**
 * Read every target this plugin has stored, with its token when usable.
 *
 * A record whose payload this plugin cannot read is reported as unusable rather
 * than skipped: it is a delivery target that will fail, and the plugin page
 * needs to show it so the user can replace or delete it.
 *
 * @param provider - The credentials service.
 * @returns one entry per record, ordered by name.
 */
export async function listTargets(provider) {
  const entries = await provider.listRecords()
  const targets = []
  for (const entry of entries) {
    if (credentialKeyScope(entry.key) !== CREDENTIAL_SCOPE) continue
    const name = credentialKeyId(entry.key)
    const record = await provider.readRecord(entry.key)
    const payload = readPayload(record)
    targets.push(
      payload.ok
        ? { name, status: 'ready', token: payload.token, addedAt: payload.addedAt }
        : { name, status: 'unusable', reason: payload.reason },
    )
  }
  return targets.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * Store one target's token, keeping the instant it was first added.
 * @param provider - The credentials service.
 * @param name - Target name.
 * @param token - The PushPlus token.
 * @returns resolution after the record is durable.
 * @throws TypeError when the name or the token is unusable.
 */
export async function writeTarget(provider, name, token) {
  const key = keyFor(assertTargetName(name))
  const value = assertToken(token)
  await provider.modifyRecord(key, async (current) => {
    const previous = readPayload(current)
    const addedAt = previous.ok ? previous.addedAt : new Date().toISOString()
    return { kind: 'grant', payload: { channel: CHANNEL, token: value, addedAt } }
  })
}

/**
 * Forget one target, leaving the record absent.
 * @param provider - The credentials service.
 * @param name - Target name.
 * @returns resolution after the record is removed.
 */
export async function clearTarget(provider, name) {
  await provider.deleteRecord(keyFor(assertTargetName(name)))
}

/**
 * Validate a target name.
 * @param value - Candidate name.
 * @returns the name.
 * @throws TypeError when the name is unusable.
 */
function assertTargetName(value) {
  if (!isTargetName(value)) {
    throw Object.assign(new TypeError('notify: a target name is lowercase letters, digits, and hyphens'), {
      code: 'invalid_target_name',
    })
  }
  return value
}

/**
 * Validate a token.
 * @param value - Candidate token.
 * @returns the trimmed token.
 * @throws TypeError when the token is empty.
 */
function assertToken(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new TypeError('notify: a target needs a non-empty token'), { code: 'invalid_token' })
  }
  return value.trim()
}

/**
 * Read a stored record as a target payload.
 * @param record - The stored record, if any.
 * @returns the token and add time, or the reason the record is unusable.
 */
function readPayload(record) {
  if (record === undefined) return { ok: false, reason: 'record_missing' }
  if (record.kind !== 'grant') return { ok: false, reason: 'not_a_target' }
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'not_a_target' }
  if (payload.channel !== CHANNEL) return { ok: false, reason: 'unknown_channel' }
  if (typeof payload.token !== 'string' || payload.token.trim() === '') return { ok: false, reason: 'no_token' }
  return {
    ok: true,
    token: payload.token.trim(),
    addedAt: typeof payload.addedAt === 'string' ? payload.addedAt : new Date().toISOString(),
  }
}

/**
 * Deterministic hashing for record identity.
 *
 * Two payloads that are structurally equal must hash the same across runs and
 * across batches, so every digest is taken over canonical JSON: object keys
 * sorted at every depth, compact separators, UTF-8.
 *
 * These digests are internal to this corpus. They are not byte-compatible with
 * the yorha importer's, which hashed through Python's `json.dumps` escaping.
 *
 * @module dsh-wechat/src/hash
 */

import { createHash } from 'node:crypto'

/**
 * Serialize a value with object keys sorted at every depth.
 * @param value - The value to serialize.
 * @returns canonical JSON text.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * SHA-256 of a string or byte buffer.
 * @param input - Text or bytes.
 * @returns the 64-character lowercase hex digest.
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * SHA-256 of a value's canonical JSON.
 * @param value - The value to digest.
 * @returns the 64-character lowercase hex digest.
 */
export function digest(value) {
  return sha256Hex(canonicalJson(value))
}

/**
 * The media fields that carry identity.
 *
 * A local path is deliberately excluded: the same image re-exported into a
 * later batch lives at a different relative path and must not read as a content
 * change when that batch is imported.
 *
 * @param media - Media references as stored.
 * @returns one identity object per reference, in order.
 */
export function mediaIdentity(media) {
  return media.map((ref) => ({
    type: ref.type,
    sha256: ref.sha256 ?? null,
    size: ref.size ?? null,
    metadata: ref.metadata ?? null,
  }))
}

/**
 * Version fingerprint of one message: the text a reader sees plus the identity
 * of the media it refers to. Unchanged fingerprint means the import is a no-op.
 * @param content - Normalized content, with OCR and voice transcriptions appended.
 * @param media - Media references as stored.
 * @returns the 64-character lowercase hex digest.
 */
export function contentHash(content, media) {
  return digest({ content: content ?? '', media: mediaIdentity(media ?? []) })
}

/**
 * Identity of a message the exporter gave a local id, which is the exact key.
 * @param chatId - Conversation the message belongs to.
 * @param localId - The exporter's per-conversation message id.
 * @returns the source id prefixed `local:`.
 */
export function localSourceId(chatId, localId) {
  return `local:${digest({ chat_id: chatId, local_id: String(localId) })}`
}

/**
 * The fields a fingerprint identity is built from, without the duplicate index.
 * Stored on the record so a later import can recognize the same message.
 * @param record - The message fields that identify it.
 * @param record.chatId - Conversation the message belongs to.
 * @param record.timestamp - Upstream Unix timestamp in seconds.
 * @param record.senderId - Sender as the exporter recorded it.
 * @param record.msgType - Upstream message type.
 * @returns the 64-character lowercase hex digest.
 */
export function fallbackBase({ chatId, timestamp, senderId, msgType }) {
  return digest({ chat_id: chatId, timestamp, sender_id: senderId, msg_type: msgType })
}

/**
 * Identity of a message without a local id: the fallback base plus the content
 * fingerprint plus the index of this duplicate within the conversation's file.
 * @param base - A {@link fallbackBase} digest.
 * @param contentFingerprint - A {@link contentHash} digest.
 * @param duplicateIndex - Zero-based index among identical messages, in file order.
 * @returns the source id prefixed `fallback:`.
 */
export function fallbackSourceId(base, contentFingerprint, duplicateIndex) {
  return `fallback:${digest({ base, content_hash: contentFingerprint, duplicate_index: duplicateIndex })}`
}

/**
 * The batch identity recorded with an import: the sorted (path, digest, size)
 * triples of every source file, hashed once.
 *
 * yorha stored the whole per-file list, which for a full-history batch is over
 * seventeen thousand entries; the digest answers the same question — "is this
 * import id being reused for different content" — in one column.
 *
 * @param files - Source files with `relativePath`, `sha256`, and `size`.
 * @returns the 64-character lowercase hex digest.
 */
export function sourceFilesHash(files) {
  const lines = files
    .map((file) => `${file.relativePath}\u0000${file.sha256}\u0000${file.size}`)
    .sort()
  return sha256Hex(lines.join('\n'))
}

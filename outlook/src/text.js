/**
 * Text preparation for the corpus index and for display.
 *
 * SQLite's `unicode61` tokenizer treats a run of Chinese characters as ONE
 * token, so a query for a word inside a Chinese sentence matches nothing, and
 * the `trigram` tokenizer — which would match substrings — needs at least three
 * characters per query and inflates the index several times over.
 *
 * This module therefore splits CJK text into one token per character on the way
 * into the index, and turns a query into phrases of those single characters:
 * `会议` becomes the phrase `"会 议"`, which matches exactly where those two
 * characters are adjacent. Latin words keep their usual whole-word semantics.
 *
 * @module dsh-outlook/src/text
 */

import { createHash } from 'node:crypto'

/**
 * Code point ranges indexed per character rather than as a run: CJK ideographs
 * and their extensions, kana, Hangul syllables, and compatibility ideographs.
 */
const CJK_RANGES = Object.freeze([
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xac00, 0xd7af],
])

/** A character SQLite's tokenizer keeps as part of a word. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u

/**
 * Whether one code point is written without spaces between words.
 * @param codePoint - The code point to classify.
 * @returns true when the character must become its own index token.
 */
export function isCjk(codePoint) {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

/**
 * Prepare text for storage in the full-text index.
 *
 * Surrounds every CJK character with spaces and collapses whitespace runs, so
 * each such character becomes its own token while Latin words stay intact.
 *
 * @param value - Raw text, or null.
 * @returns the indexed form; an empty string for absent text.
 */
export function segmentForIndex(value) {
  if (typeof value !== 'string' || value === '') return ''
  let out = ''
  for (const character of value) {
    if (isCjk(character.codePointAt(0))) out += ` ${character} `
    else out += character
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Split a query into index tokens, dropping every character the index does not
 * carry. CJK characters become tokens of their own; everything a tokenizer
 * treats as a word character accumulates into one token.
 * @param query - Raw user query.
 * @returns the tokens, in order.
 */
function tokenizeQuery(query) {
  const tokens = []
  let word = ''
  const flush = () => {
    if (word !== '') {
      tokens.push({ text: word, cjk: false })
      word = ''
    }
  }
  for (const character of query) {
    if (isCjk(character.codePointAt(0))) {
      flush()
      tokens.push({ text: character, cjk: true })
      continue
    }
    if (WORD_CHARACTER.test(character)) word += character
    else flush()
  }
  flush()
  return tokens
}

/**
 * Build an FTS5 `MATCH` expression for a query.
 *
 * Consecutive CJK characters become one quoted phrase, so the search means "as
 * written" rather than "these characters somewhere"; each Latin word becomes a
 * quoted term. Terms are joined with `AND`. Nothing a caller passes can reach
 * FTS5 as syntax: quoting plus tokenization leaves only word characters.
 *
 * @param query - Raw user query.
 * @returns the expression, or null when the query carries no searchable token.
 */
export function toMatchExpression(query) {
  if (typeof query !== 'string') return null
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return null
  const groups = []
  let run = []
  const closeRun = () => {
    if (run.length > 0) {
      groups.push(run)
      run = []
    }
  }
  for (const token of tokens) {
    if (token.cjk) {
      run.push(token.text)
      continue
    }
    closeRun()
    groups.push([token.text])
  }
  closeRun()
  return groups.map((group) => `"${group.join(' ')}"`).join(' AND ')
}

/**
 * Truncate text to a UTF-8 byte ceiling without splitting a code point.
 * @param value - Raw text, or null.
 * @param maxBytes - Inclusive ceiling in UTF-8 bytes.
 * @returns the text, or its longest prefix that fits.
 */
export function truncateBytes(value, maxBytes) {
  if (typeof value !== 'string' || value === '') return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let bytes = 0
  let out = ''
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    out += character
    bytes += size
  }
  return out
}

/**
 * Window of text around the first occurrence of a query, for display.
 *
 * The index holds a segmented copy of the text, so a snippet is taken from the
 * stored original instead: the model reads the words as the sender wrote them.
 *
 * @param text - Stored original text, or null.
 * @param query - The query the search ran, or null.
 * @param characters - Approximate window width in characters.
 * @returns the snippet, or null when there is no text or no match to centre on.
 */
export function snippetAround(text, query, characters) {
  if (typeof text !== 'string' || text === '') return null
  const needle = firstNeedle(text, query)
  if (needle === null) return null
  const at = text.toLowerCase().indexOf(needle)
  if (at === -1) return null
  const start = Math.max(0, at - Math.floor(characters / 3))
  const end = Math.min(text.length, start + characters)
  const window = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${window}${end < text.length ? '…' : ''}`
}

/**
 * First query fragment that actually occurs in the text.
 * @param text - Stored original text.
 * @param query - The query the search ran, or null.
 * @returns the lowercased fragment to centre on, or null when none occurs.
 */
function firstNeedle(text, query) {
  if (typeof query !== 'string' || query.trim() === '') return null
  const haystack = text.toLowerCase()
  const whole = query.trim().toLowerCase()
  if (haystack.includes(whole)) return whole
  for (const piece of whole.split(/[^\p{L}\p{N}]+/u)) {
    if (piece !== '' && haystack.includes(piece)) return piece
  }
  return null
}

/**
 * Searchable text for a record's participants.
 * @param actors - Participants with names, addresses, and roles.
 * @returns one line per participant.
 */
export function actorText(actors) {
  return (actors ?? [])
    .map((actor) => [actor?.name, actor?.id, actor?.role].filter((part) => typeof part === 'string' && part !== '').join(' '))
    .join('\n')
}

/**
 * Stable hex digest used for corpus keys and content fingerprints.
 * @param value - Text to digest.
 * @returns the digest as lowercase hex.
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

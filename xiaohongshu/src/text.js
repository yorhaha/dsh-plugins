/**
 * Text preparation for the corpus index.
 *
 * SQLite's `unicode61` tokenizer treats a run of Chinese characters as one
 * token, so a query for a word inside a Chinese sentence matches nothing.
 * This module splits CJK text into one token per character on the way into the
 * index and turns a query into phrases of those characters, so `露营装备`
 * becomes the phrase `"露 营 装 备"` and matches exactly where those characters
 * are adjacent. Latin words keep their usual whole-word semantics.
 *
 * Adapted from `dsh-outlook/src/text.js` in this repository.
 *
 * @module dsh-xiaohongshu/src/text
 */

/** Code point ranges indexed per character rather than as a run. */
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
 * @param codePoint - the code point to classify.
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
 * @param value - raw text, or null.
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
 * Split a query into index tokens.
 * @param query - raw user query.
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
 * @param query - raw user query.
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
 * Cut text to a number of code points, keeping surrogate pairs whole.
 * @param text - the text.
 * @param maximum - the longest accepted code-point count.
 * @returns the text, or its prefix.
 */
export function truncate(text, maximum) {
  if (typeof text !== 'string' || text.length <= maximum) return text ?? ''
  let units = 0
  let count = 0
  for (const character of text) {
    if (count === maximum) break
    units += character.length
    count += 1
  }
  return text.slice(0, units)
}

/**
 * Count code points, so a Chinese reply costs what a reader sees.
 * @param text - the text.
 * @returns the code-point count.
 */
export function characterCount(text) {
  if (typeof text !== 'string') return 0
  let count = 0
  for (const _ of text) count += 1
  return count
}

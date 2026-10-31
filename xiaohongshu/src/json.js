/**
 * JSON parsing that keeps Xiaohongshu's large ids exact.
 *
 * Xiaohongshu sometimes sends a user or note id as a bare JSON number. A 19-digit number exceeds
 * `Number.MAX_SAFE_INTEGER`, so `JSON.parse` silently replaces its last digits —
 * a note would then point at a different note or user. This
 * module quotes every integer literal that a double cannot hold before handing
 * the text to `JSON.parse`, so such an id arrives as its exact digits and every
 * reader can treat ids as strings.
 *
 * @module dsh-xiaohongshu/src/json
 */

/** Integer literals longer than this may still be safe; the value check decides. */
const MAX_SAFE_DIGITS = 15

/**
 * Quote integer literals that a JavaScript number cannot represent exactly.
 *
 * String literals are copied verbatim, so digits inside them are untouched.
 * Floats and exponents are left alone: they are measurements here (counts,
 * ratios), not identifiers.
 *
 * @param text - a JSON document.
 * @returns the same document with unsafe integer literals turned into strings.
 */
export function quoteUnsafeIntegers(text) {
  let output = ''
  let index = 0
  // Sticky, so scanning a multi-megabyte page stays linear instead of taking a
  // fresh substring for every numeric field.
  const number = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2
          continue
        }
        if (text[index] === '"') {
          index += 1
          break
        }
        index += 1
      }
      output += text.slice(start, index)
      continue
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      number.lastIndex = index
      const match = number.exec(text)
      if (match !== null) {
        const literal = match[0]
        const digits = literal.startsWith('-') ? literal.slice(1) : literal
        const isInteger = !/[.eE]/.test(literal)
        if (isInteger && (digits.length > MAX_SAFE_DIGITS || !Number.isSafeInteger(Number(literal)))) {
          output += `"${literal}"`
        } else {
          output += literal
        }
        index += literal.length
        continue
      }
    }
    output += character
    index += 1
  }
  return output
}

/**
 * Parse one JSON document without losing large integer ids.
 *
 * @param text - the JSON text.
 * @returns the parsed value.
 * @throws {SyntaxError} when the document is not JSON.
 */
export function parseJsonPreservingIds(text) {
  return JSON.parse(quoteUnsafeIntegers(text))
}

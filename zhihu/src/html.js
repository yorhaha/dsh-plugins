/**
 * Reading the two shapes of Zhihu web page this plugin consumes.
 *
 * Every page Zhihu serves a signed-in browser carries its server-rendered data
 * in a `<script id="js-initialData" type="text/json">` block: one JSON document
 * whose `initialState.entities` hold the question, its answers, the article,
 * and the people involved. Reading that block is cheaper and more stable than
 * scraping the rendered markup.
 *
 * The content fields themselves are HTML fragments — paragraphs, lists,
 * blockquote, code, and images standing in for equations. {@link htmlToText}
 * turns one into the text a model reads, keeping the structure it can use
 * (line breaks, list markers, headings as plain lines) and dropping the rest.
 *
 * @module dsh-zhihu/src/html
 */

import { parseJsonPreservingIds } from './json.js'

/** Named entities that actually appear in Zhihu content. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
}

/**
 * Decode the entities Zhihu puts in content.
 *
 * Numeric references are decoded by code point; an unknown or malformed one is
 * left as it was rather than dropped, so the reader still sees what the page
 * said.
 *
 * @param text - the text carrying entities.
 * @returns the decoded text.
 */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.startsWith('#')) {
      const hexadecimal = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hexadecimal ? body.slice(2) : body.slice(1), hexadecimal ? 16 : 10)
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code)
      }
      return whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Read one attribute out of a tag's source text.
 *
 * @param tag - the tag, angle brackets included.
 * @param name - the attribute name.
 * @returns the decoded value, or an empty string when the attribute is absent.
 */
function attribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const match = pattern.exec(tag)
  if (match === null) return ''
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
}

/**
 * Turn one HTML fragment into the text a reader sees.
 *
 * @param html - the fragment; an empty string is accepted.
 * @returns the text, with blank lines collapsed and no surrounding whitespace.
 */
export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return ''
  let text = html

  // Scripts and styles carry no content a reader wants, and their braces would
  // survive tag stripping as noise.
  text = text.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')

  // Equations are images whose alt text is the TeX. Keep the formula and drop
  // the decoration around it.
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    if (/\b(eeimg|formula)\b/i.test(tag) || attribute(tag, 'data-formula') !== '') {
      const formula = attribute(tag, 'alt').trim()
      return formula === '' ? '[公式]' : `[公式] ${formula}`
    }
    return '[图片]'
  })

  // A link's label is what a reader follows; the URL itself is noise in prose.
  // An image-only link keeps its URL so it is still reachable.
  text = text.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (whole, inner) => {
    const label = inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    if (label !== '' && label !== '[图片]' && label !== '[公式]') return inner
    const href = attribute(whole, 'href')
    return href === '' ? label : `[链接](${href})`
  })

  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<li\b[^>]*>/gi, '\n- ')
  text = text.replace(/<(h[1-6])\b[^>]*>/gi, '\n\n')
  text = text.replace(/<\/(p|div|li|h[1-6]|blockquote|tr|ul|ol|table|section|figure|figcaption|pre)>/gi, '\n')
  text = text.replace(/<hr\s*\/?>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)

  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Read the server-rendered state out of one Zhihu page.
 *
 * Attribute order varies between page types, so the script tag is matched
 * loosely and the id is checked afterwards.
 *
 * @param html - the page source.
 * @returns the `initialState` object, or null when the page carries none.
 */
export function readInitialState(html) {
  if (typeof html !== 'string' || html === '') return null
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)
  for (const match of scripts) {
    if (!/\bid\s*=\s*["']js-initialData["']/.test(match[1])) continue
    try {
      const parsed = parseJsonPreservingIds(match[2])
      if (typeof parsed !== 'object' || parsed === null) return null
      const initialState = parsed.initialState
      return typeof initialState === 'object' && initialState !== null ? initialState : null
    } catch {
      return null
    }
  }
  return null
}

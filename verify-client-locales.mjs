/**
 * Every locale key a plugin's browser half can ask for must resolve.
 *
 * The locale service indexes a dictionary by exact key: `translate()` looks up
 * `dict[key]`, and on a miss it returns the key itself, so a nested group
 * (`errors: { rejected: … }`) or a typo reaches the page as the literal text
 * `errors.rejected`. This check reads each plugin's browser half, extracts the
 * dictionaries it declares (they are plain data literals), and compares them
 * against every `t(...)` call in that same file:
 *
 * - no dictionary value may be an object — a nested group is unreachable;
 * - `zh` and `en` must declare the identical flat key set;
 * - every literal key must exist in both;
 * - every template key (`` t(`errors.${code}`) ``) must have at least one flat
 *   key under its static prefix, which is what makes the expansion possible.
 *
 * Offline and static: it loads no component and needs no browser. Run it from
 * this repository's root (`node verify-client-locales.mjs`) or from a plugin
 * directory (`node ../verify-client-locales.mjs notify`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const requested = process.argv.slice(2).filter(argument => !argument.startsWith('-'))
const failures = []

/**
 * Read one directory's entries, treating only a genuinely absent directory as empty.
 *
 * @param dir - the absolute path.
 * @returns the entry names.
 */
function entriesOf(dir) {
  try {
    return readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * The browser half of one plugin directory, or null when it declares none.
 *
 * @param dir - the plugin directory.
 * @returns the absolute path of the client module.
 */
function clientModule(dir) {
  for (const candidate of ['client.js', join('web', 'client.js')]) {
    const path = join(dir, candidate)
    try {
      if (statSync(path).isFile()) return path
    } catch {
      // The next candidate is the only remaining possibility.
    }
  }
  return null
}

/**
 * Slice one balanced object literal that starts at `start`, skipping strings so
 * a value like `'{count} characters'` cannot be read as structure.
 *
 * @param source - the whole file.
 * @param start - the index of the opening brace.
 * @returns the literal's text, braces included.
 */
function objectLiteral(source, start) {
  let depth = 0
  let quote = null
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') quote = character
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error('unterminated object literal')
}

/**
 * The dictionaries a browser half declares, by locale.
 *
 * @param source - the client module's text.
 * @returns `{ zh, en }`, each a parsed dictionary or undefined.
 */
function dictionariesOf(source) {
  const found = {}
  const declaration = /const\s+(zh|en)([A-Za-z0-9_$]*)\s*=\s*\{/g
  for (const match of source.matchAll(declaration)) {
    const [, locale, suffix] = match
    const start = match.index + match[0].length - 1
    // `settingsZh`/`zhSettings` style names are not this shape: `zh` followed by
    // a lowercase letter is an identifier, not a locale-tagged dictionary.
    if (suffix !== '' && !/^[A-Z_$]/.test(suffix)) continue
    found[locale] = new Function(`return (${objectLiteral(source, start)})`)()
  }
  return found
}

/**
 * Flatten one dictionary into keys, recording every nested group.
 *
 * @param dictionary - the parsed dictionary.
 * @returns the flat keys and the paths of nested objects.
 */
function flatten(dictionary) {
  const keys = []
  const nested = []
  const walk = (value, prefix) => {
    for (const [name, entry] of Object.entries(value)) {
      const path = prefix === '' ? name : `${prefix}.${name}`
      if (typeof entry === 'string') keys.push(path)
      else if (entry !== null && typeof entry === 'object') {
        nested.push(path)
        walk(entry, path)
      }
    }
  }
  walk(dictionary, '')
  return { keys: keys.sort(), nested }
}

/**
 * Every key the module asks the locale service for.
 *
 * @param source - the client module's text.
 * @returns literal keys and template prefixes.
 */
function requestedKeys(source) {
  const literals = new Set()
  const prefixes = new Set()
  for (const match of source.matchAll(/\bt\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    const key = match[2].replace(/\\(['"`\\])/g, '$1')
    const hole = key.indexOf('${')
    if (hole === -1) literals.add(key)
    else prefixes.add(key.slice(0, hole))
  }
  return { literals: [...literals].sort(), prefixes: [...prefixes].sort() }
}

/** Every plugin directory that ships a browser half, in name order. */
function pluginDirectories() {
  return entriesOf(here)
    .filter(name => !name.startsWith('.'))
    .map(name => join(here, name))
    .filter(dir => {
      try {
        return statSync(join(dir, 'package.json')).isFile() && clientModule(dir) !== null
      } catch {
        return false
      }
    })
    .sort()
}

const directories = requested.length === 0
  ? pluginDirectories()
  : requested.map(name => join(here, name))

for (const dir of directories) {
  const name = dir.slice(here.length + 1)
  const path = clientModule(dir)
  if (path === null) {
    console.log(`SKIP  ${name} — no browser half`)
    continue
  }
  const source = readFileSync(path, 'utf8')
  const { zh, en } = dictionariesOf(source)
  const problems = []
  if (zh === undefined || en === undefined) {
    problems.push(`dictionaries not found (zh=${zh !== undefined} en=${en !== undefined})`)
  } else {
    const flatZh = flatten(zh)
    const flatEn = flatten(en)
    for (const [locale, flat] of [['zh', flatZh], ['en', flatEn]]) {
      for (const group of flat.nested) {
        problems.push(`${locale}: '${group}' is a nested object, which the key lookup can never reach`)
      }
    }
    const zhKeys = new Set(flatZh.keys)
    const enKeys = new Set(flatEn.keys)
    for (const key of flatZh.keys) if (!enKeys.has(key)) problems.push(`en is missing '${key}'`)
    for (const key of flatEn.keys) if (!zhKeys.has(key)) problems.push(`zh is missing '${key}'`)
    const { literals, prefixes } = requestedKeys(source)
    for (const key of literals) {
      if (!zhKeys.has(key) || !enKeys.has(key)) problems.push(`no copy for '${key}'`)
    }
    for (const prefix of prefixes) {
      const under = flatEn.keys.filter(key => key.startsWith(prefix))
      if (under.length === 0) problems.push(`no copy under the '${prefix}' prefix a template key expands into`)
    }
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${name} — ${flatEn.keys.length} keys, ${literals.length} literal and ${prefixes.length} template key(s)`)
  }
  for (const problem of problems) console.log(`        ${problem}`)
  if (problems.length > 0) failures.push(name)
}

console.log(failures.length === 0
  ? '\nevery browser half resolves every locale key it asks for'
  : `\n${failures.length} browser half(s) ask for a key that cannot resolve: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)

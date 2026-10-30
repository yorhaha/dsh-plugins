/**
 * Every time a plugin's browser half shows must be 24-hour, and its date wording
 * must follow the interface language rather than the machine's regional settings.
 *
 * The failure this guards against is quiet: `toLocaleString()` with no options,
 * or `hour: '2-digit'` without a `hourCycle`, takes its clock and its month name
 * from the reader's locale. On an `en-US` machine the same panel then prints
 * `10/28/2026, 7:56:00 PM` while a Chinese colleague sees `10月28日 19:56`, and
 * neither agrees with the other's reading of the same deadline.
 *
 * So this check holds two things:
 *
 * - no browser half may call `toLocaleDateString`, `toLocaleTimeString`, or a
 *   date-shaped `toLocaleString` — a locale decides the clock, and a locale that
 *   prefers 12 hours reintroduces AM/PM. Formatting a *number* (`toLocaleString`
 *   with only digit options) stays allowed;
 * - each plugin that renders an instant must expose the 24-hour formatter this
 *   repository settled on, and that formatter must print `YYYY-MM-DD HH:MM` with
 *   no AM/PM and no English month name for every language.
 *
 * Offline and static where it can be, with one small dynamic step: the
 * formatters are pure, so they are lifted out of the script and run against a
 * fake `document` — the check asserts on what the shipped code actually prints.
 * Run it from this repository's root (`node verify-client-datetime.mjs`) or from
 * a plugin directory (`node ../verify-client-datetime.mjs notify`).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const requested = process.argv.slice(2).filter(argument => !argument.startsWith('-'))
const failures = []

/**
 * The browser half of every plugin this check applies to, each with the
 * formatters it must provide.
 *
 * `when` is the shared name for "one instant, rendered"; `stock` names its pair
 * after what they show, and is checked through both.
 */
const TARGETS = [
  { dir: 'bilibili', file: 'web/client.js', formatters: ['when'] },
  { dir: 'deepxiv', file: 'web/client.js', formatters: ['when'] },
  { dir: 'notify', file: 'web/client.js', formatters: ['when'] },
  { dir: 'zhihu', file: 'web/client.js', formatters: ['when'] },
  { dir: 'outlook', file: 'web/client.js', formatters: ['when'] },
  { dir: 'stock', file: 'client.js', formatters: ['formatTime', 'formatOpening'] },
  { dir: 'user-todo', file: 'client.js', formatters: ['timeText', 'dateTimeShort'] },
  { dir: 'wechat', file: 'web/client.js', formatters: ['stamp'] },
]

/**
 * Browser halves that show no date or time at all. They are listed, not skipped
 * by omission, so adding a timestamp to one of them fails here until it is
 * given a formatter and moved into {@link TARGETS}.
 */
const NO_TIMES = ['file-memory']

/** The languages a page can announce on `<html lang>`, plus the unset case. */
const LANGUAGES = ['zh-CN', 'en', '']

/** Anything a 12-hour clock or an English month name would print. */
const FORBIDDEN = /\b(AM|PM|a\.m\.|p\.m\.)\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/

const fail = (message) => {
  failures.push(message)
  console.log(`FAIL  ${message}`)
}

/** Read one label's verdict line, printing it either way. */
const check = (label, ok, detail = '') => {
  if (ok) console.log(`ok    ${label}${detail === '' ? '' : ` — ${detail}`}`)
  else fail(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Whether a `toLocaleString` argument list formats a clock or a calendar day.
 *
 * A numeric formatter passes only digit options; a date does not. No argument at
 * all is the worst case, because the whole shape comes from the locale.
 */
const isDateShaped = (argumentText) => /hour|minute|second|day|month|year|weekday|dateStyle|timeStyle/.test(argumentText)

/** Pull one function's source text, from its `function` keyword to its closing brace. */
const functionSource = (source, name) => {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return undefined
  const end = source.indexOf('\n    }\n', start)
  if (end < 0) return undefined
  return source.slice(start, end + '\n    }'.length)
}

/** A fake document whose `<html lang>` is the page's active language. */
const pageDocument = (lang) => ({ documentElement: { lang } })

/** Compile one script's helpers and formatters into a callable set. */
const compile = (source, formatters) => {
  // Every small helper the formatters close over has to travel with them: the
  // two halves of this repository name the zero-padder differently.
  const helperNames = ['pad2', 'pad', 'uiLanguage', 'weekdayName', 'weekdayText', 'dateShort']
  const helpers = helperNames
    .map(name => functionSource(source, name))
    .filter(text => text !== undefined)
  const bodies = formatters.map(name => functionSource(source, name))
  const missing = formatters.filter((_name, index) => bodies[index] === undefined)
  if (missing.length > 0) throw new Error(`missing formatter(s): ${missing.join(', ')}`)
  const parts = [...new Set([...helpers, ...bodies])]
  const factory = new Function('document', `${parts.join('\n')}\nreturn { ${formatters.join(', ')} }`)
  return (lang) => factory(pageDocument(lang))
}

/** One instant far enough from midnight that a 12-hour clock would differ. */
const EVENING = '2026-10-28T11:56:00Z'
const MIDNIGHT = '2026-12-31T16:00:00Z'

for (const target of TARGETS) {
  if (requested.length > 0 && !requested.includes(target.dir)) continue
  const path = join(here, target.dir, target.file)
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${target.dir}: ${target.file} is missing`)
    continue
  }
  const source = readFileSync(path, 'utf8')

  // ── the static half: no locale may pick the clock or the month name ──
  for (const name of ['toLocaleDateString', 'toLocaleTimeString']) {
    check(`${target.dir}: no ${name}()`, !source.includes(name))
  }
  let dateShaped = 0
  for (const match of source.matchAll(/\.toLocaleString\(([^)]*)\)/g)) {
    if (isDateShaped(match[1])) dateShaped += 1
  }
  check(`${target.dir}: no date-shaped toLocaleString()`, dateShaped === 0, `${dateShaped} found`)
  // `Intl.DateTimeFormat` picks its clock and month names the same locale-first
  // way the `toLocale*` family does, so it is just as likely to print AM/PM on
  // an `en-US` machine. A target renders through the formatter checked below,
  // never through a hand-rolled formatter.
  check(`${target.dir}: no Intl.DateTimeFormat`, !source.includes('DateTimeFormat'))

  // ── the dynamic half: what the shipped formatter actually prints ──
  let build
  try {
    build = compile(source, target.formatters)
  } catch (error) {
    fail(`${target.dir}: could not compile its formatters — ${error.message}`)
    continue
  }
  for (const lang of LANGUAGES) {
    const namespace = lang === '' ? '(unset)' : lang
    let rendered
    try {
      rendered = build(lang)
    } catch (error) {
      fail(`${target.dir} ${namespace}: formatter threw — ${error.message}`)
      continue
    }
    const samples = []
    for (const iso of [EVENING, MIDNIGHT]) {
      if (typeof rendered.when === 'function') samples.push(['when', rendered.when(iso)])
      if (typeof rendered.formatTime === 'function') samples.push(['formatTime', rendered.formatTime(iso)])
      if (typeof rendered.timeText === 'function') samples.push(['timeText', rendered.timeText(new Date(iso))])
      if (typeof rendered.dateTimeShort === 'function') samples.push(['dateTimeShort', rendered.dateTimeShort(new Date(iso))])
    }
    for (const [name, text] of samples) {
      const clean = typeof text === 'string' && !FORBIDDEN.test(text) && /\d{2}:\d{2}/.test(text)
      check(`${target.dir} ${namespace}: ${name}() is 24-hour and language-free`, clean, String(text))
    }
    // Names the weekday? It must speak the page's language, not the locale's.
    if (typeof rendered.formatOpening === 'function') {
      const later = new Date()
      later.setDate(later.getDate() + 3)
      later.setHours(9, 30, 0, 0)
      const text = rendered.formatOpening(later.toISOString())
      const names = lang.startsWith('zh')
        ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
        : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      const want = `${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')} ${names[(later.getDay() + 6) % 7]} 09:30`
      check(`${target.dir} ${namespace}: formatOpening() names the weekday in ${lang.startsWith('zh') ? '中文' : 'English'}`, text === want, text)
      const today = new Date()
      today.setHours(23, 30, 0, 0)
      const sameDay = rendered.formatOpening(today.toISOString())
      check(`${target.dir} ${namespace}: formatOpening() keeps a same-day opening to its clock`, /^\d{2}:\d{2}$/.test(sameDay), sameDay)
    }
    if (typeof rendered.stamp === 'function') {
      const text = rendered.stamp(EVENING)
      check(`${target.dir} ${namespace}: stamp() is 24-hour`, typeof text === 'string' && !FORBIDDEN.test(text) && /\d{2}:\d{2}/.test(text), String(text))
    }
  }
}

// Every plugin directory is a target once someone adds a browser half; say so
// rather than pass quietly over one nobody listed.
const covered = new Set([...TARGETS.map(target => target.dir), ...NO_TIMES])

for (const dir of NO_TIMES) {
  if (requested.length > 0 && !requested.includes(dir)) continue
  const candidates = [join(here, dir, 'client.js'), join(here, dir, 'web/client.js')].filter(path => existsSync(path))
  const source = candidates.map(path => readFileSync(path, 'utf8')).join('\n')
  // Any of these in a half declared time-free means the declaration is stale.
  const shows = /\.toLocale(String|DateString|TimeString)\(|Intl\.DateTimeFormat|new Date\(|Date\.parse\(|updated_at|created_at|savedAt|addedAt|lastRunAt/.test(source)
  check(`${dir}: declared free of dates and times`, !shows, shows ? 'it now reads or renders an instant' : '')
}
for (const entry of readdirSync(here)) {
  if (entry.startsWith('.') || entry === 'node_modules') continue
  const clientPath = join(here, entry, 'client.js')
  const webPath = join(here, entry, 'web/client.js')
  if (!existsSync(clientPath) && !existsSync(webPath)) continue
  if (!covered.has(entry)) fail(`${entry}: has a browser half but is not checked for its date and time wording`)
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`)
  process.exitCode = 1
} else {
  console.log(`\nPASS  ${requested.length > 0 ? requested.join(', ') : 'every plugin'} — 24-hour clocks, no AM/PM, no English month names`)
}

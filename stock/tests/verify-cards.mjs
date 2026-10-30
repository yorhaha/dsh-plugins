/**
 * Local verification for the dsh-stock Client half: load the browser module
 * exactly as the module loader would, then render the quote card with real
 * React in both locales and drive its raw-data disclosure with real events in
 * jsdom.
 *
 * Every payload is a recorded tool result, so the checks run without the quote
 * endpoints: they cover the card's rows, both locales, the malformed-payload
 * fallbacks, and the absence of any chart. `--record` replaces the fixtures
 * from the live endpoints.
 *
 * Needs the browser dependencies in this package's devDependencies: run
 * `node tests/verify-cards.mjs` from the plugin directory after `pnpm install`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  React,
  act,
  createRoot,
  mountClientHalf,
  renderToStaticMarkup,
  translateFor,
  window,
} from './client-harness.mjs'
import { fakeStorageDomain, mountHost } from './host-harness.mjs'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const { registration, exported, dictionaries, registered, requestedSlots, missing: contextMissing } = mountClientHalf()

check('registers one module factory under the package id', registration?.id === 'dsh-stock', String(registration?.id))
check('exposes the cordis plugin form only', JSON.stringify(Object.keys(exported).sort()) === '["apply","inject"]')
check('declares its required services', JSON.stringify(exported.inject) === '["slots","locale"]')
check('claims the quote key of tool.call.toolview, and no other view',
  registered.has('tool.call.toolview:stock_quote')
  && [...registered.keys()].filter(key => key.startsWith('tool.call.toolview:')).length === 2,
  [...registered.keys()].join(','))
check('registers the card stylesheet', window.document.head.querySelector('style') !== null)

const stylesheet = window.document.head.querySelector('style')?.textContent ?? ''
check('the stylesheet carries no chart rules',
  !/dsh-stock-(svg|chart|tip|legend|setting)/.test(stylesheet))
check('the stylesheet reflows the panel at a narrow width',
  /container-type:\s*inline-size/.test(stylesheet)
  && /@media \(max-width: 640px\)/.test(stylesheet)
  && /@container stock-panel \(max-width: 640px\)/.test(stylesheet)
  && /@media \(max-width: 420px\)/.test(stylesheet),
  '')
check('the narrow panel orders the row menu onto its own track',
  /\.dsh-stock-row-menu\s*\{[^}]*order:\s*2/.test(stylesheet))

const zhKeys = Object.keys(dictionaries.stock.zh).sort()
const enKeys = Object.keys(dictionaries.stock.en).sort()
check('both dictionaries carry the identical key set',
  zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
  `zh=${zhKeys.length} en=${enKeys.length}`)

const missingKeys = new Set()
const t = locale => translateFor(dictionaries, 'stock', locale, missingKeys)

const useDisclosure = () => {
  const [expanded, setExpanded] = React.useState(false)
  return { expanded, setExpanded, toggle: () => setExpanded(value => !value) }
}

// ── real tool payloads ──────────────────────────────────────────────────────

const host = await mountHost({ facility: fakeStorageDomain(), config: { minIntervalMs: 1, retryDelayMs: 1 } })
const call = (name, args) => host.tools.get(name).execute(args, {})

// ── recorded payloads ───────────────────────────────────────────────────────

const FIXTURE_DIR = new URL('./fixtures/', import.meta.url)
/** Every payload the checks replay, and the call that produces it. */
const RECORDABLE = {
  'quote-one': ['stock_quote', { codes: ['sh600519'] }],
  'quote-many': ['stock_quote', { codes: ['sh600519', 'hk00700', 'usAAPL', 'sh999999'] }],
}
const record = process.argv.includes('--record')
const recorded = []

/**
 * Replay one recorded tool result, recording it from the live endpoint first
 * when asked to or when the fixture is missing.
 *
 * @param name - the fixture name.
 * @returns the recorded payload.
 */
async function fixture(name) {
  const file = new URL(`${name}.json`, FIXTURE_DIR)
  if (!record) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const [tool, args] = RECORDABLE[name]
  const value = await call(tool, args)
  if (value.ok !== true) {
    throw new Error(`recording ${name} failed: ${value.error?.message ?? 'the tool reported no value'} (retry when the endpoint is back)`)
  }
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(file, `${JSON.stringify(value)}\n`)
  recorded.push(name)
  return value
}

const quote = await fixture('quote-one')
const quotes = await fixture('quote-many')
if (recorded.length > 0) console.log(`recorded fixtures: ${recorded.join(', ')}`)

// The fixtures are replayed, not fetched: state the payload facts the card
// depends on here, so a stale recording is visible instead of silently passing.
check('the quote fixtures carry the fields the card shows',
  quote.items.length === 1 && typeof quote.items[0].name === 'string'
  && Array.isArray(quote.items[0].bids) && Array.isArray(quote.items[0].asks)
  && quotes.items.length === 3 && quotes.missing.length === 1 && quotes.missing[0].code === 'sh999999',
  `${quote.items.length} and ${quotes.items.length} items`)

const blockOf = (value, extra = {}) => ({
  kind: 'tool-result',
  seq: 1,
  time: 0,
  callId: 'call-1',
  name: 'stock_quote',
  args: {},
  call: null,
  callTime: null,
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError: false,
  subCalls: [],
  ...extra,
})

const props = (block, locale) => ({
  toolName: 'stock_quote',
  phase: 'result',
  block,
  callId: 'call-1',
  t: t(locale),
  useDisclosure,
})

/** No chart survives in the module: no chart class, and no shape a series could draw. */
const hasChart = html => html.includes('dsh-stock-svg') || html.includes('<rect') || html.includes('<polyline') || html.includes('<polygon')

// ── the card ────────────────────────────────────────────────────────────────

for (const locale of ['zh', 'en']) {
  const one = renderToStaticMarkup(React.createElement(registered.get('tool.call.toolview:stock_quote'), props(blockOf(quote), locale)))
  check(`${locale} quote card shows the metrics and the order book`,
    one.includes('dsh-stock-quote-name') && one.includes('dsh-stock-book') && !hasChart(one)
    && !one.includes('undefined') && !one.includes('NaN'),
    `${one.length} chars`)

  const many = renderToStaticMarkup(React.createElement(registered.get('tool.call.toolview:stock_quote'), props(blockOf(quotes), locale)))
  check(`${locale} quote card names the codes upstream omitted and draws no book for a batch`,
    many.includes('sh999999') && !many.includes('dsh-stock-book') && !hasChart(many)
    && !many.includes('undefined') && !many.includes('NaN'),
    `${many.length} chars`)
}

// ── fallbacks: a card never claims data it cannot show ──────────────────────

const fallbacks = [
  ['a failed call', blockOf('{"ok":false}', { isError: true }), '调用失败'],
  ['unparseable text', blockOf('not json'), '上游没有返回'],
  ['an error payload', blockOf({ ok: false, error: { code: 'not_found' } }), '上游没有返回'],
  ['a quote without items', blockOf({ ok: true, items: [] }), '没有可显示的行情'],
  ['a quote whose only item cannot be read', blockOf({ ok: true, items: [null] }), '没有可显示的行情'],
]
for (const [label, block, expected] of fallbacks) {
  const html = renderToStaticMarkup(React.createElement(registered.get('tool.call.toolview:stock_quote'), props(block, 'zh')))
  check(`falls back on ${label}`, html.includes(expected) && !hasChart(html))
}
{
  const running = { phase: 'start', name: 'stock_quote', callId: 'c', turn: 1, step: 1, time: 0, argsRaw: '{}', subCalls: [], args: {} }
  const html = renderToStaticMarkup(React.createElement(registered.get('tool.call.toolview:stock_quote'), { ...props(running, 'zh'), phase: 'start' }))
  check('renders a running call without data', html.includes('读取中') && !html.includes('dsh-stock-quote-name'))
}

// ── the raw-data disclosure, driven by real events ──────────────────────────

{
  const host = window.document.createElement('div')
  window.document.body.append(host)
  const root = createRoot(host)
  act(() => { root.render(React.createElement(registered.get('tool.call.toolview:stock_quote'), props(blockOf(quote), 'zh'))) })
  const buttonWith = label => [...host.querySelectorAll('button')].find(button => button.textContent === label)
  check('the raw text stays behind the disclosure',
    host.querySelector('pre.dsh-stock-raw') === null && buttonWith('原始数据') !== undefined)

  act(() => { buttonWith('原始数据').click() })
  check('the disclosure shows the raw result text',
    host.querySelector('pre.dsh-stock-raw')?.textContent === JSON.stringify(quote))

  act(() => { buttonWith('收起').click() })
  check('the disclosure collapses again', host.querySelector('pre.dsh-stock-raw') === null)
}

check('every locale key the card uses resolves', missingKeys.size === 0, [...missingKeys].join(', '))

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECKS FAILED`)
process.exitCode = failures.length === 0 ? 0 : 1

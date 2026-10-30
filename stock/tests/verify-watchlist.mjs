/**
 * Deterministic behaviour checks for the dsh-stock watchlist: the one durable
 * list the `stock_watchlist` tool and the sidebar panel share.
 *
 * Mounts the real plugin through a stub context whose storage domain and HTTP
 * transport are scripted, then exercises what the live quote endpoints cannot
 * produce on demand: canonicalization and deduplication, the configured
 * maximum, the atomic reject of an unusable code, the concurrent adds the
 * store's mutation chain serializes, the same list reopening after a restart,
 * and the panel route's row compaction, defect responses, and body limit.
 *
 * Offline: the scripted transport answers the batched-quote and search paths
 * with ASCII bodies in the upstream field layout, so nothing reaches the
 * network. Run `node tests/verify-watchlist.mjs` from the plugin directory after
 * `pnpm install`.
 */
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { BRIDGE_PATH } from '../src/bridge.js'
import { stockDomainSpec } from '../src/watchlist.js'
import { fakeStorageDomain, mountHost, postRoute } from './host-harness.mjs'

let checks = 0
const failures = []
const check = (label, ok, detail = '') => {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const show = (value) => JSON.stringify(value ?? null)
const codesOf = (value) => value.entries.map(entry => entry.code).join(',')

/** Run one action that must reject, and report its message. */
async function rejects(work) {
  try {
    await work()
  } catch (error) {
    return error.message
  }
  return null
}

/**
 * Run one tool call and validate its value against the tool's declared output
 * schema, so a value no consumer could accept ends the script instead of
 * quietly counting as a pass.
 *
 * @param tool - the registered tool definition.
 * @param args - the raw tool arguments.
 * @param label - the call this value belongs to, named in a violation.
 * @returns the validated value.
 */
async function call(tool, args, label) {
  const value = await tool.execute(args, {})
  const violations = validateJsonSchemaValue(tool.output.schema, value)
  if (violations.length > 0) throw new Error(`${label}: ${violations.join('; ')}`)
  return value
}

/** Run one action at a fixed instant, restoring the clock afterwards. */
async function atInstant(epochMs, work) {
  const real = Date.now
  Date.now = () => epochMs
  try {
    return await work()
  } finally {
    Date.now = real
  }
}

// ── the scripted quote and search endpoints ─────────────────────────────────

/** Names the scripted upstream reports, so a learned label is checkable. */
const NAMES = {
  sh600519: 'Kweichow Moutai',
  sz000001: 'Ping An Bank',
  hk00700: 'Tencent Holdings',
}

/** Field counts the quote parser enforces per market. */
const CN_QUOTE_FIELDS = 83
const HK_QUOTE_FIELDS = 76

/**
 * One quote line's `~`-separated fields, at the layout `quoteItem` reads:
 * price and volume, the order book, the timestamp, the valuation fields a
 * mainland quote adds, and the market's currency. Fields no reading touches
 * stay `0`, which is a valid number for every one of them.
 *
 * @param code - the canonical code, which decides the field layout.
 * @returns the fields, or null for a market this script does not build.
 */
function quoteFields(code) {
  const market = code.slice(0, 2)
  const mainland = market === 'sh' || market === 'sz' || market === 'bj'
  const hongkong = market === 'hk'
  if (!mainland && !hongkong) return null
  const fields = new Array(mainland ? CN_QUOTE_FIELDS : HK_QUOTE_FIELDS).fill('0')
  const digits = code.slice(2)
  fields[1] = NAMES[code] ?? `Security ${digits}`
  fields[2] = digits
  fields[3] = '100.00'
  fields[4] = '99.00'
  fields[5] = '99.50'
  fields[6] = '1000'
  fields[30] = mainland ? '20261014150000' : '2026/10/14 15:00:00'
  fields[31] = '1.00'
  fields[32] = '1.01'
  fields[33] = '101.00'
  fields[34] = '98.00'
  fields[43] = '3.00'
  fields[44] = '1000000000'
  fields[45] = '1200000000'
  if (mainland) {
    fields[9] = '99.99'
    fields[10] = '5'
    fields[19] = '100.01'
    fields[20] = '7'
    fields[38] = '0.35'
    fields[39] = '25.50'
    fields[46] = '8.50'
    fields[47] = '110.00'
    fields[48] = '90.00'
    fields[57] = '12345'
    fields[61] = /^(sh000|sz399)/.test(code) ? 'ZS' : 'GP-A'
    fields[82] = 'CNY'
  } else {
    fields[46] = 'Tencent Holdings Ltd'
    fields[48] = '120.00'
    fields[49] = '80.00'
    fields[63] = 'GP'
    fields[75] = 'HKD'
  }
  return fields
}

/**
 * The batched-quote body: one `v_<code>="…";` line per code this script can
 * build, and no line for a code it cannot, which upstream renders as a code it
 * silently omitted.
 *
 * @param codes - the requested canonical codes.
 * @returns the response body.
 */
function quoteBody(codes) {
  const lines = []
  for (const code of codes) {
    const fields = quoteFields(code)
    if (fields !== null) lines.push(`v_${code}="${fields.join('~')}";`)
  }
  return lines.join('\n')
}

/** The scripted search matches, keyed by the lowercased keyword. */
const SEARCH_HINTS = new Map([
  ['moutai', 'sh~600519~Kweichow Moutai~moutai~GP-A'],
  ['tencent', 'hk~00700~Tencent Holdings~tencent~GP'],
])

/**
 * The intraday prices the scripted minute endpoint holds, per code. A code
 * absent from this table answers upstream's no-series marker.
 */
const MINUTE_PRICES = new Map([
  ['sh600519', [100, 101, 102, 103, 104, 105]],
  ['sz000001', [10, 9.5, 9.8]],
])

/** The intraday session the scripted minute endpoint reports. */
const MINUTE_DATE = '20261015'

/**
 * The intraday body in the layout `minute()` reads: the multi-day endpoint's
 * days, newest first, each carrying one row per price with a time, a price, and
 * a cumulative volume.
 *
 * @param code - the requested canonical code.
 * @returns the response body.
 */
function minuteBody(code) {
  const prices = MINUTE_PRICES.get(code)
  if (prices === undefined) return JSON.stringify({ code: 0, msg: '', data: { [code]: { data: [] } } })
  const rows = prices.map((price, index) => {
    const minute = 30 + index
    const time = `${String(9 + Math.floor(minute / 60)).padStart(2, '0')}${String(minute % 60).padStart(2, '0')}`
    return `${time} ${price.toFixed(2)} ${(index + 1) * 100} ${((index + 1) * 100 * price).toFixed(0)}`
  })
  return JSON.stringify({
    code: 0,
    msg: '',
    data: { [code]: { data: [{ date: MINUTE_DATE, prec: '1.00', data: rows }] } },
  })
}

/**
 * The search endpoint's `v_hint` receipt.
 * @param keyword - the requested keyword.
 * @returns the response body, carrying upstream's no-match marker when nothing is scripted.
 */
function hintBody(keyword) {
  return `v_hint="${SEARCH_HINTS.get(keyword.trim().toLowerCase()) ?? 'N'}"`
}

/**
 * Install a scripted global fetch for the public paths these checks read: the
 * batched quotes, the keyword search, and the intraday series. An unscripted
 * host answers 404, which the client reports as an invalid response without
 * pausing this process the way a transport failure would.
 *
 * The client fetches a `URL` object rather than a string, and a scripted
 * failure would back this process off for a minute, so both forms are read.
 *
 * @returns the requested URLs and a restore function.
 */
function scriptTransport() {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    calls.push(url.href)
    if (url.hostname === 'qt.gtimg.cn') {
      return new Response(quoteBody(url.pathname.replace(/^\/q=/, '').split(',').filter(Boolean)))
    }
    if (url.hostname === 'smartbox.gtimg.cn') return new Response(hintBody(url.searchParams.get('q') ?? ''))
    if (url.hostname === 'web.ifzq.gtimg.cn' && url.pathname === '/appstock/app/day/query') {
      return new Response(minuteBody(url.searchParams.get('code') ?? ''))
    }
    return new Response('', { status: 404 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── stub infrastructure ─────────────────────────────────────────────────────

/** The options every mount shares; pacing is tightened so the checks stay fast. */
const BASE_CONFIG = { minIntervalMs: 1, retryDelayMs: 1 }

/** The codes the concurrent adds carry and the restart expects back, in queue order. */
const CONCURRENT = ['sh600000', 'sh600036', 'sh601318', 'sz000001', 'sz000002']

// ── A. the facility, the mount, and thirteen enforceable tool schemas ───────

const probeFacility = fakeStorageDomain()
const probe = await probeFacility.open(stockDomainSpec)
check('A the facility serves the declared global',
  show(probe.global.get()) === show(stockDomainSpec.global.initial), show(probe.global.get()))
check('A the facility refuses a table the spec does not declare',
  (await rejects(() => probe.table('items'))) !== null)
check('A the facility refuses a document its schema rejects',
  (await rejects(() => probe.global.set({ entries: 'not a list', updatedAt: null }))) !== null)
await probe.close()

const transport = scriptTransport()
const facility = fakeStorageDomain()
const mountA = await mountHost({ facility, config: BASE_CONFIG })
check('A mounted the thirteen stock tools, stock_watchlist among them',
  mountA.tools.size === 13 && mountA.tools.has('stock_watchlist'), show([...mountA.tools.keys()].sort()))
for (const [name, definition] of mountA.tools) {
  let ok = true
  let detail = ''
  try {
    assertSupportedJsonSchema(definition.parameters)
    assertSupportedJsonSchema(definition.output.schema)
  } catch (error) {
    ok = false
    detail = error.message
  }
  check(`A ${name} schemas are enforceable`, ok, detail)
}
check('A the facility opened the spec the plugin declares',
  facility.spec === stockDomainSpec, facility.spec?.name)

const caveats = mountA.sections[0]
check('A the mount registers one caveats section, after the tool sections',
  mountA.sections.length === 1 && caveats?.name === 'stock:caveats' && caveats?.order === 3120,
  show(mountA.sections.map(section => ({ name: section.name, order: section.order }))))
check('A the shared caveats are stated once, in the section alone',
  typeof caveats?.text === 'string' && caveats.text.includes('not investment advice')
  && [...mountA.tools.values()].every(tool =>
    !tool.description.includes('investment advice') && !tool.description.includes('stability guarantee')),
  show([...mountA.tools.values()].filter(tool => tool.description.includes('investment advice')).map(tool => tool.name)))
check('A a caveat about one tool stays in that tool',
  mountA.tools.get('stock_search').description.includes('Beijing exchange')
  && mountA.tools.get('stock_quote').description.includes('not_found')
  && !mountA.tools.get('stock_quote').description.includes('Beijing exchange'),
  show(mountA.tools.get('stock_quote').description))

// ── B. an empty list reads cleanly ──────────────────────────────────────────

const watchlist = mountA.tools.get('stock_watchlist')
const empty = await call(watchlist, { action: 'list' }, 'B empty list')
check('B an empty list is ok with no entries', empty.ok === true && empty.entries.length === 0, show(empty.entries))
check('B an empty list is reported as empty',
  typeof empty.note === 'string' && empty.note.includes('empty'), show(empty.note))
check('B an empty list reports no trading market and no mutation instant',
  empty.market.open === false && empty.market.trading.length === 0 && empty.updated_at === null,
  show({ market: empty.market, updated_at: empty.updated_at }))

// ── C. add canonicalizes, deduplicates, and writes the durable value ────────

const added = await call(watchlist, { action: 'add', codes: ['hk700'] }, 'C add')
check('C add canonicalizes the code', codesOf(added) === 'hk00700', codesOf(added))
check('C the request carried the canonical code', transport.calls.some(url => url.includes('/q=hk00700')),
  show(transport.calls.at(-1)))
check('C add reports the quote of the new entry',
  added.items.length === 1 && added.items[0].code === 'hk00700', show(added.items.map(item => item.code)))
check('C add records the mutation instant', added.updated_at !== null, show(added.updated_at))
check('C the durable document holds the entry with the name upstream reported',
  facility.document.entries.length === 1 && facility.document.entries[0].code === 'hk00700'
  && facility.document.entries[0].name === 'Tencent Holdings', show(facility.document.entries))
check('C the durable document records the mutation instant',
  facility.document.updatedAt === added.updated_at, show(facility.document.updatedAt))

const again = await call(watchlist, { action: 'add', codes: ['hk00700'] }, 'C duplicate add')
check('C a repeated code is reported as already in the list',
  (again.note ?? '').includes('Already in the watchlist') && codesOf(again) === 'hk00700', show(again.note))
check('C the repeated code changed nothing durably',
  facility.document.entries.length === 1, show(facility.document.entries.length))

// ── D. the tool value keeps what the panel later drops ──────────────────────

const three = await call(watchlist, { action: 'add', codes: ['sh600519', 'sz000001'] }, 'D add two')
check('D the additions keep the order they were asked for',
  codesOf(three) === 'hk00700,sh600519,sz000001', codesOf(three))
const mainland = three.items.find(item => item.code === 'sh600519')
check('D the mainland quote carries the order book and the valuation',
  Array.isArray(mainland?.bids) && mainland.bids.length === 5 && mainland.pe_ttm === 25.5,
  show({ bids: mainland?.bids?.length, pe_ttm: mainland?.pe_ttm }))

// ── E. move reorders, and reports what it cannot do ─────────────────────────

const moved = await call(watchlist, { action: 'move', code: 'sz000001', to: 1 }, 'E move')
check('E move puts the code at the target position',
  codesOf(moved) === 'sz000001,hk00700,sh600519', codesOf(moved))
const beyond = await call(watchlist, { action: 'move', code: 'hk00700', to: 9 }, 'E move past the end')
check('E a target past the end is reported without changing the list',
  (beyond.note ?? '').includes('between 1 and 3') && codesOf(beyond) === 'sz000001,hk00700,sh600519',
  show(beyond.note))
const unknownCode = await call(watchlist, { action: 'move', code: 'sh601318', to: 1 }, 'E move an unknown code')
check('E a code the list does not hold is reported without changing the list',
  (unknownCode.note ?? '').includes('does not hold') && codesOf(unknownCode) === 'sz000001,hk00700,sh600519',
  show(unknownCode.note))
const still = await call(watchlist, { action: 'move', code: 'sz000001', to: 1 }, 'E move to its own position')
check('E a move to the position already held is reported as unchanged',
  (still.note ?? '').includes('already occupies') && codesOf(still) === 'sz000001,hk00700,sh600519', show(still.note))

// ── F. remove reports an absent code and drops the followed one ─────────────

const absent = await call(watchlist, { action: 'remove', codes: ['sh601318'] }, 'F remove absent')
check('F an absent code is reported as not in the list',
  (absent.note ?? '').includes('Not in the watchlist: sh601318.') && codesOf(absent) === 'sz000001,hk00700,sh600519',
  show(absent.note))
const dropped = await call(watchlist, { action: 'remove', codes: ['hk00700'] }, 'F remove followed')
check('F a followed code is dropped from the list and the document',
  codesOf(dropped) === 'sz000001,sh600519' && facility.document.entries.length === 2, codesOf(dropped))

// ── G. clear needs its confirmation ─────────────────────────────────────────

const unconfirmed = await rejects(() => watchlist.execute({ action: 'clear' }, {}))
check('G clear without confirm throws', (unconfirmed ?? '').includes('confirm: true'), show(unconfirmed))
check('G the refused clear left the list intact',
  codesOf(await call(watchlist, { action: 'list' }, 'G list after refused clear')) === 'sz000001,sh600519')
const cleared = await call(watchlist, { action: 'clear', confirm: true }, 'G clear')
check('G a confirmed clear empties the list and the document',
  codesOf(cleared) === '' && cleared.entries.length === 0 && facility.document.entries.length === 0,
  show(facility.document.entries))

// ── H. an unusable code fails the whole call ────────────────────────────────

const refused = await rejects(() => watchlist.execute({ action: 'add', codes: ['sh601318', '600519'] }, {}))
check('H a code without a market prefix throws', (refused ?? '').includes('600519'), show(refused))
check('H the refused add wrote nothing, not even the usable code',
  facility.document.entries.length === 0, show(facility.document.entries))

// ── I. concurrent adds all land ─────────────────────────────────────────────

const raced = await Promise.all(CONCURRENT.map(code =>
  call(watchlist, { action: 'add', codes: [code] }, `I concurrent add ${code}`)))
check('I every concurrent add reported success',
  raced.every(value => value.ok === true), show(raced.map(value => value.ok)))
check('I the store kept every concurrently added code, in queue order',
  codesOf(raced.at(-1)) === CONCURRENT.join(','), codesOf(raced.at(-1)))
check('I the durable document holds every concurrently added code',
  facility.document.entries.map(entry => entry.code).join(',') === CONCURRENT.join(','),
  show(facility.document.entries.map(entry => entry.code)))

// ── J. the market window is judged at a fixed instant ───────────────────────

const WEEKEND = Date.UTC(2026, 9, 17, 4, 0, 0)
const SESSION = Date.UTC(2026, 9, 14, 2, 0, 0)
check('J the fixed instants are a weekend and a weekday session',
  new Date(WEEKEND).getUTCDay() === 6 && new Date(SESSION).getUTCDay() === 3,
  show({ weekend: new Date(WEEKEND).toISOString(), session: new Date(SESSION).toISOString() }))
const shut = await atInstant(WEEKEND, () => call(watchlist, { action: 'list' }, 'J weekend list'))
check('J a weekend instant reports every held market closed',
  shut.market.open === false && shut.market.trading.length === 0, show(shut.market))
check('J a closed market reports the next weekday opening',
  shut.market.next_open_at === '2026-10-19T01:30:00.000Z', show(shut.market.next_open_at))
const trading = await atInstant(SESSION, () => call(watchlist, { action: 'list' }, 'J session list'))
check('J a weekday session instant reports the held mainland markets trading',
  trading.market.open === true && trading.market.trading.join(',') === 'sh,sz', show(trading.market))
check('J a trading market reports no next opening',
  trading.market.next_open_at === null, show(trading.market.next_open_at))
const LUNCH = Date.UTC(2026, 9, 14, 4, 0, 0)
const lunch = await atInstant(LUNCH, () => call(watchlist, { action: 'list' }, 'J lunch-break list'))
check('J a mainland lunch break names the afternoon session as the next opening',
  lunch.market.open === false && lunch.market.next_open_at === '2026-10-14T05:00:00.000Z',
  show({ open: lunch.market.open, next: lunch.market.next_open_at }))

// ── K. the list survives a restart ──────────────────────────────────────────

await mountA.dispose()
check('K the lifecycle disposer closed the domain', facility.isOpen === false, show(facility.isOpen))
const mountB = await mountHost({ facility, config: BASE_CONFIG })
const restarted = await call(mountB.tools.get('stock_watchlist'), { action: 'list' }, 'K restarted list')
check('K every entry survived in the order the user arranged',
  codesOf(restarted) === CONCURRENT.join(','), codesOf(restarted))
check('K the names learned before the restart survived',
  restarted.entries.every(entry => typeof entry.name === 'string' && entry.name !== ''),
  show(restarted.entries.map(entry => entry.name)))
check('K a fresh mount registers the same caveats text, so the prompt never changes between mounts',
  mountB.sections[0]?.text === caveats?.text, show(mountB.sections.map(section => section.name)))
await mountB.dispose()

// ── L. the configured maximum and the panel route ───────────────────────────

const panelFacility = fakeStorageDomain()
const mountC = await mountHost({
  facility: panelFacility,
  config: { ...BASE_CONFIG, watchlistMaxEntries: 2, panelRefreshMs: 5000 },
  withConnection: true,
})
const route = mountC.route()
check('L the panel route registered below /api',
  route?.path === BRIDGE_PATH && BRIDGE_PATH.startsWith('/api/'), show(route?.path))

const bounded = mountC.tools.get('stock_watchlist')
const two = await call(bounded, { action: 'add', codes: ['sh600519', 'sz000001'] }, 'L add at the maximum')
check('L the list took exactly its configured maximum',
  codesOf(two) === 'sh600519,sz000001', codesOf(two))
const overflow = await call(bounded, { action: 'add', codes: ['hk700'] }, 'L add past the maximum')
check('L the code with no room left is reported, not added',
  (overflow.note ?? '').includes('not added: hk00700') && codesOf(overflow) === 'sh600519,sz000001',
  show(overflow.note))
check('L the store kept its maximum', panelFacility.document.entries.length === 2,
  show(panelFacility.document.entries.length))
check('L a full list is warned about',
  mountC.warnings.some(line => line.includes('watchlist is full')), show(mountC.warnings))

const panelResponse = await route.fetch(new Request(`http://harness.test${BRIDGE_PATH}`))
const panel = await panelResponse.json()
check('L GET answers the panel value',
  panelResponse.status === 200 && panel.ok === true, show(panelResponse.status))
check('L the panel value reflects the configured panel options',
  panel.value.panel.refreshMs === 5000 && panel.value.panel.updatedAt !== undefined, show(panel.value.panel))
check('L the panel value sends no cap the client does not read',
  panel.value.panel.maxEntries === undefined && panel.value.panel.indexMaxEntries === undefined, show(panel.value.panel))
/** Exactly what the client half reads off a panel row, and so all the route may send. */
const PANEL_ROW_FIELDS = 'change,change_pct,code,currency,high,low,name,open,prev_close,price'

const rows = panel.value.quotes.items
check('L every panel row carries exactly the fields the panel draws',
  rows.length === panel.value.entries.length + panel.value.indices.length
  && rows.every(row => Object.keys(row).sort().join(',') === PANEL_ROW_FIELDS),
  show(rows.map(row => Object.keys(row).sort().join(','))))
check('L the tool value keeps the rows the panel compacts',
  two.items[0].bids !== undefined && two.items[0].asks !== undefined && two.items[0].pe_ttm !== undefined,
  show({ bids: two.items[0].bids?.length, asks: two.items[0].asks?.length, pe_ttm: two.items[0].pe_ttm }))

const refusedAdd = await postRoute(route, { action: 'add', codes: ['hk700'] })
check('L POST add answers with the outcome and the state it produced',
  refusedAdd.status === 200 && refusedAdd.payload.value.outcome.full.join(',') === 'hk00700'
  && refusedAdd.payload.value.state.entries.length === 2, show(refusedAdd.payload.value?.outcome))
const droppedOne = await postRoute(route, { action: 'remove', codes: ['sz000001'] })
check('L POST remove answers with the outcome and the state it produced',
  droppedOne.status === 200 && droppedOne.payload.value.outcome.removed.join(',') === 'sz000001'
  && droppedOne.payload.value.state.entries.map(entry => entry.code).join(',') === 'sh600519',
  show(droppedOne.payload.value?.outcome))
const refilled = await postRoute(route, { action: 'add', codes: ['hk700'] })
check('L POST add canonicalizes through the route',
  refilled.status === 200 && refilled.payload.value.outcome.added.join(',') === 'hk00700'
  && refilled.payload.value.state.entries.map(entry => entry.code).join(',') === 'sh600519,hk00700',
  show(refilled.payload.value?.outcome))

const searched = await postRoute(route, { action: 'search', keyword: 'moutai' })
check('L POST search answers with the keyword and its matches',
  searched.status === 200 && searched.payload.value.keyword === 'moutai'
  && searched.payload.value.search.items[0]?.code === 'sh600519',
  show(searched.payload.value?.search?.items))

const unknown = await postRoute(route, { action: 'nope' })
check('L an unknown action is a 400 unknown_action',
  unknown.status === 400 && unknown.payload.error.code === 'unknown_action', show(unknown.payload))
const getClear = await route.fetch(new Request(`http://harness.test${BRIDGE_PATH}?action=clear`))
const getClearBody = await getClear.json()
check('L a GET cannot clear a list',
  getClear.status === 405 && getClearBody.error.code === 'method_not_allowed',
  show({ status: getClear.status, body: getClearBody }))
const clearWithoutConfirm = await postRoute(route, { action: 'clear' })
check('L a clear without confirm is refused',
  clearWithoutConfirm.status === 400 && clearWithoutConfirm.payload.error.code === 'confirmation_required'
  && panelFacility.document.entries.length === 2,
  show(clearWithoutConfirm.payload))
const routeCleared = await postRoute(route, { action: 'clear', confirm: true })
check('L POST clear answers with the outcome and an empty state',
  routeCleared.status === 200 && routeCleared.payload.value.outcome.removed === 2
  && routeCleared.payload.value.state.entries.length === 0 && panelFacility.document.entries.length === 0,
  show(routeCleared.payload.value?.outcome))
const back = await postRoute(route, { action: 'add', codes: ['sh600519', 'hk00700'] })
check('L the list refills after a clear',
  back.payload.value.state.entries.map(entry => entry.code).join(',') === 'sh600519,hk00700',
  show(back.payload.value?.state?.entries))
const badCode = await postRoute(route, { action: 'add', codes: ['600519'] })
check('L an unusable code is a 400 invalid_code that adds nothing',
  badCode.status === 400 && badCode.payload.error.code === 'invalid_code'
  && panelFacility.document.entries.length === 2, show(badCode.payload))
const oversized = await route.fetch(new Request(`http://harness.test${BRIDGE_PATH}`, {
  method: 'POST',
  body: JSON.stringify({ action: 'status', pad: 'x'.repeat(40_000) }),
}))
check('L an oversized body is refused before it is parsed', oversized.status === 413, String(oversized.status))

// ── N. a setup that fails after the domain opened releases it ───────────────

const retryFacility = fakeStorageDomain()
const failedMount = await rejects(() => mountHost({
  facility: retryFacility,
  config: BASE_CONFIG,
  failToolAt: 3,
}))
check('N a tool registration failure fails the mount', failedMount !== null, show(failedMount))
check('N the failure released the domain it had already opened',
  retryFacility.isOpen === false, show(retryFacility.isOpen))
const retry = await mountHost({ facility: retryFacility, config: BASE_CONFIG })
check('N the plugin mounts again on that facility, as a hot reload does',
  retry.tools.size === 13 && retry.sections.length === 1,
  show({ tools: retry.tools.size, sections: retry.sections.length }))
await retry.dispose()

// ── O. the index row is a second list in the same document ──────────────────

const indexFacility = fakeStorageDomain()
const mountD = await mountHost({ facility: indexFacility, config: BASE_CONFIG, withConnection: true })
const indexRoute = mountD.route()
const indexListed = await call(mountD.tools.get('stock_watchlist'), { action: 'list', scope: 'index' }, 'O list the index row')
check('O a document that never held an index row starts with the configured defaults',
  indexListed.scope === 'index' && codesOf(indexListed) === 'sh000001,sz399001,sz399006,sh000688,sh000300', `${indexListed.scope}: ${codesOf(indexListed)}`)
check('O the index row is stored beside the followed securities',
  indexFacility.document.indices.length === 5 && indexFacility.document.entries.length === 0,
  show({ indices: indexFacility.document.indices.length, entries: indexFacility.document.entries.length }))
check('O an index row carries the latest quote of every index',
  indexListed.items.length === 5 && indexListed.items.every(item => item.type === 'ZS'), show(indexListed.items.map(item => item.type).join(',')))

const indexAdded = await call(mountD.tools.get('stock_watchlist'), { action: 'add', scope: 'index', codes: ['sh000905'] }, 'O add an index')
check('O an indexAdded index joins that row alone',
  codesOf(indexAdded) === 'sh000001,sz399001,sz399006,sh000688,sh000300,sh000905' && indexFacility.document.entries.length === 0,
  `${codesOf(indexAdded)} | followed ${indexFacility.document.entries.length}`)

const indexRepeat = await call(mountD.tools.get('stock_watchlist'), { action: 'add', scope: 'index', codes: ['sh000905'] }, 'O add it twice')
check('O an index already in the row is reported, not indexAdded again',
  (indexRepeat.note ?? '').includes('Already in the index row: sh000905.') && codesOf(indexRepeat).split(',').length === 6, show(indexRepeat.note))

let indexRejection = null
try {
  await mountD.tools.get('stock_watchlist').execute({ action: 'add', scope: 'index', codes: ['hk00700'] }, {})
} catch (error) {
  indexRejection = error.message
}
check('O the index row refuses a code that is not a mainland index',
  (indexRejection ?? '').includes('mainland index codes only'), String(indexRejection))
const indexRouteRejection = await postRoute(indexRoute, { action: 'add', scope: 'index', codes: ['sh600519'] })
check('O the panel route refuses a non-index code for the index row',
  indexRouteRejection.status === 400 && indexRouteRejection.payload.error.code === 'invalid_code'
  && !indexFacility.document.indices.some(entry => entry.code === 'sh600519'),
  show(indexRouteRejection.payload))

const indexMoved = await call(mountD.tools.get('stock_watchlist'), { action: 'move', scope: 'index', code: 'sh000905', to: 1 }, 'O move an index')
check('O an index moves to the position it was given',
  codesOf(indexMoved).startsWith('sh000905,') && indexMoved.note === undefined, show(codesOf(indexMoved)))

const indexRemoved = await call(mountD.tools.get('stock_watchlist'), { action: 'remove', scope: 'index', codes: ['sh000001'] }, 'O remove an index')
check('O a indexRemoved index leaves the row',
  !codesOf(indexRemoved).includes('sh000001') && indexRemoved.note === undefined, show(codesOf(indexRemoved)))

const indexPosted = await postRoute(indexRoute, { action: 'add', scope: 'index', codes: ['sh000016'] })
check('O the panel route adds to the scope it was given',
  indexPosted.status === 200 && indexPosted.payload.value.state.indices.some(entry => entry.code === 'sh000016')
  && indexPosted.payload.value.state.entries.length === 0, show(indexPosted.payload.value?.outcome))
const indexWrongScope = await postRoute(indexRoute, { action: 'add', scope: 'watchlists', codes: ['sh000016'] })
check('O an unknown scope is refused as a defect',
  indexWrongScope.status === 400 && indexWrongScope.payload.error.code === 'invalid_scope', show(indexWrongScope.payload.error))

const indexCleared = await postRoute(indexRoute, { action: 'clear', scope: 'index', confirm: true })
check('O clearing the index row leaves the followed securities alone',
  indexCleared.status === 200 && indexCleared.payload.value.state.indices.length === 0
  && indexFacility.document.entries.length === 0 && Array.isArray(indexFacility.document.indices),
  show({ indices: indexCleared.payload.value.state.indices.length, entries: indexFacility.document.entries.length }))
const indexReseeded = await call(mountD.tools.get('stock_watchlist'), { action: 'list', scope: 'index' }, 'O list the indexCleared index row')
check('O a row the user emptied stays empty',
  indexReseeded.entries.length === 0, show(indexReseeded.entries.length))
await mountD.dispose()

// ── Q. holding marks ────────────────────────────────────────────────────────

const positionFacility = fakeStorageDomain()
const mountQ = await mountHost({ facility: positionFacility, config: BASE_CONFIG, withConnection: true })
const positionRoute = mountQ.route()
const positionTool = mountQ.tools.get('stock_watchlist')
await call(positionTool, { action: 'add', codes: ['sh600519', 'sz000001'] }, 'Q add two followed securities')
const marked = await call(positionTool, { action: 'mark', code: 'sh600519', cost: 1200, quantity: 100 }, 'Q mark')
const heldEntry = marked.entries.find(entry => entry.code === 'sh600519')
check('Q mark records the cost and quantity on the followed entry',
  heldEntry?.position?.cost === 1200 && heldEntry.position.quantity === 100
  && typeof heldEntry.position.markedAt === 'string' && positionFacility.document.entries[0].position.cost === 1200,
  show(heldEntry?.position))
check('Q marking leaves the list order and the other entry alone',
  codesOf(marked) === 'sh600519,sz000001' && marked.entries[1].position === null,
  show(marked.entries.map(entry => ({ code: entry.code, position: entry.position }))))
const updated = await call(positionTool, { action: 'mark', code: 'sh600519', quantity: 200 }, 'Q update the quantity')
check('Q a mark that names one figure keeps the other stored',
  updated.entries[0].position.cost === 1200 && updated.entries[0].position.quantity === 200,
  show(updated.entries[0].position))
const bare = await call(positionTool, { action: 'mark', code: 'sz000001' }, 'Q mark without figures')
check('Q a bare mark records a holding with no figures to derive a profit from',
  bare.entries[1].position?.cost === null && bare.entries[1].position.quantity === null,
  show(bare.entries[1].position))
const absentMark = await call(positionTool, { action: 'mark', code: 'hk00700', cost: 10 }, 'Q mark an unlisted code')
check('Q marking a code the list does not hold changes nothing and says so',
  codesOf(absentMark) === 'sh600519,sz000001' && (absentMark.note ?? '').includes('does not hold hk00700'),
  show(absentMark.note))
const indexMark = await rejects(() => positionTool.execute({ action: 'mark', scope: 'index', code: 'sh000001' }, {}))
check('Q the index row refuses a holding mark', (indexMark ?? '').includes('Positions are marked on the watchlist'), show(indexMark))
const invalidFigure = await rejects(() => positionTool.execute({ action: 'mark', code: 'sh600519', cost: 0 }, {}))
check('Q a zero cost is refused before the store sees it', (invalidFigure ?? '').includes('positive number'), show(invalidFigure))

const routeMarked = await postRoute(positionRoute, { action: 'mark', code: 'sz000001', cost: 9.5, quantity: 300 })
check('Q the panel route marks a held position',
  routeMarked.status === 200
  && routeMarked.payload.value.state.entries.find(entry => entry.code === 'sz000001')?.position?.cost === 9.5,
  show(routeMarked.payload.value?.outcome))
const routeClearedCost = await postRoute(positionRoute, { action: 'mark', code: 'sz000001', cost: null })
check('Q a null field clears the stored figure while keeping the holding',
  routeClearedCost.status === 200
  && routeClearedCost.payload.value.state.entries.find(entry => entry.code === 'sz000001')?.position?.cost === null
  && routeClearedCost.payload.value.state.entries.find(entry => entry.code === 'sz000001')?.position?.quantity === 300,
  show(routeClearedCost.payload.value?.state?.entries?.find(entry => entry.code === 'sz000001')?.position))
const routeInvalid = await postRoute(positionRoute, { action: 'mark', code: 'sz000001', quantity: -1 })
check('Q the route refuses a non-positive figure as a defect',
  routeInvalid.status === 400 && routeInvalid.payload.error.code === 'invalid_position_value'
  && positionFacility.document.entries[1].position.quantity === 300,
  show(routeInvalid.payload))
const routeWrongScope = await postRoute(positionRoute, { action: 'mark', scope: 'index', code: 'sh000001' })
check('Q the route refuses a holding mark on the index row',
  routeWrongScope.status === 400 && routeWrongScope.payload.error.code === 'invalid_scope',
  show(routeWrongScope.payload))

const unmarked = await call(positionTool, { action: 'unmark', code: 'sz000001' }, 'Q unmark')
check('Q unmark clears the position and leaves the entry followed',
  unmarked.entries[1].position === null && codesOf(unmarked) === 'sh600519,sz000001'
  && positionFacility.document.entries[1].position === null,
  show(unmarked.entries[1]))
const againUnmarked = await call(positionTool, { action: 'unmark', code: 'sz000001' }, 'Q unmark twice')
check('Q unmarking an unmarked entry is reported without changing the list',
  (againUnmarked.note ?? '').includes('is not marked as held'), show(againUnmarked.note))
const routeUnmarked = await postRoute(positionRoute, { action: 'unmark', code: 'sh600519' })
check('Q the panel route clears a held position',
  routeUnmarked.status === 200
  && routeUnmarked.payload.value.state.entries.find(entry => entry.code === 'sh600519')?.position === null,
  show(routeUnmarked.payload.value?.outcome))

const persistedFacility = fakeStorageDomain()
const mountP1 = await mountHost({ facility: persistedFacility, config: BASE_CONFIG, withConnection: true })
await call(mountP1.tools.get('stock_watchlist'), { action: 'add', codes: ['sh600519'] }, 'Q add for a restart')
await call(mountP1.tools.get('stock_watchlist'), { action: 'mark', code: 'sh600519', cost: 1180.5, quantity: 20 }, 'Q mark for a restart')
await mountP1.dispose()
const mountP2 = await mountHost({ facility: persistedFacility, config: BASE_CONFIG })
const reopenedPosition = await call(mountP2.tools.get('stock_watchlist'), { action: 'list' }, 'Q position after restart')
check('Q a marked position survives a restart',
  reopenedPosition.entries[0]?.position?.cost === 1180.5 && reopenedPosition.entries[0]?.position?.quantity === 20,
  show(reopenedPosition.entries[0]?.position))
await mountP2.dispose()
await mountQ.dispose()

// ── H. holdings, as the model sees them ─────────────────────────────────────

// The scripted transport quotes every security at 100.00, so a cost of 80 and
// 200 shares is a +25% holding worth 20,000 in the security's own currency.
const holdingFacility = fakeStorageDomain()
const mountH = await mountHost({ facility: holdingFacility, config: BASE_CONFIG })
const holdingTool = mountH.tools.get('stock_watchlist')
await call(holdingTool, { action: 'add', codes: ['sh600519', 'sz000001', 'hk00700'] }, 'H add')
await call(holdingTool, { action: 'mark', code: 'sh600519', cost: 80, quantity: 200 }, 'H full mark')
await call(holdingTool, { action: 'mark', code: 'hk00700', cost: 125 }, 'H cost only')

const held = await call(holdingTool, { action: 'list' }, 'H list with holdings')
const first = held.holdings.find(entry => entry.code === 'sh600519')
check('H a full position reports its value and profit beside the stored cost and quantity',
  first?.price === 100 && first.market_value === 20000 && first.profit === 4000 && first.profit_pct === 25
  && first.cost === 80 && first.quantity === 200 && first.currency === 'CNY',
  show(first))
check('H the holdings follow the list order and skip unmarked entries',
  held.holdings.map(entry => entry.code).join(',') === 'sh600519,hk00700',
  show(held.holdings.map(entry => entry.code)))
const percentOnly = held.holdings.find(entry => entry.code === 'hk00700')
check('H a position with a cost but no share count reports a return, not a value or an amount',
  percentOnly?.profit_pct === -20 && percentOnly.market_value === null && percentOnly.profit === null
  && percentOnly.currency === 'HKD',
  show(percentOnly))
check('H the note points at marking when nothing is held but the list is not empty',
  (held.note ?? '') === '' || !(held.note ?? '').includes('No entry is marked as held'),
  show(held.note))

const bareH = await mountHost({ facility: fakeStorageDomain(), config: BASE_CONFIG })
const bareTool = bareH.tools.get('stock_watchlist')
await call(bareTool, { action: 'add', codes: ['sh600519'] }, 'H add for the bare list')
const unmarkedList = await call(bareTool, { action: 'list' }, 'H list with nothing marked')
check('H a list with no holding says how to record one',
  unmarkedList.holdings.length === 0 && (unmarkedList.note ?? '').includes('action `mark`'),
  show(unmarkedList.note))
await bareH.dispose()

const indexList = await call(holdingTool, { action: 'list', scope: 'index' }, 'H index row')
check('H the index row explains that it carries no positions',
  indexList.holdings.length === 0 && (indexList.note ?? '').includes('market gauge'), show(indexList.note))

const afterRemoval = await call(holdingTool, { action: 'remove', codes: ['sh600519'] }, 'H remove a holding')
check('H removing a held security drops it from the holdings too',
  afterRemoval.holdings.map(entry => entry.code).join(',') === 'hk00700',
  show(afterRemoval.holdings.map(entry => entry.code)))
await mountH.dispose()

// ── P. the panel's intraday lines ───────────────────────────────────────────

/** The intraday reads the transport has answered so far. */
const minuteReads = () => transport.calls.filter(url => url.includes('/appstock/app/day/query')).length

const lineFacility = fakeStorageDomain()
const mountE = await mountHost({
  facility: lineFacility,
  config: { ...BASE_CONFIG, sparklinePoints: 4, sparklineRefreshMs: 60_000, sparklineMaxFetches: 1 },
  withConnection: true,
})
const lineRoute = mountE.route()
await postRoute(lineRoute, { action: 'add', codes: ['sh600519', 'sz000001', 'hk00700'] })
check('P a view of the lines reads no upstream series of its own',
  minuteReads() === 0, show(minuteReads()))

const firstLines = await postRoute(lineRoute, { action: 'sparklines', codes: ['sh600519', 'sz000001', 'hk00700'] })
const firstSeries = firstLines.payload.value?.series ?? {}
check('P the answered series carries the session date and the thinned prices',
  firstLines.status === 200 && firstSeries.sh600519?.date === '2026-10-15'
  && JSON.stringify(firstSeries.sh600519?.points) === JSON.stringify([100, 102, 103, 105]),
  show(firstSeries.sh600519))
check('P the codes beyond the configured read budget are reported as pending',
  JSON.stringify(firstLines.payload.value?.pending) === JSON.stringify(['sz000001', 'hk00700']),
  show(firstLines.payload.value?.pending))
check('P one request reads only the codes its budget covers',
  firstLines.payload.value?.failed.length === 0 && minuteReads() === 1,
  show({ failed: firstLines.payload.value?.failed, reads: minuteReads() }))

const secondLines = await postRoute(lineRoute, { action: 'sparklines', codes: ['sh600519', 'sz000001', 'hk00700'] })
const secondSeries = secondLines.payload.value?.series ?? {}
check('P a later view reads the next stalest code and serves the first from its cache',
  minuteReads() === 2 && secondSeries.sh600519 !== undefined
  && JSON.stringify(secondSeries.sz000001?.points) === JSON.stringify([10, 9.5, 9.8])
  && secondLines.payload.value?.pending.join(',') === 'hk00700',
  show({ reads: minuteReads(), series: Object.keys(secondSeries), pending: secondLines.payload.value?.pending }))

const thirdLines = await postRoute(lineRoute, { action: 'sparklines', codes: ['sh600519', 'sz000001', 'hk00700'] })
check('P a code with no intraday series upstream is reported as a failure, not retried forever',
  thirdLines.status === 200
  && thirdLines.payload.value.failed.some(entry => entry.code === 'hk00700' && entry.error.code === 'not_found')
  && thirdLines.payload.value.pending.length === 0,
  show(thirdLines.payload.value.failed))
check('P every code is read once, and a cached series is not read again inside its window',
  minuteReads() === 3, show(transport.calls.filter(url => url.includes('day/query'))))
check('P a code this plugin cannot query is a defect of the request',
  (await postRoute(lineRoute, { action: 'sparklines', codes: ['600519'] })).payload.error?.code === 'invalid_code')
check('P a view of the lines without codes is a defect of the request',
  (await postRoute(lineRoute, { action: 'sparklines', codes: [] })).payload.error?.code === 'invalid_body')
await mountE.dispose()

// ── teardown ────────────────────────────────────────────────────────────────

transport.restore()
await mountC.dispose()
check('M the lifecycle disposer released the panel domain',
  panelFacility.isOpen === false, show(panelFacility.isOpen))

console.log(failures.length === 0
  ? `\nALL ${checks} CHECKS PASSED`
  : `\nFAILED ${failures.length} OF ${checks}: ${failures.join(', ')}`)
process.exitCode = failures.length === 0 ? 0 : 1

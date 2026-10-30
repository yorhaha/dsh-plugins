/**
 * Deterministic parsing checks for the dsh-stock Host half: the upstream
 * behaviours the live quote endpoints cannot produce on demand.
 *
 * Mounts the real plugin through a stub context whose HTTP transport is
 * scripted, then covers the upstream quirks a live read cannot produce on
 * demand. The search endpoint matches a name by prefix and answers its
 * no-match marker above 23 bytes of keyword instead of truncating the keyword
 * itself, so this plugin searches the longest prefix within that and says which
 * one it used. The newest intraday row of a session upstream is still finalizing
 * restates the day's cumulative amount below the row before it, which the series
 * accepts and names in its note, while a decrease anywhere else still fails the
 * call. A security without a daily limit carries `-1` in its limit fields rather
 * than an empty one, which reads as no limit instead of failing the batch it
 * arrived in.
 *
 * Offline: the scripted transport answers the search, quote, intraday, and
 * multi-day intraday paths, so nothing reaches the network. Run
 * `node tests/verify-endpoints.mjs` from the plugin directory after `pnpm install`.
 */
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { fakeStorageDomain, mountHost } from './host-harness.mjs'

let checks = 0
const failures = []
const check = (label, ok, detail = '') => {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const show = (value) => JSON.stringify(value ?? null)

// ── the scripted endpoints ──────────────────────────────────────────────────

/**
 * Search matches, keyed by the keyword the plugin sends. Both keys are exactly
 * what a longer accepted keyword has to be cut to. The names stay ASCII because
 * the endpoint body is read as GBK, which these checks do not exercise.
 */
const SEARCH_HINTS = new Map([
  ['半导体设备ETF国', 'sz~159516~Semiconductor Equipment ETF Guotai~bdtsbetfgt~ETF'],
  ['科创半导体设备ET', 'sh~588710~STAR Semiconductor Equipment ETF~kcbdtsbetfhtbr~ETF'],
])

/**
 * Intraday rows per code. `sz159516` ends with the restated settled amount, and
 * `sz000002` carries the same decrease one row before the end.
 */
const SCRIPTED_MINUTES = new Map([
  ['sz159516', [
    '0930 0.580 1179341 68401778.00',
    '1459 0.599 51000000 3060541629.00',
    '1500 0.601 51981023 3060934201.93',
    '1515 0.601 51981038 3059731802.00',
  ]],
  ['sz000002', [
    '0930 0.580 1000 58000.00',
    '1500 0.601 2000 120000.00',
    '1501 0.601 2100 119000.00',
    '1502 0.601 2200 121000.00',
  ]],
])

/** The no-match receipt for a keyword nothing is scripted for. */
const NO_HINT = 'v_hint="N"'

/**
 * One quote per code, as the batched text endpoint carries it. `sh113050` is a
 * convertible bond: upstream reports `-1` in both limit fields because the
 * instrument has no fixed daily limit.
 */
const SCRIPTED_QUOTES = new Map([
  ['sh600519', { name: 'Kweichow Moutai', price: 1309.02, limitUp: 1440.66, limitDown: 1178.72, type: 'GP-A' }],
  ['sh113050', { name: 'Nanyin Convertible Bond', price: 110.5, limitUp: -1, limitDown: -1, type: 'ZQ-KZZ' }],
])

/** Fields in one mainland quote, which is the shortest the parser accepts. */
const QUOTE_FIELDS = 83

/**
 * The batched-quote body for the requested codes, at the layout the parser
 * reads.
 *
 * @param path - the request path, which carries the codes after `/q=`.
 * @returns the text body, which omits an unscripted code.
 */
function quoteBody(path) {
  const lines = []
  for (const code of path.slice('/q='.length).split(',')) {
    const row = SCRIPTED_QUOTES.get(code)
    if (row === undefined) continue
    const fields = new Array(QUOTE_FIELDS).fill('')
    fields[1] = row.name
    fields[2] = code.slice(2)
    fields[3] = String(row.price)
    fields[4] = String(row.price)
    fields[5] = String(row.price)
    fields[6] = '1000'
    fields[30] = '20261022150000'
    fields[31] = '0.00'
    fields[32] = '0.00'
    fields[33] = String(row.price)
    fields[34] = String(row.price)
    fields[47] = String(row.limitUp)
    fields[48] = String(row.limitDown)
    fields[57] = '100'
    fields[61] = row.type
    fields[82] = 'CNY'
    lines.push(`v_${code}="${fields.join('~')}";`)
  }
  return lines.join('\n')
}

/**
 * The multi-day intraday body for one code, holding the same rows as one day.
 *
 * @param code - the requested canonical code.
 * @returns the JSON body, which carries no node for an unscripted code.
 */
function dayBody(code) {
  const rows = SCRIPTED_MINUTES.get(code)
  if (rows === undefined) return '{"code":0,"msg":"","data":{}}'
  return JSON.stringify({
    code: 0,
    msg: '',
    data: { [code]: { data: [{ date: '20261015', prec: '0.599', data: rows }] } },
  })
}

/**
 * The news body for one symbol: two items for the ordinary symbol, an empty
 * block, and one item whose time breaks the contract.
 *
 * @param symbol - the requested canonical code.
 * @returns the JSON body.
 */
function newsBody(symbol) {
  if (symbol === 'sh600001') return JSON.stringify({ code: 0, msg: 'ok', data: { data: [] } })
  if (symbol === 'sh600002') {
    return JSON.stringify({ code: 0, msg: 'ok', data: { data: [{ id: 'n3', time: 'yesterday', title: 'Broken' }] } })
  }
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      data: [
        { id: 'n2', time: '2026-10-21 09:00:00', title: 'Second', src: 'B', url: 'http://example.test/b', summary: '' },
        { id: 'n1', time: '2026-10-20 15:00:00', title: 'First', src: '', url: '', summary: 'summary' },
      ],
    },
  })
}

/**
 * The macro report body for one report name: two consumer-price rows, a row
 * without its period, and an empty report.
 *
 * @param report - the requested report name.
 * @returns the JSON body.
 */
function macroBody(report) {
  if (report === 'RPT_ECONOMY_CPI') {
    return JSON.stringify({
      success: true,
      code: 0,
      result: {
        data: [
          { TIME: '2026年09月份', NATIONAL_SAME: 0.9, NATIONAL_SEQUENTIAL: 0.2 },
          { TIME: '2026年08月份', NATIONAL_SAME: 0.8, NATIONAL_SEQUENTIAL: 0.4 },
        ],
      },
    })
  }
  if (report === 'RPT_ECONOMY_GDP') {
    return JSON.stringify({ success: true, code: 0, result: { data: [{ SUM_SAME: 4.6 }] } })
  }
  return JSON.stringify({ success: true, code: 0, result: { data: [] } })
}

/**
 * Install a scripted global fetch for the paths these checks read. An
 * unscripted host answers 404, which the client reports as an invalid response
 * without pausing this process the way a transport failure would.
 *
 * @returns the requested URLs and a restore function.
 */
function scriptTransport() {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    calls.push(url)
    if (url.hostname === 'smartbox.gtimg.cn') {
      const hint = SEARCH_HINTS.get(url.searchParams.get('q') ?? '')
      return new Response(hint === undefined ? NO_HINT : `v_hint="${hint}"`)
    }
    if (url.hostname === 'qt.gtimg.cn' && url.pathname.startsWith('/q=')) {
      return new Response(quoteBody(url.pathname))
    }
    if (url.hostname === 'web.ifzq.gtimg.cn' && url.pathname === '/appstock/app/usMinute/query') {
      const code = url.searchParams.get('code') ?? ''
      // The live endpoint answers an unknown US code with this fixed date and
      // all-zero rows, rather than an empty date.
      return new Response(code === 'usZZZZ'
        ? JSON.stringify({ code: 0, msg: '', data: { usZZZZ: { data: { date: '20210714', data: ['0930 0.000 0', '0931 0.000 0'] } } } })
        : '{"code":0,"msg":"","data":{}}')
    }
    if (url.hostname === 'web.ifzq.gtimg.cn' && url.pathname === '/appstock/app/day/query') {
      return new Response(dayBody(url.searchParams.get('code') ?? ''))
    }
    if (url.hostname === 'proxy.finance.qq.com' && url.pathname === '/cgi/cgi-bin/news/info/news') {
      // One symbol answers 5xx twice, which is how the per-host backoff is
      // reached without a transport failure.
      if (url.searchParams.get('symbol') === 'sh600009') return new Response('', { status: 503 })
      return new Response(newsBody(url.searchParams.get('symbol') ?? ''))
    }
    if (url.hostname === 'datacenter-web.eastmoney.com' && url.pathname === '/api/data/v1/get') {
      return new Response(macroBody(url.searchParams.get('reportName') ?? ''))
    }
    return new Response('', { status: 404 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── mount ───────────────────────────────────────────────────────────────────

const transport = scriptTransport()
const mount = await mountHost({ facility: fakeStorageDomain(), config: { minIntervalMs: 1, retryDelayMs: 1 } })
const tool = (name) => mount.tools.get(name)

/**
 * Run one tool call and validate its value against the tool's declared output
 * schema, so a value no consumer could accept fails the check that produced it.
 *
 * @param name - the registered tool name.
 * @param args - the raw tool arguments.
 * @param label - the check label carrying the result.
 * @returns the validated value.
 */
async function call(name, args, label) {
  const value = await tool(name).execute(args, {})
  const violations = validateJsonSchemaValue(tool(name).output.schema, value)
  check(`${label} value satisfies its schema`, violations.length === 0, violations.join('; '))
  return value
}

// ── the search endpoint's 23-byte keyword cap ───────────────────────────────

const long = await call('stock_search', { keyword: '半导体设备ETF国泰' }, 'a 24-byte keyword')
check('a keyword above 23 bytes is searched as its longest prefix within that',
  transport.calls.at(-1).searchParams.get('q') === '半导体设备ETF国', show(transport.calls.at(-1).href))
check('that search still returns the security the prefix names',
  long.ok === true && long.count === 1 && long.items[0].code === 'sz159516', show(long))
check('the note names the prefix that was searched',
  typeof long.note === 'string' && long.note.includes('半导体设备ETF国') && !long.note.includes('No match'),
  show(long.note))

const exact = await call('stock_search', { keyword: '科创半导体设备ET' }, 'a 23-byte keyword')
check('a keyword of exactly 23 bytes is sent unchanged',
  transport.calls.at(-1).searchParams.get('q') === '科创半导体设备ET' && exact.count === 1, show(exact))
check('a search that was not shortened carries no truncation note', exact.note === undefined, show(exact.note))

const short = await call('stock_search', { keyword: '半导体设备ETF' }, 'an 18-byte keyword')
check('a keyword within the cap is sent unchanged',
  transport.calls.at(-1).searchParams.get('q') === '半导体设备ETF', show(transport.calls.at(-1).href))
check('a no-match search reports the upstream caveat alone',
  short.note === 'No match was found upstream.', show(short.note))

// ── the newest intraday row's restated amount ───────────────────────────────

const restated = await call('stock_minute', { code: 'sz159516' }, 'an intraday series ending in a restatement')
check('the newest row may restate the cumulative amount below the row before it',
  restated.ok === true && restated.rows.at(-1).amount_cum === 3059731802, show(restated.error))
check('the accepted restatement is named in the note',
  typeof restated.note === 'string' && restated.note.startsWith('The newest row restates'), show(restated.note))
check('the series is read from the multi-day endpoint, never the retired single-day path',
  transport.calls.at(-1).pathname === '/appstock/app/day/query'
  && transport.calls.every(url => url.pathname !== '/appstock/app/minute/query'),
  show(transport.calls.at(-1).href))

const interior = await call('stock_minute', { code: 'sz000002' }, 'an intraday series decreasing before its end')
check('a decrease the newest row does not carry still fails the call',
  interior.ok === false && interior.error.code === 'invalid_response', show(interior))

const unknownUs = await call('stock_minute', { code: 'usZZZZ' }, 'an unknown US code')
check('an unknown US code is reported instead of zero-price rows',
  unknownUs.ok === false && unknownUs.error.code === 'not_found', show(unknownUs))

const history = await call('stock_minute_history', { code: 'sz159516', days: 5, detail: 'rows' }, 'a multi-day series')
check('the multi-day series keeps the restated newest row',
  history.ok === true && history.days.at(-1).rows.at(-1).amount_cum === 3059731802, show(history.error))

const summary = await call('stock_minute_history', { code: 'sz159516', days: 5, detail: 'summary' }, 'a multi-day summary')
check('the day aggregate carries the restated amount as its close',
  summary.ok === true && summary.days.at(-1).amount_cum === 3059731802 && summary.days.at(-1).volume_cum === 51981038,
  show(summary.days?.at(-1)))

// ── a limit price upstream reports as -1 ────────────────────────────────────

const bond = await call('stock_quote', { codes: ['sh113050'] }, 'a quote without a daily limit')
check('a limit field of -1 reads as no limit instead of failing the call',
  bond.ok === true && bond.items.length === 1
  && bond.items[0].limit_up === null && bond.items[0].limit_down === null,
  show(bond))

const mixed = await call('stock_quote', { codes: ['sh600519', 'sh113050'] }, 'a batch mixing both')
check('the security beside it keeps its limits, so one instrument cannot fail the batch',
  mixed.ok === true && mixed.items.length === 2 && mixed.missing.length === 0
  && mixed.items[0].code === 'sh600519' && mixed.items[0].limit_up === 1440.66
  && mixed.items[1].code === 'sh113050' && mixed.items[1].limit_up === null,
  show(mixed))

// ── per-symbol news ─────────────────────────────────────────────────────────

const news = await call('stock_news', { code: 'sh600000', limit: 1 }, 'a news block')
check('news keeps the newest items the limit allows',
  news.ok === true && news.returned_count === 1 && news.items.length === 1, show(news))
check('the news request carries the symbol alone',
  [...transport.calls.at(-1).searchParams.keys()].length === 1
  && transport.calls.at(-1).searchParams.get('symbol') === 'sh600000', transport.calls.at(-1).href)
check('an item time is reported as Beijing time with its offset',
  news.ok === true && news.items[0].published_at === '2026-10-21T09:00:00+08:00', show(news.items?.[0]?.published_at))

const newsAll = await call('stock_news', { code: 'sh600000' }, 'a full news block')
check('an empty upstream field maps to null beside a present one',
  newsAll.ok === true && newsAll.items.length === 2
    && newsAll.items[1].publisher === null && newsAll.items[1].summary === 'summary',
  show(newsAll.items?.[1]))

const noNews = await call('stock_news', { code: 'sh600001' }, 'an empty news block')
check('an empty block is an empty list with a note',
  noNews.ok === true && noNews.items.length === 0 && typeof noNews.note === 'string', show(noNews))

const brokenNews = await call('stock_news', { code: 'sh600002' }, 'a news item with an unreadable time')
check('an unreadable item time fails the call',
  brokenNews.ok === false && brokenNews.error.code === 'invalid_response', show(brokenNews))

// ── macro reports ───────────────────────────────────────────────────────────

const cpi = await call('stock_macro', { indicator: 'cpi', periods: 2 }, 'a macro report')
check('the macro request asks for the catalog report, newest first',
  transport.calls.at(-1).searchParams.get('reportName') === 'RPT_ECONOMY_CPI'
  && transport.calls.at(-1).searchParams.get('columns') === 'ALL'
  && transport.calls.at(-1).searchParams.get('sortColumns') === 'REPORT_DATE'
  && transport.calls.at(-1).searchParams.get('sortTypes') === '-1', transport.calls.at(-1).href)
check('a macro row keeps its period and both changes',
  cpi.ok === true && cpi.rows.length === 2 && cpi.rows[0].yoy_pct === 0.9 && cpi.rows[0].mom_pct === 0.2,
  show(cpi))

const noPeriod = await call('stock_macro', { indicator: 'gdp' }, 'a macro row without its period')
check('a row without its period fails the call',
  noPeriod.ok === false && noPeriod.error.code === 'invalid_response', show(noPeriod))

const emptyReport = await call('stock_macro', { indicator: 'm2' }, 'an empty macro report')
check('an empty report is not_found',
  emptyReport.ok === false && emptyReport.error.code === 'not_found', show(emptyReport))

// ── the backoff is keyed by the host that failed ────────────────────────────

const failedHost = await call('stock_news', { code: 'sh600009' }, 'a host answering 5xx twice')
check('a 5xx is retried once before the call fails',
  transport.calls.filter(url => url.searchParams.get('symbol') === 'sh600009').length === 2,
  show(transport.calls.length))
check('a host that failed both attempts is reported as unavailable',
  failedHost.ok === false && failedHost.error.code === 'upstream_unavailable', show(failedHost))

const stillQuoting = await call('stock_quote', { codes: ['sh600519'] }, 'a quote after another host failed')
check('a failing host does not pause the quote host',
  stillQuoting.ok === true && stillQuoting.items[0].code === 'sh600519', show(stillQuoting.error))

const stillSearching = await call('stock_search', { keyword: '科创半导体设备ET' }, 'a search after another host failed')
check('a failing host does not pause the search host',
  stillSearching.ok === true && stillSearching.count === 1, show(stillSearching.error))

const paused = await call('stock_news', { code: 'sh600000' }, 'the host that failed, asked again')
check('the host that failed is paused, naming the instant it may be asked again',
  paused.ok === false && paused.error.code === 'temporarily_blocked'
  && typeof paused.error.retry_at === 'string',
  show(paused))

// ── teardown ────────────────────────────────────────────────────────────────

transport.restore()
await mount.dispose()

console.log(failures.length === 0
  ? `\nALL ${checks} CHECKS PASSED`
  : `\nFAILED ${failures.length} OF ${checks}: ${failures.join(', ')}`)
process.exitCode = failures.length === 0 ? 0 : 1

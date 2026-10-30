/**
 * stock — market queries exposed as thirteen Host tools, plus the durable
 * watchlist the user manages from a panel.
 *
 * `stock_search`, `stock_quote`, `stock_kline`, `stock_minute`, `stock_bars`,
 * `stock_minute_history`, `stock_moneyflow`, `stock_fundamentals`,
 * `stock_market`, `stock_rank`, `stock_news`, and `stock_macro` each issue one
 * GET against a whitelisted public endpoint, coerce the response through strict
 * field checks, and return a bounded JSON value. `stock_watchlist` reads and
 * edits the one list this package stores. An expected request failure
 * (transport, timeout, an unexpected status, or a response that violates the
 * endpoint contract) comes back as an `ok: false` payload carrying a closed
 * `error.code`, so the model reads the failure and its retry time instead of
 * losing the call; only argument validation throws.
 *
 * The seven request hosts, the sixteen endpoint paths, and each path's
 * parameter keys and values are a closed whitelist: no tool can be talked into
 * requesting anything else. Requests are serialized, spaced by a minimum
 * interval, and backed off per host after a transport, 5xx, 403, or 429
 * failure, so a host that fails or refuses requests stops only itself. That
 * state — serialization chain, last request time, and each host's deadline —
 * lives in this process only and disappears when the process exits. It writes
 * no session data beyond the ordinary tool call and result the registry logs.
 *
 * `stock_watchlist` adds the one thing this plugin stores: an ordered list of
 * followed securities, kept by {@link module:dsh-stock/src/watchlist} and
 * managed from the sidebar panel {@link module:dsh-stock/src/bridge} serves.
 * Market data is never stored — a quote is read when a surface asks for one and
 * discarded with the answer.
 *
 * @module dsh-stock
 */

import { buildWatchlistApi, registerBridge } from './src/bridge.js'
import { MIN_POINTS } from './src/sparkline.js'
import { openWatchlist } from './src/watchlist.js'

/**
 * Cordis plugin name used by loader diagnostics.
 */
export const name = 'stock'

/**
 * The services this plugin contributes to and cannot run without. The
 * watchlist is durable host state, so the storage domain is a hard dependency:
 * a composition without it cannot mount this plugin instead of mounting a
 * watchlist that silently forgets everything.
 *
 * `systemPrompt` is a hard dependency for the same reason. The caveats that
 * qualify every value these endpoints return are one prompt section, so a
 * composition that mounted the tools without that service would hand the model
 * market data and no statement of what it does not promise.
 */
export const inject = ['tools', 'storageDomain', 'systemPrompt']

// ── protocol constants (fixed: they describe the remote API, not a tunable) ──

/** Host serving the batched `v_<code>="..."` quote text. */
const QT_HOST = 'qt.gtimg.cn'

/** Host serving the JSON daily-bar and intraday endpoints. */
const WEB_HOST = 'web.ifzq.gtimg.cn'

/** Host serving the keyword search endpoint. */
const SEARCH_HOST = 'smartbox.gtimg.cn'

/** Daily bars for Shanghai and Shenzhen, and for Hong Kong unadjusted. */
const FQ_PATH = '/appstock/app/fqkline/get'

/** Daily bars for Hong Kong, adjusted. */
const HKFQ_PATH = '/appstock/app/hkfqkline/get'

/** Daily bars for the United States. */
const USFQ_PATH = '/appstock/app/usfqkline/get'

/** Daily bars for the Beijing exchange. */
const NEWFQ_PATH = '/appstock/app/newfqkline/get'

/** Intraday minute series for the United States, the only market served by a single-day path. */
const US_MINUTE_PATH = '/appstock/app/usMinute/query'

/** The five most recent trading days of intraday rows. */
const DAY_PATH = '/appstock/app/day/query'

/** Keyword search path; the query parameters carry the keyword. */
const SEARCH_PATH = '/s3/'

/**
 * Longest keyword the search endpoint matches, in UTF-8 bytes. Above it the
 * endpoint answers its no-match marker instead of truncating the keyword
 * itself, and it matches a name or pinyin by prefix, so a longer keyword is
 * searched as its longest prefix within this many bytes.
 */
const SEARCH_KEYWORD_MAX_BYTES = 23

/** Quote path prefix; the requested codes follow it in the path itself. */
const QUOTE_PATH_PREFIX = '/q='

/** Daily-bar paths, all of which take exactly one `param` parameter. */
const KLINE_PATHS = new Set([FQ_PATH, HKFQ_PATH, USFQ_PATH, NEWFQ_PATH])

/** Every request is a GET; only these paths, hosts, and parameter keys exist. */
const SEARCH_PARAM_KEYS = new Set(['q', 't'])

/** Characters a batched-quote path may carry after {@link QUOTE_PATH_PREFIX}. */
const CODES_CHARSET_PATTERN = /^[A-Za-z0-9.,]+$/

// ── second upstream: Tencent's finance proxy ────────────────────────────────

/** Host serving minute bars, the board rankings, and per-symbol news. */
const PROXY_HOST = 'proxy.finance.qq.com'

/** Minute-level bars, served for Shanghai and Shenzhen only. */
const MKLINE_PATH = '/ifzqgtimg/appstock/app/kline/mkline'

/**
 * The newest news items upstream holds for one symbol. The endpoint carries no
 * paging: every request answers the same latest block however it is asked.
 */
const NEWS_PATH = '/cgi/cgi-bin/news/info/news'

/** How many items that block holds, which is therefore the largest limit. */
const NEWS_MAX_ITEMS = 20

/** Symbols the news endpoint accepts, as this plugin builds them from a code. */
const NEWS_SYMBOL_PATTERN = /^(?:(?:sh|sz|bj)[0-9]{6}|hk[0-9]{5}|us[A-Z][A-Z0-9]*)$/

/** A news item's upstream time, which is Beijing wall-clock time. */
const NEWS_TIME_PATTERN = /^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2})$/

/** What a news field violates when it is not the text the endpoint promised. */
const NEWS_TEXT_MESSAGE = 'A news item does not match the endpoint contract.'

/** Sector boards ranked by one key. */
const SECTOR_RANK_PATH = '/cgi/cgi-bin/rank/pt/getRank'

/** Securities of one board ranked by one key. */
const STOCK_RANK_PATH = '/cgi/cgi-bin/rank/hs/getBoardRankList'

/**
 * Minute-bar periods the endpoint serves. The third request field must stay
 * empty: any value there makes the endpoint answer with an empty series, so it
 * is not an end date.
 */
const BAR_PERIODS = ['m1', 'm5', 'm15', 'm30', 'm60', 'm120']

/** Requested sort key → the upstream token. */
const RANK_SORT_TOKENS = { change_pct: 'PriceRatio', turnover: 'turnover', volume: 'volume' }

/** Requested ranking order → the upstream direction token. */
const RANK_ORDER_TOKENS = { top: 'down', bottom: 'up' }

/** Sector board scopes the ranking endpoint serves. */
const SECTOR_BOARDS = { hy: 'industry', dy: 'region', gn: 'concept', all: 'all boards' }

/** Security-board scopes the ranking endpoint serves. */
const STOCK_BOARDS = { aStock: 'Shanghai and Shenzhen A shares', cyb: 'ChiNext' }

/** Ranking scope → the board values it accepts. */
const RANK_BOARDS = { sector: SECTOR_BOARDS, stock: STOCK_BOARDS }

/** Ranking parameter keys, which every ranking request carries. */
const RANK_PARAM_KEYS = ['sort_type', 'direct', 'offset', 'count']

// ── third upstream: East Money snapshots, money flow, and fundamentals ──────

/** Host serving snapshot lists and the same-day money-flow series. */
const EM_PUSH_HOST = 'push2.eastmoney.com'

/** Host serving money-flow history. */
const EM_HISTORY_HOST = 'push2his.eastmoney.com'

/** Host serving report-period fundamentals. */
const EM_DATA_HOST = 'datacenter-web.eastmoney.com'

/** Snapshot list endpoint: index quotes, advance and decline counts, or money flow. */
const EM_ULIST_PATH = '/api/qt/ulist.np/get'

/** Same-day money flow, sampled once a minute. */
const EM_FLOW_INTRADAY_PATH = '/api/qt/stock/fflow/kline/get'

/** Per-day money-flow history. */
const EM_FLOW_DAILY_PATH = '/api/qt/stock/fflow/daykline/get'

/** Report-period fundamentals. */
const EM_DATA_PATH = '/api/data/v1/get'

/**
 * The closed index set the market overview reports, in output order. Each entry
 * pairs the secid this plugin requests with the code vocabulary it returns,
 * because the upstream market digit alone cannot tell Shenzhen from Beijing.
 */
const MARKET_INDEXES = [
  { secid: '1.000001', code: 'sh000001' },
  { secid: '0.399001', code: 'sz399001' },
  { secid: '0.399006', code: 'sz399006' },
  { secid: '1.000300', code: 'sh000300' },
  { secid: '1.000688', code: 'sh000688' },
  { secid: '0.899050', code: 'bj899050' },
]

/** The requested secids of {@link MARKET_INDEXES}, as one query value. */
const MARKET_INDEX_SECIDS = MARKET_INDEXES.map(entry => entry.secid)

/** Requested secid → the code this plugin reports for it. */
const MARKET_INDEX_CODES = new Map(MARKET_INDEXES.map(entry => [entry.secid, entry.code]))

/** Field selection of the market overview: quotes plus advance and decline counts. */
const EM_INDEX_FIELDS = 'f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f104,f105,f106'

/** Field selection shared by both money-flow series. */
const EM_FLOW_KLINE_FIELDS1 = 'f1,f2,f3,f7'

/** Column selection shared by both money-flow series. */
const EM_FLOW_KLINE_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65'

/** The one fundamentals report this plugin reads. */
const EM_FUNDAMENTAL_REPORT = 'RPT_LICO_FN_CPD'

/** Columns of the fundamentals report, in the order the parser expects them. */
const EM_FUNDAMENTAL_COLUMNS = [
  'SECUCODE', 'REPORTDATE', 'QDATE', 'BASIC_EPS', 'DEDUCT_BASIC_EPS', 'TOTAL_OPERATE_INCOME',
  'PARENT_NETPROFIT', 'WEIGHTAVG_ROE', 'YSTZ', 'SJLTZ', 'BPS', 'MGJYXJJE', 'XSMLL', 'BOARD_NAME',
  'NOTICE_DATE',
].join(',')

/**
 * The macro indicators this plugin reads, each as the report that publishes it,
 * the field naming its period, and the ordered output field → upstream field
 * pairs. The catalog is closed: a report outside it is never requested.
 */
const MACRO_CATALOG = {
  gdp: {
    report: 'RPT_ECONOMY_GDP',
    fields: [['gdp_yi', 'DOMESTICL_PRODUCT_BASE'], ['yoy_pct', 'SUM_SAME']],
  },
  cpi: {
    report: 'RPT_ECONOMY_CPI',
    fields: [['yoy_pct', 'NATIONAL_SAME'], ['mom_pct', 'NATIONAL_SEQUENTIAL']],
  },
  ppi: {
    report: 'RPT_ECONOMY_PPI',
    fields: [['yoy_pct', 'BASE_SAME'], ['index', 'BASE']],
  },
  pmi: {
    report: 'RPT_ECONOMY_PMI',
    fields: [['manufacturing', 'MAKE_INDEX'], ['non_manufacturing', 'NMAKE_INDEX']],
  },
  m2: {
    // The report's English field names predate today's money-supply caliber:
    // by magnitude, `BASIC_CURRENCY` is M2, `CURRENCY` is M1, and `FREE_CASH`
    // is M0, which is what this plugin reports them as.
    report: 'RPT_ECONOMY_CURRENCY_SUPPLY',
    fields: [
      ['m2_yi', 'BASIC_CURRENCY'], ['m2_yoy_pct', 'BASIC_CURRENCY_SAME'],
      ['m1_yi', 'CURRENCY'], ['m1_yoy_pct', 'CURRENCY_SAME'],
    ],
  },
}

/** Calendar period each macro report states in its `TIME` field. */
const MACRO_PERIOD_FIELD = 'TIME'

/** What a non-text macro period violates. */
const MACRO_TEXT_MESSAGE = 'A macro row does not carry a readable period.'

/** The largest period count one macro request may ask for. */
const MACRO_MAX_PERIODS = 24

/** Market → the East Money market prefix of a secid. */
const EM_SECID_PREFIX = { sh: '1', sz: '0', bj: '0', hk: '116' }

/** US exchange suffix → the East Money market prefix of a secid. */
const EM_US_SECID_PREFIX = { '.OQ': '105', '.N': '106', '.AM': '107' }

/** Market → the suffix of a fundamentals `SECUCODE`. */
const EM_SECUCODE_SUFFIX = { sh: 'SH', sz: 'SZ', bj: 'BJ' }

/** Secid pattern: a market prefix, a dot, and the upstream security id. */
const SECID_PATTERN = /^[0-9]{1,3}\.[A-Za-z0-9]{1,10}$/

/** Minute-bar request pattern: a Shanghai or Shenzhen code, a period, and an empty third field. */
const MKLINE_PARAM_PATTERN = new RegExp(`^(?:sh|sz)[0-9]{6},(?:${BAR_PERIODS.join('|')}),,[0-9]{1,4}$`)

/** Minute-bar timestamp pattern. */
const BAR_TIME_PATTERN = /^([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})$/

/** Money-flow timestamp pattern, which the daily and same-day series share. */
const FLOW_TIME_PATTERN = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}):([0-9]{2})/

/** A ranked sector's advance and decline counts, as upstream reports them. */
const SECTOR_COUNTS_PATTERN = /^([0-9]+)\/([0-9]+)$/

/** What a non-text ranking field violates. */
const RANK_TEXT_MESSAGE = 'A ranking text field does not match the endpoint contract.'

/** What a non-text market-overview field violates. */
const MARKET_TEXT_MESSAGE = 'A market-overview text field does not match the endpoint contract.'

/** Fundamentals filter pattern, which is the only upstream query text this plugin builds. */
const EM_FILTER_PATTERN = /^\(SECUCODE="[0-9]{6}\.(?:SH|SZ|BJ)"\)$/

/** Market → the IANA zone whose clock and trading day the market follows. */
const MARKET_TIMEZONE = {
  sh: 'Asia/Shanghai',
  sz: 'Asia/Shanghai',
  bj: 'Asia/Shanghai',
  hk: 'Asia/Shanghai',
  us: 'America/New_York',
}

/** The markets this plugin serves, in the order its schemas enumerate them. */
const MARKETS = ['sh', 'sz', 'bj', 'hk', 'us']

/** The markets a multi-day intraday series is served for. */
const MINUTE_HISTORY_MARKETS = ['sh', 'sz', 'bj', 'hk']

/** The price adjustments a caller may ask for, `auto` included. */
const ADJUST_MODES = ['auto', 'qfq', 'hfq', 'none']

/** The adjustments a response can report as applied: `auto` resolves to one of these. */
const APPLIED_ADJUSTMENTS = ['qfq', 'hfq', 'none']

/** Requested adjustment → the response data key carrying it. */
const KLINE_KEY_BY_ADJUST = { qfq: 'qfqday', hfq: 'hfqday', none: 'day' }

/** Response data key → the adjustment actually applied. */
const ADJUST_BY_KLINE_KEY = { qfqday: 'qfq', hfqday: 'hfq', day: 'none' }

/** Beijing returns whichever key it has, so lookup scans these three. */
const KLINE_KEYS = ['qfqday', 'hfqday', 'day']

/**
 * Market → the security types the search keeps. Shanghai and Shenzhen keep
 * exchange-traded funds beside stocks and indexes: `ETF` and `QDII-ETF` are
 * the listed funds traded as a basket, `LOF` and `QDII-LOF` the listed
 * open-end funds that are not, and `FJ` the listed REITs. Beijing is absent:
 * its search results are not served in a form this plugin can normalize.
 */
const SEARCH_ALLOWED_TYPES = {
  sh: new Set(['GP-A', 'ZS', 'ETF', 'QDII-ETF', 'LOF', 'QDII-LOF', 'FJ']),
  sz: new Set(['GP-A', 'ZS', 'ETF', 'QDII-ETF', 'LOF', 'QDII-LOF', 'FJ']),
  hk: new Set(['GP']),
  us: new Set(['GP']),
}

/** Market → the fewest response fields a quote for it may carry. */
const QUOTE_MIN_FIELDS = { sh: 83, sz: 83, bj: 83, hk: 76, us: 57 }

/** Market → the field index holding the security type. */
const QUOTE_TYPE_INDEX = { sh: 61, sz: 61, bj: 61, hk: 63, us: 56 }

/** Market → the field index holding the traded currency. */
const QUOTE_CURRENCY_INDEX = { sh: 82, sz: 82, bj: 82, hk: 75, us: 35 }

/** Market → the field index holding the cumulative amount. */
const QUOTE_AMOUNT_INDEX = { sh: 57, sz: 57, bj: 57, hk: 37, us: 37 }

/** US exchange suffixes the batched-quote endpoint appends to a ticker. */
const US_SUFFIXES = ['.OQ', '.N', '.PS', '.AM']

const CN_CODE_PATTERN = /^(sh|sz|bj)([0-9]{6})$/i
const BJ_LEGACY_CODE_PATTERN = /^(43|83|87)/
const BJ_CURRENT_CODE_PATTERN = /^(920|899)/
const HK_CODE_PATTERN = /^hk([0-9]{1,5})$/i
const US_CODE_PATTERN = /^us([a-z0-9]+(?:\.[a-z0-9]+){0,2})$/i
const US_BODY_PATTERN = /^[A-Z0-9]+(?:\.[A-Z0-9]+){0,2}$/
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const CN_TIME_PATTERN = /^([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})$/
const HK_TIME_PATTERN = /^([0-9]{4})\/([0-9]{2})\/([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$/
const US_TIME_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$/
const MINUTE_DATE_PATTERN = /^([0-9]{4})([0-9]{2})([0-9]{2})$/
const HINT_PATTERN = /v_hint="([^"]*)"/
const UNICODE_ESCAPE_PATTERN = /\\u([0-9a-fA-F]{4})/g
const LONE_SURROGATE_PATTERN = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/
const ASCII_PATTERN = /^[\x00-\x7F]*$/
const NUMBER_PATTERN = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/
const WHITESPACE_PATTERN = /\s+/

/** Reported when the search matched nothing upstream. */
const NO_MATCH_NOTE = 'No match was found upstream.'

/** Reported when the search matched securities this plugin does not serve. */
const FILTERED_MATCH_NOTE = 'Matches exist upstream but none is in a market or security type this tool serves.'

/** Reported when a daily-bar request came back without bars. */
const EMPTY_BARS_NOTE = 'Upstream returned no daily bars for this code; the endpoint cannot distinguish a code that does not exist, a security with no history, and a market it does not cover.'

/** The ordered lists this plugin stores, as the tool and the panel address them. */
const WATCHLIST_SCOPES = ['watchlist', 'index']

/**
 * The mainland indexes a document that has never held an index row starts with:
 * the Shanghai composite, the Shenzhen component, ChiNext, STAR 50, and the CSI
 * 300. From then on the row is the user's, arranged from the panel or the tool.
 */
const DEFAULT_INDEX_CODES = ['sh000001', 'sz399001', 'sz399006', 'sh000688', 'sh000300']

// ── configuration ───────────────────────────────────────────────────────────

/**
 * Every configurable value with its default. The plugin declares no
 * schemastery `Config` (it carries no dependencies), so {@link resolveConfig}
 * validates the row's `config` itself and fails the load on a bad value.
 */
const DEFAULT_CONFIG = {
  userAgent: 'dsh-stock/0.1',
  requestTimeoutMs: 10_000,
  responseLimitBytes: 1_048_576,
  minIntervalMs: 1_000,
  retryDelayMs: 1_000,
  pauseNetworkMs: 60_000,
  pauseBlockedMs: 300_000,
  keywordMaxChars: 32,
  quoteMaxCodes: 20,
  klineDefaultCount: 120,
  klineMaxCount: 800,
  barsDefaultCount: 120,
  barsMaxCount: 320,
  minuteHistoryMaxDays: 5,
  moneyflowDefaultDays: 20,
  moneyflowMaxDays: 60,
  fundamentalsDefaultPeriods: 4,
  fundamentalsMaxPeriods: 12,
  newsDefaultLimit: 10,
  newsMaxLimit: 20,
  macroDefaultPeriods: 6,
  macroMaxPeriods: 24,
  rankDefaultCount: 20,
  rankMaxCount: 50,
  rankMaxOffset: 5_000,
  toolTimeoutMs: 60_000,
  watchlistMaxEntries: 50,
  indexMaxEntries: 10,
  panelRefreshMs: 10_000,
  sparklinePoints: 60,
  sparklineRefreshMs: 120_000,
  sparklineMaxFetches: 4,
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/** Config fields for which zero is a value: each switches one behavior off. */
const NON_NEGATIVE_CONFIG_KEYS = new Set(['panelRefreshMs', 'sparklineMaxFetches'])

/**
 * Read one positive-integer config field, falling back to its default.
 *
 * @param config - the row's raw `config` object.
 * @param key - field name, also used in the failure message.
 * @returns the configured value, or the default when the field is absent.
 */
function configInteger(config, key) {
  const value = config[key]
  if (value === undefined) return DEFAULT_CONFIG[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`stock: config.${key} must be a positive integer`)
  }
  return value
}

/**
 * Read one non-negative-integer config field, falling back to its default.
 *
 * Some fields switch a behavior off at zero, so zero is a value rather than a
 * missing one.
 *
 * @param config - the row's raw `config` object.
 * @param key - field name, also used in the failure message.
 * @returns the configured value, or the default when the field is absent.
 */
function configNonNegativeInteger(config, key) {
  const value = config[key]
  if (value === undefined) return DEFAULT_CONFIG[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`stock: config.${key} must be a non-negative integer`)
  }
  return value
}

/**
 * Resolve and validate the row's `config` into the complete option set.
 *
 * Fails loud at load on an unknown key, a non-positive integer, an empty
 * `userAgent`, a default bar count above its cap, or a sparkline shorter than a
 * line: each would otherwise surface later as a confusing runtime failure.
 *
 * @param raw - the `config` value the Loader passed to `apply`, if any.
 * @returns every option resolved to a concrete value.
 */
function resolveConfig(raw) {
  const config = raw === undefined || raw === null ? {} : raw
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('stock: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`stock: unknown config key "${key}"`)
  }
  const resolved = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === 'userAgent') continue
    resolved[key] = NON_NEGATIVE_CONFIG_KEYS.has(key) ? configNonNegativeInteger(config, key) : configInteger(config, key)
  }
  const userAgent = config.userAgent ?? DEFAULT_CONFIG.userAgent
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) {
    throw new Error('stock: config.userAgent must be a non-empty string')
  }
  resolved.userAgent = userAgent
  if (resolved.klineDefaultCount > resolved.klineMaxCount) {
    throw new Error('stock: config.klineDefaultCount must not exceed config.klineMaxCount')
  }
  if (resolved.newsDefaultLimit > resolved.newsMaxLimit) {
    throw new Error('stock: config.newsDefaultLimit must not exceed config.newsMaxLimit')
  }
  if (resolved.newsMaxLimit > NEWS_MAX_ITEMS) {
    throw new Error(`stock: config.newsMaxLimit must not exceed ${NEWS_MAX_ITEMS}, the number of items upstream holds`)
  }
  if (resolved.macroDefaultPeriods > resolved.macroMaxPeriods) {
    throw new Error('stock: config.macroDefaultPeriods must not exceed config.macroMaxPeriods')
  }
  if (resolved.macroMaxPeriods > MACRO_MAX_PERIODS) {
    throw new Error(`stock: config.macroMaxPeriods must not exceed ${MACRO_MAX_PERIODS}`)
  }
  if (resolved.sparklinePoints < MIN_POINTS) {
    throw new Error(`stock: config.sparklinePoints must be at least ${MIN_POINTS}, because a series of one point has no line to draw`)
  }
  return resolved
}

// ── failures ────────────────────────────────────────────────────────────────

/** Local argument-validation failure. No request is issued. */
class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StockUsageError'
  }
}

/**
 * Expected failure of a request that was issued (or that a host's backoff
 * refused before issuing). It carries the closed error code and, for a
 * backoff, the wall-clock time at which this process may request that host
 * again.
 */
class RequestFailure extends Error {
  /**
   * @param code - closed failure code rendered into the payload.
   * @param message - model-facing explanation.
   * @param options - `retryable` and the epoch-millisecond `retryAt`, if any.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'StockRequestFailure'
    this.code = code
    this.retryable = options.retryable === true
    this.retryAt = options.retryAt ?? null
  }

  /**
   * @returns the model-facing failure value for this request.
   */
  payload() {
    const error = { code: this.code, message: this.message, retryable: this.retryable }
    if (this.retryAt !== null) error.retry_at = isoSeconds(Math.floor(this.retryAt / 1000))
    return { ok: false, source: 'stock', error }
  }
}

/**
 * Build the failure for a response that does not match the endpoint contract.
 *
 * @param message - what the response violated.
 * @returns the failure to throw.
 */
function invalidResponse(message) {
  return new RequestFailure('invalid_response', message)
}

// ── time ────────────────────────────────────────────────────────────────────

/** Cached `Intl.DateTimeFormat` per zone, keyed by IANA zone name. */
const ZONE_FORMATTERS = new Map()

/**
 * The formatter reading one zone's wall clock as numbered parts.
 *
 * @param timeZone - IANA zone name.
 * @returns the cached formatter.
 */
function zoneFormatter(timeZone) {
  let formatter = ZONE_FORMATTERS.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    ZONE_FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Read one zone's wall-clock fields at an instant.
 *
 * @param timeZone - IANA zone name.
 * @param epochMs - the instant in epoch milliseconds.
 * @returns the zone's year, month, day, hour, minute, and second.
 */
function wallClockAt(timeZone, epochMs) {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(epochMs))
  const field = name => Number(parts.find(part => part.type === name)?.value)
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  }
}

/**
 * The zone's UTC offset at an instant, as milliseconds to add to UTC.
 *
 * @param timeZone - IANA zone name.
 * @param epochMs - the instant in epoch milliseconds.
 * @returns the offset in milliseconds.
 */
function zoneOffsetMs(timeZone, epochMs) {
  const wall = wallClockAt(timeZone, epochMs)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/** Zero-pad a number to a fixed width. */
function pad(value, width) {
  return String(value).padStart(width, '0')
}

/**
 * Split wall-clock fields out of a strict timestamp match, rejecting a
 * calendar-invalid date the way the upstream parser would.
 *
 * @param match - the pattern match whose groups are year, month, day, hour, minute, second.
 * @returns the validated fields.
 */
function wallClockFields(match) {
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw invalidResponse('A quote timestamp field is outside the calendar range the endpoint contract allows.')
  }
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw invalidResponse('A quote timestamp is not a real calendar date.')
  }
  return { year, month, day, hour, minute, second }
}

/**
 * Format one wall-clock reading as RFC 3339 in its market's zone.
 *
 * The offset is resolved twice: once from the wall clock read as UTC, then
 * again at the candidate instant, which is the reading the zone actually maps
 * back to.
 *
 * @param fields - the wall-clock fields.
 * @param timeZone - the market's IANA zone.
 * @returns the offset-bearing timestamp.
 */
function zonedTimestamp(fields, timeZone) {
  const asUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second)
  const guess = zoneOffsetMs(timeZone, asUtc)
  const offset = zoneOffsetMs(timeZone, asUtc - guess)
  const sign = offset < 0 ? '-' : '+'
  const totalMinutes = Math.abs(offset) / 60_000
  const date = `${pad(fields.year, 4)}-${pad(fields.month, 2)}-${pad(fields.day, 2)}`
  const time = `${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}`
  return `${date}T${time}${sign}${pad(Math.floor(totalMinutes / 60), 2)}:${pad(totalMinutes % 60, 2)}`
}

/**
 * The market's current trading date at an instant.
 *
 * @param timeZone - the market's IANA zone.
 * @param epochMs - the instant in epoch milliseconds.
 * @returns the date as `YYYY-MM-DD`.
 */
function todayInZone(timeZone, epochMs) {
  const wall = wallClockAt(timeZone, epochMs)
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}`
}

/**
 * Format an epoch-second timestamp as `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * @param epochSeconds - the process wall-clock instant.
 * @returns the UTC instant.
 */
function isoSeconds(epochSeconds) {
  const date = new Date(epochSeconds * 1000)
  if (Number.isNaN(date.getTime())) {
    throw invalidResponse('A quote timestamp is outside the representable range.')
  }
  return `${date.toISOString().slice(0, 19)}Z`
}

// ── trading sessions ────────────────────────────────────────────────────────

/** The mainland's continuous-trading windows, as minutes past local midnight. */
const MAINLAND_WINDOWS = [{ from: 570, to: 690 }, { from: 780, to: 900 }]

/**
 * Regular trading windows per market, in that market's own zone: the two
 * mainland sessions, Hong Kong's two, and the United States' single one.
 *
 * Exchange holidays are not modelled, so a holiday reads as open: the panel
 * then polls a quote that does not change until the next close. Deriving the
 * holiday calendar is deliberately out of scope — a stale poll is cheap, and a
 * wrong "closed" would hide a live market.
 */
const MARKET_WINDOWS = {
  sh: MAINLAND_WINDOWS,
  sz: MAINLAND_WINDOWS,
  bj: MAINLAND_WINDOWS,
  hk: [{ from: 570, to: 720 }, { from: 780, to: 960 }],
  us: [{ from: 570, to: 960 }],
}

/**
 * The next instant one market enters a regular trading window, in epoch
 * milliseconds.
 *
 * The search walks the next calendar week, skipping weekends, and resolves each
 * wall-clock window start through the zone's offset twice so a daylight-saving
 * transition between now and then still lands on the intended local time. It
 * returns null only when the market has no window at all.
 *
 * @param timeZone - the market's IANA zone.
 * @param windows - that market's windows, in minutes past local midnight.
 * @param epochMs - the instant to search from.
 * @returns the next window start, or null when there is none within a week.
 */
function nextMarketOpen(timeZone, windows, epochMs) {
  const wall = wallClockAt(timeZone, epochMs)
  const dayStart = Date.UTC(wall.year, wall.month - 1, wall.day)
  const minutesNow = wall.hour * 60 + wall.minute + wall.second / 60
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(dayStart + offset * 86_400_000)
    const weekday = day.getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (const window of windows) {
      // A window already open is not the *next* one; the caller only asks after
      // it judged the market closed, which includes the lunch break.
      if (offset === 0 && window.from <= minutesNow) continue
      const wallMs = day.getTime() + window.from * 60_000
      const first = wallMs - zoneOffsetMs(timeZone, wallMs)
      const second = wallMs - zoneOffsetMs(timeZone, first)
      return Math.max(second, epochMs + 1)
    }
  }
  return null
}

/**
 * Report which of the named markets are inside a regular trading window now,
 * and when the next one opens when none is.
 *
 * A schedule-driven surface uses this to stop polling a closed market rather
 * than to state what the market is doing: nothing here knows about holidays or
 * about a session that closed early.
 *
 * @param markets - the markets the caller cares about; duplicates are ignored.
 * @param epochMs - the instant to judge, in epoch milliseconds.
 * @returns whether any of them is trading, which ones, and the earliest next
 *   open when none is, as an RFC 3339 instant.
 */
function marketSession(markets, epochMs = Date.now()) {
  const trading = []
  let nextOpen = null
  for (const market of new Set(markets)) {
    const zone = MARKET_TIMEZONE[market]
    const windows = MARKET_WINDOWS[market]
    if (zone === undefined || windows === undefined) continue
    const wall = wallClockAt(zone, epochMs)
    const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()
    const minutes = wall.hour * 60 + wall.minute
    if (weekday >= 1 && weekday <= 5 && windows.some(window => minutes >= window.from && minutes < window.to)) {
      trading.push(market)
      continue
    }
    const candidate = nextMarketOpen(zone, windows, epochMs)
    if (candidate !== null && (nextOpen === null || candidate < nextOpen)) nextOpen = candidate
  }
  trading.sort()
  return {
    open: trading.length > 0,
    trading,
    next_open_at: trading.length > 0 || nextOpen === null ? null : new Date(nextOpen).toISOString(),
  }
}

// ── value coercion ──────────────────────────────────────────────────────────

/**
 * Whether a decoded value is a JSON object rather than an array or null.
 *
 * @param value - the candidate.
 * @returns whether it is a plain record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read an optional text field, mapping an absent value to null.
 *
 * @param value - the raw field.
 * @param message - what a malformed field violates.
 * @returns the text, or null when the field is absent.
 */
function text(value, message = 'A quote text field does not match the endpoint contract.') {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalidResponse(message)
  return value
}

/**
 * Read a required numeric field.
 *
 * @param value - the raw field.
 * @param field - the field name, used in the failure message.
 * @returns the parsed number.
 */
function number(value, field) {
  const message = `The quote field ${field} is not a valid number.`
  if (typeof value !== 'string' || !ASCII_PATTERN.test(value)) throw invalidResponse(message)
  const stripped = value.trim()
  if (!NUMBER_PATTERN.test(stripped)) throw invalidResponse(message)
  const parsed = Number(stripped)
  if (!Number.isFinite(parsed)) throw invalidResponse(message)
  return parsed
}

/**
 * Read an optional numeric field, mapping an absent value to null.
 *
 * @param value - the raw field.
 * @param field - the field name, used in the failure message.
 * @returns the parsed number, or null when the field is absent.
 */
function optionalNumber(value, field) {
  if (value === undefined || value === null || value === '') return null
  return number(value, field)
}

/**
 * Reject a negative reading, which no field in this contract may carry.
 *
 * @param value - the parsed number, or null.
 * @param field - the field name, used in the failure message.
 * @returns the value unchanged.
 */
function nonNegative(value, field) {
  if (value !== null && value < 0) {
    throw invalidResponse(`The quote field ${field} is negative, outside the endpoint contract.`)
  }
  return value
}

/**
 * Read a daily limit price. Upstream answers `-1` for a security that has no
 * fixed limit — an index, or a convertible bond under its temporary-halt
 * regime — instead of leaving the field empty, so `-1` means the value does not
 * apply rather than that the field broke the contract.
 *
 * @param value - the raw field.
 * @param field - the field name, used in the failure message.
 * @returns the limit price, or null when upstream reports no limit.
 */
function limitPrice(value, field) {
  const parsed = optionalNumber(value, field)
  return parsed === -1 ? null : nonNegative(parsed, field)
}

/**
 * Read a required numeric field of a JSON payload, which carries it as a number
 * or as a numeric string depending on the endpoint.
 *
 * @param value - the raw field.
 * @param field - the field name, used in the failure message.
 * @returns the parsed number.
 */
function jsonNumber(value, field) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidResponse(`The quote field ${field} is not a valid number.`)
    return value
  }
  return number(value, field)
}

/**
 * Read an optional numeric field of a JSON payload, mapping an absent value to
 * null.
 *
 * @param value - the raw field.
 * @param field - the field name, used in the failure message.
 * @returns the parsed number, or null when the field is absent.
 */
function jsonOptionalNumber(value, field) {
  if (value === undefined || value === null || value === '') return null
  return jsonNumber(value, field)
}

/**
 * Normalize an upstream timestamp that carries a date and may carry a time of
 * day, keeping the date.
 *
 * @param value - the raw `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS` field.
 * @param field - the field name, used in the failure message.
 * @returns the date as `YYYY-MM-DD`, or null when the field is absent.
 */
function dateOnly(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalidResponse(`The quote field ${field} is not a date.`)
  const date = value.trim().slice(0, 10)
  if (!DATE_PATTERN.test(date)) throw invalidResponse(`The quote field ${field} is not a date.`)
  const probe = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== date) {
    throw invalidResponse(`The quote field ${field} is not a real calendar date.`)
  }
  return date
}

// ── request bodies ──────────────────────────────────────────────────────────

/**
 * Decode an upstream body as GBK text. The live endpoints serve GBK, and
 * `gb18030` is its superset.
 *
 * @param bytes - the response body.
 * @returns the decoded text.
 */
function decodeGbk(bytes) {
  try {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  } catch {
    throw invalidResponse('The quote response text could not be decoded.')
  }
}

/**
 * Parse a JSON response body.
 *
 * @param bytes - the response body.
 * @returns the parsed value.
 */
function loadJson(bytes) {
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw invalidResponse('The quote endpoint did not return valid JSON.')
  }
  return parsed
}

/**
 * Restore the `\uXXXX` escapes the search endpoint uses in names and pinyin.
 *
 * @param value - the escaped text.
 * @returns the decoded text.
 */
function unescapeHint(value) {
  const decoded = value.replace(UNICODE_ESCAPE_PATTERN, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  if (LONE_SURROGATE_PATTERN.test(decoded)) {
    throw invalidResponse('A search result carries an incomplete Unicode escape.')
  }
  return decoded
}

/**
 * Split one line-oriented quote body into code → fields.
 *
 * @param body - the decoded quote text.
 * @returns each `v_<code>="…"` line as its field list.
 */
function parseQuoteText(body) {
  const quotes = new Map()
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('v_')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    let value = trimmed.slice(separator + 1).trim()
    if (value.endsWith(';')) value = value.slice(0, -1)
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    quotes.set(trimmed.slice(2, separator).trim(), value.split('~'))
  }
  return quotes
}

/**
 * Cut an accepted keyword to the longest prefix the search endpoint matches.
 *
 * @param keyword - the accepted keyword.
 * @returns the keyword to send upstream, unchanged when it already fits.
 */
function searchKeyword(keyword) {
  let bytes = 0
  let wire = ''
  for (const character of keyword) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > SEARCH_KEYWORD_MAX_BYTES) break
    bytes += size
    wire += character
  }
  return wire
}

/**
 * Parse the search endpoint's `v_hint` receipt.
 *
 * @param body - the decoded search text.
 * @returns one entry per match, or an empty list for the upstream "no match" marker.
 */
function parseHint(body) {
  const match = HINT_PATTERN.exec(body)
  if (match === null) throw invalidResponse('The search response does not match the endpoint contract.')
  const value = match[1]
  if (value === 'N') return []
  const entries = []
  for (const segment of value.split('^')) {
    const parts = segment.split('~')
    if (parts.length < 4) throw invalidResponse('The search response does not match the endpoint contract.')
    entries.push(parts)
  }
  return entries
}

/**
 * Keep one search entry only when its market and security type are served.
 *
 * @param parts - the entry's `~`-separated fields.
 * @returns the model-facing item, or null when it is filtered out.
 */
function searchItem(parts) {
  const market = parts[0]
  const allowed = SEARCH_ALLOWED_TYPES[market]
  if (allowed === undefined || !allowed.has(parts.length > 4 ? parts[4] : '')) return null
  let parsed
  try {
    parsed = parseCode(`${market}${parts[1]}`, { usSuffix: market === 'us' ? 'require' : 'keep' })
  } catch {
    return null
  }
  return {
    market,
    code: parsed.code,
    name: unescapeHint(parts[2]),
    pinyin: unescapeHint(parts[3]),
    type: parts.length > 4 ? parts[4] : '',
  }
}

// ── quote fields ────────────────────────────────────────────────────────────

/**
 * Read the five-level order book, or null when both sides are all zero, which
 * is how the endpoint renders an index or a security without a book.
 *
 * @param fields - the quote's fields.
 * @returns the bid and ask sides, or null.
 */
function orderBook(fields) {
  const sides = []
  let allZero = true
  for (const base of [9, 19]) {
    const side = []
    for (let step = 0; step < 5; step++) {
      const price = nonNegative(optionalNumber(fields[base + 2 * step], 'order book'), 'order book') ?? 0
      const volume = nonNegative(optionalNumber(fields[base + 2 * step + 1], 'order book'), 'order book') ?? 0
      if (price !== 0 || volume !== 0) allZero = false
      side.push({ price, volume })
    }
    sides.push(side)
  }
  return allZero ? null : { bids: sides[0], asks: sides[1] }
}

/**
 * Normalize one quote timestamp into its market's zone.
 *
 * @param market - the parsed code's market.
 * @param value - the raw timestamp field.
 * @returns the offset-bearing timestamp, or null when upstream omitted it.
 */
function asOf(market, value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalidResponse('A quote timestamp field does not match the endpoint contract.')
  const pattern = market === 'us' ? US_TIME_PATTERN : market === 'hk' ? HK_TIME_PATTERN : CN_TIME_PATTERN
  const match = pattern.exec(value)
  if (match === null) throw invalidResponse('A quote timestamp field does not match the endpoint contract.')
  return zonedTimestamp(wallClockFields(match), MARKET_TIMEZONE[market])
}

/**
 * Whether a market is one of the three mainland exchanges, which alone report
 * amounts in ten-thousand yuan, carry valuation fields, and publish a book.
 *
 * @param market - the parsed code's market.
 * @returns whether the market is a mainland exchange.
 */
function isMainland(market) {
  return market === 'sh' || market === 'sz' || market === 'bj'
}

/**
 * Map one quote's fields onto the model-facing item. Fields a market does not
 * carry are omitted, and fields upstream left empty become null.
 *
 * @param parsed - the normalized code.
 * @param fields - the quote's raw fields.
 * @returns the model-facing item.
 */
function quoteItem(parsed, fields) {
  const market = parsed.market
  if (fields.length < QUOTE_MIN_FIELDS[market]) {
    throw invalidResponse('A quote carries fewer fields than the endpoint contract requires.')
  }
  const optional = index => optionalNumber(fields[index], `[${index}]`)
  const safe = index => nonNegative(optional(index), `[${index}]`)
  let amount = safe(QUOTE_AMOUNT_INDEX[market])
  // Shanghai, Shenzhen, and Beijing report the amount in ten-thousand yuan.
  if (amount !== null && isMainland(market)) amount *= 10_000
  const item = {
    code: parsed.code,
    symbol: text(fields[2]),
    name: text(fields[1]),
    type: text(fields[QUOTE_TYPE_INDEX[market]]),
    price: safe(3),
    prev_close: safe(4),
    open: safe(5),
    high: safe(33),
    low: safe(34),
    change: optional(31),
    change_pct: optional(32),
    volume: safe(6),
    volume_unit: market === 'hk' || market === 'us' ? 'share' : 'lot',
    amount,
    amplitude: safe(43),
  }
  if (market === 'us') item.turnover_rate = optional(38)
  if (isMainland(market)) {
    item.turnover_rate = optional(38)
    item.pe_ttm = optional(39)
    item.pb = optional(46)
    item.limit_up = limitPrice(fields[47], '[47]')
    item.limit_down = limitPrice(fields[48], '[48]')
  }
  item.market_cap = safe(45)
  item.float_market_cap = safe(44)
  if (market === 'hk' || market === 'us') {
    item.name_en = text(fields[46])
    item.high_52w = safe(48)
    item.low_52w = safe(49)
  }
  item.currency = text(fields[QUOTE_CURRENCY_INDEX[market]])
  if (isMainland(market)) {
    const book = orderBook(fields)
    if (book !== null) {
      item.bids = book.bids
      item.asks = book.asks
    }
  }
  item.as_of = asOf(market, fields[30])
  item.timezone = MARKET_TIMEZONE[market]
  return item
}

// ── daily bars and intraday rows ────────────────────────────────────────────

/**
 * Coerce one daily-bar row.
 *
 * The market's current-day bar is exempt from the open/close envelope check:
 * it may not have closed yet, and upstream's snapshot occasionally publishes a
 * high or low that the latest trade has not caught up with.
 *
 * @param row - the raw row.
 * @param options - whether the row's amount is in ten-thousand yuan, and the market's current date.
 * @returns the model-facing bar.
 */
function klineBar(row, options) {
  if (!Array.isArray(row) || row.length < 6) throw invalidResponse('A daily-bar row does not match the endpoint contract.')
  const date = row[0]
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) {
    throw invalidResponse('A daily-bar date does not match the endpoint contract.')
  }
  const probe = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== date) {
    throw invalidResponse('A daily-bar date is not a real calendar date.')
  }
  const open = nonNegative(number(row[1], 'open'), 'open')
  const close = nonNegative(number(row[2], 'close'), 'close')
  const high = nonNegative(number(row[3], 'high'), 'high')
  const low = nonNegative(number(row[4], 'low'), 'low')
  const volume = nonNegative(number(row[5], 'volume'), 'volume')
  if (low > high) throw invalidResponse('A daily bar has a low above its high, outside the endpoint contract.')
  if (date !== options.today && !(low <= open && open <= high && low <= close && close <= high)) {
    throw invalidResponse('A daily bar has an open or close outside its high and low, outside the endpoint contract.')
  }
  const bar = { date, open, close, high, low, volume }
  if (options.amountWan) {
    if (row.length < 9) throw invalidResponse('A daily-bar row does not match the endpoint contract.')
    const amount = nonNegative(number(row[8], 'amount'), 'amount')
    if (amount !== null) bar.amount = amount * 10_000
  }
  return bar
}

/**
 * Pick the response key holding the requested adjustment. Beijing returns
 * whichever key it has, so the actual adjustment is read back from the key.
 *
 * @param node - the response node for the requested code.
 * @param market - the parsed code's market.
 * @param adjust - the resolved adjustment.
 * @returns the raw rows and the key they came from.
 */
function klineRows(node, market, adjust) {
  if (market === 'bj') {
    for (const key of KLINE_KEYS) {
      if (Array.isArray(node[key])) return { rows: node[key], key }
    }
    throw invalidResponse('The daily-bar response is missing the data key the endpoint contract requires.')
  }
  const key = KLINE_KEY_BY_ADJUST[adjust]
  const rows = node[key]
  if (!Array.isArray(rows)) {
    throw invalidResponse('The daily-bar response is missing the data key the endpoint contract requires.')
  }
  return { rows, key }
}

/**
 * Require strictly increasing keys across a returned bar series.
 *
 * @param bars - the coerced bars, in upstream order.
 * @param field - the field carrying the ordering key.
 * @param message - what an out-of-order series violates.
 */
function checkBarOrder(bars, field, message) {
  for (let index = 1; index < bars.length; index++) {
    if (bars[index][field] <= bars[index - 1][field]) throw invalidResponse(message)
  }
}

/**
 * Read a Hong Kong security's traded currency from the response's embedded
 * quote block. The 9xxx range holds both ordinary and USD counters, so the
 * prefix cannot decide; a present-but-malformed block is rejected rather than
 * guessed, which would silently mislabel a USD counter as HKD.
 *
 * @param node - the response node for the requested code.
 * @param wire - the requested code.
 * @returns the currency.
 */
function hkCurrency(node, wire) {
  if (node.qt === undefined) return wire.slice(2).startsWith('8') ? 'CNY' : 'HKD'
  const quote = isRecord(node.qt) ? node.qt[wire] : undefined
  if (!Array.isArray(quote) || quote.length <= 75) {
    throw invalidResponse('The currency field of the embedded quote does not match the endpoint contract.')
  }
  const value = quote[75]
  if (typeof value !== 'string' || !['HKD', 'CNY', 'USD'].includes(value)) {
    throw invalidResponse('The currency field of the embedded quote is outside the endpoint contract.')
  }
  return value
}

/**
 * Whether an intraday row's price and cumulative volume are both zero, which
 * is how the US endpoint renders an unknown code.
 *
 * @param raw - the raw row.
 * @returns whether the row is all zero.
 */
function isZeroRow(raw) {
  const parts = raw.trim().split(WHITESPACE_PATTERN)
  if (parts.length < 3) return false
  const price = Number(parts[1])
  const volume = Number(parts[2])
  return Number.isFinite(price) && Number.isFinite(volume) && price === 0 && volume === 0
}

/**
 * Normalize the intraday series date.
 *
 * @param value - the raw date.
 * @returns the date as `YYYY-MM-DD`.
 */
function minuteDate(value) {
  const match = typeof value === 'string' ? MINUTE_DATE_PATTERN.exec(value) : null
  if (match === null) throw invalidResponse('The intraday date does not match the endpoint contract.')
  const [, year, month, day] = match
  const probe = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    throw invalidResponse('The intraday date is not a real calendar date.')
  }
  return `${year}-${month}-${day}`
}

/**
 * Coerce the intraday rows, requiring increasing times and non-decreasing
 * cumulative readings.
 *
 * The newest row alone may restate the cumulative amount below the row before
 * it: while upstream is still finalizing a session its latest row carries the
 * settled total, which can sit below the running total the earlier rows hold.
 *
 * @param rows - the raw rows.
 * @returns the model-facing rows and whether the newest row restated the amount.
 */
function minuteRows(rows) {
  const result = []
  let previousTime = null
  let previousVolume = 0
  let previousAmount = 0
  let restated = false
  for (const [index, raw] of rows.entries()) {
    const parts = raw.trim().split(WHITESPACE_PATTERN)
    if (parts.length !== 3 && parts.length !== 4) {
      throw invalidResponse('An intraday row does not match the endpoint contract.')
    }
    const time = parts[0]
    if (!/^[0-9]{4}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(2)) > 59) {
      throw invalidResponse('An intraday time does not match the endpoint contract.')
    }
    if (previousTime !== null && time <= previousTime) {
      throw invalidResponse('The intraday times are not in the order the endpoint contract requires.')
    }
    const price = number(parts[1], 'price')
    const volume = number(parts[2], 'volume')
    if (price < 0 || volume < 0) {
      throw invalidResponse('An intraday price or cumulative volume is negative, outside the endpoint contract.')
    }
    if (volume < previousVolume) {
      throw invalidResponse('An intraday cumulative volume decreases, outside the endpoint contract.')
    }
    const row = { time, price, volume_cum: volume }
    if (parts.length === 4) {
      const amount = number(parts[3], 'amount')
      if (amount < 0) throw invalidResponse('An intraday cumulative amount is negative, outside the endpoint contract.')
      if (amount < previousAmount) {
        if (index !== rows.length - 1) {
          throw invalidResponse('An intraday cumulative amount decreases, outside the endpoint contract.')
        }
        restated = true
      }
      row.amount_cum = amount
      previousAmount = amount
    }
    result.push(row)
    previousTime = time
    previousVolume = volume
  }
  return { rows: result, restated }
}

// ── minute bars ─────────────────────────────────────────────────────────────

/**
 * Normalize a minute-bar timestamp.
 *
 * @param value - the raw `YYYYMMDDHHMM` field.
 * @returns the timestamp as `YYYY-MM-DD HH:MM`.
 */
function barTime(value) {
  const match = typeof value === 'string' ? BAR_TIME_PATTERN.exec(value) : null
  if (match === null) throw invalidResponse('A minute-bar time does not match the endpoint contract.')
  const [, year, month, day, hour, minute] = match
  if (Number(hour) > 23 || Number(minute) > 59) {
    throw invalidResponse('A minute-bar time is outside the clock range the endpoint contract allows.')
  }
  const probe = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    throw invalidResponse('A minute-bar time is not a real calendar date.')
  }
  return `${year}-${month}-${day} ${hour}:${minute}`
}

/**
 * Coerce one minute bar.
 *
 * The market's current date is exempt from the open/close envelope check: a bar
 * still forming can carry a high or low the latest print has not reached. The
 * eighth field is a placeholder object for these markets and is not read.
 *
 * @param row - the raw row.
 * @param today - the market's current date.
 * @returns the model-facing bar.
 */
function minuteBar(row, today) {
  if (!Array.isArray(row) || row.length < 8) throw invalidResponse('A minute bar does not match the endpoint contract.')
  const time = barTime(row[0])
  const open = nonNegative(number(row[1], 'open'), 'open')
  const close = nonNegative(number(row[2], 'close'), 'close')
  const high = nonNegative(number(row[3], 'high'), 'high')
  const low = nonNegative(number(row[4], 'low'), 'low')
  const volume = nonNegative(number(row[5], 'volume'), 'volume')
  if (low > high) throw invalidResponse('A minute bar has a low above its high, outside the endpoint contract.')
  if (!time.startsWith(today) && !(low <= open && open <= high && low <= close && close <= high)) {
    throw invalidResponse('A minute bar has an open or close outside its high and low, outside the endpoint contract.')
  }
  const turnover = nonNegative(optionalNumber(row[7], 'turnover'), 'turnover')
  return {
    time,
    open,
    close,
    high,
    low,
    volume,
    turnover_rate_pct: turnover === null ? null : turnover / 100,
  }
}

// ── multi-day intraday ──────────────────────────────────────────────────────

/**
 * Coerce one day of the multi-day intraday response.
 *
 * @param entry - the raw day entry.
 * @returns the day's date, previous close, series, and whether its newest row restated the amount.
 */
function intradayDay(entry) {
  if (!isRecord(entry)) throw invalidResponse('A multi-day intraday entry does not match the endpoint contract.')
  const date = minuteDate(entry.date)
  const rawRows = entry.data
  if (!Array.isArray(rawRows) || rawRows.some(row => typeof row !== 'string')) {
    throw invalidResponse('A multi-day intraday entry does not match the endpoint contract.')
  }
  const prevClose = jsonOptionalNumber(entry.prec, 'prec')
  const series = minuteRows(rawRows)
  return { date, prevClose, rows: series.rows, restated: series.restated }
}

/**
 * Render one day of the multi-day intraday response as the model-facing day.
 *
 * @param entry - the raw day entry.
 * @param detail - `rows` keeps the series; anything else keeps the session's aggregates.
 * @returns the model-facing day.
 */
function minuteHistoryDay(entry, detail) {
  const { date, prevClose, rows } = intradayDay(entry)
  if (detail === 'rows') return { date, prev_close: prevClose, rows }
  const first = rows[0]
  const last = rows[rows.length - 1]
  let high = null
  let low = null
  for (const row of rows) {
    if (high === null || row.price > high) high = row.price
    if (low === null || row.price < low) low = row.price
  }
  const day = {
    date,
    prev_close: prevClose,
    open: first === undefined ? null : first.price,
    high,
    low,
    close: last === undefined ? null : last.price,
    volume_cum: last === undefined ? null : last.volume_cum,
  }
  if (last !== undefined && last.amount_cum !== undefined) day.amount_cum = last.amount_cum
  return day
}

// ── money flow ──────────────────────────────────────────────────────────────

/**
 * Normalize a money-flow timestamp.
 *
 * @param value - the raw `YYYY-MM-DD HH:MM` field.
 * @returns the timestamp as `YYYY-MM-DD HH:MM`.
 */
function flowTime(value) {
  const match = typeof value === 'string' ? FLOW_TIME_PATTERN.exec(value.trim()) : null
  if (match === null) throw invalidResponse('A money-flow timestamp does not match the endpoint contract.')
  const date = dateOnly(match[1], 'time')
  if (Number(match[2]) > 23 || Number(match[3]) > 59) {
    throw invalidResponse('A money-flow timestamp is outside the clock range the endpoint contract allows.')
  }
  return `${date} ${match[2]}:${match[3]}`
}

/** Column names of a money-flow row's five net amounts, in upstream order. */
const FLOW_NET_FIELDS = ['main_net', 'small_net', 'medium_net', 'large_net', 'xlarge_net']

/** Column names of a daily money-flow row's five net-share percentages, in upstream order. */
const FLOW_PCT_FIELDS = ['main_net_pct', 'small_net_pct', 'medium_net_pct', 'large_net_pct', 'xlarge_net_pct']

/**
 * Coerce one money-flow row. The daily series adds the five net-share
 * percentages, the close, and that day's change; the same-day series carries
 * the five net amounts alone. The two trailing daily columns are upstream
 * placeholders and are not read.
 *
 * @param raw - the raw comma-separated row.
 * @param range - `intraday` or `daily`.
 * @returns the model-facing row.
 */
function flowRow(raw, range) {
  if (typeof raw !== 'string') throw invalidResponse('A money-flow row does not match the endpoint contract.')
  const parts = raw.split(',')
  if (parts.length < (range === 'intraday' ? 6 : 15)) {
    throw invalidResponse('A money-flow row carries fewer fields than the endpoint contract requires.')
  }
  const row = range === 'intraday' ? { time: flowTime(parts[0]) } : { date: dateOnly(parts[0], 'date') }
  for (const [index, name] of FLOW_NET_FIELDS.entries()) row[name] = jsonNumber(parts[index + 1], name)
  if (range === 'daily') {
    for (const [index, name] of FLOW_PCT_FIELDS.entries()) row[name] = jsonOptionalNumber(parts[index + 6], name)
    row.close = jsonOptionalNumber(parts[11], 'close')
    row.change_pct = jsonOptionalNumber(parts[12], 'change_pct')
  }
  return row
}

// ── fundamentals ────────────────────────────────────────────────────────────

/**
 * Coerce one report period. Income and profit arrive in yuan, the ratios in
 * percent.
 *
 * @param row - the raw report row.
 * @returns the model-facing period.
 */
function fundamentalPeriod(row) {
  if (!isRecord(row)) throw invalidResponse('A fundamentals row does not match the endpoint contract.')
  const reportDate = dateOnly(row.REPORTDATE, 'REPORTDATE')
  if (reportDate === null) throw invalidResponse('A fundamentals row is missing its report date.')
  return {
    report_date: reportDate,
    report_name: text(row.QDATE, MARKET_TEXT_MESSAGE),
    revenue: jsonOptionalNumber(row.TOTAL_OPERATE_INCOME, 'TOTAL_OPERATE_INCOME'),
    revenue_yoy_pct: jsonOptionalNumber(row.YSTZ, 'YSTZ'),
    net_profit: jsonOptionalNumber(row.PARENT_NETPROFIT, 'PARENT_NETPROFIT'),
    net_profit_yoy_pct: jsonOptionalNumber(row.SJLTZ, 'SJLTZ'),
    basic_eps: jsonOptionalNumber(row.BASIC_EPS, 'BASIC_EPS'),
    deducted_eps: jsonOptionalNumber(row.DEDUCT_BASIC_EPS, 'DEDUCT_BASIC_EPS'),
    roe_weighted_pct: jsonOptionalNumber(row.WEIGHTAVG_ROE, 'WEIGHTAVG_ROE'),
    gross_margin_pct: jsonOptionalNumber(row.XSMLL, 'XSMLL'),
    bps: jsonOptionalNumber(row.BPS, 'BPS'),
    ocf_per_share: jsonOptionalNumber(row.MGJYXJJE, 'MGJYXJJE'),
    industry: text(row.BOARD_NAME, MARKET_TEXT_MESSAGE),
    notice_date: dateOnly(row.NOTICE_DATE, 'NOTICE_DATE'),
  }
}

/**
 * Coerce one news item. Its time is Beijing wall-clock time, which the item
 * states as `YYYY-MM-DD HH:MM:SS`, and is reported with that offset.
 *
 * @param row - the raw news row.
 * @returns the model-facing item.
 */
function newsItem(row) {
  if (!isRecord(row)) throw invalidResponse(NEWS_TEXT_MESSAGE)
  const id = text(row.id, NEWS_TEXT_MESSAGE)
  const title = text(row.title, NEWS_TEXT_MESSAGE)
  if (id === null || title === null) throw invalidResponse('A news item is missing its id or title.')
  const time = text(row.time, NEWS_TEXT_MESSAGE)
  const match = time === null ? null : NEWS_TIME_PATTERN.exec(time)
  if (match === null) throw invalidResponse('A news item does not carry a readable time.')
  return {
    id,
    published_at: `${match[1]}T${match[2]}+08:00`,
    title,
    publisher: text(row.src, NEWS_TEXT_MESSAGE),
    url: text(row.url, NEWS_TEXT_MESSAGE),
    summary: text(row.summary, NEWS_TEXT_MESSAGE),
  }
}

/**
 * Coerce one macro row for one indicator, whose catalog entry names the fields
 * that row carries.
 *
 * @param indicator - the catalog key of the report.
 * @param row - the raw report row.
 * @returns the model-facing row.
 */
function macroRow(indicator, row) {
  if (!isRecord(row)) throw invalidResponse('A macro row does not match the endpoint contract.')
  const period = text(row[MACRO_PERIOD_FIELD], MACRO_TEXT_MESSAGE)
  if (period === null) throw invalidResponse('A macro row is missing its period.')
  const values = {}
  for (const [name, field] of MACRO_CATALOG[indicator].fields) values[name] = jsonOptionalNumber(row[field], field)
  return { period, ...values }
}

// ── market overview and rankings ────────────────────────────────────────────

/**
 * Coerce one market-overview row. Every field carries a {@link MARKET_INDEXES}
 * secid, so a row outside that closed set is a contract violation.
 *
 * @param row - the raw snapshot-list row.
 * @returns the model-facing index.
 */
function marketIndexItem(row) {
  if (!isRecord(row)) throw invalidResponse('A market-overview row does not match the endpoint contract.')
  const code = MARKET_INDEX_CODES.get(`${jsonNumber(row.f13, 'f13')}.${text(row.f12, MARKET_TEXT_MESSAGE)}`)
  if (code === undefined) throw invalidResponse('The market overview returned an index outside the requested set.')
  return {
    code,
    name: text(row.f14, MARKET_TEXT_MESSAGE),
    price: jsonOptionalNumber(row.f2, 'f2'),
    change: jsonOptionalNumber(row.f4, 'f4'),
    change_pct: jsonOptionalNumber(row.f3, 'f3'),
    open: jsonOptionalNumber(row.f17, 'f17'),
    high: jsonOptionalNumber(row.f15, 'f15'),
    low: jsonOptionalNumber(row.f16, 'f16'),
    prev_close: jsonOptionalNumber(row.f18, 'f18'),
    volume: jsonOptionalNumber(row.f5, 'f5'),
    amount: jsonOptionalNumber(row.f6, 'f6'),
    advancers: jsonOptionalNumber(row.f104, 'f104'),
    decliners: jsonOptionalNumber(row.f105, 'f105'),
    unchanged: jsonOptionalNumber(row.f106, 'f106'),
  }
}

/**
 * Split a ranked sector's advance and decline counts.
 *
 * @param value - the raw `advancers/decliners` field.
 * @returns the two counts, both null when the field is absent or malformed.
 */
function sectorCounts(value) {
  if (typeof value !== 'string') return [null, null]
  const match = SECTOR_COUNTS_PATTERN.exec(value.trim())
  if (match === null) return [null, null]
  return [Number(match[1]), Number(match[2])]
}

/**
 * Coerce a ranked sector's leading security.
 *
 * @param value - the raw `lzg` field.
 * @returns the leading security, or null when the field is absent.
 */
function sectorLeader(value) {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw invalidResponse('A ranking leader field does not match the endpoint contract.')
  return {
    code: text(value.code, RANK_TEXT_MESSAGE),
    name: text(value.name, RANK_TEXT_MESSAGE),
    change_pct: jsonOptionalNumber(value.zdf, 'zdf'),
  }
}

/**
 * Coerce one ranked sector board. Amounts arrive in ten thousand yuan, market
 * capitalizations in one hundred million yuan, and volumes in lots.
 *
 * @param row - the raw ranking row.
 * @returns the model-facing board.
 */
function sectorRankRow(row) {
  if (!isRecord(row)) throw invalidResponse('A ranking row does not match the endpoint contract.')
  const [advancers, decliners] = sectorCounts(row.zgb)
  return {
    board_code: text(row.code, RANK_TEXT_MESSAGE),
    name: text(row.name, RANK_TEXT_MESSAGE),
    price: jsonOptionalNumber(row.zxj, 'zxj'),
    change: jsonOptionalNumber(row.zd, 'zd'),
    change_pct: jsonOptionalNumber(row.zdf, 'zdf'),
    turnover_wan: jsonOptionalNumber(row.turnover, 'turnover'),
    volume_lot: jsonOptionalNumber(row.volume, 'volume'),
    turnover_rate_pct: jsonOptionalNumber(row.hsl, 'hsl'),
    volume_ratio: jsonOptionalNumber(row.lb, 'lb'),
    market_cap_yi: jsonOptionalNumber(row.zsz, 'zsz'),
    float_market_cap_yi: jsonOptionalNumber(row.ltsz, 'ltsz'),
    main_net_inflow_wan: jsonOptionalNumber(row.zljlr, 'zljlr'),
    main_net_inflow_5d_wan: jsonOptionalNumber(row.zljlr_d5, 'zljlr_d5'),
    main_net_inflow_20d_wan: jsonOptionalNumber(row.zljlr_d20, 'zljlr_d20'),
    main_inflow_wan: jsonOptionalNumber(row.zllr, 'zllr'),
    main_outflow_wan: jsonOptionalNumber(row.zllc, 'zllc'),
    change_pct_5d: jsonOptionalNumber(row.zdf_d5, 'zdf_d5'),
    change_pct_20d: jsonOptionalNumber(row.zdf_d20, 'zdf_d20'),
    change_pct_60d: jsonOptionalNumber(row.zdf_d60, 'zdf_d60'),
    advancers,
    decliners,
    leader: sectorLeader(row.lzg),
  }
}

/**
 * Coerce one ranked security. Amounts arrive in ten thousand yuan, market
 * capitalizations in one hundred million yuan, and volumes in lots.
 *
 * @param row - the raw ranking row.
 * @returns the model-facing security.
 */
function stockRankRow(row) {
  if (!isRecord(row)) throw invalidResponse('A ranking row does not match the endpoint contract.')
  return {
    code: text(row.code, RANK_TEXT_MESSAGE),
    name: text(row.name, RANK_TEXT_MESSAGE),
    price: jsonOptionalNumber(row.zxj, 'zxj'),
    change: jsonOptionalNumber(row.zd, 'zd'),
    change_pct: jsonOptionalNumber(row.zdf, 'zdf'),
    amplitude_pct: jsonOptionalNumber(row.zf, 'zf'),
    turnover_wan: jsonOptionalNumber(row.turnover, 'turnover'),
    volume_lot: jsonOptionalNumber(row.volume, 'volume'),
    turnover_rate_pct: jsonOptionalNumber(row.hsl, 'hsl'),
    volume_ratio: jsonOptionalNumber(row.lb, 'lb'),
    pe_ttm: jsonOptionalNumber(row.pe_ttm, 'pe_ttm'),
    pb: jsonOptionalNumber(row.pn, 'pn'),
    market_cap_yi: jsonOptionalNumber(row.zsz, 'zsz'),
    float_market_cap_yi: jsonOptionalNumber(row.ltsz, 'ltsz'),
    main_net_inflow_wan: jsonOptionalNumber(row.zljlr, 'zljlr'),
    main_inflow_wan: jsonOptionalNumber(row.zllr, 'zllr'),
    main_outflow_wan: jsonOptionalNumber(row.zllc, 'zllc'),
    change_pct_5d: jsonOptionalNumber(row.zdf_d5, 'zdf_d5'),
    change_pct_10d: jsonOptionalNumber(row.zdf_d10, 'zdf_d10'),
    change_pct_20d: jsonOptionalNumber(row.zdf_d20, 'zdf_d20'),
    change_pct_60d: jsonOptionalNumber(row.zdf_d60, 'zdf_d60'),
    change_pct_52w: jsonOptionalNumber(row.zdf_w52, 'zdf_w52'),
    change_pct_ytd: jsonOptionalNumber(row.zdf_y, 'zdf_y'),
  }
}

// ── code normalization ──────────────────────────────────────────────────────

/**
 * Normalize a code into its request form, market, and index flag.
 *
 * @param value - the caller's code.
 * @param options - how a US exchange suffix is treated: `strip` removes a known one,
 *   `require` demands one, and `keep` preserves whatever was given.
 * @returns the normalized code.
 */
function parseCode(value, options = {}) {
  const usSuffix = options.usSuffix ?? 'strip'
  if (typeof value !== 'string' || value === '') throw new UsageError('A code must be a non-empty string.')
  const cn = CN_CODE_PATTERN.exec(value)
  if (cn !== null) {
    const prefix = cn[1].toLowerCase()
    const digits = cn[2]
    if (prefix === 'bj') {
      if (BJ_LEGACY_CODE_PATTERN.test(digits)) {
        throw new UsageError('Beijing exchange codes were renumbered; use the current 920 stock codes and 899 index codes (official mapping: https://www.bse.cn/service/code_mapping.html).')
      }
      if (!BJ_CURRENT_CODE_PATTERN.test(digits)) {
        throw new UsageError('Beijing accepts only the current 920 stock codes and 899 index codes.')
      }
      return { code: `bj${digits}`, market: 'bj', isIndex: digits.startsWith('899') }
    }
    const isIndex = prefix === 'sh' ? digits.startsWith('000') : digits.startsWith('399')
    return { code: `${prefix}${digits}`, market: prefix, isIndex }
  }
  const hk = HK_CODE_PATTERN.exec(value)
  if (hk !== null) return { code: `hk${hk[1].padStart(5, '0')}`, market: 'hk', isIndex: false }
  const us = US_CODE_PATTERN.exec(value)
  if (us !== null) {
    let body = us[1].toUpperCase()
    let suffix = ''
    for (const candidate of US_SUFFIXES) {
      if (body.endsWith(candidate)) {
        suffix = candidate
        body = body.slice(0, -candidate.length)
        break
      }
    }
    if (body === '' || !US_BODY_PATTERN.test(body)) throw new UsageError('A US code has an invalid form.')
    if (usSuffix === 'require') {
      if (suffix === '') {
        throw new UsageError('A US daily bar needs an exchange suffix (for example usAAPL.OQ); get the canonical code from stock_search or stock_quote first.')
      }
      return { code: `us${body}${suffix}`, market: 'us', isIndex: false }
    }
    if (usSuffix === 'keep' && suffix !== '') return { code: `us${body}${suffix}`, market: 'us', isIndex: false }
    return { code: `us${body}`, market: 'us', isIndex: false }
  }
  throw new UsageError(`Unrecognized code: ${value}.`)
}

/**
 * Map a normalized code onto the secid the money-flow endpoints take.
 *
 * @param parsed - the normalized code, whose US form must carry its exchange suffix.
 * @returns the secid.
 */
function emSecid(parsed) {
  if (parsed.market === 'us') {
    const suffix = parsed.code.slice(2).match(/\.[A-Z]+$/)?.[0]
    const prefix = EM_US_SECID_PREFIX[suffix]
    if (prefix === undefined) {
      throw new UsageError(`Money flow is not served for the US exchange suffix ${suffix ?? '(none)'}; use a code ending in .OQ, .N, or .AM.`)
    }
    return `${prefix}.${parsed.code.slice(2, -suffix.length)}`
  }
  return `${EM_SECID_PREFIX[parsed.market]}.${parsed.code.slice(2).padStart(parsed.market === 'hk' ? 5 : 6, '0')}`
}

/**
 * Map a normalized mainland code onto the `SECUCODE` the report endpoints take.
 *
 * @param parsed - the normalized code, which must be a mainland listing.
 * @returns the `SECUCODE`.
 */
function emSecucode(parsed) {
  return `${parsed.code.slice(2)}.${EM_SECUCODE_SUFFIX[parsed.market]}`
}

/**
 * Resolve the requested adjustment against what the market supports.
 *
 * @param parsed - the normalized code.
 * @param adjust - the caller's request.
 * @returns `qfq`, `hfq`, or `none`.
 */
function resolveAdjust(parsed, adjust) {
  if (parsed.market === 'us') {
    if (adjust !== 'auto' && adjust !== 'qfq') throw new UsageError('US daily bars are available only as qfq.')
    return 'qfq'
  }
  if (parsed.isIndex) {
    if (adjust !== 'auto' && adjust !== 'none') throw new UsageError('An index supports only the none adjustment.')
    return 'none'
  }
  if (!ADJUST_MODES.includes(adjust)) {
    throw new UsageError(`${parsed.code} does not support the adjustment ${adjust}.`)
  }
  return adjust === 'auto' ? 'qfq' : adjust
}

// ── request whitelist ───────────────────────────────────────────────────────

/**
 * Whether a ranking request carries the closed parameter set its board takes.
 *
 * @param path - the ranking path, which decides the board parameter's name.
 * @param params - the request's query parameters.
 * @returns whether the request is the one form that path serves.
 */
function rankParamsAllowed(path, params) {
  const keys = Object.keys(params)
  const boardKey = path === SECTOR_RANK_PATH ? 'board_type' : 'board_code'
  if (keys.length !== RANK_PARAM_KEYS.length + 1) return false
  if (!keys.includes(boardKey) || !RANK_PARAM_KEYS.every(key => keys.includes(key))) return false
  const boards = path === SECTOR_RANK_PATH ? SECTOR_BOARDS : STOCK_BOARDS
  if (!Object.hasOwn(boards, params[boardKey])) return false
  if (!Object.values(RANK_SORT_TOKENS).includes(params.sort_type)) return false
  if (!Object.values(RANK_ORDER_TOKENS).includes(params.direct)) return false
  return /^[0-9]{1,4}$/.test(params.offset) && /^[0-9]{1,3}$/.test(params.count)
}

/**
 * Whether a snapshot-list request is the one form this plugin issues: the
 * closed market index set with the fields the overview reports.
 *
 * @param params - the request's query parameters.
 * @returns whether the request is in the whitelist.
 */
function ulistParamsAllowed(params) {
  const keys = Object.keys(params)
  if (keys.length !== 3 || !['fltt', 'secids', 'fields'].every(key => keys.includes(key))) return false
  if (params.fltt !== '2' || params.fields !== EM_INDEX_FIELDS) return false
  return params.secids === MARKET_INDEX_SECIDS.join(',')
}

/**
 * Whether a money-flow request carries the closed parameter set of its path.
 *
 * @param params - the request's query parameters.
 * @param klt - the sampling the path serves: `1` for the same day, `101` per day.
 * @returns whether the request is in the whitelist.
 */
function flowParamsAllowed(params, klt) {
  const expected = ['lmt', 'klt', 'secid', 'fields1', 'fields2']
  const keys = Object.keys(params)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) return false
  if (params.lmt !== '0' || params.klt !== klt) return false
  if (params.fields1 !== EM_FLOW_KLINE_FIELDS1 || params.fields2 !== EM_FLOW_KLINE_FIELDS2) return false
  return SECID_PATTERN.test(params.secid)
}

/**
 * Whether a fundamentals request carries the closed parameter set, including
 * the report filter this plugin builds from a normalized code.
 *
 * @param params - the request's query parameters.
 * @returns whether the request is in the whitelist.
 */
function fundamentalsParamsAllowed(params) {
  const expected = ['reportName', 'columns', 'filter', 'pageSize', 'sortColumns', 'sortTypes']
  const keys = Object.keys(params)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) return false
  if (params.reportName !== EM_FUNDAMENTAL_REPORT) return false
  if (params.columns !== EM_FUNDAMENTAL_COLUMNS) return false
  if (!EM_FILTER_PATTERN.test(params.filter)) return false
  if (params.sortColumns !== 'REPORTDATE' || params.sortTypes !== '-1') return false
  const size = Number(params.pageSize)
  return /^[0-9]{1,2}$/.test(params.pageSize) && size >= 1 && size <= 50
}

/**
 * Whether a macro request carries the closed parameter set for one catalog
 * report: the report itself, the newest periods first, and nothing else.
 *
 * @param params - the request's query parameters.
 * @returns whether the request is in the whitelist.
 */
function macroParamsAllowed(params) {
  const expected = ['reportName', 'columns', 'pageNumber', 'pageSize', 'sortColumns', 'sortTypes']
  const keys = Object.keys(params)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) return false
  if (!Object.values(MACRO_CATALOG).some(entry => entry.report === params.reportName)) return false
  if (params.columns !== 'ALL' || params.pageNumber !== '1') return false
  if (params.sortColumns !== 'REPORT_DATE' || params.sortTypes !== '-1') return false
  const size = Number(params.pageSize)
  return /^[0-9]{1,2}$/.test(params.pageSize) && size >= 1 && size <= MACRO_MAX_PERIODS
}

/**
 * Second check of the request whitelist: the method is always GET, and the
 * host, path, parameter keys, and the values this plugin derives must be one of
 * the supported forms.
 *
 * @param host - the request host.
 * @param path - the request path.
 * @param params - the request's query parameters.
 */
function authorize(host, path, params) {
  const keys = Object.keys(params)
  if (host === QT_HOST) {
    if (!path.startsWith(QUOTE_PATH_PREFIX) || keys.length > 0) {
      throw new UsageError('The request is not in the quote endpoint whitelist.')
    }
    if (!CODES_CHARSET_PATTERN.test(path.slice(QUOTE_PATH_PREFIX.length))) {
      throw new UsageError('The request is not in the quote endpoint whitelist.')
    }
    return
  }
  if (host === WEB_HOST) {
    if (KLINE_PATHS.has(path) && keys.length === 1 && keys[0] === 'param') return
    if (path === US_MINUTE_PATH && keys.length === 1 && keys[0] === 'code') return
    if (path === DAY_PATH && keys.length === 1 && keys[0] === 'code') return
  }
  if (host === PROXY_HOST) {
    if (path === MKLINE_PATH && keys.length === 1 && keys[0] === 'param' && MKLINE_PARAM_PATTERN.test(params.param)) return
    if ((path === SECTOR_RANK_PATH || path === STOCK_RANK_PATH) && rankParamsAllowed(path, params)) return
    if (path === NEWS_PATH && keys.length === 1 && keys[0] === 'symbol' && NEWS_SYMBOL_PATTERN.test(params.symbol)) return
  }
  if (host === EM_PUSH_HOST) {
    if (path === EM_ULIST_PATH && ulistParamsAllowed(params)) return
    if (path === EM_FLOW_INTRADAY_PATH && flowParamsAllowed(params, '1')) return
  }
  if (host === EM_HISTORY_HOST && path === EM_FLOW_DAILY_PATH && flowParamsAllowed(params, '101')) return
  if (host === EM_DATA_HOST && path === EM_DATA_PATH && (fundamentalsParamsAllowed(params) || macroParamsAllowed(params))) return
  if (host === SEARCH_HOST && path === SEARCH_PATH && params.t === 'all') {
    const unique = new Set(keys)
    if (unique.size === SEARCH_PARAM_KEYS.size && keys.every(key => SEARCH_PARAM_KEYS.has(key))) return
  }
  throw new UsageError('The request is not in the quote endpoint whitelist.')
}

// ── client ──────────────────────────────────────────────────────────────────

/** Resolve after `ms` milliseconds, or reject as soon as `signal` aborts. */
function sleep(ms, signal) {
  if (signal === undefined || signal === null) {
    return new Promise(resolve => { setTimeout(resolve, ms) })
  }
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One process-local Tencent client. All four queries share its serialization
 * chain, so concurrent tool calls cannot exceed the pacing the public endpoints
 * tolerate. Backoff is kept per upstream host: a host that fails or refuses
 * requests stops only itself, so the unreliability of one endpoint family
 * cannot take the other vendors' endpoints down with it.
 */
class StockClient {
  /**
   * @param config - the resolved plugin options.
   */
  constructor(config) {
    this._config = config
    this._tail = Promise.resolve()
    this._lastRequestAt = null
    this._blocks = new Map()
  }

  /**
   * Run one task after every previously queued task settled. Queueing, rather
   * than rejecting, keeps one failed call from cancelling the others.
   *
   * @param task - the request task.
   * @returns the task's outcome.
   */
  _serialize(task) {
    const result = this._tail.then(task, task)
    this._tail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Search securities by name, pinyin, or code.
   *
   * @param keyword - the 1–32 character keyword.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async search(keyword, signal) {
    const accepted = this._checkKeyword(keyword)
    const wire = searchKeyword(accepted)
    try {
      const body = decodeGbk(await this._request(SEARCH_HOST, SEARCH_PATH, { q: wire, t: 'all' }, signal))
      const entries = parseHint(body)
      const items = []
      for (const parts of entries) {
        const item = searchItem(parts)
        if (item !== null) items.push(item)
      }
      const payload = { ok: true, source: 'stock', query: 'search', items, count: items.length }
      const notes = []
      if (wire !== accepted) {
        notes.push(`The search endpoint matches at most ${SEARCH_KEYWORD_MAX_BYTES} bytes of keyword, so "${accepted}" was searched as the prefix "${wire}".`)
      }
      if (entries.length === 0) notes.push(NO_MATCH_NOTE)
      else if (items.length === 0) notes.push(FILTERED_MATCH_NOTE)
      if (notes.length > 0) payload.note = notes.join(' ')
      return payload
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read a batch of quote snapshots. Codes upstream silently omitted are
   * reported as missing; a batch with no item at all fails.
   *
   * @param codes - the caller's codes.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async quote(codes, signal) {
    const parsedList = this._checkQuoteCodes(codes)
    try {
      const wire = parsedList.map(item => item.code).join(',')
      const body = decodeGbk(await this._request(QT_HOST, `${QUOTE_PATH_PREFIX}${wire}`, {}, signal))
      const quotes = parseQuoteText(body)
      const items = []
      const missing = []
      for (const parsed of parsedList) {
        const fields = quotes.get(parsed.code)
        if (fields === undefined) {
          missing.push({ code: parsed.code, reason: 'not_found' })
          continue
        }
        items.push(quoteItem(parsed, fields))
      }
      if (items.length === 0) throw new RequestFailure('not_found', 'Upstream returned no quote for these codes.')
      return {
        ok: true,
        source: 'stock',
        query: 'quote',
        items,
        missing,
        snapshot: this._snapshot(),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read daily bars, keeping the newest `count` of them.
   *
   * @param code - the caller's code.
   * @param count - how many of the newest bars to keep.
   * @param adjust - `auto`, `qfq`, `hfq`, or `none`.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async kline(code, count, adjust, signal) {
    const parsed = parseCode(code, { usSuffix: 'require' })
    const accepted = this._checkCount(count, 'count', this._config.klineMaxCount)
    if (!ADJUST_MODES.includes(adjust)) {
      throw new UsageError('adjust must be auto, qfq, hfq, or none.')
    }
    const resolved = resolveAdjust(parsed, adjust)
    try {
      let path
      let token
      if (parsed.market === 'us') {
        path = USFQ_PATH
        token = 'qfq'
      } else if (parsed.market === 'hk') {
        path = resolved === 'none' ? FQ_PATH : HKFQ_PATH
        token = resolved === 'none' ? '' : resolved
      } else if (parsed.market === 'bj') {
        path = NEWFQ_PATH
        token = resolved === 'none' ? '' : resolved
      } else {
        path = FQ_PATH
        token = resolved === 'none' ? '' : resolved
      }
      const data = await this._ifzq(WEB_HOST, path, { param: `${parsed.code},day,,,${accepted},${token}` }, signal)
      const node = data[parsed.code]
      if (!isRecord(node)) throw invalidResponse('The daily-bar response does not match the endpoint contract.')
      const { rows, key } = klineRows(node, parsed.market, resolved)
      const amountWan = parsed.market === 'bj' || (parsed.market === 'hk' && resolved !== 'none')
      const today = todayInZone(MARKET_TIMEZONE[parsed.market], Date.now())
      let bars = rows.map(row => klineBar(row, { amountWan, today }))
      checkBarOrder(bars, 'date', 'The daily-bar dates are not in the order the endpoint contract requires.')
      bars = bars.slice(-accepted)
      const payload = {
        ok: true,
        source: 'stock',
        query: 'kline',
        code: parsed.code,
        market: parsed.market,
        adjust_requested: adjust,
        adjust_applied: ADJUST_BY_KLINE_KEY[key],
        requested_count: accepted,
        returned_count: bars.length,
        currency: klineCurrency(parsed, node),
        volume_unit: parsed.market === 'hk' || parsed.market === 'us' ? 'share' : 'lot',
        bars,
        snapshot: this._snapshot(),
      }
      const notes = []
      if (parsed.market === 'bj' && payload.adjust_applied !== resolved) {
        notes.push(`Upstream did not apply the requested adjustment: ${resolved} was requested and ${key} data came back.`)
      }
      if (bars.length > 0 && bars[bars.length - 1].date === today) {
        notes.push('The last bar is the market\'s current day and may not have closed or finished settling.')
      }
      if (bars.length === 0) payload.note = EMPTY_BARS_NOTE
      else if (notes.length > 0) payload.note = notes.join(' ')
      return payload
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read the intraday minute series.
   *
   * A Shanghai, Shenzhen, Beijing, or Hong Kong code is read from the
   * multi-day endpoint, whose newest day is the session this tool reports: its
   * single-day sibling answers every request with an anti-bot challenge page,
   * so that path is not in the request whitelist at all. The US series keeps
   * its own single-day endpoint.
   *
   * @param code - the caller's code.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async minute(code, signal) {
    const parsed = parseCode(code)
    try {
      const intraday = parsed.market === 'us'
        ? await this._usIntraday(parsed, signal)
        : await this._newestIntradayDay(parsed, signal)
      const payloadValue = {
        ok: true,
        source: 'stock',
        query: 'minute',
        code: parsed.code,
        market: parsed.market,
        date: intraday.date,
        timezone: MARKET_TIMEZONE[parsed.market],
        currency: minuteCurrency(parsed, intraday.node),
        volume_unit: parsed.market === 'hk' || parsed.market === 'us' ? 'share' : 'lot',
        rows: intraday.rows,
        snapshot: this._snapshot(),
      }
      const notes = []
      if (intraday.restated) {
        notes.push('The newest row restates the day\'s cumulative amount below the row before it; upstream carries the settled total in the row it is still finalizing.')
      }
      if (intraday.date !== todayInZone(MARKET_TIMEZONE[parsed.market], Date.now())) {
        notes.push('The date is the most recent trading day upstream has, which may predate the current date and does not describe today.')
      }
      if (notes.length > 0) payloadValue.note = notes.join(' ')
      return payloadValue
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read a US code's session from its own single-day intraday endpoint.
   *
   * Upstream answers an unknown ticker with a sentinel date and all-zero rows,
   * or with an empty date and one zero row, instead of an absent node.
   *
   * @param parsed - the normalized code.
   * @param signal - caller cancellation.
   * @returns the response node, the date, and the series.
   */
  async _usIntraday(parsed, signal) {
    const data = await this._ifzq(WEB_HOST, US_MINUTE_PATH, { code: parsed.code }, signal)
    const node = data[parsed.code]
    if (!isRecord(node)) throw invalidResponse('The intraday response does not match the endpoint contract.')
    const inner = node.data
    if (!isRecord(inner)) throw invalidResponse('The intraday response does not match the endpoint contract.')
    const rawDate = inner.date
    const rawRows = inner.data
    if (typeof rawDate !== 'string' || !Array.isArray(rawRows) || rawRows.some(row => typeof row !== 'string')) {
      throw invalidResponse('The intraday response does not match the endpoint contract.')
    }
    if (rawDate === '' || (rawRows.length > 0 && rawRows.every(isZeroRow))) {
      throw new RequestFailure('not_found', 'Upstream has no intraday series for this code.')
    }
    const series = minuteRows(rawRows)
    return { node, date: minuteDate(rawDate), rows: series.rows, restated: series.restated }
  }

  /**
   * Read the newest day of the multi-day intraday endpoint.
   *
   * Upstream orders its days newest first and answers a code it does not serve
   * with none, which is the only not-found marker this endpoint carries.
   *
   * @param parsed - the normalized code.
   * @param signal - caller cancellation.
   * @returns the response node, the date, and the series.
   */
  async _newestIntradayDay(parsed, signal) {
    const data = await this._ifzq(WEB_HOST, DAY_PATH, { code: parsed.code }, signal)
    const node = data[parsed.code]
    if (!isRecord(node)) throw invalidResponse('The intraday response does not match the endpoint contract.')
    const rawDays = node.data
    if (!Array.isArray(rawDays)) throw invalidResponse('The intraday response does not match the endpoint contract.')
    if (rawDays.length === 0) throw new RequestFailure('not_found', 'Upstream has no intraday series for this code.')
    const day = intradayDay(rawDays[0])
    return { node, date: day.date, rows: day.rows, restated: day.restated }
  }

  /**
   * Read minute-level bars. Only Shanghai and Shenzhen listings are served.
   *
   * @param code - the caller's code.
   * @param period - one of {@link BAR_PERIODS}.
   * @param count - how many of the newest bars to keep.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async bars(code, period, count, signal) {
    const parsed = parseCode(code)
    if (parsed.market !== 'sh' && parsed.market !== 'sz') {
      throw new UsageError('Minute bars are served for Shanghai and Shenzhen codes only; use stock_minute for the current session of a Hong Kong, US, or Beijing code.')
    }
    if (!BAR_PERIODS.includes(period)) throw new UsageError(`period must be one of ${BAR_PERIODS.join(', ')}.`)
    const accepted = this._checkCount(count, 'count', this._config.barsMaxCount)
    try {
      const data = await this._ifzq(PROXY_HOST, MKLINE_PATH, { param: `${parsed.code},${period},,${accepted}` }, signal)
      const node = data[parsed.code]
      if (!isRecord(node)) throw invalidResponse('The minute-bar response does not match the endpoint contract.')
      const rows = node[period]
      if (!Array.isArray(rows)) {
        throw invalidResponse('The minute-bar response is missing the data key the endpoint contract requires.')
      }
      const today = todayInZone(MARKET_TIMEZONE[parsed.market], Date.now())
      const bars = rows.map(row => minuteBar(row, today))
      checkBarOrder(bars, 'time', 'The minute-bar times are not in the order the endpoint contract requires.')
      const payload = {
        ok: true,
        source: 'stock',
        query: 'bars',
        code: parsed.code,
        market: parsed.market,
        period,
        requested_count: accepted,
        returned_count: bars.length,
        prev_close: jsonOptionalNumber(node.prec, 'prec'),
        volume_unit: 'lot',
        bars,
        snapshot: this._snapshot(),
      }
      const notes = []
      if (bars.length < accepted) notes.push('Upstream returned fewer bars than requested.')
      if (bars.length > 0 && bars[bars.length - 1].time.startsWith(today)) {
        notes.push('The last bar is the market\'s current session and may not have finished forming.')
      }
      if (notes.length > 0) payload.note = notes.join(' ')
      return payload
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read the intraday series of the most recent trading days upstream holds.
   *
   * @param code - the caller's code.
   * @param days - how many of the newest days to return.
   * @param detail - `rows` keeps each day's series; `summary` keeps its aggregates.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async minuteHistory(code, days, detail, signal) {
    const parsed = parseCode(code)
    if (parsed.market === 'us') {
      throw new UsageError('A multi-day intraday series is served for Shanghai, Shenzhen, Beijing, and Hong Kong codes only; use stock_minute for the current session of a US code.')
    }
    try {
      const data = await this._ifzq(WEB_HOST, DAY_PATH, { code: parsed.code }, signal)
      const node = data[parsed.code]
      if (!isRecord(node)) throw invalidResponse('The multi-day intraday response does not match the endpoint contract.')
      const rawDays = node.data
      if (!Array.isArray(rawDays) || rawDays.length === 0) {
        throw new RequestFailure('not_found', 'Upstream has no intraday series for this code.')
      }
      // Upstream orders the days newest first; this tool returns them oldest first.
      const selected = rawDays.slice(0, days).reverse().map(entry => minuteHistoryDay(entry, detail))
      const payload = {
        ok: true,
        source: 'stock',
        query: 'minute_history',
        code: parsed.code,
        market: parsed.market,
        detail,
        timezone: MARKET_TIMEZONE[parsed.market],
        currency: minuteCurrency(parsed, node),
        volume_unit: parsed.market === 'hk' ? 'share' : 'lot',
        days_available: rawDays.length,
        days: selected,
        snapshot: this._snapshot(),
      }
      const newest = selected[selected.length - 1]
      if (newest.date !== todayInZone(MARKET_TIMEZONE[parsed.market], Date.now())) {
        payload.note = 'The newest day is the most recent trading day upstream has, which may predate the current date and does not describe today.'
      }
      return payload
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read one security's money flow: the current session sampled once a minute,
   * or the per-day history.
   *
   * @param code - the caller's code, which must carry a US exchange suffix.
   * @param range - `intraday` or `daily`.
   * @param days - how many of the newest daily rows to keep.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async moneyflow(code, range, days, signal) {
    const parsed = parseCode(code, { usSuffix: 'require' })
    const daily = range === 'daily'
    if (!daily && parsed.market !== 'sh' && parsed.market !== 'sz' && parsed.market !== 'bj') {
      throw new UsageError('The same-day money-flow series is served for Shanghai, Shenzhen, and Beijing codes only; use range=daily for a Hong Kong or US code.')
    }
    const secid = emSecid(parsed)
    try {
      const data = await this._emPush(daily ? EM_HISTORY_HOST : EM_PUSH_HOST, daily ? EM_FLOW_DAILY_PATH : EM_FLOW_INTRADAY_PATH, {
        lmt: '0',
        klt: daily ? '101' : '1',
        secid,
        fields1: EM_FLOW_KLINE_FIELDS1,
        fields2: EM_FLOW_KLINE_FIELDS2,
      }, signal)
      const klines = data.klines
      if (!Array.isArray(klines)) throw invalidResponse('The money-flow response does not match the endpoint contract.')
      const rows = klines.map(raw => flowRow(raw, range))
      if (rows.length === 0) throw new RequestFailure('not_found', 'Upstream has no money flow for this code.')
      return {
        ok: true,
        source: 'stock',
        query: 'moneyflow',
        code: parsed.code,
        market: parsed.market,
        range,
        requested_days: daily ? days : null,
        returned_rows: daily ? Math.min(rows.length, days) : rows.length,
        rows: daily ? rows.slice(-days) : rows,
        snapshot: this._snapshot(),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read the report periods of one mainland listing.
   *
   * @param code - the caller's code, which must be a mainland listing.
   * @param periods - how many of the newest report periods to keep.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async fundamentals(code, periods, signal) {
    const parsed = parseCode(code)
    if (parsed.market === 'hk' || parsed.market === 'us') {
      throw new UsageError('Report-period fundamentals are served for Shanghai, Shenzhen, and Beijing codes only.')
    }
    try {
      const rows = await this._emData(EM_DATA_HOST, EM_DATA_PATH, {
        reportName: EM_FUNDAMENTAL_REPORT,
        columns: EM_FUNDAMENTAL_COLUMNS,
        filter: `(SECUCODE="${emSecucode(parsed)}")`,
        pageSize: String(periods),
        sortColumns: 'REPORTDATE',
        sortTypes: '-1',
      }, signal)
      if (rows.length === 0) throw new RequestFailure('not_found', 'Upstream has no report period for this code.')
      return {
        ok: true,
        source: 'stock',
        query: 'fundamentals',
        code: parsed.code,
        market: parsed.market,
        currency: 'CNY',
        requested_periods: periods,
        returned_periods: rows.length,
        periods: rows.map(row => fundamentalPeriod(row)),
        snapshot: this._snapshot(),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read the newest news items upstream holds for one symbol.
   *
   * @param code - one canonical code.
   * @param limit - how many of the newest items to keep.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async news(code, limit, signal) {
    const parsed = parseCode(code)
    try {
      const data = await this._tencent(PROXY_HOST, NEWS_PATH, { symbol: parsed.code }, signal)
      if (!Array.isArray(data.data)) throw invalidResponse('The news response does not match the endpoint contract.')
      const items = data.data.slice(0, limit).map(row => newsItem(row))
      const payload = {
        ok: true,
        source: 'stock',
        query: 'news',
        code: parsed.code,
        market: parsed.market,
        returned_count: items.length,
        items,
        snapshot: this._snapshot(),
      }
      if (items.length === 0) {
        payload.note = 'Upstream holds no news for this code.'
      } else if (items.length < limit) {
        payload.note = `Upstream holds ${items.length} items for this code, fewer than the requested ${limit}.`
      }
      return payload
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read the newest periods of one macro indicator.
   *
   * @param indicator - one key of {@link MACRO_CATALOG}.
   * @param periods - how many of the newest periods to keep.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async macro(indicator, periods, signal) {
    if (!Object.hasOwn(MACRO_CATALOG, indicator)) {
      throw new UsageError(`indicator must be one of ${Object.keys(MACRO_CATALOG).join(', ')}.`)
    }
    try {
      const rows = await this._emData(EM_DATA_HOST, EM_DATA_PATH, {
        reportName: MACRO_CATALOG[indicator].report,
        columns: 'ALL',
        pageNumber: '1',
        pageSize: String(periods),
        sortColumns: 'REPORT_DATE',
        sortTypes: '-1',
      }, signal)
      if (rows.length === 0) throw new RequestFailure('not_found', 'Upstream has no period for this indicator.')
      return {
        ok: true,
        source: 'stock',
        query: 'macro',
        indicator,
        requested_periods: periods,
        returned_periods: rows.length,
        rows: rows.map(row => macroRow(indicator, row)),
        snapshot: this._snapshot(),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read the market overview: the closed index set with each index's advance,
   * decline, and unchanged counts.
   *
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async market(signal) {
    try {
      const data = await this._emPush(EM_PUSH_HOST, EM_ULIST_PATH, {
        fltt: '2',
        secids: MARKET_INDEX_SECIDS.join(','),
        fields: EM_INDEX_FIELDS,
      }, signal)
      const rows = data.diff
      if (!Array.isArray(rows)) throw invalidResponse('The market-overview response does not match the endpoint contract.')
      return {
        ok: true,
        source: 'stock',
        query: 'market',
        indexes: rows.map(row => marketIndexItem(row)),
        snapshot: this._snapshot(),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read one ranked board list.
   *
   * @param scope - `sector` for boards, `stock` for their securities.
   * @param board - the board scope, which must belong to `scope`.
   * @param sort - one of {@link RANK_SORT_TOKENS}.
   * @param order - `top` for the largest values first, `bottom` for the smallest.
   * @param count - how many rows to return.
   * @param offset - how many rows to skip.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async rank(scope, board, sort, order, count, offset, signal) {
    if (!Object.hasOwn(RANK_BOARDS, scope)) {
      throw new UsageError(`scope must be one of ${Object.keys(RANK_BOARDS).join(', ')}.`)
    }
    const boards = RANK_BOARDS[scope]
    const chosen = board ?? (scope === 'sector' ? 'hy' : 'aStock')
    if (!Object.hasOwn(boards, chosen)) {
      throw new UsageError(`board must be one of ${Object.keys(boards).join(', ')} for scope ${scope}.`)
    }
    if (!Object.hasOwn(RANK_SORT_TOKENS, sort)) {
      throw new UsageError(`sort must be one of ${Object.keys(RANK_SORT_TOKENS).join(', ')}.`)
    }
    if (!Object.hasOwn(RANK_ORDER_TOKENS, order)) {
      throw new UsageError(`order must be one of ${Object.keys(RANK_ORDER_TOKENS).join(', ')}.`)
    }
    try {
      const data = await this._tencent(PROXY_HOST, scope === 'sector' ? SECTOR_RANK_PATH : STOCK_RANK_PATH, {
        [scope === 'sector' ? 'board_type' : 'board_code']: chosen,
        sort_type: RANK_SORT_TOKENS[sort],
        direct: RANK_ORDER_TOKENS[order],
        offset: String(offset),
        count: String(count),
      }, signal)
      const rows = data.rank_list
      if (!Array.isArray(rows)) throw invalidResponse('The ranking response does not match the endpoint contract.')
      return {
        ok: true,
        source: 'stock',
        query: 'rank',
        scope,
        board: chosen,
        sort,
        order,
        offset: jsonNumber(data.offset, 'offset'),
        total: jsonNumber(data.total, 'total'),
        returned_count: rows.length,
        rows: scope === 'sector' ? rows.map(row => sectorRankRow(row)) : rows.map(row => stockRankRow(row)),
        snapshot: this._snapshot(),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Issue one whitelisted GET and read a Tencent envelope whose `data` object
   * is the payload. The informational `msg` field carries a status word here,
   * so unlike the quote envelopes it is not required to be empty.
   *
   * @param host - the request host.
   * @param path - the request path.
   * @param params - the query parameters.
   * @param signal - caller cancellation.
   * @returns the envelope's `data` object.
   */
  async _tencent(host, path, params, signal) {
    const payload = loadJson(await this._request(host, path, params, signal))
    if (!isRecord(payload)) throw invalidResponse('The quote endpoint response does not match the contract.')
    if (payload.code !== 0) {
      throw invalidResponse('The quote endpoint rejected the request in a way the contract does not describe.')
    }
    if (!isRecord(payload.data)) throw invalidResponse('The quote endpoint response does not match the contract.')
    return payload.data
  }

  /**
   * Issue one whitelisted GET and read an East Money snapshot envelope.
   *
   * @param host - the request host.
   * @param path - the request path.
   * @param params - the query parameters.
   * @param signal - caller cancellation.
   * @returns the envelope's `data` object.
   */
  async _emPush(host, path, params, signal) {
    const payload = loadJson(await this._request(host, path, params, signal))
    if (!isRecord(payload)) throw invalidResponse('The quote endpoint response does not match the contract.')
    if (payload.rc !== 0) {
      throw invalidResponse('The quote endpoint rejected the request in a way the contract does not describe.')
    }
    if (payload.data === null || payload.data === undefined) {
      throw new RequestFailure('not_found', 'Upstream has no data for this request.')
    }
    if (!isRecord(payload.data)) throw invalidResponse('The quote endpoint response does not match the contract.')
    return payload.data
  }

  /**
   * Issue one whitelisted GET and read an East Money report envelope, whose
   * empty result the endpoint reports as a success flag with code 9201.
   *
   * @param host - the request host.
   * @param path - the request path.
   * @param params - the query parameters.
   * @param signal - caller cancellation.
   * @returns the report's rows.
   */
  async _emData(host, path, params, signal) {
    const payload = loadJson(await this._request(host, path, params, signal))
    if (!isRecord(payload)) throw invalidResponse('The quote endpoint response does not match the contract.')
    if (payload.success !== true) {
      if (payload.code === 9201) {
        throw new RequestFailure('not_found', 'Upstream returned no rows for this report filter.')
      }
      throw invalidResponse('The quote endpoint rejected the request in a way the contract does not describe.')
    }
    const result = payload.result
    if (!isRecord(result) || !Array.isArray(result.data)) {
      throw invalidResponse('The quote endpoint response does not match the contract.')
    }
    return result.data
  }

  /**
   * Issue one whitelisted GET and read its JSON envelope, requiring the
   * success code and an object payload.
   *
   * @param host - the request host.
   * @param path - the request path.
   * @param params - the request's query parameters.
   * @param signal - caller cancellation.
   * @returns the envelope's `data` object.
   */
  async _ifzq(host, path, params, signal) {
    const payload = loadJson(await this._request(host, path, params, signal))
    if (!isRecord(payload)) throw invalidResponse('The quote endpoint response does not match the contract.')
    if (payload.code !== 0 && payload.code !== null && payload.code !== undefined) {
      throw invalidResponse('The quote endpoint rejected the request in a way the contract does not describe.')
    }
    if (typeof payload.msg === 'string' && payload.msg !== '') {
      throw invalidResponse('The quote endpoint rejected the request in a way the contract does not describe.')
    }
    if (!isRecord(payload.data)) throw invalidResponse('The quote endpoint response does not match the contract.')
    return payload.data
  }

  /**
   * When this process issued the request. How old the upstream value itself is
   * comes from the item's own `as_of`, not from this instant.
   *
   * @returns the snapshot metadata.
   */
  _snapshot() {
    return { queried_at: isoSeconds(Math.floor(Date.now() / 1000)) }
  }

  /**
   * Validate and trim the search keyword.
   *
   * @param value - the caller's keyword.
   * @returns the accepted keyword.
   */
  _checkKeyword(value) {
    if (typeof value !== 'string') throw new UsageError('keyword must be a string.')
    const keyword = value.trim()
    if (keyword.length < 1 || keyword.length > this._config.keywordMaxChars) {
      throw new UsageError(`keyword must be 1 to ${this._config.keywordMaxChars} characters after trimming.`)
    }
    return keyword
  }

  /**
   * Validate a quote batch and reject duplicates that only normalization reveals.
   *
   * @param value - the caller's codes.
   * @returns the normalized codes.
   */
  _checkQuoteCodes(value) {
    if (!Array.isArray(value)) throw new UsageError('codes must be an array of code strings.')
    if (value.length < 1 || value.length > this._config.quoteMaxCodes) {
      throw new UsageError(`codes must hold 1 to ${this._config.quoteMaxCodes} codes.`)
    }
    const parsed = value.map(item => parseCode(item))
    if (new Set(parsed.map(item => item.code)).size !== parsed.length) {
      throw new UsageError('codes must stay distinct after normalization.')
    }
    return parsed
  }

  /**
   * Validate a requested item count.
   *
   * @param value - the caller's count.
   * @param name - the argument name, used in the failure message.
   * @param maximum - the largest accepted value.
   * @returns the accepted count.
   */
  _checkCount(value, name, maximum) {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new UsageError(`${name} must be an integer.`)
    if (value < 1 || value > maximum) {
      throw new UsageError(`${name} must be from 1 to ${maximum}.`)
    }
    return value
  }

  /**
   * Issue one whitelisted GET, retrying once after a transport failure, a
   * timeout, a 5xx, or an empty success body, before backing this process off
   * from that host alone.
   *
   * @param host - the request host, which must be in the whitelist.
   * @param path - the request path, which must be in the whitelist.
   * @param params - the query parameters, which must be allowed for the path.
   * @param signal - caller cancellation.
   * @returns the response body.
   */
  _request(host, path, params, signal) {
    authorize(host, path, params)
    return this._serialize(async () => {
      await this._gate(host, signal)
      let attempt = 0
      for (;;) {
        let response
        try {
          response = await this._read(host, path, params, signal)
        } catch (error) {
          if (error instanceof RequestFailure) throw error
          if (isCallerAbort(signal)) throw error
          if (isTimeout(error)) {
            if (attempt === 0) {
              attempt = 1
              await sleep(this._config.retryDelayMs, signal)
              continue
            }
            throw this._pauseFailure(host, 'timeout', 'The quote request timed out. Try again later.', this._config.pauseNetworkMs)
          }
          if (attempt === 0) {
            attempt = 1
            await sleep(this._config.retryDelayMs, signal)
            continue
          }
          throw this._pauseFailure(host, 'network_error', 'The quote request could not be completed. Try again later.', this._config.pauseNetworkMs)
        }
        if (response.status === 200) {
          if (response.bytes.byteLength > 0) return response.bytes
          if (attempt === 0) {
            attempt = 1
            await sleep(this._config.retryDelayMs, signal)
            continue
          }
          throw invalidResponse('The quote endpoint returned an empty body.')
        }
        if (response.status === 429) {
          throw this._pauseFailure(host, 'rate_limited', 'The quote endpoint is temporarily rate-limiting this process. Try again later.', this._config.pauseBlockedMs)
        }
        if (response.status === 403) {
          throw this._pauseFailure(host, 'access_denied', 'The quote endpoint is temporarily refusing requests from this process. Try again later.', this._config.pauseBlockedMs)
        }
        if (response.status >= 500 && response.status <= 599) {
          if (attempt === 0) {
            attempt = 1
            await sleep(this._config.retryDelayMs, signal)
            continue
          }
          throw this._pauseFailure(host, 'upstream_unavailable', 'The quote service is temporarily unavailable. Try again later.', this._config.pauseNetworkMs)
        }
        throw invalidResponse('The quote endpoint returned an unexpected response status.')
      }
    })
  }

  /**
   * Perform one GET and read at most `responseLimitBytes` of its body. No
   * redirect is followed and no ambient proxy or netrc credential is read.
   *
   * @param host - the request host.
   * @param path - the request path.
   * @param params - the query parameters.
   * @param signal - caller cancellation.
   * @returns the status and body bytes.
   */
  async _read(host, path, params, signal) {
    this._lastRequestAt = performance.now()
    const url = new URL(`https://${host}${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const timeout = AbortSignal.timeout(this._config.requestTimeoutMs)
    const combined = signal === undefined || signal === null ? timeout : AbortSignal.any([signal, timeout])
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': this._config.userAgent },
      signal: combined,
    })
    const chunks = []
    let total = 0
    const reader = response.body === null ? null : response.body.getReader()
    if (reader !== null) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > this._config.responseLimitBytes) {
          await reader.cancel()
          throw new RequestFailure('response_too_large', 'The quote response exceeds the single-read limit, so no data was returned.')
        }
        chunks.push(value)
      }
    }
    return { status: response.status, bytes: Buffer.concat(chunks) }
  }

  /**
   * Apply the host's backoff and the minimum-interval pacing. Runs inside the
   * serialization chain, so the state it reads cannot change underneath it.
   *
   * @param host - the request host the backoff is keyed by.
   * @param signal - caller cancellation.
   * @returns once this process may issue the request.
   */
  async _gate(host, signal) {
    const now = performance.now()
    const block = this._blocks.get(host)
    if (block !== undefined) {
      if (now < block.until) {
        throw new RequestFailure('temporarily_blocked', `Quote requests to ${host} are temporarily paused in this process. Try again later.`, {
          retryable: true,
          retryAt: block.wall,
        })
      }
      this._blocks.delete(host)
    }
    if (this._lastRequestAt !== null) {
      const wait = this._lastRequestAt + this._config.minIntervalMs - now
      if (wait > 0) await sleep(wait, signal)
    }
  }

  /**
   * Extend one host's backoff, never shortening a backoff it already carries.
   *
   * @param host - the request host.
   * @param ms - the pause length in milliseconds.
   */
  _block(host, ms) {
    const until = performance.now() + ms
    const block = this._blocks.get(host)
    if (block === undefined || until > block.until) {
      this._blocks.set(host, { until, wall: Date.now() + ms })
    }
  }

  /**
   * Back this process off from one host and build the matching failure.
   *
   * @param host - the request host to pause.
   * @param code - the closed failure code.
   * @param message - the model-facing explanation.
   * @param ms - the pause length in milliseconds.
   * @returns the failure to throw.
   */
  _pauseFailure(host, code, message, ms) {
    this._block(host, ms)
    return new RequestFailure(code, message, { retryable: true, retryAt: this._blocks.get(host).wall })
  }
}

/**
 * Whether the caller cancelled the call rather than the request timing out.
 *
 * @param signal - the caller's cancellation signal, if any.
 * @returns whether the caller cancelled.
 */
function isCallerAbort(signal) {
  return signal !== undefined && signal !== null && signal.aborted === true
}

/**
 * Whether a `fetch` rejection is this request's own timeout.
 *
 * @param error - the rejection raised by `fetch`.
 * @returns whether the deadline elapsed.
 */
function isTimeout(error) {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * Convert a caught error into the model-facing failure value.
 *
 * @param error - the caught value.
 * @returns the failure payload.
 */
function failurePayload(error) {
  if (error instanceof RequestFailure) return error.payload()
  throw error
}

/**
 * The traded currency of a daily-bar response.
 *
 * @param parsed - the normalized code.
 * @param node - the response node for the code.
 * @returns the currency.
 */
function klineCurrency(parsed, node) {
  if (parsed.market === 'us') return 'USD'
  if (parsed.market === 'hk') return hkCurrency(node, parsed.code)
  return 'CNY'
}

/**
 * The traded currency of an intraday response.
 *
 * @param parsed - the normalized code.
 * @param node - the response node for the code.
 * @returns the currency.
 */
function minuteCurrency(parsed, node) {
  return klineCurrency(parsed, node)
}

// ── tool value schemas ──────────────────────────────────────────────────────

/** A number the endpoint may omit or leave empty, mapped to null. */
const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] }

/** A string the endpoint may omit or leave empty, mapped to null. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** The instant this process issued the request. */
const SNAPSHOT_SCHEMA = {
  type: 'object',
  required: ['queried_at'],
  properties: {
    queried_at: { type: 'string' },
  },
  additionalProperties: false,
}

/** The closed failure value every tool returns instead of throwing. */
const ERROR_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'error'],
  properties: {
    ok: { type: 'boolean', const: false },
    source: { type: 'string', const: 'stock' },
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        retry_at: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

/** One level of the five-level order book. */
const ORDER_BOOK_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['price', 'volume'],
    properties: { price: { type: 'number' }, volume: { type: 'number' } },
    additionalProperties: false,
  },
}

/** Fields every market's quote carries. */
const QUOTE_PROPERTIES = {
  code: { type: 'string' },
  symbol: NULLABLE_STRING,
  name: NULLABLE_STRING,
  type: NULLABLE_STRING,
  price: NULLABLE_NUMBER,
  prev_close: NULLABLE_NUMBER,
  open: NULLABLE_NUMBER,
  high: NULLABLE_NUMBER,
  low: NULLABLE_NUMBER,
  change: NULLABLE_NUMBER,
  change_pct: NULLABLE_NUMBER,
  volume: NULLABLE_NUMBER,
  volume_unit: { type: 'string', enum: ['lot', 'share'] },
  amount: NULLABLE_NUMBER,
  amplitude: NULLABLE_NUMBER,
  market_cap: NULLABLE_NUMBER,
  float_market_cap: NULLABLE_NUMBER,
  currency: NULLABLE_STRING,
  as_of: NULLABLE_STRING,
  timezone: { type: 'string' },
}

/** Field names every market's quote carries. */
const QUOTE_REQUIRED = Object.keys(QUOTE_PROPERTIES)

/** A Shanghai, Shenzhen, or Beijing quote, which alone carries valuation and limits. */
const CN_QUOTE_ITEM_SCHEMA = {
  type: 'object',
  required: [...QUOTE_REQUIRED, 'turnover_rate', 'pe_ttm', 'pb', 'limit_up', 'limit_down'],
  properties: {
    ...QUOTE_PROPERTIES,
    turnover_rate: NULLABLE_NUMBER,
    pe_ttm: NULLABLE_NUMBER,
    pb: NULLABLE_NUMBER,
    limit_up: NULLABLE_NUMBER,
    limit_down: NULLABLE_NUMBER,
    bids: ORDER_BOOK_SCHEMA,
    asks: ORDER_BOOK_SCHEMA,
  },
  additionalProperties: false,
}

/** A Hong Kong quote, which carries an English name and the 52-week range. */
const HK_QUOTE_ITEM_SCHEMA = {
  type: 'object',
  required: [...QUOTE_REQUIRED, 'name_en', 'high_52w', 'low_52w'],
  properties: {
    ...QUOTE_PROPERTIES,
    name_en: NULLABLE_STRING,
    high_52w: NULLABLE_NUMBER,
    low_52w: NULLABLE_NUMBER,
  },
  additionalProperties: false,
}

/** A US quote, which adds the turnover rate to the Hong Kong field set. */
const US_QUOTE_ITEM_SCHEMA = {
  type: 'object',
  required: [...QUOTE_REQUIRED, 'turnover_rate', 'name_en', 'high_52w', 'low_52w'],
  properties: {
    ...QUOTE_PROPERTIES,
    turnover_rate: NULLABLE_NUMBER,
    name_en: NULLABLE_STRING,
    high_52w: NULLABLE_NUMBER,
    low_52w: NULLABLE_NUMBER,
  },
  additionalProperties: false,
}

/** One quote, in whichever of the three market field sets it arrived. */
const QUOTE_ITEM_SCHEMA = {
  oneOf: [CN_QUOTE_ITEM_SCHEMA, HK_QUOTE_ITEM_SCHEMA, US_QUOTE_ITEM_SCHEMA],
}

/** One search match. */
const SEARCH_ITEM_SCHEMA = {
  type: 'object',
  required: ['market', 'code', 'name', 'pinyin', 'type'],
  properties: {
    market: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    pinyin: { type: 'string' },
    type: { type: 'string' },
  },
  additionalProperties: false,
}

/** One daily bar. */
const BAR_SCHEMA = {
  type: 'object',
  required: ['date', 'open', 'close', 'high', 'low', 'volume'],
  properties: {
    date: { type: 'string' },
    open: { type: 'number' },
    close: { type: 'number' },
    high: { type: 'number' },
    low: { type: 'number' },
    volume: { type: 'number' },
    amount: { type: 'number' },
  },
  additionalProperties: false,
}

/** One intraday row. */
const MINUTE_ROW_SCHEMA = {
  type: 'object',
  required: ['time', 'price', 'volume_cum'],
  properties: {
    time: { type: 'string' },
    price: { type: 'number' },
    volume_cum: { type: 'number' },
    amount_cum: { type: 'number' },
  },
  additionalProperties: false,
}

/** A search result. */
const SEARCH_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'query', 'items', 'count'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'search' },
    items: { type: 'array', items: SEARCH_ITEM_SCHEMA },
    count: { type: 'integer' },
    note: { type: 'string' },
  },
  additionalProperties: false,
}

/** A batch of quote snapshots, with the codes upstream omitted. */
const QUOTE_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'query', 'items', 'missing', 'snapshot'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'quote' },
    items: { type: 'array', items: QUOTE_ITEM_SCHEMA },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'reason'],
        properties: { code: { type: 'string' }, reason: { type: 'string', const: 'not_found' } },
        additionalProperties: false,
      },
    },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** A holding the user marked on one followed security. */
const WATCHLIST_POSITION_SCHEMA = {
  type: 'object',
  required: ['cost', 'quantity', 'markedAt'],
  properties: {
    cost: NULLABLE_NUMBER,
    quantity: NULLABLE_NUMBER,
    markedAt: { type: 'string' },
  },
  additionalProperties: false,
}

/**
 * One holding with the figures the panel draws, computed from the stored mark
 * and the latest quote.
 *
 * The panel already derives value and profit; a model that has to redo the
 * arithmetic from `cost` and `quantity` will eventually disagree with what the
 * person sees on screen, so the same derivation is done here once and published.
 * A figure whose input is missing stays null rather than being guessed.
 */
const HOLDING_SCHEMA = {
  type: 'object',
  required: ['code', 'currency', 'cost', 'quantity', 'price', 'market_value', 'profit', 'profit_pct', 'marked_at'],
  properties: {
    code: { type: 'string' },
    currency: NULLABLE_STRING,
    cost: NULLABLE_NUMBER,
    quantity: NULLABLE_NUMBER,
    price: NULLABLE_NUMBER,
    market_value: NULLABLE_NUMBER,
    profit: NULLABLE_NUMBER,
    profit_pct: NULLABLE_NUMBER,
    marked_at: { type: 'string' },
  },
  additionalProperties: false,
}

/** One followed security, as the watchlist stores it. */
const WATCHLIST_ENTRY_SCHEMA = {
  type: 'object',
  required: ['code', 'name', 'addedAt', 'position'],
  properties: {
    code: { type: 'string' },
    name: NULLABLE_STRING,
    addedAt: { type: 'string' },
    position: { oneOf: [WATCHLIST_POSITION_SCHEMA, { type: 'null' }] },
  },
  additionalProperties: false,
}

/** One batch of the watchlist whose quotes could not be read. */
const WATCHLIST_FAILED_SCHEMA = {
  type: 'object',
  required: ['codes', 'error'],
  properties: {
    codes: { type: 'array', items: { type: 'string' } },
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        retry_at: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

/** The markets the watchlist covers and when the next one opens. */
const WATCHLIST_MARKET_SCHEMA = {
  type: 'object',
  required: ['open', 'trading', 'next_open_at'],
  properties: {
    open: { type: 'boolean' },
    trading: { type: 'array', items: { type: 'string', enum: MARKETS } },
    next_open_at: NULLABLE_STRING,
  },
  additionalProperties: false,
}

/** One of the stored lists, with the latest quote of every entry. */
const WATCHLIST_SUCCESS_SCHEMA = {
  type: 'object',
  required: [
    'ok', 'source', 'query', 'action', 'scope', 'entries', 'invalid',
    'holdings', 'items', 'missing', 'market', 'updated_at', 'snapshot',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'watchlist' },
    action: { type: 'string', enum: ['list', 'add', 'remove', 'move', 'clear', 'mark', 'unmark'] },
    scope: { type: 'string', enum: WATCHLIST_SCOPES },
    entries: { type: 'array', items: WATCHLIST_ENTRY_SCHEMA },
    invalid: { type: 'array', items: { type: 'string' } },
    holdings: { type: 'array', items: HOLDING_SCHEMA, description: 'The marked positions of this list, with value and profit derived the same way the panel derives them.' },
    items: { type: 'array', items: QUOTE_ITEM_SCHEMA },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'reason'],
        properties: { code: { type: 'string' }, reason: { type: 'string', const: 'not_found' } },
        additionalProperties: false,
      },
    },
    failed: { type: 'array', items: WATCHLIST_FAILED_SCHEMA },
    market: WATCHLIST_MARKET_SCHEMA,
    updated_at: NULLABLE_STRING,
    note: { type: 'string' },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** A daily-bar series. */
const KLINE_SUCCESS_SCHEMA = {
  type: 'object',
  required: [
    'ok', 'source', 'query', 'code', 'market', 'adjust_requested', 'adjust_applied',
    'requested_count', 'returned_count', 'currency', 'volume_unit', 'bars', 'snapshot',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'kline' },
    code: { type: 'string' },
    market: { type: 'string', enum: MARKETS },
    adjust_requested: { type: 'string', enum: ADJUST_MODES },
    adjust_applied: { type: 'string', enum: APPLIED_ADJUSTMENTS },
    requested_count: { type: 'integer' },
    returned_count: { type: 'integer' },
    currency: { type: 'string' },
    volume_unit: { type: 'string', enum: ['lot', 'share'] },
    bars: { type: 'array', items: BAR_SCHEMA },
    note: { type: 'string' },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** An intraday minute series. */
const MINUTE_SUCCESS_SCHEMA = {
  type: 'object',
  required: [
    'ok', 'source', 'query', 'code', 'market', 'date', 'timezone',
    'currency', 'volume_unit', 'rows', 'snapshot',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'minute' },
    code: { type: 'string' },
    market: { type: 'string', enum: MARKETS },
    date: { type: 'string' },
    timezone: { type: 'string' },
    currency: { type: 'string' },
    volume_unit: { type: 'string', enum: ['lot', 'share'] },
    rows: { type: 'array', items: MINUTE_ROW_SCHEMA },
    note: { type: 'string' },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** One minute bar. */
const MINUTE_BAR_SCHEMA = {
  type: 'object',
  required: ['time', 'open', 'close', 'high', 'low', 'volume', 'turnover_rate_pct'],
  properties: {
    time: { type: 'string' },
    open: { type: 'number' },
    close: { type: 'number' },
    high: { type: 'number' },
    low: { type: 'number' },
    volume: { type: 'number' },
    turnover_rate_pct: NULLABLE_NUMBER,
  },
  additionalProperties: false,
}

/** A minute-bar series. */
const BARS_SUCCESS_SCHEMA = {
  type: 'object',
  required: [
    'ok', 'source', 'query', 'code', 'market', 'period', 'requested_count',
    'returned_count', 'prev_close', 'volume_unit', 'bars', 'snapshot',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'bars' },
    code: { type: 'string' },
    market: { type: 'string', enum: ['sh', 'sz'] },
    period: { type: 'string', enum: BAR_PERIODS },
    requested_count: { type: 'integer' },
    returned_count: { type: 'integer' },
    prev_close: NULLABLE_NUMBER,
    volume_unit: { type: 'string', const: 'lot' },
    bars: { type: 'array', items: MINUTE_BAR_SCHEMA },
    note: { type: 'string' },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** One day of a multi-day intraday series, summarized. */
const MINUTE_HISTORY_SUMMARY_DAY = {
  type: 'object',
  required: ['date', 'prev_close', 'open', 'high', 'low', 'close', 'volume_cum'],
  properties: {
    date: { type: 'string' },
    prev_close: NULLABLE_NUMBER,
    open: NULLABLE_NUMBER,
    high: NULLABLE_NUMBER,
    low: NULLABLE_NUMBER,
    close: NULLABLE_NUMBER,
    volume_cum: NULLABLE_NUMBER,
    amount_cum: NULLABLE_NUMBER,
  },
  additionalProperties: false,
}

/** One day of a multi-day intraday series, with its rows. */
const MINUTE_HISTORY_ROWS_DAY = {
  type: 'object',
  required: ['date', 'prev_close', 'rows'],
  properties: {
    date: { type: 'string' },
    prev_close: NULLABLE_NUMBER,
    rows: { type: 'array', items: MINUTE_ROW_SCHEMA },
  },
  additionalProperties: false,
}

/**
 * Build the success contract of the multi-day intraday tool for one detail
 * level, so the payload's `detail` and its day layout cannot disagree.
 *
 * @param detail - the detail level this branch describes.
 * @param daySchema - the day schema that level returns.
 * @returns the success schema.
 */
function minuteHistorySuccess(detail, daySchema) {
  return {
    type: 'object',
    required: [
      'ok', 'source', 'query', 'code', 'market', 'detail', 'timezone', 'currency',
      'volume_unit', 'days_available', 'days', 'snapshot',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      source: { type: 'string', const: 'stock' },
      query: { type: 'string', const: 'minute_history' },
      code: { type: 'string' },
      market: { type: 'string', enum: MINUTE_HISTORY_MARKETS },
      detail: { type: 'string', const: detail },
      timezone: { type: 'string' },
      currency: { type: 'string' },
      volume_unit: { type: 'string', enum: ['lot', 'share'] },
      days_available: { type: 'integer' },
      days: { type: 'array', items: daySchema },
      note: { type: 'string' },
      snapshot: SNAPSHOT_SCHEMA,
    },
    additionalProperties: false,
  }
}

/**
 * The five net amounts every money-flow row carries.
 *
 * The property map is built from {@link FLOW_NET_FIELDS}, the same ordered list
 * the row builder reads upstream columns by: a bucket renamed in one place
 * cannot silently disagree with the schema that admits it.
 */
const FLOW_NET_PROPERTIES = Object.fromEntries(
  FLOW_NET_FIELDS.map((name) => [name, { type: 'number' }]),
)

/** Field names of {@link FLOW_NET_PROPERTIES}. */
const FLOW_NET_REQUIRED = [...FLOW_NET_FIELDS]

/** The five net-share percentages only the daily series carries. */
const FLOW_PCT_PROPERTIES = Object.fromEntries(
  FLOW_PCT_FIELDS.map((name) => [name, NULLABLE_NUMBER]),
)

/** Field names of {@link FLOW_PCT_PROPERTIES}. */
const FLOW_PCT_REQUIRED = [...FLOW_PCT_FIELDS]

/** One same-day money-flow sample. */
const FLOW_INTRADAY_ROW_SCHEMA = {
  type: 'object',
  required: ['time', ...FLOW_NET_REQUIRED],
  properties: { time: { type: 'string' }, ...FLOW_NET_PROPERTIES },
  additionalProperties: false,
}

/** One daily money-flow row. */
const FLOW_DAILY_ROW_SCHEMA = {
  type: 'object',
  required: ['date', ...FLOW_NET_REQUIRED, ...FLOW_PCT_REQUIRED, 'close', 'change_pct'],
  properties: {
    date: { type: 'string' },
    ...FLOW_NET_PROPERTIES,
    ...FLOW_PCT_PROPERTIES,
    close: NULLABLE_NUMBER,
    change_pct: NULLABLE_NUMBER,
  },
  additionalProperties: false,
}

/**
 * Build the success contract of the money-flow tool for one range, so the
 * payload's `range` and its row layout cannot disagree.
 *
 * @param range - the range this branch describes.
 * @param rowSchema - the row schema that range returns.
 * @returns the success schema.
 */
function moneyflowSuccess(range, rowSchema) {
  return {
    type: 'object',
    required: [
      'ok', 'source', 'query', 'code', 'market', 'range', 'requested_days',
      'returned_rows', 'rows', 'snapshot',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      source: { type: 'string', const: 'stock' },
      query: { type: 'string', const: 'moneyflow' },
      code: { type: 'string' },
      market: { type: 'string', enum: MARKETS },
      range: { type: 'string', const: range },
      requested_days: NULLABLE_NUMBER,
      returned_rows: { type: 'integer' },
      rows: { type: 'array', items: rowSchema },
      snapshot: SNAPSHOT_SCHEMA,
    },
    additionalProperties: false,
  }
}

/** One report period. */
const FUNDAMENTAL_PERIOD_SCHEMA = {
  type: 'object',
  required: [
    'report_date', 'report_name', 'revenue', 'revenue_yoy_pct', 'net_profit', 'net_profit_yoy_pct',
    'basic_eps', 'deducted_eps', 'roe_weighted_pct', 'gross_margin_pct', 'bps', 'ocf_per_share',
    'industry', 'notice_date',
  ],
  properties: {
    report_date: { type: 'string' },
    report_name: NULLABLE_STRING,
    revenue: NULLABLE_NUMBER,
    revenue_yoy_pct: NULLABLE_NUMBER,
    net_profit: NULLABLE_NUMBER,
    net_profit_yoy_pct: NULLABLE_NUMBER,
    basic_eps: NULLABLE_NUMBER,
    deducted_eps: NULLABLE_NUMBER,
    roe_weighted_pct: NULLABLE_NUMBER,
    gross_margin_pct: NULLABLE_NUMBER,
    bps: NULLABLE_NUMBER,
    ocf_per_share: NULLABLE_NUMBER,
    industry: NULLABLE_STRING,
    notice_date: NULLABLE_STRING,
  },
  additionalProperties: false,
}

/** A fundamentals series. */
const FUNDAMENTALS_SUCCESS_SCHEMA = {
  type: 'object',
  required: [
    'ok', 'source', 'query', 'code', 'market', 'currency', 'requested_periods',
    'returned_periods', 'periods', 'snapshot',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'fundamentals' },
    code: { type: 'string' },
    market: { type: 'string', enum: ['sh', 'sz', 'bj'] },
    currency: { type: 'string', const: 'CNY' },
    requested_periods: { type: 'integer' },
    returned_periods: { type: 'integer' },
    periods: { type: 'array', items: FUNDAMENTAL_PERIOD_SCHEMA },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** One index of the market overview. */
const MARKET_INDEX_SCHEMA = {
  type: 'object',
  required: [
    'code', 'name', 'price', 'change', 'change_pct', 'open', 'high', 'low', 'prev_close',
    'volume', 'amount', 'advancers', 'decliners', 'unchanged',
  ],
  properties: {
    code: { type: 'string' },
    name: NULLABLE_STRING,
    price: NULLABLE_NUMBER,
    change: NULLABLE_NUMBER,
    change_pct: NULLABLE_NUMBER,
    open: NULLABLE_NUMBER,
    high: NULLABLE_NUMBER,
    low: NULLABLE_NUMBER,
    prev_close: NULLABLE_NUMBER,
    volume: NULLABLE_NUMBER,
    amount: NULLABLE_NUMBER,
    advancers: NULLABLE_NUMBER,
    decliners: NULLABLE_NUMBER,
    unchanged: NULLABLE_NUMBER,
  },
  additionalProperties: false,
}

/** The market overview. */
const MARKET_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'query', 'indexes', 'snapshot'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'market' },
    indexes: { type: 'array', items: MARKET_INDEX_SCHEMA },
    snapshot: SNAPSHOT_SCHEMA,
  },
  additionalProperties: false,
}

/** A ranked sector's leading security. */
const SECTOR_LEADER_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['code', 'name', 'change_pct'],
      properties: { code: NULLABLE_STRING, name: NULLABLE_STRING, change_pct: NULLABLE_NUMBER },
      additionalProperties: false,
    },
    { type: 'null' },
  ],
}

/** One ranked sector board. */
const SECTOR_RANK_ROW_SCHEMA = {
  type: 'object',
  required: [
    'board_code', 'name', 'price', 'change', 'change_pct', 'turnover_wan', 'volume_lot',
    'turnover_rate_pct', 'volume_ratio', 'market_cap_yi', 'float_market_cap_yi',
    'main_net_inflow_wan', 'main_net_inflow_5d_wan', 'main_net_inflow_20d_wan',
    'main_inflow_wan', 'main_outflow_wan', 'change_pct_5d', 'change_pct_20d', 'change_pct_60d',
    'advancers', 'decliners', 'leader',
  ],
  properties: {
    board_code: NULLABLE_STRING,
    name: NULLABLE_STRING,
    price: NULLABLE_NUMBER,
    change: NULLABLE_NUMBER,
    change_pct: NULLABLE_NUMBER,
    turnover_wan: NULLABLE_NUMBER,
    volume_lot: NULLABLE_NUMBER,
    turnover_rate_pct: NULLABLE_NUMBER,
    volume_ratio: NULLABLE_NUMBER,
    market_cap_yi: NULLABLE_NUMBER,
    float_market_cap_yi: NULLABLE_NUMBER,
    main_net_inflow_wan: NULLABLE_NUMBER,
    main_net_inflow_5d_wan: NULLABLE_NUMBER,
    main_net_inflow_20d_wan: NULLABLE_NUMBER,
    main_inflow_wan: NULLABLE_NUMBER,
    main_outflow_wan: NULLABLE_NUMBER,
    change_pct_5d: NULLABLE_NUMBER,
    change_pct_20d: NULLABLE_NUMBER,
    change_pct_60d: NULLABLE_NUMBER,
    advancers: NULLABLE_NUMBER,
    decliners: NULLABLE_NUMBER,
    leader: SECTOR_LEADER_SCHEMA,
  },
  additionalProperties: false,
}

/** One ranked security. */
const STOCK_RANK_ROW_SCHEMA = {
  type: 'object',
  required: [
    'code', 'name', 'price', 'change', 'change_pct', 'amplitude_pct', 'turnover_wan',
    'volume_lot', 'turnover_rate_pct', 'volume_ratio', 'pe_ttm', 'pb', 'market_cap_yi',
    'float_market_cap_yi', 'main_net_inflow_wan', 'main_inflow_wan', 'main_outflow_wan',
    'change_pct_5d', 'change_pct_10d', 'change_pct_20d', 'change_pct_60d', 'change_pct_52w',
    'change_pct_ytd',
  ],
  properties: {
    code: NULLABLE_STRING,
    name: NULLABLE_STRING,
    price: NULLABLE_NUMBER,
    change: NULLABLE_NUMBER,
    change_pct: NULLABLE_NUMBER,
    amplitude_pct: NULLABLE_NUMBER,
    turnover_wan: NULLABLE_NUMBER,
    volume_lot: NULLABLE_NUMBER,
    turnover_rate_pct: NULLABLE_NUMBER,
    volume_ratio: NULLABLE_NUMBER,
    pe_ttm: NULLABLE_NUMBER,
    pb: NULLABLE_NUMBER,
    market_cap_yi: NULLABLE_NUMBER,
    float_market_cap_yi: NULLABLE_NUMBER,
    main_net_inflow_wan: NULLABLE_NUMBER,
    main_inflow_wan: NULLABLE_NUMBER,
    main_outflow_wan: NULLABLE_NUMBER,
    change_pct_5d: NULLABLE_NUMBER,
    change_pct_10d: NULLABLE_NUMBER,
    change_pct_20d: NULLABLE_NUMBER,
    change_pct_60d: NULLABLE_NUMBER,
    change_pct_52w: NULLABLE_NUMBER,
    change_pct_ytd: NULLABLE_NUMBER,
  },
  additionalProperties: false,
}

/**
 * Build the success contract of the ranking tool for one scope, so the
 * payload's `scope` and its row layout cannot disagree.
 *
 * @param scope - the scope this branch describes.
 * @param boards - the board values this scope accepts.
 * @param rowSchema - the row schema this scope returns.
 * @returns the success schema.
 */
function rankSuccess(scope, boards, rowSchema) {
  return {
    type: 'object',
    required: [
      'ok', 'source', 'query', 'scope', 'board', 'sort', 'order', 'offset', 'total',
      'returned_count', 'rows', 'snapshot',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      source: { type: 'string', const: 'stock' },
      query: { type: 'string', const: 'rank' },
      scope: { type: 'string', const: scope },
      board: { type: 'string', enum: Object.keys(boards) },
      sort: { type: 'string', enum: Object.keys(RANK_SORT_TOKENS) },
      order: { type: 'string', enum: Object.keys(RANK_ORDER_TOKENS) },
      offset: { type: 'integer' },
      total: { type: 'integer' },
      returned_count: { type: 'integer' },
      rows: { type: 'array', items: rowSchema },
      snapshot: SNAPSHOT_SCHEMA,
    },
    additionalProperties: false,
  }
}

/** Output contract of the search tool. */
const SEARCH_OUTPUT = { oneOf: [SEARCH_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the quote tool. */
const QUOTE_OUTPUT = { oneOf: [QUOTE_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the daily-bar tool. */
const KLINE_OUTPUT = { oneOf: [KLINE_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the intraday tool. */
const MINUTE_OUTPUT = { oneOf: [MINUTE_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the minute-bar tool. */
const BARS_OUTPUT = { oneOf: [BARS_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the multi-day intraday tool. */
const MINUTE_HISTORY_OUTPUT = {
  oneOf: [
    minuteHistorySuccess('summary', MINUTE_HISTORY_SUMMARY_DAY),
    minuteHistorySuccess('rows', MINUTE_HISTORY_ROWS_DAY),
    ERROR_PAYLOAD_SCHEMA,
  ],
}

/** Output contract of the money-flow tool. */
const MONEYFLOW_OUTPUT = {
  oneOf: [
    moneyflowSuccess('intraday', FLOW_INTRADAY_ROW_SCHEMA),
    moneyflowSuccess('daily', FLOW_DAILY_ROW_SCHEMA),
    ERROR_PAYLOAD_SCHEMA,
  ],
}

/** Output contract of the fundamentals tool. */
const FUNDAMENTALS_OUTPUT = { oneOf: [FUNDAMENTALS_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the market-overview tool. */
const MARKET_OUTPUT = { oneOf: [MARKET_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the ranking tool. */
const RANK_OUTPUT = {
  oneOf: [
    rankSuccess('sector', SECTOR_BOARDS, SECTOR_RANK_ROW_SCHEMA),
    rankSuccess('stock', STOCK_BOARDS, STOCK_RANK_ROW_SCHEMA),
    ERROR_PAYLOAD_SCHEMA,
  ],
}

/** One news item. */
const NEWS_ITEM_SCHEMA = {
  type: 'object',
  required: ['id', 'published_at', 'title', 'publisher', 'url', 'summary'],
  properties: {
    id: { type: 'string' },
    published_at: { type: 'string' },
    title: { type: 'string' },
    publisher: NULLABLE_STRING,
    url: NULLABLE_STRING,
    summary: NULLABLE_STRING,
  },
  additionalProperties: false,
}

/** The newest news items upstream holds for one code. */
const NEWS_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'query', 'code', 'market', 'returned_count', 'items', 'snapshot'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'stock' },
    query: { type: 'string', const: 'news' },
    code: { type: 'string' },
    market: { type: 'string', enum: MARKETS },
    returned_count: { type: 'integer' },
    items: { type: 'array', items: NEWS_ITEM_SCHEMA },
    snapshot: SNAPSHOT_SCHEMA,
    note: { type: 'string' },
  },
  additionalProperties: false,
}

/**
 * Build the success contract of the macro tool for one indicator, so the
 * payload's `indicator` and its row layout cannot disagree.
 *
 * @param indicator - the catalog key this branch describes.
 * @param fields - the value fields every row of this indicator carries.
 * @returns the success schema.
 */
function macroSuccess(indicator, fields) {
  const values = {}
  for (const name of fields) values[name] = NULLABLE_NUMBER
  return {
    type: 'object',
    required: ['ok', 'source', 'query', 'indicator', 'requested_periods', 'returned_periods', 'rows', 'snapshot'],
    properties: {
      ok: { type: 'boolean', const: true },
      source: { type: 'string', const: 'stock' },
      query: { type: 'string', const: 'macro' },
      indicator: { type: 'string', const: indicator },
      requested_periods: { type: 'integer' },
      returned_periods: { type: 'integer' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          required: ['period', ...fields],
          properties: { period: { type: 'string' }, ...values },
          additionalProperties: false,
        },
      },
      snapshot: SNAPSHOT_SCHEMA,
    },
    additionalProperties: false,
  }
}

/** Output contract of the news tool. */
const NEWS_OUTPUT = { oneOf: [NEWS_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the macro tool, one branch per indicator. */
const MACRO_OUTPUT = {
  oneOf: [
    ...Object.entries(MACRO_CATALOG).map(([indicator, entry]) => macroSuccess(indicator, entry.fields.map(([name]) => name))),
    ERROR_PAYLOAD_SCHEMA,
  ],
}

/** Output contract of the watchlist tool. */
const WATCHLIST_OUTPUT = { oneOf: [WATCHLIST_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

// ── tool arguments ──────────────────────────────────────────────────────────

/**
 * Read one argument from possibly non-object arguments.
 *
 * @param args - the raw tool arguments.
 * @param key - the argument name.
 * @returns the value, or undefined when absent.
 */
function readArg(args, key) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  return args[key]
}

/**
 * Read an optional integer argument.
 *
 * @param args - the raw tool arguments.
 * @param name - the argument name, also used in the failure message.
 * @param fallback - the value used when the argument is absent.
 * @param maximum - the largest accepted value.
 * @returns the accepted value.
 */
function readInteger(args, name, fallback, maximum) {
  const raw = readArg(args, name)
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > maximum) {
    throw new UsageError(`${name} must be an integer from 1 to ${maximum}.`)
  }
  return raw
}

/**
 * Read an optional integer argument that may be zero.
 *
 * @param args - the raw tool arguments.
 * @param name - the argument name, also used in the failure message.
 * @param fallback - the value used when the argument is absent.
 * @param maximum - the largest accepted value.
 * @returns the accepted value.
 */
function readOffset(args, name, fallback, maximum) {
  const raw = readArg(args, name)
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > maximum) {
    throw new UsageError(`${name} must be an integer from 0 to ${maximum}.`)
  }
  return raw
}

/**
 * Read an optional argument constrained to a closed set of strings.
 *
 * @param args - the raw tool arguments.
 * @param name - the argument name, also used in the failure message.
 * @param fallback - the value used when the argument is absent.
 * @param allowed - the accepted values.
 * @returns the accepted value.
 */
function readEnum(args, name, fallback, allowed) {
  const raw = readArg(args, name)
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw new UsageError(`${name} must be one of ${allowed.join(', ')}.`)
  }
  return raw
}

/**
 * Read an argument constrained to a closed set of strings, requiring it.
 *
 * @param args - the raw tool arguments.
 * @param name - the argument name, also used in the failure message.
 * @param allowed - the accepted values.
 * @returns the accepted value.
 */
function readRequiredEnum(args, name, allowed) {
  const raw = readArg(args, name)
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw new UsageError(`${name} must be one of ${allowed.join(', ')}.`)
  }
  return raw
}

/**
 * Read the required adjustment argument.
 *
 * @param args - the raw tool arguments.
 * @returns the accepted adjustment.
 */
function readAdjust(args) {
  return readEnum(args, 'adjust', 'auto', ADJUST_MODES)
}

/**
 * Build the object-rooted parameter schema for one tool.
 *
 * @param properties - the declared arguments.
 * @param required - the argument names the model must supply.
 * @returns the parameter schema.
 */
function parameters(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...required.length > 0 ? { required } : {},
    additionalProperties: false,
  }
}

/**
 * Render one tool value as the single JSON text block the model reads.
 *
 * @param _args - the executed arguments; unused.
 * @param value - the validated tool value.
 * @returns the rendered content.
 */
function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Build each tool's pending-call presentation.
 *
 * @param title - the card title.
 * @param kind - the call kind shown in the UI.
 * @param rawInput - the arguments worth showing, when any.
 * @returns the presentation.
 */
function present(title, kind, rawInput = undefined) {
  return rawInput === undefined
    ? { card: 'generic', title, kind }
    : { card: 'generic', title, kind, rawInput }
}

/**
 * Project the arguments worth showing on a call card. Presentation runs on
 * playback of arbitrary logged arguments, so it never throws.
 *
 * @param args - the raw tool arguments.
 * @param key - the argument name to show.
 * @returns the projected arguments, or undefined when there is nothing to show.
 */
function presentableArgs(args, key) {
  const value = readArg(args, key)
  if (typeof value === 'string' || typeof value === 'number') return { [key]: value }
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return { [key]: value }
  return undefined
}

// ── watchlist arguments and results ─────────────────────────────────────────

/** The actions the watchlist tool accepts, as its schema enumerates them. */
const WATCHLIST_ACTIONS = ['list', 'add', 'remove', 'move', 'clear', 'mark', 'unmark']

/**
 * Read the list a watchlist call addresses.
 *
 * @param args - the raw tool arguments.
 * @returns the scope, defaulting to the followed securities.
 * @throws {UsageError} when the argument is not a scope this plugin stores.
 */
function readWatchlistScope(args) {
  return readEnum(args, 'scope', 'watchlist', WATCHLIST_SCOPES)
}

/**
 * Read and canonicalize the codes of an add or remove call.
 *
 * The list is deduplicated after normalization, so one call naming the same
 * security twice appends it once.
 *
 * @param args - the raw tool arguments.
 * @param maxEntries - how many codes this call's scope accepts.
 * @returns the canonical codes, in the order given.
 * @throws {UsageError} when the argument is missing, empty, or not codes.
 */
function readWatchlistCodes(args, maxEntries) {
  const raw = readArg(args, 'codes')
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new UsageError('codes must be a non-empty array of code strings.')
  }
  if (raw.length > maxEntries) {
    throw new UsageError(`codes must hold at most ${maxEntries} codes.`)
  }
  const canonical = []
  for (const value of raw) {
    const code = parseCode(value).code
    if (!canonical.includes(code)) canonical.push(code)
  }
  return canonical
}

/**
 * Read the position a move call targets.
 *
 * Whether the position fits depends on the list at the moment the move runs, so
 * only the form is checked here; the store reports a target past the end.
 *
 * @param args - the raw tool arguments.
 * @returns the 1-based position.
 * @throws {UsageError} when the argument is not a positive whole number.
 */
function readPosition(args) {
  const raw = readArg(args, 'to')
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new UsageError('to must be a whole number of 1 or more.')
  }
  return raw
}

/**
 * Read the code a mark or unmark call addresses.
 *
 * @param args - the raw tool arguments.
 * @param action - the action, used in the failure message.
 * @returns the canonical code.
 * @throws {UsageError} when the argument is missing or not a code this plugin serves.
 */
function readWatchlistCode(args, action) {
  const code = readArg(args, 'code')
  if (typeof code !== 'string' || code.trim() === '') {
    throw new UsageError(`code is required when action is ${action}.`)
  }
  return parseCode(code).code
}

/**
 * Read one optional positive position figure.
 *
 * An absent field keeps whatever the stored position holds, which is how a
 * mark that only updates the quantity leaves the cost alone.
 *
 * @param args - the raw tool arguments.
 * @param key - `cost` or `quantity`.
 * @returns the accepted figure, or undefined when absent.
 * @throws {UsageError} when the argument is not a positive finite number.
 */
function readPositionFigure(args, key) {
  const raw = readArg(args, key)
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new UsageError(`${key} must be a positive number.`)
  }
  return raw
}

/**
 * Build the model-facing watchlist value for one scope.
 *
 * The Host reads both lists in one pass, so the quotes, the failed batches, and
 * the market session are narrowed here to the codes of the list this call named.
 *
 * @param action - the action that produced it.
 * @param scope - the list the call addressed.
 * @param state - the state both surfaces read.
 * @param notes - what this action did, beyond the list itself.
 * @returns the tool value.
 */
function watchlistPayload(action, scope, state, notes = []) {
  const listed = scope === 'index' ? state.indices : state.entries
  const codes = new Set(listed.map(entry => entry.code))
  const markets = new Set(listed.map(entry => entry.code.slice(0, 2)))
  // The Host read both lists in one pass, so its market session covers the
  // other list too. Judge this list's own markets at the same instant, or a
  // watchlist of US codes would inherit a mainland opening time from the index
  // row that this call did not address.
  const at = Date.parse(state.snapshot?.queried_at ?? '')
  const market = marketSession([...markets], Number.isFinite(at) ? at : Date.now())
  const failed = state.quotes.failed
    .map(batch => ({ ...batch, codes: batch.codes.filter(code => codes.has(code)) }))
    .filter(batch => batch.codes.length > 0)
  const holdings = holdingView(listed, codes, state.quotes.items)
  const payload = {
    ok: true,
    source: 'stock',
    query: 'watchlist',
    action,
    scope,
    entries: listed,
    invalid: state.invalid.filter(code => codes.has(code)),
    holdings,
    items: state.quotes.items.filter(item => codes.has(item.code)),
    missing: state.quotes.missing.filter(entry => codes.has(entry.code)),
    market,
    updated_at: state.panel.updatedAt,
    snapshot: state.snapshot,
  }
  const all = [...notes]
  if (failed.length > 0) {
    payload.failed = failed
    const unread = failed.flatMap(entry => entry.codes)
    all.push(`No quote could be read for ${unread.join(', ')} (${failed[0].error.code}); the stored entries are unaffected.`)
  }
  if (listed.length === 0) all.push(scope === 'index' ? 'The index row is empty.' : 'The watchlist is empty.')
  if (payload.invalid.length > 0) {
    all.push(`The stored list holds ${payload.invalid.join(', ')}, which this plugin cannot query; remove them.`)
  }
  if (scope === 'watchlist' && holdings.length === 0 && listed.length > 0) {
    all.push('No entry is marked as held; `stock_watchlist` with action `mark` records a cost and a share count.')
  } else if (holdings.length > 0) {
    const unpriced = holdings.filter(holding => holding.price === null).map(holding => holding.code)
    if (unpriced.length > 0) all.push(`No quote was available for the holding in ${unpriced.join(', ')}, so its value and profit are null rather than zero.`)
  }
  if (all.length > 0) payload.note = all.join(' ')
  return payload
}

/**
 * Round to a fixed number of decimal places.
 *
 * @param value - the figure.
 * @param places - how many decimals to keep.
 * @returns the rounded figure.
 */
function roundTo(value, places) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * Derive the panel's holding figures for the marked entries of one list.
 *
 * The arithmetic mirrors the panel exactly — value is price times quantity and
 * profit is price minus cost times quantity, in the security's own currency —
 * so a model quoting a figure agrees with what the person sees. A missing input
 * leaves its figure null; a cost of zero is treated as unknown, because a
 * percentage return against it is meaningless.
 *
 * @param listed - the entries of the addressed list.
 * @param codes - the codes of that list, already filtered.
 * @param quotes - the quote items the Host read in one pass.
 * @returns the holdings, in the list's own order.
 */
function holdingView(listed, codes, quotes) {
  const byCode = new Map(quotes.filter(item => codes.has(item.code)).map(item => [item.code, item]))
  const holdings = []
  for (const entry of listed) {
    const position = entry.position
    if (position === undefined || position === null) continue
    const quote = byCode.get(entry.code)
    const price = typeof quote?.price === 'number' && Number.isFinite(quote.price) ? quote.price : null
    const cost = position.cost
    const quantity = position.quantity
    // Rounded where the panel rounds, so the figure a model quotes and the
    // figure on screen are the same number rather than two floats that differ
    // in the last place.
    const marketValue = price !== null && quantity !== null ? roundTo(price * quantity, 2) : null
    const profit = price !== null && cost !== null && cost > 0 && quantity !== null ? roundTo((price - cost) * quantity, 2) : null
    const profitPct = price !== null && cost !== null && cost > 0 ? roundTo((price / cost - 1) * 100, 2) : null
    holdings.push({
      code: entry.code,
      currency: typeof quote?.currency === 'string' ? quote.currency : null,
      cost,
      quantity,
      price,
      market_value: marketValue,
      profit,
      profit_pct: profitPct,
      marked_at: position.markedAt,
    })
  }
  return holdings
}

/**
 * Run one watchlist action for the agent.
 *
 * @param watchlist - the watchlist surface the panel also uses.
 * @param config - the resolved plugin options.
 * @param args - the raw tool arguments.
 * @param signal - caller cancellation, forwarded to the quote reads.
 * @returns the model-facing value.
 * @throws {UsageError} on unusable arguments; every state-dependent outcome is a value.
 */
async function runWatchlist(watchlist, config, args, signal) {
  const action = readEnum(args, 'action', 'list', WATCHLIST_ACTIONS)
  const scope = readWatchlistScope(args)
  const maxEntries = scope === 'index' ? config.indexMaxEntries : config.watchlistMaxEntries
  const label = scope === 'index' ? 'index row' : 'watchlist'
  switch (action) {
    case 'list': {
      // Only a read explains the shape of what it returns: a mutation already
      // says what it changed, and repeating the caveat on every write buries it.
      const state = await watchlist.status(signal)
      return watchlistPayload(action, scope, state, scope === 'index'
        ? ['The index row is a market gauge; positions are marked on the watchlist only.']
        : [],
      )
    }
    case 'add': {
      const { outcome, state } = await watchlist.add(scope, readWatchlistCodes(args, maxEntries), signal)
      const notes = []
      if (outcome.duplicates.length > 0) notes.push(`Already in the ${label}: ${outcome.duplicates.join(', ')}.`)
      if (outcome.full.length > 0) {
        notes.push(`The ${label} holds its maximum of ${maxEntries} entries; not added: ${outcome.full.join(', ')}.`)
      }
      return watchlistPayload(action, scope, state, notes)
    }
    case 'remove': {
      const { outcome, state } = await watchlist.remove(scope, readWatchlistCodes(args, maxEntries), signal)
      const notes = outcome.absent.length > 0 ? [`Not in the ${label}: ${outcome.absent.join(', ')}.`] : []
      return watchlistPayload(action, scope, state, notes)
    }
    case 'move': {
      const code = readWatchlistCode(args, 'move')
      const { outcome, state } = await watchlist.move(scope, code, readPosition(args), signal)
      const notes = []
      if (outcome.reason === 'not_listed') notes.push(`The ${label} does not hold that code.`)
      else if (outcome.reason === 'out_of_range') notes.push(`The ${label} holds ${outcome.count} entries, so to must be between 1 and ${outcome.count}.`)
      else if (outcome.reason === 'unchanged') notes.push('It already occupies that position.')
      return watchlistPayload(action, scope, state, notes)
    }
    case 'mark': {
      if (scope !== 'watchlist') {
        throw new UsageError('Positions are marked on the watchlist; the index row holds no positions.')
      }
      const code = readWatchlistCode(args, 'mark')
      const fields = {}
      const cost = readPositionFigure(args, 'cost')
      const quantity = readPositionFigure(args, 'quantity')
      if (cost !== undefined) fields.cost = cost
      if (quantity !== undefined) fields.quantity = quantity
      const { outcome, state } = await watchlist.mark(scope, code, fields, signal)
      const notes = outcome.reason === 'not_listed'
        ? [`The watchlist does not hold ${code}; add it before marking a position.`]
        : [`Marked ${code} as held${outcome.position.cost === null && outcome.position.quantity === null ? '' : ' with the figures stored'}.`]
      return watchlistPayload(action, scope, state, notes)
    }
    case 'unmark': {
      if (scope !== 'watchlist') {
        throw new UsageError('Positions are marked on the watchlist; the index row holds no positions.')
      }
      const code = readWatchlistCode(args, 'unmark')
      const { outcome, state } = await watchlist.unmark(scope, code)
      const notes = []
      if (outcome.reason === 'not_listed') notes.push(`The watchlist does not hold ${code}.`)
      else if (outcome.reason === 'not_marked') notes.push(`${code} is not marked as held.`)
      return watchlistPayload(action, scope, state, notes)
    }
    case 'clear': {
      if (readArg(args, 'confirm') !== true) {
        throw new UsageError(`clear deletes every ${label} entry; pass confirm: true to run it.`)
      }
      const { outcome, state } = await watchlist.clear(scope, signal)
      return watchlistPayload(action, scope, state, [`Removed ${outcome.removed} ${outcome.removed === 1 ? 'entry' : 'entries'}.`])
    }
  }
}

/**
 * Build the placeholder presentation of a watchlist call. Presentation runs on
 * playback of arbitrary logged arguments, so it never throws and never assumes
 * the action is one the schema enumerates.
 *
 * @param args - the raw tool arguments.
 * @returns the presentation.
 */
function presentWatchlistCall(args) {
  const codes = readArg(args, 'codes')
  const shown = Array.isArray(codes) && codes.every(code => typeof code === 'string')
    ? { codes }
    : presentableArgs(args, 'code')
  const list = readArg(args, 'scope') === 'index' ? 'the stock index row' : 'the stock watchlist'
  switch (readArg(args, 'action')) {
    case 'add':
      return present(`Add to ${list}`, 'edit', shown)
    case 'remove':
      return present(`Remove from ${list}`, 'delete', shown)
    case 'move':
      return present(`Reorder ${list}`, 'move', shown)
    case 'mark':
      return present(`Mark a position on ${list}`, 'edit', shown)
    case 'unmark':
      return present(`Clear a position on ${list}`, 'delete', shown)
    case 'clear':
      return present(`Clear ${list}`, 'delete')
    default:
      return present(`Read ${list}`, 'read')
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

/**
 * The caveats that hold for every stock tool, registered once as a prompt
 * section rather than appended to each of the thirteen descriptions. Each fact
 * is then stated once, and no description carries a fact that belongs to
 * another tool — the search coverage gap, the daily-bar adjustment rule.
 *
 * The text depends on nothing, so the assembled prompt stays byte-identical
 * between turns.
 */
const CAVEATS =
  'Market data from the stock_* tools: the quote endpoints carry no stability guarantee, so every value is a snapshot upstream last returned and may be delayed, stale, or internally inconsistent. '
  + 'No market data is stored locally; only the watchlist and the positions marked on it are durable. '
  + 'Complete coverage of securities, history, and trading sessions is not claimed, and quotes are not investment advice.'

/**
 * Render one board map as `key (meaning)` options, so the ranking tool's
 * `board` parameter states what each board set ranks.
 *
 * @param boards - board keys mapped to the set each one ranks.
 * @returns the comma-separated option list.
 */
function boardOptions(boards) {
  return Object.entries(boards).map(([key, meaning]) => `${key} (${meaning})`).join(', ')
}

/**
 * Build the thirteen tool definitions bound to one client.
 *
 * @param client - the shared process-local client.
 * @param config - the resolved plugin options.
 * @param watchlist - the watchlist surface the last tool reads and manages.
 * @returns the tool definitions, in registration order.
 */
function buildTools(client, config, watchlist) {
  return [
    {
      name: 'stock_search',
      description: `Search stocks, exchange-traded funds, and indexes by name, pinyin, or code (public, read-only) across the Shanghai, Shenzhen, Hong Kong, and US markets; a Shanghai or Shenzhen fund match is returned as its ETF, QDII-ETF, LOF, QDII-LOF, or REIT listing. Upstream decides the matches, which means a name or pinyin matches by prefix rather than anywhere inside it, and takes at most 23 bytes of keyword, so a longer keyword is searched as its longest prefix within that. This tool filters out the markets and security types it does not serve. Search does not cover the Beijing exchange, which accepts only the current 920 stock codes and 899 index codes and rejects the older numbering. Every returned code is canonical and can be passed to stock_quote, stock_kline, and stock_minute.`,
      parameters: parameters({
        keyword: {
          type: 'string',
          description: `Name, pinyin, or code to look for, from 1 to ${config.keywordMaxChars} characters after trimming.`,
        },
      }, ['keyword']),
      output: { schema: SEARCH_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Search stock codes', 'search', presentableArgs(args, 'keyword')),
      execute: (args, exec) => client.search(readArg(args, 'keyword'), exec?.signal),
    },
    {
      name: 'stock_quote',
      description: `Read the latest quote snapshot of one to ${config.quoteMaxCodes} codes (public, read-only): price, change, volume and amount, market capitalization, valuation, the five-level order book, and the quote time. Codes look like sh600519, hk00700, or usAAPL and must stay distinct after normalization. Items come back in request order, codes upstream silently omitted are listed in missing, and a request whose codes are all missing fails with not_found.`,
      parameters: parameters({
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: `One to ${config.quoteMaxCodes} codes, each in the form sh600519, sz399001, bj920001, hk00700, or usAAPL.`,
        },
      }, ['codes']),
      output: { schema: QUOTE_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read stock quotes', 'fetch', presentableArgs(args, 'codes')),
      execute: (args, exec) => client.quote(readArg(args, 'codes'), exec?.signal),
    },
    {
      name: 'stock_kline',
      description: 'Read daily bars (public, read-only) for one code. The market\'s current-day bar may not have closed or finished settling.',
      parameters: parameters({
        code: {
          type: 'string',
          description: 'One code in the form sh600519, sz399001, bj920001, hk00700, or usAAPL.OQ; a US code must carry its exchange suffix.',
        },
        count: {
          type: 'integer',
          description: `How many of the newest daily bars to keep, from 1 to ${config.klineMaxCount}. Defaults to ${config.klineDefaultCount}.`,
        },
        adjust: {
          type: 'string',
          enum: ADJUST_MODES,
          description: 'Price adjustment: auto (default), qfq (forward), hfq (backward), or none. An index supports only none, and a US code supports only qfq.',
        },
      }, ['code']),
      output: { schema: KLINE_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read stock daily bars', 'fetch', presentableArgs(args, 'code')),
      execute: (args, exec) => client.kline(
        readArg(args, 'code'),
        readInteger(args, 'count', config.klineDefaultCount, config.klineMaxCount),
        readAdjust(args),
        exec?.signal,
      ),
    },
    {
      name: 'stock_minute',
      description: `Read the intraday minute series for one code (public, read-only). Each row carries its time, price, and cumulative volume, and some markets add the cumulative amount. The newest row may restate the day's cumulative amount below the row before it, which is how upstream carries the settled total of a session it is still finalizing. date is the most recent trading day upstream has, which may predate the current date and does not describe today.`,
      parameters: parameters({
        code: {
          type: 'string',
          description: 'One code in the form sh600519, sz399001, bj920001, hk00700, or usAAPL.',
        },
      }, ['code']),
      output: { schema: MINUTE_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read stock intraday series', 'fetch', presentableArgs(args, 'code')),
      execute: (args, exec) => client.minute(readArg(args, 'code'), exec?.signal),
    },
    {
      name: 'stock_bars',
      description: `Read minute bars (public, read-only) for one Shanghai or Shenzhen code, indexes included. period sets the bar size and count keeps the newest bars, which span as many sessions as that takes — a mainland session holds about 240 minutes. Each bar carries its time, open, close, high, low, volume in lots, and the share of the float that bar turned over. The market's current session may not have finished forming. Hong Kong, US, and Beijing codes are not served here: use stock_minute for one current session and stock_kline for daily bars.`,
      parameters: parameters({
        code: {
          type: 'string',
          description: 'One code in the form sh600519 or sz399001; a Shanghai or Shenzhen listing or index.',
        },
        period: {
          type: 'string',
          enum: BAR_PERIODS,
          description: `Bar size, one of ${BAR_PERIODS.join(', ')}. Defaults to m5.`,
        },
        count: {
          type: 'integer',
          description: `How many of the newest bars to keep, from 1 to ${config.barsMaxCount}. Defaults to ${config.barsDefaultCount}.`,
        },
      }, ['code']),
      output: { schema: BARS_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read stock minute bars', 'fetch', presentableArgs(args, 'code')),
      execute: (args, exec) => client.bars(
        readArg(args, 'code'),
        readEnum(args, 'period', 'm5', BAR_PERIODS),
        readInteger(args, 'count', config.barsDefaultCount, config.barsMaxCount),
        exec?.signal,
      ),
    },
    {
      name: 'stock_minute_history',
      description: 'Read the intraday minute series of the most recent trading days upstream holds (public, read-only), for one Shanghai, Shenzhen, Beijing, or Hong Kong code. A row carries its time, price, and cumulative volume, and some markets add the cumulative amount. US codes are not served here: use stock_minute.',
      parameters: parameters({
        code: {
          type: 'string',
          description: 'One code in the form sh600519, sz399001, bj920001, or hk00700.',
        },
        days: {
          type: 'integer',
          description: `How many of the newest trading days to return, from 1 to ${config.minuteHistoryMaxDays}. Defaults to ${config.minuteHistoryMaxDays}.`,
        },
        detail: {
          type: 'string',
          enum: ['summary', 'rows'],
          description: 'summary (default) returns each day\'s first price, high, low, last price, and that session\'s cumulative volume and amount, all computed from the rows; rows returns every minute row instead, which costs far more context.',
        },
      }, ['code']),
      output: { schema: MINUTE_HISTORY_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read stock intraday history', 'fetch', presentableArgs(args, 'code')),
      execute: (args, exec) => client.minuteHistory(
        readArg(args, 'code'),
        readInteger(args, 'days', config.minuteHistoryMaxDays, config.minuteHistoryMaxDays),
        readEnum(args, 'detail', 'summary', ['summary', 'rows']),
        exec?.signal,
      ),
    },
    {
      name: 'stock_moneyflow',
      description: 'Read one security\'s money flow (public, read-only). Main is the sum of large and extra-large. Amounts are in the security\'s traded currency with no conversion.',
      parameters: parameters({
        code: {
          type: 'string',
          description: 'One code in the form sh600519, sz399001, bj920001, hk00700, or usAAPL.OQ; a US code must carry its exchange suffix.',
        },
        range: {
          type: 'string',
          enum: ['daily', 'intraday'],
          description: 'daily (default) returns the newest trading days, each carrying the net amounts of main, small, medium, large, and extra-large orders, each bucket\'s share of that day\'s turnover, the close, and the day\'s change; intraday returns the session\'s running totals sampled once a minute, and is served for Shanghai, Shenzhen, and Beijing codes only.',
        },
        days: {
          type: 'integer',
          description: `How many of the newest daily rows to keep, from 1 to ${config.moneyflowMaxDays}. Defaults to ${config.moneyflowDefaultDays}. Applies to range=daily only.`,
        },
      }, ['code']),
      output: { schema: MONEYFLOW_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read stock money flow', 'fetch', presentableArgs(args, 'code')),
      execute: (args, exec) => {
        const range = readEnum(args, 'range', 'daily', ['daily', 'intraday'])
        if (range === 'intraday' && readArg(args, 'days') !== undefined) {
          throw new UsageError('days applies to the daily range only.')
        }
        return client.moneyflow(
          readArg(args, 'code'),
          range,
          readInteger(args, 'days', config.moneyflowDefaultDays, config.moneyflowMaxDays),
          exec?.signal,
        )
      },
    },
    {
      name: 'stock_fundamentals',
      description: `Read report-period fundamentals (public, read-only) for one Shanghai, Shenzhen, or Beijing code: revenue and net profit with their year-on-year change, basic and deducted earnings per share, weighted return on equity, gross margin, book value per share, operating cash flow per share, the industry, and the report's notice date. Revenue and net profit are cumulative for the report period and are reported in yuan, with the ratios in percent. Hong Kong and US codes are not served here, and a listed fund publishes no such report, so a fund code answers not_found.`,
      parameters: parameters({
        code: {
          type: 'string',
          description: 'One code in the form sh600519, sz399001, or bj920001.',
        },
        periods: {
          type: 'integer',
          description: `How many of the newest report periods to keep, from 1 to ${config.fundamentalsMaxPeriods}. Defaults to ${config.fundamentalsDefaultPeriods}.`,
        },
      }, ['code']),
      output: { schema: FUNDAMENTALS_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read stock fundamentals', 'fetch', presentableArgs(args, 'code')),
      execute: (args, exec) => client.fundamentals(
        readArg(args, 'code'),
        readInteger(args, 'periods', config.fundamentalsDefaultPeriods, config.fundamentalsMaxPeriods),
        exec?.signal,
      ),
    },
    {
      name: 'stock_market',
      description: `Read the mainland market overview (public, read-only): the latest snapshot of six indexes, each with its open, high, low, previous close, volume, amount in yuan, and the counts of advancing, declining, and unchanged securities in the market that index tracks. It takes no arguments.`,
      parameters: parameters({}),
      output: { schema: MARKET_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: () => present('Read the market overview', 'fetch'),
      execute: (_args, exec) => client.market(exec?.signal),
    },
    {
      name: 'stock_rank',
      description: 'Read a ranked board list (public, read-only). Only Shanghai, Shenzhen, and ChiNext listings are ranked; amounts are in ten thousand yuan, market capitalizations in one hundred million yuan, and volumes in lots.',
      parameters: parameters({
        scope: {
          type: 'string',
          enum: Object.keys(RANK_BOARDS),
          description: 'sector ranks boards; stock ranks the securities of one board.',
        },
        board: {
          type: 'string',
          enum: [...Object.keys(SECTOR_BOARDS), ...Object.keys(STOCK_BOARDS)],
          description: `The board set to rank: ${boardOptions(SECTOR_BOARDS)} for scope=sector (default hy), or ${boardOptions(STOCK_BOARDS)} for scope=stock (default aStock).`,
        },
        sort: {
          type: 'string',
          enum: Object.keys(RANK_SORT_TOKENS),
          description: `Ranking key: ${Object.keys(RANK_SORT_TOKENS).join(', ')}. Defaults to change_pct.`,
        },
        order: {
          type: 'string',
          enum: Object.keys(RANK_ORDER_TOKENS),
          description: 'top (default) returns the largest values first; bottom returns the smallest.',
        },
        count: {
          type: 'integer',
          description: `How many rows to return, from 1 to ${config.rankMaxCount}. Defaults to ${config.rankDefaultCount}.`,
        },
        offset: {
          type: 'integer',
          description: `How many rows to skip, from 0 to ${config.rankMaxOffset}. Defaults to 0.`,
        },
      }, ['scope']),
      output: { schema: RANK_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read a stock ranking', 'fetch', presentableArgs(args, 'scope')),
      execute: (args, exec) => client.rank(
        readRequiredEnum(args, 'scope', Object.keys(RANK_BOARDS)),
        readArg(args, 'board'),
        readEnum(args, 'sort', 'change_pct', Object.keys(RANK_SORT_TOKENS)),
        readEnum(args, 'order', 'top', Object.keys(RANK_ORDER_TOKENS)),
        readInteger(args, 'count', config.rankDefaultCount, config.rankMaxCount),
        readOffset(args, 'offset', 0, config.rankMaxOffset),
        exec?.signal,
      ),
    },
    {
      name: 'stock_news',
      description: 'Read the newest news items upstream holds for one code (public, read-only), newest first: the item\'s time, title, publisher, and link. Upstream keeps only its latest block of items, so a larger limit does not reach further back.',
      parameters: parameters({
        code: {
          type: 'string',
          description: 'One code in the form sh600519, sz399001, bj920001, hk00700, or usAAPL.',
        },
        limit: {
          type: 'integer',
          description: `How many of the newest items to keep, from 1 to ${config.newsMaxLimit}. Defaults to ${config.newsDefaultLimit}.`,
        },
      }, ['code']),
      output: { schema: NEWS_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read stock news', 'fetch', presentableArgs(args, 'code')),
      execute: (args, exec) => client.news(
        readArg(args, 'code'),
        readInteger(args, 'limit', config.newsDefaultLimit, config.newsMaxLimit),
        exec?.signal,
      ),
    },
    {
      name: 'stock_macro',
      description: 'Read the newest periods of one mainland macro indicator (public, read-only), newest first. gdp is cumulative GDP in 100 million yuan with its year-on-year change; cpi is the national consumer price change, year on year and month on month, in percent; ppi is the producer price change year on year in percent with the index it is computed from; pmi carries the manufacturing and non-manufacturing readings; m2 carries the M2 and M1 stock in 100 million yuan with their year-on-year changes. The period is the publisher\'s own label.',
      parameters: parameters({
        indicator: {
          type: 'string',
          enum: Object.keys(MACRO_CATALOG),
          description: 'gdp (gross domestic product), cpi (consumer prices), ppi (producer prices), pmi (purchasing managers), or m2 (money supply).',
        },
        periods: {
          type: 'integer',
          description: `How many of the newest periods to keep, from 1 to ${config.macroMaxPeriods}. Defaults to ${config.macroDefaultPeriods}.`,
        },
      }, ['indicator']),
      output: { schema: MACRO_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Read macro indicators', 'fetch', presentableArgs(args, 'indicator')),
      execute: (args, exec) => client.macro(
        readRequiredEnum(args, 'indicator', Object.keys(MACRO_CATALOG)),
        readInteger(args, 'periods', config.macroDefaultPeriods, config.macroMaxPeriods),
        exec?.signal,
      ),
    },
    {
      name: 'stock_watchlist',
      description: `Read and manage the two ordered lists this plugin stores, both shared with the watchlist panel in the harness UI. scope=watchlist (the default) is the securities the user follows; scope=index is the index row the panel shows above them, which takes index codes only (resolve one with stock_search, where an index comes back as type ZS). A followed security can also be marked as held, with an optional cost per share and quantity; every marked entry comes back in \`holdings\` with its market value and profit, derived the same way the panel derives them, and a figure whose input is missing stays null rather than zero. An entry already in the list, a code with no room left at the configured maximum (${config.watchlistMaxEntries} followed securities, ${config.indexMaxEntries} indexes), a move past the end of the list, and a mark on a code the list does not hold are all reported in note instead of failing the call.`,
      parameters: parameters({
        action: {
          type: 'string',
          enum: WATCHLIST_ACTIONS,
          description: 'list (default) reads the addressed list with the latest quote of every entry, exactly as stock_quote reports it; add appends codes; remove drops codes; move repositions one code; mark records a holding on a followed security; unmark clears that holding; clear deletes every entry of that list.',
        },
        scope: {
          type: 'string',
          enum: WATCHLIST_SCOPES,
          description: 'Which list the action addresses: watchlist (default) for the followed securities, index for the index row. Both lists are stored, and the other one is left alone. mark and unmark apply to the watchlist only.',
        },
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: `The canonical codes add appends or remove drops, 1 to the addressed list's maximum of them (${config.watchlistMaxEntries} for the watchlist, ${config.indexMaxEntries} for the index row), each in the form sh600519, sz399001, bj920001, hk00700, or usAAPL. Resolve a name or keyword with stock_search first: a bare 600519 is not a code.`,
        },
        code: {
          type: 'string',
          description: 'The canonical code move repositions, or the followed security mark and unmark address.',
        },
        to: {
          type: 'integer',
          description: 'The 1-based position move puts code at, counted from the start of the list.',
        },
        cost: {
          type: 'number',
          description: 'mark only: the average cost per share. Omit it to keep the stored cost, or to mark the holding without one.',
        },
        quantity: {
          type: 'number',
          description: 'mark only: the number of shares held. Omit it to keep the stored quantity, or to mark the holding without one.',
        },
        confirm: {
          type: 'boolean',
          description: 'clear deletes every entry and runs only when this is true.',
        },
      }, []),
      output: { schema: WATCHLIST_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: args => readEnum(args, 'action', 'list', WATCHLIST_ACTIONS) === 'list',
      presentCall: args => presentWatchlistCall(args),
      execute: (args, exec) => runWatchlist(watchlist, config, args, exec?.signal),
    },
  ]
}

/**
 * Register the thirteen stock tools and the watchlist they manage. Each
 * registration is fiber-scoped, so unloading the plugin removes every tool it
 * added, and the watchlist domain closes with it.
 *
 * @param ctx - the plugin context, which must expose the tool registry, the storage domain, and the system prompt.
 * @param config - the row's `config`, validated here.
 * @returns the effect that owns the watchlist domain.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const client = new StockClient(resolved)
  // The section sits just after the tool sections, because it qualifies what
  // those tools return. `section()` registers its own effect on this fiber, so
  // the caveats leave with the plugin.
  ctx.systemPrompt.section({
    name: 'stock:caveats',
    order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS') + 20,
    text: CAVEATS,
  })
  return ctx.effect(async () => {
    const store = await openWatchlist(ctx.storageDomain, {
      maxEntries: { watchlist: resolved.watchlistMaxEntries, index: resolved.indexMaxEntries },
      indexDefaults: DEFAULT_INDEX_CODES,
    })
    try {
      const watchlist = buildWatchlistApi({
        store,
        client,
        config: resolved,
        parseCode,
        marketSession,
        snapshot: () => client._snapshot(),
        logger: ctx.logger,
      })
      for (const tool of buildTools(client, resolved, watchlist)) ctx.tools.register(tool)
      // Owned by this plugin's fiber: the route appears whenever Connection
      // mounts, and goes away with the plugin.
      registerBridge(ctx, watchlist)
    } catch (error) {
      // The domain is open by now, and a registration can throw — a hot reload
      // that disposes this fiber mid-setup does exactly that. Release the
      // domain before the failure escapes: the facility reserves an open name,
      // so a leak here fails every later mount with `already-open` until the
      // process restarts.
      await store.close()
      throw error
    }
    return async () => {
      await store.close()
    }
  }, 'stock:lifecycle')
}



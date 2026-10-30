/**
 * Deterministic behaviour checks for the dsh-taobao bundle: a scripted global
 * `fetch` drives the failure, retry, backoff, ranking, and disclosure paths
 * that the live API cannot produce on demand. Each scenario gets a fresh
 * plugin instance and transport, so one scenario's process-local backoff
 * cannot leak into the next.
 *
 * Every route builder returns a fresh `Response`, because a body can be read
 * only once and the plugin retries.
 *
 * Offline: run `node tests/verify-behavior.mjs` from the plugin directory after
 * `pnpm install`.
 */
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as plugin from '../index.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const previousFetch = globalThis.fetch
const SEARCH = 'https://appapi.maishou88.com/api/v1/homepage/searchList'
const DETAIL = 'https://appapi.maishou88.com/api/v3/goods/detail'
const TARGET = 'https://msapi.maishou88.com/api/v1/share/getTargetUrl'

/** Mount the plugin against a stub registry that applies the harness's own schema assertions. */
function mount(config) {
  const tools = new Map()
  plugin.apply({
    tools: {
      register(definition) {
        assertSupportedJsonSchema(definition.output.schema)
        assertSupportedJsonSchema(definition.parameters)
        tools.set(definition.name, definition)
        return () => {}
      },
    },
  }, { minIntervalMs: 1, retryDelayMs: 1, ...config })
  return tools
}

/**
 * Run one scenario with its own plugin instance and transport. `routes` maps a
 * URL to a response builder; `body` receives the mounted tools.
 * @returns the body's value together with every request the scenario made.
 */
async function scenario({ config = {}, routes, body }) {
  const tools = mount(config)
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const builder = routes[String(url)]
    if (builder === undefined) throw new Error(`unexpected request to ${url}`)
    return builder(init)
  }
  try {
    const value = await body(tools, calls)
    return { value, calls }
  } finally {
    globalThis.fetch = previousFetch
  }
}

const json = value => () => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const status = (code, headers = {}) => () => new Response('{}', { status: code, headers })

const envelope = data => ({ status: 'success', code: 200, message: 'Success', data })

const record = (overrides = {}) => ({
  goodsId: 'AbC-123_item',
  title: '测试商品 16G+512G',
  sourceType: 1,
  sourceTypeName: '天猫',
  shopName: '测试旗舰店',
  originalPrice: '199',
  actualPrice: '99.9',
  couponPrice: '0',
  monthSales: '2万+',
  salesStr: '销量2万+',
  favorableRate: '100%',
  picUrl: 'https://img.example/1.jpg',
  tagList: ['包邮'],
  commission: '0.37',
  ...overrides,
})

/** Run one tool and refuse a value its own output schema rejects. */
const run = async (tool, args, signal = new AbortController().signal) => {
  const value = await tool.execute(args, { signal })
  const violations = validateJsonSchemaValue(tool.output.schema, value)
  if (violations.length > 0) throw new Error(`tool value: ${violations.join('; ')}`)
  return value
}
const fail = value => value.ok === false
const form = init => new URLSearchParams(init.body)

// ── load as the Loader would ────────────────────────────────────────────────

check('exports a function plugin form (name/inject/apply, no default)',
  typeof plugin.name === 'string' && Array.isArray(plugin.inject) && typeof plugin.apply === 'function'
  && plugin.default === undefined,
  `name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`)

{
  const tools = mount({})
  check('registers four tools with unique names', tools.size === 4 && new Set(tools.keys()).size === 4,
    [...tools.keys()].join(','))
}

// ── channels ────────────────────────────────────────────────────────────────

await scenario({
  routes: {},
  body: async (tools) => {
    const value = await run(tools.get('taobao_channels'), {})
    check('channels lists every channel and issues no request',
      value.channels.length === 7 && value.channels[0].channel === '淘宝/天猫' && value.channels.at(-1).channel === '快手')
    check('channels reports no affiliate code by default', value.affiliate.invite_code_in_links === false)
  },
})

// ── search: success, trimming, schema ───────────────────────────────────────

await scenario({
  routes: {
    [SEARCH]: json(envelope([record(), record({ sourceType: 2, sourceTypeName: '京东', actualPrice: '' })])),
  },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_search'), { keyword: '测试商品', source: 0 })
    check('search returns ok for a success envelope', value.ok === true, JSON.stringify(value).slice(0, 160))
    check('search keeps prices as numbers', value.items[0].actual_price === 99.9 && value.items[0].original_price === 199)
    check('search maps a blank price to null rather than 0', value.items[1].actual_price === null)
    check('search reports per-channel coverage',
      value.coverage.length === 7 && value.coverage[0].records === 1 && value.coverage[2].status === 'no_results')
    check('search does not leak commission into list items', value.items.every(item => !('commission' in item)))
    check('search sends source and page in the form body',
      form(calls[0].init).get('sourceType') === '0' && form(calls[0].init).get('page') === '1')
    check('search sends the app identity headers',
      calls[0].init.headers['user-agent'].startsWith('MaiShouApp/') && calls[0].init.headers.openid === '564bdce0fa408fc9e1d5d42fd022ef0b')
  },
})

// ── search: the page argument reaches the remote ────────────────────────────

await scenario({
  routes: { [SEARCH]: json(envelope([])) },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_search'), { keyword: 'x', source: 1, page: 3 })
    check('search reports no results as ok with no_results coverage',
      value.ok === true && value.available_count === 0 && value.coverage[0].status === 'no_results')
    check('search forwards a non-default page (regression: the original script hardcoded page 1)',
      form(calls[0].init).get('page') === '3' && value.page === 3)
  },
})

// ── search: a failed envelope is not "no results" ───────────────────────────

await scenario({
  routes: { [SEARCH]: json({ status: 'fail', code: 500, message: '未授权', data: null }) },
  body: async (tools) => {
    const value = await run(tools.get('taobao_search'), { keyword: 'x' })
    check('search maps a failed envelope to upstream_error carrying the remote message',
      fail(value) && value.error.code === 'upstream_error' && value.error.message.includes('未授权'),
      JSON.stringify(value))
  },
})

// ── retry then backoff ──────────────────────────────────────────────────────

await scenario({
  config: { pauseNetworkMs: 60_000 },
  routes: { [SEARCH]: () => new Response('oops', { status: 503 }) },
  body: async (tools, calls) => {
    const first = await run(tools.get('taobao_search'), { keyword: 'x' })
    check('exhausted 5xx becomes upstream_unavailable with retry_at',
      fail(first) && first.error.code === 'upstream_unavailable' && typeof first.error.retry_at === 'string')
    check('a 5xx is retried exactly once before failing', calls.length === 2, `${calls.length} requests`)
    const second = await run(tools.get('taobao_search'), { keyword: 'x' })
    check('the backoff blocks the next call without issuing a request',
      second.error.code === 'temporarily_blocked' && calls.length === 2, `${calls.length} requests`)
  },
})

await scenario({
  config: { pauseForbiddenMs: 1_000 },
  routes: { [SEARCH]: status(403) },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_search'), { keyword: 'x' })
    check('403 becomes access_denied and is not retried',
      value.error.code === 'access_denied' && calls.length === 1, `${calls.length} requests`)
  },
})

await scenario({
  config: { pauseDefaultMs: 5_000 },
  routes: { [SEARCH]: status(429, { 'retry-after': '2' }) },
  body: async (tools) => {
    const value = await run(tools.get('taobao_search'), { keyword: 'x' })
    check('429 becomes rate_limited with a retry time',
      value.error.code === 'rate_limited' && typeof value.error.retry_at === 'string')
  },
})

await scenario({
  routes: { [SEARCH]: () => new Response('<html>', { status: 200 }) },
  body: async (tools) => {
    const value = await run(tools.get('taobao_search'), { keyword: 'x' })
    check('a non-JSON 200 becomes upstream_error rather than throwing', value.error.code === 'upstream_error')
  },
})

// ── caller cancellation propagates ──────────────────────────────────────────

// A real cancellation arrives while a request is in flight: the transport
// hangs until the caller's signal aborts, exactly as `fetch` does.
await scenario({
  routes: {
    [SEARCH]: init => new Promise((_resolve, reject) => {
      const signal = init.signal
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    }),
  },
  body: async (tools, calls) => {
    const controller = new AbortController()
    const pending = run(tools.get('taobao_search'), { keyword: 'x' }, controller.signal)
    controller.abort()
    const outcome = await pending.then(() => 'resolved', error => error.name)
    check('caller cancellation propagates instead of becoming a backoff',
      outcome === 'AbortError' && calls.length === 1, `${outcome} after ${calls.length} request(s)`)
  },
})

// ── compare: per-channel isolation and verdict ──────────────────────────────

// A channel that merely returns no records is isolated: the comparison goes on.
await scenario({
  routes: {
    [SEARCH]: init => {
      const source = form(init).get('sourceType')
      if (source === '3') return json(envelope([]))()
      const price = source === '1' ? '120' : '88'
      return json(envelope([record({ sourceType: Number(source), actualPrice: price, goodsId: `id-${source}` })]))()
    },
  },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_compare'), { keyword: '测试商品', platforms: [1, 3, 2] })
    const bySource = new Map(value.coverage.map(entry => [entry.source, entry]))
    check('compare issues one request per selected channel', calls.length === 3, `${calls.length} requests`)
    check('compare isolates a channel that returned no records',
      bySource.get(3).status === 'no_results' && bySource.get(1).status === 'ok' && bySource.get(2).status === 'ok')
    check('compare ranks by actual price across channels, keeping the record\'s own source',
      value.items.map(item => item.source).join(',') === '2,1', value.items.map(item => item.source).join(','))
    check('compare calls a comparison with an empty channel partial', value.verdict === 'partial')
    check('the summary reports the lowest observed record with its channel and id',
      value.summary.lowest_observed.actual_price === 88 && value.summary.lowest_observed.goods_id === 'id-2')
    check('the verdict note names the empty channel rather than counting it',
      value.verdict_note.includes('拼多多 returned no records'), value.verdict_note)
  },
})

// A 403 refuses the whole process, so the remaining channels are reported as
// not attempted rather than as individual failures.
await scenario({
  routes: {
    [SEARCH]: init => {
      const source = form(init).get('sourceType')
      if (source === '2') return status(403)()
      return json(envelope([record({ sourceType: Number(source), actualPrice: '120', goodsId: `id-${source}` })]))()
    },
  },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_compare'), { keyword: '测试商品', platforms: [1, 2, 4] })
    const bySource = new Map(value.coverage.map(entry => [entry.source, entry]))
    check('a channel 403 is recorded with its error', bySource.get(2).status === 'access_denied' && bySource.get(2).error?.code === 'access_denied')
    check('channels after a refusal are reported as not attempted',
      bySource.get(4).status === 'not_attempted' && value.summary.platforms_not_attempted === 1)
    check('a refusal stops issuing further channel requests', calls.length === 2, `${calls.length} requests`)
    check('a refusal makes the comparison partial', value.verdict === 'partial' && value.summary.platforms_failed === 1)
    check('the verdict note names the refusal instead of claiming the lowest price',
      value.verdict_note.includes('refused') && value.verdict_note.includes('do not call'), value.verdict_note)
  },
})

await scenario({
  routes: {
    [SEARCH]: init => {
      const source = form(init).get('sourceType')
      return json(envelope([record({ sourceType: Number(source), actualPrice: String(100 + Number(source)) })]))()
    },
  },
  body: async (tools) => {
    const value = await run(tools.get('taobao_compare'), { keyword: 'x', platforms: [1, 2, 5] })
    check('compare reports verdict all only when every channel answered',
      value.verdict === 'all' && value.summary.lowest_observed.source === 1)
    check('compare includes commission for detail follow-ups', value.items.every(item => typeof item.commission === 'number'))
  },
})

await scenario({
  config: { compareMaxPagesPerPlatform: 3 },
  routes: {
    [SEARCH]: init => {
      const pars = form(init)
      const page = pars.get('page')
      const source = Number(pars.get('sourceType'))
      return json(envelope(page === '2' && source === 7
        ? []
        : [record({ sourceType: source, actualPrice: String(Number(page) * 10) })]))()
    },
  },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_compare'), { keyword: 'x', platforms: [7], pages: 2 })
    check('compare issues one request per page', calls.length === 2, `${calls.length} requests`)
    check('compare keeps the records of every requested page',
      value.coverage[0].records === 1 && value.coverage[0].status === 'ok', JSON.stringify(value.coverage))
  },
})

// ── detail: links, id re-encoding, disclosure ───────────────────────────────

await scenario({
  config: { inviteCode: 'testcode' },
  routes: {
    [DETAIL]: json(envelope(record({ goodsId: 'ReEncoded_Id', levelOneCategoryName: '电脑外设' }))),
    [TARGET]: json(envelope({ appUrl: 'https://m.tb.cn/x', kl: '/ CZ3457 abc' })),
  },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_detail'), { goods_id: 'AbC-123_item', source: 1 })
    check('detail returns the purchase link and share code',
      value.links.available === true && value.links.app_url === 'https://m.tb.cn/x' && value.links.share_code === '/ CZ3457 abc')
    check('detail keeps the queried id and flags a re-encoded id',
      value.queried.goods_id === 'AbC-123_item' && value.item.goods_id === 'ReEncoded_Id' && value.id_changed === true)
    check('detail includes commission and the affiliate disclosure',
      value.item.commission === 0.37 && value.affiliate.notice.length > 0)
    check('detail sends the configured invite code to the share endpoint',
      JSON.parse(calls[1].init.body).inviteCode === 'testcode')
  },
})

await scenario({
  config: { inviteCode: '' },
  routes: { [DETAIL]: json(envelope(record())), [TARGET]: json(envelope({ appUrl: 'https://m.tb.cn/y' })) },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_detail'), { goods_id: 'AbC-123_item', source: 1 })
    check('an empty inviteCode drops attribution and the disclosure',
      value.affiliate.invite_code_in_links === false && value.affiliate.notice === null)
    check('an empty inviteCode is forwarded as empty', JSON.parse(calls[1].init.body).inviteCode === '')
  },
})

await scenario({
  routes: { [DETAIL]: json(envelope(record())), [TARGET]: status(503) },
  config: { pauseNetworkMs: 10_000 },
  body: async (tools) => {
    const value = await run(tools.get('taobao_detail'), { goods_id: 'AbC-123_item', source: 1 })
    check('a failed share-link request still returns the item with an explanatory note',
      value.ok === true && value.links.available === false && value.links.note.includes('upstream_unavailable'),
      JSON.stringify(value.links))
  },
})

await scenario({
  routes: { [DETAIL]: json(envelope(record())) },
  body: async (tools, calls) => {
    const value = await run(tools.get('taobao_detail'), { goods_id: 'AbC-123_item', source: 1, include_links: false })
    check('include_links false skips the share-link request',
      value.links.note.includes('not requested') && calls.length === 1, `${calls.length} requests`)
  },
})

await scenario({
  routes: { [DETAIL]: json(envelope({})) },
  body: async (tools) => {
    const value = await run(tools.get('taobao_detail'), { goods_id: 'AbC-123_item', source: 1 })
    check('an empty detail body becomes not_found', value.error.code === 'not_found')
  },
})

// ── argument validation throws ──────────────────────────────────────────────

{
  const tools = mount({})
  const cases = [
    ['taobao_search', {}],
    ['taobao_search', { keyword: '   ' }],
    ['taobao_search', { keyword: 'x', source: 9 }],
    ['taobao_search', { keyword: 'x', limit: 999 }],
    ['taobao_compare', { keyword: 'x', platforms: [6] }],
    ['taobao_compare', { keyword: 'x', platforms: [] }],
    ['taobao_compare', { keyword: 'x', pages: 0 }],
    ['taobao_detail', { goods_id: 'x' }],
    ['taobao_detail', { goods_id: 'x', source: 0 }],
    ['taobao_detail', { goods_id: 'x y', source: 1 }],
    ['taobao_detail', { goods_id: 42, source: 1 }],
  ]
  const rejected = []
  for (const [name, args] of cases) {
    const outcome = await run(tools.get(name), args).then(() => 'resolved', error => error.name)
    if (outcome === 'TaobaoUsageError') rejected.push(`${name}${JSON.stringify(args)}`)
  }
  check('every invalid argument throws TaobaoUsageError', rejected.length === cases.length,
    `${rejected.length}/${cases.length}`)
}

// ── presentation is pure and total ──────────────────────────────────────────

{
  const tools = mount({})
  const view = tools.get('taobao_search').presentCall({ keyword: '机械键盘', source: 2 })
  check('presentCall projects only presentable arguments',
    view.rawInput.keyword === '机械键盘' && view.rawInput.source === 2)
  check('presentCall never throws on arbitrary playback arguments',
    tools.get('taobao_detail').presentCall(null) !== undefined && tools.get('taobao_detail').presentCall('junk') !== undefined)
}

// ── configuration fails loud ────────────────────────────────────────────────

{
  const rejects = (config) => {
    try {
      plugin.apply({ tools: { register: () => () => {} } }, config)
      return false
    } catch {
      return true
    }
  }
  check('unknown config key fails the load', rejects({ nope: 1 }))
  check('non-positive interval fails the load', rejects({ minIntervalMs: 0 }))
  check('an invalid invite code fails the load', rejects({ inviteCode: 'a b' }))
  check('a default limit above its cap fails the load', rejects({ searchDefaultLimit: 10, searchMaxLimit: 5 }))
  check('non-boolean discloseAffiliate fails the load', rejects({ discloseAffiliate: 'yes' }))
  check('empty config loads with defaults', !rejects(undefined))
}

console.log(failures.length === 0 ? '\nall behaviour checks passed' : `\n${failures.length} check(s) failed`)
process.exitCode = failures.length === 0 ? 0 : 1

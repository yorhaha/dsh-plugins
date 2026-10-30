/**
 * Deterministic behaviour checks for the dsh-v2ex bundle: a scripted global
 * `fetch` drives the failure, retry, backoff, and trimming paths that the
 * live API cannot produce on demand. Each scenario mounts a fresh plugin, so
 * one scenario's process-local backoff cannot leak into the next.
 *
 * Every scripted entry is a builder, because a `Response` body can be read
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

function mount(config = {}) {
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

/** Install a scripted transport built fresh on every request. */
function scriptFetch(builders) {
  const calls = []
  let index = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, redirect: init.redirect, method: init.method })
    return builders[Math.min(index++, builders.length - 1)]()
  }
  return calls
}

const body = (text, init = {}) => () => new Response(text, init)
const json = (value, init = {}) => () => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json', ...init.headers },
  ...init,
})
const status = (code, init = {}) => () => new Response(`status ${code}`, { status: code, ...init })

/** One list row with every required field. */
const topicRow = (overrides = {}) => ({
  id: 1, title: 't', content: 'c', replies: 0, last_touched: 1, node: null, member: null, ...overrides,
})

let label = ''
let calls
let value

async function run(name, args, config) {
  const tools = mount(config)
  const tool = tools.get(name)
  const outcome = await tool.execute(args, { signal: new AbortController().signal })
  const violations = validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(outcome)), 'value')
  check(`${label} value matches output.schema`, violations.length === 0, violations.join('; '))
  return outcome
}

// ── request construction ────────────────────────────────────────────────────

label = 'node request'
calls = scriptFetch([json([topicRow({ node: { name: 'python', title: 'Python' }, member: { username: 'u', id: 7 } })])])
value = await run('v2ex_node', { node_name: 'python' })
check('node request URL and parameters', calls[0].url === 'https://www.v2ex.com/api/topics/show.json?node_name=python&page=1', calls[0].url)
check('requests are GET without following redirects', calls[0].method === 'GET' && calls[0].redirect === 'manual')
check('requests carry the configured User-Agent', calls[0].headers['user-agent'] === 'dsh-v2ex/0.1', calls[0].headers['user-agent'])
check('a topic list is trimmed to the model-facing fields',
  value.ok === true && value.items[0].url === 'https://www.v2ex.com/t/1' && value.items[0].author.id === '7')

// ── retries and backoff ─────────────────────────────────────────────────────

label = '500 then success'
calls = scriptFetch([status(500), json([topicRow({ id: 2 })])])
value = await run('v2ex_hot', {})
check('a single 5xx is retried and the retry result is returned', value.ok === true && calls.length === 2, `${calls.length} requests`)

label = 'repeated 5xx'
calls = scriptFetch([status(500)])
const backoffTools = mount({ pauseNetworkMs: 60000 })
value = await backoffTools.get('v2ex_hot').execute({}, { signal: new AbortController().signal })
check('a repeated 5xx maps to upstream_unavailable', value.ok === false && value.error.code === 'upstream_unavailable', JSON.stringify(value.error))
check('the failure is retryable and carries a retry time',
  value.error.retryable === true && typeof value.error.retry_at === 'string', value.error.retry_at)
check('a repeated 5xx is retried exactly once', calls.length === 2, `${calls.length} requests`)

const blocked = await backoffTools.get('v2ex_hot').execute({}, { signal: new AbortController().signal })
check('a later call on the same client is refused by process-local backoff',
  blocked.ok === false && blocked.error.code === 'temporarily_blocked' && blocked.error.retryable === true,
  JSON.stringify(blocked.error))
check('refusing a call does not extend the existing backoff',
  blocked.error.retry_at === value.error.retry_at
  && new Date(blocked.error.retry_at).getTime() > Date.now() + 50_000,
  `${value.error.retry_at} then ${blocked.error.retry_at}`)

label = 'network error'
calls = scriptFetch([() => { throw new TypeError('fetch failed') }])
value = await run('v2ex_hot', {}, { pauseNetworkMs: 60000 })
check('a transport failure maps to network_error after one retry',
  value.ok === false && value.error.code === 'network_error' && calls.length === 2, JSON.stringify(value.error))

label = 'timeout'
calls = scriptFetch([() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }])
value = await run('v2ex_hot', {}, { pauseNetworkMs: 60000 })
check('a timeout maps to timeout after one retry', value.ok === false && value.error.code === 'timeout', JSON.stringify(value.error))

// ── status handling ─────────────────────────────────────────────────────────

label = '403'
calls = scriptFetch([status(403)])
value = await run('v2ex_hot', {}, { pauseForbiddenMs: 3600000 })
check('403 maps to access_denied without a retry', value.ok === false && value.error.code === 'access_denied' && calls.length === 1, JSON.stringify(value.error))

label = '429'
calls = scriptFetch([status(429, { headers: { 'retry-after': '120' } })])
value = await run('v2ex_hot', {})
check('429 maps to rate_limited and honours Retry-After',
  value.ok === false && value.error.code === 'rate_limited'
  && new Date(value.error.retry_at).getTime() - Date.now() > 110_000,
  `${value.error.code} at ${value.error.retry_at}`)

label = 'unexpected status'
calls = scriptFetch([status(301, { headers: { location: 'https://example.com' } })])
value = await run('v2ex_hot', {})
check('an unfollowed redirect maps to invalid_response', value.ok === false && value.error.code === 'invalid_response', JSON.stringify(value.error))

// ── body handling ───────────────────────────────────────────────────────────

label = 'non-JSON body'
calls = scriptFetch([body('<html>nope</html>')])
value = await run('v2ex_hot', {})
check('a non-JSON body maps to invalid_response', value.ok === false && value.error.code === 'invalid_response', JSON.stringify(value.error))

label = 'wrong structure'
calls = scriptFetch([json({ topics: [] })])
value = await run('v2ex_hot', {})
check('a non-array body maps to invalid_response', value.ok === false && value.error.code === 'invalid_response', JSON.stringify(value.error))

label = 'oversized body'
calls = scriptFetch([json([topicRow({ title: 'x'.repeat(2000) })])])
value = await run('v2ex_hot', {}, { responseLimitBytes: 512 })
check('a body above the read limit maps to response_too_large',
  value.ok === false && value.error.code === 'response_too_large', JSON.stringify(value.error))

label = 'bad field'
calls = scriptFetch([json([topicRow({ replies: true })])])
value = await run('v2ex_hot', {})
check('a boolean where a count belongs maps to invalid_response',
  value.ok === false && value.error.code === 'invalid_response', JSON.stringify(value.error))

label = 'unrepresentable timestamp'
calls = scriptFetch([json([topicRow({ last_touched: 1e18 })])])
value = await run('v2ex_hot', {})
check('an out-of-range timestamp maps to invalid_response',
  value.ok === false && value.error.code === 'invalid_response', JSON.stringify(value.error))

// ── accepted remote forms ───────────────────────────────────────────────────

label = 'string counts'
calls = scriptFetch([json([topicRow({
  id: '5', content: null, replies: '3', last_touched: '1700000000',
  node: { name: 'qna', title: 'Q&A' }, member: { username: 'u' },
})])])
value = await run('v2ex_hot', {})
check('decimal-string counts and a null body are accepted',
  value.ok === true && value.items[0].replies === 3 && value.items[0].content_excerpt === ''
  && value.items[0].last_touched === '2023-11-14T22:13:20Z' && value.items[0].node.name === 'qna',
  JSON.stringify(value.items[0] ?? value.error))

// ── trimming ────────────────────────────────────────────────────────────────

label = 'excerpt trimming'
calls = scriptFetch([json([topicRow({ content: '中'.repeat(50) })])])
value = await run('v2ex_hot', {}, { excerptChars: 10 })
check('the excerpt is cut to the configured character budget and flagged',
  value.items[0].content_excerpt === '中'.repeat(10) && value.items[0].content_chars === 50 && value.items[0].content_truncated === true,
  JSON.stringify({ excerpt: value.items[0].content_excerpt.length, chars: value.items[0].content_chars }))

label = 'surrogate pairs'
calls = scriptFetch([json([topicRow({ id: 9, content: '😀'.repeat(20), created: 1, last_modified: 1 })])])
value = await run('v2ex_topic', { topic_id: 9 }, { topicContentChars: 3 })
check('truncation counts characters, not UTF-16 units, and never splits a pair',
  value.ok === true && value.content === '😀😀😀' && value.content_chars === 20 && value.content_truncated === true,
  JSON.stringify({ content: value.content, chars: value.content_chars }))

label = 'reply trimming'
calls = scriptFetch([json([{ id: 9, topic_id: 9, content: 'abcdefghij', created: 2, last_modified: 3, member: null }])])
value = await run('v2ex_replies', { topic_id: 9 }, { replyContentChars: 4 })
check('a reply body is cut to its own budget',
  value.ok === true && value.items[0].content === 'abcd' && value.items[0].content_truncated === true && value.items[0].content_chars === 10,
  JSON.stringify(value.items[0] ?? value.error))

// ── reply ordering and the empty-list caveat ────────────────────────────────

const replyRows = [3, 1, 2].map(created => ({ id: created, topic_id: 9, content: `r${created}`, created, last_modified: created, member: { username: 'u' } }))

calls = scriptFetch([json(replyRows)])
value = await run('v2ex_replies', { topic_id: 9, limit: 2, order: 'latest' })
check('latest returns the newest replies, newest first',
  value.items.map(item => item.content).join(',') === 'r3,r2', JSON.stringify(value.items.map(item => item.content)))

calls = scriptFetch([json(replyRows)])
value = await run('v2ex_replies', { topic_id: 9, limit: 2, order: 'oldest' })
check('oldest returns the earliest replies, oldest first',
  value.items.map(item => item.content).join(',') === 'r1,r2', JSON.stringify(value.items.map(item => item.content)))

calls = scriptFetch([json([])])
value = await run('v2ex_replies', { topic_id: 9 })
check('an empty reply list carries the ambiguity caveat',
  value.ok === true && value.available_count === 0 && typeof value.note === 'string', value.note)

const repliesDescription = mount({}).get('v2ex_replies').description
check('the reply-list description states that the endpoint does not paginate',
  repliesDescription.includes('no pagination'), repliesDescription)

// ── rate-limit watermark ────────────────────────────────────────────────────

label = 'rate limit watermark'
calls = scriptFetch([json([], { headers: { 'x-rate-limit-remaining': '5', 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 3600) } })])
const watermarkTools = mount({ rateLimitWatermark: 60 })
value = await watermarkTools.get('v2ex_hot').execute({}, { signal: new AbortController().signal })
check('a low remaining allowance is reported as a warning on the value',
  value.ok === true && typeof value.snapshot.warning === 'string', JSON.stringify(value.snapshot))

const afterWatermark = await watermarkTools.get('v2ex_latest').execute({}, { signal: new AbortController().signal })
check('the watermark pauses this process until the allowance resets',
  afterWatermark.ok === false && afterWatermark.error.code === 'temporarily_blocked', JSON.stringify(afterWatermark.error))

// ── cache status ────────────────────────────────────────────────────────────

label = 'cached value'
calls = scriptFetch([json([topicRow()], { headers: { age: '600', 'x-rate-limit-remaining': '900' } })])
value = await run('v2ex_hot', {})
check('a value served from cache reports its age, status, and allowance, and omits the warning',
  value.ok === true && value.snapshot.cache_status === 'cached' && value.snapshot.cache_age_seconds === 600
  && value.snapshot.rate_limit_remaining === 900 && value.snapshot.warning === undefined,
  JSON.stringify(value.snapshot))
check('a snapshot carries fields instead of caveat prose',
  value.snapshot.note === undefined, JSON.stringify(value.snapshot))

label = 'fresh value'
calls = scriptFetch([json([topicRow()], { headers: { age: '0' } })])
value = await run('v2ex_hot', {})
check('a zero cache age reports fresh',
  value.ok === true && value.snapshot.cache_status === 'fresh' && value.snapshot.cache_age_seconds === 0,
  JSON.stringify(value.snapshot ?? value.error))

label = 'unstated value'
calls = scriptFetch([json([topicRow()])])
value = await run('v2ex_hot', {})
check('a missing Age header reports unknown rather than fresh',
  value.ok === true && value.snapshot.cache_status === 'unknown' && value.snapshot.cache_age_seconds === null,
  JSON.stringify(value.snapshot ?? value.error))

// ── configuration validation ────────────────────────────────────────────────

function expectConfigError(config, contains, text) {
  try {
    mount(config)
    check(text, false, 'no error thrown')
  } catch (error) {
    check(text, error.message.includes(contains), error.message)
  }
}

expectConfigError({ minIntervalMs: 0 }, 'config.minIntervalMs must be a positive integer', 'rejects a non-positive integer')
expectConfigError({ listDefaultLimit: 100 }, 'must not exceed', 'rejects a default above its cap')
expectConfigError({ nope: 1 }, 'unknown config key', 'rejects an unknown key')
expectConfigError({ userAgent: '  ' }, 'config.userAgent', 'rejects a blank User-Agent')

const custom = mount({ userAgent: 'custom/9', listMaxLimit: 2, listDefaultLimit: 2 })
check('a custom cap reaches the tool schema',
  custom.get('v2ex_hot').parameters.properties.limit.description.includes('1 to 2'),
  custom.get('v2ex_hot').parameters.properties.limit.description)

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join(' | ')}`}`)
process.exitCode = failures.length === 0 ? 0 : 1

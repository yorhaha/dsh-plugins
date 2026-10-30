/**
 * Deterministic behaviour checks for the dsh-zhihu bundle.
 *
 * A scripted global `fetch` drives every status, page shape, and refusal that
 * the live service cannot produce on demand. Each scenario mounts a fresh
 * plugin, so one scenario's pacing state, backoff, or cache cannot leak into
 * the next.
 *
 * Offline: run `node tests/verify-behavior.mjs` from the plugin directory after
 * `pnpm install`.
 */
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as plugin from '../index.js'
import { resolveConfig } from '../src/config.js'
import { CookieError, describeCookie, normalizeCookie, parseCookieString } from '../src/cookie.js'
import { readCookie, writeCookie } from '../src/credentials.js'
import { htmlToText, readInitialState } from '../src/html.js'
import { parseJsonPreservingIds } from '../src/json.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** A cookie string that satisfies the two required names. */
const COOKIE = 'z_c0=fake-session; d_c0=fake-device; _xsrf=abc'

/** The account `/api/v4/me` returns. */
const ACCOUNT = {
  id: '00000000000000000000000000000000',
  url_token: 'example-user',
  name: 'Example User',
  headline: 'Example headline',
  answer_count: 1,
  articles_count: 2,
  question_count: 0,
  voteup_count: 3,
  thanked_count: 0,
  favorite_count: 0,
  ip_info: 'IP 属地示例',
}

/** One complete question state, as its page embeds it. */
function questionState() {
  return {
    entities: {
      questions: {
        19550517: {
          id: '19550517',
          title: 'Instagram 有多少用户？',
          detail: '<p>问题详情</p>',
          answerCount: '6',
          followerCount: '50',
          commentCount: '0',
          created: '1292996146',
          updatedTime: '1292996146',
          author: { id: 'u1', urlToken: 'author-one', name: '示例作者', headline: '示例简介' },
          topics: [{ name: '互联网' }, { name: 'Instagram' }],
        },
      },
      answers: {
        14204568: {
          id: '14204568',
          type: 'answer',
          content: '<p>1500 万。</p><p>这是第二段。</p>',
          excerpt: '1500 万。',
          voteupCount: '3',
          commentCount: '1',
          createdTime: '1334057938',
          updatedTime: '1334057938',
          author: { id: 'u2', urlToken: 'author-two', name: '示例答主', headline: '示例简介二' },
          question: { id: '19550517', title: 'Instagram 有多少用户？' },
        },
      },
      users: {},
    },
    question: {
      answers: {
        19550517: { ids: [{ type: 'question_feed_card', target: '14204568' }], antiSpider: false },
      },
    },
  }
}

/** One complete article state, as a zhuanlan page embeds it. */
function articleState() {
  return {
    entities: {
      articles: {
        '2062869046270353592': {
          id: '2062869046270353592',
          title: '2607.14530 xHC',
          content: '<p>这篇论文深入探讨了残差流的扩展。</p>',
          excerpt: '这篇论文深入探讨了残差流的扩展。',
          voteupCount: '0',
          commentCount: '0',
          created: '1784607030',
          updated: '1784607030',
          author: { id: 'u1' },
        },
      },
      users: { u1: { id: 'u1', urlToken: 'example-user', name: 'Example User', headline: 'Example headline' } },
    },
  }
}

/** Wrap an `initialState` in the minimal page a Zhihu response carries. */
function pageHtml(initialState) {
  return `<!doctype html><html><head></head><body><div id="root"></div><script id="js-initialData" type="text/json">${JSON.stringify({ initialState })}</script></body></html>`
}

/** Build a response body builder: a `Response` body can be read once. */
const text = (body, init = {}) => () => new Response(body, init)
const json = (value, init = {}) => () => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
  ...init,
})
const html = (initialState) => () => new Response(pageHtml(initialState), {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
})
const status = (code, init = {}) => () => new Response(`status ${code}`, { status: code, ...init })
const redirect = (location) => () => new Response('', { status: 301, headers: { location } })

/** Install a scripted transport, returning the calls it saw. */
function scriptFetch(builders) {
  const calls = []
  let index = 0
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init.headers,
      redirect: init.redirect,
      method: init.method,
      at: Date.now(),
    })
    const builder = builders[Math.min(index, builders.length - 1)]
    index += 1
    return builder(String(url), init)
  }
  return calls
}

/** A credentials service holding at most one record. */
function fakeProvider(cookie) {
  const records = new Map()
  if (cookie !== null) {
    records.set('zhihu/default', {
      kind: 'grant',
      payload: { cookie, saved_at: '2026-01-01T00:00:00Z' },
    })
  }
  return {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, body) {
      const value = await body()
      records.set(key, value)
      return value
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }
}

/**
 * Mount the plugin with a scripted fetch and, when possible, its route.
 * @param options - config overrides and the stored cookie.
 * @returns the registered tools, routes, and credentials.
 */
function mount({ config = {}, cookie = COOKIE, provider } = {}) {
  const tools = new Map()
  const routes = []
  let captured = null
  const credentials = provider ?? fakeProvider(cookie)
  const ctx = {
    tools: {
      register(definition) {
        assertSupportedJsonSchema(definition.parameters)
        assertSupportedJsonSchema(definition.output.schema)
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    credentials,
    inject(names, fn) {
      captured = { names, fn }
      return () => {}
    },
  }
  plugin.apply(ctx, { minIntervalMs: 1, retryDelayMs: 1, ...config })
  if (captured !== null) {
    captured.fn({
      effect(fn) {
        return fn()
      },
      connection: {
        fetch: {
          register(spec) {
            routes.push(spec)
            return () => {}
          },
        },
      },
    })
  }
  return { tools, routes, credentials }
}

/** Execute one tool and validate its value against its declared output. */
async function run(tools, name, args = {}, { signal } = {}) {
  const tool = tools.get(name)
  const value = await tool.execute(args, { signal: signal ?? new AbortController().signal })
  const violations = validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value)), 'value')
  check(`${name} value matches output.schema`, violations.length === 0, violations.join('; '))
  return value
}

/** Dispatch one bridge request. */
async function bridge(routes, method, body) {
  const request = new Request('http://127.0.0.1/api/plugin-zhihu', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await routes[0].fetch(request)
  return { status: response.status, body: await response.json() }
}

// ── configuration ───────────────────────────────────────────────────────────

check('defaults resolve', resolveConfig().minIntervalMs === 3_000)
check('retryAttempts may be zero', resolveConfig({ retryAttempts: 0 }).retryAttempts === 0)
check('unknown config key fails', (() => {
  try {
    resolveConfig({ nope: 1 })
    return false
  } catch (error) {
    return /unknown config key "nope"/.test(error.message)
  }
})())
check('out-of-range field fails', (() => {
  try {
    resolveConfig({ retryAttempts: 4 })
    return false
  } catch (error) {
    return /retryAttempts/.test(error.message)
  }
})())
check('default limit above maximum fails', (() => {
  try {
    resolveConfig({ listDefaultLimit: 5, listMaxLimit: 2 })
    return false
  } catch (error) {
    return /listDefaultLimit/.test(error.message)
  }
})())
check('a tool timeout that cannot cover a request fails', (() => {
  try {
    resolveConfig({ toolTimeoutMs: 10_000, requestTimeoutMs: 20_000 })
    return false
  } catch (error) {
    return /toolTimeoutMs/.test(error.message)
  }
})())

// ── cookie ──────────────────────────────────────────────────────────────────

check('cookie normalizes and drops duplicates', normalizeCookie('Cookie: z_c0=a; d_c0=b; z_c0=c') === 'z_c0=c; d_c0=b')
check('cookie parses to a map', [...parseCookieString(COOKIE).keys()].join(',') === 'z_c0,d_c0,_xsrf')
check('missing z_c0 is refused', (() => {
  try {
    normalizeCookie('d_c0=b')
    return false
  } catch (error) {
    return error instanceof CookieError && /z_c0/.test(error.message)
  }
})())
check('missing d_c0 is refused', (() => {
  try {
    normalizeCookie('z_c0=a')
    return false
  } catch (error) {
    return error instanceof CookieError && /d_c0/.test(error.message)
  }
})())
check('a newline is refused', (() => {
  try {
    normalizeCookie('z_c0=a\r\nX: y; d_c0=b')
    return false
  } catch (error) {
    return error instanceof CookieError && /newline/.test(error.message)
  }
})())
check('an empty value is refused', (() => {
  try {
    normalizeCookie('z_c0=; d_c0=b')
    return false
  } catch (error) {
    return error instanceof CookieError && /empty value/.test(error.message)
  }
})())
check('the page description never leaks the value', (() => {
  const described = JSON.stringify(describeCookie('z_c0=secret; d_c0=device'))
  return !described.includes('secret') && !described.includes('device') && described.includes('"names":2')
})())

// ── html ────────────────────────────────────────────────────────────────────

check('html keeps paragraphs and list structure', (() => {
  const textValue = htmlToText('<p>你好 &amp; 世界</p><p>第二段</p><ul><li>一</li><li>二</li></ul>')
  return textValue.includes('你好 & 世界') && textValue.includes('第二段') && textValue.includes('- 一')
})())
check('html keeps an equation image as its TeX', htmlToText('<p>x</p><img class="eeimg" alt="x^2">').includes('[公式] x^2'))
check('html drops scripts', htmlToText('<p>正文</p><script>alert(1)</script>') === '正文')
check('initial state is read', readInitialState(pageHtml({ entities: { questions: {} } }))?.entities?.questions !== undefined)
check('a page without state yields null', readInitialState('<html><body>no state</body></html>') === null)

// ── credentials ─────────────────────────────────────────────────────────────

{
  const provider = fakeProvider(null)
  const saved = await writeCookie(provider, 'default', COOKIE)
  const read = await readCookie(provider, 'default')
  check('the record sits under zhihu/default', provider.records.has('zhihu/default'))
  check('the record round-trips', read?.cookie === COOKIE && read?.saved_at === saved.saved_at)
  provider.records.set('zhihu/default', {
    kind: 'grant',
    payload: { cookie: COOKIE, saved_at: new Date('2026-10-30T11:03:58Z') },
  })
  const dated = await readCookie(provider, 'default')
  check('a Date saved_at is rendered as ISO text', dated?.saved_at === '2026-10-30T11:03:58Z', String(dated?.saved_at))
  provider.records.set('zhihu/default', { kind: 'grant', payload: { token: 'x' } })
  let foreign = false
  try {
    await readCookie(provider, 'default')
  } catch (error) {
    foreign = error.code === 'credential_invalid'
  }
  check('a foreign payload is reported', foreign)
}

// ── request construction and caching ────────────────────────────────────────

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools } = mount()
  const account = await run(tools, 'zhihu_me')
  check('the account is projected', account.account.name === 'Example User' && account.account.url_token === 'example-user')
  check('the me URL is the v4 endpoint', calls[0].url === 'https://www.zhihu.com/api/v4/me', calls[0].url)
  check('the stored cookie is sent', calls[0].headers.cookie === COOKIE)
  check('redirects are not followed', calls[0].redirect === 'manual' && calls[0].method === 'GET')
  check('the account value is fresh', account.snapshot.cached === false && account.snapshot.cache_age_seconds === 0)
  await run(tools, 'zhihu_me')
  check('an identical read is cached', calls.length === 1, `${calls.length} calls`)
  await run(tools, 'zhihu_me', { fresh: true })
  check('a fresh read bypasses the cache and refreshes it', calls.length === 2, `${calls.length} calls`)
}

// ── the hot list ────────────────────────────────────────────────────────────

{
  const hot = {
    fresh_text: '刚刚更新',
    data: [
      {
        detail_text: '2603 万热度',
        target: {
          id: '2099125476149274126',
          title: '如何看待红果短剧？',
          excerpt: '红果短剧跃升为国内第四大 app',
          answer_count: 749,
          follower_count: 1691,
          created: 1793250513,
          type: 'question',
        },
      },
      {
        detail_text: '100 万热度',
        target: { id: '19550517', title: '第二问', excerpt: '', answer_count: 2, follower_count: 1, created: 1292996146, type: 'question' },
      },
    ],
  }
  const calls = scriptFetch([json(hot)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_hot', { limit: 1 })
  check('the hot list keeps the requested count', value.returned_count === 1 && value.items.length === 1)
  check('a long question id stays exact', value.items[0].question_id === '2099125476149274126', value.items[0].question_id)
  check('the heat text is carried', value.items[0].detail_text === '2603 万热度')
  check('the hot URL asks for the total list', calls[0].url.includes('/api/v3/feed/topstory/hot-lists/total'), calls[0].url)
}

{
  const parsed = parseJsonPreservingIds('{"id":2099125476149274126,"n":12,"s":"x2099125476149274126"}')
  check('an unsafe integer id becomes its exact string', parsed.id === '2099125476149274126', String(parsed.id))
  check('a safe number stays a number', parsed.n === 12)
  check('digits inside a string are untouched', parsed.s === 'x2099125476149274126')
}

{
  // The wire really sends this id as a bare number; the fixture must too, so it
  // is written as raw JSON rather than built from a rounded JavaScript number.
  const raw = '{"fresh_text":"","data":[{"detail_text":"1 万热度","target":{"id":2099125476149274126,"title":"Q","excerpt":"","answer_count":1,"follower_count":1,"created":1,"type":"question"}}]}'
  const calls = scriptFetch([text(raw)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_hot', { limit: 1 })
  check('a numeric hot-list id keeps every digit', value.items[0].question_id === '2099125476149274126', value.items[0].question_id)
  check('the url follows the exact id', value.items[0].url === 'https://www.zhihu.com/question/2099125476149274126', value.items[0].url)
}

// ── questions and answers ───────────────────────────────────────────────────

{
  const calls = scriptFetch([html(questionState())])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_question', { question_id: '19550517' })
  check('the question page URL is the question path', calls[0].url === 'https://www.zhihu.com/question/19550517', calls[0].url)
  check('the question is projected', value.question.title === 'Instagram 有多少用户？')
  check('the question detail is text', value.question.detail === '问题详情')
  check('the topics are carried', value.question.topic_names.join(',') === '互联网,Instagram')
  check('the answer preview is projected', value.answers_preview.length === 1 && value.answers_preview[0].answer_id === '14204568')
}

{
  const feed = {
    data: [{
      type: 'question_feed_card',
      target: {
        type: 'answer',
        id: '14204568',
        content: '<p>1500 万。</p>',
        excerpt: '1500 万。',
        voteup_count: 3,
        comment_count: 1,
        created_time: 1334057938,
        updated_time: 1334057938,
        author: { id: 'u2', url_token: 'author-two', name: '示例答主', headline: '示例简介二' },
        question: { id: '19550517', title: 'Instagram 有多少用户？' },
      },
    }],
    paging: { is_end: false },
  }
  const calls = scriptFetch([json(feed)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_answers', { question_id: '19550517', limit: 1, order: 'created' })
  check('the answers URL carries order and include', calls[0].url.includes('order=created') && calls[0].url.includes('include='), calls[0].url)
  check('the answer content is text', value.items[0].content === '1500 万。')
  check('the answer keeps its question', value.items[0].question_id === '19550517' && value.items[0].question_title === 'Instagram 有多少用户？')
  check('paging fields follow the response', value.has_more === true && value.next_offset === 1)
}

{
  const calls = scriptFetch([html(questionState())])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_answer', { answer_id: '14204568', question_id: '19550517' })
  check('a known question costs one request', calls.length === 1 && calls[0].url === 'https://www.zhihu.com/question/19550517/answer/14204568', calls[0].url)
  check('the answer is projected', value.answer.content.includes('这是第二段') && value.answer.author.name === '示例答主')
  check('the answer carries its question title', value.answer.question_title === 'Instagram 有多少用户？')
}

{
  const calls = scriptFetch([redirect('/question/19550517/answer/14204568'), html(questionState())])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_answer', { answer_id: '14204568' })
  check('an unknown question follows one redirect', calls.length === 2 && calls[1].url === 'https://www.zhihu.com/question/19550517/answer/14204568', calls[1].url)
  check('the redirected answer is read', value.answer.answer_id === '14204568')
}

// ── articles, people, and comments ──────────────────────────────────────────

{
  const calls = scriptFetch([html(articleState())])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_article', { article_id: '2062869046270353592' })
  check('the article URL is the zhuanlan path', calls[0].url === 'https://zhuanlan.zhihu.com/p/2062869046270353592', calls[0].url)
  check('a long article id stays exact', value.article.article_id === '2062869046270353592')
  check('the article content is text', value.article.content === '这篇论文深入探讨了残差流的扩展。')
  check('the author is resolved from the page map', value.article.author.name === 'Example User')
}

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_user', { url_token: 'example-user' })
  check('the member URL encodes the slug and asks for counts', calls[0].url.startsWith('https://www.zhihu.com/api/v4/members/example-user?include=') && calls[0].url.includes('follower_count'), calls[0].url)
  check('the person is projected', value.user.name === 'Example User' && value.user.articles_count === 2)
}

{
  const answers = {
    data: [{
      id: '3280134495',
      type: 'answer',
      content: '<p>train, test, ref</p>',
      excerpt: 'train, test, ref',
      comment_count: 2,
      created_time: 1699346259,
      updated_time: 1699346259,
      author: { id: 'u1', url_token: 'example-user', name: 'Example User', headline: 'Example headline' },
      question: { id: '628957425', title: '如何评价天工大模型技术报告？' },
    }],
    paging: { is_end: true },
  }
  const calls = scriptFetch([json(answers)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_user_answers', { url_token: 'example-user' })
  check('the member answers URL carries sort_by', calls[0].url.includes('/members/example-user/answers') && calls[0].url.includes('sort_by=created'), calls[0].url)
  check('the member answer is projected', value.items[0].question_title === '如何评价天工大模型技术报告？')
  check('a finished page has no more', value.has_more === false)
}

{
  const articles = {
    data: [{
      id: '2062869046270353592',
      title: '2607.14530 xHC',
      excerpt: '这篇论文深入探讨了残差流的扩展。',
      voteup_count: 0,
      comment_count: 0,
      created: 1784607030,
      updated: 1784607030,
      author: { id: 'u1', url_token: 'example-user', name: 'Example User' },
    }],
    paging: { is_end: true },
  }
  const calls = scriptFetch([json(articles)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_user_articles', { url_token: 'example-user' })
  check('the article list URL is the member one', calls[0].url.includes('/members/example-user/articles'), calls[0].url)
  check('an article summary has no content field', value.items[0].article_id === '2062869046270353592' && !('content' in value.items[0]))
}

{
  const comments = {
    data: [{
      id: '52060517',
      content: '消除',
      created_time: 1389705476,
      vote_count: 0,
      child_comment_count: 2,
      author: { role: 'normal', member: { id: 'm1', name: '某人', url_token: 'someone', headline: '简介' } },
    }],
    paging: { is_end: true, totals: 1 },
  }
  const calls = scriptFetch([json(comments)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_comments', { answer_id: '14204568' })
  check('the comments URL is the answer one', calls[0].url.includes('/api/v4/answers/14204568/comments'), calls[0].url)
  check('a nested comment author is resolved', value.items[0].author.name === '某人')
  check('a comment keeps its child count', value.items[0].child_comment_count === 2)
}

// ── failures ────────────────────────────────────────────────────────────────

{
  const calls = scriptFetch([text('{"error":{"message":"请求参数异常","code":10003}}', { status: 403 })])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_question', { question_id: '19550517' })
  check('a signature refusal is named', value.ok === false && value.error.code === 'signature_required')
  check('a signature refusal pauses with a retry instant', value.error.retryable === true && typeof value.error.retry_at === 'string')
  const second = await run(tools, 'zhihu_hot')
  check('the pause blocks the next call before transport', second.error.code === 'temporarily_blocked' && calls.length === 1, second.error?.code)
}

{
  scriptFetch([text('<html>系统检测到您的网络环境存在异常，请完成安全验证</html>', { status: 403 })])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_me')
  check('a verification page is risk control', value.error.code === 'risk_control')
  check('risk control is retryable with an instant', value.error.retryable === true && typeof value.error.retry_at === 'string')
}

{
  const calls = scriptFetch([text('<html><body>请完成安全验证</body></html>', { status: 200 })])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_question', { question_id: '19550517' })
  check('a 200 verification page is risk control', value.error.code === 'risk_control')
  const second = await run(tools, 'zhihu_hot')
  check('a 200 verification page pauses the process', second.error.code === 'temporarily_blocked' && calls.length === 1)
}

{
  scriptFetch([text('', { status: 429, headers: { 'retry-after': '2' } })])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_me')
  check('a 429 is rate limiting', value.error.code === 'rate_limited')
  check('the retry instant follows Retry-After', (() => {
    const at = Date.parse(value.error.retry_at)
    const delta = at - Date.now()
    return delta > 500 && delta <= 3_000
  })(), value.error.retry_at)
}

{
  scriptFetch([status(404)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_user', { url_token: 'nobody' })
  check('a 404 is not_found and does not pause', value.error.code === 'not_found' && value.error.retryable === false)
}

{
  scriptFetch([text('not json', { status: 200 })])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_me')
  check('a non-JSON answer is invalid_response', value.error.code === 'invalid_response')
}

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools } = mount({ cookie: null })
  const value = await run(tools, 'zhihu_me')
  check('no stored cookie is not_connected', value.error.code === 'not_connected')
  check('a missing cookie issues no request', calls.length === 0)
}

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools } = mount()
  const value = await run(tools, 'zhihu_connect', { cookie: 'foo=bar' })
  check('a malformed cookie is refused before transport', value.error.code === 'cookie_invalid' && calls.length === 0)
}

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools, credentials } = mount({ cookie: null })
  const value = await run(tools, 'zhihu_connect', { cookie: COOKIE })
  check('connect proves the cookie once', calls.length === 1 && value.account.name === 'Example User')
  check('connect stores the normalized cookie', credentials.records.get('zhihu/default')?.payload?.cookie === COOKIE)
}

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools } = mount()
  await run(tools, 'zhihu_me')
  await run(tools, 'zhihu_connect', { cookie: 'z_c0=second-session; d_c0=second-device' })
  await run(tools, 'zhihu_me')
  check('a cookie change drops the response cache', calls.length === 3, `${calls.length} calls`)
}

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools } = mount()
  await run(tools, 'zhihu_me')
  await run(tools, 'zhihu_disconnect')
  const value = await run(tools, 'zhihu_me')
  check('disconnect drops the cached account', value.error.code === 'not_connected' && calls.length === 1, value.error.code)
}

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools, credentials } = mount()
  const value = await run(tools, 'zhihu_disconnect')
  check('disconnect clears the record without a request', value.cleared === true && credentials.records.size === 0 && calls.length === 0)
  const after = await run(tools, 'zhihu_me')
  check('after disconnect reads are not_connected', after.error.code === 'not_connected')
}

{
  const { tools } = mount()
  let refused = false
  try {
    await tools.get('zhihu_hot').execute({ limit: 0 }, {})
  } catch (error) {
    refused = error.name === 'ZhihuUsageError'
  }
  check('a limit below one is refused', refused)
}

// ── pacing, budget, retries, and cancellation ───────────────────────────────

{
  let active = 0
  let maximum = 0
  const started = []
  globalThis.fetch = async (url) => {
    active += 1
    maximum = Math.max(maximum, active)
    started.push(Date.now())
    await sleep(15)
    active -= 1
    return new Response(JSON.stringify(ACCOUNT), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { tools } = mount({ config: { minIntervalMs: 30 } })
  await Promise.all([
    tools.get('zhihu_me').execute({}, {}),
    tools.get('zhihu_me').execute({ fresh: true }, {}),
  ])
  check('requests are serialized', maximum === 1, `max ${maximum}`)
  check('requests are spaced by the interval', started.length === 2 && started[1] - started[0] >= 25, `${started[1] - started[0]} ms`)
}

{
  const calls = scriptFetch([json(ACCOUNT), json(ACCOUNT)])
  const { tools } = mount({ config: { hourlyBudget: 1 } })
  await run(tools, 'zhihu_me')
  const value = await run(tools, 'zhihu_hot')
  check('the hourly budget refuses after it is spent', value.error.code === 'request_budget_exhausted' && calls.length === 1)
  check('the budget refusal names a retry instant', typeof value.error.retry_at === 'string')
}

{
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) throw new Error('ECONNRESET')
    return new Response(JSON.stringify(ACCOUNT), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { tools } = mount({ config: { retryAttempts: 1, retryDelayMs: 1 } })
  const value = await run(tools, 'zhihu_me')
  check('a transport failure is retried once', value.ok === true && calls === 2, `${calls} calls`)
}

{
  globalThis.fetch = async () => {
    throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
  }
  const { tools } = mount({ config: { retryAttempts: 0 } })
  const value = await run(tools, 'zhihu_me')
  check('a timeout is named and retryable', value.error.code === 'timeout' && value.error.retryable === true)
}

{
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(JSON.stringify(ACCOUNT), { status: 200 })
  }
  const { tools } = mount()
  const controller = new AbortController()
  controller.abort()
  const value = await run(tools, 'zhihu_me', {}, { signal: controller.signal })
  check('an aborted caller issues no request', value.error.code === 'aborted' && calls === 0)
}

{
  const calls = scriptFetch([() => new Response('x'.repeat(70_000), { status: 200 })])
  const { tools } = mount({ config: { responseLimitBytes: 65_536 } })
  const value = await run(tools, 'zhihu_me')
  check('an oversized body is refused', value.error.code === 'response_too_large' && calls.length === 1)
}

// ── argument validation ────────────────────────────────────────────────────

{
  const { tools } = mount()
  const unsafe = tools.get('zhihu_question')
  let refused = false
  try {
    await unsafe.execute({ question_id: 2099125476149274126 }, {})
  } catch (error) {
    refused = error.name === 'ZhihuUsageError' && /string/.test(error.message)
  }
  check('an unsafe numeric id is refused with a string hint', refused)
  let slug = false
  try {
    await tools.get('zhihu_user').execute({ url_token: 'a/b' }, {})
  } catch (error) {
    slug = error.name === 'ZhihuUsageError'
  }
  check('a slug with a slash is refused', slug)
  let order = false
  try {
    await tools.get('zhihu_answers').execute({ question_id: '19550517', order: 'hot' }, {})
  } catch (error) {
    order = error.name === 'ZhihuUsageError'
  }
  check('an unknown ordering is refused', order)
}

// ── plugin surface and the page route ───────────────────────────────────────

{
  const calls = scriptFetch([json(ACCOUNT)])
  const { tools, routes } = mount()
  check('twelve tools are registered', tools.size === 12, `${tools.size}`)
  check('the plugin registers one route', routes.length === 1 && routes[0].path === '/api/plugin-zhihu')

  const initial = await bridge(routes, 'GET')
  check('the page status is ok', initial.body.ok === true)
  check('status reports a stored cookie', initial.body.value.connected === true && initial.body.value.saved_at === '2026-01-01T00:00:00Z')
  const serialized = JSON.stringify(initial.body)
  check('status never carries the cookie', !serialized.includes('fake-session') && !serialized.includes('fake-device'))
  check('status carries the pacing state', initial.body.value.stats.hourly_budget === 60 && initial.body.value.config.minIntervalMs === 1)

  const connected = await bridge(routes, 'POST', { action: 'connect', cookie: 'z_c0=new-session; d_c0=new-device' })
  check('the page can connect a cookie', connected.body.ok === true && connected.body.value.account.name === 'Example User')
  check('the page returns the new status', connected.body.value.status.connected === true)
  check('connect spends one request', calls.length === 1)

  const verified = await bridge(routes, 'POST', { action: 'verify' })
  check('the page can verify again', verified.body.ok === true && verified.body.value.verified_at !== null)

  const disconnected = await bridge(routes, 'POST', { action: 'disconnect' })
  check('the page can disconnect', disconnected.body.ok === true && disconnected.body.value.status.connected === false)

  const unknown = await bridge(routes, 'POST', { action: 'nope' })
  check('an unknown action is refused', unknown.status === 400 && unknown.body.error.code === 'unknown_action')
}

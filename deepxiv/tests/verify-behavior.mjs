/**
 * Deterministic behaviour checks for the dsh-deepxiv bundle: a local HTTP server
 * stands in for DeepXiv, so every request the plugin makes is inspected
 * verbatim — what it sends, what it reports, and what it must never leak.
 *
 * Offline: run `node tests/verify-behavior.mjs` from the plugin directory after
 * `pnpm install`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'
import { BRIDGE_PATH } from '../src/bridge.js'
import { resolveConfig } from '../src/config.js'
import { clearToken, keyFor, readToken, writeToken } from '../src/credentials.js'
import { redact } from '../src/api.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Run one check that must throw, and report its message. */
const throws = (work) => {
  try {
    work()
  } catch (error) {
    return error.message
  }
  return null
}

/** Run one check that must reject, and report its message. */
const rejects = async (work) => {
  try {
    await work()
  } catch (error) {
    return error.message
  }
  return null
}

// ── a stand-in DeepXiv ──────────────────────────────────────────────────────

/**
 * Start a server that routes every request through one handler, recording it.
 * @param route - Handler called with the recorded request and the response.
 * @returns the endpoint, the received requests, and a closer.
 */
async function startUpstream(route) {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const entry = {
      method: request.method,
      url: request.url,
      path: url.pathname,
      params: url.searchParams,
      headers: request.headers,
    }
    requests.push(entry)
    route(entry, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      // A request the plugin abandoned on timeout or abort still holds its
      // socket; closing the server must not wait for it.
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Answer one request with a JSON body. */
const json = (body, status = 200) => (_entry, response) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** Answer one request with a refusal in the API's own `detail` form. */
const refused = (status, detail) => json({ detail }, status)

/** Answer one request with a body that is not JSON. */
const notJson = () => (_entry, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<html>not the API</html>')
}

/** Answer one request with a body far larger than a test's read limit. */
const oversized = () => (_entry, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ result: [], padding: 'x'.repeat(8192) }))
}

/** Answer one request with a redirect. */
const redirects = (location) => (_entry, response) => {
  response.writeHead(302, { location })
  response.end()
}

/** Never answer; the caller's timeout is what ends the call. */
const never = () => () => {}

/** Send headers and the start of a body, then never finish it. */
const stalls = () => (_entry, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.write('{"result":')
}

/** Route a retrieval request to one paper payload per query. */
const retrieve = (body) => (entry, response) => {
  const query = entry.params.get('query')
  return json(typeof body === 'function' ? body(query, entry) : body)(entry, response)
}

// ── the plugin's seams ──────────────────────────────────────────────────────

/**
 * An in-memory stand-in for the credential service, with the provider's own
 * rule that a mutation returning undefined leaves the record alone.
 * @param entries - `[scope, id, record]` triples to preload.
 * @returns the fake provider.
 */
function fakeCredentials(entries = []) {
  const records = new Map(entries.map(([scope, id, record]) => [`${scope}/${id}`, record]))
  return {
    records,
    async listRecords() {
      return [...records.entries()].map(([key, record]) => {
        const [scope, id] = key.split('/')
        return { key: credentialKey(scope, id), kind: record.kind }
      })
    },
    async readRecord(key) {
      return records.get(String(key))
    },
    async modifyRecord(key, mutate) {
      const current = records.get(String(key))
      const next = await mutate(current)
      if (next === undefined) return current
      records.set(String(key), next)
      return next
    },
    async deleteRecord(key) {
      records.delete(String(key))
    },
  }
}

/**
 * Mount the plugin against stub services, as the Loader would.
 * @param options - Mount inputs.
 * @returns the registered tools, captured warnings, the settings route, and the disposers.
 */
function mount({ provider, config, withConnection = false }) {
  const tools = new Map()
  const logs = []
  const disposers = []
  let route
  const ctx = {
    credentials: provider,
    logger: { warn: (message) => logs.push(message) },
    tools: {
      register(definition) {
        assertSupportedJsonSchema(definition.parameters)
        assertSupportedJsonSchema(definition.output.schema)
        tools.set(definition.name, definition)
        const dispose = () => tools.delete(definition.name)
        disposers.push(dispose)
        return dispose
      },
    },
    inject: (names, callback) => {
      if (!withConnection || !names.includes('connection')) return undefined
      const connectionCtx = {
        connection: {
          fetch: {
            register: (registration) => {
              route = registration
              return () => {
                route = undefined
              }
            },
          },
        },
        effect: (work) => {
          const cleanup = work()
          return () => cleanup?.()
        },
      }
      return callback(connectionCtx)
    },
  }
  apply(ctx, config)
  return { tools, logs, disposers, route: () => route }
}

/** Post one settings action to the captured route. */
async function hit(route, action, body = {}) {
  const response = await route.fetch(
    new Request(`http://127.0.0.1${BRIDGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    }),
  )
  return { status: response.status, payload: await response.json() }
}

/** One stored DeepXiv token record. */
const tokenRecord = (token) => ({
  kind: 'grant',
  payload: { channel: 'deepxiv', token, addedAt: '2026-10-14T00:00:00.000Z' },
})

/** One search result as the retrieval endpoint returns it. */
const resultItem = (overrides = {}) => ({
  arxiv_id: '2506.18871',
  score: 0.9475,
  title: 'Paper Title',
  tldr: 'A short summary.',
  abstract: 'A longer abstract.',
  authors: [{ name: 'Ada Lovelace', orgs: ['Analytical Engine Co'] }],
  url: 'https://arxiv.org/abs/2506.18871',
  date: '2025-06-23T17:38:54Z',
  citation_count: 217,
  categories: ['cs.CV'],
  ...overrides,
})

/** One arXiv metadata body as the head view returns it. */
const headBody = (overrides = {}) => ({
  arxiv_id: '2409.05591',
  src_url: 'https://arxiv.org/pdf/2409.05591',
  title: 'MemoRAG',
  abstract: 'Processing long contexts presents a significant challenge.',
  authors: [{ name: 'Hongjin Qian', orgs: ['Peking University'] }],
  token_count: 23311,
  venue: 'The Web Conference',
  journal_name: 'Proceedings of the ACM on Web Conference 2025',
  citations: 127,
  sections: [
    { name: '1. Introduction', idx: 0, tldr: 'Introduces the framework.' },
    { name: '2. Method', idx: 1, tldr: 'Describes the memory module.' },
  ],
  categories: ['cs.CL', 'cs.AI'],
  publish_at: '2024-09-09T00:00:00',
  keywords: ['global memory augmentation'],
  tldr: 'A dual-system RAG framework.',
  github_url: 'https://github.com/qhjqhj00/MemoRAG',
  ...overrides,
})

// ── configuration ───────────────────────────────────────────────────────────

{
  const defaults = resolveConfig(undefined)
  check(
    'defaults resolve, with the endpoint stripped of trailing slashes',
    defaults.baseUrl === 'https://data.rag.ac.cn'
    && defaults.searchDefaultTopK === 10
    && defaults.previewDefaultChars === 10_000
    && defaults.fullMaxChars === 200_000
    && defaults.userAgent === 'dsh-deepxiv/0.1',
    JSON.stringify({ baseUrl: defaults.baseUrl, topK: defaults.searchDefaultTopK }),
  )
  check(
    'a trailing slash on the configured endpoint is dropped',
    resolveConfig({ baseUrl: 'https://example.test///' }).baseUrl === 'https://example.test',
  )
  check(
    'an unknown config key fails the load',
    throws(() => resolveConfig({ nope: 1 })) === 'deepxiv: unknown config key "nope"',
    String(throws(() => resolveConfig({ nope: 1 }))),
  )
  check(
    'a relative endpoint fails the load',
    throws(() => resolveConfig({ baseUrl: 'data.rag.ac.cn' }))?.includes('is not an absolute URL') === true,
    String(throws(() => resolveConfig({ baseUrl: 'data.rag.ac.cn' }))),
  )
  check(
    'and so does a non-http scheme',
    throws(() => resolveConfig({ baseUrl: 'ftp://data.rag.ac.cn' })) === 'deepxiv: config.baseUrl must use http or https',
  )
  check(
    'a tool timeout below the request timeout fails the load',
    throws(() => resolveConfig({ requestTimeoutMs: 30_000, toolTimeoutMs: 5_000 }))
      === 'deepxiv: config.toolTimeoutMs must be at least config.requestTimeoutMs',
  )
  check(
    'a default search size above the ceiling fails the load',
    throws(() => resolveConfig({ searchDefaultTopK: 60, searchMaxTopK: 50 }))
      === 'deepxiv: config.searchDefaultTopK must not exceed config.searchMaxTopK',
  )
  check(
    'a default preview above the ceiling fails the load',
    throws(() => resolveConfig({ previewDefaultChars: 2_000, previewMaxChars: 1_000 }))
      === 'deepxiv: config.previewDefaultChars must not exceed config.previewMaxChars',
  )
  check(
    'a baseUrl carrying a query or fragment fails the load',
    throws(() => resolveConfig({ baseUrl: 'https://data.rag.ac.cn/x?y=1' }))
      === 'deepxiv: config.baseUrl must not carry a query or fragment',
    String(throws(() => resolveConfig({ baseUrl: 'https://data.rag.ac.cn/x?y=1' }))),
  )
  check(
    'a baseUrl path prefix is kept',
    resolveConfig({ baseUrl: 'https://example.test/deepxiv/' }).baseUrl === 'https://example.test/deepxiv',
  )
  check(
    'a non-numeric bound fails the load',
    throws(() => resolveConfig({ top_k: 5 })) === 'deepxiv: unknown config key "top_k"',
  )
}

// ── requests: what goes on the wire ─────────────────────────────────────────

{
  const upstream = await startUpstream(retrieve({ status: 'success', total_count: 1, result: [resultItem()] }))
  const provider = fakeCredentials([['deepxiv', 'default', tokenRecord('tok-live')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl } })
  const tool = mounted.tools.get('deepxiv_search')
  try {
    await tool.execute({ query: 'kv cache eviction', source: 'biorxiv', top_k: 3, min_citation: 5 }, {})
    const entry = upstream.requests[0]
    check('the retrieval path is the arXiv route', entry.path === '/arxiv/', entry.path)
    check(
      'the retrieval parameters name the query, corpus, and size',
      entry.params.get('type') === 'retrieve'
      && entry.params.get('query') === 'kv cache eviction'
      && entry.params.get('source') === 'biorxiv'
      && entry.params.get('top_k') === '3'
      && entry.params.get('min_citation') === '5',
      entry.url,
    )
    check(
      'the token rides the Authorization header',
      entry.headers.authorization === 'Bearer tok-live',
      String(entry.headers.authorization),
    )
    check('the token never rides the URL', !entry.url.includes('tok-live'), entry.url)
    check('the user agent is the configured one', entry.headers['user-agent'] === 'dsh-deepxiv/0.1')

    upstream.requests.length = 0
    await tool.execute({ query: 'x', year_from: 2020, year_to: 2024 }, {})
    const ranged = upstream.requests[0]
    check(
      'a year range becomes the API comparator plus two dates',
      ranged.params.get('date_search_type') === 'between'
      && ranged.params.getAll('date_str').join(',') === '2020,2024',
      ranged.url,
    )

    upstream.requests.length = 0
    await tool.execute({ query: 'x', year_from: 2023 }, {})
    const after = upstream.requests[0]
    check(
      'a single lower year becomes an open-ended after',
      after.params.get('date_search_type') === 'after' && after.params.get('date_str') === '2023',
      after.url,
    )

    upstream.requests.length = 0
    await tool.execute({ query: 'x', year_to: 2019 }, {})
    const before = upstream.requests[0]
    check(
      'a single upper year becomes an open-ended before',
      before.params.get('date_search_type') === 'before' && before.params.get('date_str') === '2019',
      before.url,
    )

    upstream.requests.length = 0
    await tool.execute({ query: 'x', categories: ['cs.CL', 'cs.AI'], venues: ['NeurIPS'], authors: ['Ada'], orgs: ['MIT'] }, {})
    const filtered = upstream.requests[0]
    check(
      'list filters repeat one parameter per value',
      filtered.params.getAll('categories').join(',') === 'cs.CL,cs.AI'
      && filtered.params.getAll('venues').join(',') === 'NeurIPS'
      && filtered.params.getAll('authors').join(',') === 'Ada'
      && filtered.params.getAll('orgs').join(',') === 'MIT',
      filtered.url,
    )
  } finally {
    await upstream.close()
  }
}

// ── a deployment mounted under a path prefix ────────────────────────────────

{
  const upstream = await startUpstream(json({ status: 'success', total_count: 0, result: [] }))
  const mounted = mount({
    provider: fakeCredentials([['deepxiv', 'default', tokenRecord('tok')]]),
    config: { baseUrl: `${upstream.baseUrl}/deepxiv` },
  })
  try {
    await mounted.tools.get('deepxiv_search').execute({ query: 'q' }, {})
    check(
      'a configured path prefix is kept, not discarded',
      upstream.requests[0].path === '/deepxiv/arxiv/',
      upstream.requests[0].path,
    )
  } finally {
    await upstream.close()
  }
}

// ── response mapping ────────────────────────────────────────────────────────

{
  const longTldr = 'y'.repeat(900)
  const upstream = await startUpstream((entry, response) => {
    if (entry.path === '/pmc/') {
      return entry.params.get('type') === 'head'
        ? json({
            pmc_id: 'PMC544940',
            title: 'Editorial',
            doi: '10.1/x',
            abstract: 'A',
            authors: [{
              name: 'David L Suskind',
              email: 'david.suskind@seattlechildrens.org',
              affiliations: ["Children's Hospital, University of Washington, Seattle, USA"],
              is_corresponding: 'yes',
            }],
            categories: 'PMC, Research Article',
            publish_at: '2004-10-06',
          })(entry, response)
        : json({
            pmc_id: 'PMC544940',
            data: {
              metadata: { title: 'Editorial', doi: '10.1/x', publish_date: '2004-10-06', abstract: 'A' },
              body: {
                root_paragraphs: ['Opening line.'],
                sections: [{
                  title: 'Background',
                  paragraphs: ['First.', 'Second.'],
                  subsections: [{
                    title: 'HLA typing',
                    paragraphs: ['Third.'],
                    subsections: [{ title: 'Detection of maternal DNA by kPCR', paragraphs: ['Fourth.'], subsections: [] }],
                  }],
                }],
              },
              references: [{ id: 'B1' }, { id: 'B2' }],
            },
          })(entry, response)
    }
    const type = entry.params.get('type')
    if (type === 'retrieve') {
      return json({ status: 'success', total_count: 42, result: [resultItem({ tldr: longTldr }), resultItem({ arxiv_id: '2506.18872' })] })(entry, response)
    }
    if (type === 'brief') return json({ arxiv_id: '2409.05591', title: 'MemoRAG', tldr: 'short', keywords: ['a'], publish_at: '2024-09-09', citations: 127, src_url: 'https://arxiv.org/pdf/2409.05591' })(entry, response)
    if (type === 'head') return json(headBody())(entry, response)
    if (type === 'preview') return json({ arxiv_id: '2409.05591', preview: 'p'.repeat(300), is_truncated: true, total_characters: 83376, preview_characters: 300 })(entry, response)
    if (type === 'section') return json({ arxiv_id: '2409.05591', section: '1. Introduction', content: 'c'.repeat(500) })(entry, response)
    return json({ arxiv_id: '2409.05591', raw: 'r'.repeat(5_000) })(entry, response)
  })
  const provider = fakeCredentials([['deepxiv', 'default', tokenRecord('tok')]])
  const config = {
    baseUrl: upstream.baseUrl,
    tldrMaxChars: 100,
    sectionMaxChars: 200,
    fullMaxChars: 300,
    previewDefaultChars: 200,
    previewMaxChars: 1_000,
    searchDefaultTopK: 1,
    searchMaxTopK: 5,
  }
  const mounted = mount({ provider, config })
  try {
    const search = await mounted.tools.get('deepxiv_search').execute({ query: 'q', top_k: 1 }, {})
    check('a retrieval keeps the requested number of results', search.returned === 1 && search.results.length === 1)
    check('a retrieval reports the upstream total', search.total_count === 42, String(search.total_count))
    check('the corpus is named as asked', search.corpus === 'arxiv', search.corpus)
    check('an over-long TLDR is cut and named in truncated', search.results[0].tldr.length === 100 && search.truncated.includes('tldr'), JSON.stringify(search.truncated))
    check(
      'the trimmed text ends inside the bound',
      search.results[0].tldr.endsWith('…') && search.results[0].tldr.length <= 100,
    )
    check('the id field follows the corpus', search.results[0].id === '2506.18871' && search.results[0].id_kind === 'arxiv')
    check('a result keeps its citation count and score', search.results[0].citation_count === 217 && search.results[0].score === 0.9475)
    check('a result keeps its authors and their organizations', search.results[0].authors[0].name === 'Ada Lovelace' && search.results[0].authors[0].orgs[0] === 'Analytical Engine Co')

    const brief = await mounted.tools.get('deepxiv_paper').execute({ paper_id: '2409.05591', view: 'brief' }, {})
    check('the brief view answers with the citation count', brief.citations === 127 && brief.title === 'MemoRAG', JSON.stringify(brief))
    check('the brief view marks nothing as cut', Array.isArray(brief.truncated) && brief.truncated.length === 0)

    const head = await mounted.tools.get('deepxiv_paper').execute({ paper_id: '2409.05591', view: 'head' }, {})
    check(
      'the head view lists the section titles the section view reads',
      head.sections.length === 2 && head.sections[0].name === '1. Introduction' && head.sections[1].name === '2. Method',
      JSON.stringify(head.sections.map((section) => section.name)),
    )
    check('the head view keeps the venue and journal', head.venue === 'The Web Conference' && head.journal_name.startsWith('Proceedings'))

    upstream.requests.length = 0
    await mounted.tools.get('deepxiv_paper').execute({ paper_id: '2409.05591v2', view: 'brief' }, {})
    check(
      'a version suffix is dropped before the request',
      upstream.requests.at(-1).params.get('arxiv_id') === '2409.05591',
      upstream.requests.at(-1).url,
    )

    upstream.requests.length = 0
    const preview = await mounted.tools.get('deepxiv_paper').execute({ paper_id: '2409.05591', view: 'preview', characters: 200 }, {})
    check(
      'the preview view asks for the requested length on the wire',
      upstream.requests.at(-1).params.get('characters') === '200'
      && upstream.requests.at(-1).params.get('type') === 'preview',
      upstream.requests.at(-1).url,
    )
    check(
      'the preview view reports both lengths and the upstream truncation flag',
      preview.preview_characters === 300 && preview.total_characters === 83376 && preview.is_truncated === true,
      JSON.stringify(preview).slice(0, 160),
    )

    const section = await mounted.tools.get('deepxiv_paper').execute({ paper_id: '2409.05591', view: 'section', section: '1. Introduction' }, {})
    check(
      'a long section is cut at the configured bound and reports its full length',
      section.content.length === 200 && section.content.endsWith('…') && section.content_chars === 500 && section.truncated.includes('content'),
      JSON.stringify({ length: section.content.length, chars: section.content_chars }),
    )

    const full = await mounted.tools.get('deepxiv_paper').execute({ paper_id: '2409.05591', view: 'full' }, {})
    check(
      'a whole paper is cut at the configured bound and reports its full length',
      full.content.length === 300 && full.content_chars === 5_000 && full.truncated.includes('content'),
      JSON.stringify({ length: full.content.length, chars: full.content_chars }),
    )

    const pmcHead = await mounted.tools.get('deepxiv_paper').execute({ paper_id: 'PMC544940', view: 'head' }, {})
    check(
      'the PMC metadata view reads the PMC route',
      pmcHead.corpus === 'pmc' && pmcHead.doi === '10.1/x' && pmcHead.paper_id === 'PMC544940',
      JSON.stringify(pmcHead),
    )
    check(
      'PMC author affiliations fill the organization list',
      pmcHead.authors[0].orgs[0] === "Children's Hospital, University of Washington, Seattle, USA",
      JSON.stringify(pmcHead.authors),
    )
    check(
      'a PMC category string becomes a list',
      pmcHead.categories.join('|') === 'PMC|Research Article',
      JSON.stringify(pmcHead.categories),
    )

    upstream.requests.length = 0
    const pmcFull = await mounted.tools.get('deepxiv_paper').execute({ paper_id: 'pmc544940', view: 'full' }, {})
    check(
      'the PMC full view flattens the structured body into markdown',
      pmcFull.content.includes('Opening line.') && pmcFull.content.includes('## Background') && pmcFull.content.includes('First.'),
      pmcFull.content.slice(0, 120),
    )
    check(
      'and descends into subsections rather than dropping them',
      pmcFull.content.includes('### HLA typing')
      && pmcFull.content.includes('Third.')
      && pmcFull.content.includes('#### Detection of maternal DNA by kPCR')
      && pmcFull.content.includes('Fourth.'),
      pmcFull.content.slice(0, 300),
    )
    check('the PMC full view reports its reference count', pmcFull.references === 2, String(pmcFull.references))
    check(
      'a lowercase PMC id is uppercased on the wire',
      upstream.requests.at(-1).params.get('pmc_id') === 'PMC544940',
      upstream.requests.at(-1).url,
    )
    check(
      'the PMC full view asks for the json type',
      upstream.requests.at(-1).params.get('type') === 'json',
    )

    const unsupported = await mounted.tools.get('deepxiv_paper').execute({ paper_id: 'PMC544940', view: 'section', section: 'Background' }, {})
    check(
      'a view the PMC route does not serve comes back as view_unsupported',
      unsupported.ok === false && unsupported.error.code === 'view_unsupported' && unsupported.error.retryable === false,
      JSON.stringify(unsupported),
    )
  } finally {
    await upstream.close()
  }
}

// ── failures: what the tools report ─────────────────────────────────────────

{
  const upstream = await startUpstream((entry, response) => {
    const key = entry.params.get('query') ?? entry.params.get('section') ?? ''
    if (key === 'broken') return notJson()(entry, response)
    if (key === 'huge') return oversized()(entry, response)
    if (key === 'slow') return never()(entry, response)
    if (key === 'stall') return stalls()(entry, response)
    if (entry.params.get('section') === 'Nope') {
      return refused(404, "Section 'Nope' not found for arXiv paper: 2409.05591")(entry, response)
    }
    const status = { key401: 401, key403: 403, key400: 400, key404: 404, key422: 422, key429: 429, key503: 503 }[key]
    if (status !== undefined) return refused(status, `upstream says ${status}`)(entry, response)
    return json({ status: 'success', total_count: 0, result: [] })(entry, response)
  })

  const withToken = fakeCredentials([['deepxiv', 'default', tokenRecord('tok-secret')]])
  const withoutToken = fakeCredentials([])
  const mounted = mount({
    provider: withToken,
    config: { baseUrl: upstream.baseUrl, responseLimitBytes: 1_024, requestTimeoutMs: 1_000, toolTimeoutMs: 5_000 },
  })
  const bare = mount({ provider: withoutToken, config: { baseUrl: upstream.baseUrl } })
  const search = mounted.tools.get('deepxiv_search')
  const paper = mounted.tools.get('deepxiv_paper')
  const noTokenSearch = bare.tools.get('deepxiv_search')

  try {
    const missing = await noTokenSearch.execute({ query: 'key401' }, {})
    check(
      'a 401 without a stored token reports token_missing',
      missing.ok === false && missing.error.code === 'token_missing' && missing.error.retryable === false,
      JSON.stringify(missing.error),
    )
    check(
      'and its message points at the plugin\'s page',
      missing.error.message.includes('Plugins page'),
      missing.error.message,
    )

    const rejected = await search.execute({ query: 'key401' }, {})
    check(
      'a 401 with a stored token reports token_rejected',
      rejected.error.code === 'token_rejected' && rejected.error.message.includes('upstream says 401'),
      JSON.stringify(rejected.error),
    )
    check(
      'the refused token is never quoted back',
      !JSON.stringify(rejected).includes('tok-secret'),
      JSON.stringify(rejected),
    )

    const empty = await search.execute({ query: 'nothing' }, {})
    check(
      'an empty retrieval is a success, not a failure',
      empty.ok === true && empty.returned === 0 && empty.total_count === 0,
      JSON.stringify(empty),
    )

    check('a 403 reports forbidden', (await search.execute({ query: 'key403' }, {})).error.code === 'forbidden')
    check('a 400 reports invalid_request', (await search.execute({ query: 'key400' }, {})).error.code === 'invalid_request')
    check('a 422 reports unprocessable', (await search.execute({ query: 'key422' }, {})).error.code === 'unprocessable')
    check(
      'a 429 reports rate_limited as not retryable',
      (await search.execute({ query: 'key429' }, {})).error.code === 'rate_limited',
    )
    const unavailable = await search.execute({ query: 'key503' }, {})
    check(
      'a 503 reports upstream_unavailable as retryable',
      unavailable.error.code === 'upstream_unavailable' && unavailable.error.retryable === true,
      JSON.stringify(unavailable.error),
    )

    const sectionMiss = await paper.execute({ paper_id: '2409.05591', view: 'section', section: 'Nope' }, {})
    check(
      "a missing section is told apart from a missing paper",
      sectionMiss.error.code === 'section_not_found',
      JSON.stringify(sectionMiss.error),
    )
    const paperMiss = await paper.execute({ paper_id: '2409.05591', view: 'section', section: 'key404' }, {})
    check('any other 404 reports not_found', paperMiss.error.code === 'not_found', JSON.stringify(paperMiss.error))

    const broken = await search.execute({ query: 'broken' }, {})
    check('a non-JSON body reports invalid_response', broken.error.code === 'invalid_response', JSON.stringify(broken.error))

    const huge = await search.execute({ query: 'huge' }, {})
    check(
      'a body over the read limit is refused, not parsed',
      huge.error.code === 'response_too_large' && huge.error.message.includes('1024'),
      JSON.stringify(huge.error),
    )

    const timedOut = await search.execute({ query: 'slow' }, {})
    check(
      'a request that outlives its budget reports timeout',
      timedOut.error.code === 'timeout' && timedOut.error.retryable === true,
      JSON.stringify(timedOut.error),
    )

    const controller = new AbortController()
    const cancelled = search.execute({ query: 'slow' }, { signal: controller.signal })
    controller.abort()
    const aborted = await cancelled
    check('a cancelled call reports aborted', aborted.error.code === 'aborted', JSON.stringify(aborted.error))

    const stalled = await search.execute({ query: 'stall' }, {})
    check(
      'a body that stops mid-answer reports timeout, not an unreachable API',
      stalled.error.code === 'timeout' && stalled.error.retryable === true,
      JSON.stringify(stalled.error),
    )

    const midRead = new AbortController()
    const pending = search.execute({ query: 'stall' }, { signal: midRead.signal })
    setTimeout(() => midRead.abort(), 20)
    const cancelledMidRead = await pending
    check(
      'cancelling during the body read reports aborted',
      cancelledMidRead.error.code === 'aborted' && cancelledMidRead.error.retryable === false,
      JSON.stringify(cancelledMidRead.error),
    )

    // Every failure above is a payload, so none of them throws.
    check(
      'a failure payload always names its source and its retryability',
      [missing, rejected, huge, timedOut, aborted].every(
        (value) => value.source === 'deepxiv' && typeof value.error.code === 'string' && typeof value.error.retryable === 'boolean',
      ),
    )
    check(
      'no failure payload carries the token',
      !JSON.stringify([missing, rejected, huge, timedOut, aborted]).includes('tok-secret'),
    )
    check(
      'and no warning line carries it either',
      mounted.logs.every((line) => !line.includes('tok-secret')),
      mounted.logs.join(' | '),
    )
  } finally {
    await upstream.close()
  }
}

// ── redirects ───────────────────────────────────────────────────────────────

{
  const target = await startUpstream(json({ status: 'success', total_count: 0, result: [] }))
  const upstream = await startUpstream(redirects(`${target.baseUrl}/arxiv/?type=retrieve`))
  const provider = fakeCredentials([['deepxiv', 'default', tokenRecord('tok-secret')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl } })
  try {
    const value = await mounted.tools.get('deepxiv_search').execute({ query: 'q' }, {})
    check('a redirect is not followed', value.ok === false && value.error.code === 'request_failed', JSON.stringify(value.error))
    check('the redirect target is never contacted', target.requests.length === 0, String(target.requests.length))
    check('the redirect failure does not quote the token', !JSON.stringify(value).includes('tok-secret'))
  } finally {
    await upstream.close()
    await target.close()
  }
}

// ── argument validation ─────────────────────────────────────────────────────

{
  const upstream = await startUpstream(json({ status: 'success', total_count: 0, result: [] }))
  const mounted = mount({ provider: fakeCredentials([]), config: { baseUrl: upstream.baseUrl, queryMaxChars: 20, searchDefaultTopK: 1, searchMaxTopK: 5 } })
  const search = mounted.tools.get('deepxiv_search')
  const paper = mounted.tools.get('deepxiv_paper')
  try {
    check(
      'a search without a query is rejected before any request',
      (await rejects(() => search.execute({}, {}))) === 'query is required.',
    )
    check(
      'an over-long query is rejected before any request',
      (await rejects(() => search.execute({ query: 'z'.repeat(21) }, {})))?.startsWith('query must be at most 20 characters') === true,
    )
    check(
      'an unknown corpus is rejected',
      (await rejects(() => search.execute({ query: 'q', source: 'pubmed' }, {})))?.startsWith('source must be one of') === true,
    )
    check(
      'a result count above the ceiling is rejected',
      (await rejects(() => search.execute({ query: 'q', top_k: 6 }, {}))) === 'top_k must be an integer from 1 to 5.',
    )
    check(
      'a non-array filter is rejected',
      (await rejects(() => search.execute({ query: 'q', authors: 'Ada' }, {}))) === 'authors must be an array of strings.',
    )
    check(
      'an empty filter entry is rejected',
      (await rejects(() => search.execute({ query: 'q', venues: [''] }, {}))) === 'venues must contain only non-empty strings.',
    )
    check(
      'a paper id that is neither arXiv nor PMC is rejected',
      (await rejects(() => paper.execute({ paper_id: 'doi:10.1/x' }, {})))?.startsWith('paper_id must be an arXiv id') === true,
    )
    check(
      'the section view requires a section title',
      (await rejects(() => paper.execute({ paper_id: '2409.05591', view: 'section' }, {})))?.startsWith('section is required') === true,
    )
    check(
      'a section title outside the section view is rejected',
      (await rejects(() => paper.execute({ paper_id: '2409.05591', section: '1. Introduction' }, {})))?.startsWith('section applies only to') === true,
    )
    check(
      'characters outside the preview view is rejected',
      (await rejects(() => paper.execute({ paper_id: '2409.05591', view: 'head', characters: 500 }, {})))?.startsWith('characters applies only to') === true,
    )
    check('no request was issued for any rejected argument', upstream.requests.length === 0, String(upstream.requests.length))
  } finally {
    await upstream.close()
  }
}

// ── presentation ────────────────────────────────────────────────────────────

{
  const mounted = mount({ provider: fakeCredentials([]), config: { baseUrl: 'https://data.rag.ac.cn' } })
  const search = mounted.tools.get('deepxiv_search')
  const paper = mounted.tools.get('deepxiv_paper')
  check(
    'every tool renders one JSON text block',
    search.output.render({}, { ok: true }).length === 1 && search.output.render({}, { ok: true })[0].type === 'text',
  )
  check(
    'a call card names the paper being read',
    paper.presentCall({ paper_id: '2409.05591' }).rawInput.paper_id === '2409.05591',
  )
  check(
    'a call card survives arguments that are not an object',
    search.presentCall(undefined).title === 'Search DeepXiv papers' && search.presentCall('nonsense').rawInput === undefined,
  )
  check('both tools advertise a cooperative timeout', search.timeoutMs > 0 && paper.timeoutMs > 0)
  check('both tools are marked concurrency safe', search.isConcurrencySafe({}) === true && paper.isConcurrencySafe({}) === true)
  check(
    'the model-facing text never names the credential or the settings route',
    !`${search.description} ${paper.description}`.includes('credential')
    && !`${search.description} ${paper.description}`.includes('bridge')
    && !`${search.description} ${paper.description}`.includes('/api/'),
  )
}

// ── the credential record ───────────────────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deepxiv-check-'))
  const ctx = new Context()
  ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml') })
  const provider = await mountedService(ctx, 'credentials')
  try {
    const absent = await readToken(provider)
    check('an absent token is reported as absent', absent.ok === false && absent.reason === 'record_missing', JSON.stringify(absent))

    await writeToken(provider, '  tok-real  ')
    const stored = await readToken(provider)
    check('a stored token comes back trimmed', stored.ok === true && stored.token === 'tok-real', JSON.stringify(stored))

    await writeToken(provider, 'tok-real-2')
    const replaced = await readToken(provider)
    check(
      'replacing a token keeps its add time',
      replaced.token === 'tok-real-2' && replaced.addedAt === stored.addedAt,
      `${replaced.token} ${replaced.addedAt} vs ${stored.addedAt}`,
    )

    const empty = await rejects(() => writeToken(provider, '   '))
    check('an empty token is refused', empty === 'deepxiv: a token is required', String(empty))

    await clearToken(provider)
    check('a deleted token is gone', (await readToken(provider)).reason === 'record_missing')
    check('the record key is the plugin scope', String(keyFor()) === 'deepxiv/default', String(keyFor()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Wait for one service to mount, as the Loader eventually does. */
async function mountedService(ctx, name) {
  const deadline = Date.now() + 5_000
  for (;;) {
    const service = ctx.get(name)
    if (service !== undefined) return service
    if (Date.now() > deadline) throw new Error(`${name} never mounted`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ── records the plugin cannot use ───────────────────────────────────────────

{
  const provider = fakeCredentials([
    ['deepxiv', 'default', { kind: 'api-key', key: 'not-ours' }],
    ['other', 'default', { kind: 'grant', payload: { channel: 'other', token: 'theirs' } }],
  ])
  const status = await mount({ provider, config: {}, withConnection: true })
  const route = status.route()
  const answer = await hit(route, 'status')
  check(
    'a record of another kind is reported unusable, not as absent',
    answer.payload.value.configured === false && answer.payload.value.reason === 'not_a_token',
    JSON.stringify(answer.payload.value),
  )
  check(
    'an unusable record contributes no token to the status',
    !JSON.stringify(answer.payload).includes('not-ours') && !JSON.stringify(answer.payload).includes('theirs'),
    JSON.stringify(answer.payload),
  )
}

// ── the settings route ──────────────────────────────────────────────────────

{
  const upstream = await startUpstream((entry, response) => {
    if (entry.path === '/fa/v1/whoami') {
      // The live shape: two pools under `quota` and `agent`, the tier inside
      // `agent`, and the account named at the top level.
      return json({
        source: 'web',
        name: 'Ada Lovelace',
        subject: 'dx:u1',
        quota: { daily_limit: 10_000, used: 12, remaining: 9_988 },
        agent: { tier: 'free', daily_limit: 30, used_today: 1, remaining_today: 29 },
      })(entry, response)
    }
    return json({ detail: 'Invalid or inactive token' }, 401)(entry, response)
  })
  const provider = fakeCredentials([])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl }, withConnection: true })
  const route = mounted.route()
  try {
    const initial = await hit(route, 'status')
    check('the route answers a status read', initial.status === 200 && initial.payload.value.configured === false)
    check(
      'an empty store reports no token for the page to show',
      initial.payload.value.token === undefined,
      JSON.stringify(initial.payload.value),
    )
    check(
      'the status carries the configuration the page only displays',
      initial.payload.value.config.baseUrl === upstream.baseUrl && initial.payload.value.config.searchMaxTopK === 50,
      JSON.stringify(initial.payload.value.config),
    )

    const saved = await hit(route, 'token.save', { token: 'tok-page' })
    check(
      'saving a token stores it and answers the new status',
      saved.status === 200 && saved.payload.value.configured === true && typeof saved.payload.value.addedAt === 'string',
      JSON.stringify(saved.payload.value),
    )
    check(
      'the save answer carries the stored token for the page to show',
      saved.payload.value.token === 'tok-page',
      JSON.stringify(saved.payload.value),
    )
    check('the record now holds the token', provider.records.get('deepxiv/default').payload.token === 'tok-page')

    const blank = await hit(route, 'token.save', { token: '  ' })
    check(
      'an empty token is a malformed request, not a server failure',
      blank.status === 400 && blank.payload.error.code === 'invalid_token',
      JSON.stringify(blank.payload),
    )

    const unknown = await hit(route, 'token.rename')
    check('an unknown action is refused', unknown.status === 400 && unknown.payload.error.code === 'unknown_action')

    const tooBig = await hit(route, 'token.save', { token: 'x'.repeat(40_000) })
    check('an oversized body is refused', tooBig.status === 413 && tooBig.payload.error.code === 'body_too_large', String(tooBig.status))

    const verified = await hit(route, 'token.verify')
    check(
      'verifying reads the quota and normalizes both pools',
      verified.payload.value.ok === true
      && verified.payload.value.tier === 'free'
      && verified.payload.value.general.used === 12
      && verified.payload.value.general.limit === 10_000
      && verified.payload.value.general.remaining === 9_988
      && verified.payload.value.agentic.used === 1
      && verified.payload.value.agentic.limit === 30
      && verified.payload.value.agentic.remaining === 29,
      JSON.stringify(verified.payload.value),
    )
    check(
      'and names the account the token belongs to',
      verified.payload.value.account === 'Ada Lovelace' && verified.payload.value.subject === 'dx:u1',
      JSON.stringify({ account: verified.payload.value.account, subject: verified.payload.value.subject }),
    )
    check(
      'the upstream quota path is the whoami route',
      upstream.requests.at(-1).path === '/fa/v1/whoami',
      upstream.requests.at(-1).path,
    )
    check(
      'the quota answer carries the raw body for unknown fields',
      typeof verified.payload.value.raw === 'string' && verified.payload.value.raw_withheld === false,
    )

    // A link or prefetch is a GET; it must not be able to drop the credential.
    const viaGet = await route.fetch(new Request(`http://127.0.0.1${BRIDGE_PATH}?action=token.delete`))
    check('a GET cannot delete the stored token', viaGet.status === 405, String(viaGet.status))
    check('the stored token survives the GET attempt', provider.records.has('deepxiv/default') === true)

    const removed = await hit(route, 'token.delete')
    check('deleting a token answers the new status', removed.payload.value.configured === false)
    check(
      'and leaves no token for the page to show',
      removed.payload.value.token === undefined,
      JSON.stringify(removed.payload.value),
    )
    check('the record is gone', provider.records.has('deepxiv/default') === false)

    const nothing = await hit(route, 'token.verify')
    check(
      'verifying without a token says so instead of calling upstream',
      nothing.payload.value.ok === false && nothing.payload.value.error.code === 'token_missing',
      JSON.stringify(nothing.payload.value),
    )
  } finally {
    await upstream.close()
  }
}

// ── the documented quota spelling still normalizes ──────────────────────────

{
  const upstream = await startUpstream(json({ tier: 'premium', general: { used: 5, limit: 100 }, agentic: { used: 2, limit: 50 } }))
  const provider = fakeCredentials([['deepxiv', 'default', tokenRecord('tok-page')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl }, withConnection: true })
  try {
    const answer = await hit(mounted.route(), 'token.verify')
    check(
      'a body using the documented field names still normalizes',
      answer.payload.value.tier === 'premium'
      && answer.payload.value.general.limit === 100
      && answer.payload.value.agentic.remaining === 48,
      JSON.stringify(answer.payload.value),
    )
  } finally {
    await upstream.close()
  }
}

// ── a refused stored token ──────────────────────────────────────────────────

{
  const upstream = await startUpstream(refused(401, 'Invalid or inactive token'))
  const provider = fakeCredentials([['deepxiv', 'default', tokenRecord('tok-page')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl }, withConnection: true })
  const route = mounted.route()
  try {
    const refusedCall = await hit(route, 'token.verify')
    check(
      'a refused token comes back as a soft failure the page can render',
      refusedCall.status === 200 && refusedCall.payload.value.ok === false
      && refusedCall.payload.value.error.code === 'token_rejected',
      JSON.stringify(refusedCall.payload.value),
    )
    check(
      'the refusal never quotes the stored token',
      !JSON.stringify(refusedCall.payload).includes('tok-page'),
      JSON.stringify(refusedCall.payload),
    )
    check(
      'the refusal is logged by code, without the token',
      mounted.logs.some((line) => line.includes('token_rejected')) && mounted.logs.every((line) => !line.includes('tok-page')),
      mounted.logs.join(' | '),
    )
  } finally {
    await upstream.close()
  }
}

// ── a quota body that echoes the credential ─────────────────────────────────

{
  // The Host withholds any upstream body that carries the token back, so a
  // rewritten endpoint cannot turn the plugin's page into a way to read it.
  const upstream = await startUpstream((entry, response) => {
    const authorization = entry.headers.authorization ?? ''
    return json({ tier: 'free', note: `this answer quotes ${authorization}` })(entry, response)
  })
  const provider = fakeCredentials([['deepxiv', 'default', tokenRecord('tok-page')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl }, withConnection: true })
  try {
    const answer = await hit(mounted.route(), 'token.verify')
    check(
      'a quota body that echoes the token is withheld',
      answer.payload.value.ok === true
      && answer.payload.value.raw === null
      && answer.payload.value.raw_withheld === true,
      JSON.stringify(answer.payload.value),
    )
    check(
      'and the page never receives the token through it',
      !JSON.stringify(answer.payload).includes('tok-page'),
      JSON.stringify(answer.payload).slice(0, 200),
    )
  } finally {
    await upstream.close()
  }
}

// ── a quota body that echoes an escaped credential ──────────────────────────

{
  // A token carrying a quote or a backslash is re-escaped by JSON.stringify, so
  // the literal comparison alone would hand the body back with the token in it.
  const tricky = 'ab"cd\\ef'
  const upstream = await startUpstream((entry, response) => {
    const authorization = entry.headers.authorization ?? ''
    return json({ tier: 'free', api_token: authorization.replace('Bearer ', '') })(entry, response)
  })
  const provider = fakeCredentials([['deepxiv', 'default', tokenRecord(tricky)]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl }, withConnection: true })
  try {
    const answer = await hit(mounted.route(), 'token.verify')
    check(
      'a body echoing an escaped token is withheld',
      answer.payload.value.raw_withheld === true && answer.payload.value.raw === null,
      JSON.stringify(answer.payload.value).slice(0, 200),
    )
    check(
      'and neither form of the token reaches the page',
      !JSON.stringify(answer.payload).includes(tricky) && !JSON.stringify(answer.payload).includes('ab\\"cd'),
      JSON.stringify(answer.payload).slice(0, 200),
    )
  } finally {
    await upstream.close()
  }
}

// ── redaction happens before the message bound ─────────────────────────────

{
  const longToken = 'a'.repeat(300)
  const redactedLong = redact(`upstream said: ${longToken}`, longToken)
  check(
    'a long token is removed before the message is bounded',
    !redactedLong.includes(longToken.slice(0, 50)) && redactedLong.includes('<token>'),
    redactedLong.slice(0, 60),
  )
  const tricky = 'ab"cd\\ef'
  const redactedEscaped = redact(JSON.stringify({ message: tricky }), tricky)
  check(
    'a JSON-escaped token is removed',
    !redactedEscaped.includes('ab\\"cd') && redactedEscaped.includes('<token>'),
    redactedEscaped,
  )
}

// ── disposal ────────────────────────────────────────────────────────────────

{
  const mounted = mount({ provider: fakeCredentials([]), config: {}, withConnection: true })
  check(
    'the plugin registers exactly the two research tools',
    mounted.tools.size === 2 && mounted.tools.has('deepxiv_search') && mounted.tools.has('deepxiv_paper'),
    [...mounted.tools.keys()].join(', '),
  )
  check('and exactly one settings route', mounted.route() !== undefined && mounted.route().path === BRIDGE_PATH)
  for (const dispose of mounted.disposers) dispose()
  check('disposing the registrations removes the tools', mounted.tools.size === 0, [...mounted.tools.keys()].join(', '))
}

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`}`)
process.exit(failures.length === 0 ? 0 : 1)

/**
 * The DeepXiv HTTP surface: request construction, failure classification, and
 * the trimming that bounds every model-facing value.
 *
 * Requests authenticate with the stored token in an `Authorization: Bearer`
 * header, never in the query-string form the API also accepts, so no URL this
 * plugin builds carries a secret. Every request refuses redirects before their
 * target is contacted, because the request carries that credential. A failure
 * quotes the API's own `detail` field, bounded, with any occurrence of the token
 * removed.
 *
 * Upstream text — titles, TLDRs, abstracts, and paper bodies — is external and
 * untrusted: this module bounds it and never interprets it.
 *
 * @module dsh-deepxiv/src/api
 */

// ── protocol constants (fixed: they describe the remote API, not a tunable) ──

/** Paper routes; the `type` parameter selects the view. */
const ARXIV_PATH = '/arxiv/'
const PMC_PATH = '/pmc/'

/** Quota endpoint of the 1stAuthor verticals, which shares this account's quota. */
const WHOAMI_PATH = '/fa/v1/whoami'

/** Retrieval corpora this plugin offers. */
export const SOURCES = Object.freeze(['arxiv', 'biorxiv', 'medrxiv'])

/** Reading views this plugin offers. */
export const VIEWS = Object.freeze(['brief', 'head', 'preview', 'section', 'full'])

/** Reading view → the `type` parameter the arXiv route serves it as. */
const ARXIV_TYPES = Object.freeze({
  brief: 'brief',
  head: 'head',
  preview: 'preview',
  section: 'section',
  full: 'raw',
})

/** Retrieval corpus → the id field its results carry. */
const ID_FIELDS = Object.freeze({
  arxiv: 'arxiv_id',
  biorxiv: 'biorxiv_id',
  medrxiv: 'medrxiv_id',
})

/** arXiv id: `2409.05591`, optionally versioned. */
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}(?:v\d+)?$/

/** PMC id: `PMC544940`, as the PMC route accepts it. */
const PMC_ID_PATTERN = /^PMC\d+$/i

/** The API's wording when a named section does not exist in a paper. */
const SECTION_MISSING_PATTERN = /section\b.*\bnot found/i

/** Longest upstream message quoted in a failure, so a hostile body cannot flood a log. */
const MESSAGE_MAX_CHARS = 200

/** Longest quota body handed to the settings page as a raw fallback. */
const QUOTA_RAW_MAX_CHARS = 2_000

/** A refused or failed DeepXiv call; `message` never contains the token. */
export class DeepXivError extends Error {
  /**
   * @param code - Closed failure code.
   * @param message - Human-readable reason, with the token already removed.
   * @param options - Failure facts.
   * @param options.retryable - Whether calling again could succeed unchanged.
   */
  constructor(code, message, { retryable = false } = {}) {
    super(message)
    this.name = 'DeepXivError'
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Remove every occurrence of a secret from a text bound for a human.
 * @param text - Candidate text.
 * @param token - The secret to remove, when one was used.
 * @returns the bounded text with each occurrence replaced by `<token>`.
 */
export function redact(text, token) {
  if (typeof text !== 'string' || text === '') return ''
  // Replace before bounding: a token longer than the bound would otherwise be
  // cut out of the text before the search could find it, leaking its prefix.
  let sanitized = text
  if (typeof token === 'string' && token !== '') {
    // Upstream may echo the token as it appeared in a JSON body.
    const escaped = JSON.stringify(token).slice(1, -1)
    for (const form of new Set([token, escaped])) {
      if (form !== '') sanitized = sanitized.split(form).join('<token>')
    }
  }
  return sanitized.length > MESSAGE_MAX_CHARS ? `${sanitized.slice(0, MESSAGE_MAX_CHARS)}…` : sanitized
}

/**
 * Strip a version suffix, which the arXiv route rejects: it serves the latest
 * version of a paper and answers 400 for `2409.05591v1`.
 * @param value - Candidate arXiv id.
 * @returns the id without a version suffix.
 */
export function withoutArxivVersion(value) {
  return typeof value === 'string' ? value.replace(/v\d+$/, '') : value
}

/**
 * Whether a value names an arXiv paper this plugin can read.
 * @param value - Candidate id.
 * @returns true when the id has the arXiv form.
 */
export function isArxivId(value) {
  return typeof value === 'string' && ARXIV_ID_PATTERN.test(value)
}

/**
 * Whether a value names a PMC paper this plugin can read.
 * @param value - Candidate id.
 * @returns true when the id has the PMC form.
 */
export function isPmcId(value) {
  return typeof value === 'string' && PMC_ID_PATTERN.test(value)
}

/** One DeepXiv client bound to one resolved configuration. */
export class DeepXivClient {
  #config

  /**
   * @param config - The resolved plugin configuration.
   */
  constructor(config) {
    this.#config = config
  }

  /**
   * Run one hybrid retrieval.
   *
   * @param request - Retrieval inputs.
   * @param request.token - The stored DeepXiv token, when one is configured.
   * @param request.query - The search query, already validated and bounded.
   * @param request.source - Corpus to search.
   * @param request.topK - Number of results to ask for and to keep.
   * @param request.yearFrom - Earliest publication year, inclusive.
   * @param request.yearTo - Latest publication year, inclusive.
   * @param request.minCitation - Minimum citation count.
   * @param request.categories - Category filters such as `cs.CL`.
   * @param request.venues - Venue filters such as `NeurIPS`.
   * @param request.authors - Author filters, which also affect ranking.
   * @param request.orgs - Organization filters, which also affect ranking.
   * @param request.signal - Cancellation of the enclosing tool call.
   * @returns the bounded result list and its bounds.
   * @throws {DeepXivError} when the request failed or answered unusably.
   */
  async search({ token, query, source, topK, yearFrom, yearTo, minCitation, categories, venues, authors, orgs, signal }) {
    const params = [
      ['type', 'retrieve'],
      ['query', query],
      ['source', source],
      ['top_k', String(topK)],
    ]
    // The API takes one comparator plus its dates; a range repeats `date_str`.
    if (yearFrom !== undefined && yearTo !== undefined) {
      params.push(['date_search_type', 'between'], ['date_str', String(yearFrom)], ['date_str', String(yearTo)])
    } else if (yearFrom !== undefined) {
      params.push(['date_search_type', 'after'], ['date_str', String(yearFrom)])
    } else if (yearTo !== undefined) {
      params.push(['date_search_type', 'before'], ['date_str', String(yearTo)])
    }
    if (minCitation !== undefined) params.push(['min_citation', String(minCitation)])
    for (const value of categories) params.push(['categories', value])
    for (const value of venues) params.push(['venues', value])
    for (const value of authors) params.push(['authors', value])
    for (const value of orgs) params.push(['orgs', value])

    const body = await this.#get(ARXIV_PATH, params, { token, signal })
    if (!isRecord(body) || !Array.isArray(body.result)) {
      throw new DeepXivError('invalid_response', 'DeepXiv answered a retrieval body without a result list')
    }
    const bounded = new Truncations()
    const results = body.result.slice(0, topK).map((item) => mapSearchResult(item, source, this.#config, bounded))
    if (body.result.length > topK) bounded.mark('results')
    return {
      corpus: source,
      total_count: asNumber(body.total_count) ?? null,
      returned: results.length,
      results,
      truncated: bounded.fields,
    }
  }

  /**
   * Read one paper through one view.
   *
   * @param request - Reading inputs.
   * @param request.token - The stored DeepXiv token, when one is configured.
   * @param request.paperId - An arXiv id or a PMC id.
   * @param request.view - The reading view.
   * @param request.section - Section title, required by the `section` view.
   * @param request.characters - Preview length, used by the `preview` view.
   * @param request.signal - Cancellation of the enclosing tool call.
   * @returns the bounded reading value for that view.
   * @throws {DeepXivError} when the request failed, answered unusably, or the
   *   route does not serve that view for that corpus.
   */
  async read({ token, paperId, view, section, characters, signal }) {
    return isPmcId(paperId)
      ? await this.#readPmc({ token, paperId, view, signal })
      : await this.#readArxiv({ token, paperId, view, section, characters, signal })
  }

  /**
   * Read the account's remaining quota, as the settings page reports it.
   *
   * The API answers `{source, name, subject, quota:{daily_limit, used,
   * remaining}, agent:{tier, daily_limit, used_today, remaining_today}}`; the
   * documented and older spellings are tried as well, and the bounded raw body
   * rides along so a page still shows something when the API renames a field
   * again. A body that echoes the token back is dropped rather than handed to
   * the browser.
   *
   * @param request - Quota inputs.
   * @param request.token - The stored DeepXiv token.
   * @param request.signal - Cancellation of the enclosing request.
   * @returns tier name, per-pool usage, and the raw fallback.
   * @throws {DeepXivError} when the request failed or the token was refused.
   */
  async quota({ token, signal }) {
    const body = await this.#get(WHOAMI_PATH, [], { token, signal })
    const value = isRecord(body) ? body : {}
    const agent = isRecord(value.agent) ? value.agent : undefined
    const serialized = JSON.stringify(value) ?? ''
    // Both forms: a token carrying a quote, a backslash, or a control character
    // is re-escaped by JSON.stringify, so the literal comparison alone misses it.
    const literal = token ?? ''
    const escaped = JSON.stringify(literal).slice(1, -1)
    const echoesToken = literal !== '' && (serialized.includes(literal) || serialized.includes(escaped))
    return {
      account: asText(value.name) ?? null,
      subject: asText(value.subject) ?? null,
      tier: asText(agent?.tier) ?? asText(value.tier) ?? asText(value.plan) ?? null,
      general: readQuota(value.quota) ?? readQuota(value.general) ?? readQuota(value.general_quota) ?? readQuota(value.daily),
      agentic: readQuota(value.agent) ?? readQuota(value.agentic) ?? readQuota(value.agentic_quota),
      raw: echoesToken ? null : bound(serialized, QUOTA_RAW_MAX_CHARS),
      raw_withheld: echoesToken,
    }
  }

  /**
   * Read one arXiv paper through the view's `type`.
   * @param request - Reading inputs for the arXiv route.
   * @returns the bounded reading value for that view.
   * @throws {DeepXivError} when the request failed or answered unusably.
   */
  async #readArxiv({ token, paperId, view, section, characters, signal }) {
    const params = [['type', ARXIV_TYPES[view]], ['arxiv_id', paperId]]
    if (view === 'preview') params.push(['characters', String(characters)])
    if (view === 'section') params.push(['section', section])
    const body = await this.#get(ARXIV_PATH, params, { token, signal })
    return mapArxivPaper(body, paperId, view, this.#config)
  }

  /**
   * Read one PMC paper. That route serves metadata and the complete JSON only.
   * @param request - Reading inputs for the PMC route.
   * @returns the bounded reading value for that view.
   * @throws {DeepXivError} when the view is unsupported or the request failed.
   */
  async #readPmc({ token, paperId, view, signal }) {
    if (view !== 'head' && view !== 'full') {
      throw new DeepXivError(
        'view_unsupported',
        `PMC papers support only the head and full views, not "${view}". Use the arXiv route for a paper that has one.`,
      )
    }
    const id = paperId.toUpperCase()
    const params = [['type', view === 'head' ? 'head' : 'json'], ['pmc_id', id]]
    const body = await this.#get(PMC_PATH, params, { token, signal })
    return mapPmcPaper(body, id, view, this.#config)
  }

  /**
   * Perform one bounded GET and parse its JSON body.
   *
   * @param path - Route path, resolved against the configured endpoint.
   * @param params - Query parameters, in the order the API expects them.
   * @param options - Request facts.
   * @param options.token - Bearer token, when one is configured.
   * @param options.signal - Caller cancellation.
   * @returns the parsed body.
   * @throws {DeepXivError} when the transport failed, the response did not fit
   *   the byte bound, or the API answered with a failure status or a non-JSON body.
   */
  async #get(path, params, { token, signal }) {
    // Concatenated, not resolved: a deployment may mount this API under a path
    // prefix, and `new URL('/arxiv/', base)` would silently discard it.
    const url = new URL(`${this.#config.baseUrl}${path}`)
    for (const [key, value] of params) url.searchParams.append(key, value)
    const timeout = AbortSignal.timeout(this.#config.requestTimeoutMs)
    const combined = signal === undefined || signal === null ? timeout : AbortSignal.any([signal, timeout])

    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': this.#config.userAgent,
          ...token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` },
        },
        // The bearer token rides this request, so a redirect is refused before
        // its target is contacted.
        redirect: 'error',
        signal: combined,
      })
    } catch (error) {
      throw transportFailure(error, signal, this.#config.requestTimeoutMs)
    }

    let text
    try {
      text = await readBounded(response, this.#config.responseLimitBytes)
    } catch (error) {
      // The headers arrived, but the answer did not: the caller's abort and the
      // request budget apply here too, so a cancelled long read is not reported
      // as an unreachable API that is worth retrying.
      if (error instanceof DeepXivError) throw error
      throw transportFailure(error, signal, this.#config.requestTimeoutMs)
    }
    if (!response.ok) throw failureFor(response.status, redact(text, token), token)
    return parseJson(text, response.status)
  }
}

/**
 * Classify one transport failure: the caller's cancellation, the request budget,
 * or anything else the transport reported.
 * @param error - The thrown value.
 * @param signal - The caller's cancellation, when one was supplied.
 * @param timeoutMs - The request budget that was in force.
 * @returns the failure.
 */
function transportFailure(error, signal, timeoutMs) {
  if (signal?.aborted === true) {
    return new DeepXivError('aborted', 'The DeepXiv call was cancelled before its answer was complete')
  }
  const name = error instanceof Error ? error.name : 'Error'
  if (name === 'TimeoutError') {
    return new DeepXivError('timeout', `DeepXiv did not finish answering within ${timeoutMs} ms`, { retryable: true })
  }
  return new DeepXivError('request_failed', `The DeepXiv request failed (${name})`, { retryable: true })
}

/**
 * Classify one failure status into a closed code and a message quoting the API.
 * @param status - HTTP status.
 * @param text - The body text, already bounded and redacted.
 * @param token - The token the request used, when any.
 * @returns the failure.
 */
function failureFor(status, text, token) {
  const detail = text === '' ? 'no detail' : text
  switch (status) {
    case 400:
      return new DeepXivError('invalid_request', `DeepXiv rejected the request: ${detail}`)
    case 401:
      return token === undefined || token === ''
        ? new DeepXivError(
            'token_missing',
            'DeepXiv needs an API token for this request. The user adds one on the Plugins page, on the DeepXiv row.',
          )
        : new DeepXivError('token_rejected', `DeepXiv refused the stored token: ${detail}`)
    case 403:
      return new DeepXivError('forbidden', `DeepXiv refused this request: ${detail}`)
    case 404:
      return SECTION_MISSING_PATTERN.test(detail)
        ? new DeepXivError('section_not_found', `DeepXiv found no such section: ${detail}`)
        : new DeepXivError('not_found', `DeepXiv has nothing for that request: ${detail}`)
    case 422:
      return new DeepXivError('unprocessable', `DeepXiv could not accept the request: ${detail}`)
    case 429:
      return new DeepXivError('rate_limited', `The DeepXiv daily quota is used up: ${detail}`)
    default:
      return status >= 500
        ? new DeepXivError('upstream_unavailable', `DeepXiv is unavailable: ${detail}`, { retryable: true })
        : new DeepXivError('http_status', `DeepXiv answered HTTP ${status}: ${detail}`)
  }
}

/**
 * Read a response body under a byte bound.
 * @param response - The response.
 * @param limitBytes - Largest body accepted.
 * @returns the decoded body text.
 * @throws {DeepXivError} when the body exceeds the bound or the read failed.
 */
async function readBounded(response, limitBytes) {
  const reader = response.body === null ? null : response.body.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let total = 0
  if (reader !== null) {
    for (;;) {
      // A read failure is a transport failure: the caller classifies it, so a
      // cancelled or timed-out read is not reported as an unreachable API.
      const step = await reader.read()
      if (step.done) break
      total += step.value.byteLength
      if (total > limitBytes) {
        await reader.cancel()
        throw new DeepXivError(
          'response_too_large',
          `The DeepXiv response exceeds the ${limitBytes}-byte read limit, so no data was returned.`,
        )
      }
      chunks.push(step.value)
    }
  }
  let text = ''
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  text += decoder.decode()
  return text
}

/**
 * Parse a body the API promised is JSON.
 * @param text - The body text.
 * @param status - The status that carried it, named in the failure.
 * @returns the parsed value.
 * @throws {DeepXivError} when the text is not JSON.
 */
function parseJson(text, status) {
  try {
    return JSON.parse(text)
  } catch {
    throw new DeepXivError('invalid_response', `DeepXiv answered HTTP ${status} with a body that is not JSON`)
  }
}

// ── response mapping ────────────────────────────────────────────────────────

/**
 * One participant, bounded the same way from every view.
 *
 * PMC names the affiliation list `affiliations` where arXiv names it `orgs`;
 * reading only one of them reported every PMC author as unaffiliated, which is
 * why this mapping lives in one place rather than once per mapper.
 *
 * @param value - The upstream participant.
 * @param config - Resolved bounds.
 * @param bounded - The bounding helpers.
 * @returns the participant the tools report.
 */
function mapAuthor(value, config, bounded) {
  const author = isRecord(value) ? value : {}
  const orgs = author.orgs ?? author.affiliations
  return {
    name: asText(author.name) ?? '',
    orgs: bounded.list(orgs, config.orgsMax, 'orgs')
      .map((org) => asText(org) ?? '')
      .filter((org) => org !== ''),
  }
}

/** One search result, bounded. */
function mapSearchResult(item, source, config, bounded) {
  const value = isRecord(item) ? item : {}
  const idField = ID_FIELDS[source] ?? 'arxiv_id'
  const authors = bounded.list(value.authors, config.authorsMax, 'authors')
  return {
    id: asText(value[idField]) ?? asText(value.arxiv_id) ?? '',
    id_kind: source,
    title: bounded.text(asText(value.title) ?? '', config.titleMaxChars, 'title'),
    tldr: bounded.text(asText(value.tldr) ?? '', config.tldrMaxChars, 'tldr'),
    authors: authors.map((author) => mapAuthor(author, config, bounded)),
    url: asText(value.url) ?? '',
    date: asText(value.date) ?? '',
    citation_count: asNumber(value.citation_count) ?? null,
    categories: bounded.list(value.categories, config.categoriesMax, 'categories')
      .map((category) => asText(category) ?? '')
      .filter((category) => category !== ''),
    score: asNumber(value.score) ?? null,
  }
}

/**
 * Map one arXiv reading body onto the model-facing value of its view.
 * @param body - The parsed response.
 * @param paperId - The id that was requested.
 * @param view - The requested view.
 * @param config - The resolved plugin configuration.
 * @returns the bounded reading value.
 * @throws {DeepXivError} when the body does not carry that view.
 */
function mapArxivPaper(body, paperId, view, config) {
  if (!isRecord(body)) {
    throw new DeepXivError('invalid_response', `DeepXiv answered no ${view} body for ${paperId}`)
  }
  const bounded = new Truncations()
  const common = {
    paper_id: asText(body.arxiv_id) ?? paperId,
    corpus: 'arxiv',
    view,
  }
  if (view === 'brief') {
    return {
      ok: true,
      ...common,
      title: asText(body.title) ?? '',
      tldr: bounded.text(asText(body.tldr) ?? '', config.tldrMaxChars, 'tldr'),
      keywords: bounded.list(body.keywords, config.keywordsMax, 'keywords').map((word) => asText(word) ?? ''),
      publish_at: asText(body.publish_at) ?? '',
      citations: asNumber(body.citations) ?? null,
      src_url: asText(body.src_url) ?? '',
      truncated: bounded.fields,
    }
  }
  if (view === 'head') {
    return {
      ok: true,
      ...common,
      title: asText(body.title) ?? '',
      abstract: bounded.text(asText(body.abstract) ?? '', config.abstractMaxChars, 'abstract'),
      authors: bounded.list(body.authors, config.authorsMax, 'authors')
        .map((author) => mapAuthor(author, config, bounded)),
      // The titles are the menu the `section` view reads from, so they are kept
      // exactly as the API spells them.
      sections: bounded.list(body.sections, config.sectionsMax, 'sections').map((section) => ({
        name: asText(isRecord(section) ? section.name : undefined) ?? '',
        tldr: bounded.text(asText(isRecord(section) ? section.tldr : undefined) ?? '', config.tldrMaxChars, 'section_tldr'),
      })),
      venue: asText(body.venue) ?? '',
      journal_name: asText(body.journal_name) ?? '',
      citations: asNumber(body.citations) ?? null,
      token_count: asNumber(body.token_count) ?? null,
      categories: bounded.list(body.categories, config.categoriesMax, 'categories').map((c) => asText(c) ?? ''),
      keywords: bounded.list(body.keywords, config.keywordsMax, 'keywords').map((word) => asText(word) ?? ''),
      publish_at: asText(body.publish_at) ?? '',
      github_url: asText(body.github_url) ?? '',
      src_url: asText(body.src_url) ?? '',
      truncated: bounded.fields,
    }
  }
  if (view === 'preview') {
    return {
      ok: true,
      ...common,
      preview: bounded.text(asText(body.preview) ?? '', config.previewMaxChars, 'preview'),
      preview_characters: asNumber(body.preview_characters) ?? null,
      total_characters: asNumber(body.total_characters) ?? null,
      is_truncated: body.is_truncated === true,
      truncated: bounded.fields,
    }
  }
  if (view === 'section') {
    const content = asText(body.content) ?? ''
    const trimmed = trimText(content, config.sectionMaxChars)
    if (trimmed.truncated) bounded.mark('content')
    return {
      ok: true,
      ...common,
      section: asText(body.section) ?? '',
      content: trimmed.text,
      content_chars: content.length,
      truncated: bounded.fields,
    }
  }
  const content = asText(body.raw) ?? ''
  const trimmed = trimText(content, config.fullMaxChars)
  if (trimmed.truncated) bounded.mark('content')
  return {
    ok: true,
    ...common,
    content: trimmed.text,
    content_chars: content.length,
    truncated: bounded.fields,
  }
}

/**
 * Map one PMC reading body onto the model-facing value of its view.
 * @param body - The parsed response.
 * @param paperId - The uppercased id that was requested.
 * @param view - The requested view, `head` or `full`.
 * @param config - The resolved plugin configuration.
 * @returns the bounded reading value.
 * @throws {DeepXivError} when the body does not carry that view.
 */
function mapPmcPaper(body, paperId, view, config) {
  if (!isRecord(body)) {
    throw new DeepXivError('invalid_response', `DeepXiv answered no ${view} body for ${paperId}`)
  }
  const bounded = new Truncations()
  const common = {
    paper_id: asText(body.pmc_id) ?? paperId,
    corpus: 'pmc',
    view,
  }
  if (view === 'head') {
    return {
      ok: true,
      ...common,
      title: asText(body.title) ?? '',
      doi: asText(body.doi) ?? '',
      abstract: bounded.text(asText(body.abstract) ?? '', config.abstractMaxChars, 'abstract'),
      authors: bounded.list(body.authors, config.authorsMax, 'authors')
        .map((author) => mapAuthor(author, config, bounded)),
      categories: bounded.list(asList(body.categories), config.categoriesMax, 'categories').map((c) => asText(c) ?? ''),
      publish_at: asText(body.publish_at) ?? '',
      truncated: bounded.fields,
    }
  }
  const data = isRecord(body.data) ? body.data : {}
  const metadata = isRecord(data.metadata) ? data.metadata : {}
  const content = flattenPmcBody(data.body)
  const trimmed = trimText(content, config.fullMaxChars)
  if (trimmed.truncated) bounded.mark('content')
  return {
    ok: true,
    ...common,
    title: asText(metadata.title) ?? asText(body.title) ?? '',
    doi: asText(metadata.doi) ?? '',
    publish_date: asText(metadata.publish_date) ?? '',
    abstract: bounded.text(asText(metadata.abstract) ?? '', config.abstractMaxChars, 'abstract'),
    content: trimmed.text,
    content_chars: content.length,
    references: Array.isArray(data.references) ? data.references.length : null,
    truncated: bounded.fields,
  }
}

/**
 * Flatten a PMC `body` into markdown-shaped text.
 *
 * Sections nest: a section carries `subsections`, and those carry their own, so
 * the walk descends rather than reading only the top level — a whole titled
 * sub-study otherwise disappears from a value the model is told is the paper.
 *
 * @param value - The PMC `data.body` value, or one of its sections.
 * @param depth - Heading depth, which follows the nesting level.
 * @returns the flattened text, empty when nothing readable is carried.
 */
function flattenPmcBody(value, depth = 2) {
  if (!isRecord(value)) return ''
  const parts = []
  const root = Array.isArray(value.root_paragraphs) ? value.root_paragraphs : []
  for (const paragraph of root) {
    const text = asText(paragraph)
    if (text !== undefined && text !== '') parts.push(text)
  }
  const sections = Array.isArray(value.sections) ? value.sections : []
  for (const section of sections) {
    const text = flattenPmcSection(section, depth)
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * Flatten one PMC section and everything nested under it.
 * @param section - The section value.
 * @param depth - Heading depth of this section's title.
 * @returns the flattened text, empty when nothing readable is carried.
 */
function flattenPmcSection(section, depth) {
  if (!isRecord(section)) return ''
  const parts = []
  const title = asText(section.title) ?? ''
  if (title !== '') parts.push(`${'#'.repeat(Math.min(depth, 6))} ${title}`)
  const paragraphs = Array.isArray(section.paragraphs) ? section.paragraphs : []
  for (const paragraph of paragraphs) {
    const text = asText(paragraph)
    if (text !== undefined && text !== '') parts.push(text)
  }
  const subsections = Array.isArray(section.subsections) ? section.subsections : []
  for (const subsection of subsections) {
    const text = flattenPmcSection(subsection, depth + 1)
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}

// ── shared readers ──────────────────────────────────────────────────────────

/** Collects the field names one mapping had to shorten. */
class Truncations {
  #fields = new Set()

  /**
   * Record that a field was shortened.
   * @param field - Field name as the model sees it.
   */
  mark(field) {
    this.#fields.add(field)
  }

  /**
   * Bound one text field.
   * @param value - The field text.
   * @param max - Longest accepted text.
   * @param field - Field name, recorded when the bound cut the text.
   * @returns the bounded text.
   */
  text(value, max, field) {
    const result = trimText(value, max)
    if (result.truncated) this.mark(field)
    return result.text
  }

  /**
   * Bound one list field.
   * @param value - The field value, when it is an array at all.
   * @param max - Longest accepted list.
   * @param field - Field name, recorded when the bound cut the list.
   * @returns the bounded list.
   */
  list(value, max, field) {
    const items = Array.isArray(value) ? value : []
    if (items.length > max) this.mark(field)
    return items.slice(0, max)
  }

  /** @returns the shortened field names, ordered. */
  get fields() {
    return [...this.#fields].sort()
  }
}

/**
 * Bound a text, keeping the ellipsis inside the bound.
 * @param value - Candidate text.
 * @param max - Longest accepted text.
 * @returns the bounded text and whether it was cut.
 */
function trimText(value, max) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max - 1)}…`, truncated: true }
}

/**
 * Bound a text without reporting whether it was cut.
 * @param text - Candidate text.
 * @param max - Longest accepted text.
 * @returns the bounded text.
 */
function bound(text, max) {
  return trimText(text, max).text
}

/**
 * Read a list field the API sometimes returns as one comma-joined string, as
 * PMC does for `categories`.
 * @param value - Candidate value.
 * @returns the list, empty when the value carries no entry.
 */
function asList(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Read a nullable string field.
 * @param value - Candidate value.
 * @returns the text, or undefined when the value is not a string.
 */
function asText(value) {
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a nullable number field.
 * @param value - Candidate value.
 * @returns the number, or undefined when the value is not a finite number.
 */
function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Whether a value is a JSON object.
 * @param value - Candidate value.
 * @returns true when the value is a non-null, non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one quota pool.
 * @param value - The pool value, when the API reports one.
 * @returns the used, limit, and remaining counts, or null when none is readable.
 */
function readQuota(value) {
  if (!isRecord(value)) return null
  const used = asNumber(value.used) ?? asNumber(value.used_today) ?? asNumber(value.calls_used)
  const limit = asNumber(value.limit) ?? asNumber(value.daily_limit) ?? asNumber(value.quota)
  const remaining =
    asNumber(value.remaining)
    ?? asNumber(value.remaining_today)
    ?? asNumber(value.left)
    ?? (used !== undefined && limit !== undefined ? limit - used : undefined)
  if (used === undefined && limit === undefined && remaining === undefined) return null
  return { used: used ?? null, limit: limit ?? null, remaining: remaining ?? null }
}

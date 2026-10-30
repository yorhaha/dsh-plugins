/**
 * The one HTTP client every Zhihu tool shares.
 *
 * Zhihu's risk control reacts to request rate, not to request count: a burst of
 * ordinary reads can turn into a 403 verification page that lasts far longer
 * than the reads were worth. The client therefore funnels every request through
 * one queue, spaces them by `minIntervalMs`, caps them per rolling hour, answers
 * an identical request from a short-lived cache, and puts the whole process on a
 * long pause when Zhihu answers with a refusal. Those four mechanisms are the
 * plugin's answer to "frequent calls will trigger risk control".
 *
 * Transports are injectable so the offline tests can script every status Zhihu
 * never produces on demand; the shipped plugin uses the global `fetch`.
 *
 * @module dsh-zhihu/src/client
 */

import {
  RequestFailure,
  createPacer,
  isCallerAbort,
  isTimeout,
  readBoundedBody,
  retryAfterMs,
  sleep,
} from '../../shared/http.js'
import { CookieError, normalizeCookie } from './cookie.js'
import { parseJsonPreservingIds } from './json.js'
import {
  answerFrom,
  answerPreviewFrom,
  articleFromEntity,
  articleSummaryFrom,
  commentFrom,
  hotItemFrom,
  peopleMap,
  personFrom,
  questionFromEntity,
} from './extract.js'
import { readInitialState } from './html.js'

/** Origin of the API and question pages. */
const ORIGIN = 'https://www.zhihu.com'

/** Origin of column articles. */
const ARTICLE_ORIGIN = 'https://zhuanlan.zhihu.com'

/** Accept header for API calls. */
const JSON_ACCEPT = 'application/json, text/plain, */*'

/** Accept header for pages, which are read for their embedded state. */
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

/** Fields selected on answer lists; Zhihu omits content unless asked. */
const ANSWER_INCLUDE =
  'data[*].content,excerpt,voteup_count,comment_count,thanks_count,created_time,updated_time,author,question;data[*].author.follower_count,badge'

/** Fields selected on article lists; content itself is fetched by `article`. */
const ARTICLE_INCLUDE = 'data[*].excerpt,created,updated,voteup_count,comment_count,author'

/** Counts a member profile does not return unless they are asked for. */
const MEMBER_INCLUDE =
  'answer_count,articles_count,question_count,follower_count,following_count,voteup_count,thanked_count,favorite_count,pins_count,description,gender,ip_info'

/** One rolling budget window. */
const HOUR_MS = 3_600_000

/** Highest position a question page previews before the list tool takes over. */
const QUESTION_PREVIEW_ANSWERS = 3

/**
 * Format a wall-clock instant as `YYYY-MM-DDTHH:MM:SSZ`.
 * @param epochMs - the instant.
 * @returns the ISO text.
 */
function isoOf(epochMs) {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * The provenance block every success value carries.
 * @param response - the response this value came from.
 * @returns the snapshot.
 */
function snapshotOf(response) {
  return {
    fetched_at: response.fetchedAt,
    cached: response.cached === true,
    cache_age_seconds: response.cacheAgeSeconds ?? 0,
  }
}

/**
 * Whether a parsed API body reports an error instead of a payload.
 * @param value - the parsed body.
 * @returns the error object, or null.
 */
function apiError(value) {
  if (typeof value !== 'object' || value === null) return null
  const error = value.error
  return typeof error === 'object' && error !== null ? error : null
}

/** The process-local Zhihu client. */
export class ZhihuClient {
  /** @type {object} */
  #config

  /** @type {() => Promise<{cookie: string, saved_at: string|null}|undefined>} */
  #readCookie

  /** @type {Function} */
  #fetch

  /** @type {() => number} */
  #wallNow

  /** @type {() => number} */
  #monotonicNow

  /** Resolved-queue tail; the serialization point for every request. */
  #queue = Promise.resolve()

  /** Cache key → `{ value, expiresAt }`, in LRU order. */
  #cache = new Map()

  /** Cache key → in-flight promise, so two identical calls share one request. */
  #inflight = new Map()

  /** Bumped whenever the stored cookie changes, so a stale read cannot refill the cache. */
  #cacheEpoch = 0

  /** Wall-clock instants of the requests inside the current hour. */
  #requestTimes = []

  /** Wall-clock instant of the last issued request, or null. */
  #lastRequestAt = null

  /** Total requests this process issued, for the page. */
  #totalRequests = 0

  /** Wall-clock instant this process may request again, or null. */
  #pausedUntil = null

  /** Last expected failure, kept for the page. */
  #lastError = null

  /** Pacing and backoff state. */
  #pacer

  /**
   * @param options - injection points.
   * @param options.config - resolved plugin options.
   * @param options.readCookie - reads the stored cookie record, or undefined.
   * @param options.fetchImpl - transport; defaults to the global `fetch`.
   * @param options.wallNow - wall clock in milliseconds; defaults to `Date.now`.
   * @param options.monotonicNow - interval clock; defaults to `performance.now`.
   */
  constructor({ config, readCookie, fetchImpl = (...args) => globalThis.fetch(...args), wallNow = Date.now, monotonicNow = () => performance.now() }) {
    this.#config = config
    this.#readCookie = readCookie
    this.#fetch = fetchImpl
    this.#wallNow = wallNow
    this.#monotonicNow = monotonicNow
    this.#pacer = createPacer({
      label: 'Zhihu',
      config: { minIntervalMs: config.minIntervalMs },
      now: this.#monotonicNow,
      wallNow: this.#wallNow,
    })
  }

  // ── public surface ────────────────────────────────────────────────────────

  /**
   * Read the signed-in account, which also proves the cookie still works.
   * @param options - optional cookie override (used by the connect flow) and a cache bypass.
   * @returns the account and its provenance.
   */
  async me({ cookie, fresh = false, signal } = {}) {
    const response = await this.#getJson(`${ORIGIN}/api/v4/me`, { cookie, fresh, signal })
    return { account: personFrom(response.json), snapshot: snapshotOf(response) }
  }

  /**
   * List the questions Zhihu currently ranks as hot.
   * @param limit - how many entries to keep.
   * @param signal - caller cancellation.
   * @returns the hot list.
   */
  async hot(limit, signal) {
    const response = await this.#getJson(
      `${ORIGIN}/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true`,
      { signal },
    )
    const rows = Array.isArray(response.json.data) ? response.json.data : []
    const items = rows
      .filter((row) => typeof row?.target === 'object' && row.target !== null)
      .slice(0, limit)
      .map((row, index) => hotItemFrom(row, index + 1))
    const freshText = typeof response.json.fresh_text === 'string' ? response.json.fresh_text : ''
    return { fresh_text: freshText, items, snapshot: snapshotOf(response) }
  }

  /**
   * Read one question page: its metadata and a preview of its first answers.
   * @param questionId - numeric id, as text.
   * @param signal - caller cancellation.
   * @returns the question and preview.
   */
  async question(questionId, signal) {
    const response = await this.#getPage(`${ORIGIN}/question/${questionId}`, signal)
    const state = readInitialState(response.text)
    if (state === null) throw this.#pageFailure('question', response.text)
    const entities = state.entities ?? {}
    const raw = entities.questions?.[questionId]
    if (raw === undefined) throw missingFailure('question', questionId)
    const answerState = state.question?.answers?.[questionId]
    if (answerState?.antiSpider === true) {
      throw this.#pause(
        'risk_control',
        'Zhihu answered the question page with an anti-spider placeholder instead of its content. The process is paused for a while; do not retry immediately.',
        this.#config.pauseRiskMs,
      )
    }
    const order = Array.isArray(answerState?.ids) ? answerState.ids : []
    const preview = order
      .map((reference) => entities.answers?.[asEntityKey(reference?.target)])
      .filter((answer) => typeof answer === 'object' && answer !== null)
      .slice(0, QUESTION_PREVIEW_ANSWERS)
      .map((answer) => answerPreviewFrom(answer, { excerptChars: this.#config.excerptChars }))
    return {
      question: questionFromEntity(raw, questionId, this.#config.contentChars),
      answers_preview: preview,
      snapshot: snapshotOf(response),
    }
  }

  /**
   * Page through one question's answers.
   * @param questionId - numeric question id, as text.
   * @param options - page size, offset, and ordering.
   * @returns the answer page.
   */
  async answers(questionId, { limit, offset, order, signal }) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      order,
      platform: 'desktop',
      include: ANSWER_INCLUDE,
    })
    const response = await this.#getJson(
      `${ORIGIN}/api/v4/questions/${questionId}/feeds?${params.toString()}`,
      { signal },
    )
    const rows = Array.isArray(response.json.data) ? response.json.data : []
    const items = rows
      .map((row) => (typeof row?.target === 'object' && row.target !== null ? row.target : row))
      .filter((answer) => typeof answer === 'object' && answer !== null && answer.type === 'answer')
      .map((answer) => answerFrom(answer, this.#bounds()))
    const paging = response.json.paging ?? {}
    const hasMore = paging.is_end === false || (paging.is_end === undefined && items.length >= limit)
    return {
      question_id: questionId,
      order,
      offset,
      returned_count: items.length,
      has_more: hasMore,
      next_offset: offset + items.length,
      items,
      snapshot: snapshotOf(response),
    }
  }

  /**
   * Read one answer with its full content.
   *
   * `/api/v4/answers/{id}` is signature-gated, so the answer is read from the
   * page that renders it. When the caller knows the question id, that page is
   * fetched directly; otherwise the answer URL is asked once for its redirect
   * target, which costs one extra request.
   *
   * @param answerId - numeric answer id, as text.
   * @param options - the question id when known, and cancellation.
   * @returns the answer.
   */
  async answer(answerId, { questionId, signal }) {
    let url = questionId === undefined
      ? `${ORIGIN}/answer/${answerId}`
      : `${ORIGIN}/question/${questionId}/answer/${answerId}`
    let response = await this.#getPage(url, signal)
    if (response.status >= 300) {
      const target = redirectTarget(response.location)
      if (target === null) throw missingFailure('answer', answerId)
      response = await this.#getPage(target, signal)
    }
    const state = readInitialState(response.text)
    if (state === null) throw this.#pageFailure('answer', response.text)
    const raw = state.entities?.answers?.[answerId]
    if (raw === undefined) throw missingFailure('answer', answerId)
    const answer = answerFrom(raw, this.#bounds())
    if (answer.question_id === '') {
      const nested = raw.question?.id
      answer.question_id = nested === undefined ? '' : String(nested)
    }
    const question = state.entities?.questions?.[answer.question_id]
    if (answer.question_title === '' && question !== undefined) {
      answer.question_title = typeof question.title === 'string' ? question.title : ''
    }
    return { answer, snapshot: snapshotOf(response) }
  }

  /**
   * Read one column article.
   * @param articleId - numeric article id, as text.
   * @param signal - caller cancellation.
   * @returns the article.
   */
  async article(articleId, signal) {
    const response = await this.#getPage(`${ARTICLE_ORIGIN}/p/${articleId}`, signal)
    if (response.status >= 300) {
      const target = articleRedirectTarget(response.location)
      if (target === null) throw missingFailure('article', articleId)
      return this.#articleAt(target, articleId, signal)
    }
    return this.#articleFromPage(response, articleId)
  }

  /**
   * Read one person's profile.
   * @param urlToken - the personal URL slug.
   * @param signal - caller cancellation.
   * @returns the person.
   */
  async user(urlToken, signal) {
    const params = new URLSearchParams({ include: MEMBER_INCLUDE })
    const response = await this.#getJson(
      `${ORIGIN}/api/v4/members/${encodeURIComponent(urlToken)}?${params.toString()}`,
      { signal },
    )
    return { user: personFrom(response.json), snapshot: snapshotOf(response) }
  }

  /**
   * List one person's answers.
   * @param urlToken - the personal URL slug.
   * @param options - page size, offset, and ordering.
   * @returns the answer page.
   */
  async userAnswers(urlToken, { limit, offset, sortBy, signal }) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      sort_by: sortBy,
      include: ANSWER_INCLUDE,
    })
    const response = await this.#getJson(
      `${ORIGIN}/api/v4/members/${encodeURIComponent(urlToken)}/answers?${params.toString()}`,
      { signal },
    )
    const rows = Array.isArray(response.json.data) ? response.json.data : []
    const items = rows
      .filter((answer) => typeof answer === 'object' && answer !== null)
      .map((answer) => answerFrom(answer, this.#bounds()))
    const paging = response.json.paging ?? {}
    const hasMore = paging.is_end === false || (paging.is_end === undefined && items.length >= limit)
    return {
      url_token: urlToken,
      sort_by: sortBy,
      offset,
      returned_count: items.length,
      has_more: hasMore,
      next_offset: offset + items.length,
      items,
      snapshot: snapshotOf(response),
    }
  }

  /**
   * List one person's articles.
   * @param urlToken - the personal URL slug.
   * @param options - page size and offset.
   * @returns the article page.
   */
  async userArticles(urlToken, { limit, offset, signal }) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      include: ARTICLE_INCLUDE,
    })
    const response = await this.#getJson(
      `${ORIGIN}/api/v4/members/${encodeURIComponent(urlToken)}/articles?${params.toString()}`,
      { signal },
    )
    const rows = Array.isArray(response.json.data) ? response.json.data : []
    const items = rows
      .filter((article) => typeof article === 'object' && article !== null)
      .map((article) => articleSummaryFrom(article, { excerptChars: this.#config.excerptChars }))
    const paging = response.json.paging ?? {}
    const hasMore = paging.is_end === false || (paging.is_end === undefined && items.length >= limit)
    return {
      url_token: urlToken,
      offset,
      returned_count: items.length,
      has_more: hasMore,
      next_offset: offset + items.length,
      items,
      snapshot: snapshotOf(response),
    }
  }

  /**
   * List one answer's comments.
   * @param answerId - numeric answer id, as text.
   * @param options - page size, offset, and ordering.
   * @returns the comment page.
   */
  async comments(answerId, { limit, offset, order, signal }) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      order,
      status: 'open',
    })
    const response = await this.#getJson(
      `${ORIGIN}/api/v4/answers/${answerId}/comments?${params.toString()}`,
      { signal },
    )
    const rows = Array.isArray(response.json.data) ? response.json.data : []
    const items = rows
      .map((row) => (typeof row?.comment === 'object' && row.comment !== null ? row.comment : row))
      .filter((comment) => typeof comment === 'object' && comment !== null)
      .map((comment) => commentFrom(comment, this.#config.commentChars))
      .filter((comment) => comment.comment_id !== '' || comment.content !== '')
    const paging = response.json.paging ?? {}
    const hasMore = paging.is_end === false || (paging.is_end === undefined && items.length >= limit)
    return {
      answer_id: answerId,
      order,
      offset,
      returned_count: items.length,
      has_more: hasMore,
      next_offset: offset + items.length,
      items,
      snapshot: snapshotOf(response),
    }
  }

  /**
   * Validate a candidate cookie and report the account it belongs to.
   *
   * No cache is read and none is written: a cookie that is being tested must
   * produce Zhihu's current answer, not one an earlier cookie received.
   *
   * @param cookie - the cookie string the user pasted.
   * @returns the account.
   */
  async verifyCookie(cookie, signal) {
    let normalized
    try {
      normalized = normalizeCookie(cookie)
    } catch (error) {
      if (error instanceof CookieError) throw error
      throw new CookieError(error instanceof Error ? error.message : String(error))
    }
    const { account } = await this.me({ cookie: normalized, fresh: true, signal })
    if (account.id === '') {
      throw new RequestFailure('invalid_response', 'Zhihu accepted the cookie but returned no account identity.')
    }
    return account
  }

  /**
   * The connection, pacing, and cache state the plugin page shows.
   * @returns the state, with no cookie material of any kind.
   */
  stats() {
    const now = this.#wallNow()
    this.#pruneBudget(now)
    return {
      requests_last_hour: this.#requestTimes.length,
      hourly_budget: this.#config.hourlyBudget,
      budget_reset_at: this.#requestTimes.length === 0 ? null : isoOf(this.#requestTimes[0] + HOUR_MS),
      paused_until: this.#pausedUntil !== null && this.#pausedUntil > now ? isoOf(this.#pausedUntil) : null,
      cache_entries: this.#cache.size,
      total_requests: this.#totalRequests,
      last_request_at: this.#lastRequestAt === null ? null : isoOf(this.#lastRequestAt),
      last_error: this.#lastError,
    }
  }

  /**
   * Drop every cached and in-flight response.
   *
   * Called when the stored cookie changes: a read issued under the old cookie
   * must not answer for the new one, and `/me` is the case that matters most.
   */
  clearCache() {
    this.#cacheEpoch += 1
    this.#cache.clear()
    this.#inflight.clear()
  }

  /** Content and excerpt bounds, in code points. */
  #bounds() {
    return { contentChars: this.#config.contentChars, excerptChars: this.#config.excerptChars }
  }

  // ── request plumbing ──────────────────────────────────────────────────────

  /**
   * Read one article page reached through a redirect.
   * @param url - the redirect target.
   * @param articleId - the id the target must still render.
   * @param signal - caller cancellation.
   * @returns the article.
   */
  async #articleAt(url, articleId, signal) {
    const response = await this.#getPage(url, signal)
    if (response.status >= 300) throw missingFailure('article', articleId)
    return this.#articleFromPage(response, articleId)
  }

  /**
   * Turn a page without its embedded state into the right failure.
   *
   * A 200 carrying a verification page is risk control, not a layout change:
   * it must pause the process, or the next call repeats the refusal.
   *
   * @param kind - the resource kind, for the message.
   * @param text - the page source.
   * @returns the failure to throw.
   */
  #pageFailure(kind, text) {
    if (looksLikeVerification(text)) {
      return this.#pause(
        'risk_control',
        'Zhihu answered the page with a verification or captcha page instead of the content, which is risk control. The process is paused for a while; do not retry immediately.',
        this.#config.pauseRiskMs,
      )
    }
    return pageShapeFailure(kind)
  }

  /**
   * Parse one article page that has already been fetched.
   * @param response - the page response.
   * @param articleId - the expected id.
   * @returns the article.
   */
  #articleFromPage(response, articleId) {
    const state = readInitialState(response.text)
    if (state === null) throw this.#pageFailure('article', response.text)
    const raw = state.entities?.articles?.[articleId]
    if (raw === undefined) throw missingFailure('article', articleId)
    return {
      article: articleFromEntity(raw, articleId, peopleMap(state), this.#bounds()),
      snapshot: snapshotOf(response),
    }
  }

  /**
   * Read one page, accepting HTML.
   * @param url - absolute URL.
   * @param signal - caller cancellation.
   * @returns the response, including a 3xx status and its location.
   */
  async #getPage(url, signal) {
    return this.#request(url, { accept: HTML_ACCEPT, signal })
  }

  /**
   * Read one JSON endpoint.
   * @param url - absolute URL.
   * @param options - cookie override, cache bypass, and cancellation.
   * @returns the response with its parsed body.
   * @throws {RequestFailure} `invalid_response` when the body is not JSON.
   */
  async #getJson(url, { cookie, fresh = false, signal } = {}) {
    const response = await this.#request(url, { accept: JSON_ACCEPT, cookie, fresh, signal })
    let parsed
    try {
      parsed = parseJsonPreservingIds(response.text)
    } catch {
      throw new RequestFailure('invalid_response', 'Zhihu answered with something that is not JSON.')
    }
    const error = apiError(parsed)
    if (error !== null) {
      throw new RequestFailure(
        'upstream_error',
        `Zhihu answered with error ${String(error.code ?? '')}: ${String(error.message ?? 'no message')}`,
      )
    }
    return { ...response, json: parsed }
  }

  /**
   * One request through the cache, the in-flight map, and the serialized queue.
   *
   * @param url - absolute URL.
   * @param options - accept header, cookie override, cache bypass, cancellation.
   * @returns the response.
   */
  async #request(url, { accept = JSON_ACCEPT, cookie, fresh = false, signal }) {
    const bypass = cookie !== undefined
    // A cookie being tested is not cached and never joins an in-flight request
    // for the stored cookie: the answer must belong to the cookie, not to
    // whichever call reached Zhihu first.
    const key = bypass ? null : url
    if (key !== null) {
      if (!fresh) {
        const hit = this.#cacheGet(key)
        if (hit !== null) return hit
      }
      // A fresh read must reach Zhihu, so it never joins an in-flight read.
      const existing = fresh ? undefined : this.#inflight.get(key)
      if (existing !== undefined) return existing
    }

    const epoch = this.#cacheEpoch
    const run = this.#enqueue(() => this.#perform(url, accept, cookie, signal))
      .then((response) => {
        // A cookie change while this request was in flight makes its answer
        // stale by construction; it is returned to its caller but not cached.
        if (key !== null && epoch === this.#cacheEpoch) this.#cacheSet(key, response)
        return response
      })
      .catch((error) => {
        if (error instanceof RequestFailure) {
          this.#lastError = { code: error.code, message: error.message, at: isoOf(this.#wallNow()) }
        }
        throw error
      })

    if (key === null) return run
    const tracked = run.finally(() => {
      if (this.#inflight.get(key) === tracked) this.#inflight.delete(key)
    })
    this.#inflight.set(key, tracked)
    return tracked
  }

  /**
   * Issue one request, retrying a transport failure once.
   *
   * Runs inside the queue, so the pacing state it reads cannot change while it
   * waits.
   *
   * @param url - absolute URL.
   * @param accept - accept header.
   * @param cookie - cookie override, when validating a new one.
   * @param signal - caller cancellation.
   * @returns the response.
   */
  async #perform(url, accept, cookie, signal) {
    if (isCallerAbort(signal)) {
      throw new RequestFailure('aborted', 'The request was cancelled before it was issued.')
    }
    const cookieHeader = await this.#cookieHeader(cookie)
    for (let attempt = 0; ; attempt += 1) {
      await this.#gate()
      this.#pacer.start()
      this.#recordRequest()
      const startedAt = this.#wallNow()
      let response
      try {
        response = await this.#send(url, accept, cookieHeader, signal)
      } catch (error) {
        if (isCallerAbort(signal)) {
          throw new RequestFailure('aborted', 'The request was cancelled before Zhihu answered.')
        }
        const timedOut = isTimeout(error)
        if (attempt < this.#config.retryAttempts) {
          await sleep(this.#config.retryDelayMs)
          continue
        }
        throw this.#pause(
          timedOut ? 'timeout' : 'request_failed',
          timedOut
            ? `Zhihu did not answer within ${this.#config.requestTimeoutMs} ms. The process is paused briefly.`
            : 'Zhihu could not be reached. The process is paused briefly; check the network before retrying.',
          this.#config.pauseNetworkMs,
        )
      }
      const fetchedAt = isoOf(startedAt)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (isSigninLocation(location)) {
          throw new RequestFailure(
            'not_authorized',
            'Zhihu redirected to its sign-in page, so the stored cookie is no longer signed in. Add a fresh cookie on the Zhihu plugin page.',
          )
        }
        return { status: response.status, text: '', location, fetchedAt, cached: false }
      }
      const body = await readBoundedBody(response, this.#config.responseLimitBytes, 'Zhihu')
      const text = body.bytes.toString('utf8')
      const status = body.status
      if (status >= 200 && status < 300) {
        return { status, text, location: null, fetchedAt, cached: false }
      }
      throw this.#classifyFailure(status, text, body.headers)
    }
  }

  /**
   * Turn a non-2xx response into the failure the caller sees, pausing the
   * process when the status means "too many requests" rather than "no such
   * resource".
   *
   * @param status - the HTTP status.
   * @param text - the body, already read.
   * @param headers - the response headers.
   * @returns the failure to throw.
   */
  #classifyFailure(status, text, headers) {
    if (status === 401) {
      return new RequestFailure(
        'not_authorized',
        'Zhihu refused the stored cookie. It is expired or was signed out; add a fresh cookie on the Zhihu plugin page.',
      )
    }
    if (status === 403) {
      const code = jsonErrorCode(text)
      if (code === 10003) {
        return this.#pause(
          'signature_required',
          'This Zhihu endpoint requires the web client\'s signed headers (error 10003). The plugin does not forge that signature; use the question, answer, article, or list tools instead.',
          this.#config.pauseSignatureMs,
        )
      }
      if (looksLikeVerification(text)) {
        return this.#pause(
          'risk_control',
          'Zhihu answered with a verification or captcha page, which is risk control. The process is paused for a while; do not retry, and consider spacing reads further apart.',
          this.#config.pauseRiskMs,
        )
      }
      return this.#pause(
        'forbidden',
        'Zhihu refused the request with 403. That is usually risk control or a missing permission; the process is paused for a while.',
        this.#config.pauseRiskMs,
      )
    }
    if (status === 404) {
      return new RequestFailure('not_found', 'Zhihu has no such resource, or it was deleted or made private.')
    }
    if (status === 429) {
      const pause = retryAfterMs(headers, this.#config.pauseRateLimitMs)
      return this.#pause(
        'rate_limited',
        `Zhihu rate-limited the request (429). The process is paused for ${Math.ceil(pause / 1000)} seconds.`,
        pause,
      )
    }
    if (status >= 500) {
      return this.#pause(
        'upstream_unavailable',
        `Zhihu answered with ${status}. The process is paused briefly; retry later.`,
        this.#config.pauseNetworkMs,
      )
    }
    return new RequestFailure('http_status', `Zhihu answered with HTTP ${status}.`)
  }

  /**
   * Apply the hourly budget and the shared pacer.
   *
   * @returns resolution once this process may issue a request.
   * @throws {RequestFailure} `request_budget_exhausted` or `temporarily_blocked`.
   */
  async #gate() {
    const now = this.#wallNow()
    this.#pruneBudget(now)
    if (this.#requestTimes.length >= this.#config.hourlyBudget) {
      const retryAt = this.#requestTimes[0] + HOUR_MS
      throw new RequestFailure(
        'request_budget_exhausted',
        `This process allows ${this.#config.hourlyBudget} Zhihu requests per hour and has used them. The next one is allowed after ${isoOf(retryAt)}.`,
        { retryable: true, retryAt },
      )
    }
    try {
      await this.#pacer.gate()
    } catch (error) {
      if (error instanceof RequestFailure && error.retryAt !== null) this.#pausedUntil = error.retryAt
      throw error
    }
  }

  /**
   * Drop request timestamps that have left the rolling hour.
   * @param now - the current wall-clock instant.
   */
  #pruneBudget(now) {
    while (this.#requestTimes.length > 0 && now - this.#requestTimes[0] >= HOUR_MS) {
      this.#requestTimes.shift()
    }
  }

  /** Record that a request is being issued now. */
  #recordRequest() {
    const now = this.#wallNow()
    this.#requestTimes.push(now)
    this.#lastRequestAt = now
    this.#totalRequests += 1
  }

  /**
   * Pause the process and build the matching failure.
   * @param code - the closed failure code.
   * @param message - the model-facing explanation.
   * @param ms - the pause length in milliseconds.
   * @returns the failure to throw.
   */
  #pause(code, message, ms) {
    const failure = this.#pacer.pause(code, message, ms)
    this.#pausedUntil = failure.retryAt
    return failure
  }

  /**
   * Read the cookie to send, refusing before any request when none is stored.
   * @param override - a cookie being tested, which must still be well formed.
   * @returns the Cookie header value.
   */
  async #cookieHeader(override) {
    if (override !== undefined) {
      try {
        return normalizeCookie(override)
      } catch (error) {
        if (error instanceof CookieError) throw error
        throw new CookieError(error instanceof Error ? error.message : String(error))
      }
    }
    let stored
    try {
      stored = await this.#readCookie()
    } catch (error) {
      throw new RequestFailure(
        'credential_invalid',
        `The stored Zhihu cookie cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (stored === undefined) {
      throw new RequestFailure(
        'not_connected',
        'No Zhihu cookie is stored. Paste one on the Zhihu plugin page, or call zhihu_connect with the Cookie header copied from a signed-in zhihu.com page.',
      )
    }
    try {
      return normalizeCookie(stored.cookie)
    } catch (error) {
      throw new RequestFailure(
        'credential_invalid',
        `The stored Zhihu cookie is unusable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Issue one transport request with its own timeout, linked to the caller's signal.
   * @param url - absolute URL.
   * @param accept - accept header.
   * @param cookie - the Cookie header value.
   * @param signal - caller cancellation.
   * @returns the response.
   */
  async #send(url, accept, cookie, signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs)
    const forward = () => controller.abort()
    if (signal !== undefined && signal !== null) {
      signal.addEventListener('abort', forward, { once: true })
      if (signal.aborted) controller.abort()
    }
    try {
      return await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          cookie,
          'user-agent': this.#config.userAgent,
          accept,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
          referer: 'https://www.zhihu.com/',
          ...(accept === JSON_ACCEPT ? { 'x-requested-with': 'fetch' } : {}),
        },
      })
    } finally {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', forward)
    }
  }

  /**
   * Queue one task behind every request already in flight.
   * @param task - the task to run.
   * @returns the task's result, with the queue continuing either way.
   */
  #enqueue(task) {
    const run = this.#queue.then(() => task())
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Read one cache entry, refreshing its LRU position.
   * @param key - the cache key.
   * @returns the cached response, or null when absent or expired.
   */
  #cacheGet(key) {
    const entry = this.#cache.get(key)
    if (entry === undefined) return null
    const now = this.#wallNow()
    if (now >= entry.expiresAt) {
      this.#cache.delete(key)
      return null
    }
    this.#cache.delete(key)
    this.#cache.set(key, entry)
    return {
      ...entry.response,
      cached: true,
      cacheAgeSeconds: Math.max(0, Math.floor((now - entry.fetchedAtMs) / 1000)),
    }
  }

  /**
   * Store one successful response, evicting the oldest entry past the bound.
   * @param key - the cache key.
   * @param response - the response to store.
   */
  #cacheSet(key, response) {
    if (response.status !== 200) return
    const now = this.#wallNow()
    this.#cache.set(key, { response, fetchedAtMs: now, expiresAt: now + this.#config.cacheTtlMs })
    while (this.#cache.size > this.#config.cacheMaxEntries) {
      const oldest = this.#cache.keys().next().value
      if (oldest === undefined) break
      this.#cache.delete(oldest)
    }
  }
}

/**
 * Normalize an entity key to the string form an object uses.
 * @param value - a numeric or string key.
 * @returns the key as text.
 */
function asEntityKey(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return typeof value === 'string' ? value : ''
}

/**
 * The failure for a page whose embedded state is missing or unparseable.
 * @param kind - the resource kind, for the message.
 * @returns the failure.
 */
function pageShapeFailure(kind) {
  return new RequestFailure(
    'page_not_recognized',
    `Zhihu served a ${kind} page without the embedded state this plugin reads, so its layout has probably changed.`,
  )
}

/**
 * The failure for a page that loaded but does not contain the requested item.
 * @param kind - the resource kind.
 * @param id - the id that was requested.
 * @returns the failure.
 */
function missingFailure(kind, id) {
  return new RequestFailure(
    'not_found',
    `Zhihu served the ${kind} page but it contains no ${kind} with id ${id}; it may be deleted, private, or the id may be wrong.`,
  )
}

/**
 * Extract the question/answer target of a redirect, refusing another host.
 * @param location - the Location header, relative or absolute.
 * @returns the absolute target URL, or null when it is not a Zhihu answer page.
 */
function redirectTarget(location) {
  if (typeof location !== 'string' || location === '') return null
  let resolved
  try {
    resolved = new URL(location, ORIGIN)
  } catch {
    return null
  }
  if (resolved.hostname !== 'www.zhihu.com') return null
  if (!/^\/question\/[0-9]+\/answer\/[0-9]+$/.test(resolved.pathname)) return null
  return resolved.href
}

/**
 * Extract the column-article target of a redirect, refusing another host.
 * @param location - the Location header, relative or absolute.
 * @returns the absolute target URL, or null when it is not an article page.
 */
function articleRedirectTarget(location) {
  if (typeof location !== 'string' || location === '') return null
  let resolved
  try {
    resolved = new URL(location, ARTICLE_ORIGIN)
  } catch {
    return null
  }
  if (resolved.hostname !== 'zhuanlan.zhihu.com' && resolved.hostname !== 'www.zhihu.com') return null
  if (!/^\/p\/[0-9]+\/?$/.test(resolved.pathname)) return null
  return resolved.href
}

/**
 * Whether a redirect goes to the sign-in flow.
 * @param location - the Location header.
 * @returns true when the cookie is no longer signed in.
 */
function isSigninLocation(location) {
  if (typeof location !== 'string') return false
  return /\/signin\b|\/login\b|\/account\/unhuman/i.test(location)
}

/**
 * Read the closed error code out of a JSON error body.
 * @param text - the response body.
 * @returns the code, or null.
 */
function jsonErrorCode(text) {
  try {
    const parsed = JSON.parse(text)
    const code = parsed?.error?.code
    return Number.isInteger(code) ? code : null
  } catch {
    return null
  }
}

/**
 * Whether a 403 body is a verification/captcha page rather than a permission error.
 * @param text - the response body.
 * @returns true for the risk-control signals.
 */
function looksLikeVerification(text) {
  return /unhuman|captcha|验证码|安全验证|人机验证|异常请求|系统检测到您的网络环境/i.test(text)
}

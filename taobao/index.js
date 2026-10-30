/**
 * taobao — cross-platform product price comparison exposed as four Host tools.
 *
 * The data comes from maishou88.com, a commercial affiliate aggregation
 * service that fans a keyword out to Taobao/TMall, JD, Pinduoduo, Suning,
 * Vipshop, Douyin, and Kuaishou. This plugin never talks to any of those
 * platforms directly and holds no account there; it issues unauthenticated
 * requests to maishou88.com's app API with this plugin's own fixed headers.
 *
 * Every tool result records what the answer does and does not cover:
 * `coverage` names each channel that was queried, its status, and how many
 * records came back, so a caller cannot report "cheapest across all
 * platforms" from a partial search. `affiliate` reports that the returned
 * purchase links and item ids carry an invite code that earns the operator a
 * commission, so the model discloses it. `source` carries the attribution and
 * the fact that prices are indicative rather than authoritative.
 *
 * An expected request failure (transport, timeout, 5xx, 403, 429, or a
 * response that violates the endpoint contract) comes back as an `ok: false`
 * payload carrying a closed `error.code`, so the model reads the failure and
 * its retry time instead of losing the call; only argument validation throws.
 *
 * Requests are serialized, spaced by a minimum interval, and backed off after
 * a transport, 5xx, 403, or 429 failure. That state lives in this plugin
 * instance only and disappears when the process exits or the plugin reloads,
 * so saving this file clears any backoff in force.
 *
 * @module dsh-taobao
 */

import {
  RequestFailure,
  characterCount,
  createPacer,
  defineUsageError,
  intHeader,
  isCallerAbort,
  isTimeout,
  isoSeconds as sharedIsoSeconds,
  readBoundedBody,
  retryAfterMs,
  sendRequest,
  sleep,
  toFailurePayload,
  truncate,
} from '../shared/http.js'

/**
 * Cordis plugin name used by loader diagnostics.
 */
export const name = 'taobao'

/**
 * The tool registry this plugin contributes to.
 */
export const inject = ['tools']

// ── protocol constants (fixed: they describe the remote API, not a tunable) ──

/** Origin of the search and item-detail endpoints. */
const APP_ORIGIN = 'https://appapi.maishou88.com'

/** Origin of the share-link endpoint. */
const SHARE_ORIGIN = 'https://msapi.maishou88.com'

/** Keyword search across the selected channels. */
const SEARCH_PATH = '/api/v1/homepage/searchList'

/** One item's detail by channel and id. */
const DETAIL_PATH = '/api/v3/goods/detail'

/** The purchase link and share code for one item. */
const TARGET_PATH = '/api/v1/share/getTargetUrl'

/** App identity maishou88.com expects on every request. */
const CLIENT_HEADERS = {
  'user-agent': 'MaiShouApp/3.7.7 (iPhone; iOS 26.3; Scale/3.00)',
  openid: '564bdce0fa408fc9e1d5d42fd022ef0b',
  version: '3.7.7.2',
}

/** The referer the web client sends; the app endpoints accept it. */
const WEB_REFERER = 'https://hnbc018.kuaizhan.com/'

/** The `Accept` header every request sends. */
const JSON_ACCEPT = 'application/json'

/**
 * Every channel the remote API can return, keyed by the `source` argument.
 * `0` means "every channel at once" and is not itself a channel.
 */
const CHANNELS = new Map([
  [1, '淘宝/天猫'],
  [2, '京东'],
  [3, '拼多多'],
  [4, '苏宁'],
  [5, '唯品会'],
  [7, '抖音'],
  [8, '快手'],
])

/** Channels a request that omits `source` fans out to, in stable order. */
const ALL_CHANNELS = [...CHANNELS.keys()]

/** The `source` value meaning every channel in one request. */
const SOURCE_ALL = 0

/** Caveat attached to every successful payload. */
const SOURCE_NOTICE = 'Prices and coupons come from the third-party aggregator maishou88.com, not from the platforms themselves, and change in real time; they are indicative and the platform page governs.'

/** Disclosure attached when returned links carry an invite code. */
const AFFILIATE_NOTICE = 'Returned purchase links, share codes, and item ids carry an invite code, so a purchase through them may earn the operator of this plugin a commission. Tell the user this whenever purchase links or share codes are shown.'

// ── configuration ───────────────────────────────────────────────────────────

/**
 * Every configurable value with its default. The plugin declares no
 * schemastery `Config` (it carries no dependencies), so {@link resolveConfig}
 * validates the row's `config` itself and fails the load on a bad value.
 */
const DEFAULT_CONFIG = {
  inviteCode: '',
  discloseAffiliate: true,
  requestTimeoutMs: 10_000,
  responseLimitBytes: 4_194_304,
  minIntervalMs: 800,
  retryDelayMs: 1_000,
  pauseNetworkMs: 60_000,
  pauseForbiddenMs: 1_800_000,
  pauseDefaultMs: 600_000,
  searchDefaultLimit: 20,
  searchMaxLimit: 50,
  comparePlatformsPerPage: 20,
  compareMaxPlatformsPerPage: 50,
  compareMaxPagesPerPlatform: 5,
  outputChars: 20_000,
  toolTimeoutMs: 120_000,
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

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
    throw new Error(`taobao: config.${key} must be a positive integer`)
  }
  return value
}

/**
 * Read one boolean config field, falling back to its default.
 *
 * @param config - the row's raw `config` object.
 * @param key - field name, also used in the failure message.
 * @returns the configured value, or the default when the field is absent.
 */
function configBoolean(config, key) {
  const value = config[key]
  if (value === undefined) return DEFAULT_CONFIG[key]
  if (typeof value !== 'boolean') throw new Error(`taobao: config.${key} must be a boolean`)
  return value
}

/**
 * Resolve and validate the row's `config` into the complete option set.
 *
 * Fails loud at load on an unknown key, a non-positive integer, an invite code
 * that is neither empty nor alphanumeric, or a default limit above its cap:
 * each would otherwise surface later as a confusing runtime failure.
 *
 * @param raw - the `config` value the Loader passed to `apply`, if any.
 * @returns every option resolved to a concrete value.
 */
function resolveConfig(raw) {
  const config = raw === undefined || raw === null ? {} : raw
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('taobao: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`taobao: unknown config key "${key}"`)
  }
  const resolved = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === 'inviteCode' || key === 'discloseAffiliate') continue
    resolved[key] = configInteger(config, key)
  }
  const inviteCode = config.inviteCode ?? DEFAULT_CONFIG.inviteCode
  if (typeof inviteCode !== 'string' || !/^[A-Za-z0-9]*$/.test(inviteCode)) {
    throw new Error('taobao: config.inviteCode must be empty or alphanumeric')
  }
  resolved.inviteCode = inviteCode
  resolved.discloseAffiliate = configBoolean(config, 'discloseAffiliate')
  if (resolved.searchDefaultLimit > resolved.searchMaxLimit) {
    throw new Error('taobao: config.searchDefaultLimit must not exceed config.searchMaxLimit')
  }
  if (resolved.comparePlatformsPerPage > resolved.compareMaxPlatformsPerPage) {
    throw new Error('taobao: config.comparePlatformsPerPage must not exceed config.compareMaxPlatformsPerPage')
  }
  return resolved
}

// ── failures ────────────────────────────────────────────────────────────────

/** Local argument-validation failure. No request is issued. */
const UsageError = defineUsageError('TaobaoUsageError')

/**
 * Convert a caught error into the model-facing failure value.
 *
 * @param error - the caught value.
 * @returns the failure payload.
 */
function failurePayload(error) {
  return toFailurePayload(error, 'taobao')
}

// ── response coercion ───────────────────────────────────────────────────────

/**
 * Format an epoch-second timestamp as `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * @param epochSeconds - the remote timestamp.
 * @returns the UTC instant.
 */
function isoSeconds(epochSeconds) {
  return sharedIsoSeconds(epochSeconds, 'A maishou88')
}

/** The epoch-second time a successful response was read. */
function readAt() {
  return isoSeconds(Math.floor(Date.now() / 1000))
}

/**
 * Read a remote money field, which maishou88 sends as a decimal string.
 *
 * @param value - the raw JSON field.
 * @param field - field name used in the failure message.
 * @returns the amount, or null when the field is absent or blank.
 */
function asMoney(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string') {
    const stripped = value.trim()
    if (stripped === '') return null
    if (/^[0-9]+(\.[0-9]+)?$/.test(stripped)) return Number(stripped)
  }
  throw new RequestFailure('invalid_response', `maishou88 response field ${field} is not a price.`)
}

/**
 * Read a remote text field.
 *
 * @param value - the raw JSON field.
 * @returns the text, or null when the field is absent or not a string.
 */
function asTextOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Read the `sourceType` a record belongs to.
 *
 * @param value - the raw JSON field.
 * @returns the channel number.
 */
function asSourceType(value) {
  const number = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isInteger(number) || !CHANNELS.has(number)) {
    throw new RequestFailure('invalid_response', 'A maishou88 record carries an unknown sourceType.')
  }
  return number
}

/**
 * Project one search or detail record into the model-facing item. Only fields
 * the remote API actually reports survive; a price it does not return stays
 * null rather than being estimated.
 *
 * @param raw - one raw record object.
 * @param commission - whether to include commission fields.
 * @returns the trimmed item.
 */
function projectItem(raw, commission) {
  const source = asSourceType(raw.sourceType)
  const title = typeof raw.title === 'string' ? raw.title : ''
  const sales = asTextOrNull(raw.salesStr) ?? asTextOrNull(raw.monthSales)
  const item = {
    goods_id: typeof raw.goodsId === 'string' && raw.goodsId !== '' ? raw.goodsId : null,
    source,
    channel: CHANNELS.get(source),
    platform: asTextOrNull(raw.sourceTypeName) ?? asTextOrNull(raw.platformName),
    shop: asTextOrNull(raw.shopName),
    shop_type: asTextOrNull(raw.shopTypeName),
    title,
    title_chars: characterCount(title),
    original_price: asMoney(raw.originalPrice, 'originalPrice'),
    actual_price: asMoney(raw.actualPrice, 'actualPrice'),
    coupon_price: asMoney(raw.couponPrice, 'couponPrice'),
    coupon_text: asTextOrNull(raw.couponText),
    sales,
    seller_rating: asTextOrNull(raw.favorableRate),
    image: asTextOrNull(raw.picUrl),
    tags: Array.isArray(raw.tagList) ? raw.tagList.filter(tag => typeof tag === 'string' && tag !== '') : [],
  }
  if (commission) item.commission = asMoney(raw.commission, 'commission')
  if (item.goods_id === null) {
    throw new RequestFailure('invalid_response', 'A maishou88 record carries no goodsId.')
  }
  return item
}

/**
 * Decide whether the remote reply reports success. maishou88 answers HTTP 200
 * with a `status`/`code` pair and an empty `data` for a query that matched
 * nothing, so the envelope rather than the body decides.
 *
 * @param parsed - the parsed JSON body.
 * @returns whether the envelope reports a successful query.
 */
function isSuccessEnvelope(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const status = parsed.status
  const code = parsed.code
  return (status === undefined || status === 'success') && (code === undefined || code === 200 || code === '200')
}

/**
 * The remote explanation carried by a failed envelope.
 *
 * @param parsed - the parsed JSON body, if it parsed.
 * @param text - the raw response text.
 * @returns a short explanation for the model.
 */
function describeFailure(parsed, text) {
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const message = asTextOrNull(parsed.message)
    const status = parsed.status === undefined ? '' : `status=${String(parsed.status)} `
    if (message !== null) return truncate(`${status}${message}`, 300)
  }
  return truncate(text.trim() === '' ? 'empty response' : text.trim(), 300)
}

/**
 * Parse a response body as JSON without throwing.
 *
 * @param bytes - the response bytes.
 * @returns the parsed value, or undefined when the body is not UTF-8 JSON.
 */
function parseJson(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { parsed: undefined, text: '' }
  }
  try {
    return { parsed: JSON.parse(text), text }
  } catch {
    return { parsed: undefined, text }
  }
}

// ── client ──────────────────────────────────────────────────────────────────

/**
 * One process-local maishou88 client. Every query shares its serialization
 * chain and backoff state, so concurrent tool calls cannot exceed the pacing
 * the remote API tolerates.
 */
class MaishouClient {
  /**
   * @param config - the resolved plugin options.
   */
  constructor(config) {
    this._config = config
    this._tail = Promise.resolve()
    this._pacer = createPacer({ label: 'maishou88', config })
  }

  /**
   * Resolve the affiliate disclosure attached to every payload.
   *
   * @returns the disclosure value.
   */
  affiliate() {
    const enabled = this._config.discloseAffiliate && this._config.inviteCode !== ''
    return { invite_code_in_links: enabled, notice: enabled ? AFFILIATE_NOTICE : null }
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
   * Search one channel, or every channel when `source` is omitted.
   *
   * @param keyword - the search keyword.
   * @param source - one channel number, or `0`/undefined for all of them.
   * @param page - 1-based result page.
   * @param limit - maximum records to return.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async search(keyword, source, page, limit, signal) {
    const selected = source ?? SOURCE_ALL
    try {
      const { data, receivedAt } = await this._request(APP_ORIGIN, SEARCH_PATH, { form: searchForm(keyword, selected, page) }, signal)
      if (!Array.isArray(data)) {
        throw new RequestFailure('invalid_response', 'The maishou88 search response carries no record list.')
      }
      // The remote API returns more than one record only for source=0, where each
      // channel fills the page with its own results.
      const returned = data.slice(0, limit).map(raw => projectItem(raw, false))
      return {
        ok: true,
        source: 'taobao',
        query: 'search',
        keyword,
        requested_source: selected,
        channels_requested: selected === SOURCE_ALL ? ALL_CHANNELS : [selected],
        page,
        available_count: data.length,
        returned_count: returned.length,
        coverage: coverageOf(data, selected === SOURCE_ALL ? ALL_CHANNELS : [selected]),
        items: returned,
        received_at: receivedAt,
        source_notice: SOURCE_NOTICE,
        affiliate: this.affiliate(),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read one item's detail and, unless `includeLinks` is false, its purchase
   * link and share code.
   *
   * @param goodsId - the item id as a search returned it.
   * @param source - the channel the id belongs to.
   * @param includeLinks - whether to resolve the purchase link.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async detail(goodsId, source, includeLinks, signal) {
    try {
      const body = detailBody(this._config, goodsId, source)
      const { data, receivedAt } = await this._request(APP_ORIGIN, DETAIL_PATH, { json: body }, signal)
      if (typeof data !== 'object' || data === null || Array.isArray(data) || Object.keys(data).length === 0) {
        throw new RequestFailure('not_found', 'maishou88 returned no detail for this goods_id and source.')
      }
      const item = projectItem(data, true)
      const payload = {
        ok: true,
        source: 'taobao',
        query: 'detail',
        queried: { goods_id: goodsId, source },
        item,
        // The platform may re-encode the id, so the search value stays available.
        id_changed: item.goods_id !== goodsId,
        categories: {
          level_one: asTextOrNull(data.levelOneCategoryName),
        },
        links: { available: false, app_url: null, h5_url: null, schema_url: null, share_code: null, note: null },
        received_at: receivedAt,
        source_notice: SOURCE_NOTICE,
        affiliate: this.affiliate(),
      }
      if (!includeLinks) {
        payload.links.note = 'The purchase link was not requested; call with include_links to resolve it.'
        return payload
      }
      try {
        const target = await this._request(SHARE_ORIGIN, TARGET_PATH, { json: { ...body, isDirectDetail: 0 } }, signal)
        const links = target.data
        if (typeof links !== 'object' || links === null || Array.isArray(links)) {
          throw new RequestFailure('invalid_response', 'The maishou88 share-link response carries no link object.')
        }
        const appUrl = asTextOrNull(links.appUrl)
        const h5Url = asTextOrNull(links.h5Url)
        const schemaUrl = asTextOrNull(links.schemaUrl)
        const shareCode = asTextOrNull(links.kl)
        const available = appUrl !== null || h5Url !== null || schemaUrl !== null || shareCode !== null
        payload.links = {
          available,
          app_url: appUrl,
          h5_url: h5Url,
          schema_url: schemaUrl,
          share_code: shareCode,
          note: available ? null : 'maishou88 returned no purchase link for this item.',
        }
      } catch (error) {
        if (!(error instanceof RequestFailure)) throw error
        payload.links = {
          available: false,
          app_url: null,
          h5_url: null,
          schema_url: null,
          share_code: null,
          note: `The purchase link could not be resolved (${error.code}); the item data above is still valid.`,
        }
      }
      return payload
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Query every selected channel separately, page by page, and rank the merged
   * records by actual price.
   *
   * Per-channel queries rather than one `source=0` query, because only the
   * former can report each channel's own status and lets one dead channel fail
   * alone.
   *
   * @param keyword - the search keyword.
   * @param platforms - the channel numbers to query.
   * @param pages - 1-based pages to read per channel.
   * @param perPlatform - maximum records to keep per channel.
   * @param includeCommission - whether to include commission fields.
   * @param signal - caller cancellation, combined with the request timeout.
   * @returns the success or failure payload.
   */
  async compare(keyword, platforms, pages, perPlatform, includeCommission, signal) {
    try {
      const perChannel = new Map(platforms.map(source => [source, { status: 'not_attempted', items: [], error: null }]))
      const halted = { reason: null }
      for (const page of pages) {
        // Once maishou88 refuses this process, the remaining channels cannot
        // succeed; they are reported as not attempted rather than as failures
        // of their own.
        if (halted.reason !== null) break
        for (const source of platforms) {
          if (halted.reason !== null) break
          const outcome = await this._channelPage(keyword, source, page, includeCommission, signal)
          const bucket = perChannel.get(source)
          if (outcome.status === 'ok') {
            bucket.status = 'ok'
            bucket.items.push(...outcome.items)
          } else if (outcome.status !== 'no_results' && bucket.error === null) {
            bucket.status = outcome.status
            bucket.error = outcome.error
            if (this._refusedByRemote(outcome.status)) halted.reason = outcome.status
          } else if (bucket.status !== 'ok' && bucket.error === null) {
            bucket.status = 'no_results'
          }
        }
      }

      const coverage = []
      const items = []
      for (const source of platforms) {
        const bucket = perChannel.get(source)
        const kept = bucket.items.slice(0, perPlatform)
        const entry = {
          source,
          channel: CHANNELS.get(source),
          status: bucket.status,
          records: bucket.items.length,
          kept: kept.length,
        }
        if (bucket.error !== null) entry.error = failureView({ error: bucket.error })
        coverage.push(entry)
        items.push(...kept)
      }

      const ranked = items
        .filter(item => item.actual_price !== null)
        .sort((left, right) => left.actual_price - right.actual_price || left.source - right.source)
      const unranked = items.filter(item => item.actual_price === null)
      const withResults = coverage.filter(entry => entry.status === 'ok').length
      const failed = coverage.filter(entry => entry.status !== 'ok' && entry.status !== 'no_results' && entry.status !== 'not_attempted').length
      const notAttempted = coverage.filter(entry => entry.status === 'not_attempted').length
      const noResults = coverage.filter(entry => entry.status === 'no_results').length
      // A caller may assert a cross-platform lowest price only when every
      // requested channel answered with records.
      const verdict = withResults === coverage.length ? 'all' : withResults === 0 ? 'none' : 'partial'
      const names = status => coverage.filter(entry => status(entry)).map(entry => entry.channel)
      const gaps = []
      if (failed > 0) gaps.push(`${names(entry => entry.status !== 'ok' && entry.status !== 'no_results' && entry.status !== 'not_attempted').join(', ')} failed`)
      if (noResults > 0) gaps.push(`${names(entry => entry.status === 'no_results').join(', ')} returned no records`)
      if (notAttempted > 0) gaps.push(`${names(entry => entry.status === 'not_attempted').join(', ')} not attempted after maishou88 refused this process`)

      return {
        ok: true,
        source: 'taobao',
        query: 'compare',
        keyword,
        pages,
        platforms_requested: platforms,
        coverage,
        summary: {
          platforms_queried: coverage.length,
          platforms_with_results: withResults,
          platforms_no_results: noResults,
          platforms_failed: failed,
          platforms_not_attempted: notAttempted,
          ranked_items: ranked.length,
          unranked_items: unranked.length,
          lowest_observed: ranked.length === 0
            ? null
            : {
                source: ranked[0].source,
                channel: ranked[0].channel,
                shop: ranked[0].shop,
                actual_price: ranked[0].actual_price,
                goods_id: ranked[0].goods_id,
              },
        },
        verdict,
        verdict_note: verdict === 'all'
          ? 'Every requested channel returned records; the first ranked item is the lowest observed among them. Channels not requested are outside this comparison, and prices are indicative.'
          : `This comparison is incomplete: ${gaps.join(', ')}. Report it as partial and do not call the cheapest record the lowest price across all platforms.`,
        items: [...ranked, ...unranked],
        received_at: readAt(),
        source_notice: SOURCE_NOTICE,
        affiliate: this.affiliate(),
      }
    } catch (error) {
      return failurePayload(error)
    }
  }

  /**
   * Read one channel's page of a comparison. A request failure becomes this
   * channel's status rather than failing the whole comparison.
   *
   * @param keyword - the search keyword.
   * @param source - the channel number.
   * @param page - the 1-based page.
   * @param includeCommission - whether to include commission fields.
   * @param signal - caller cancellation.
   * @returns the channel page: its status and whatever records arrived.
   */
  async _channelPage(keyword, source, page, includeCommission, signal) {
    try {
      const data = await this._request(APP_ORIGIN, SEARCH_PATH, { form: searchForm(keyword, source, page) }, signal).then(result => result.data)
      if (!Array.isArray(data)) {
        throw new RequestFailure('invalid_response', 'The maishou88 search response carries no record list.')
      }
      const items = data.map(raw => projectItem(raw, includeCommission)).filter(item => item.source === source)
      return { source, page, status: items.length === 0 ? 'no_results' : 'ok', items }
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error
      return { source, page, status: error.code, items: [], error }
    }
  }

  /**
   * Whether a channel failure means maishou88 refused the whole process rather
   * than this one query, so the remaining channels of a comparison cannot
   * succeed either.
   *
   * @param status - a failed channel page's status.
   * @returns whether the comparison should stop issuing requests.
   */
  _refusedByRemote(status) {
    return status === 'access_denied' || status === 'rate_limited'
  }

  /**
   * Issue one whitelisted POST, retrying once after a transport failure, a
   * timeout, or a 5xx before backing this process off.
   *
   * @param origin - the endpoint origin, which must be a known one.
   * @param path - the endpoint path, which must be in the whitelist.
   * @param payload - exactly one of `form` (urlencoded) or `json` (JSON body).
   * @param signal - caller cancellation.
   * @returns the response `data` field and the time it was read.
   */
  _request(origin, path, payload, signal) {
    authorize(origin, path, payload)
    return this._serialize(async () => {
      await this._gate()
      let attempt = 0
      for (;;) {
        let response
        try {
          response = await this._post(origin, path, payload, signal)
        } catch (error) {
          if (error instanceof RequestFailure) throw error
          if (isCallerAbort(signal)) throw error
          if (isTimeout(error)) {
            if (attempt === 0) {
              attempt = 1
              await sleep(this._config.retryDelayMs)
              continue
            }
            throw this._pauseFailure('timeout', 'The maishou88 request timed out. Try again later.', this._config.pauseNetworkMs)
          }
          if (attempt === 0) {
            attempt = 1
            await sleep(this._config.retryDelayMs)
            continue
          }
          throw this._pauseFailure('network_error', 'The maishou88 request could not be completed. Try again later.', this._config.pauseNetworkMs)
        }
        const { status, headers, bytes } = response
        const { parsed, text } = parseJson(bytes)
        if (status === 200) {
          if (!isSuccessEnvelope(parsed)) {
            throw new RequestFailure('upstream_error', `maishou88 rejected the query: ${describeFailure(parsed, text)}`)
          }
          const data = parsed.data
          return { data: data === undefined || data === null ? (path === SEARCH_PATH ? [] : {}) : data, receivedAt: readAt() }
        }
        if (status === 401 || status === 403) {
          throw this._pauseFailure(
            'access_denied',
            'maishou88 is refusing this process\'s unauthenticated requests. The remote API may require an updated app signature; try again later.',
            this._config.pauseForbiddenMs,
          )
        }
        if (status === 404) throw new RequestFailure('not_found', `maishou88 does not serve ${path}.`)
        if (status === 429) {
          throw this._pauseFailure(
            'rate_limited',
            'The maishou88 query allowance is temporarily exhausted. Try again later.',
            this._retryAfterMs(headers),
          )
        }
        if (status >= 500 && status <= 599) {
          if (attempt === 0) {
            attempt = 1
            await sleep(this._config.retryDelayMs)
            continue
          }
          throw this._pauseFailure(
            'upstream_unavailable',
            'The maishou88 service is temporarily unavailable. Try again later.',
            this._config.pauseNetworkMs,
          )
        }
        throw new RequestFailure('invalid_response', `maishou88 returned an unexpected status ${status}.`)
      }
    })
  }

  /**
   * Perform one POST and read at most `responseLimitBytes` of its body.
   *
   * @param origin - the endpoint origin.
   * @param path - the endpoint path.
   * @param payload - exactly one of `form` or `json`.
   * @param signal - caller cancellation.
   * @returns the status, headers, and body bytes.
   */
  async _post(origin, path, payload, signal) {
    this._pacer.start()
    const headers = { ...CLIENT_HEADERS, accept: JSON_ACCEPT, referer: WEB_REFERER }
    let body
    if (payload.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = payload.form.toString()
    } else {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(payload.json)
    }
    const response = await sendRequest(`${origin}${path}`, { method: 'POST', headers, body }, { config: this._config, signal })
    return readBoundedBody(response, this._config.responseLimitBytes, 'maishou88')
  }

  /**
   * Apply the backoff and minimum-interval pacing. Runs inside the
   * serialization chain, so the state it reads cannot change underneath it.
   *
   * @returns once this process may issue the request.
   */
  async _gate() {
    return this._pacer.gate()
  }

  /**
   * Extend the process-local backoff, never shortening an existing one.
   *
   * @param ms - the pause length in milliseconds.
   */
  _block(ms) {
    this._pacer.block(ms)
  }

  /**
   * Back this process off and build the matching failure.
   *
   * @param code - the closed failure code.
   * @param message - the model-facing explanation.
   * @param ms - the pause length in milliseconds.
   * @returns the failure to throw.
   */
  _pauseFailure(code, message, ms) {
    return this._pacer.pause(code, message, ms)
  }

  /**
   * Read the pause a 429 asks for, from `Retry-After` where present.
   *
   * @param headers - the 429 response's headers.
   * @returns the pause length in milliseconds.
   */
  _retryAfterMs(headers) {
    return retryAfterMs(headers, this._config.pauseDefaultMs)
  }
}

/**
 * Build one search request's urlencoded form.
 *
 * @param keyword - the trimmed search keyword.
 * @param source - the channel number, or `0` for every channel.
 * @param page - the 1-based result page.
 * @returns the form body.
 */
function searchForm(keyword, source, page) {
  return new URLSearchParams({
    isCoupon: '0',
    keyword,
    openid: CLIENT_HEADERS.openid,
    order: 'desc',
    page: String(page),
    pddListId: '',
    sort: '',
    sourceType: String(source),
    user_id: '',
  })
}

/**
 * Project a failed channel request into a coverage entry's `error`.
 *
 * @param failure - the failed channel page.
 * @returns the closed error value.
 */
function failureView(failure) {
  const retryAt = failure.error.retryAt
  return {
    code: failure.error.code,
    message: failure.error.message,
    retry_at: retryAt === null ? null : isoSeconds(Math.floor(retryAt / 1000)),
  }
}

/**
 * Build the item-detail request body shared by the detail and share-link
 * endpoints.
 *
 * @param config - the resolved plugin options.
 * @param goodsId - the item id.
 * @param source - the channel the id belongs to.
 * @returns the request body.
 */
function detailBody(config, goodsId, source) {
  return {
    goodsId,
    sourceType: String(source),
    inviteCode: config.inviteCode,
    supplierCode: '',
    activityId: '',
    isShare: '1',
    token: '',
    keyword: '',
    usageScene: 5,
  }
}

/**
 * Count records per requested channel and report each channel's status. A
 * channel missing from a mixed page is `no_results` for that page, which says
 * only that this data source returned nothing, never that the platform is out
 * of stock.
 *
 * @param records - the raw records from one response.
 * @param requested - the channel numbers the request asked for.
 * @returns one coverage entry per requested channel.
 */
function coverageOf(records, requested) {
  const counts = new Map(requested.map(source => [source, 0]))
  for (const record of records) {
    const source = asSourceType(record.sourceType)
    if (counts.has(source)) counts.set(source, counts.get(source) + 1)
  }
  return requested.map(source => ({
    source,
    channel: CHANNELS.get(source),
    status: counts.get(source) > 0 ? 'ok' : 'no_results',
    records: counts.get(source),
  }))
}

/**
 * Second check of the request whitelist: origin and path are known, and the
 * payload carries exactly one body form.
 *
 * @param origin - the requested origin.
 * @param path - the requested path.
 * @param payload - the requested payload.
 */
function authorize(origin, path, payload) {
  const known = (origin === APP_ORIGIN && (path === SEARCH_PATH || path === DETAIL_PATH))
    || (origin === SHARE_ORIGIN && path === TARGET_PATH)
  if (!known) throw new UsageError('The request is not in the maishou88 endpoint whitelist.')
  const forms = (payload.form === undefined ? 0 : 1) + (payload.json === undefined ? 0 : 1)
  if (forms !== 1) throw new UsageError('The maishou88 request must carry exactly one body form.')
}

// ── tool value schemas ──────────────────────────────────────────────────────

/** A price the remote API may omit. */
const NULLABLE_PRICE = { oneOf: [{ type: 'number' }, { type: 'null' }] }

/** A text field the remote API may omit. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** The affiliate disclosure attached to every success. */
const AFFILIATE_SCHEMA = {
  type: 'object',
  required: ['invite_code_in_links', 'notice'],
  properties: {
    invite_code_in_links: { type: 'boolean' },
    notice: NULLABLE_STRING,
  },
  additionalProperties: false,
}

/** One channel's outcome within a query. */
const COVERAGE_SCHEMA = {
  type: 'object',
  required: ['source', 'channel', 'status', 'records'],
  properties: {
    source: { type: 'integer' },
    channel: { type: 'string' },
    status: { type: 'string' },
    records: { type: 'integer' },
    kept: { type: 'integer' },
    error: {
      type: 'object',
      required: ['code', 'message', 'retry_at'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retry_at: NULLABLE_STRING,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

/** One trimmed product record. */
const ITEM_SCHEMA = {
  type: 'object',
  required: [
    'goods_id', 'source', 'channel', 'platform', 'shop', 'shop_type', 'title', 'title_chars',
    'original_price', 'actual_price', 'coupon_price', 'coupon_text', 'sales', 'seller_rating',
    'image', 'tags',
  ],
  properties: {
    goods_id: NULLABLE_STRING,
    source: { type: 'integer' },
    channel: { type: 'string' },
    platform: NULLABLE_STRING,
    shop: NULLABLE_STRING,
    shop_type: NULLABLE_STRING,
    title: { type: 'string' },
    title_chars: { type: 'integer' },
    original_price: NULLABLE_PRICE,
    actual_price: NULLABLE_PRICE,
    coupon_price: NULLABLE_PRICE,
    coupon_text: NULLABLE_STRING,
    sales: NULLABLE_STRING,
    seller_rating: NULLABLE_STRING,
    image: NULLABLE_STRING,
    tags: { type: 'array', items: { type: 'string' } },
    commission: NULLABLE_PRICE,
  },
  additionalProperties: false,
}

/** The closed failure value every tool returns instead of throwing. */
const ERROR_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'error'],
  properties: {
    ok: { type: 'boolean', const: false },
    source: { type: 'string', const: 'taobao' },
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

/** A keyword search across one or every channel. */
const SEARCH_SUCCESS_SCHEMA = {
  type: 'object',
  required: [
    'ok', 'source', 'query', 'keyword', 'requested_source', 'channels_requested', 'page',
    'available_count', 'returned_count', 'coverage', 'items', 'received_at', 'source_notice', 'affiliate',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'taobao' },
    query: { type: 'string', const: 'search' },
    keyword: { type: 'string' },
    requested_source: { type: 'integer' },
    channels_requested: { type: 'array', items: { type: 'integer' } },
    page: { type: 'integer' },
    available_count: { type: 'integer' },
    returned_count: { type: 'integer' },
    coverage: { type: 'array', items: COVERAGE_SCHEMA },
    items: { type: 'array', items: ITEM_SCHEMA },
    received_at: { type: 'string' },
    source_notice: { type: 'string' },
    affiliate: AFFILIATE_SCHEMA,
  },
  additionalProperties: false,
}

/** One item's detail, with or without its purchase link. */
const DETAIL_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'query', 'queried', 'item', 'id_changed', 'categories', 'links', 'received_at', 'source_notice', 'affiliate'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'taobao' },
    query: { type: 'string', const: 'detail' },
    queried: {
      type: 'object',
      required: ['goods_id', 'source'],
      properties: { goods_id: { type: 'string' }, source: { type: 'integer' } },
      additionalProperties: false,
    },
    item: ITEM_SCHEMA,
    id_changed: { type: 'boolean' },
    categories: {
      type: 'object',
      required: ['level_one'],
      properties: { level_one: NULLABLE_STRING },
      additionalProperties: false,
    },
    links: {
      type: 'object',
      required: ['available', 'app_url', 'h5_url', 'schema_url', 'share_code', 'note'],
      properties: {
        available: { type: 'boolean' },
        app_url: NULLABLE_STRING,
        h5_url: NULLABLE_STRING,
        schema_url: NULLABLE_STRING,
        share_code: NULLABLE_STRING,
        note: NULLABLE_STRING,
      },
      additionalProperties: false,
    },
    received_at: { type: 'string' },
    source_notice: { type: 'string' },
    affiliate: AFFILIATE_SCHEMA,
  },
  additionalProperties: false,
}

/** A cross-channel comparison ranked by actual price. */
const COMPARE_SUCCESS_SCHEMA = {
  type: 'object',
  required: [
    'ok', 'source', 'query', 'keyword', 'pages', 'platforms_requested', 'coverage', 'summary',
    'verdict', 'verdict_note', 'items', 'received_at', 'source_notice', 'affiliate',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'taobao' },
    query: { type: 'string', const: 'compare' },
    keyword: { type: 'string' },
    pages: { type: 'array', items: { type: 'integer' } },
    platforms_requested: { type: 'array', items: { type: 'integer' } },
    coverage: { type: 'array', items: COVERAGE_SCHEMA },
    summary: {
      type: 'object',
      required: [
        'platforms_queried', 'platforms_with_results', 'platforms_no_results', 'platforms_failed',
        'platforms_not_attempted', 'ranked_items', 'unranked_items', 'lowest_observed',
      ],
      properties: {
        platforms_queried: { type: 'integer' },
        platforms_with_results: { type: 'integer' },
        platforms_no_results: { type: 'integer' },
        platforms_failed: { type: 'integer' },
        platforms_not_attempted: { type: 'integer' },
        ranked_items: { type: 'integer' },
        unranked_items: { type: 'integer' },
        lowest_observed: {
          oneOf: [{
            type: 'object',
            required: ['source', 'channel', 'shop', 'actual_price', 'goods_id'],
            properties: {
              source: { type: 'integer' },
              channel: { type: 'string' },
              shop: NULLABLE_STRING,
              actual_price: { type: 'number' },
              goods_id: NULLABLE_STRING,
            },
            additionalProperties: false,
          }, { type: 'null' }],
        },
      },
      additionalProperties: false,
    },
    verdict: { type: 'string', enum: ['all', 'partial', 'none'] },
    verdict_note: { type: 'string' },
    items: { type: 'array', items: ITEM_SCHEMA },
    received_at: { type: 'string' },
    source_notice: { type: 'string' },
    affiliate: AFFILIATE_SCHEMA,
  },
  additionalProperties: false,
}

/** The static channel directory. */
const CHANNELS_SUCCESS_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'query', 'channels', 'aggregator', 'source_notice', 'affiliate'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'taobao' },
    query: { type: 'string', const: 'channels' },
    channels: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'channel'],
        properties: { source: { type: 'integer' }, channel: { type: 'string' } },
        additionalProperties: false,
      },
    },
    aggregator: { type: 'string' },
    source_notice: { type: 'string' },
    affiliate: AFFILIATE_SCHEMA,
  },
  additionalProperties: false,
}

/** Output contract of the search tool. */
const SEARCH_OUTPUT = { oneOf: [SEARCH_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the compare tool. */
const COMPARE_OUTPUT = { oneOf: [COMPARE_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the detail tool. */
const DETAIL_OUTPUT = { oneOf: [DETAIL_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

/** Output contract of the channels tool. */
const CHANNELS_OUTPUT = { oneOf: [CHANNELS_SUCCESS_SCHEMA, ERROR_PAYLOAD_SCHEMA] }

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
 * Read an optional positive-integer argument.
 *
 * @param args - the raw tool arguments.
 * @param name - the argument name, also used in the failure message.
 * @param fallback - the value used when the argument is absent.
 * @param minimum - the smallest accepted value.
 * @param maximum - the largest accepted value.
 * @returns the accepted value.
 */
function readInteger(args, name, fallback, minimum, maximum) {
  const raw = readArg(args, name)
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < minimum || raw > maximum) {
    throw new UsageError(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return raw
}

/**
 * Read the required keyword.
 *
 * @param args - the raw tool arguments.
 * @returns the trimmed keyword.
 */
function readKeyword(args) {
  const raw = readArg(args, 'keyword')
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new UsageError('keyword must be a non-empty string.')
  }
  if (raw.trim().length > 100) throw new UsageError('keyword must be at most 100 characters.')
  return raw.trim()
}

/**
 * Read the optional channel selector of the search tool. `0` and omission both
 * mean every channel.
 *
 * @param args - the raw tool arguments.
 * @returns the channel number.
 */
function readSource(args) {
  const raw = readArg(args, 'source')
  if (raw === undefined) return SOURCE_ALL
  if (typeof raw !== 'number' || !Number.isInteger(raw) || (raw !== SOURCE_ALL && !CHANNELS.has(raw))) {
    throw new UsageError(`source must be one of 0 (all), ${[...CHANNELS.keys()].join(', ')}.`)
  }
  return raw
}

/**
 * Read the channel the item id belongs to.
 *
 * @param args - the raw tool arguments.
 * @returns the channel number.
 */
function readItemSource(args) {
  const raw = readArg(args, 'source')
  if (typeof raw !== 'number' || !Number.isInteger(raw) || !CHANNELS.has(raw)) {
    throw new UsageError(`source must be one of ${[...CHANNELS.keys()].join(', ')} (the record's "source" field); 0 is only valid for search.`)
  }
  return raw
}

/**
 * Read the required item id, preserving it byte for byte. The remote ids mix
 * upper and lower case and run longer than a JS integer, so a non-string value
 * is rejected rather than coerced.
 *
 * @param args - the raw tool arguments.
 * @returns the id as given.
 */
function readGoodsId(args) {
  const raw = readArg(args, 'goods_id')
  if (typeof raw !== 'string' || raw === '') {
    throw new UsageError('goods_id must be the string the search returned, copied unchanged.')
  }
  if (raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new UsageError('goods_id must be the alphanumeric id a search returned, copied unchanged.')
  }
  return raw
}

/**
 * Read the optional per-channel page selection of the compare tool.
 *
 * @param args - the raw tool arguments.
 * @param pages - the largest accepted page number.
 * @returns the 1-based pages to read.
 */
function readPages(args, pages) {
  const raw = readArg(args, 'pages')
  if (raw === undefined) return [1]
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > pages) {
    throw new UsageError(`pages must be an integer from 1 to ${pages}.`)
  }
  return Array.from({ length: raw }, (_, index) => index + 1)
}

/**
 * Read the optional channel list of the compare tool.
 *
 * @param args - the raw tool arguments.
 * @returns the channel numbers, without duplicates, in canonical order.
 */
function readPlatforms(args) {
  const raw = readArg(args, 'platforms')
  if (raw === undefined) return ALL_CHANNELS
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new UsageError('platforms must be a non-empty array of channel numbers.')
  }
  const selected = new Set()
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value) || !CHANNELS.has(value)) {
      throw new UsageError(`platforms entries must be channel numbers among ${ALL_CHANNELS.join(', ')}.`)
    }
    selected.add(value)
  }
  return ALL_CHANNELS.filter(source => selected.has(source))
}

/**
 * Read one optional boolean argument. Accepts the string forms a model
 * sometimes sends for a boolean schema.
 *
 * @param args - the raw tool arguments.
 * @param name - the argument name.
 * @param fallback - the value used when the argument is absent.
 * @returns the flag.
 */
function readBoolean(args, name, fallback) {
  const raw = readArg(args, name)
  if (raw === undefined) return fallback
  if (raw === true || raw === 'true') return true
  if (raw === false || raw === 'false') return false
  throw new UsageError(`${name} must be a boolean.`)
}

// ── tools ───────────────────────────────────────────────────────────────────

/**
 * Render one tool value as the single JSON text block the model reads, with
 * the deployment's overall character budget applied.
 *
 * @param _args - the executed arguments; unused.
 * @param value - the validated tool value.
 * @param maximum - the character budget for the rendered text.
 * @returns the rendered content.
 */
function renderer(maximum) {
  return (_args, value) => {
    const text = JSON.stringify(value)
    if (text.length <= maximum) return [{ type: 'text', text }]
    return [{ type: 'text', text: `${text.slice(0, maximum)}\n…[output truncated at ${maximum} characters; narrow the query with fewer pages, platforms, or a smaller limit]` }]
  }
}

/**
 * Build each tool's pending-call presentation.
 *
 * @param title - the card title.
 * @param kind - the call kind shown in the UI.
 * @param rawInput - the arguments worth showing, when any.
 * @returns the presentation.
 */
function present(title, kind = 'search', rawInput = undefined) {
  return rawInput === undefined
    ? { card: 'generic', title, kind }
    : { card: 'generic', title, kind, rawInput }
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
 * Project the arguments worth showing on a call card. Presentation runs on
 * playback of arbitrary logged arguments, so it never throws.
 *
 * @param args - the raw tool arguments.
 * @param keys - the argument names to show.
 * @returns the projected arguments, or undefined when there is nothing to show.
 */
function presentableArgs(args, ...keys) {
  const shown = {}
  for (const key of keys) {
    const value = readArg(args, key)
    if (typeof value === 'string' || typeof value === 'number') shown[key] = value
  }
  return Object.keys(shown).length === 0 ? undefined : shown
}

/**
 * Build the four tool definitions bound to one client.
 *
 * @param client - the shared process-local client.
 * @param config - the resolved plugin options.
 * @returns the tool definitions, in registration order.
 */
function buildTools(client, config) {
  const render = renderer(config.outputChars)
  const channelsList = ALL_CHANNELS.map(source => `\`${source}\` ${CHANNELS.get(source)}`).join(', ')
  const channelEnum = { type: 'integer', enum: [...CHANNELS.keys()] }
  return [
    {
      name: 'taobao_channels',
      description: 'List the shopping channels this tool can search (source number and name), taken from the maishou88.com aggregator. Call it when you need to explain which channels a comparison covered. Issues no request.',
      parameters: parameters({}),
      output: { schema: CHANNELS_OUTPUT, render },
      isConcurrencySafe: () => true,
      presentCall: () => present('Shopping channels', 'other'),
      execute: () => ({
        ok: true,
        source: 'taobao',
        query: 'channels',
        channels: ALL_CHANNELS.map(source => ({ source, channel: CHANNELS.get(source) })),
        aggregator: 'maishou88.com',
        source_notice: SOURCE_NOTICE,
        affiliate: client.affiliate(),
      }),
    },
    {
      name: 'taobao_search',
      description: `Search products across Chinese shopping platforms and return prices, coupons, shops, and goods ids. Results come from the third-party aggregator maishou88.com, not from the platforms, and each result's purchase links carry the operator's affiliate invite code. Channels: ${channelsList}; omit source or pass 0 to search every channel at once, which fills one page per channel. The response's coverage array reports, per channel, whether it returned records.`,
      parameters: parameters({
        keyword: { type: 'string', description: 'Product search keyword, 1-100 characters, in Chinese for best recall.' },
        source: { type: 'integer', description: `Channel to search: 0 for all, or ${ALL_CHANNELS.join(', ')}. Defaults to 0.` },
        page: { type: 'integer', description: '1-based result page. Defaults to 1.' },
        limit: { type: 'integer', description: `Maximum records to return, from 1 to ${config.searchMaxLimit}. Defaults to ${config.searchDefaultLimit}.` },
      }, ['keyword']),
      output: { schema: SEARCH_OUTPUT, render },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Search products', 'search', presentableArgs(args, 'keyword', 'source', 'page')),
      execute: async (args, exec) => {
        const keyword = readKeyword(args)
        const source = readSource(args)
        const page = readInteger(args, 'page', 1, 1, 100)
        const limit = readInteger(args, 'limit', config.searchDefaultLimit, 1, config.searchMaxLimit)
        return client.search(keyword, source, page, limit, exec?.signal)
      },
    },
    {
      name: 'taobao_compare',
      description: `Compare one product keyword across several channels and get the records ranked by actual price. Unlike taobao_search, this queries each channel separately, so the coverage array states every channel's status and result count, and one failing channel does not hide the others. Channels: ${channelsList}. The verdict field is "all" only when every requested channel returned records; otherwise report the comparison as incomplete and never call the cheapest record the lowest price across all platforms. Prices come from maishou88.com and are indicative.`,
      parameters: parameters({
        keyword: { type: 'string', description: 'Product search keyword, 1-100 characters, in Chinese for best recall.' },
        platforms: {
          type: 'array',
          items: channelEnum,
          description: `Channels to compare, from ${ALL_CHANNELS.join(', ')}. Defaults to every channel.`,
        },
        pages: { type: 'integer', description: `Pages to read per channel, 1 to ${config.compareMaxPagesPerPlatform}. Defaults to 1; the remote API returns roughly 20 records per channel per page.` },
        per_platform: { type: 'integer', description: `Maximum records kept per channel, 1 to ${config.compareMaxPlatformsPerPage}. Defaults to ${config.comparePlatformsPerPage}.` },
      }, ['keyword']),
      output: { schema: COMPARE_OUTPUT, render },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Compare prices', 'search', presentableArgs(args, 'keyword')),
      execute: async (args, exec) => {
        const keyword = readKeyword(args)
        const platforms = readPlatforms(args)
        const pages = readPages(args, config.compareMaxPagesPerPlatform)
        const perPlatform = readInteger(args, 'per_platform', config.comparePlatformsPerPage, 1, config.compareMaxPlatformsPerPage)
        return client.compare(keyword, platforms, pages, perPlatform, true, exec?.signal)
      },
    },
    {
      name: 'taobao_detail',
      description: 'Read one product\'s detail and its purchase link by the goods_id a search returned. The goods_id must be copied unchanged and the record\'s source passed with it, because ids are only unique within a channel. The purchase link and share code are the only valid links for that record and carry the operator\'s affiliate invite code, which you must disclose. If the link cannot be resolved the item data is still returned.',
      parameters: parameters({
        goods_id: { type: 'string', description: 'The goods_id string exactly as taobao_search or taobao_compare returned it.' },
        source: { type: 'integer', description: `The record's source channel: ${ALL_CHANNELS.join(', ')}.` },
        include_links: { type: 'boolean', description: 'Whether to resolve the purchase link and share code. Defaults to true.' },
      }, ['goods_id', 'source']),
      output: { schema: DETAIL_OUTPUT, render },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: args => present('Product detail', 'fetch', presentableArgs(args, 'goods_id', 'source')),
      execute: async (args, exec) => {
        const goodsId = readGoodsId(args)
        const source = readItemSource(args)
        const includeLinks = readBoolean(args, 'include_links', true)
        return client.detail(goodsId, source, includeLinks, exec?.signal)
      },
    },
  ]
}

/**
 * Register the four cross-platform price tools. Each registration is
 * fiber-scoped, so unloading the plugin removes every tool it added.
 *
 * @param ctx - the plugin context, which must expose the tool registry.
 * @param config - the row's `config`, validated here.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const client = new MaishouClient(resolved)
  for (const tool of buildTools(client, resolved)) ctx.tools.register(tool)
}

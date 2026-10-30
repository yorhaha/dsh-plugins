/**
 * Normalization of upstream Bilibili entries into the records the corpus
 * stores.
 *
 * Pure functions only: no I/O, no clock, no configuration. Each mapper takes one
 * parsed upstream entry and returns `sourceId`, `kind`, `ts`, `title`,
 * `content`, `actors`, and `metadata`, or throws a plain `Error` naming the
 * missing identity when the entry carries none. The storage layer adds its own
 * bookkeeping fields and derives `contentKey` from `metadata.content_key`.
 * Metadata keys keep their upstream names, so a record reads the same way in
 * the medium as it does in an upstream response.
 *
 * @module dsh-bilibili/src/mapping
 */

/** Markup removed before entity decoding. */
const TAG_RE = /<[^>]+>/g

/** One character reference: named, decimal, or hexadecimal. */
const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g

/** Named character references this decoder resolves. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

/** Business identifiers denoting one video. */
export const VIDEO_BUSINESS = new Set(['archive', 'video', '2'])

/** Business identifiers denoting one bangumi episode. */
export const EPISODE_BUSINESS = new Set(['pgc', 'episode', 'bangumi'])

/** Business identifiers denoting one live room. */
export const LIVE_BUSINESS = new Set(['live', 'live_room'])

/** Business identifiers denoting one article. */
export const ARTICLE_BUSINESS = new Set(['article', 'article-list'])

/** Scheme of an absolute URL. */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*$/

/** Latest Unix second a calendar date still represents: 9999-12-31T23:59:59Z. */
const MAX_UNIX_SECONDS = 253402300799

/**
 * Report whether a value is a JSON object.
 * @param value - Value to test.
 * @returns whether the value is a non-null, non-array object.
 */
function isDict(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Report whether a value is a JSON object carrying at least one member.
 * @param value - Value to test.
 * @returns whether the value is a non-empty JSON object.
 */
function hasFields(value) {
  return isDict(value) && Object.keys(value).length > 0
}

/**
 * Read a value as a JSON object.
 * @param value - Value to read.
 * @returns the value itself when it is a JSON object, otherwise an empty object.
 */
export function asDict(value) {
  return isDict(value) ? value : {}
}

/**
 * Read a value as a JSON array.
 * @param value - Value to read.
 * @returns the value itself when it is an array, otherwise an empty array.
 */
export function asList(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Render an upstream scalar as identity text.
 *
 * Booleans, non-integral numbers, and every non-scalar render empty, so a
 * placeholder such as `undefined` never becomes a usable identity.
 *
 * @param value - Value to render.
 * @returns the trimmed text, or an empty string when the value carries none.
 */
export function opaque(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : ''
  if (typeof value === 'string') return value.trim()
  return ''
}

/**
 * Render an upstream scalar as a usable remote identity.
 * @param value - Value to render.
 * @returns the identity text, or an empty string for a missing or `0` identity.
 */
export function remoteId(value) {
  const result = opaque(value)
  return result === '' || result === '0' ? '' : result
}

/**
 * Return the first usable identity among the candidates.
 * @param values - Candidate identity values, in order of preference.
 * @returns the first non-empty identity, or an empty string when there is none.
 */
export function firstRemoteId(...values) {
  for (const value of values) {
    const result = remoteId(value)
    if (result !== '') return result
  }
  return ''
}

/**
 * Read a value as a whole number.
 * @param value - Value to read; a numeric string is accepted.
 * @param defaultValue - Value returned when nothing numeric can be read.
 * @returns the truncated number, or `defaultValue`.
 */
export function integer(value, defaultValue = null) {
  if (typeof value === 'boolean' || value === null || value === undefined) return defaultValue
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : defaultValue
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^[+-]?\d+$/.test(text)) return defaultValue
    const parsed = Number(text)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : defaultValue
  }
  return defaultValue
}

/**
 * Read an upstream event time.
 * @param value - Unix seconds.
 * @returns the instant as an ISO-8601 UTC string with milliseconds, or `null` when the value is absent, non-positive, or outside the calendar range.
 */
export function timestamp(value) {
  const seconds = integer(value)
  if (seconds === null || seconds <= 0 || seconds > MAX_UNIX_SECONDS) return null
  const instant = new Date(seconds * 1000)
  if (Number.isNaN(instant.getTime())) return null
  return instant.toISOString()
}

/**
 * Resolve one numeric character reference.
 * @param codepoint - Unicode code point.
 * @returns the character, with an out-of-range or surrogate value replaced by U+FFFD.
 */
function decodeCodepoint(codepoint) {
  if (!Number.isInteger(codepoint) || codepoint > 0x10ffff) return '\ufffd'
  if (codepoint === 0 || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return '\ufffd'
  return String.fromCodePoint(codepoint)
}

/**
 * Decode the character references a title or description may carry.
 * @param text - Text whose markup has already been removed.
 * @returns the text with `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, and numeric references decoded; unknown references stay as written.
 */
function decodeEntities(text) {
  return text.replace(ENTITY_RE, (match, decimal, hex, name) => {
    if (decimal !== undefined) return decodeCodepoint(Number(decimal))
    if (hex !== undefined) return decodeCodepoint(Number.parseInt(hex, 16))
    return NAMED_ENTITIES.get(name) ?? match
  })
}

/**
 * Strip markup and decode character references from upstream text.
 *
 * Markup is removed before decoding, so an escaped tag stays literal text.
 * @param value - Value to clean.
 * @returns the cleaned text, or an empty string when the value is not a string.
 */
export function cleanText(value) {
  if (typeof value !== 'string') return ''
  return decodeEntities(value.replace(TAG_RE, '')).trim()
}

/**
 * Split a URL into the components the public-URL rule needs.
 * @param url - URL to split.
 * @returns the lowercased scheme, the authority, and the path, each empty when absent.
 */
function splitUrl(url) {
  let rest = url
  let scheme = ''
  const colon = rest.indexOf(':')
  if (colon > 0 && SCHEME_RE.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase()
    rest = rest.slice(colon + 1)
  }
  let netloc = ''
  if (rest.startsWith('//')) {
    const end = rest.slice(2).search(/[/?#]/)
    const stop = end === -1 ? rest.length : end + 2
    netloc = rest.slice(2, stop)
    rest = rest.slice(stop)
  }
  const cut = firstIndexOf(rest, ['?', '#'])
  return { scheme, netloc, path: cut === -1 ? rest : rest.slice(0, cut) }
}

/**
 * Find the earliest occurrence of any character.
 * @param text - Text to search.
 * @param chars - Characters to look for.
 * @returns the lowest index, or -1 when none occurs.
 */
function firstIndexOf(text, chars) {
  let best = -1
  for (const char of chars) {
    const index = text.indexOf(char)
    if (index !== -1 && (best === -1 || index < best)) best = index
  }
  return best
}

/**
 * Read the host and credentials out of a URL authority.
 * @param netloc - Authority component.
 * @returns the lowercased hostname without port or userinfo, plus the userinfo parts, each `null` when absent.
 */
function authorityParts(netloc) {
  const at = netloc.lastIndexOf('@')
  const userinfo = at === -1 ? '' : netloc.slice(0, at)
  const hostinfo = at === -1 ? netloc : netloc.slice(at + 1)
  let username = null
  let password = null
  if (at !== -1) {
    const colon = userinfo.indexOf(':')
    username = colon === -1 ? userinfo : userinfo.slice(0, colon)
    password = colon === -1 ? null : userinfo.slice(colon + 1)
  }
  let hostname = null
  const open = hostinfo.indexOf('[')
  if (open !== -1) {
    const bracketed = hostinfo.slice(open + 1)
    const close = bracketed.indexOf(']')
    hostname = close === -1 ? bracketed : bracketed.slice(0, close)
  } else {
    const colon = hostinfo.indexOf(':')
    hostname = colon === -1 ? hostinfo : hostinfo.slice(0, colon)
  }
  return { hostname: hostname === '' ? null : hostname.toLowerCase(), username, password }
}

/**
 * Reduce an upstream image or page URL to a public https URL.
 *
 * Scheme-relative URLs take the https scheme; the query and fragment are
 * dropped; anything that is not an http(s) URL, carries no host, or embeds
 * credentials is discarded.
 *
 * @param value - Value to clean.
 * @returns the cleaned URL, or `null` when the value is not a public URL.
 */
export function cleanPublicUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url = value.trim()
  if (url.startsWith('//')) url = `https:${url}`
  const parts = splitUrl(url)
  if (parts.scheme !== 'http' && parts.scheme !== 'https') return null
  const authority = authorityParts(parts.netloc)
  if (authority.hostname === null) return null
  if (authority.username || authority.password) return null
  const path = parts.path === '' || parts.path.startsWith('/') ? parts.path : `/${parts.path}`
  return `https://${parts.netloc}${path}`
}

/**
 * Build the human-readable body of an item from labeled source fields.
 * @param pairs - `[label, value]` pairs, in display order.
 * @returns the non-empty lines joined by newlines, or `null` when every value cleans to empty.
 */
export function content(...pairs) {
  const lines = []
  for (const [label, value] of pairs) {
    const text = cleanText(value)
    if (text !== '') lines.push(`${label}：${text}`)
  }
  return lines.length === 0 ? null : lines.join('\n')
}

/**
 * Reduce a video identity to its corpus-wide content key.
 * @param aid - Video id.
 * @returns the `video:<id>` key, or `null` when the id is missing.
 */
export function videoContentKey(aid) {
  const value = remoteId(aid)
  return value === '' ? null : `video:${value}`
}

/**
 * Reduce one upstream business object to the corpus-wide content key that
 * groups repeated sightings of the same work.
 * @param options - Identity of the work.
 * @param options.business - Upstream business or resource type.
 * @param options.remote - Primary upstream id.
 * @param options.epid - Bangumi episode id, when the business carries one.
 * @returns the content key, or `null` for a business this corpus does not group.
 */
export function contentKey({ business, remote, epid = null }) {
  const oid = remoteId(remote)
  const episodeId = remoteId(epid)
  if (VIDEO_BUSINESS.has(business) && oid !== '') return `video:${oid}`
  if (EPISODE_BUSINESS.has(business) && (episodeId !== '' || oid !== '')) {
    return `episode:${episodeId || oid}`
  }
  if (LIVE_BUSINESS.has(business) && oid !== '') return `live:${oid}`
  if (ARTICLE_BUSINESS.has(business) && oid !== '') return `article:${oid}`
  return null
}

/**
 * Guarantee that metadata carries a content key.
 * @param metadata - Metadata object to complete; modified in place.
 * @param sourceId - Item identity used when no upstream key exists.
 * @returns the same metadata object.
 */
export function withFallbackContentKey(metadata, sourceId) {
  if (!metadata.content_key) metadata.content_key = `item:${sourceId}`
  return metadata
}

/**
 * Truncate text to a number of Unicode code points.
 * @param text - Text to truncate.
 * @param limit - Maximum code points to keep.
 * @returns the truncated text.
 */
function codePointSlice(text, limit) {
  return [...text].slice(0, limit).join('')
}

/**
 * Map one watch-history entry to an item record.
 * @param entry - One entry of the history cursor payload.
 * @returns the item record.
 * @throws {Error} `history_missing_identity` when the entry carries no business, no id, or no view time.
 */
export function historyToItem(entry) {
  const history = asDict(entry.history)
  const business = opaque(history.business || entry.business)
  const oid = firstRemoteId(history.oid, entry.oid)
  const viewAt = integer('view_at' in entry ? entry.view_at : history.view_at)
  if (business === '' || oid === '' || viewAt === null || viewAt <= 0) {
    throw new Error('history_missing_identity')
  }
  const cid = firstRemoteId(history.cid, entry.cid)
  const epid = firstRemoteId(history.epid, entry.epid)
  const partId = cid || epid || '0'
  const sourceId = `history:${business}:${oid}:${partId}:${viewAt}`
  const owner = asDict(entry.owner)
  const authorName = owner.name || entry.author_name || entry.author
  const authorLabel = cleanText(authorName)
  const authorId = firstRemoteId(owner.mid, entry.author_mid)
  const title = cleanText(entry.title || entry.name)
  const metadata = withFallbackContentKey(
    {
      business,
      oid,
      bvid: firstRemoteId(history.bvid, entry.bvid) || null,
      cid: cid || null,
      epid: epid || null,
      progress: integer(entry.progress),
      duration: integer(entry.duration),
      part: cleanText(history.part || entry.show_title) || null,
      cover_url: cleanPublicUrl(entry.cover),
      content_key: contentKey({ business, remote: oid, epid }),
    },
    sourceId,
  )
  return {
    sourceId,
    kind: 'watch_history',
    ts: timestamp(viewAt),
    title: title || null,
    content: content(
      ['标题', title],
      ['作者', authorName],
      ['类型', history.business_name || business],
      ['分集', metadata.part],
    ),
    actors:
      authorId || authorLabel
        ? [{ name: authorLabel || null, id: authorId, role: 'uploader' }]
        : [],
    metadata,
  }
}

/**
 * Map one favorite-folder entry to an item record.
 * @param entry - One resource of a favorite-folder payload.
 * @param folder - The folder the resource was read from.
 * @param folder.folderId - Folder id, part of the item identity.
 * @param folder.folderTitle - Folder title, carried into the body and metadata.
 * @returns the item record.
 * @throws {Error} `favorite_missing_identity` when the folder, the resource id, or the resource type is missing.
 */
export function favoriteToItem(entry, { folderId, folderTitle }) {
  const resourceId = firstRemoteId(entry.id, entry.aid)
  const resourceType = opaque(entry.type)
  if (!folderId || resourceId === '' || resourceType === '') {
    throw new Error('favorite_missing_identity')
  }
  const favTime = integer(entry.fav_time)
  let sourceId = `favorite:${folderId}:${resourceType}:${resourceId}`
  if (favTime !== null && favTime > 0) sourceId = `${sourceId}:${favTime}`
  const upper = asDict(entry.upper)
  const upperId = firstRemoteId(upper.mid, upper.id)
  const upperName = upper.name || upper.uname
  const upperLabel = cleanText(upperName)
  const title = cleanText(entry.title)
  const metadata = withFallbackContentKey(
    {
      folder_id: folderId,
      folder_title: folderTitle,
      resource_type: resourceType,
      resource_id: resourceId,
      bvid: remoteId(entry.bvid) || null,
      duration: integer(entry.duration),
      fav_time: favTime,
      cover_url: cleanPublicUrl(entry.cover),
      content_key: contentKey({
        business: resourceType,
        remote: resourceId,
        epid: entry.epid,
      }),
    },
    sourceId,
  )
  return {
    sourceId,
    kind: 'favorite',
    ts: timestamp(favTime),
    title: title || null,
    content: content(
      ['标题', title],
      ['作者', upperName],
      ['收藏夹', folderTitle],
      ['类型', resourceType],
    ),
    actors:
      upperId || upperLabel
        ? [{ name: upperLabel || null, id: upperId, role: 'uploader' }]
        : [],
    metadata,
  }
}

/**
 * Map one following entry to an item record.
 * @param entry - One account of a followings payload.
 * @returns the item record.
 * @throws {Error} `following_missing_identity` when the entry carries no account id.
 */
export function followingToItem(entry) {
  const mid = remoteId(entry.mid)
  if (mid === '') throw new Error('following_missing_identity')
  const mtime = integer(entry.mtime)
  let sourceId = `following:${mid}`
  if (mtime !== null && mtime > 0) sourceId = `${sourceId}:${mtime}`
  const name = cleanText(entry.uname || entry.name)
  const sign = cleanText(entry.sign)
  return {
    sourceId,
    kind: 'following',
    ts: timestamp(mtime),
    title: name || null,
    content: content(['用户', name], ['签名', sign]),
    actors: [{ name: name || null, id: mid, role: 'following' }],
    metadata: {
      mid,
      uname: name || null,
      sign: sign || null,
      mtime,
      // A follow-time change produces a new record, but the same account. The
      // content key is what lets search group those records together.
      content_key: `following:${mid}`,
    },
  }
}

/**
 * Map one watch-later entry to an item record.
 * @param entry - One entry of the watch-later payload.
 * @returns the item record.
 * @throws {Error} `watch_later_missing_identity` when the entry carries no video id.
 */
export function watchLaterToItem(entry) {
  const aid = firstRemoteId(entry.aid, entry.id)
  if (aid === '') throw new Error('watch_later_missing_identity')
  const addAt = integer(entry.add_at)
  let sourceId = `watch_later:${aid}`
  if (addAt !== null && addAt > 0) sourceId = `${sourceId}:${addAt}`
  const owner = asDict(entry.owner)
  const ownerId = firstRemoteId(owner.mid, owner.id)
  const ownerName = owner.name || owner.uname
  const ownerLabel = cleanText(ownerName)
  const title = cleanText(entry.title)
  const metadata = withFallbackContentKey(
    {
      aid,
      bvid: remoteId(entry.bvid) || null,
      cid: remoteId(entry.cid) || null,
      progress: integer(entry.progress),
      duration: integer(entry.duration),
      add_at: addAt,
      cover_url: cleanPublicUrl(entry.pic || entry.cover),
      content_key: videoContentKey(aid),
    },
    sourceId,
  )
  return {
    sourceId,
    kind: 'watch_later',
    ts: timestamp(addAt),
    title: title || null,
    content: content(['标题', title], ['作者', ownerName], ['类型', 'video']),
    actors:
      ownerId || ownerLabel
        ? [{ name: ownerLabel || null, id: ownerId, role: 'uploader' }]
        : [],
    metadata,
  }
}

/**
 * Classify the major content one dynamic attaches.
 * @param dynamicModule - The `module_dynamic` object of a dynamic entry.
 * @returns the attached title, the attached type, and its metadata fields; the type is the upstream major type when nothing is recognized.
 */
function dynamicMajor(dynamicModule) {
  const major = asDict(dynamicModule.major)
  const archive = asDict(major.archive)
  if (hasFields(archive)) {
    const aid = remoteId(archive.aid)
    return {
      title: cleanText(archive.title),
      type: 'archive',
      metadata: {
        aid: aid || null,
        bvid: remoteId(archive.bvid) || null,
        content_key: videoContentKey(aid),
        cover_url: cleanPublicUrl(archive.cover),
      },
    }
  }
  const article = asDict(major.article)
  if (hasFields(article)) {
    const articleId = firstRemoteId(article.id, article.cvid)
    const covers = asList(article.covers)
    return {
      title: cleanText(article.title),
      type: 'article',
      metadata: {
        cvid: articleId || null,
        content_key: contentKey({ business: 'article', remote: articleId }),
        cover_url: covers.length > 0 ? cleanPublicUrl(covers[0]) : null,
      },
    }
  }
  const live = asDict(major.live_rcmd)
  let liveContent = asDict(live.content)
  if (typeof live.content === 'string') {
    try {
      liveContent = asDict(JSON.parse(live.content))
    } catch {
      liveContent = {}
    }
  }
  const liveInfo = asDict(liveContent.live_play_info)
  if (hasFields(liveInfo)) {
    const roomId = remoteId(liveInfo.room_id)
    return {
      title: cleanText(liveInfo.title),
      type: 'live',
      metadata: {
        room_id: roomId || null,
        content_key: contentKey({ business: 'live', remote: roomId }),
        cover_url: cleanPublicUrl(liveInfo.cover),
      },
    }
  }
  return { title: '', type: opaque(major.type), metadata: {} }
}

/**
 * Map one dynamic entry to an item record.
 * @param entry - One entry of a dynamic timeline payload.
 * @param options - Mapping options.
 * @param options.timeline - Timeline the entry was read from, recorded in metadata.
 * @returns the item record.
 * @throws {Error} `dynamic_missing_identity` when the entry carries no dynamic id.
 */
export function dynamicToItem(entry, { timeline = 'self' } = {}) {
  const dynamicId = firstRemoteId(entry.id_str, entry.id)
  if (dynamicId === '') throw new Error('dynamic_missing_identity')
  const modules = asDict(entry.modules)
  const author = asDict(modules.module_author)
  const dynamicModule = asDict(modules.module_dynamic)
  const description = asDict(dynamicModule.desc)
  let text = cleanText(description.text)
  const opus = asDict(dynamicModule.major).opus
  if (text === '' && isDict(opus)) text = cleanText(asDict(opus.summary).text)
  const attached = dynamicMajor(dynamicModule)
  const dynamicType = opaque(entry.type)
  const published = integer(author.pub_ts || entry.timestamp)
  const authorId = remoteId(author.mid)
  const authorName = cleanText(author.name)
  const sourceId = `dynamic:${dynamicId}`
  const metadata = withFallbackContentKey(
    {
      dynamic_id: dynamicId,
      timeline,
      dynamic_type: dynamicType || null,
      attached_type: attached.type || null,
      ...attached.metadata,
    },
    sourceId,
  )
  return {
    sourceId,
    kind: 'dynamic',
    ts: timestamp(published),
    title: attached.title || (text === '' ? null : codePointSlice(text, 80)),
    content: content(['动态', text], ['附带内容', attached.title]),
    actors:
      authorId || authorName
        ? [{ name: authorName || null, id: authorId, role: 'author' }]
        : [],
    metadata,
  }
}

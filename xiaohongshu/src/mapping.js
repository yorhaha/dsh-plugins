/**
 * Response mapping for the Xiaohongshu web API.
 *
 * The upstream payloads are UI-shaped: the same fact may arrive as a number, a
 * localized string such as `1.2万`, or a nested `url_default`/`url_pre` pair,
 * and list endpoints differ in whether they call their rows `items`, `notes`,
 * or `comments`. Every helper here is defensive: a missing field becomes null
 * (or an empty list), never a thrown error, so a field the platform renames
 * costs one column rather than the whole capture.
 *
 * @module dsh-xiaohongshu/src/mapping
 */

/**
 * Trim a value into a non-empty string.
 * @param value - candidate value.
 * @returns the string, or null.
 */
export function textOf(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Read the first string found at one of several paths.
 * @param value - root object.
 * @param paths - arrays of property names.
 * @returns the first non-empty string, or null.
 */
export function stringAt(value, paths) {
  if (typeof value !== 'object' || value === null) return null
  for (const path of paths) {
    let cursor = value
    for (const key of path) {
      if (typeof cursor !== 'object' || cursor === null) {
        cursor = undefined
        break
      }
      cursor = cursor[key]
    }
    const text = textOf(cursor)
    if (text !== null) return text
  }
  return null
}

/**
 * Read the first finite number found at one of several paths.
 * @param value - root object.
 * @param paths - arrays of property names.
 * @returns the number, or null.
 */
export function numberAt(value, paths) {
  if (typeof value !== 'object' || value === null) return null
  for (const path of paths) {
    let cursor = value
    for (const key of path) {
      if (typeof cursor !== 'object' || cursor === null) {
        cursor = undefined
        break
      }
      cursor = cursor[key]
    }
    if (typeof cursor === 'number' && Number.isFinite(cursor)) return Math.trunc(cursor)
    const parsed = countOf(cursor)
    if (parsed !== null) return parsed
  }
  return null
}

/**
 * Parse a Xiaohongshu engagement count.
 *
 * The API sometimes sends `1234` and sometimes `"1.2万"` or `"3亿"`; thousands
 * separators and a trailing `+` are accepted as well.
 *
 * @param value - raw count.
 * @returns the integer approximation, or null.
 */
export function countOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value !== 'string') return null
  const cleaned = value.trim().replace(/[,\s+]/g, '')
  if (cleaned === '') return null
  const match = /^([0-9]+(?:\.[0-9]+)?)(万|亿)?$/.exec(cleaned)
  if (match === null) return null
  const magnitude = match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1
  return Math.round(Number(match[1]) * magnitude)
}

/**
 * Convert a Unix instant in seconds or milliseconds to ISO-8601 text.
 * @param value - raw timestamp.
 * @returns the instant, or null.
 */
export function isoOf(value) {
  const number = typeof value === 'number' ? value : countOf(value)
  if (number === null || number <= 0) return null
  const millis = number > 10_000_000_000 ? number : number * 1000
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Build the canonical public URL for a note.
 * @param noteId - note id.
 * @param xsecToken - per-note access token, when known.
 * @param source - the surface that minted the token.
 * @returns the URL.
 */
export function noteUrl(noteId, xsecToken, source = 'pc_search') {
  const base = `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`
  if (typeof xsecToken !== 'string' || xsecToken === '') return base
  const params = new URLSearchParams({ xsec_token: xsecToken, xsec_source: source })
  return `${base}?${params.toString()}`
}

/**
 * Map one `user` object from a card, note, or comment.
 * @param value - raw user object.
 * @returns a normalized author, or null.
 */
export function authorOf(value) {
  if (typeof value !== 'object' || value === null) return null
  const id = stringAt(value, [['user_id'], ['userid'], ['id']])
  const name = stringAt(value, [['nickname'], ['name'], ['user_name']])
  const avatar = stringAt(value, [['avatar'], ['image'], ['images', '0'], ['imageb']])
  if (id === null && name === null) return null
  return { user_id: id, nickname: name, avatar_url: avatar }
}

/**
 * Normalize an image list.
 * @param value - raw `image_list` or similar array.
 * @returns up to 40 images with their remote URLs and dimensions.
 */
function imagesOf(value) {
  if (!Array.isArray(value)) return []
  const images = []
  const seen = new Set()
  for (const item of value.slice(0, 40)) {
    if (typeof item !== 'object' || item === null) continue
    const url = stringAt(item, [
      ['url_default'],
      ['url_pre'],
      ['url'],
      ['info_list', '0', 'url'],
      ['info_list', '1', 'url'],
    ])
    if (url === null || seen.has(url)) continue
    seen.add(url)
    images.push({
      url,
      width: numberAt(item, [['width']]),
      height: numberAt(item, [['height']]),
    })
  }
  return images
}

/**
 * Normalize one note card from a search result, feed item, or user-post list.
 *
 * @param value - raw `note_card` object, or a row that carries one.
 * @param fallback - note id and token gathered by the caller.
 * @returns a normalized note, or null when it has no id.
 */
export function noteFromCard(value, fallback = {}) {
  if (typeof value !== 'object' || value === null) return null
  const card = typeof value.note_card === 'object' && value.note_card !== null ? value.note_card : value
  const noteId = textOf(fallback.note_id)
    ?? stringAt(value, [['id'], ['note_id']])
    ?? stringAt(card, [['note_id'], ['id']])
  if (noteId === null) return null
  const xsecToken = textOf(fallback.xsec_token) ?? textOf(value.xsec_token) ?? textOf(card.xsec_token)
  const user = authorOf(card.user)
  const interact = card.interact_info ?? card.interactInfo ?? {}
  const title = stringAt(card, [['display_title'], ['title']])
  const body = stringAt(card, [['desc'], ['description'], ['content']])
  const type = stringAt(card, [['type'], ['note_type']]) ?? 'normal'
  const videoUrl = stringAt(card, [
    ['video', 'media', 'stream', 'h264', '0', 'master_url'],
    ['video', 'media', 'stream', 'h265', '0', 'master_url'],
    ['video', 'consumer', 'origin_video_key'],
    ['video', 'url'],
  ])
  return {
    note_id: noteId,
    type,
    title,
    body,
    author: user,
    tags: Array.isArray(card.tag_list)
      ? card.tag_list.map((tag) => textOf(tag?.name ?? tag)).filter((name) => name !== null).slice(0, 30)
      : [],
    images: imagesOf(card.image_list),
    video_url: videoUrl,
    cover_url: stringAt(card, [['cover', 'url_default'], ['cover', 'url_pre'], ['cover', 'url']]),
    published_at: isoOf(
      card.time ?? card.publish_time ?? card.publishTime ?? card.last_update_time ?? card.lastUpdateTime,
    ),
    liked_count: numberAt(interact, [['liked_count'], ['likedCount'], ['like_count']]),
    collected_count: numberAt(interact, [['collected_count'], ['collectedCount'], ['collect_count']]),
    comment_count: numberAt(interact, [['comment_count'], ['commentCount']]),
    share_count: numberAt(interact, [['share_count'], ['shareCount']]),
    ip_location: stringAt(card, [['ip_location'], ['ipLocation']]),
    xsec_token: xsecToken,
    xsec_source: textOf(fallback.xsec_source) ?? 'pc_search',
    url: noteUrl(noteId, xsecToken, textOf(fallback.xsec_source) ?? 'pc_search'),
  }
}

/**
 * Map a search response into note cards.
 * @param body - parsed API body.
 * @returns the normalized notes.
 */
export function searchNotesFrom(body) {
  const data = body?.data ?? body
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.notes) ? data.notes : []
  const notes = []
  for (const item of items) {
    const note = noteFromCard(item, {
      note_id: item?.id ?? item?.note_id,
      xsec_token: item?.xsec_token,
      xsec_source: 'pc_search',
    })
    if (note !== null) notes.push(note)
  }
  return notes
}

/**
 * Map a note-detail response.
 * @param body - parsed API body.
 * @returns the first normalized note, or null.
 */
export function noteDetailFrom(body) {
  const data = body?.data ?? body
  const items = Array.isArray(data?.items) ? data.items : []
  for (const item of items) {
    const note = noteFromCard(item, {
      note_id: item?.id ?? item?.note_id,
      xsec_token: item?.xsec_token,
      xsec_source: 'pc_feed',
    })
    if (note !== null && (note.body !== null || note.title !== null)) return note
  }
  return null
}

/**
 * Map a comment page.
 * @param body - parsed API body.
 * @returns the comments, cursor, and whether more exist.
 */
export function commentsFrom(body) {
  const data = body?.data ?? body
  const rows = Array.isArray(data?.comments) ? data.comments : []
  const comments = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const id = stringAt(row, [['id'], ['comment_id']])
    if (id === null) continue
    const user = authorOf(row.user_info ?? row.user ?? row.author)
    comments.push({
      comment_id: id,
      parent_comment_id: stringAt(row, [['parent_comment_id'], ['parent_id']]),
      author: user,
      content: stringAt(row, [['content'], ['text']]) ?? '',
      like_count: numberAt(row, [['like_count'], ['liked_count']]),
      created_at: isoOf(row.create_time ?? row.created_at ?? row.time),
      sub_comment_count: numberAt(row, [['sub_comment_count'], ['sub_comment_count']]),
    })
  }
  return {
    comments,
    cursor: textOf(data?.cursor) ?? '',
    has_more: data?.has_more === true || data?.hasMore === true,
  }
}

/**
 * Map a user-profile response.
 * @param body - parsed API body.
 * @returns a normalized profile, or null.
 */
export function userFrom(body) {
  const data = body?.data ?? body
  const user = data?.user ?? data?.user_info ?? data?.basic_info ?? data
  if (typeof user !== 'object' || user === null) return null
  const id = stringAt(user, [['user_id'], ['userid'], ['id']])
  if (id === null) return null
  return {
    user_id: id,
    nickname: stringAt(user, [['nickname'], ['name']]),
    red_id: stringAt(user, [['red_id'], ['redId']]),
    description: stringAt(user, [['desc'], ['description'], ['intro']]),
    avatar_url: stringAt(user, [['image'], ['avatar'], ['images', '0'], ['imageb']]),
    gender: numberAt(user, [['gender']]),
    ip_location: stringAt(user, [['ip_location'], ['location']]),
    follower_count: numberAt(user, [['fans'], ['follower_count'], ['fans_count']]),
    following_count: numberAt(user, [['follows'], ['following_count']]),
    note_count: numberAt(user, [['notes'], ['note_count'], ['note_num']]),
    liked_count: numberAt(user, [['liked'], ['liked_count']]),
    url: `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(id)}`,
  }
}

/**
 * Map a user-notes response.
 * @param body - parsed API body.
 * @returns the normalized notes, cursor, and whether more exist.
 */
export function userNotesFrom(body) {
  const data = body?.data ?? body
  const rows = Array.isArray(data?.notes) ? data.notes : Array.isArray(data?.items) ? data.items : []
  const notes = []
  for (const row of rows) {
    const note = noteFromCard(row, {
      note_id: row?.note_id ?? row?.id,
      xsec_token: row?.xsec_token,
      xsec_source: 'pc_user',
    })
    if (note !== null) notes.push(note)
  }
  return {
    notes,
    cursor: textOf(data?.cursor) ?? '',
    has_more: data?.has_more === true || data?.hasMore === true,
  }
}

/**
 * The account block a connection proof returns.
 * @param body - parsed `/api/sns/web/v2/user/me` body.
 * @returns the account fields the credential record keeps.
 */
export function accountFrom(body) {
  const data = body?.data ?? body
  return {
    user_id: textOf(data?.user_id),
    nickname: textOf(data?.nickname),
    avatar_url: stringAt(data, [['imageb'], ['images', '0'], ['image'], ['avatar']]),
    red_id: textOf(data?.red_id),
  }
}

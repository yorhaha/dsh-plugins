/**
 * Projections from Zhihu's wire shapes to the bounded values a model reads.
 *
 * Zhihu is not one API: the HTML state uses camelCase (`voteupCount`), the
 * answer feed uses snake_case (`voteup_count`), and a person appears as
 * `url_token` in one response and `urlToken` in another. Every reader here
 * accepts both spellings, treats a missing number as null rather than zero, and
 * never lets one odd field fail a whole page. Content is converted from HTML to
 * text and cut to the configured length, with the untruncated length reported
 * beside it.
 *
 * @module dsh-zhihu/src/extract
 */

import { characterCount, truncate } from '../../shared/http.js'
import { htmlToText } from './html.js'

/**
 * Read the first present value among several spellings.
 * @param source - the object to read.
 * @param names - candidate keys, in priority order.
 * @returns the value, or undefined when none is present.
 */
function pick(source, ...names) {
  if (typeof source !== 'object' || source === null) return undefined
  for (const name of names) {
    const value = source[name]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * Coerce a remote value to text.
 * @param value - the raw field.
 * @returns the text, or an empty string when absent.
 */
function asText(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Coerce a remote count.
 * @param value - the raw field.
 * @returns the non-negative integer, or null when absent or unusable.
 */
function asCount(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^[0-9]{1,18}$/.test(value)) return Number(value)
  return null
}

/**
 * Coerce a remote epoch-second timestamp.
 * @param value - the raw field.
 * @returns the UTC instant as `YYYY-MM-DDTHH:MM:SSZ`, or null when unusable.
 */
function asIso(value) {
  const seconds = asCount(value)
  if (seconds === null) return null
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Convert one HTML content field and cut it to a bound.
 * @param html - the raw content.
 * @param maximum - the longest text kept, in code points.
 * @returns the text, its full length, and whether it was cut.
 */
export function boundedContent(html, maximum) {
  const text = htmlToText(html)
  const chars = characterCount(text)
  return { text: truncate(text, maximum), chars, truncated: chars > maximum }
}

/**
 * Project the author of a question, answer, article, or comment.
 *
 * Both the HTML state and the API responses nest the author as an object with
 * `url_token` or `urlToken`; a missing author stays null so the reader can tell
 * "written by a deleted account" from "written by someone with no name".
 *
 * @param raw - the raw author object.
 * @returns the author, or null.
 */
export function authorFrom(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const id = asText(pick(raw, 'id'))
  const urlToken = asText(pick(raw, 'url_token', 'urlToken'))
  const name = asText(pick(raw, 'name'))
  if (id === '' && urlToken === '' && name === '') return null
  return {
    name,
    url_token: urlToken,
    headline: asText(pick(raw, 'headline')),
    avatar_url: asText(pick(raw, 'avatar_url', 'avatarUrl')),
  }
}

/**
 * Project one person, as `/api/v4/me` and `/api/v4/members/{token}` return it.
 * @param raw - the raw person object.
 * @returns the person value.
 */
export function personFrom(raw) {
  return {
    id: asText(pick(raw, 'id')),
    url_token: asText(pick(raw, 'url_token', 'urlToken')),
    name: asText(pick(raw, 'name')),
    headline: asText(pick(raw, 'headline')),
    description: asText(pick(raw, 'description')),
    avatar_url: asText(pick(raw, 'avatar_url', 'avatarUrl')),
    gender: asCount(pick(raw, 'gender')),
    answer_count: asCount(pick(raw, 'answer_count', 'answerCount')),
    articles_count: asCount(pick(raw, 'articles_count', 'articlesCount')),
    question_count: asCount(pick(raw, 'question_count', 'questionCount')),
    follower_count: asCount(pick(raw, 'follower_count', 'followerCount')),
    following_count: asCount(pick(raw, 'following_count', 'followingCount')),
    voteup_count: asCount(pick(raw, 'voteup_count', 'voteupCount')),
    thanked_count: asCount(pick(raw, 'thanked_count', 'thankedCount')),
    favorite_count: asCount(pick(raw, 'favorite_count', 'favoriteCount')),
    pins_count: asCount(pick(raw, 'pins_count', 'pinsCount')),
    ip_info: asText(pick(raw, 'ip_info', 'ipInfo')),
    url: asText(pick(raw, 'url')),
  }
}

/**
 * Project the topic names attached to a question.
 * @param topics - the raw topic array.
 * @returns the names, bounded to twelve, with empty names dropped.
 */
function topicNames(topics) {
  if (!Array.isArray(topics)) return []
  return topics
    .map((topic) => asText(pick(topic, 'name', 'title')))
    .filter((name) => name !== '')
    .slice(0, 12)
}

/**
 * Project one question out of a page's embedded state.
 *
 * @param raw - `initialState.entities.questions[id]`.
 * @param id - the numeric question id, as text.
 * @param maximumContent - the longest detail kept, in code points.
 * @returns the question value.
 */
export function questionFromEntity(raw, id, maximumContent) {
  const detail = boundedContent(asText(pick(raw, 'detail')), maximumContent)
  return {
    question_id: id,
    title: asText(pick(raw, 'title')),
    detail: detail.text,
    detail_chars: detail.chars,
    detail_truncated: detail.truncated,
    answer_count: asCount(pick(raw, 'answerCount', 'answer_count')),
    follower_count: asCount(pick(raw, 'followerCount', 'follower_count')),
    comment_count: asCount(pick(raw, 'commentCount', 'comment_count')),
    created_at: asIso(pick(raw, 'created')),
    updated_at: asIso(pick(raw, 'updatedTime', 'updated_time', 'updated')),
    author: authorFrom(pick(raw, 'author')),
    topic_names: topicNames(pick(raw, 'topics')),
    url: `https://www.zhihu.com/question/${id}`,
  }
}

/**
 * Project the question reference nested in an answer.
 * @param raw - the raw question object, or undefined.
 * @returns the id and title, empty when the answer carries no question.
 */
export function questionRefFrom(raw) {
  return {
    question_id: asText(pick(raw, 'id')),
    title: asText(pick(raw, 'title')),
  }
}

/**
 * Project one answer as an API list or the question feed returns it.
 *
 * @param raw - the raw answer object.
 * @param bounds - content and excerpt limits, in code points.
 * @returns the answer value.
 */
export function answerFrom(raw, bounds) {
  const content = boundedContent(asText(pick(raw, 'content')), bounds.contentChars)
  const excerpt = boundedContent(asText(pick(raw, 'excerpt')), bounds.excerptChars)
  const question = questionRefFrom(pick(raw, 'question'))
  const id = asText(pick(raw, 'id'))
  return {
    answer_id: id,
    question_id: question.question_id,
    question_title: question.title,
    author: authorFrom(pick(raw, 'author')),
    content: content.text,
    content_chars: content.chars,
    content_truncated: content.truncated,
    excerpt: excerpt.text,
    excerpt_chars: excerpt.chars,
    excerpt_truncated: excerpt.truncated,
    voteup_count: asCount(pick(raw, 'voteup_count', 'voteupCount')),
    comment_count: asCount(pick(raw, 'comment_count', 'commentCount')),
    thanks_count: asCount(pick(raw, 'thanks_count', 'thanksCount')),
    created_at: asIso(pick(raw, 'created_time', 'createdTime')),
    updated_at: asIso(pick(raw, 'updated_time', 'updatedTime')),
    url: id === '' ? '' : `https://www.zhihu.com/answer/${id}`,
  }
}

/**
 * Project the compact form a question page shows for its first answers.
 *
 * @param raw - the raw answer entity.
 * @param bounds - excerpt limits, in code points.
 * @returns the preview value.
 */
export function answerPreviewFrom(raw, bounds) {
  const excerpt = boundedContent(asText(pick(raw, 'excerpt')), bounds.excerptChars)
  const id = asText(pick(raw, 'id'))
  return {
    answer_id: id,
    author: authorFrom(pick(raw, 'author')),
    excerpt: excerpt.text,
    excerpt_chars: excerpt.chars,
    excerpt_truncated: excerpt.truncated,
    voteup_count: asCount(pick(raw, 'voteup_count', 'voteupCount')),
    comment_count: asCount(pick(raw, 'comment_count', 'commentCount')),
    created_at: asIso(pick(raw, 'created_time', 'createdTime')),
  }
}

/**
 * Project one article out of a zhuanlan page's embedded state.
 *
 * @param raw - `initialState.entities.articles[id]`.
 * @param id - the numeric article id, as text.
 * @param users - the page's people map, used when the article nests no author.
 * @param bounds - content and excerpt limits, in code points.
 * @returns the article value.
 */
export function articleFromEntity(raw, id, users, bounds) {
  const content = boundedContent(asText(pick(raw, 'content')), bounds.contentChars)
  const excerpt = boundedContent(asText(pick(raw, 'excerpt')), bounds.excerptChars)
  const authorId = asText(pick(pick(raw, 'author'), 'id'))
  const nested = authorFrom(pick(raw, 'author'))
  // An article's nested author may carry only an id; the page's people map is
  // where the name and slug are. A nested author with a name wins, because it is
  // the one the article was rendered with.
  const author =
    nested !== null && (nested.name !== '' || nested.url_token !== '')
      ? nested
      : (authorFrom(users?.[authorId]) ?? nested)
  return {
    article_id: id,
    title: asText(pick(raw, 'title')),
    content: content.text,
    content_chars: content.chars,
    content_truncated: content.truncated,
    excerpt: excerpt.text,
    excerpt_chars: excerpt.chars,
    excerpt_truncated: excerpt.truncated,
    voteup_count: asCount(pick(raw, 'voteupCount', 'voteup_count')),
    comment_count: asCount(pick(raw, 'commentCount', 'comment_count')),
    created_at: asIso(pick(raw, 'created')),
    updated_at: asIso(pick(raw, 'updated', 'updatedTime')),
    author,
    url: `https://zhuanlan.zhihu.com/p/${id}`,
  }
}

/**
 * Project one article as the member-articles list returns it.
 *
 * @param raw - the raw article object.
 * @param bounds - excerpt limits, in code points.
 * @returns the article summary value.
 */
export function articleSummaryFrom(raw, bounds) {
  const excerpt = boundedContent(asText(pick(raw, 'excerpt')), bounds.excerptChars)
  const id = asText(pick(raw, 'id'))
  return {
    article_id: id,
    title: asText(pick(raw, 'title')),
    excerpt: excerpt.text,
    excerpt_chars: excerpt.chars,
    excerpt_truncated: excerpt.truncated,
    voteup_count: asCount(pick(raw, 'voteup_count', 'voteupCount')),
    comment_count: asCount(pick(raw, 'comment_count', 'commentCount')),
    created_at: asIso(pick(raw, 'created', 'created_time')),
    updated_at: asIso(pick(raw, 'updated', 'updated_time')),
    author: authorFrom(pick(raw, 'author')),
    url: id === '' ? '' : `https://zhuanlan.zhihu.com/p/${id}`,
  }
}

/**
 * Project one row of the hot list.
 *
 * The hot-list feed reports a question's heat in `detail_text` and its metadata
 * under `target`; an item without a question target is skipped by the caller.
 *
 * @param raw - one `data[]` entry.
 * @param rank - the 1-based position this entry is being given.
 * @returns the hot item value.
 */
export function hotItemFrom(raw, rank) {
  const target = pick(raw, 'target') ?? {}
  const id = asText(pick(target, 'id'))
  const excerpt = boundedContent(asText(pick(target, 'excerpt')), 200)
  return {
    rank,
    question_id: id,
    title: asText(pick(target, 'title')),
    excerpt: excerpt.text,
    detail_text: asText(pick(raw, 'detail_text', 'detailText')),
    answer_count: asCount(pick(target, 'answer_count', 'answerCount')),
    follower_count: asCount(pick(target, 'follower_count', 'followerCount')),
    created_at: asIso(pick(target, 'created')),
    url: id === '' ? '' : `https://www.zhihu.com/question/${id}`,
  }
}

/**
 * Project one comment.
 *
 * The comment API nests its author as `{ role, member }`; an older payload
 * nests it directly, so both are accepted.
 *
 * @param raw - the raw comment object.
 * @param maximum - the longest comment text kept, in code points.
 * @returns the comment value.
 */
export function commentFrom(raw, maximum) {
  const content = boundedContent(asText(pick(raw, 'content')), maximum)
  const nested = pick(raw, 'author')
  const author = authorFrom(pick(nested, 'member')) ?? authorFrom(nested)
  return {
    comment_id: asText(pick(raw, 'id')),
    author,
    content: content.text,
    content_chars: content.chars,
    content_truncated: content.truncated,
    vote_count: asCount(pick(raw, 'vote_count', 'voteCount')),
    child_comment_count: asCount(pick(raw, 'child_comment_count', 'childCommentCount')),
    created_at: asIso(pick(raw, 'created_time', 'createdTime')),
  }
}

/**
 * Read the page's people map as a plain object keyed by id.
 * @param state - the parsed `initialState`.
 * @returns the map, empty when the page carries none.
 */
export function peopleMap(state) {
  const users = pick(pick(state, 'entities'), 'users')
  return typeof users === 'object' && users !== null ? users : {}
}

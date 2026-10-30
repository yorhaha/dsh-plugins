/**
 * Bounded per-dataset paging for the local Bilibili corpus.
 *
 * Each fetcher reads only its whitelisted upstream paths, maps what it reads
 * into item records, and returns those records with the cursor state the next
 * run resumes from. Page size, per-run page limits, overlap detection, and the
 * stalled-cursor guards all live here; persisting the returned state and
 * committing the records belong to the sync caller.
 *
 * @module dsh-bilibili/src/fetch
 */

import {
  BilibiliError,
  FAVORITE_CONTENT_PATH,
  FAVORITE_FOLDERS_PATH,
  FOLLOWINGS_PATH,
  HISTORY_PATH,
  SELF_DYNAMIC_PATH,
  WATCH_LATER_PATH,
} from './client.js'
import {
  asDict,
  asList,
  cleanText,
  dynamicToItem,
  favoriteToItem,
  firstRemoteId,
  followingToItem,
  historyToItem,
  integer,
  opaque,
  remoteId,
  watchLaterToItem,
} from './mapping.js'

// ── paging constants (fixed: they describe upstream limits, not tunables) ──

/** History page size requested from upstream. */
const HISTORY_PAGE_SIZE = 20

/** Recent-pass pages a single history run may read. */
const HISTORY_RECENT_PAGE_LIMIT = 5

/** Backfill pages a scheduled history run may read. */
const HISTORY_BACKFILL_PAGE_LIMIT = 2

/** Backfill pages a run explicitly asked for a backfill may read. */
const HISTORY_MANUAL_BACKFILL_PAGE_LIMIT = 20

/** Caps the source ids remembered for history and dynamic overlap detection. */
const RECENT_KEY_LIMIT = 50

/** Favorite content page size requested from upstream. */
const FAVORITE_PAGE_SIZE = 20

/** Favorite content pages a single run may read across every folder. */
const FAVORITE_PAGE_LIMIT = 10

/** Following page size requested from upstream. */
const FOLLOWING_PAGE_SIZE = 50

/** Following pages a single run may read. */
const FOLLOWING_PAGE_LIMIT = 10

/** Dynamic timeline pages a single run may read. */
const DYNAMIC_PAGE_LIMIT = 5

/**
 * The read-only client surface these fetchers use.
 *
 * @typedef {object} BilibiliApi
 * @property {(path: string, params?: Record<string, unknown>, options?: { signed?: boolean }) => Promise<{ data: unknown }>} get
 *   Issues one whitelisted GET; `options.signed` requests WBI signing.
 * @property {() => Promise<void>} pause Waits out the interval between two pages.
 */

/**
 * One dataset's capture: the records to ingest and the state to persist.
 *
 * @typedef {object} DatasetBatch
 * @property {string} name Dataset identifier: `history`, `watch_later`, `favorites`, `following`, or `self_dynamic`.
 * @property {Array<Record<string, unknown>>} records Mapped item records, deduped by `sourceId`, last one wins.
 * @property {Record<string, unknown>} nextState Resumption state for this dataset's next run.
 * @property {boolean} snapshotComplete Whether this run captured the dataset in full rather than a bounded slice.
 * @property {number|null} currentItemCount Items in a completed snapshot; null while the snapshot is incomplete.
 * @property {string[]} warnings Warning codes for the entries this run skipped.
 */

/**
 * Compares two cursor values structurally.
 *
 * A cursor read back from persisted state is never the same object as the one
 * a page returned, so the stalled-cursor guards compare JSON data rather than
 * object identity.
 *
 * @param {unknown} left First value.
 * @param {unknown} right Second value.
 * @returns {boolean} Whether both values hold equal JSON data.
 */
function sameValue(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
    )
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

/**
 * Parses an integer an upstream payload may omit, malform, or send as text.
 *
 * @param {unknown} value Candidate value.
 * @returns {number|null} Parsed integer, or null when upstream carries none.
 */
function optionalInteger(value) {
  const parsed = integer(value, null)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Reads a persisted cursor, treating an empty one as absent.
 *
 * @param {unknown} value Candidate stored cursor.
 * @returns {Record<string, unknown>|null} The cursor, or null when none was stored.
 */
function storedCursor(value) {
  const cursor = asDict(value)
  return Object.keys(cursor).length > 0 ? cursor : null
}

/**
 * Collapses records that share a `sourceId`, keeping the last one seen.
 *
 * @param {Array<Record<string, unknown>>} records Mapped records in capture order.
 * @returns {Array<Record<string, unknown>>} Deduped records in first-seen order.
 */
export function dedupeRecords(records) {
  const byId = new Map()
  for (const record of records) byId.set(record.sourceId, record)
  return [...byId.values()]
}

/**
 * Maps upstream entries, skipping the ones that carry no usable identity.
 *
 * @param {unknown[]} entries Raw upstream entries.
 * @param {(entry: Record<string, unknown>) => Record<string, unknown>} mapper Per-entry mapper.
 * @returns {[Array<Record<string, unknown>>, string[]]} Mapped records, then one warning code per skipped entry.
 */
function mapEntries(entries, mapper) {
  const records = []
  const warnings = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push('invalid_record')
      continue
    }
    try {
      records.push(mapper(entry))
    } catch {
      // A mapper throws when an entry's upstream identity is absent or malformed; the rest of the page still counts.
      warnings.push('missing_remote_identity')
    }
  }
  return [records, warnings]
}

/**
 * Reads the resume cursor upstream returns with a history page.
 *
 * @param {unknown} value Candidate cursor from the page payload.
 * @returns {{ max: number, view_at: number, business: string }|null} Cursor, or null when upstream carries none.
 */
function historyCursor(value) {
  const cursor = asDict(value)
  const maximum = optionalInteger(cursor.max)
  const viewAt = optionalInteger(cursor.view_at)
  if (!maximum || !viewAt) return null
  return { max: maximum, view_at: viewAt, business: opaque(cursor.business) }
}

/**
 * Builds the history request parameters for one cursor.
 *
 * @param {Record<string, unknown>|null} cursor Cursor to resume from, or null for the newest page.
 * @returns {Record<string, unknown>} Request parameters.
 */
function historyParams(cursor) {
  const params = { type: 'all', ps: HISTORY_PAGE_SIZE }
  if (cursor) {
    params.max = cursor.max
    params.view_at = cursor.view_at
    params.business = cursor.business
  }
  return params
}

/**
 * Captures watch history: a recent pass, then a bounded backfill pass.
 *
 * The recent pass reads at most `HISTORY_RECENT_PAGE_LIMIT` pages and stops at
 * the first entry already present in `recent_keys`; a pass that never stops
 * keeps `catchup_cursor` so the next run resumes it. The backfill pass then
 * walks the stored `backfill_cursor` for `HISTORY_BACKFILL_PAGE_LIMIT` pages,
 * or `HISTORY_MANUAL_BACKFILL_PAGE_LIMIT` pages when `backfill` is set.
 *
 * @param {BilibiliApi} api Client the pages are read through.
 * @param {Record<string, unknown>} datasetState State persisted by the previous run.
 * @param {{ backfill: boolean }} options Whether this run takes the deeper backfill pass.
 * @returns {Promise<DatasetBatch>} Captured records and the state to persist.
 */
export async function fetchHistory(api, datasetState, { backfill }) {
  const state = { ...datasetState }
  const records = []
  const warnings = []
  let pagesFetched = 0
  const recentKeys = new Set(asList(state.recent_keys).map((value) => String(value)))
  const catchup = storedCursor(state.catchup_cursor)
  let headKeys = asList(state.catchup_head_keys).map((value) => String(value))
  const firstSync = recentKeys.size === 0 && catchup === null
  let cursor = catchup
  let recentDone = false
  let recentLastCursor = cursor

  for (let pageIndex = 0; pageIndex < HISTORY_RECENT_PAGE_LIMIT; pageIndex += 1) {
    if (pageIndex) await api.pause()
    const result = await api.get(HISTORY_PATH, historyParams(cursor))
    pagesFetched += 1
    const payload = asDict(result.data)
    const entries = asList(payload.list)
    const [pageRecords, pageWarnings] = mapEntries(entries, historyToItem)
    warnings.push(...pageWarnings)
    if (headKeys.length === 0 && pageIndex === 0) {
      headKeys = pageRecords.map((record) => record.sourceId).slice(0, RECENT_KEY_LIMIT)
    }

    let overlap = false
    for (const record of pageRecords) {
      if (recentKeys.has(record.sourceId)) {
        overlap = true
        break
      }
      records.push(record)
    }
    const nextCursor = historyCursor(payload.cursor)
    recentLastCursor = nextCursor

    if (firstSync) {
      recentDone = true
      state.recent_keys = headKeys
      delete state.catchup_cursor
      delete state.catchup_head_keys
      if (!state.backfill_complete && !Object.hasOwn(state, 'backfill_cursor')) {
        if (nextCursor) state.backfill_cursor = nextCursor
        else state.backfill_complete = true
      }
      break
    }
    if (overlap || entries.length === 0 || nextCursor === null) {
      recentDone = true
      state.recent_keys = headKeys.length > 0 ? headKeys : [...recentKeys].slice(0, RECENT_KEY_LIMIT)
      delete state.catchup_cursor
      delete state.catchup_head_keys
      if (!state.backfill_complete && !Object.hasOwn(state, 'backfill_cursor')) {
        if (nextCursor) state.backfill_cursor = nextCursor
        else state.backfill_complete = true
      }
      break
    }
    if (sameValue(nextCursor, cursor)) throw new BilibiliError('history_cursor_stalled')
    cursor = nextCursor
  }
  if (!recentDone) {
    state.catchup_cursor = recentLastCursor
    state.catchup_head_keys = headKeys
  }

  const backfillCursor = storedCursor(state.backfill_cursor)
  let backfillComplete = Boolean(state.backfill_complete)
  const backfillLimit = backfill ? HISTORY_MANUAL_BACKFILL_PAGE_LIMIT : HISTORY_BACKFILL_PAGE_LIMIT
  if (!backfillComplete && backfillCursor) {
    cursor = backfillCursor
    for (let pageIndex = 0; pageIndex < backfillLimit; pageIndex += 1) {
      if (pagesFetched > 0) await api.pause()
      const result = await api.get(HISTORY_PATH, historyParams(cursor))
      pagesFetched += 1
      const payload = asDict(result.data)
      const entries = asList(payload.list)
      const [pageRecords, pageWarnings] = mapEntries(entries, historyToItem)
      records.push(...pageRecords)
      warnings.push(...pageWarnings)
      const nextCursor = historyCursor(payload.cursor)
      if (entries.length === 0 || nextCursor === null) {
        delete state.backfill_cursor
        state.backfill_complete = true
        backfillComplete = true
        break
      }
      if (sameValue(nextCursor, cursor)) throw new BilibiliError('history_backfill_cursor_stalled')
      cursor = nextCursor
      state.backfill_cursor = cursor
      if (pageIndex + 1 >= backfillLimit) break
    }
  } else if (!backfillComplete && !backfillCursor) {
    state.backfill_complete = true
    backfillComplete = true
  }

  return {
    name: 'history',
    records: dedupeRecords(records),
    nextState: state,
    snapshotComplete: Boolean(state.backfill_complete) && !state.catchup_cursor,
    currentItemCount: null,
    warnings,
  }
}

/**
 * Captures the watch-later list, which upstream returns in a single response.
 *
 * @param {BilibiliApi} api Client the list is read through.
 * @param {Record<string, unknown>} datasetState State persisted by the previous run.
 * @returns {Promise<DatasetBatch>} Captured records and the state to persist.
 */
export async function fetchWatchLater(api, datasetState) {
  const result = await api.get(WATCH_LATER_PATH)
  const payload = asDict(result.data)
  const [records, warnings] = mapEntries(asList(payload.list), watchLaterToItem)
  const state = { ...datasetState }
  delete state.continuation_cursor
  delete state.pending_item_count
  return {
    name: 'watch_later',
    records,
    nextState: state,
    snapshotComplete: true,
    currentItemCount: records.length,
    warnings,
  }
}

/**
 * Reads the favorite folders of one account, ordered by ascending numeric id.
 *
 * @param {unknown} payload Folder-list payload.
 * @returns {Array<Record<string, unknown>>} Folder entries.
 */
function favoriteFolders(payload) {
  const folders = asList(asDict(payload).list).filter(
    (entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  )
  return folders.sort((left, right) => {
    const leftId = optionalInteger(left.id) || 0
    const rightId = optionalInteger(right.id) || 0
    if (leftId !== rightId) return leftId - rightId
    const leftSortKey = opaque(left.id)
    const rightSortKey = opaque(right.id)
    if (leftSortKey === rightSortKey) return 0
    return leftSortKey < rightSortKey ? -1 : 1
  })
}

/**
 * Captures every favorite folder, resuming from the stored continuation.
 *
 * Folders are walked in ascending id order and their content pages are read
 * until `FAVORITE_PAGE_LIMIT` pages have been read by this run, a folder ends,
 * or the folders run out. Stopping early persists `continuation_cursor` with
 * the item count accumulated so far, so the next run resumes mid-folder.
 *
 * @param {BilibiliApi} api Client the folders and their pages are read through.
 * @param {Record<string, unknown>} datasetState State persisted by the previous run.
 * @param {{ userMid: string }} options Account whose folders are captured.
 * @returns {Promise<DatasetBatch>} Captured records and the state to persist.
 */
export async function fetchFavorites(api, datasetState, { userMid }) {
  const state = { ...datasetState }
  const continuation = storedCursor(state.continuation_cursor)
  const startCount = continuation ? optionalInteger(state.pending_item_count) || 0 : 0
  const folderResult = await api.get(FAVORITE_FOLDERS_PATH, {
    up_mid: userMid,
    type: 2,
    web_location: '333.1387',
  })
  const folders = favoriteFolders(folderResult.data)
  const records = []
  const warnings = []
  const startFolder = opaque((continuation ?? {}).folder_id)
  let startPage = optionalInteger((continuation ?? {}).pn) || 1
  let startIndex = 0
  if (startFolder) {
    const found = folders.findIndex((folder) => opaque(folder.id) === startFolder)
    if (found === -1) startPage = 1
    else startIndex = found
  }

  let pages = 0
  let nextContinuation = null
  for (let folderIndex = startIndex; folderIndex < folders.length; folderIndex += 1) {
    const folder = folders[folderIndex]
    const folderId = remoteId(folder.id)
    if (!folderId) {
      warnings.push('missing_remote_identity')
      continue
    }
    const folderTitle = cleanText(folder.title)
    let page = folderId === startFolder ? startPage : 1
    while (true) {
      await api.pause()
      const result = await api.get(FAVORITE_CONTENT_PATH, {
        media_id: folderId,
        pn: page,
        ps: FAVORITE_PAGE_SIZE,
        order: 'mtime',
        tid: 0,
        type: 0,
        platform: 'web',
        web_location: '333.1387',
      })
      const payload = asDict(result.data)
      const mapper = (entry) => favoriteToItem(entry, { folderId, folderTitle })
      const [pageRecords, pageWarnings] = mapEntries(asList(payload.medias), mapper)
      records.push(...pageRecords)
      warnings.push(...pageWarnings)
      pages += 1
      const hasMore = Boolean(payload.has_more)
      if (pages >= FAVORITE_PAGE_LIMIT) {
        if (hasMore) nextContinuation = { folder_id: folderId, pn: page + 1 }
        else if (folderIndex + 1 < folders.length) {
          nextContinuation = { folder_id: opaque(folders[folderIndex + 1].id), pn: 1 }
        }
        break
      }
      if (!hasMore) break
      page += 1
    }
    if (nextContinuation) break
    startPage = 1
  }

  const complete = nextContinuation === null
  const totalCount = startCount + records.length
  if (complete) {
    delete state.continuation_cursor
    delete state.pending_item_count
  } else {
    state.continuation_cursor = nextContinuation
    state.pending_item_count = totalCount
  }
  return {
    name: 'favorites',
    records: dedupeRecords(records),
    nextState: state,
    snapshotComplete: complete,
    currentItemCount: complete ? totalCount : null,
    warnings,
  }
}

/**
 * Captures the accounts one user follows, resuming from the stored page.
 *
 * The page loop stops as soon as upstream reports no further entries for the
 * page it just returned, or after `FOLLOWING_PAGE_LIMIT` pages, in which case
 * the next page number is persisted as `continuation_cursor`.
 *
 * @param {BilibiliApi} api Client the pages are read through.
 * @param {Record<string, unknown>} datasetState State persisted by the previous run.
 * @param {{ userMid: string }} options Account whose followings are captured.
 * @returns {Promise<DatasetBatch>} Captured records and the state to persist.
 */
export async function fetchFollowing(api, datasetState, { userMid }) {
  const state = { ...datasetState }
  const continuation = storedCursor(state.continuation_cursor)
  let page = optionalInteger((continuation ?? {}).pn) || 1
  const startCount = continuation ? optionalInteger(state.pending_item_count) || 0 : 0
  const records = []
  const warnings = []
  let nextContinuation = null
  for (let pageIndex = 0; pageIndex < FOLLOWING_PAGE_LIMIT; pageIndex += 1) {
    if (pageIndex) await api.pause()
    const result = await api.get(FOLLOWINGS_PATH, {
      vmid: userMid,
      pn: page,
      ps: FOLLOWING_PAGE_SIZE,
      order: 'desc',
      order_type: '',
    })
    const payload = asDict(result.data)
    const entries = asList(payload.list)
    const [pageRecords, pageWarnings] = mapEntries(entries, followingToItem)
    records.push(...pageRecords)
    warnings.push(...pageWarnings)
    const total = optionalInteger(payload.total)
    const hasMore =
      entries.length > 0
      && (total === null ? entries.length >= FOLLOWING_PAGE_SIZE : page * FOLLOWING_PAGE_SIZE < total)
    if (!hasMore) break
    page += 1
    if (pageIndex + 1 >= FOLLOWING_PAGE_LIMIT) {
      nextContinuation = { pn: page }
      break
    }
  }

  const complete = nextContinuation === null
  const totalCount = startCount + records.length
  if (complete) {
    delete state.continuation_cursor
    delete state.pending_item_count
  } else {
    state.continuation_cursor = nextContinuation
    state.pending_item_count = totalCount
  }
  return {
    name: 'following',
    records: dedupeRecords(records),
    nextState: state,
    snapshotComplete: complete,
    currentItemCount: complete ? totalCount : null,
    warnings,
  }
}

/**
 * Reads the dynamic id upstream uses for one timeline entry.
 *
 * @param {unknown} entry Raw upstream entry.
 * @returns {string} Dynamic id, or an empty string when the entry carries none.
 */
function dynamicId(entry) {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    ? firstRemoteId(entry.id_str, entry.id)
    : ''
}

/**
 * Captures the signed-in user's own dynamic timeline.
 *
 * The offset loop stops at the first entry already present in `recent_ids`, at
 * the end of the timeline, or after `DYNAMIC_PAGE_LIMIT` pages, in which case
 * the next offset is persisted as `continuation_cursor` and the ids seen at
 * the head of the timeline are kept for the next run's overlap detection.
 *
 * @param {BilibiliApi} api Client the pages are read through.
 * @param {Record<string, unknown>} datasetState State persisted by the previous run.
 * @param {{ userMid: string }} options Account whose timeline is captured.
 * @returns {Promise<DatasetBatch>} Captured records and the state to persist.
 */
export async function fetchSelfDynamic(api, datasetState, { userMid }) {
  const state = { ...datasetState }
  const continuation = storedCursor(state.continuation_cursor)
  let offset = opaque((continuation ?? {}).offset)
  const knownIds = new Set(asList(state.recent_ids).map((value) => String(value)))
  let headIds = asList(state.continuation_head_ids).map((value) => String(value))
  const records = []
  const warnings = []
  let nextContinuation = null
  let complete = false
  for (let pageIndex = 0; pageIndex < DYNAMIC_PAGE_LIMIT; pageIndex += 1) {
    if (pageIndex) await api.pause()
    const result = await api.get(
      SELF_DYNAMIC_PATH,
      {
        host_mid: userMid,
        offset,
        features:
          'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,'
          + 'forwardListHidden,decorationCard,commentsNewVersion',
        timezone_offset: -480,
        'x-bili-device-req-json': '{"platform":"web","device":"pc"}',
        'x-bili-web-req-json': '{"spm_id":"333.1387"}',
      },
      { signed: true },
    )
    const payload = asDict(result.data)
    const entries = asList(payload.items)
    if (headIds.length === 0 && continuation === null && pageIndex === 0) {
      headIds = entries
        .map((entry) => dynamicId(entry))
        .filter((value) => value !== '')
        .slice(0, RECENT_KEY_LIMIT)
    }
    let overlap = false
    const selected = []
    for (const entry of entries) {
      if (knownIds.has(dynamicId(entry))) {
        overlap = true
        break
      }
      selected.push(entry)
    }
    const [pageRecords, pageWarnings] = mapEntries(selected, (entry) =>
      dynamicToItem(entry, { timeline: 'self' }),
    )
    records.push(...pageRecords)
    warnings.push(...pageWarnings)
    const nextOffset = opaque(payload.offset)
    const hasMore = Boolean(payload.has_more) && Boolean(nextOffset)
    if (overlap || !hasMore || entries.length === 0) {
      complete = true
      break
    }
    if (nextOffset === offset) throw new BilibiliError('dynamic_cursor_stalled')
    offset = nextOffset
    if (pageIndex + 1 >= DYNAMIC_PAGE_LIMIT) {
      nextContinuation = { offset }
      break
    }
  }

  if (complete) {
    state.recent_ids = headIds.length > 0 ? headIds : [...knownIds].slice(0, RECENT_KEY_LIMIT)
    delete state.continuation_cursor
    delete state.continuation_head_ids
    delete state.pending_item_count
  } else {
    state.continuation_cursor = nextContinuation
    state.continuation_head_ids = headIds
    state.pending_item_count = (optionalInteger(state.pending_item_count) || 0) + records.length
  }
  return {
    name: 'self_dynamic',
    records: dedupeRecords(records),
    nextState: state,
    snapshotComplete: complete,
    currentItemCount: null,
    warnings,
  }
}

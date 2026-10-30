/**
 * The durable corpus: opening the domain, committing captured batches, and
 * answering queries from it.
 *
 * Reads are synchronous because an open domain keeps its validated records in
 * memory; a captured batch is therefore deduplicated against the in-memory copy
 * before any write. Every write is durable before it resolves, and the domain's
 * single write chain serializes them, so a caller never needs its own write
 * mutex — only the fetch itself needs one ({@link module:dsh-bilibili/src/sync}).
 *
 * @module dsh-bilibili/src/store
 */

import { createHash } from 'node:crypto'
import { DATASETS, bilibiliDomainSpec } from './spec.js'

/** Milliseconds in one day, the window after which captured data reads as stale. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Record key for one item.
 *
 * The `per-record` layout turns a key into a path segment and accepts only
 * `[a-zA-Z0-9_-]+`, while an upstream identity such as
 * `history:archive:123:0:1700000000` carries colons. Hashing the identity keeps
 * the key path-safe on every platform and collision-free; the identity itself
 * stays readable in the record's `sourceId`.
 *
 * @param sourceId - Upstream identity of the item.
 * @returns the 64-character lowercase hex record key.
 */
export function itemKey(sourceId) {
  return createHash('sha256').update(sourceId, 'utf8').digest('hex')
}

/**
 * Whether a re-capture carries the same payload as the stored record.
 *
 * The four fields a capture can change are compared directly: they are all in
 * the record, so a fingerprint of them would be a second copy of the same fact
 * — and one more field to keep in step. Actors and metadata are compared as
 * serialized text because they are objects and arrays; the mappers build them
 * in a fixed order, so an identical re-capture serializes identically.
 *
 * @param existing - The stored record.
 * @param incoming - The record this capture produced.
 * @returns true when the stored record already says the same thing.
 */
function samePayload(existing, incoming) {
  return existing.title === incoming.title
    && existing.content === incoming.content
    && JSON.stringify(existing.actors) === JSON.stringify(incoming.actors)
    && JSON.stringify(existing.metadata) === JSON.stringify(incoming.metadata)
}

/**
 * Shape one mapper result into a storable record.
 * @param record - A result from `./mapping.js`, carrying `sourceId`, `kind`, `ts`, `title`, `content`, `actors`, and `metadata`.
 * @param dataset - Dataset the record was captured from.
 * @param now - ISO-8601 instant of this capture.
 * @returns the record as stored, without the bookkeeping fields the caller owns.
 */
function toStoredItem(record, dataset, now) {
  const metadata = record.metadata ?? {}
  const contentKey = typeof metadata.content_key === 'string' ? metadata.content_key : null
  return {
    sourceId: record.sourceId,
    dataset,
    kind: record.kind,
    ts: record.ts ?? null,
    title: record.title ?? null,
    content: record.content ?? null,
    actors: record.actors ?? [],
    metadata,
    contentKey,
    firstSeenAt: now,
    lastSeenAt: now,
  }
}

/** An open corpus handle. Construct through {@link openStore}. */
export class BilibiliStore {
  #domain
  #statusWrites = Promise.resolve()

  /**
   * @param domain - The opened domain handle; this instance owns its lifecycle.
   */
  constructor(domain) {
    this.#domain = domain
  }

  /** @returns the item table handle. */
  get #items() {
    return this.#domain.table('items')
  }

  /** @returns the cursor table handle. */
  get #cursors() {
    return this.#domain.table('cursors')
  }

  /** @returns the platform status recorded by the last sync attempt. */
  status() {
    return this.#domain.global.get()
  }

  /**
   * Merge a patch into the platform status.
   *
   * Patches are queued so the read and the write they replace stay one step: a
   * sign-in finishing while a sync reports its outcome must not let either
   * caller overwrite the other with a snapshot taken before its write.
   *
   * @param patch - Fields to replace.
   * @returns resolution after durability.
   */
  async updateStatus(patch) {
    const write = this.#statusWrites.then(async () => {
      await this.#domain.global.set({ ...this.#domain.global.get(), ...patch })
    })
    this.#statusWrites = write.catch(() => {})
    return write
  }

  /**
   * Most recent successful capture across datasets.
   * @returns the ISO-8601 instant, or null when no dataset ever succeeded.
   */
  latestSuccessAt() {
    let latest = null
    for (const dataset of DATASETS) {
      const at = this.#cursors.get(dataset)?.lastSuccessAt
      if (typeof at === 'string' && (latest === null || at > latest)) latest = at
    }
    return latest
  }

  /**
   * Read one dataset's resumption state.
   * @param dataset - Dataset name.
   * @returns the cursor record, or undefined before the dataset's first successful capture.
   */
  cursor(dataset) {
    return this.#cursors.get(dataset)
  }

  /**
   * Commit one captured batch: store every item whose payload changed, then
   * advance the dataset cursor.
   *
   * The two steps are separate durable commits, and a crash between them leaves
   * the cursor behind the items. That direction is safe: the next run re-reads
   * the same pages and every already-stored item deduplicates to a no-op, so no
   * record is lost and none is written twice.
   *
   * @param dataset - Dataset the batch belongs to.
   * @param batch - A batch from `./fetch.js`.
   * @param now - ISO-8601 instant of this commit.
   * @returns counts of newly stored and unchanged records.
   */
  async commitBatch(dataset, batch, now) {
    let added = 0
    let updated = 0
    let unchanged = 0
    for (const record of batch.records) {
      const stored = toStoredItem(record, dataset, now)
      const key = itemKey(stored.sourceId)
      const existing = this.#items.get(key)
      if (existing !== undefined && samePayload(existing, stored)) {
        unchanged += 1
        continue
      }
      await this.#items.put(key, {
        ...stored,
        firstSeenAt: existing?.firstSeenAt ?? now,
      })
      if (existing === undefined) added += 1
      else updated += 1
    }
    const previous = this.cursor(dataset)
    await this.#cursors.put(dataset, {
      state: batch.nextState ?? {},
      lastSuccessAt: now,
      lastErrorCode: null,
      itemCount: batch.records.length,
      snapshotComplete: batch.snapshotComplete ?? null,
    })
    return { added, updated, unchanged, firstCapture: previous === undefined }
  }

  /**
   * Record a failed capture attempt without touching the resumption state, so
   * the next run retries the same pages.
   * @param dataset - Dataset whose capture failed.
   * @param errorCode - Stable failure code.
   * @returns resolution after durability.
   */
  async recordFailure(dataset, errorCode) {
    const previous = this.cursor(dataset)
    await this.#cursors.put(dataset, {
      state: previous?.state ?? {},
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastErrorCode: errorCode,
      itemCount: previous?.itemCount ?? 0,
      snapshotComplete: previous?.snapshotComplete ?? null,
    })
  }

  /**
   * Count stored records, overall and per dataset.
   * @returns the counts and the total.
   */
  stats() {
    const byDataset = Object.fromEntries(DATASETS.map((name) => [name, 0]))
    let total = 0
    for (const [, item] of this.#items.entries()) {
      total += 1
      byDataset[item.dataset] = (byDataset[item.dataset] ?? 0) + 1
    }
    return { total, byDataset }
  }

  /**
   * Search the corpus.
   *
   * Every filter is optional and they combine conjunctively. `query` matches
   * case-insensitively against the title, the content body, the actor names, and
   * the upstream metadata, so a video found by its BV id, its uploader, or a
   * word in its title all work without the caller knowing which field holds it.
   *
   * @param options - Search options.
   * @param options.query - Substring to match, or absent to match everything.
   * @param options.dataset - Restrict to one dataset.
   * @param options.kind - Restrict to one item class.
   * @param options.contentKey - Restrict to records denoting one upstream work.
   * @param options.since - Inclusive lower bound on `ts`, ISO-8601.
   * @param options.until - Exclusive upper bound on `ts`, ISO-8601.
   * @param options.limit - Maximum rows to return.
   * @param options.offset - Rows to skip after ordering.
   * @returns the matched total and the requested window, newest first.
   */
  search(options = {}) {
    const { query, dataset, kind, contentKey, since, until, seenSince, limit = 20, offset = 0 } = options
    const needle = typeof query === 'string' && query.trim() !== '' ? query.trim().toLowerCase() : null
    const matched = []
    for (const [, item] of this.#items.entries()) {
      if (dataset !== undefined && item.dataset !== dataset) continue
      if (kind !== undefined && item.kind !== kind) continue
      if (contentKey !== undefined && item.contentKey !== contentKey) continue
      if (since !== undefined && (item.ts === null || item.ts < since)) continue
      if (until !== undefined && (item.ts === null || item.ts >= until)) continue
      // Upstream event time says when the thing happened; lastSeenAt says when
      // this corpus last confirmed it, which is what "since the last capture"
      // has to ask about.
      if (seenSince !== undefined && item.lastSeenAt < seenSince) continue
      if (needle !== null && !matches(item, needle)) continue
      matched.push(item)
    }
    matched.sort(compareByRecency)
    return {
      total: matched.length,
      rows: matched.slice(offset, offset + limit),
    }
  }

  /**
   * Read one stored record by its upstream identity.
   * @param sourceId - Upstream identity of the item.
   * @returns the stored record, or undefined when it was never captured.
   */
  item(sourceId) {
    return this.#items.get(itemKey(sourceId))
  }

  /**
   * Close the corpus and release its medium.
   * @returns resolution after the domain is released.
   */
  close() {
    return this.#domain.close()
  }
}

/**
 * Test one record against a lowercase needle.
 * @param item - The stored record.
 * @param needle - Lowercase substring.
 * @returns whether any searchable field contains the needle.
 */
function matches(item, needle) {
  if (item.title?.toLowerCase().includes(needle)) return true
  if (item.content?.toLowerCase().includes(needle)) return true
  if (item.sourceId.toLowerCase().includes(needle)) return true
  if (item.contentKey?.toLowerCase().includes(needle)) return true
  if (item.actors.some((actor) => actor.name?.toLowerCase().includes(needle))) return true
  return JSON.stringify(item.metadata).toLowerCase().includes(needle)
}

/**
 * Order records newest first, with records carrying no upstream time last and
 * ties broken by identity so the window is stable across calls.
 * @param left - First record.
 * @param right - Second record.
 * @returns the comparator result.
 */
function compareByRecency(left, right) {
  if (left.ts !== right.ts) {
    if (left.ts === null) return 1
    if (right.ts === null) return -1
    return left.ts < right.ts ? 1 : -1
  }
  return left.sourceId < right.sourceId ? -1 : 1
}

/**
 * Open the corpus domain.
 * @param facility - The mounted storage domain facility.
 * @returns the open corpus handle.
 */
export async function openStore(facility) {
  return new BilibiliStore(await facility.open(bilibiliDomainSpec))
}

/**
 * Domain declaration for the local Bilibili corpus.
 *
 * One domain carries everything durable this plugin owns: the captured item
 * corpus, one cursor record per dataset, and the platform-level sync status.
 * The `per-record` layout keeps each item in its own document, so a sync that
 * writes hundreds of records never rewrites the rest, and one unreadable
 * document is skipped instead of blocking the whole domain at open.
 *
 * @module dsh-bilibili/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** The datasets this plugin captures, in sync order. */
export const DATASETS = Object.freeze([
  'history',
  'watch_later',
  'favorites',
  'following',
  'self_dynamic',
])

/**
 * A value that survives a JSON round trip unchanged. The medium stores records
 * as JSON, so a value admitted here but not representable there would read back
 * as something else at the next open.
 */
const jsonValue = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
)

/** One party attached to an item, such as the uploader of a video. */
const actorSchema = z.object({
  name: z.string().nullable(),
  id: z.string(),
  role: z.string(),
})

/** One captured item: the unit a search returns. */
const itemSchema = z.object({
  /** Stable identity in the upstream source, unique within `dataset`. */
  sourceId: z.string().min(1),
  /** Dataset this item was captured from. */
  dataset: z.enum(DATASETS),
  /** Item class, such as `watch_history` or `favorite`. */
  kind: z.string().min(1),
  /** Upstream event time as ISO-8601 UTC, or null when the source carries none. */
  ts: z.string().nullable(),
  title: z.string().nullable(),
  /** Human-readable lines built from the source fields; the search body. */
  content: z.string().nullable(),
  actors: z.array(actorSchema),
  /** Upstream-specific fields; the search also matches against these. */
  metadata: z.record(z.string(), jsonValue),
  /**
   * Groups records that denote the same upstream work, so repeated views or a
   * re-favorite of one video are recognizable as one thing.
   */
  contentKey: z.string().nullable(),
  /** When this plugin first captured the record. */
  firstSeenAt: z.string(),
  /** When the capture last observed the record. */
  lastSeenAt: z.string(),
})

/** Per-dataset resumption state plus the outcome of its last capture attempt. */
const cursorSchema = z.object({
  /** Fetcher-owned resumption state; opaque to every other reader. */
  state: z.record(z.string(), jsonValue),
  lastSuccessAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  /** Items captured by the last successful run of this dataset. */
  itemCount: z.number().int().nonnegative(),
  /** Whether that run captured a complete snapshot rather than a bounded slice. */
  snapshotComplete: z.boolean().nullable(),
})

/** Platform-level state shared by every dataset. */
const statusSchema = z.object({
  /** Start of the most recent sync attempt, whatever its outcome. */
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(['succeeded', 'failed', 'partial', 'skipped']).nullable(),
  lastErrorCode: z.string().nullable(),
  /** Set when upstream refused the stored session; cleared by a successful sync. */
  authRequired: z.boolean(),
  /** Consecutive risk-control rejections, which widen the retry window. */
  riskConsecutive: z.number().int().nonnegative(),
  /** Wall-clock instant before which the next attempt is pointless. */
  retryNotBefore: z.string().nullable(),
  /** Signed-in account as last observed from upstream. */
  account: z
    .object({
      mid: z.string().min(1),
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      checkedAt: z.string(),
    })
    .nullable(),
})

/** The domain declaration opened by {@link openStore}. */
export const bilibiliDomainSpec = defineDomain({
  name: 'bilibili',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  global: {
    schema: statusSchema,
    initial: {
      lastRunAt: null,
      lastRunStatus: null,
      lastErrorCode: null,
      authRequired: false,
      riskConsecutive: 0,
      retryNotBefore: null,
      account: null,
    },
  },
  tables: {
    items: domainTable(itemSchema),
    cursors: domainTable(cursorSchema),
  },
})

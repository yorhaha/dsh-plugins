/**
 * The durable lists: the securities the user follows and the index row the panel
 * shows above them, every mutation landing as a single atomic document.
 *
 * Both lists are one domain `global` rather than one record per code: a reorder
 * must never be observable as a half-applied medium, and either list is small
 * enough that one durable write per change is the cheapest correct shape. The
 * medium is the mounted storage backend (`$DSH_HOME/storages/stock.json` in the
 * stock profile), so an operator can read or repair the lists by hand.
 *
 * The domain's global slot has no read-modify-write operation, so this module
 * owns a serialization chain: `panel`, agent tool, and any concurrent callers
 * share one store instance, and every mutation reads and writes inside that
 * chain. Without it two overlapping adds would each start from the same list
 * and the later write would drop the other's entry.
 *
 * @module dsh-stock/src/watchlist
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** The two ordered lists one document holds. */
export const SCOPES = ['watchlist', 'index']

/**
 * Document field holding each scope's list. The followed securities keep the
 * `entries` name they were stored under before the index row existed.
 */
const SCOPE_FIELD = { watchlist: 'entries', index: 'indices' }

/** The instant recorded on a mutation, as `YYYY-MM-DDTHH:MM:SSZ`. */
function nowInstant() {
  return `${new Date().toISOString().slice(0, 19)}Z`
}

/**
 * A holding the user marked on one followed security. Both figures are
 * optional: a bare mark records the fact of holding, while `cost` and
 * `quantity` let the panel derive a market value and a profit or loss from the
 * latest quote. Either figure is null when the user did not state it.
 */
const positionSchema = z.object({
  cost: z.number().positive().nullable(),
  quantity: z.number().positive().nullable(),
  markedAt: z.string().min(1),
})

/**
 * One listed security. `code` is the canonical form `parseCode` returns, so two
 * spellings of one security can never both be stored; `name` is the last name
 * upstream reported, kept so the panel and the tool can label an entry while the
 * quote endpoint is unreachable. `position` is absent in documents written
 * before holdings were marked, which reads as an unheld entry.
 */
const entrySchema = z.object({
  code: z.string().min(1),
  name: z.string().nullable(),
  addedAt: z.string().min(1),
  position: positionSchema.nullable().optional(),
})

/**
 * The complete document. `updatedAt` is null only before the first mutation, so
 * it cannot collide with the medium's "never written" sentinel, and `indices` is
 * absent until the index row is first seeded or edited, which is what tells a
 * document no one has chosen indices for from a row the user emptied.
 */
const watchlistSchema = z.object({
  entries: z.array(entrySchema),
  indices: z.array(entrySchema).optional(),
  updatedAt: z.string().nullable(),
})

/**
 * The domain this plugin owns. `single` layout keeps both lists in one readable
 * document; the absent tables are deliberate — nothing but the lists is stored.
 * A document that fails {@link watchlistSchema} rejects the open, which fails the
 * plugin load loudly rather than starting with silently empty lists.
 */
export const stockDomainSpec = defineDomain({
  name: 'stock',
  version: 1,
  layout: 'single',
  global: {
    schema: watchlistSchema,
    initial: { entries: [], updatedAt: null },
  },
  tables: {},
})

/**
 * Copy one stored position, dropping the stored object identity.
 *
 * @param position - the stored position, absent or null when unmarked.
 * @returns an independent copy, or null.
 */
function copyPosition(position) {
  if (position === undefined || position === null) return null
  return { cost: position.cost, quantity: position.quantity, markedAt: position.markedAt }
}

/**
 * Copy one stored entry. `global.get()` hands back the stored object itself, so
 * a caller that mutated a returned entry would change the document without a write.
 *
 * @param entry - the stored entry.
 * @returns an independent copy.
 */
function copyEntry(entry) {
  return { code: entry.code, name: entry.name, addedAt: entry.addedAt, position: copyPosition(entry.position) }
}

/** The lists this plugin owns and every surface mutates through. */
export class WatchlistStore {
  #domain

  #limits

  #indexDefaults

  #chain = Promise.resolve()

  #closing = false

  #closeTask = null

  /**
   * @param domain - the opened domain handle; this store owns its lifecycle.
   * @param options - the configured bounds and the index row's default codes.
   * @param options.maxEntries - the largest accepted number of entries per scope.
   * @param options.indexDefaults - the canonical codes a never-chosen index row starts with.
   */
  constructor(domain, { maxEntries, indexDefaults }) {
    this.#domain = domain
    this.#limits = maxEntries
    this.#indexDefaults = indexDefaults
  }

  /**
   * Run one mutation after every previously queued mutation settled. Queueing,
   * rather than rejecting, keeps one failed operation from cancelling the
   * others; the chain never observes a rejection.
   *
   * @param task - the mutation.
   * @returns the mutation's outcome.
   */
  #serialize(task) {
    if (this.#closing) {
      return Promise.reject(Object.assign(new Error('stock: the watchlist is closing'), { code: 'closed' }))
    }
    const result = this.#chain.then(task, task)
    this.#chain = result.then(() => undefined, () => undefined)
    return result
  }

  /** @returns the stored document as this store treats it. */
  get #state() {
    return this.#domain.global.get()
  }

  /**
   * Resolve one scope's document field.
   *
   * @param scope - the list to address.
   * @returns the field name holding it.
   * @throws {Error} when the scope is not one this store keeps.
   */
  #field(scope) {
    const field = SCOPE_FIELD[scope]
    if (field === undefined) throw new Error(`stock: unknown list scope "${scope}"`)
    return field
  }

  /**
   * Read one list, in the order the user arranged it.
   *
   * @param scope - the list to read.
   * @returns one copy per entry.
   */
  list(scope) {
    const stored = this.#state[this.#field(scope)]
    return stored === undefined ? [] : stored.map(copyEntry)
  }

  /** @returns the instant of the last mutation, or null before the first one. */
  updatedAt() {
    return this.#state.updatedAt
  }

  /**
   * @param scope - the list to measure.
   * @returns the largest accepted number of entries in it.
   */
  maxEntries(scope) {
    this.#field(scope)
    return this.#limits[scope]
  }

  /**
   * Give a document that has never held an index row the configured defaults.
   *
   * An empty row and an absent row mean different things: `[]` is a row the user
   * emptied, and only the absent field is seeded, so clearing the row stays
   * cleared across restarts.
   *
   * @returns whether the document was written.
   */
  seedIndexDefaults() {
    return this.#serialize(async () => {
      const state = this.#state
      if (state.indices !== undefined) return { seeded: false }
      const indices = this.#indexDefaults
        .slice(0, this.#limits.index)
        .map(code => ({ code, name: null, addedAt: nowInstant(), position: null }))
      await this.#domain.global.set({ ...state, indices, updatedAt: state.updatedAt })
      return { seeded: true }
    })
  }

  /**
   * Append securities that are not already listed.
   *
   * One call reports three outcomes rather than failing whole: a code already
   * present and a code with no room left are both normal results of a request
   * the user or the model can act on.
   *
   * @param scope - the list to append to.
   * @param codes - canonical codes, in the order to append them.
   * @returns what was appended, what was already present, and what did not fit.
   * @throws {Error} when a code is not a non-empty string.
   */
  add(scope, codes) {
    const field = this.#field(scope)
    for (const code of codes) {
      if (typeof code !== 'string' || code === '') throw new Error('stock: a listed code must be a non-empty string')
    }
    return this.#serialize(async () => {
      const state = this.#state
      const entries = state[field] ?? []
      const present = new Set(entries.map(entry => entry.code))
      const added = []
      const duplicates = []
      const full = []
      for (const code of new Set(codes)) {
        if (present.has(code)) {
          duplicates.push(code)
          continue
        }
        if (entries.length + added.length >= this.#limits[scope]) {
          full.push(code)
          continue
        }
        present.add(code)
        added.push({ code, name: null, addedAt: nowInstant(), position: null })
      }
      if (added.length > 0) {
        await this.#domain.global.set({
          ...state,
          [field]: [...entries.map(copyEntry), ...added],
          updatedAt: nowInstant(),
        })
      }
      return { added, duplicates, full, changed: added.length > 0 }
    })
  }

  /**
   * Drop securities from one list.
   *
   * @param scope - the list to drop from.
   * @param codes - canonical codes to remove.
   * @returns the codes removed and the codes that were not listed.
   */
  remove(scope, codes) {
    const field = this.#field(scope)
    return this.#serialize(async () => {
      const state = this.#state
      const entries = state[field] ?? []
      const wanted = new Set(codes)
      const kept = []
      const removed = []
      for (const entry of entries) {
        if (wanted.has(entry.code)) removed.push(entry.code)
        else kept.push(copyEntry(entry))
      }
      const dropped = new Set(removed)
      const absent = [...new Set(codes)].filter(code => !dropped.has(code))
      if (removed.length > 0) {
        await this.#domain.global.set({ ...state, [field]: kept, updatedAt: nowInstant() })
      }
      return { removed, absent, changed: removed.length > 0 }
    })
  }

  /**
   * Move one entry to another position in its list.
   *
   * The target is 1-based, which is how a person reads the list; the store
   * reports an impossible target as an outcome instead of throwing, because
   * whether it fits depends on the list at the moment the mutation runs.
   *
   * @param scope - the list to reorder.
   * @param code - canonical code to move.
   * @param to - the 1-based position the entry should occupy.
   * @returns the move's outcome and the list length it was judged against.
   */
  move(scope, code, to) {
    const field = this.#field(scope)
    return this.#serialize(async () => {
      const state = this.#state
      const entries = (state[field] ?? []).map(copyEntry)
      const from = entries.findIndex(entry => entry.code === code)
      if (from === -1) return { reason: 'not_listed', from: null, to: null, count: entries.length, changed: false }
      if (to > entries.length) return { reason: 'out_of_range', from: from + 1, to: null, count: entries.length, changed: false }
      const target = to - 1
      if (target === from) return { reason: 'unchanged', from: from + 1, to, count: entries.length, changed: false }
      const [moved] = entries.splice(from, 1)
      entries.splice(target, 0, moved)
      await this.#domain.global.set({ ...state, [field]: entries, updatedAt: nowInstant() })
      return { reason: 'moved', from: from + 1, to, count: entries.length, changed: true }
    })
  }

  /**
   * Forget every entry of one list, leaving the other list alone.
   *
   * @param scope - the list to empty.
   * @returns how many entries were dropped.
   */
  clear(scope) {
    const field = this.#field(scope)
    return this.#serialize(async () => {
      const state = this.#state
      const entries = state[field] ?? []
      const count = entries.length
      if (count > 0) await this.#domain.global.set({ ...state, [field]: [], updatedAt: nowInstant() })
      return { removed: count, changed: count > 0 }
    })
  }

  /**
   * Record the names upstream last reported, so an entry can be labelled while
   * the quote endpoint is unreachable.
   *
   * This is a repair of cached labels, not a change to the list the user
   * arranged, so it leaves `updatedAt` alone.
   *
   * @param scope - the list whose labels to repair.
   * @param names - canonical code to the name upstream returned for it.
   * @returns whether any stored name changed.
   */
  rememberNames(scope, names) {
    const field = this.#field(scope)
    return this.#serialize(async () => {
      const state = this.#state
      const entries = state[field] ?? []
      let changed = false
      const next = entries.map((entry) => {
        const name = names.get(entry.code)
        if (name === undefined || name === null || name === entry.name) return copyEntry(entry)
        changed = true
        return { ...copyEntry(entry), name }
      })
      if (changed) await this.#domain.global.set({ ...state, [field]: next, updatedAt: state.updatedAt })
      return { changed }
    })
  }

  /**
   * Mark one followed security as held, or update the figures already recorded
   * for it.
   *
   * A field left undefined keeps the figure already stored, and null clears it,
   * so a panel that submits an emptied input and a tool that omits an argument
   * mean different things. Marking a code the list does not hold changes
   * nothing; the caller reports that outcome instead.
   *
   * @param scope - the list to mark on; only the watchlist can hold positions.
   * @param code - canonical code of the followed security.
   * @param fields - `cost` and `quantity`; undefined keeps, null clears.
   * @returns the recorded position, or why nothing changed.
   */
  mark(scope, code, fields = {}) {
    if (scope !== 'watchlist') {
      return Promise.reject(Object.assign(new Error('stock: only the watchlist can hold positions'), { code: 'invalid_scope' }))
    }
    return this.#serialize(async () => {
      const state = this.#state
      const entries = (state.entries ?? []).map(copyEntry)
      const at = entries.findIndex(entry => entry.code === code)
      if (at === -1) return { reason: 'not_listed', position: null, changed: false }
      const current = entries[at].position
      const position = {
        cost: fields.cost === undefined ? current?.cost ?? null : fields.cost,
        quantity: fields.quantity === undefined ? current?.quantity ?? null : fields.quantity,
        markedAt: nowInstant(),
      }
      entries[at] = { ...entries[at], position }
      await this.#domain.global.set({ ...state, entries, updatedAt: nowInstant() })
      return { reason: 'marked', position, changed: true }
    })
  }

  /**
   * Clear the holding mark of one followed security, leaving the entry itself in
   * the list.
   *
   * @param scope - the list to unmark on; only the watchlist can hold positions.
   * @param code - canonical code of the followed security.
   * @returns whether a position was cleared, or why nothing changed.
   */
  unmark(scope, code) {
    if (scope !== 'watchlist') {
      return Promise.reject(Object.assign(new Error('stock: only the watchlist can hold positions'), { code: 'invalid_scope' }))
    }
    return this.#serialize(async () => {
      const state = this.#state
      const entries = (state.entries ?? []).map(copyEntry)
      const at = entries.findIndex(entry => entry.code === code)
      if (at === -1) return { reason: 'not_listed', changed: false }
      if (entries[at].position === null) return { reason: 'not_marked', changed: false }
      entries[at] = { ...entries[at], position: null }
      await this.#domain.global.set({ ...state, entries, updatedAt: nowInstant() })
      return { reason: 'unmarked', changed: true }
    })
  }

  /**
   * Release the domain. Pending mutations drain first; later calls reject.
   * @returns resolution after the medium is released.
   */
  async close() {
    this.#closing = true
    this.#closeTask ??= (async () => {
      await this.#chain
      return this.#domain.close()
    })()
    return this.#closeTask
  }
}

/**
 * Open the lists' domain, wrap it, and give a document that has never held an
 * index row its defaults.
 *
 * @param facility - the mounted storage domain facility.
 * @param options - the configured bounds and the index row's default codes.
 * @returns the open store.
 */
export async function openWatchlist(facility, options) {
  const store = new WatchlistStore(await facility.open(stockDomainSpec), options)
  try {
    await store.seedIndexDefaults()
  } catch (error) {
    // The facility reserves an open name, so a store that cannot finish opening
    // must release its domain or every later mount fails `already-open`.
    await store.close()
    throw error
  }
  return store
}

/**
 * The user's todo list: one durable document behind one serialization chain,
 * shared by the panel and the tools.
 *
 * Reads are synchronous from the in-memory document the domain keeps current;
 * every mutation runs inside the chain, so a panel toggle and an agent batch
 * cannot each start from the same snapshot and drop the other's change. A
 * mutation that writes nothing answers with the outcome that explains why and
 * leaves the medium alone.
 *
 * There is no per-item version: the last accepted write wins. The chain still
 * makes each write atomic and gives it the latest state, but a later writer is
 * not refused because another surface changed the item first.
 *
 * Every write spreads the document it read rather than building one from the
 * fields it touched. That is not a style choice: the schema strips keys it does
 * not declare, so a write that forgot `notifications` or `prefs` would drop the
 * reminder ledger and the person's settings on the next edit.
 *
 * @module dsh-user-todo/src/store
 */

import { randomUUID } from 'node:crypto'
import { buildAgenda, MAX_OCCURRENCES, nextOf as nextOccurrenceOf } from './agenda.js'
import { documentSchema, MAX_REMIND_BEFORE_MIN, prefsSchema } from './domain.js'
import { instant, SOURCES, STATUSES } from './item.js'
import { expandOccurrences, FREQS as FREQUENCY_NAMES, normalizeRecurrence, RecurrenceError } from './recurrence.js'
import {
  DATE_PATTERN,
  formatInstant,
  instantFromParts,
  instantOfLocalMidnight,
  isTimeZone,
  parseInstant,
  parseLocal,
} from './zone.js'

/** The instant form a deadline or a filter accepts. */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** Most reminder offsets one item may ask for. */
const MAX_REMIND_ENTRIES = 5

/** Most skipped occurrences one series may hold. */
const MAX_EXDATES = 200

/** Most ledger entries the document keeps. */
const MAX_NOTIFICATIONS = 500

/** How long one ledger entry stays useful. */
const NOTIFICATION_AGE_DAYS = 30

/**
 * A refused operation, carrying a closed code so every surface reports it the
 * same way. Codes are part of this bundle's contract: the panel maps them to
 * copy and the tools hand them to the model.
 */
export class TodoError extends Error {
  /**
   * @param {'invalid_title' | 'invalid_note' | 'invalid_due_at' | 'invalid_recurrence' | 'unsupported_rule' | 'invalid_remind' | 'invalid_prefs' | 'invalid_status' | 'invalid_writer' | 'invalid_key' | 'invalid_occurrence' | 'not_recurring' | 'batch_too_large' | 'too_many_items' | 'not_found'} code - closed failure code.
   * @param {string} message - diagnostic naming the field or the item.
   */
  constructor(code, message) {
    super(message)
    this.name = 'TodoError'
    this.code = code
  }
}

/**
 * Copy one stored item, so nothing outside the store holds a mutable reference
 * into the document.
 *
 * @param {import('./item.js').Item} item - stored item.
 * @returns {import('./item.js').Item} the copy.
 */
export function copyItem(item) {
  return {
    ...item,
    recurrence: item.recurrence === null ? null : { ...item.recurrence, byWeekday: [...item.recurrence.byWeekday] },
    exdates: [...item.exdates],
    remindBeforeMin: [...item.remindBeforeMin],
  }
}

/**
 * The order the list is read in: open items before done ones, then deadline
 * (undated last), then creation time. Ordering is computed on read, so a reorder
 * never needs a write.
 *
 * @param {import('./item.js').Item} a - left item.
 * @param {import('./item.js').Item} b - right item.
 * @returns the comparison.
 */
export function compareItems(a, b) {
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1
  const due = (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999')
  if (due !== 0) return due
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

/**
 * Validate and normalize a title.
 *
 * @param {unknown} value - the candidate.
 * @param {number} max - longest accepted title.
 * @returns {string} the trimmed title.
 * @throws {TodoError} `invalid_title` for anything else.
 */
function titleOf(value, max) {
  if (typeof value !== 'string') throw new TodoError('invalid_title', 'todo: `title` must be a string')
  const title = value.trim()
  if (title === '') throw new TodoError('invalid_title', 'todo: `title` must not be empty')
  if (title.length > max) throw new TodoError('invalid_title', `todo: \`title\` is longer than ${max} characters`)
  return title
}

/**
 * Validate and normalize a note.
 *
 * @param {unknown} value - the candidate.
 * @param {number} max - longest accepted note.
 * @returns {string | null} the trimmed note, or null for an empty one.
 * @throws {TodoError} `invalid_note` for anything else.
 */
function noteOf(value, max) {
  if (value === null) return null
  if (typeof value !== 'string') throw new TodoError('invalid_note', 'todo: `note` must be a string or null')
  const note = value.trim()
  if (note.length > max) throw new TodoError('invalid_note', `todo: \`note\` is longer than ${max} characters`)
  return note === '' ? null : note
}

/**
 * Validate one closed value.
 *
 * @param {unknown} value - the candidate.
 * @param {string[]} allowed - accepted values.
 * @param {'invalid_status' | 'invalid_writer'} code - failure code.
 * @returns {string} the value.
 * @throws {TodoError} the code when the value is not one of `allowed`.
 */
function oneOf(value, allowed, code) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TodoError(code, `todo: expected one of ${allowed.join(', ')}`)
  }
  return value
}

/**
 * Read a zone name.
 *
 * @param value - the candidate.
 * @returns the zone name to store, or null when the item leaves it to the deployment.
 * @throws {TodoError} `invalid_due_at` when the name is not one this runtime knows.
 */
function zoneOf(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !isTimeZone(value)) {
    throw new TodoError('invalid_due_at', `todo: \`timeZone\` is not a zone this runtime knows: ${String(value)}`)
  }
  return value
}

/**
 * The two stored fields one time request becomes.
 *
 * A bare date means all-day; a local wall-clock reading means timed in the item's
 * zone; an instant means timed as written. Exactly one of `dueDate` and a
 * writer-supplied `dueAt` survives: when a date is given, the instant is derived
 * and the writer's instant is ignored rather than contradicting it.
 *
 * @param request - `{ dueAt?, dueDate?, timeZone? }` or null.
 * @param options - the deployment zone and whether an absent request clears the time.
 * @param options.defaultTimeZone - zone used when the request names none.
 * @returns `{ dueAt, dueDate, timeZone }`, or null when the request clears the time.
 * @throws {TodoError} `invalid_due_at`.
 */
/**
 * The snake_case spellings a tool argument or a panel body may use for one
 * stored field.
 *
 * Both surfaces reach this store, and the tools speak the model-facing
 * vocabulary while the panel speaks the stored one. Renaming them here is what
 * keeps a rule or a reminder from being accepted and silently dropped because it
 * arrived under the other name.
 */
const FIELD_ALIASES = {
  due_at: 'dueAt',
  due_date: 'dueDate',
  time_zone: 'timeZone',
  repeat: 'recurrence',
  remind_before_min: 'remindBeforeMin',
}

/**
 * One entry or patch with its aliases renamed.
 *
 * @param source - the object a surface wrote.
 * @returns the same object when it has no alias, or a renamed copy.
 */
function canonicalFields(source) {
  let next = source
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (!Object.hasOwn(source, alias)) continue
    if (next === source) next = { ...source }
    if (next[canonical] === undefined) next[canonical] = source[alias]
    delete next[alias]
  }
  return next
}

function timeOf(request, { defaultTimeZone }) {
  if (request === null) return null
  if (typeof request !== 'object' || Array.isArray(request)) {
    throw new TodoError('invalid_due_at', 'todo: `due` must be an object or null')
  }
  const rawZone = zoneOf(request.timeZone)
  const zone = rawZone ?? defaultTimeZone
  const date = request.dueDate
  const at = request.dueAt
  if (date !== undefined && date !== null) {
    if (typeof date !== 'string' || !DATE_PATTERN.test(date) || Number.isNaN(instantOfLocalMidnight(date, zone))) {
      throw new TodoError('invalid_due_at', 'todo: `dueDate` must be a calendar date such as 2026-11-02, or null')
    }
    return { dueAt: formatInstant(instantOfLocalMidnight(date, zone)), dueDate: date, timeZone: rawZone }
  }
  if (at === undefined || at === null) return null
  if (typeof at !== 'string') {
    throw new TodoError('invalid_due_at', 'todo: `dueAt` must be a string or null')
  }
  if (DATE_PATTERN.test(at)) {
    return { dueAt: formatInstant(instantOfLocalMidnight(at, zone)), dueDate: at, timeZone: rawZone }
  }
  const local = parseLocal(at)
  if (local !== null) {
    const [year, month, day] = local.date.split('-').map(Number)
    // Built from wall-clock fields rather than midnight plus an offset: a zone
    // that shifts its clock inside this day would otherwise move the deadline.
    const millis = instantFromParts({ year, month, day, hour: local.hour, minute: local.minute }, zone)
    return { dueAt: formatInstant(millis), dueDate: null, timeZone: rawZone }
  }
  if (INSTANT_PATTERN.test(at) && !Number.isNaN(parseInstant(at))) {
    return { dueAt: at, dueDate: null, timeZone: rawZone }
  }
  throw new TodoError('invalid_due_at', 'todo: `dueAt` must be 2026-11-02, 2026-11-02T15:00, or 2026-11-02T07:00:00Z, or null')
}

/**
 * Validate one repeat rule, translating its failures into this store's codes.
 *
 * @param value - the candidate rule.
 * @returns the normalized rule, or null.
 * @throws {TodoError} `invalid_recurrence` or `unsupported_rule`.
 */
function recurrenceOf(value) {
  // A bare frequency is the shorthand both surfaces offer in their own words
  // ("每天" / "daily"); it means the same rule as `{ freq }` with every other
  // field at its default.
  const asked = typeof value === 'string' && FREQUENCY_NAMES.includes(value) ? { freq: value } : value
  try {
    return normalizeRecurrence(asked)
  } catch (error) {
    if (error instanceof RecurrenceError) throw new TodoError(error.code, error.message)
    throw error
  }
}

/**
 * Validate reminder offsets: whole minutes, de-duplicated, bounded.
 *
 * @param value - the candidate list, a single number, or null.
 * @returns the kept offsets, ascending.
 * @throws {TodoError} `invalid_remind`.
 */
function remindOf(value) {
  if (value === null) return []
  const list = typeof value === 'number' ? [value] : value
  if (!Array.isArray(list)) throw new TodoError('invalid_remind', 'todo: `remindBeforeMin` must be an array of minutes or null')
  const kept = new Set()
  for (const entry of list) {
    if (!Number.isSafeInteger(entry) || entry < 0 || entry > MAX_REMIND_BEFORE_MIN) {
      throw new TodoError('invalid_remind', `todo: each reminder offset must be whole minutes from 0 to ${MAX_REMIND_BEFORE_MIN}`)
    }
    kept.add(entry)
  }
  if (kept.size > MAX_REMIND_ENTRIES) {
    throw new TodoError('invalid_remind', `todo: at most ${MAX_REMIND_ENTRIES} reminder offsets are kept`)
  }
  return [...kept].sort((left, right) => left - right)
}

/**
 * The occurrence start one occurrence id names, checked against its item.
 *
 * @param item - the item the caller named.
 * @param occurrenceId - the derived id, `item id@instant`.
 * @returns the start instant in epoch milliseconds.
 * @throws {TodoError} `invalid_occurrence`.
 */
function occurrenceStartOf(item, occurrenceId) {
  if (typeof occurrenceId !== 'string') {
    throw new TodoError('invalid_occurrence', 'todo: `occurrence_id` must be a string')
  }
  const at = occurrenceId.lastIndexOf('@')
  if (at <= 0) throw new TodoError('invalid_occurrence', 'todo: `occurrence_id` must look like "<item id>@<instant>"')
  if (occurrenceId.slice(0, at) !== item.id) {
    throw new TodoError('invalid_occurrence', 'todo: `occurrence_id` does not belong to this item')
  }
  const millis = parseInstant(occurrenceId.slice(at + 1))
  if (Number.isNaN(millis)) throw new TodoError('invalid_occurrence', 'todo: `occurrence_id` does not carry a UTC instant')
  return millis
}

/**
 * The list behind one open domain. All reads and writes go through this
 * instance; the plugin creates exactly one.
 */
export class TodoStore {
  /** @type {object} */
  #domain

  /** @type {(() => unknown) | null} */
  #context = null

  /** @type {Promise<unknown>} */
  #chain = Promise.resolve()

  #closing = false

  /**
   * The last document read while the domain was open, kept so a read on a
   * closed domain still answers instead of throwing. A reader that races the
   * shutdown (a reminder tick firing as the plugin disposes) must not be able to
   * take the host down, so that one case degrades to the last known list. So
   * there we sit, and any other read failure is a fault that still surfaces.
   *
   * @type {unknown}
   */
  #lastDocument = undefined

  /** @type {object} */
  #bounds

  /** @type {number} */
  #maxItems

  /** @type {string} */
  #timeZone

  /**
   * @param domain - the opened domain handle.
   * @param options - configured bounds.
   * @param options.bounds - per-field limits.
   * @param options.maxItems - most items the list holds.
   * @param options.timeZone - zone used when an item names none.
   */
  constructor(domain, { bounds, maxItems, timeZone }) {
    this.#domain = domain
    this.#bounds = bounds
    this.#maxItems = maxItems
    this.#timeZone = timeZone
  }

  /**
   * The zone a written time is read in when the item names none.
   *
   * @returns the IANA name.
   */
  get timeZone() {
    return this.#timeZone
  }

  /**
   * Run one mutation in the store's serialization chain.
   *
   * @template T
   * @param {() => Promise<T>} work - the mutation.
   * @returns {Promise<T>} its result.
   */
  #serialize(work) {
    if (this.#closing) return Promise.reject(new TodoError('not_found', 'todo: the list is closing'))
    const run = this.#chain.then(work, work)
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Read the stored document.
   *
   * A read is attempted against the domain for as long as it answers, and the
   * last good answer is remembered. `close()` sets `#closing` before it drains
   * the queue, so the flag alone cannot decide this: a write already admitted
   * still has to read once more. What decides it is whether the domain still
   * answers a read. When it does not (closed underneath a late reader such as a
   * reminder tick firing as the plugin disposes) the last read is served
   * instead, so a read degrades to a coherent snapshot rather than throwing an
   * exception that would escape into a timer and take the host down.
   *
   * Only a medium that is gone is answered from the snapshot. The facility
   * signals that with `code: 'closed'`; any other failure is a real fault, and
   * serving an old list would hide it behind plausible-looking stale data. It
   * is therefore rethrown rather than absorbed.
   *
   * @returns the document.
   * @throws {TodoError} `not_found` when nothing was ever read and none can be.
   */
  #document() {
    try {
      const document = this.#domain.global.get()
      this.#lastDocument = document
      return document
    } catch (error) {
      if (error?.code !== 'closed') throw error
      if (this.#lastDocument === undefined) {
        throw new TodoError('not_found', `todo: the list is closed (${error?.message ?? error})`)
      }
      return this.#lastDocument
    }
  }

  #emit() {
    this.#context?.()
  }

  /**
   * Snapshot every item, copied and ordered.
   *
   * @returns {import('./item.js').Item[]} the list as a reader sees it.
   */
  items() {
    return this.#document().items.map(copyItem).sort(compareItems)
  }

  /**
   * Read one item.
   *
   * @param {string} id - item identity.
   * @returns {import('./item.js').Item | undefined} a copy, or undefined when absent.
   */
  item(id) {
    const found = this.#document().items.find(item => item.id === id)
    return found === undefined ? undefined : copyItem(found)
  }

  /**
   * The person's preference block.
   *
   * @returns the prefs, copied.
   */
  prefs() {
    return structuredClone(this.#document().prefs)
  }

  /**
   * The reminder ledger.
   *
   * @returns the entries, copied.
   */
  notifications() {
    return this.#document().notifications.map(entry => ({ ...entry }))
  }

  /**
   * The occurrences inside a window, read without writing anything.
   *
   * @param options - the window and what to include.
   * @param options.from - inclusive window start, epoch milliseconds.
   * @param options.to - exclusive window end, epoch milliseconds.
   * @param options.includeDone - keep completed occurrences.
   * @param options.limit - most occurrences to return.
   * @returns the agenda.
   */
  agenda({ from, to, includeDone = false, limit = MAX_OCCURRENCES } = {}) {
    return buildAgenda(this.items(), { from, to, timeZone: this.#timeZone, includeDone, limit })
  }

  /**
   * The next occurrence of one item, skipping occurrences already completed.
   *
   * @param item - the stored item.
   * @param options - the moment to search from.
   * @param options.after - inclusive lower bound, epoch milliseconds.
   * @returns the occurrence, or null when the series has no more.
   */
  nextOf(item, { after }) {
    return nextOccurrenceOf(item, { after, timeZone: this.#timeZone })
  }

  /**
   * Add items in one atomic write.
   *
   * A title already held by an open item is skipped when `dedupe` is set (the
   * tools set it, so a retried batch cannot duplicate the list) and kept when it
   * is not (the panel adds what the person typed).
   *
   * @param entries - requested items.
   * @param {'user' | 'agent'} writer - who is adding.
   * @param {{ dedupe?: boolean }} [options] - dedupe against open titles.
   * @returns {Promise<{ added: import('./item.js').Item[], skipped: Array<{ title: string, reason: 'duplicate' | 'list_full' }> }>} what landed and what did not.
   */
  create(entries, writer, { dedupe = false } = {}) {
    oneOf(writer, SOURCES, 'invalid_writer')
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new TodoError('invalid_key', 'todo: at least one item is required')
    }
    const wanted = entries.map((raw) => {
      if (typeof raw !== 'object' || raw === null) throw new TodoError('invalid_key', 'todo: an item must be an object')
      const entry = canonicalFields(raw)
      const status = entry.status === undefined ? 'open' : oneOf(entry.status, STATUSES, 'invalid_status')
      // Both spellings are accepted here rather than at each surface: a panel
      // patch and a tool argument reach the same validator, and silently ignoring
      // one spelling would create the item without the deadline it asked for.
      const askedDue = entry.dueAt ?? entry.due_at
      const askedDate = entry.dueDate ?? entry.due_date
      const askedZone = entry.timeZone ?? entry.time_zone
      const due = timeOf(entry.due ?? (askedDue !== undefined || askedDate !== undefined
        ? { dueAt: askedDue, dueDate: askedDate, timeZone: askedZone }
        : null), { defaultTimeZone: this.#timeZone })
      const askedRemind = entry.remindBeforeMin ?? entry.remind_before_min
      const recurrence = entry.recurrence === undefined ? null : recurrenceOf(entry.recurrence)
      if (recurrence !== null && due === null) {
        throw new TodoError('invalid_recurrence', 'todo: a repeat rule needs a due time to start from')
      }
      return {
        title: titleOf(entry.title, this.#bounds.maxTitleChars),
        note: entry.note === undefined ? null : noteOf(entry.note, this.#bounds.maxNoteChars),
        due,
        recurrence,
        remindBeforeMin: askedRemind === undefined ? [] : remindOf(askedRemind),
        status,
      }
    })
    return this.#serialize(async () => {
      const document = this.#document()
      const at = instant()
      const openTitles = new Set(document.items.filter(item => item.status === 'open').map(item => item.title))
      /** @type {import('./item.js').Item[]} */
      const added = []
      /** @type {Array<{ title: string, reason: 'duplicate' | 'list_full' }>} */
      const skipped = []
      for (const entry of wanted) {
        if (dedupe && openTitles.has(entry.title)) {
          skipped.push({ title: entry.title, reason: 'duplicate' })
          continue
        }
        if (document.items.length + added.length >= this.#maxItems) {
          skipped.push({ title: entry.title, reason: 'list_full' })
          continue
        }
        openTitles.add(entry.title)
        added.push({
          id: `todo-${randomUUID()}`,
          status: entry.status,
          title: entry.title,
          note: entry.note,
          dueAt: entry.due === null ? null : entry.due.dueAt,
          dueDate: entry.due === null ? null : entry.due.dueDate,
          timeZone: entry.due === null ? null : entry.due.timeZone,
          recurrence: entry.recurrence,
          recurrenceDoneThrough: null,
          exdates: [],
          remindBeforeMin: entry.remindBeforeMin,
          createdAt: at,
          updatedAt: at,
          completedAt: entry.status === 'done' ? at : null,
          lastWriter: writer,
        })
      }
      if (added.length > 0) {
        await this.#domain.global.set(documentSchema.parse({ ...document, items: [...document.items, ...added], updatedAt: at }))
        this.#emit()
      }
      return { added: added.map(copyItem), skipped }
    })
  }

  /**
   * Change one or more items in one atomic write. The last accepted write wins:
   * an entry is applied to the state the chain holds at its slot, with no
   * version check against what the caller read.
   *
   * Clearing an item's time also clears its repeat rule: a series without a
   * first occurrence has nowhere to start, and keeping it would resurrect the
   * rule the moment a new date was set.
   *
   * @param changes - one entry per item: its id and the patch.
   * @param {'user' | 'agent'} writer - who is changing.
   * @returns {Promise<{ changed: import('./item.js').Item[], results: Array<object> }>} the new items, and one result per entry.
   */
  update(changes, writer) {
    oneOf(writer, SOURCES, 'invalid_writer')
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new TodoError('invalid_key', 'todo: at least one change is required')
    }
    const wanted = changes.map((change) => {
      if (typeof change !== 'object' || change === null) throw new TodoError('invalid_key', 'todo: a change must be an object')
      const patch = typeof change.patch === 'object' && change.patch !== null ? canonicalFields(change.patch) : {}
      const keys = Object.keys(patch)
      for (const key of keys) {
        if (!['title', 'note', 'due', 'recurrence', 'remindBeforeMin', 'status'].includes(key)) {
          throw new TodoError('invalid_key', `todo: \`patch.${key}\` is not an editable field`)
        }
      }
      return {
        id: typeof change.id === 'string' ? change.id : '',
        hasTitle: Object.hasOwn(patch, 'title'),
        title: Object.hasOwn(patch, 'title') ? titleOf(patch.title, this.#bounds.maxTitleChars) : undefined,
        hasNote: Object.hasOwn(patch, 'note'),
        note: Object.hasOwn(patch, 'note') ? noteOf(patch.note, this.#bounds.maxNoteChars) : undefined,
        hasDue: Object.hasOwn(patch, 'due'),
        due: Object.hasOwn(patch, 'due') ? timeOf(patch.due, { defaultTimeZone: this.#timeZone }) : undefined,
        hasRecurrence: Object.hasOwn(patch, 'recurrence'),
        recurrence: Object.hasOwn(patch, 'recurrence') ? recurrenceOf(patch.recurrence) : undefined,
        hasRemind: Object.hasOwn(patch, 'remindBeforeMin'),
        remindBeforeMin: Object.hasOwn(patch, 'remindBeforeMin') ? remindOf(patch.remindBeforeMin) : undefined,
        hasStatus: Object.hasOwn(patch, 'status'),
        status: Object.hasOwn(patch, 'status') ? oneOf(patch.status, STATUSES, 'invalid_status') : undefined,
      }
    })
    return this.#serialize(async () => {
      const document = this.#document()
      const at = instant()
      const byId = new Map(document.items.map(item => [item.id, copyItem(item)]))
      /** @type {Array<object>} */
      const results = []
      let wrote = false
      for (const change of wanted) {
        const current = byId.get(change.id)
        if (current === undefined) {
          results.push({ id: change.id, code: 'not_found' })
          continue
        }
        const next = { ...current, updatedAt: at, lastWriter: writer }
        if (change.hasTitle) next.title = change.title
        if (change.hasNote) next.note = change.note
        if (change.hasDue) {
          next.dueAt = change.due === null ? null : change.due.dueAt
          next.dueDate = change.due === null ? null : change.due.dueDate
          next.timeZone = change.due === null ? null : change.due.timeZone
          if (change.due === null) {
            next.recurrence = null
            next.recurrenceDoneThrough = null
            next.exdates = []
          }
        }
        if (change.hasRecurrence) {
          if (change.recurrence !== null && next.dueAt === null) {
            results.push({ id: change.id, code: 'invalid_recurrence', message: 'a repeat rule needs a due time to start from' })
            continue
          }
          // A different rule restarts the series: the old watermark names an
          // occurrence the new schedule may not contain, and keeping it would
          // mark arbitrary future occurrences done.
          const ruleChanged = !sameJson(change.recurrence, current.recurrence)
          next.recurrence = change.recurrence
          if (change.recurrence === null) {
            next.recurrenceDoneThrough = null
            next.exdates = []
          } else if (ruleChanged) {
            next.recurrenceDoneThrough = null
          }
        }
        if (change.hasRemind) next.remindBeforeMin = change.remindBeforeMin ?? []
        if (change.hasStatus && change.status !== current.status) {
          next.status = change.status
          next.completedAt = change.status === 'done' ? at : null
          if (change.status === 'open') next.recurrenceDoneThrough = null
        }
        const unchanged = next.title === current.title && next.note === current.note
          && next.dueAt === current.dueAt && next.dueDate === current.dueDate && next.timeZone === current.timeZone
          && next.status === current.status
          && sameJson(next.recurrence, current.recurrence)
          && sameNumbers(next.remindBeforeMin, current.remindBeforeMin)
        if (unchanged) {
          results.push({ id: change.id, code: 'unchanged', current: copyItem(current) })
          continue
        }
        byId.set(change.id, next)
        wrote = true
        results.push({ id: change.id, code: 'changed', item: copyItem(next) })
      }
      if (wrote) {
        const items = document.items.map(item => byId.get(item.id) ?? item)
        await this.#domain.global.set(documentSchema.parse({ ...document, items, updatedAt: at }))
        this.#emit()
      }
      const changed = results.filter(result => result.code === 'changed').map(result => result.item)
      return { changed, results }
    })
  }

  /**
   * Complete one occurrence of one item.
   *
   * A single item is simply marked done. A repeated item records a watermark, so
   * the series stays open and the next occurrence appears normally; the series is
   * closed only when this was its last occurrence.
   *
   * @param id - item identity.
   * @param occurrenceId - the occurrence the caller completed.
   * @param {'user' | 'agent'} writer - who is changing.
   * @returns {Promise<{ item: import('./item.js').Item }>} the new item.
   * @throws {TodoError} `not_found`, `invalid_occurrence`, or `not_recurring`.
   */
  completeOccurrence(id, occurrenceId, writer) {
    oneOf(writer, SOURCES, 'invalid_writer')
    return this.#serialize(async () => {
      const document = this.#document()
      const current = document.items.find(entry => entry.id === id)
      if (current === undefined) throw new TodoError('not_found', `todo: no item is ${id}`)
      const start = occurrenceStartOf(current, occurrenceId)
      const at = instant()
      const next = copyItem(current)
      next.updatedAt = at
      next.lastWriter = writer
      if (next.recurrence === null) {
        next.status = 'done'
        next.completedAt = at
      } else {
        const watermark = next.recurrenceDoneThrough === null ? Number.NaN : parseInstant(next.recurrenceDoneThrough)
        if (Number.isNaN(watermark) || start > watermark) next.recurrenceDoneThrough = formatInstant(start)
        const later = expandOccurrences({ ...next, recurrenceDoneThrough: null }, {
          from: start + 1000,
          to: start + 366 * 24 * 60 * 60 * 1000,
          timeZone: this.#timeZone,
          limit: 1,
        })
        if (later.length === 0) {
          next.status = 'done'
          next.completedAt = at
        }
      }
      const items = document.items.map(entry => (entry.id === id ? next : entry))
      await this.#domain.global.set(documentSchema.parse({ ...document, items, updatedAt: at }))
      this.#emit()
      return { item: copyItem(next) }
    })
  }

  /**
   * Skip one occurrence of a repeated item.
   *
   * @param id - item identity.
   * @param occurrenceId - the occurrence to skip.
   * @returns {Promise<{ item: import('./item.js').Item }>} the new item.
   * @throws {TodoError} `not_found`, `invalid_occurrence`, or `not_recurring`.
   */
  excludeOccurrence(id, occurrenceId) {
    return this.#serialize(async () => {
      const document = this.#document()
      const current = document.items.find(entry => entry.id === id)
      if (current === undefined) throw new TodoError('not_found', `todo: no item is ${id}`)
      if (current.recurrence === null) throw new TodoError('not_recurring', 'todo: only a repeating item has occurrences to skip')
      const start = occurrenceStartOf(current, occurrenceId)
      const key = formatInstant(start)
      const at = instant()
      const next = copyItem(current)
      if (!next.exdates.includes(key)) {
        next.exdates = [...next.exdates, key].sort().slice(-MAX_EXDATES)
      }
      next.updatedAt = at
      const items = document.items.map(entry => (entry.id === id ? next : entry))
      await this.#domain.global.set(documentSchema.parse({ ...document, items, updatedAt: at }))
      this.#emit()
      return { item: copyItem(next) }
    })
  }

  /**
   * Remove the named items in one atomic write.
   *
   * Removing an item stops its series and its reminders: the item is gone, so
   * the ledger entries that named it can never be replayed, and a ticker that
   * still held one would fail to find the item behind it. Trimming them is what
   * keeps a long-lived document from carrying dead keys forever.
   *
   * @param ids - identities to drop.
   * @returns {Promise<{ removed: string[], absent: string[] }>} what was dropped and what was not listed.
   * @throws {TodoError} `invalid_key` when `ids` is not an array.
   */
  remove(ids) {
    if (!Array.isArray(ids)) throw new TodoError('invalid_key', 'todo: `ids` must be an array')
    return this.#remove((item, wanted) => wanted.has(item.id), new Set(ids.filter(id => typeof id === 'string')))
  }

  /**
   * Remove every finished item, keeping the open ones.
   *
   * The panel's "clear finished" and the tool's no-`ids` form both need it. It
   * is a method of its own rather than a `null` argument to `remove`, so that a
   * caller cannot reach "delete all the finished ones" by passing a value that
   * reads like "no ids".
   *
   * @returns {Promise<{ removed: string[], absent: string[] }>} the finished items that were dropped; `absent` is always empty.
   */
  removeFinished() {
    return this.#remove(item => item.status === 'done', null)
  }

  /**
   * The one delete path both public removals share.
   *
   * @param drops - whether one stored item is to be dropped.
   * @param wanted - the identities the caller named, to report as absent; null when it named none.
   * @returns {Promise<{ removed: string[], absent: string[] }>} what was dropped and what was not listed.
   */
  #remove(drops, wanted) {
    return this.#serialize(async () => {
      const document = this.#document()
      const removed = []
      const kept = []
      for (const item of document.items) {
        if (drops(item, wanted)) removed.push(item.id)
        else kept.push(item)
      }
      const dropped = new Set(removed)
      const absent = wanted === null ? [] : [...wanted].filter(id => !dropped.has(id))
      if (removed.length === 0) return { removed, absent }
      const live = new Set(removed)
      // A ledger key is `${occurrenceId}#${offsetMin}`, and an occurrence id is
      // `${itemId}@${startInstant}`: an entry belongs to a dropped item when
      // the occurrence it names does.
      const notifications = document.notifications.filter((entry) => {
        const occurrence = entry.key.split('#')[0]
        return !live.has(occurrence.slice(0, occurrence.indexOf('@')))
      })
      await this.#domain.global.set(documentSchema.parse({ ...document, items: kept, notifications, updatedAt: instant() }))
      this.#emit()
      return { removed, absent }
    })
  }

  /**
   * Replace part of the preference block.
   *
   * @param patch - the fields to change.
   * @returns {Promise<{ prefs: object }>} the new prefs.
   * @throws {TodoError} `invalid_prefs` when the merge does not validate.
   */
  setPrefs(patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new TodoError('invalid_prefs', 'todo: `prefs` must be an object')
    }
    for (const key of Object.keys(patch)) {
      if (!['pushReminders', 'defaultRemindBeforeMin', 'allDayReminderTime', 'quietHours', 'digestAt', 'weekStart'].includes(key)) {
        throw new TodoError('invalid_prefs', `todo: \`prefs.${key}\` is not a setting`)
      }
    }
    return this.#serialize(async () => {
      const document = this.#document()
      const merged = { ...document.prefs, ...patch }
      const parsed = prefsSchema.safeParse(merged)
      if (!parsed.success) {
        throw new TodoError('invalid_prefs', `todo: ${parsed.error.issues[0]?.message ?? 'invalid preference'}`)
      }
      await this.#domain.global.set(documentSchema.parse({ ...document, prefs: parsed.data, updatedAt: instant() }))
      this.#emit()
      return { prefs: structuredClone(parsed.data) }
    })
  }

  /**
   * Append reminder outcomes to the ledger, pruning as it grows.
   *
   * @param entries - `{ key, at, status }` records.
   * @returns {Promise<void>} resolution after the write.
   */
  recordNotifications(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return Promise.resolve()
    return this.#serialize(async () => {
      const document = this.#document()
      const cutoff = Date.now() - NOTIFICATION_AGE_DAYS * 24 * 60 * 60 * 1000
      const kept = [...document.notifications, ...entries.map(entry => ({ ...entry }))]
        .filter(entry => parseInstant(entry.at) >= cutoff)
        .slice(-MAX_NOTIFICATIONS)
      await this.#domain.global.set(documentSchema.parse({ ...document, notifications: kept }))
      this.#emit()
    })
  }

  /**
   * Run `notify` after every accepted write, on this plugin's fiber.
   *
   * @param notify - the listener to call; typically a change broadcast.
   * @returns cleanup that stops the notification.
   */
  onChange(notify) {
    this.#context = notify
    return () => { this.#context = null }
  }

  /**
   * Release the domain. Pending mutations drain first; later calls reject.
   *
   * @returns {Promise<void>} resolution after the medium is released.
   */
  async close() {
    this.#closing = true
    await this.#chain
    this.#context = null
    await this.#domain.close()
  }
}

/**
 * Whether two lists of numbers match.
 *
 * @param left - one list.
 * @param right - the other.
 * @returns true when every entry matches.
 */
function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Whether two stored optional objects are indistinguishable as JSON.
 *
 * @param left - one value.
 * @param right - the other.
 * @returns true when both serialize the same.
 */
function sameJson(left, right) {
  if (left === right) return true
  if (left === null || right === null || left === undefined || right === undefined) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

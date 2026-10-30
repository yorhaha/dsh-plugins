/**
 * The durable document of the user's todo list.
 *
 * The whole list is one domain `global` rather than one record per item: a
 * create batch, an update batch, and a single toggle must each land atomically,
 * and the list is small enough that one durable write per accepted mutation is
 * the cheapest correct shape. The medium is the mounted storage backend
 * (`$DSH_HOME/storages/user_todo.json` with the json backend), so an operator
 * can read or repair the list by hand.
 *
 * A document that fails this schema rejects the open, which fails the plugin
 * load loudly: the list is the user's own data, and starting from an empty list
 * because one field was hand-edited would look like the list vanished. A field
 * the schema does not declare is dropped, which is how a document written by an
 * older version of this bundle keeps opening after a field is retired.
 *
 * The calendar fields are all optional with defaults, which is what keeps the
 * version at 1: a document written before they existed opens, gains the defaults
 * in memory, and is written back in the new shape on its next accepted mutation.
 * Raising the version would make the domain refuse to open, and this storage
 * layer has no migration.
 *
 * @module dsh-user-todo/src/domain
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { FREQS, MAX_COUNT, MAX_INTERVAL } from './recurrence.js'

/** Domain name; it is also the backend unit name and the storage file stem. */
export const DOMAIN_NAME = 'user_todo'

/**
 * Current document version. Retiring a field does not raise it: `.strip()` drops
 * a field the schema no longer declares, so an older document still opens.
 * Adding a required field or changing a stored shape does raise it, and the
 * stored data then has to be migrated by hand — which is why every field added
 * for the calendar is optional and defaulted.
 */
export const DOMAIN_VERSION = 1

/** The instant form every stored timestamp uses. */
export const instantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'expected YYYY-MM-DDTHH:MM:SSZ')

/** A calendar date with no time of day. */
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')

/** A wall-clock time of day used by reminder preferences. */
export const clockSchema = z.string()
  .regex(/^\d{2}:\d{2}$/, 'expected HH:MM')
  .refine((text) => {
    const [hour, minute] = text.split(':').map(Number)
    return hour < 24 && minute < 60
  }, 'expected a clock time inside one day')

/** Longest reminder lead accepted, in minutes: one week. */
export const MAX_REMIND_BEFORE_MIN = 7 * 24 * 60

/**
 * One repeat rule. The field set is closed: an unknown key is stripped rather
 * than carried, and the writer that produced it validates first, so a rule that
 * reaches the medium is one the expansion understands.
 */
export const recurrenceSchema = z.object({
  freq: z.enum(FREQS),
  interval: z.number().int().min(1).max(MAX_INTERVAL).default(1),
  byWeekday: z.array(z.number().int().min(1).max(7)).default([]),
  count: z.number().int().min(1).max(MAX_COUNT).nullable().default(null),
  until: instantSchema.nullable().default(null),
  dtstart: instantSchema.nullable().default(null),
}).strip()

/**
 * One stored item. An absent optional field is stored as `null` (or an empty
 * list), so the document never has a key that is sometimes present and sometimes
 * not.
 *
 * A field this list no longer offers is dropped when an older document is read,
 * so a document written while it existed still opens instead of taking the whole
 * plugin load down over a value nothing reads any more.
 */
export const itemSchema = z.object({
  id: z.string().regex(/^todo-[0-9a-f-]{36}$/),
  status: z.enum(['open', 'done']),
  title: z.string().min(1),
  note: z.string().nullable(),
  dueAt: instantSchema.nullable(),
  dueDate: dateSchema.nullable().default(null),
  timeZone: z.string().nullable().default(null),
  recurrence: recurrenceSchema.nullable().default(null),
  recurrenceDoneThrough: instantSchema.nullable().default(null),
  exdates: z.array(instantSchema).default([]),
  remindBeforeMin: z.array(z.number().int().min(0).max(MAX_REMIND_BEFORE_MIN)).default([]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  completedAt: instantSchema.nullable(),
  lastWriter: z.enum(['user', 'agent']),
}).strip()

/**
 * One reminder this plugin has already decided about. The ledger is what makes a
 * reminder idempotent across restarts: the key names the occurrence and the
 * offset, so a second tick cannot send the same one again.
 */
export const notificationSchema = z.object({
  key: z.string().min(1),
  at: instantSchema,
  status: z.enum(['sent', 'failed']),
}).strip()

/**
 * Behaviour the person can change from the panel. It lives in the document
 * rather than in the loader row because the panel must be able to write it, and
 * a row edit would mean reloading the plugin.
 */
export const prefsSchema = z.object({
  pushReminders: z.boolean().default(true),
  defaultRemindBeforeMin: z.number().int().min(0).max(MAX_REMIND_BEFORE_MIN).default(0),
  allDayReminderTime: clockSchema.default('09:00'),
  quietHours: z.object({ start: clockSchema, end: clockSchema }).strip().nullable().default(null),
  digestAt: clockSchema.nullable().default(null),
  weekStart: z.number().int().min(1).max(7).default(1),
}).strip()

/** The defaults one fresh document starts from. */
export const EMPTY_PREFS = prefsSchema.parse({})

/**
 * The complete document; `updatedAt` is null only before the first accepted
 * mutation.
 */
export const documentSchema = z.object({
  items: z.array(itemSchema),
  notifications: z.array(notificationSchema).default([]),
  prefs: prefsSchema.default(() => prefsSchema.parse({})),
  updatedAt: instantSchema.nullable(),
}).strip()

/**
 * The domain this plugin owns. `single` layout keeps the list in one readable
 * document and makes every accepted mutation atomic; it declares no tables.
 */
export const userTodoDomain = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  layout: 'single',
  global: {
    schema: documentSchema,
    initial: { items: [], notifications: [], prefs: EMPTY_PREFS, updatedAt: null },
  },
  tables: {},
})

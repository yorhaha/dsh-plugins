/**
 * Checks for the agenda projection: what an occurrence is, when one counts as
 * done, and how a window is read.
 *
 * The fixture zone is Asia/Shanghai (UTC+8), so a local 09:00 is 01:00Z and local
 * midnight is the previous day at 16:00Z.
 */
import assert from 'node:assert/strict'
import {
  AgendaError,
  buildAgenda,
  isOccurrenceDone,
  nextOf,
  occurrenceIdOf,
  parseWindowPoint,
  resolveWindow,
} from '../src/agenda.js'
import { normalizeRecurrence } from '../src/recurrence.js'
import { formatInstant, parseInstant } from '../src/zone.js'

const failures = []
let passed = 0

/**
 * Run one check, recording its outcome.
 * @param name - what the check pins.
 * @param work - the check body.
 */
function check(name, work) {
  try {
    work()
    passed += 1
    console.log(`ok    ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error?.stack ?? error}`)
  }
}

const ZONE = 'Asia/Shanghai'
const HOUR = 60 * 60 * 1000

/**
 * One stored item.
 *
 * @param overrides - fields to set on the base item.
 * @returns the item.
 */
function item(overrides = {}) {
  return {
    id: `todo-00000000-0000-0000-0000-00000000000${overrides.suffix ?? 1}`,
    status: 'open',
    title: 'item',
    note: null,
    dueAt: null,
    dueDate: null,
    timeZone: null,
    recurrence: null,
    recurrenceDoneThrough: null,
    exdates: [],
    remindBeforeMin: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    completedAt: null,
    lastWriter: 'user',
    ...overrides,
  }
}

/** The window every check uses unless it says otherwise. */
const WINDOW = { from: parseInstant('2026-11-01T16:00:00Z'), to: parseInstant('2026-11-08T16:00:00Z') }

check('an occurrence id is the item id plus its start instant', () => {
  const millis = parseInstant('2026-11-02T01:00:00Z')
  assert.equal(occurrenceIdOf('todo-x', millis), 'todo-x@2026-11-02T01:00:00Z')
})

check('a dated item appears once inside its window', () => {
  const agenda = buildAgenda([item({ dueAt: '2026-11-02T01:00:00Z' })], { ...WINDOW, timeZone: ZONE })
  assert.equal(agenda.length, 1)
  assert.equal(agenda[0].startAt, '2026-11-02T01:00:00Z')
  assert.equal(agenda[0].date, '2026-11-02')
  assert.equal(agenda[0].allDay, false)
  assert.equal(agenda[0].status, 'open')
})

check('an undated item never appears on an agenda', () => {
  assert.deepEqual(buildAgenda([item()], { ...WINDOW, timeZone: ZONE }), [])
})

check('an all-day item reports its date and its derived midnight', () => {
  const agenda = buildAgenda([item({ dueDate: '2026-11-03', dueAt: '2026-11-02T16:00:00Z' })], { ...WINDOW, timeZone: ZONE })
  assert.equal(agenda[0].allDay, true)
  assert.equal(agenda[0].date, '2026-11-03')
  assert.equal(agenda[0].startAt, '2026-11-02T16:00:00Z')
})

check('a done item is hidden unless the caller asks for done work', () => {
  const done = item({ dueAt: '2026-11-02T01:00:00Z', status: 'done', completedAt: '2026-11-02T02:00:00Z' })
  assert.equal(buildAgenda([done], { ...WINDOW, timeZone: ZONE }).length, 0)
  assert.equal(buildAgenda([done], { ...WINDOW, timeZone: ZONE, includeDone: true }).length, 1)
})

check('a repeated item expands, and its watermarked occurrences are done', () => {
  const repeated = item({
    dueAt: '2026-11-02T01:00:00Z',
    recurrence: normalizeRecurrence({ freq: 'daily' }),
    recurrenceDoneThrough: '2026-11-03T01:00:00Z',
  })
  const open = buildAgenda([repeated], { ...WINDOW, timeZone: ZONE })
  assert.deepEqual(open.map(entry => entry.date), ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
  const all = buildAgenda([repeated], { ...WINDOW, timeZone: ZONE, includeDone: true })
  assert.deepEqual(all.map(entry => entry.status), ['done', 'done', 'open', 'open', 'open', 'open', 'open'])
})

check('an occurrence exactly at the watermark counts as done', () => {
  const repeated = item({
    dueAt: '2026-11-02T01:00:00Z',
    recurrence: normalizeRecurrence({ freq: 'daily' }),
    recurrenceDoneThrough: '2026-11-02T01:00:00Z',
  })
  assert.equal(isOccurrenceDone(repeated, parseInstant('2026-11-02T01:00:00Z')), true)
  assert.equal(isOccurrenceDone(repeated, parseInstant('2026-11-03T01:00:00Z')), false)
})

check('a closed series hides every occurrence', () => {
  const closed = item({
    dueAt: '2026-11-02T01:00:00Z',
    status: 'done',
    recurrence: normalizeRecurrence({ freq: 'daily' }),
  })
  assert.deepEqual(buildAgenda([closed], { ...WINDOW, timeZone: ZONE }), [])
})

check('the agenda is ordered by start, then by item', () => {
  const agenda = buildAgenda([
    item({ suffix: 2, dueAt: '2026-11-02T02:00:00Z' }),
    item({ suffix: 1, dueAt: '2026-11-02T01:00:00Z' }),
  ], { ...WINDOW, timeZone: ZONE })
  assert.deepEqual(agenda.map(entry => entry.startAt), ['2026-11-02T01:00:00Z', '2026-11-02T02:00:00Z'])
})

check('the agenda honours its limit', () => {
  const many = [item({ suffix: 1, dueAt: '2026-11-02T01:00:00Z' }), item({ suffix: 2, dueAt: '2026-11-03T01:00:00Z' })]
  assert.equal(buildAgenda(many, { ...WINDOW, timeZone: ZONE, limit: 1 }).length, 1)
})

check('next reports the next uncompleted occurrence, not the last completed one', () => {
  const repeated = item({
    dueAt: '2026-11-02T01:00:00Z',
    recurrence: normalizeRecurrence({ freq: 'daily' }),
    recurrenceDoneThrough: '2026-11-03T01:00:00Z',
  })
  const next = nextOf(repeated, { after: parseInstant('2026-11-02T12:00:00Z'), timeZone: ZONE })
  assert.equal(next.startAt, '2026-11-04T01:00:00Z')
})

check('next is null for a done one-off and for a moment after it', () => {
  const done = item({ dueAt: '2026-11-02T01:00:00Z', status: 'done' })
  assert.equal(nextOf(done, { after: parseInstant('2026-11-01T00:00:00Z'), timeZone: ZONE }), null)
  const past = item({ dueAt: '2026-11-02T01:00:00Z' })
  assert.equal(nextOf(past, { after: parseInstant('2026-11-03T00:00:00Z'), timeZone: ZONE }), null)
  assert.equal(nextOf(past, { after: parseInstant('2026-11-01T00:00:00Z'), timeZone: ZONE }).startAt, '2026-11-02T01:00:00Z')
})

check('a window endpoint is a local midnight when written as a date', () => {
  assert.equal(formatInstant(parseWindowPoint('2026-11-02', ZONE)), '2026-11-01T16:00:00Z')
  assert.equal(formatInstant(parseWindowPoint('2026-11-02T01:00:00Z', ZONE)), '2026-11-02T01:00:00Z')
  assert.ok(Number.isNaN(parseWindowPoint('next tuesday', ZONE)))
})

check('a missing window defaults to today plus seven days', () => {
  const now = parseInstant('2026-11-02T03:00:00Z')
  const { from, to } = resolveWindow({}, { now, timeZone: ZONE, maxSpanDays: 366 })
  assert.equal(formatInstant(from), '2026-11-01T16:00:00Z')
  assert.equal(to - from, 7 * 24 * HOUR)
})

check('a window that ends before it starts is refused', () => {
  assert.throws(
    () => resolveWindow({ from: '2026-11-05', to: '2026-11-01' }, { now: Date.now(), timeZone: ZONE, maxSpanDays: 366 }),
    (error) => error instanceof AgendaError && error.code === 'invalid_window',
  )
})

check('a window longer than the configured span is refused with its own code', () => {
  assert.throws(
    () => resolveWindow({ from: '2026-01-01', to: '2026-12-31' }, { now: Date.now(), timeZone: ZONE, maxSpanDays: 30 }),
    (error) => error instanceof AgendaError && error.code === 'window_too_large',
  )
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

/**
 * Checks for repeat rules: the subset this bundle accepts, and the expansion that
 * turns one item into occurrences.
 *
 * Every window is stated in UTC instants so a reader can check the expected dates
 * without converting anything: the fixture zone is Asia/Shanghai (UTC+8), where
 * 09:00 local is 01:00Z.
 */
import assert from 'node:assert/strict'
import {
  MAX_COUNT,
  RecurrenceError,
  describeRule,
  expandOccurrences,
  normalizeRecurrence,
} from '../src/recurrence.js'
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

/** The fixture zone: no daylight saving, so a repeat never drifts. */
const ZONE = 'Asia/Shanghai'

/**
 * One stored item with a repeat rule.
 *
 * @param dueAt - the first occurrence, as a UTC instant.
 * @param rule - the rule fields to normalize.
 * @param extra - further item fields.
 * @returns the item-shaped value the expansion reads.
 */
function series(dueAt, rule, extra = {}) {
  return {
    id: 'todo-00000000-0000-0000-0000-000000000000',
    status: 'open',
    title: 'series',
    note: null,
    dueAt,
    dueDate: null,
    timeZone: ZONE,
    recurrence: normalizeRecurrence(rule),
    recurrenceDoneThrough: null,
    exdates: [],
    remindBeforeMin: [],
    createdAt: dueAt,
    updatedAt: dueAt,
    completedAt: null,
    lastWriter: 'user',
    ...extra,
  }
}

/**
 * Expand one item over a window written as instants.
 *
 * @param item - the item.
 * @param from - inclusive start instant.
 * @param to - exclusive end instant.
 * @returns the occurrence starts as instants.
 */
function expand(item, from, to) {
  return expandOccurrences(item, { from: parseInstant(from), to: parseInstant(to), timeZone: ZONE })
    .map(entry => formatInstant(entry.millis))
}

check('a normal rule fills its defaults and survives normalization twice', () => {
  const once = normalizeRecurrence({ freq: 'weekly' })
  assert.deepEqual(once, { freq: 'weekly', interval: 1, byWeekday: [], count: null, until: null, dtstart: null })
  assert.deepEqual(normalizeRecurrence(once), once)
  assert.equal(normalizeRecurrence(null), null)
  assert.equal(normalizeRecurrence(undefined), null)
})

check('a rule outside the subset is refused by name, not repaired', () => {
  assert.throws(() => normalizeRecurrence({ freq: 'hourly' }), (error) => error instanceof RecurrenceError && error.code === 'invalid_recurrence')
  assert.throws(() => normalizeRecurrence({ freq: 'daily', interval: 0 }), /interval/)
  assert.throws(() => normalizeRecurrence({ freq: 'daily', byWeekday: [1] }), (error) => error.code === 'unsupported_rule')
  assert.throws(() => normalizeRecurrence({ freq: 'weekly', byWeekday: [8] }), /byWeekday/)
  assert.throws(() => normalizeRecurrence({ freq: 'weekly', every: 2 }), /not a supported field/)
  assert.throws(() => normalizeRecurrence({ freq: 'daily', count: MAX_COUNT + 1 }), /count/)
})

check('daily with an interval steps by whole days', () => {
  const item = series('2026-11-02T01:00:00Z', { freq: 'daily', interval: 2 })
  assert.deepEqual(
    expand(item, '2026-11-01T00:00:00Z', '2026-11-11T00:00:00Z'),
    ['2026-11-02T01:00:00Z', '2026-11-04T01:00:00Z', '2026-11-06T01:00:00Z', '2026-11-08T01:00:00Z', '2026-11-10T01:00:00Z'],
  )
})

check('weekly repeats on the named weekdays, ascending inside each week', () => {
  const item = series('2026-11-02T01:00:00Z', { freq: 'weekly', byWeekday: [5, 1, 3] })
  assert.deepEqual(
    expand(item, '2026-11-01T00:00:00Z', '2026-11-15T00:00:00Z'),
    ['2026-11-02T01:00:00Z', '2026-11-04T01:00:00Z', '2026-11-06T01:00:00Z', '2026-11-09T01:00:00Z', '2026-11-11T01:00:00Z', '2026-11-13T01:00:00Z'],
  )
})

check('weekly without weekdays repeats on the start date\'s own weekday', () => {
  const item = series('2026-11-02T01:00:00Z', { freq: 'weekly' })
  assert.deepEqual(
    expand(item, '2026-11-01T00:00:00Z', '2026-11-17T00:00:00Z'),
    ['2026-11-02T01:00:00Z', '2026-11-09T01:00:00Z', '2026-11-16T01:00:00Z'],
  )
})

check('monthly on the 31st skips months that have no 31st', () => {
  const item = series('2026-01-31T01:00:00Z', { freq: 'monthly' })
  assert.deepEqual(
    expand(item, '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z'),
    ['2026-01-31T01:00:00Z', '2026-03-31T01:00:00Z'],
  )
})

check('yearly on 29 February skips non-leap years', () => {
  const item = series('2028-02-29T01:00:00Z', { freq: 'yearly' })
  assert.deepEqual(
    expand(item, '2028-01-01T00:00:00Z', '2033-01-01T00:00:00Z'),
    ['2028-02-29T01:00:00Z', '2032-02-29T01:00:00Z'],
  )
})

check('count limits the series and stops the window early', () => {
  const item = series('2026-11-02T01:00:00Z', { freq: 'daily', count: 3 })
  assert.deepEqual(
    expand(item, '2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'),
    ['2026-11-02T01:00:00Z', '2026-11-03T01:00:00Z', '2026-11-04T01:00:00Z'],
  )
})

check('count is applied from the series start even when the window starts later', () => {
  const item = series('2026-11-02T01:00:00Z', { freq: 'daily', count: 5 })
  assert.deepEqual(
    expand(item, '2026-11-04T00:00:00Z', '2026-11-30T00:00:00Z'),
    ['2026-11-04T01:00:00Z', '2026-11-05T01:00:00Z', '2026-11-06T01:00:00Z'],
  )
})

check('until is inclusive of the instant it names', () => {
  const item = series('2026-11-02T01:00:00Z', { freq: 'daily', until: '2026-11-04T01:00:00Z' })
  assert.deepEqual(
    expand(item, '2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'),
    ['2026-11-02T01:00:00Z', '2026-11-03T01:00:00Z', '2026-11-04T01:00:00Z'],
  )
})

check('an excluded occurrence is skipped without shifting the others', () => {
  const item = series('2026-11-02T01:00:00Z', { freq: 'daily', count: 3 }, { exdates: ['2026-11-03T01:00:00Z'] })
  assert.deepEqual(
    expand(item, '2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'),
    ['2026-11-02T01:00:00Z', '2026-11-04T01:00:00Z'],
  )
})

check('a window far from the series start is reached without walking every period', () => {
  const item = series('2015-01-01T01:00:00Z', { freq: 'daily' })
  const found = expand(item, '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z')
  assert.deepEqual(found, ['2026-11-01T01:00:00Z', '2026-11-02T01:00:00Z'])
})

check('an all-day series keeps calendar dates rather than instants', () => {
  const item = series('2026-11-02T16:00:00Z', { freq: 'daily' }, { dueDate: '2026-11-02' })
  // The window is written in the zone's own midnights: local 00:00 on 2 November
  // is 16:00Z on 1 November, and the exclusive end is midnight on the 5th.
  const found = expandOccurrences(item, {
    from: parseInstant('2026-11-01T16:00:00Z'),
    to: parseInstant('2026-11-04T16:00:00Z'),
    timeZone: ZONE,
  })
  assert.deepEqual(found.map(entry => entry.date), ['2026-11-02', '2026-11-03', '2026-11-04'])
  assert.equal(found.every(entry => entry.allDay), true)
})

check('dtstart overrides where the series begins', () => {
  const item = series('2026-11-02T01:00:00Z', { freq: 'weekly', dtstart: '2026-11-09T01:00:00Z' })
  assert.deepEqual(
    expand(item, '2026-11-01T00:00:00Z', '2026-11-20T00:00:00Z'),
    ['2026-11-09T01:00:00Z', '2026-11-16T01:00:00Z'],
  )
})

check('a rule with no anchor produces nothing instead of throwing', () => {
  const item = series(null, { freq: 'daily' })
  assert.deepEqual(expand(item, '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z'), [])
})

check('the description names the shape a reader needs', () => {
  assert.equal(describeRule(normalizeRecurrence({ freq: 'weekly', byWeekday: [1, 3, 5] })), 'every week on Mon, Wed, Fri')
  assert.equal(describeRule(normalizeRecurrence({ freq: 'daily', interval: 2 })), 'every 2 days')
  assert.equal(describeRule(normalizeRecurrence({ freq: 'monthly' })), 'every month')
  assert.equal(describeRule(normalizeRecurrence({ freq: 'yearly', interval: 3 })), 'every 3 years')
  assert.equal(describeRule(null), 'does not repeat')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

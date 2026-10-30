/**
 * Checks for the wall-clock layer: the conversions every date, repeat rule, and
 * reminder is built on, including the two daylight-saving edges a naive
 * implementation gets wrong.
 *
 * The zone fixtures are fixed by name so the checks do not depend on where this
 * machine happens to be: Asia/Shanghai has no DST, America/New_York does.
 */
import assert from 'node:assert/strict'
import {
  addLocalDays,
  daysBetween,
  daysInMonth,
  formatInstant,
  instantFromParts,
  instantOfLocalMidnight,
  isTimeZone,
  localClockOf,
  localDateOf,
  offsetMinutes,
  parseInstant,
  parseLocal,
  startOfWeek,
  systemTimeZone,
  weekdayOf,
  zonedParts,
} from '../src/zone.js'

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

check('a local wall-clock reading converts to the instant it names', () => {
  const millis = instantFromParts({ year: 2026, month: 11, day: 2, hour: 15, minute: 0 }, 'Asia/Shanghai')
  assert.equal(formatInstant(millis), '2026-11-02T07:00:00Z')
  assert.equal(localClockOf(millis, 'Asia/Shanghai'), '15:00')
  assert.equal(localDateOf(millis, 'Asia/Shanghai'), '2026-11-02')
})

check('local midnight is the start of that calendar day, not the previous one', () => {
  const millis = instantOfLocalMidnight('2026-11-03', 'Asia/Shanghai')
  assert.equal(formatInstant(millis), '2026-11-02T16:00:00Z')
  assert.equal(localDateOf(millis, 'Asia/Shanghai'), '2026-11-03')
})

check('a daylight-saving gap shifts the reading forward instead of losing it', () => {
  // 2026-03-08 in New York has no 02:30; the clock jumps 02:00 EST to 03:00 EDT.
  const millis = instantFromParts({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')
  assert.equal(formatInstant(millis), '2026-03-08T07:30:00Z')
  assert.equal(localClockOf(millis, 'America/New_York'), '03:30')
})

check('an ambiguous autumn hour resolves to the earlier instant', () => {
  // 2026-11-01 01:30 happens twice in New York: 05:30Z as EDT, 06:30Z as EST.
  const millis = instantFromParts({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York')
  assert.equal(formatInstant(millis), '2026-11-01T05:30:00Z')
  assert.equal(localClockOf(millis, 'America/New_York'), '01:30')
})

check('the offset reports what the zone was doing at that instant', () => {
  assert.equal(offsetMinutes(Date.parse('2026-11-02T07:00:00Z'), 'Asia/Shanghai'), 480)
  assert.equal(offsetMinutes(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York'), -300)
  assert.equal(offsetMinutes(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York'), -240)
})

check('a repeated midnight still lands on the right date', () => {
  const parts = zonedParts(instantOfLocalMidnight('2026-11-02', 'Asia/Shanghai'), 'Asia/Shanghai')
  assert.deepEqual({ year: parts.year, month: parts.month, day: parts.day, hour: parts.hour }, { year: 2026, month: 11, day: 2, hour: 0 })
})

check('only names the runtime knows are accepted as zones', () => {
  assert.equal(isTimeZone('Asia/Shanghai'), true)
  assert.equal(isTimeZone('Mars/Olympus'), false)
  assert.equal(isTimeZone(''), false)
  assert.equal(isTimeZone(null), false)
  assert.equal(typeof systemTimeZone(), 'string')
})

check('calendar arithmetic ignores zones and crosses month and year ends', () => {
  assert.equal(addLocalDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addLocalDays('2026-03-01', -1), '2026-02-28')
  assert.equal(daysBetween('2026-11-01', '2026-11-10'), 9)
  assert.equal(daysBetween('2026-11-10', '2026-11-01'), -9)
  assert.equal(weekdayOf('2026-11-02'), 1)
  assert.equal(weekdayOf('2026-11-08'), 7)
  assert.equal(startOfWeek('2026-11-06'), '2026-11-02')
  assert.equal(daysInMonth(2026, 2), 28)
  assert.equal(daysInMonth(2028, 2), 29)
})

check('the stored instant forms round-trip and reject everything else', () => {
  assert.equal(parseInstant('2026-11-02T07:00:00Z'), Date.parse('2026-11-02T07:00:00Z'))
  assert.ok(Number.isNaN(parseInstant('2026-11-02')))
  assert.ok(Number.isNaN(parseInstant('2026-11-02T07:00:00')))
  assert.deepEqual(parseLocal('2026-11-02T15:00'), { date: '2026-11-02', hour: 15, minute: 0 })
  assert.equal(parseLocal('2026-11-02T24:00'), null)
  assert.equal(parseLocal('2026-11-02'), null)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

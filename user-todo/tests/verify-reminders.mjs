/**
 * Checks for the reminder loop: what fires, what is recorded, what is retried,
 * and what is deliberately dropped.
 *
 * The clock is injected, so every case is a fixed instant rather than a wait.
 * The delivery port is a stub that keeps the messages it was handed, which is
 * how the checks see the batch a tick would have pushed.
 */
import assert from 'node:assert/strict'
import { openTodoStore } from '../src/open.js'
import {
  ReminderScheduler,
  buildDigestMessage,
  buildReminderMessage,
  inQuietHours,
} from '../src/reminders.js'
import { fakeStorageDomain } from './harness.js'

const failures = []
let passed = 0

/**
 * Run one check, recording its outcome.
 * @param name - what the check pins.
 * @param work - the check body.
 */
async function check(name, work) {
  try {
    await work()
    passed += 1
    console.log(`ok    ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error?.stack ?? error}`)
  }
}

const ZONE = 'Asia/Shanghai'
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

/** The bounds the plugin normally passes. */
const BOUNDS = { maxTitleChars: 200, maxNoteChars: 2000 }

/**
 * One open store over an in-memory medium.
 *
 * @returns the store.
 */
async function openStore() {
  const facility = fakeStorageDomain()
  return openTodoStore(facility, { bounds: BOUNDS, maxItems: 100, timeZone: ZONE })
}

/**
 * A config block with the fields the loop reads.
 *
 * @param overrides - fields to change.
 * @returns the config.
 */
function config(overrides = {}) {
  return {
    remindCatchUpHours: 24,
    maxPushesPerHour: 6,
    schedulerMaxSleepMs: 60_000,
    agendaMaxOccurrences: 400,
    ...overrides,
  }
}

/**
 * One scheduler over a store, with a controllable clock and a recording port.
 *
 * @param store - the open store.
 * @param options - the initial clock, the port result, and config overrides.
 * @returns the scheduler, the messages it sent, and a way to move the clock.
 */
function schedulerFor(store, options = {}) {
  let clock = options.clock ?? Date.parse('2026-11-02T00:00:00Z')
  const sent = []
  const port = options.port ?? (() => ({
    send: async (message) => {
      sent.push(message)
      return { ok: true, delivered: 1, total: 1 }
    },
  }))
  const scheduler = new ReminderScheduler({
    store,
    config: config(options.config),
    port,
    logger: { warn() {} },
    now: () => clock,
  })
  return {
    scheduler,
    sent,
    at: (value) => { clock = typeof value === 'number' ? value : Date.parse(value) },
    clock: () => clock,
  }
}

await check('one due reminder is pushed once and recorded', async () => {
  const store = await openStore()
  await store.create([{ title: '交周报', due: { dueAt: '2026-11-02T09:00' }, remindBeforeMin: [15] }], 'user')
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T00:50:00Z')
  const outcome = await scheduler.tick()
  assert.equal(outcome.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, '待办提醒')
  assert.match(sent[0].content, /交周报/)
  const ledger = store.notifications()
  assert.equal(ledger.length, 1)
  assert.match(ledger[0].key, /^todo-.*#15$/)
  assert.equal(ledger[0].status, 'sent')
  store.close()
})

await check('a second tick in the same minute sends nothing', async () => {
  const store = await openStore()
  await store.create([{ title: '交周报', due: { dueAt: '2026-11-02T09:00' }, remindBeforeMin: [15] }], 'user')
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T00:50:00Z')
  await scheduler.tick()
  await scheduler.tick()
  assert.equal(sent.length, 1)
  store.close()
})

await check('two reminders due together become one message', async () => {
  const store = await openStore()
  await store.create([
    { title: 'A', due: { dueAt: '2026-11-02T01:00:00Z' }, remindBeforeMin: [0] },
    { title: 'B', due: { dueAt: '2026-11-02T01:05:00Z' }, remindBeforeMin: [0] },
  ], 'user')
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T01:06:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, '待办提醒（2 项）')
  assert.match(sent[0].content, /A/)
  assert.match(sent[0].content, /B/)
  store.close()
})

await check('a reminder missed while the process was down is delivered on the first tick', async () => {
  const store = await openStore()
  await store.create([{ title: '早会', due: { dueAt: '2026-11-02T01:00:00Z' }, remindBeforeMin: [0] }], 'user')
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T03:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].content, /已到期/)
  store.close()
})

await check('a reminder older than the catch-up window is dropped', async () => {
  const store = await openStore()
  await store.create([{ title: '昨天的会', due: { dueAt: '2026-11-01T01:00:00Z' }, remindBeforeMin: [0] }], 'user')
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T03:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 0)
  store.close()
})

await check('an item with no reminder offsets follows the preference default', async () => {
  const store = await openStore()
  await store.create([{ title: '默认提醒', due: { dueAt: '2026-11-02T01:00:00Z' } }], 'user')
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T01:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].content, /默认提醒/)
  store.close()
})

await check('the reminders switch turns the whole loop off', async () => {
  const store = await openStore()
  await store.create([{ title: '关掉了', due: { dueAt: '2026-11-02T01:00:00Z' }, remindBeforeMin: [0] }], 'user')
  await store.setPrefs({ pushReminders: false })
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T01:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 0)
  store.close()
})

await check('quiet hours hold the reminder until the window ends', async () => {
  const store = await openStore()
  await store.create([{ title: '夜里的事', due: { dueAt: '2026-11-02T23:30' }, remindBeforeMin: [0] }], 'user')
  await store.setPrefs({ quietHours: { start: '22:00', end: '08:00' } })
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T15:30:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 0)
  assert.equal(inQuietHours(store.prefs(), Date.parse('2026-11-02T15:30:00Z'), ZONE), true)
  at('2026-11-03T00:05:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 1)
  store.close()
})

await check('a failed delivery is retried once and then settles', async () => {
  const store = await openStore()
  await store.create([{ title: '会失败', due: { dueAt: '2026-11-02T01:00:00Z' }, remindBeforeMin: [0] }], 'user')
  let attempts = 0
  const { scheduler, at } = schedulerFor(store, {
    port: () => ({ send: async () => { attempts += 1; return { ok: false, code: 'failed', delivered: 0, total: 1 } } }),
  })
  at('2026-11-02T01:00:00Z')
  await scheduler.tick()
  assert.equal(attempts, 1)
  assert.equal(store.notifications().at(-1).status, 'failed')
  await scheduler.tick()
  assert.equal(attempts, 1)
  at('2026-11-02T01:06:00Z')
  await scheduler.tick()
  assert.equal(attempts, 2)
  at('2026-11-02T01:20:00Z')
  await scheduler.tick()
  assert.equal(attempts, 2)
  store.close()
})

await check('a missing target is not recorded, so configuring one later can still deliver', async () => {
  const store = await openStore()
  await store.create([{ title: '还没配置', due: { dueAt: '2026-11-02T01:00:00Z' }, remindBeforeMin: [0] }], 'user')
  const { scheduler, at } = schedulerFor(store, {
    port: () => ({ send: async () => ({ ok: false, code: 'not_configured', delivered: 0, total: 0 }) }),
  })
  at('2026-11-02T01:00:00Z')
  await scheduler.tick()
  assert.equal(store.notifications().length, 0)
  store.close()
})

await check('a profile without the notification bundle records the reminder instead of failing', async () => {
  const store = await openStore()
  await store.create([{ title: '没有通知', due: { dueAt: '2026-11-02T01:00:00Z' }, remindBeforeMin: [0] }], 'user')
  const { scheduler, at } = schedulerFor(store, { port: () => undefined })
  at('2026-11-02T01:00:00Z')
  const outcome = await scheduler.tick()
  assert.equal(outcome.code, 'notify_absent')
  assert.equal(store.notifications()[0].status, 'sent')
  store.close()
})

await check('the hourly limit defers the next reminder instead of dropping it', async () => {
  const store = await openStore()
  await store.create([
    { title: 'A', due: { dueAt: '2026-11-02T01:00:00Z' }, remindBeforeMin: [0] },
    { title: 'B', due: { dueAt: '2026-11-02T01:01:00Z' }, remindBeforeMin: [0] },
  ], 'user')
  const { scheduler, sent, at } = schedulerFor(store, { config: { maxPushesPerHour: 1 } })
  at('2026-11-02T01:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 1)
  at('2026-11-02T01:01:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 1, 'the second reminder waits for the hour to pass')
  at('2026-11-02T02:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 2)
  store.close()
})

await check('a digest is sent once for the day and never twice', async () => {
  const store = await openStore()
  await store.create([{ title: '今天的活', due: { dueAt: '2026-11-02T15:00' } }], 'user')
  await store.setPrefs({ digestAt: '08:30' })
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T00:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 0, 'before the digest time nothing is sent')
  at('2026-11-02T00:31:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /今天的安排/)
  assert.match(sent[0].content, /今天的活/)
  await scheduler.tick()
  assert.equal(sent.length, 1)
  assert.equal(store.notifications().some(entry => entry.key.startsWith('digest:')), true)
  store.close()
})

await check('an all-day item reminds at the configured clock time', async () => {
  const store = await openStore()
  await store.create([{ title: '体检', due: { dueAt: '2026-11-02' }, remindBeforeMin: [0] }], 'user')
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T00:59:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 0)
  at('2026-11-02T01:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0].content, /体检/)
  store.close()
})

await check('a completed occurrence is not reminded', async () => {
  const store = await openStore()
  const created = await store.create([{ title: '做完的', due: { dueAt: '2026-11-02T01:00:00Z' }, remindBeforeMin: [0] }], 'user')
  await store.completeOccurrence(created.added[0].id, `${created.added[0].id}@2026-11-02T01:00:00Z`, 'user')
  const { scheduler, sent, at } = schedulerFor(store)
  at('2026-11-02T01:00:00Z')
  await scheduler.tick()
  assert.equal(sent.length, 0)
  store.close()
})

await check('the messages a reader receives name the item and the moment', () => {
  const now = Date.parse('2026-11-02T01:00:00Z')
  const message = buildReminderMessage([
    { key: 'a#0', at: now, startMillis: now, allDay: false, date: '2026-11-02', title: '交周报' },
  ], ZONE, now)
  assert.equal(message.title, '待办提醒')
  assert.equal(message.content, '- 09:00 交周报')
  const digest = buildDigestMessage([
    { startAt: '2026-11-02T01:00:00Z', allDay: false, title: '交周报' },
    { startAt: '2026-11-02T16:00:00Z', allDay: true, title: '体检' },
  ], ZONE, '2026-11-02')
  assert.equal(digest.content, '- 09:00 交周报\n- 全天 体检')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

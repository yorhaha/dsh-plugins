/**
 * Checks for the composition this bundle declares: the row's config block, the
 * failure paths of mounting it, and the surfaces it registers.
 *
 * Everything here is reachable through the plugin's exported `apply` with the
 * stub context from the shared harness, so it runs without the Loader.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, resolveConfig } from '../index.js'
import { DEFAULT_CONFIG, fakeConnection, fakeContext, fakeStorageDomain, mount } from './harness.js'

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

const root = new URL('..', import.meta.url)

await check('the manifest exports the patch, both halves, the locale files, and the icon', async () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.name, 'dsh-user-todo')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.exports['./client'])
  assert.ok(manifest.exports['./locale/*.json'])
  assert.ok(manifest.exports['./icon'])
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'locale/*.json', 'icon.svg']) {
    assert.ok(manifest.files.includes(file), `files must keep ${file}`)
  }
})

await check('the patch states every config key resolveConfig accepts, at this plugin\'s defaults', async () => {
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
  assert.match(patch, /- id: user-todo\n\s+name: 'dsh-user-todo'/)
  const resolved = resolveConfig(structuredClone(DEFAULT_CONFIG))
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'toolNames') continue
    // The checks pin a zone so a local-time expectation has one answer on every
    // machine; the row itself states the portable default, which is this
    // machine's zone.
    if (key === 'timeZone') {
      assert.match(patch, /timeZone: null/, 'the patch should leave the zone to the deployment')
      continue
    }
    assert.ok(patch.includes(`${key}: ${value}`), `the patch should name ${key}: ${value}`)
  }
  for (const [role, name] of Object.entries(resolved.toolNames)) {
    assert.ok(patch.includes(`${role}: ${name}`), `the patch should name the ${role} tool ${name}`)
  }
})

await check('a row without a config fails the mount instead of guessing', async () => {
  assert.throws(() => resolveConfig(undefined), /states no config/)
})

await check('a malformed config fails with the field it names', async () => {
  const cases = [
    [{ toolNames: null }, /toolNames/],
    [{ toolNames: { list: 'Bad Name', create: 'b', update: 'c' } }, /toolNames\.list/],
    [{ toolNames: { list: 'a', create: 'a', update: 'c' } }, /must differ/],
    [{ maxTitleChars: 0 }, /maxTitleChars/],
    [{ maxCreateBatch: 2.5 }, /maxCreateBatch/],
    [{ allowSubagentWrites: 'yes' }, /allowSubagentWrites/],
  ]
  for (const [patch, pattern] of cases) {
    assert.throws(() => resolveConfig({ ...DEFAULT_CONFIG, ...patch }), pattern)
  }
})

/** The named work around one mount: what it logs, and what it settles with. */
async function attempt(storageDomain, connection, prepare = () => {}) {
  const ctx = fakeContext({ storageDomain, connection })
  prepare(ctx)
  await apply(ctx, DEFAULT_CONFIG)
  const settled = ctx.settled().then(() => null, error => error)
  return { ctx, settled }
}

await check('a storage domain that is already open fails the mount and is reported', async () => {
  const storageDomain = fakeStorageDomain()
  await storageDomain.open({ name: 'user_todo', global: { initial: { items: [], updatedAt: null }, schema: null } })
  const { settled } = await attempt(storageDomain, fakeConnection())
  const error = await settled
  assert.ok(error instanceof Error)
  assert.match(error.message, /already open/)
})

await check('a tool registration that throws releases the domain before the failure escapes', async () => {
  const storageDomain = fakeStorageDomain()
  const { settled } = await attempt(storageDomain, fakeConnection(), (ctx) => {
    ctx.tools.register = () => { throw new Error('simulated registration failure') }
  })
  const error = await settled
  assert.match(String(error?.message), /simulated registration failure/)
  assert.equal(storageDomain.isOpen, false, 'the domain must not stay open after a failed mount')
})

await check('the route disappears with the plugin', async () => {
  const storageDomain = fakeStorageDomain()
  const connection = fakeConnection()
  const { ctx, settled } = await attempt(storageDomain, connection)
  await settled
  assert.ok(connection.routes.has('/api/user-todo'))
  await ctx.dispose()
  assert.equal(connection.routes.size, 0)
  assert.equal(storageDomain.isOpen, false)
})

await check('the row id and package name are the ones the patch and manifest share', async () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
  assert.ok(patch.includes(`name: '${manifest.name}'`))
  assert.equal(parse(fileURLToPath(root)).base, 'user-todo')
})

/**
 * Wait for the reminder loop's first look at the clock.
 *
 * The loop's shortest configurable wait is one second, so a check that wants a
 * tick waits for a little more than that instead of reaching into the scheduler.
 *
 * @param ms - how long to wait.
 * @returns resolution after the wait.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

await check('a due reminder is pushed through the notify service the profile provides', async () => {
  const sent = []
  const notify = {
    async send(message) {
      sent.push(message)
      return { ok: true, delivered: 1, total: 1 }
    },
    async status() {
      return { total: 1, ready: 1 }
    },
  }
  const mounted = await mount({ config: { schedulerMaxSleepMs: 1000 }, services: { notify } })
  try {
    const due = new Date(Date.now() + 30_000)
    const dueAt = `${due.toISOString().slice(0, 19)}Z`
    const created = await mounted.tools.get('create_user_todos').execute({
      items: [{ title: '交周报', due_at: dueAt, remind_before_min: 1 }],
    }, {})
    assert.equal(created.ok, true, JSON.stringify(created))
    await sleep(1400)
    assert.equal(sent.length, 1, 'one message covers the pending reminders')
    assert.match(sent[0].content, /交周报/)
    const ledger = mounted.storageDomain.handle.global.get().notifications
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].status, 'sent')
  } finally {
    await mounted.ctx.dispose()
  }
})

await check('without the notify service the reminder is recorded and the gap is logged', async () => {
  const mounted = await mount({ config: { schedulerMaxSleepMs: 1000 } })
  try {
    const due = new Date(Date.now() + 30_000)
    const dueAt = `${due.toISOString().slice(0, 19)}Z`
    await mounted.tools.get('create_user_todos').execute({
      items: [{ title: '没有通知插件', due_at: dueAt, remind_before_min: 1 }],
    }, {})
    await sleep(1400)
    const ledger = mounted.storageDomain.handle.global.get().notifications
    assert.equal(ledger.length, 1, 'the reminder is not left pending forever')
    assert.equal(ledger[0].status, 'sent')
    assert.ok(
      mounted.ctx.warnings.some(line => line.includes('no notification service')),
      `a missing service must be visible in the log: ${JSON.stringify(mounted.ctx.warnings)}`,
    )
  } finally {
    await mounted.ctx.dispose()
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

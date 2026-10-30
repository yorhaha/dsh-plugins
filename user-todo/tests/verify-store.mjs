/**
 * Checks for the durable list: what one accepted mutation does to the document,
 * how two writers interact, and that a reopened medium holds what was written.
 *
 * Every check names the behavior it pins, so a failure reads as a contract
 * change rather than "assertion failed".
 */
import assert from 'node:assert/strict'
import { documentSchema } from '../src/domain.js'
import { TodoError, TodoStore } from '../src/store.js'
import { fakeStorageDomain, mount } from './harness.js'

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

/**
 * Mount a plugin on a fresh document.
 * @returns the mounted plugin.
 */
function freshPlugin() {
  return mount()
}

await check('create adds one item with the writer recorded', async () => {
  const { tools, storageDomain } = await freshPlugin()
  const result = await tools.get('create_user_todos').execute({ items: [{ title: '  Buy milk ' }] }, {})
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  const [item] = result.items
  assert.equal(item.title, 'Buy milk')
  assert.equal(Object.hasOwn(item, 'revision'), false)
  assert.equal(item.status, 'open')
  assert.equal(item.source, 'agent')
  assert.equal(Object.hasOwn(item, 'tags'), false, 'the list no longer carries labels')
  assert.equal(item.due_at, null)
  assert.match(item.id, /^todo-[0-9a-f-]{36}$/)
  const stored = documentSchema.parse(storageDomain.document)
  assert.equal(stored.items.length, 1)
  assert.notEqual(stored.updatedAt, null)
})

await check('create accepts the snake_case and camelCase spellings of a field', async () => {
  const { tools } = await freshPlugin()
  const result = await tools.get('create_user_todos').execute({
    items: [
      { title: 'A', due_at: '2026-10-27T09:00:00Z', note: '  call first ' },
      { title: 'B', dueAt: '2026-10-28T09:00:00Z' },
    ],
  }, {})
  assert.equal(result.ok, true)
  assert.equal(result.items[0].due_at, '2026-10-27T09:00:00Z')
  assert.equal(result.items[0].note, 'call first')
  assert.equal(result.items[1].due_at, '2026-10-28T09:00:00Z')
})

await check('create skips an open title it already holds, so a retried batch never duplicates', async () => {
  const { tools } = await freshPlugin()
  const create = tools.get('create_user_todos')
  await create.execute({ items: [{ title: 'Ship release' }] }, {})
  const again = await create.execute({ items: [{ title: 'Ship release' }, { title: 'Book room' }] }, {})
  assert.equal(again.ok, true)
  assert.equal(again.count, 1)
  assert.deepEqual(again.skipped, [{ title: 'Ship release', reason: 'duplicate' }])
})

await check('a done item no longer blocks its title, so the task can be added again', async () => {
  const { tools } = await freshPlugin()
  const create = tools.get('create_user_todos')
  const first = await create.execute({ items: [{ title: 'Pay invoice' }] }, {})
  const update = tools.get('update_user_todos')
  await update.execute({ changes: [{ id: first.items[0].id, status: 'done' }] }, {})
  const again = await create.execute({ items: [{ title: 'Pay invoice' }] }, {})
  assert.equal(again.count, 1)
})

await check('the list cap answers list_full instead of throwing the batch away', async () => {
  const { tools } = await mount({ config: { maxItems: 2 } })
  const first = await tools.get('create_user_todos').execute({ items: [{ title: 'one' }, { title: 'two' }] }, {})
  assert.equal(first.count, 2)
  const second = await tools.get('create_user_todos').execute({ items: [{ title: 'three' }] }, {})
  assert.equal(second.ok, true)
  assert.equal(second.count, 0)
  assert.deepEqual(second.skipped, [{ title: 'three', reason: 'list_full' }])
})

await check('an update changes the named fields', async () => {
  const { tools } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({ items: [{ title: 'Draft' }] }, {})
  const id = created.items[0].id
  const updated = await tools.get('update_user_todos').execute({
    changes: [{ id, status: 'done', title: 'Draft v2', due_at: '2026-11-01T00:00:00Z', note: 'n' }],
  }, {})
  assert.equal(updated.ok, true)
  const [item] = updated.items
  assert.equal(item.status, 'done')
  assert.equal(item.title, 'Draft v2')
  assert.equal(item.source, 'agent')
  assert.notEqual(item.completed_at, null)
  assert.deepEqual(updated.results, [{ id, code: 'changed', current: item }])
})

await check('reopening a done item clears completed_at', async () => {
  const { tools } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({ items: [{ title: 'Cycle' }] }, {})
  const id = created.items[0].id
  const update = tools.get('update_user_todos')
  await update.execute({ changes: [{ id, status: 'done' }] }, {})
  const reopened = await update.execute({ changes: [{ id, status: 'open' }] }, {})
  assert.equal(reopened.items[0].status, 'open')
  assert.equal(reopened.items[0].completed_at, null)
})

await check('a later update overwrites an earlier one, with no revision to refuse it', async () => {
  const { tools } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({ items: [{ title: 'Race' }] }, {})
  const id = created.items[0].id
  const update = tools.get('update_user_todos')
  await update.execute({ changes: [{ id, title: 'First writer' }] }, {})
  const second = await update.execute({ changes: [{ id, title: 'Second writer' }] }, {})
  assert.equal(second.ok, true)
  assert.equal(second.count, 1)
  assert.equal(second.results[0].code, 'changed')
  assert.equal(second.items[0].title, 'Second writer')
})

await check('the panel and the agent share one list and the last write wins', async () => {
  const { tools, connection } = await freshPlugin()
  const created = await connection.request('/api/user-todo', { method: 'POST', body: { action: 'create', items: [{ title: 'Shared' }] } })
  const id = (await created.json()).value.state.items[0].id
  await tools.get('update_user_todos').execute({ changes: [{ id, title: 'Renamed by the agent' }] }, {})
  const toggled = await tools.get('update_user_todos').execute({ changes: [{ id, status: 'done' }] }, {})
  assert.equal(toggled.results[0].code, 'changed')
  assert.equal(toggled.items[0].status, 'done')
  assert.equal(toggled.items[0].title, 'Renamed by the agent')
})

await check('an update naming no new value answers unchanged and writes nothing', async () => {
  const { tools, storageDomain } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({ items: [{ title: 'Same' }] }, {})
  const before = JSON.stringify(storageDomain.document)
  const same = await tools.get('update_user_todos').execute({ changes: [{ id: created.items[0].id, title: 'Same' }] }, {})
  assert.equal(same.results[0].code, 'unchanged')
  assert.equal(JSON.stringify(storageDomain.document), before)
})

await check('an unknown id answers not_found and the batch keeps the rest', async () => {
  const { tools } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({ items: [{ title: 'Real' }] }, {})
  const result = await tools.get('update_user_todos').execute({
    changes: [{ id: 'todo-00000000-0000-0000-0000-000000000000', status: 'done' }, { id: created.items[0].id, status: 'done' }],
  }, {})
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.deepEqual(result.results.map(entry => entry.code), ['not_found', 'changed'])
})

await check('a field outside its bound refuses the whole batch before any write', async () => {
  const { tools, storageDomain } = await freshPlugin()
  const before = JSON.stringify(storageDomain.document)
  const result = await tools.get('create_user_todos').execute({
    items: [{ title: 'fine' }, { title: 'x'.repeat(201) }],
  }, {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'invalid_title')
  assert.equal(JSON.stringify(storageDomain.document), before)
})

await check('every closed failure code is reachable', async () => {
  const { connection } = await freshPlugin()
  const post = async body => (await (await connection.request('/api/user-todo', { method: 'POST', body })).json())
  const codes = []
  const cases = [
    [{ action: 'create', items: [{ title: '' }] }, 'invalid_title'],
    [{ action: 'create', items: [{ title: 't', note: 'x'.repeat(2001) }] }, 'invalid_note'],
    [{ action: 'create', items: [{ title: 't', dueAt: 'tomorrow' }] }, 'invalid_due_at'],
    [{ action: 'create', items: [{ title: 't', status: 'doing' }] }, 'invalid_status'],

    [{ action: 'create', items: [] }, 'invalid_body'],
    [{ action: 'create', items: Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` })) }, 'batch_too_large'],
    [{ action: 'update', changes: [{ id: 'todo-00000000-0000-0000-0000-000000000000', patch: { color: 'red' } }] }, 'invalid_key'],
  ]
  for (const [body, expected] of cases) {
    const payload = await post(body)
    codes.push(payload.error?.code)
    assert.equal(payload.error?.code, expected, `${JSON.stringify(body).slice(0, 60)} should be ${expected}`)
  }
  assert.equal(codes.length, cases.length)
})

await check('a reopened medium holds exactly what was written', async () => {
  const storageDomain = fakeStorageDomain()
  const first = await mount({ storageDomain })
  const created = await first.tools.get('create_user_todos').execute({ items: [{ title: 'Survives restart' }] }, {})
  assert.equal(created.ok, true)
  const before = JSON.stringify(storageDomain.document)
  await first.ctx.dispose()
  assert.equal(storageDomain.isOpen, false)
  const second = await mount({ storageDomain })
  const listed = await second.tools.get('list_user_todos').execute({ status: 'all' }, {})
  assert.equal(listed.count, 1)
  assert.equal(listed.items[0].title, 'Survives restart')
  assert.equal(JSON.stringify(storageDomain.document), before)
})

await check('unloading the plugin closes the domain and releases the open name', async () => {
  const storageDomain = fakeStorageDomain()
  const plugin = await mount({ storageDomain })
  await plugin.ctx.dispose()
  assert.equal(storageDomain.isOpen, false)
  const again = await mount({ storageDomain })
  assert.equal(storageDomain.openCount, 2)
  await again.ctx.dispose()
})

await check('a field written under the other spelling is stored, not dropped', async () => {
  const { tools } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({
    items: [{ title: '两种拼写', due_at: '2026-11-02T15:00', repeat: 'daily', remind_before_min: 30 }],
  }, {})
  assert.equal(created.ok, true, JSON.stringify(created))
  const item = created.items[0]
  assert.equal(item.due_at, '2026-11-02T07:00:00Z')
  assert.equal(item.repeat.freq, 'daily', 'a bare frequency becomes a full rule')
  assert.deepEqual(item.remind_before_min, [30])
  assert.equal(item.all_day, false)
})

await check('the tool patch replaces the rule and the reminder it names, and only those', async () => {
  const { tools } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({ items: [{ title: '补丁', note: '留着', due_at: '2026-11-02T09:00' }] }, {})
  const id = created.items[0].id
  const weekly = await tools.get('update_user_todos').execute({
    changes: [{ id, repeat: 'weekly', repeat_by_weekday: [2, 4] }],
  }, {})
  assert.equal(weekly.ok, true, JSON.stringify(weekly))
  assert.equal(weekly.items[0].repeat.freq, 'weekly')
  assert.deepEqual(weekly.items[0].repeat.byWeekday, [2, 4])
  assert.equal(weekly.items[0].note, '留着', 'a field the change did not name keeps its value')
  const monthly = await tools.get('update_user_todos').execute({
    changes: [{ id, repeat: 'monthly', remind_before_min: [0, 60] }],
  }, {})
  assert.equal(monthly.items[0].repeat.freq, 'monthly')
  assert.deepEqual(monthly.items[0].repeat.byWeekday, [], 'a new rule drops the old weekdays')
  assert.deepEqual(monthly.items[0].remind_before_min, [0, 60])
})

await check('a repeat rule without a due time is refused instead of stored dead', async () => {
  const { tools } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({ items: [{ title: '没有时间', repeat: 'daily' }] }, {})
  assert.equal(created.ok, false)
  assert.equal(created.error.code, 'invalid_recurrence')
  assert.match(created.error.message, /due time/)
  const dated = await tools.get('create_user_todos').execute({ items: [{ title: '有时间' }] }, {})
  const id = dated.items[0].id
  const patched = await tools.get('update_user_todos').execute({ changes: [{ id, repeat: 'daily' }] }, {})
  assert.equal(patched.ok, true)
  assert.equal(patched.results[0].code, 'invalid_recurrence')
  assert.equal(patched.results[0].message, 'a repeat rule needs a due time to start from')
})

await check('concurrent creates serialize instead of dropping one another', async () => {
  const { tools } = await freshPlugin()
  const create = tools.get('create_user_todos')
  await Promise.all([
    create.execute({ items: [{ title: 'A' }] }, {}),
    create.execute({ items: [{ title: 'B' }] }, {}),
    create.execute({ items: [{ title: 'C' }] }, {}),
  ])
  const listed = await tools.get('list_user_todos').execute({}, {})
  assert.deepEqual(listed.items.map(item => item.title).sort(), ['A', 'B', 'C'])
})

await check('every accepted write broadcasts a change', async () => {
  const { tools, ctx } = await freshPlugin()
  const created = await tools.get('create_user_todos').execute({ items: [{ title: 'announce' }] }, {})
  assert.equal(created.ok, true)
  assert.ok(ctx.emitted.some(([event]) => event === 'user-todo/changed'))
  const before = ctx.emitted.length
  await tools.get('update_user_todos').execute({ changes: [{ id: created.items[0].id, title: 'announce' }] }, {})
  assert.equal(ctx.emitted.length, before, 'an unchanged write must not broadcast')
})

await check('a write from a delegated child is refused when the deployment says so', async () => {
  const { tools } = await mount({ config: { allowSubagentWrites: false } })
  const result = await tools.get('create_user_todos').execute({ items: [{ title: 'child' }] }, { agent: { options: { subagentDepth: 1 } } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'subagent_denied')
})

await check('a document written with a retired field still opens, and the write drops it', async () => {
  // A field this list no longer offers must not take the whole plugin load
  // down; the item keeps every field that still exists.
  const storageDomain = fakeStorageDomain()
  storageDomain.seed({
    items: [{
      id: 'todo-00000000-0000-0000-0000-000000000001',
      revision: 3,
      status: 'open',
      priority: 'urgent',
      title: 'Written before the field was retired',
      note: null,
      tags: ['retired'],
      dueAt: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      completedAt: null,
      lastWriter: 'user',
    }],
    updatedAt: '2026-10-01T00:00:00Z',
  })
  const { tools } = await mount({ storageDomain })
  const listed = await tools.get('list_user_todos').execute({ status: 'all' }, {})
  assert.equal(listed.count, 1)
  assert.equal(listed.items[0].title, 'Written before the field was retired')
  assert.equal(Object.hasOwn(listed.items[0], 'revision'), false)
  assert.equal(Object.hasOwn(listed.items[0], 'priority'), false)
  const updated = await tools.get('update_user_todos').execute({ changes: [{ id: listed.items[0].id, status: 'done' }] }, {})
  assert.equal(updated.ok, true)
  assert.equal(Object.hasOwn(storageDomain.document.items[0], 'revision'), false)
  assert.equal(Object.hasOwn(storageDomain.document.items[0], 'priority'), false)
})

await check('closing the store drains the write already queued and refuses the next', async () => {
  const storageDomain = fakeStorageDomain()
  const plugin = await mount({ storageDomain })
  const store = new TodoStore(storageDomain.handle, {
    bounds: { maxTitleChars: 200, maxNoteChars: 2000 },
    maxItems: 10,
  })
  const queued = store.create([{ title: 'queued before close' }], 'user')
  const closing = store.close()
  await assert.rejects(async () => store.create([{ title: 'after close' }], 'user'), /closing/)
  const { added } = await queued
  await closing
  assert.equal(added[0].title, 'queued before close')
  assert.equal(storageDomain.document.items.length, 1)
  assert.equal(storageDomain.isOpen, false)
  await plugin.ctx.dispose()
})

await check('a read after the domain closed answers the last list; any other fault stays visible', async () => {
  // The crash this pins: a reminder tick fired while the plugin was disposing,
  // read the store after the domain had closed, threw, and the exception escaped
  // a timer callback and took the whole host down with exit 1.
  const storageDomain = fakeStorageDomain()
  const plugin = await mount({ storageDomain })
  const store = new TodoStore(storageDomain.handle, {
    bounds: { maxTitleChars: 200, maxNoteChars: 2000 },
    maxItems: 10,
  })
  await store.create([{ title: 'still readable' }], 'user')
  assert.equal(store.items().length, 1)

  // A fault that is not a closure is not the crash guard's case: answering it
  // with an older list would hide a real failure behind data that looks current.
  const read = storageDomain.handle.global.get
  storageDomain.handle.global.get = () => { throw Object.assign(new Error('backend exploded'), { code: 'backend-error' }) }
  assert.throws(() => store.items(), /backend exploded/)
  storageDomain.handle.global.get = read

  await store.close()
  assert.equal(storageDomain.isOpen, false)
  // Every read a late reader makes has to answer, not throw.
  const items = store.items()
  assert.equal(items[0].title, 'still readable')
  assert.equal(store.prefs().pushReminders !== undefined, true)
  assert.deepEqual(store.notifications(), [])
  assert.equal(store.item(items[0].id).title, 'still readable')
  await plugin.ctx.dispose()
})

await check('TodoError carries the closed code', async () => {
  const error = new TodoError('not_found', 'x')
  assert.equal(error.code, 'not_found')
  assert.equal(error.name, 'TodoError')
})

await check('removing an item drops the reminder ledger entries that named it', async () => {
  // A ledger entry whose item is gone can never be replayed, and a ticker that
  // still held one would look for an item that no longer exists.
  const storageDomain = fakeStorageDomain()
  const plugin = await mount({ storageDomain })
  const store = new TodoStore(storageDomain.handle, {
    bounds: { maxTitleChars: 200, maxNoteChars: 2000 },
    maxItems: 10,
  })
  const { added } = await store.create([{ title: 'doomed' }, { title: 'survivor' }], 'user')
  const [doomed, survivor] = added
  // Instants are stored at second precision; a millisecond form fails to parse
  // and is pruned as stale, which is why the ledger is empty if this is wrong.
  const at = `${new Date().toISOString().slice(0, 19)}Z`
  await store.recordNotifications([
    { key: `${doomed.id}@2026-11-02T01:00:00Z#0`, at, status: 'sent' },
    { key: `${survivor.id}@2026-11-02T01:00:00Z#0`, at, status: 'sent' },
    { key: 'digest:2026-11-02', at, status: 'sent' },
  ])
  assert.equal(store.notifications().length, 3)

  const outcome = await store.remove([doomed.id])
  assert.deepEqual(outcome.removed, [doomed.id])
  const keys = store.notifications().map(entry => entry.key)
  assert.equal(keys.includes(`${doomed.id}@2026-11-02T01:00:00Z#0`), false)
  assert.equal(keys.includes(`${survivor.id}@2026-11-02T01:00:00Z#0`), true)
  // A daily digest names no item, so it survives any single deletion.
  assert.equal(keys.includes('digest:2026-11-02'), true)
  await plugin.ctx.dispose()
})

await check('removeFinished drops every finished item and keeps the open ones', async () => {
  const storageDomain = fakeStorageDomain()
  const plugin = await mount({ storageDomain })
  const store = new TodoStore(storageDomain.handle, {
    bounds: { maxTitleChars: 200, maxNoteChars: 2000 },
    maxItems: 10,
  })
  const { added } = await store.create([{ title: 'a' }, { title: 'b' }, { title: 'c' }], 'user')
  await store.update([{ id: added[0].id, patch: { status: 'done' } }, { id: added[2].id, patch: { status: 'done' } }], 'user')
  const outcome = await store.removeFinished()
  assert.deepEqual(outcome.removed.sort(), [added[0].id, added[2].id].sort())
  assert.deepEqual(outcome.absent, [])
  assert.deepEqual(store.items().map(item => item.title), ['b'])
  // Nothing finished means nothing written and nothing dropped.
  const again = await store.removeFinished()
  assert.deepEqual(again.removed, [])
  await plugin.ctx.dispose()
})

await check('remove refuses anything that is not an id list, including null', async () => {
  const storageDomain = fakeStorageDomain()
  const plugin = await mount({ storageDomain })
  const store = new TodoStore(storageDomain.handle, {
    bounds: { maxTitleChars: 200, maxNoteChars: 2000 },
    maxItems: 10,
  })
  await assert.rejects(async () => store.remove(undefined), (error) => error.code === 'invalid_key')
  await assert.rejects(async () => store.remove('todo-1'), (error) => error.code === 'invalid_key')
  // The finished-only form is a method of its own, so `null` no longer means it.
  await assert.rejects(async () => store.remove(null), (error) => error.code === 'invalid_key')
  await plugin.ctx.dispose()
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

/**
 * Checks for the panel route and the three tools against the real tool registry
 * contract: every declared schema is one the registry accepts, and every value a
 * tool returns validates against the output schema it declared.
 */
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { mount } from './harness.js'

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
 * Run one tool, refusing a value its own declared output schema rejects.
 *
 * @param tool - the tool definition.
 * @param args - the model arguments.
 * @param exec - the run context.
 * @returns the validated tool value.
 */
async function call(tool, args, exec = {}) {
  const value = await tool.execute(args, exec)
  const violations = validateJsonSchemaValue(tool.output.schema, value)
  if (violations.length > 0) throw new Error(violations.join('; '))
  return value
}

/**
 * POST one panel action.
 * @param connection - the stub connection channel.
 * @param body - the request body.
 * @returns the parsed response.
 */
async function post(connection, body) {
  const response = await connection.request('/api/user-todo', { method: 'POST', body })
  return { status: response.status, payload: await response.json() }
}

await check('every tool declares argument and output schemas the registry supports', async () => {
  const { tools } = await mount()
  assert.deepEqual([...tools.keys()], ['list_user_todos', 'create_user_todos', 'update_user_todos', 'list_user_agenda', 'delete_user_todos'])
  for (const tool of tools.values()) {
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0)
  }
})

await check('a panel create writes as the person and answers with the new state', async () => {
  const { connection } = await mount()
  const { status, payload } = await post(connection, { action: 'create', items: [{ title: 'From the panel' }] })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.outcome.added.length, 1)
  assert.equal(payload.value.state.items.length, 1)
  assert.equal(payload.value.state.items[0].lastWriter, 'user')
})

await check('the panel keeps a repeated title: the person typed it twice on purpose', async () => {
  const { connection } = await mount()
  await post(connection, { action: 'create', items: [{ title: 'Twice' }] })
  const { payload } = await post(connection, { action: 'create', items: [{ title: 'Twice' }] })
  assert.equal(payload.value.state.items.length, 2)
  assert.deepEqual(payload.value.outcome.skipped, [])
})

await check('the panel update reports per-entry outcomes and applies the newest write', async () => {
  const { connection } = await mount()
  const created = await post(connection, { action: 'create', items: [{ title: 'Panel item' }] })
  const id = created.payload.value.state.items[0].id
  const ok = await post(connection, { action: 'update', changes: [{ id, patch: { status: 'done' } }] })
  assert.equal(ok.payload.value.outcome.results[0].code, 'changed')
  assert.equal(ok.payload.value.state.items[0].status, 'done')
  const renamed = await post(connection, { action: 'update', changes: [{ id, patch: { title: 'Renamed late' } }] })
  assert.equal(renamed.payload.value.outcome.results[0].code, 'changed')
  assert.equal(renamed.payload.value.state.items[0].title, 'Renamed late')
})

await check('the panel remove reports what was dropped and what was not listed', async () => {
  const { connection } = await mount()
  const created = await post(connection, { action: 'create', items: [{ title: 'Doomed' }] })
  const id = created.payload.value.state.items[0].id
  const { payload } = await post(connection, { action: 'remove', ids: [id, 'todo-00000000-0000-0000-0000-000000000000'] })
  assert.deepEqual(payload.value.outcome.removed, [id])
  assert.deepEqual(payload.value.outcome.absent, ['todo-00000000-0000-0000-0000-000000000000'])
  assert.equal(payload.value.state.items.length, 0)
})

await check('a read method cannot change the list', async () => {
  const { connection, storageDomain } = await mount()
  const response = await connection.request('/api/user-todo?action=remove&ids=todo-00000000-0000-0000-0000-000000000000')
  const payload = await response.json()
  assert.equal(response.status, 405)
  assert.equal(payload.error.code, 'method_not_allowed')
  assert.deepEqual(storageDomain.document.items, [])
})

await check('a panel list read answers the ordered items', async () => {
  const { connection } = await mount()
  await post(connection, { action: 'create', items: [{ title: 'later', dueAt: '2030-01-02T00:00:00Z' }, { title: 'sooner', dueAt: '2030-01-01T00:00:00Z' }] })
  const response = await connection.request('/api/user-todo')
  const payload = await response.json()
  assert.deepEqual(payload.value.items.map(item => item.title), ['sooner', 'later'])
})

await check('an unknown action and a broken body are refused with their own codes', async () => {
  const { connection } = await mount()
  assert.equal((await post(connection, { action: 'archive' })).payload.error.code, 'unknown_action')
  const raw = async (body) => { const r = await connection.request('/api/user-todo', { method: 'POST', rawBody: body }); const t = await r.text(); return new Response(t, { status: r.status }) }
  const malformed = await raw('not json')
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'invalid_json')
  const array = await raw('[1,2]')
  assert.equal((await array.json()).error.code, 'invalid_body')
  const empty = await raw('')
  assert.equal(empty.status, 200)
  assert.equal((await post(connection, { action: 'list' })).payload.ok, true)
})

await check('a body larger than the panel request bound is refused before it is parsed', async () => {
  const { connection } = await mount()
  const raw = await connection.request('/api/user-todo', { method: 'POST', rawBody: `{"action":"create","items":[{"title":"${'x'.repeat(70000)}"}]}` })
  assert.equal(raw.status, 413)
  assert.equal((await raw.json()).error.code, 'body_too_large')
})

await check('the agent and the panel share one list: a change either makes is in the other\'s next read', async () => {
  const { connection, tools } = await mount()
  await post(connection, { action: 'create', items: [{ title: 'Shared item' }] })
  const listed = await call(tools.get('list_user_todos'), {})
  assert.equal(listed.count, 1)
  assert.equal(listed.items[0].source, 'user')
  await call(tools.get('update_user_todos'), { changes: [{ id: listed.items[0].id, status: 'done' }] })
  const panel = await (await connection.request('/api/user-todo')).json()
  assert.equal(panel.value.items[0].status, 'done')
  assert.equal(panel.value.items[0].lastWriter, 'agent')
  const open = await call(tools.get('list_user_todos'), {})
  assert.equal(open.count, 0)
  assert.equal(open.done, 1)
})

await check('list filters by status and carries no free-text search', async () => {
  const { tools } = await mount()
  await call(tools.get('create_user_todos'), {
    items: [{ title: 'Buy coffee' }, { title: 'Write report', note: 'deadline friday' }],
  })
  const list = tools.get('list_user_todos')
  assert.deepEqual(Object.keys(list.parameters.properties), ['status'])
  const all = await call(list, { status: 'all' })
  assert.equal(all.count, 2)
  assert.equal(all.open, 2)
  const done = await call(list, { status: 'done' })
  assert.equal(done.count, 0)
  assert.equal(done.open, 2)
})

await check('the tool names follow the configured row, not a hardcoded set', async () => {
  const { tools } = await mount({ config: { toolNames: { list: 'todos_list', create: 'todos_add', update: 'todos_patch', agenda: 'todos_agenda', remove: 'todos_delete' } } })
  assert.deepEqual([...tools.keys()].sort(), ['todos_add', 'todos_agenda', 'todos_delete', 'todos_list', 'todos_patch'])
})

await check('a row that names only the three original tools still mounts the agenda and delete under their default names', async () => {
  const { tools } = await mount({ config: { toolNames: { list: 'todos_list', create: 'todos_add', update: 'todos_patch' } } })
  assert.deepEqual([...tools.keys()].sort(), ['delete_user_todos', 'list_user_agenda', 'todos_add', 'todos_list', 'todos_patch'])
})

await check('a refused batch answers a closed failure the model can read', async () => {
  const { tools } = await mount()
  const refused = await call(tools.get('create_user_todos'), { items: [{ title: 'x'.repeat(201) }] })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'invalid_title')
  const stale = await call(tools.get('update_user_todos'), { changes: [{ id: 'todo-00000000-0000-0000-0000-000000000000', status: 'done' }] })
  assert.equal(stale.ok, true)
  assert.equal(stale.results[0].code, 'not_found')
})

await check('a render of each result names the items a reader needs', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), { items: [{ title: 'Rendered' }] })
  const tool = tools.get('create_user_todos')
  const [block] = tool.output.render({}, created)
  assert.equal(block.type, 'text')
  assert.match(block.text, /Rendered/)
  assert.match(block.text, /agent/)
  const failure = await call(tools.get('create_user_todos'), { items: [{ title: '' }] })
  assert.match(tool.output.render({}, failure)[0].text, /invalid_title/)
})

await check('a date-only due_at becomes an all-day item and the list says so', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), { items: [{ title: '体检', due_at: '2026-11-05' }] })
  assert.equal(created.items[0].all_day, true)
  assert.equal(created.items[0].due_date, '2026-11-05')
  assert.equal(created.items[0].due_at, '2026-11-04T16:00:00Z', 'local midnight in the fixture zone')
})

await check('a local wall-clock due_at is read in the calendar zone, not as UTC', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), { items: [{ title: '交周报', due_at: '2026-11-02T15:00' }] })
  assert.equal(created.items[0].due_at, '2026-11-02T07:00:00Z')
  assert.equal(created.items[0].all_day, false)
})

await check('the agenda expands a weekly series inside the requested window', async () => {
  const { tools } = await mount()
  await call(tools.get('create_user_todos'), {
    items: [{ title: '跑步', due_at: '2026-11-02T09:00', repeat: 'weekly', repeat_by_weekday: [1, 3, 5] }],
  })
  const agenda = await call(tools.get('list_user_agenda'), { from: '2026-11-01', to: '2026-11-08' })
  assert.equal(agenda.count, 3)
  assert.deepEqual(agenda.occurrences.map(entry => entry.date), ['2026-11-02', '2026-11-04', '2026-11-06'])
  assert.equal(agenda.time_zone, 'Asia/Shanghai')
  assert.match(agenda.now, /Z$/)
})

await check('completing one occurrence advances a series without closing it', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), {
    items: [{ title: '跑步', due_at: '2026-11-02T09:00', repeat: 'daily' }],
  })
  const id = created.items[0].id
  const first = await call(tools.get('list_user_agenda'), { from: '2026-11-02', to: '2026-11-04' })
  const done = await call(tools.get('update_user_todos'), { changes: [{ id, complete_occurrence: first.occurrences[0].occurrence_id }] })
  assert.equal(done.ok, true)
  assert.equal(done.results[0].code, 'changed')
  assert.equal(done.items[0].status, 'open', 'the series stays open')
  const next = await call(tools.get('list_user_agenda'), { from: '2026-11-02', to: '2026-11-05' })
  assert.deepEqual(next.occurrences.map(entry => entry.status), ['open', 'open'])
  assert.equal(next.occurrences[0].date, '2026-11-03')
})

await check('skipping one occurrence leaves the rest of the series alone', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), {
    items: [{ title: '跑步', due_at: '2026-11-02T09:00', repeat: 'daily' }],
  })
  const id = created.items[0].id
  const listed = await call(tools.get('list_user_agenda'), { from: '2026-11-02', to: '2026-11-05' })
  await call(tools.get('update_user_todos'), { changes: [{ id, exclude_occurrence: listed.occurrences[1].occurrence_id }] })
  const after = await call(tools.get('list_user_agenda'), { from: '2026-11-02', to: '2026-11-05' })
  assert.deepEqual(after.occurrences.map(entry => entry.date), ['2026-11-02', '2026-11-04'])
})

await check('an occurrence id belonging to another item is refused', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), {
    items: [{ title: 'A', due_at: '2026-11-02T09:00', repeat: 'daily' }, { title: 'B', due_at: '2026-11-03T09:00' }],
  })
  const [a, b] = created.items
  const result = await call(tools.get('update_user_todos'), {
    changes: [{ id: b.id, complete_occurrence: `${a.id}@2026-11-02T01:00:00Z` }],
  })
  assert.equal(result.results[0].code, 'invalid_occurrence')
})

await check('the panel agenda action reads a window from the query string', async () => {
  const { connection } = await mount()
  await post(connection, { action: 'create', items: [{ title: '面板日程', due_at: '2026-11-02T15:00' }] })
  const response = await connection.request('/api/user-todo?action=agenda&from=2026-11-01&to=2026-11-08')
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.value.occurrences.length, 1)
  assert.equal(payload.value.occurrences[0].startAt, '2026-11-02T07:00:00Z')
  assert.equal(payload.value.timeZone, 'Asia/Shanghai')
})

await check('a finished occurrence stays in the panel calendar, struck through', async () => {
  const { connection, tools } = await mount()
  const rule = { freq: 'daily', interval: 1, byWeekday: [], count: null, until: null, dtstart: null }
  const created = await post(connection, { action: 'create', items: [{ title: '已完成的一次', due_at: '2026-11-02T15:00', recurrence: rule }] })
  const id = created.payload.value.state.items[0].id
  await tools.get('update_user_todos').execute({ changes: [{ id, complete_occurrence: `${id}@2026-11-02T07:00:00Z` }] }, {})
  const response = await connection.request('/api/user-todo?action=agenda&from=2026-11-02&to=2026-11-04')
  const payload = await response.json()
  assert.deepEqual(payload.value.occurrences.map(entry => entry.status), ['done', 'open'])
  const narrow = await (await connection.request('/api/user-todo?action=agenda&from=2026-11-02&to=2026-11-04&include_done=false')).json()
  assert.deepEqual(narrow.value.occurrences.map(entry => entry.status), ['open'])
})

await check('the panel reads and writes the reminder preferences', async () => {
  const { connection } = await mount()
  const before = await (await connection.request('/api/user-todo?action=prefs')).json()
  assert.equal(before.value.prefs.pushReminders, true)
  const written = await post(connection, { action: 'setPrefs', prefs: { pushReminders: false, digestAt: '08:30' } })
  assert.equal(written.payload.ok, true)
  assert.equal(written.payload.value.prefs.pushReminders, false)
  const after = await (await connection.request('/api/user-todo?action=prefs')).json()
  assert.equal(after.value.prefs.digestAt, '08:30')
  const refused = await post(connection, { action: 'setPrefs', prefs: { quietHours: { start: '25:00', end: '08:00' } } })
  assert.equal(refused.payload.error.code, 'invalid_prefs')
})

await check('a window that ends before it starts is refused by both surfaces', async () => {
  const { connection, tools } = await mount()
  const panel = await (await connection.request('/api/user-todo?action=agenda&from=2026-11-05&to=2026-11-01')).json()
  assert.equal(panel.error.code, 'invalid_window')
  const tool = await call(tools.get('list_user_agenda'), { from: '2026-11-05', to: '2026-11-01' })
  assert.equal(tool.error.code, 'invalid_window')
})

await check('delete_user_todos removes the named items and reports what it could not find', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), { items: [{ title: 'keep me' }, { title: 'drop me' }] })
  const [keep, drop] = created.items
  const deleted = await call(tools.get('delete_user_todos'), { ids: [drop.id, 'todo-00000000-0000-0000-0000-000000000000'] })
  assert.equal(deleted.ok, true)
  assert.deepEqual(deleted.removed.map(item => item.title), ['drop me'])
  assert.ok(deleted.absent.length === 1)
  assert.equal(deleted.count, 1)
  assert.equal(deleted.remaining, 1)
  const listed = await call(tools.get('list_user_todos'), { status: 'all' })
  assert.deepEqual(listed.items.map(item => item.id), [keep.id])
})

await check('delete_user_todos without ids clears every finished item and keeps the open ones', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), { items: [{ title: 'open one' }, { title: 'done one' }] })
  const [open, done] = created.items
  await call(tools.get('update_user_todos'), { changes: [{ id: done.id, status: 'done' }] })
  const cleared = await call(tools.get('delete_user_todos'), {})
  assert.deepEqual(cleared.removed.map(item => item.id), [done.id])
  assert.equal(cleared.remaining, 1)
  assert.deepEqual(cleared.absent, [])
  const listed = await call(tools.get('list_user_todos'), { status: 'all' })
  assert.deepEqual(listed.items.map(item => item.id), [open.id])
})

await check('open_only refuses to delete an item that is still open', async () => {
  const { tools } = await mount()
  const created = await call(tools.get('create_user_todos'), { items: [{ title: 'open' }, { title: 'done' }] })
  const [open, done] = created.items
  await call(tools.get('update_user_todos'), { changes: [{ id: done.id, status: 'done' }] })
  // With ids: the open one is reported, not deleted.
  const named = await call(tools.get('delete_user_todos'), { ids: [open.id, done.id], open_only: true })
  assert.deepEqual(named.removed.map(item => item.id), [done.id])
  assert.deepEqual(named.absent, [open.id])
  // Without ids: an open item is present, so the whole call is refused.
  const refused = await call(tools.get('delete_user_todos'), { open_only: true })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'open_items_present')
  const listed = await call(tools.get('list_user_todos'), { status: 'all' })
  assert.deepEqual(listed.items.map(item => item.id), [open.id])
})

await check('delete_user_todos refuses an empty or oversized batch', async () => {
  const { tools } = await mount()
  const empty = await call(tools.get('delete_user_todos'), { ids: [] })
  assert.equal(empty.error.code, 'invalid_body')
  const many = await call(tools.get('delete_user_todos'), { ids: Array.from({ length: 51 }, (_, index) => `todo-${index}`) })
  assert.equal(many.error.code, 'batch_too_large')
})

await check('the panel clears finished items through the same store call', async () => {
  const { connection, tools } = await mount()
  const created = await call(tools.get('create_user_todos'), { items: [{ title: 'a' }, { title: 'b' }] })
  await call(tools.get('update_user_todos'), { changes: [{ id: created.items[0].id, status: 'done' }] })
  const cleared = await post(connection, { action: 'remove', completed: true })
  assert.equal(cleared.payload.ok, true)
  assert.deepEqual(cleared.payload.value.outcome.removed, [created.items[0].id])
  assert.deepEqual(cleared.payload.value.state.items.map(item => item.title), ['b'])
  // Naming no id and not asking for the finished ones is still a defect.
  const bare = await post(connection, { action: 'remove' })
  assert.equal(bare.payload.error.code, 'invalid_body')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

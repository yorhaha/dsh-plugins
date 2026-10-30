/**
 * Checks for the Client half: the sidebar entry and the page it opens render,
 * the page reads and writes through the bundle's route, and its copy resolves in
 * both languages.
 *
 * The Client half is a classic script served verbatim and never bundled, so it
 * declares no imports. This harness supplies the two things it asks the browser
 * module table for — React and the shared primitives it actually uses — and a
 * stub `slots`, `locale`, and `fetch` that answer the way the Harness does.
 *
 * Needs the browser dependencies in this package's devDependencies, so run it
 * after `pnpm install`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const webRequire = createRequire(new URL('../package.json', import.meta.url))

// The browser globals must exist BEFORE react-dom loads: it decides at import
// time whether the environment supports the `input` event.
const { JSDOM } = webRequire('jsdom')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = webRequire('react')
const { createRoot } = webRequire('react-dom/client')
const { act } = webRequire('react-dom/test-utils')

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

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
 * Load the Client half the way the module loader does and capture what it
 * registers.
 *
 * @returns the registered entries and the dictionaries it declared.
 */
function loadClientHalf() {
  const registered = []
  const dictionaries = {}
  // The stylesheet lives in `document.head`, so the harness reads the node the
  // plugin actually installed instead of intercepting its creation.
  const stylesBefore = new Set(document.head.querySelectorAll('style'))
  let loaded = null
  // The file reads `window.__ModuleLoader__` at top level, so the table is
  // captured here and the module table answers `react` with the real library.
  // The Harness evaluates the file with the real page `window`, whose only
  // loader surface is `__ModuleLoader__`; this stub adds exactly that.
  const loaderWindow = Object.create(window)
  loaderWindow.__ModuleLoader__ = { load: (definition) => { loaded = definition } }
  new Function('window', source)(loaderWindow)
  const module = loaded.factory((name) => {
    if (name !== 'react') throw new Error(`unexpected module request: ${name}`)
    return React
  })
  const ctx = {
    effect: (callback) => {
      const cleanup = callback()
      return () => (typeof cleanup === 'function' ? cleanup() : undefined)
    },
    slots: {
      // A generator injection yields registrations; the real injection effect
      // drains it, so this one does too.
      inject: (_slot, callback) => {
        const effect = callback()
        if (effect !== null && typeof effect === 'object' && typeof effect.next === 'function') {
          for (const _ of effect) void _
        }
        return () => {}
      },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
    locale: {
      register: (namespace, dicts) => { dictionaries[namespace] = dicts; return () => {} },
      bind: namespace => key => (dictionaries[namespace]?.en ?? {})[key] ?? key,
    },
  }
  module.apply(ctx)
  const installed = [...document.head.querySelectorAll('style')].filter(node => !stylesBefore.has(node))
  const style = installed.map(node => node.textContent).join('\n')
  for (const node of installed) node.remove()
  return { registered, dictionaries, name: module.name, inject: module.inject, style }
}

const half = loadClientHalf()

/** A tiny router answering the bundle's route the way the Host does. */
function fakeHost(initial = [], { failCreate = null } = {}) {
  let items = structuredClone(initial)
  let serial = 0
  const calls = []
  const route = async (url, init = {}) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body)
      calls.push(body)
      if (body.action === 'create') {
        if (failCreate !== null) return { ok: false, error: { code: failCreate, message: 'refused' } }
        const at = '2026-10-26T00:00:00Z'
        for (const entry of body.items) {
          serial += 1
          items.push({
            id: `todo-00000000-0000-0000-0000-0000000000${String(serial).padStart(2, '0')}`,
            status: entry.status ?? 'open',
            title: entry.title,
            note: entry.note ?? null,
            dueAt: entry.dueAt ?? null,
            createdAt: at,
            updatedAt: at,
            completedAt: null,
            lastWriter: 'user',
          })
        }
        return { ok: true, value: { outcome: { added: body.items, skipped: [] }, state: { items } } }
      }
      if (body.action === 'update') {
        const results = body.changes.map((change) => {
          const item = items.find(entry => entry.id === change.id)
          const next = { ...item, ...change.patch, lastWriter: 'user' }
          items = items.map(entry => (entry.id === item.id ? next : entry))
          return { id: change.id, code: 'changed', item: next }
        })
        return { ok: true, value: { outcome: { changed: results.map(result => result.item), results }, state: { items } } }
      }
      if (body.action === 'remove') {
        const removed = items.filter(item => body.ids.includes(item.id)).map(item => item.id)
        items = items.filter(item => !body.ids.includes(item.id))
        return { ok: true, value: { outcome: { removed, absent: [] }, state: { items } } }
      }
      if (body.action === 'completeOccurrence') {
        const item = items.find(entry => entry.id === body.id)
        const next = { ...item, recurrenceDoneThrough: body.occurrenceId.split('@')[1], lastWriter: 'user' }
        items = items.map(entry => (entry.id === item.id ? next : entry))
        return { ok: true, value: { outcome: { item: next }, state: { items } } }
      }
      if (body.action === 'setPrefs') {
        return { ok: true, value: { prefs: { ...body.prefs }, state: { items } } }
      }
    }
    const target = new URL(typeof url === 'string' ? url : String(url), 'http://localhost/')
    const action = target.searchParams.get('action') ?? 'list'
    if (action === 'agenda') {
      const from = target.searchParams.get('from') ?? ''
      const to = target.searchParams.get('to') ?? ''
      const occurrences = items
        .filter(item => typeof item.dueAt === 'string')
        .map(item => ({
          occurrenceId: `${item.id}@${item.dueAt}`,
          itemId: item.id,
          title: item.title,
          note: item.note ?? null,
          allDay: false,
          startAt: item.dueAt,
          date: item.dueAt.slice(0, 10),
          done: item.status === 'done',
          status: item.status,
          recurrence: item.recurrence ?? null,
          recurrenceText: '',
          remindBeforeMin: item.remindBeforeMin ?? [],
          lastWriter: item.lastWriter,
        }))
        .filter(entry => entry.date >= from && entry.date < to)
      return { ok: true, value: { from, to, timeZone: 'Asia/Shanghai', now: '2026-10-27T00:00:00Z', occurrences } }
    }
    if (action === 'prefs') {
      return {
        ok: true,
        value: {
          prefs: {
            pushReminders: true,
            defaultRemindBeforeMin: 0,
            allDayReminderTime: '09:00',
            quietHours: null,
            digestAt: null,
            weekStart: 1,
          },
        },
      }
    }
    return { ok: true, value: { items } }
  }
  globalThis.fetch = async (url, init) => {
    const answer = await route(url, init)
    return { status: answer.ok ? 200 : 400, json: async () => answer }
  }
  return { calls, get items() { return items } }
}

/**
 * Render one registered component under a root.
 *
 * @param component - the component.
 * @param props - its props.
 * @returns the container and an unmount function.
 */
async function render(component, props) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(component, props)) })
  return { container, unmount: async () => { await act(async () => { root.unmount() }); container.remove() } }
}

/**
 * Find one element by its text among all descendants.
 *
 * @param container - the root element.
 * @param selector - a CSS selector.
 * @returns the elements.
 */
function all(container, selector) {
  return [...container.querySelectorAll(selector)]
}

/**
 * Let pending promises settle inside act.
 */
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

const page = half.registered.find(entry => entry.options.name === 'main')?.component
const icon = half.registered.find(entry => entry.options.name === 'sidebar.panellist')?.component

await check('the bundle exports inject and apply and registers the sidebar entry and its page', async () => {
  assert.deepEqual(half.inject, ['slots', 'locale'])
  assert.equal(half.name, undefined)
  const entry = half.registered.find(record => record.options.name === 'sidebar.panellist')
  assert.equal(entry.options.id, 'user-todo')
  assert.equal(entry.options.locale, 'user-todo')
  const main = half.registered.find(record => record.options.name === 'main')
  assert.equal(main.options.key, 'user-todo')
  assert.equal(typeof icon, 'function')
  assert.equal(typeof page, 'function')
})

await check('the dictionaries carry the same flat keys in both languages', async () => {
  const { zh: zhDict, en: enDict } = half.dictionaries['user-todo']
  assert.deepEqual(Object.keys(zhDict).sort(), Object.keys(enDict).sort())
  for (const dict of [zhDict, enDict]) {
    for (const value of Object.values(dict)) assert.equal(typeof value, 'string')
  }
})

await check('the stylesheet is installed and removed with the plugin', async () => {
  assert.match(half.style, /\.dsh-ut-page/)
  assert.match(half.style, /--dsw-alias-bg-base/)
  assert.doesNotMatch(half.style, /#[0-9a-fA-F]{3,6}\b/, 'structural colors must come from theme tokens')
})

await check('the empty list says how to begin', async () => {
  fakeHost([])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  assert.match(view.container.textContent, /No items yet/)
  await view.unmount()
})

await check('items render in date groups with their chips', async () => {
  fakeHost([
    { id: 'todo-a', status: 'open', title: 'Overdue task', note: null, dueAt: '2020-01-01T00:00:00Z', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: null, lastWriter: 'agent' },
    { id: 'todo-b', status: 'open', title: 'Undated task', note: 'a note', dueAt: null, createdAt: '2020-01-02T00:00:00Z', updatedAt: '2020-01-02T00:00:00Z', completedAt: null, lastWriter: 'user' },
  ])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  const text = view.container.textContent
  assert.match(text, /Overdue/)
  assert.match(text, /No date/)
  assert.match(text, /Overdue task/)
  assert.match(text, /a note/)
  assert.match(text, /agent/)
  assert.doesNotMatch(text, /\br\d+\b/)
  await view.unmount()
})

await check('typing a title and pressing Enter adds it', async () => {
  const host = fakeHost([])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  const input = view.container.querySelector('.dsh-ut-compose-title')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'From the page')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await settle()
  assert.equal(host.calls[0].action, 'create')
  assert.equal(host.calls[0].items[0].title, 'From the page')
  assert.match(view.container.textContent, /From the page/)
  await view.unmount()
})

await check('the check box marks the item done without a version', async () => {
  const host = fakeHost([{ id: 'todo-c', status: 'open', title: 'Tick me', note: null, dueAt: null, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: null, lastWriter: 'user' }])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  const box = view.container.querySelector('.dsh-ut-check')
  assert.equal(box.checked, false)
  await act(async () => { box.click() })
  await settle()
  assert.deepEqual(host.calls.at(-1).changes[0], { id: 'todo-c', patch: { status: 'done' } })
  await view.unmount()
})

await check('an edit opens the editor and saving posts every field', async () => {
  const host = fakeHost([{ id: 'todo-d', status: 'open', title: 'Edit me', note: 'old', dueAt: null, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: null, lastWriter: 'user' }])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  await act(async () => { view.container.querySelector('.dsh-ut-row-title').click() })
  const titleInput = view.container.querySelector('.dsh-ut-editor input')
  assert.equal(titleInput.value, 'Edit me')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(titleInput, 'Edited title')
    titleInput.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const save = [...view.container.querySelectorAll('.dsh-ut-editor .dsh-ut-button')][0]
  await act(async () => { save.click() })
  await settle()
  const change = host.calls.at(-1).changes[0]
  assert.equal(Object.hasOwn(change, 'expectedRevision'), false)
  assert.equal(change.patch.title, 'Edited title')
  assert.equal(change.patch.note, 'old')
  assert.equal(Object.hasOwn(change.patch, 'tags'), false, 'the list no longer carries labels')
  await view.unmount()
})

await check('delete offers an undo that re-adds the item', async () => {
  const host = fakeHost([{ id: 'todo-e', status: 'open', title: 'Remove me', note: null, dueAt: null, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: null, lastWriter: 'user' }])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  const removeButton = view.container.querySelector('.dsh-ut-row .dsh-ut-icon-button[data-danger="true"]')
  await act(async () => { removeButton.click() })
  await settle()
  assert.equal(host.calls.at(-1).action, 'remove')
  const undo = [...view.container.querySelectorAll('.dsh-ut-notice .dsh-ut-button')][0]
  assert.equal(undo.textContent, 'Undo')
  await act(async () => { undo.click() })
  await settle()
  assert.equal(host.calls.at(-1).action, 'create')
  assert.equal(host.calls.at(-1).items[0].title, 'Remove me')
  await view.unmount()
})

await check('a refused create shows its own copy instead of throwing', async () => {
  fakeHost([], { failCreate: 'invalid_title' })
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  const input = view.container.querySelector('.dsh-ut-compose-title')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'x')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
  assert.match(view.container.textContent, /A title is required/)
  await view.unmount()
})

await check('an unreachable Host shows the read failure with a retry', async () => {
  globalThis.fetch = async () => { throw new Error('offline') }
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  assert.match(view.container.textContent, /Cannot reach the Harness/)
  assert.ok([...view.container.querySelectorAll('button')].some(button => button.textContent === 'Retry'))
  await view.unmount()
})

await check('the filter narrows the list to open, done, or all', async () => {
  fakeHost([
    { id: 'todo-f', status: 'open', title: 'Keep me', note: null, dueAt: null, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: null, lastWriter: 'user' },
    { id: 'todo-g', status: 'done', title: 'Already done', note: null, dueAt: null, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: '2020-01-01T00:00:00Z', lastWriter: 'user' },
  ])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  assert.match(view.container.textContent, /Keep me/)
  assert.match(view.container.textContent, /Already done/)
  const openTab = [...view.container.querySelectorAll('.dsh-ut-pill')].find(button => button.textContent.startsWith('Open'))
  await act(async () => { openTab.click() })
  await settle()
  assert.match(view.container.textContent, /Keep me/)
  assert.doesNotMatch(view.container.textContent, /Already done/)
  await view.unmount()
})

await check('the panel icon draws a glyph at the size the sidebar asked for', async () => {
  const markup = React.createElement(icon, { size: 18, active: false })
  const view = await render(() => markup, {})
  const svg = view.container.querySelector('svg')
  assert.equal(svg.getAttribute('width'), '18')
  assert.equal(svg.getAttribute('aria-hidden'), 'true')
  await view.unmount()
})

await check('the calendar renders the month grid, its chips, and the selected day', async () => {
  fakeHost([{ id: 'todo-f', status: 'open', title: 'Calendar item', note: null, dueAt: '2026-11-02T01:00:00Z', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: null, lastWriter: 'user' }])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  const calendarTab = all(view.container, '.dsh-ut-segment .dsh-ut-button').find(button => button.textContent === 'Calendar')
  await act(async () => { calendarTab.click() })
  await settle()
  assert.match(view.container.textContent, /Today/)
  const cells = all(view.container, '.dsh-ut-cal-cell')
  assert.equal(cells.length, 42, 'the grid keeps six weeks so its height never jumps')
  const chip = all(view.container, '.dsh-ut-cal-chip').find(node => node.textContent.includes('Calendar item'))
  assert.ok(chip, 'the occurrence appears as a chip')
  await act(async () => { chip.click() })
  await settle()
  assert.ok(all(view.container, '.dsh-ut-editor').length === 1, 'clicking a chip opens its item')
  await view.unmount()
})

await check('ticking a day row completes only that occurrence', async () => {
  const host = fakeHost([{ id: 'todo-g', status: 'open', title: 'Series item', note: null, dueAt: '2026-11-02T01:00:00Z', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: null, lastWriter: 'user', recurrence: { freq: 'daily', interval: 1, byWeekday: [], count: null, until: null, dtstart: null } }])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  const calendarTab = all(view.container, '.dsh-ut-segment .dsh-ut-button').find(button => button.textContent === 'Calendar')
  await act(async () => { calendarTab.click() })
  await settle()
  // Select the day the fixture falls on by its aria label.
  const cell = all(view.container, '.dsh-ut-cal-cell').find(node => node.getAttribute('aria-label') === '2026-11-02')
  await act(async () => { cell.click() })
  await settle()
  const box = all(view.container, '.dsh-ut-day .dsh-ut-check')[0]
  await act(async () => { box.click() })
  await settle()
  assert.equal(host.calls.at(-1).action, 'completeOccurrence')
  assert.equal(host.calls.at(-1).occurrenceId, 'todo-g@2026-11-02T01:00:00Z')
  await view.unmount()
})

await check('a repeat rule waits for a date instead of failing on save', async () => {
  fakeHost([{ id: 'todo-h', status: 'open', title: 'No date yet', note: null, dueAt: null, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', completedAt: null, lastWriter: 'user' }])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  await act(async () => { view.container.querySelector('.dsh-ut-row-title').click() })
  await settle()
  const select = all(view.container, '.dsh-ut-editor select')[0]
  assert.equal(select.disabled, true, 'the frequency cannot be chosen without an anchor')
  assert.match(view.container.textContent, /Set a time or date before it can repeat/)
  // Setting a date enables it, and the same editor keeps the choice.
  const dateInput = all(view.container, '.dsh-ut-editor input[type="datetime-local"]')[0]
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(dateInput, '2026-11-02T09:00')
    dateInput.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.equal(all(view.container, '.dsh-ut-editor select')[0].disabled, false)
  await view.unmount()
})

await check('the settings sheet saves the reminder preferences', async () => {
  const host = fakeHost([])
  const view = await render(page, { t: key => half.dictionaries['user-todo'].en[key] ?? key })
  await settle()
  const gear = all(view.container, '.dsh-ut-header-tools .dsh-ut-icon-button')[0]
  await act(async () => { gear.click() })
  await settle()
  assert.match(view.container.textContent, /Push reminders when due/)
  const save = all(view.container, '.dsh-ut-sheet .dsh-ut-button').find(button => button.textContent === 'Save settings')
  await act(async () => { save.click() })
  await settle()
  assert.equal(host.calls.at(-1).action, 'setPrefs')
  assert.equal(host.calls.at(-1).prefs.pushReminders, true)
  await view.unmount()
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

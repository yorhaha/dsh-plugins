/**
 * Deterministic behaviour checks for the dsh-bilibili bundle.
 *
 * Mounts the real plugin through a stub context whose storage domain, credential
 * store, and HTTP transport are scripted, then exercises the paths the live API
 * cannot produce on demand: domain commit and deduplication, search and detail
 * projection, the failure a missing credential produces, QR sign-in against a
 * scripted passport service, and the settings bridge.
 *
 * Offline: run `node tests/verify-behavior.mjs` from the plugin directory after
 * `pnpm install`.
 */
import { readFile } from 'node:fs/promises'

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as plugin from '../index.js'
import { bilibiliDomainSpec } from '../src/spec.js'
import { followingToItem } from '../src/mapping.js'
import { qrMatrix, qrSvgDataUrl } from '../src/qr.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const show = (value) => JSON.stringify(value ?? null)

/** Every leaf of a nested dictionary, as dotted key paths. */
function flatten(node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return typeof value === 'object' && value !== null ? flatten(value, path) : [[path, value]]
  })
}

// ── stub infrastructure ─────────────────────────────────────────────────────

/** In-memory stand-in for the credentials service, keeping payloads verbatim. */
function fakeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }
}

/**
 * In-memory stand-in for the storage domain, validating every stored record
 * through the real spec schemas so a schema/record mismatch fails here rather
 * than at the next open.
 */
function fakeStorageDomain() {
  const tables = new Map()
  const tableFor = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  let global = null
  let opened = false
  return {
    tables,
    get globalValue() {
      return global
    },
    get isOpen() {
      return opened
    },
    async open(spec) {
      if (opened) throw new Error('already-open')
      opened = true
      global = structuredClone(spec.global.initial)
      const schemas = Object.fromEntries(
        Object.entries(spec.tables).map(([name, entry]) => [name, entry.valueSchema]),
      )
      const validate = (name, value) => {
        const parsed = schemas[name].safeParse(value)
        if (!parsed.success) throw new Error(`invalid-record ${name}: ${parsed.error.message}`)
        return parsed.data
      }
      return {
        name: spec.name,
        global: {
          get: () => global,
          set: async (value) => {
            const parsed = spec.global.schema.safeParse(value)
            if (!parsed.success) throw new Error(`invalid-global: ${parsed.error.message}`)
            global = parsed.data
          },
        },
        table: (name) => {
          const store = tableFor(name)
          const checked = (value) => validate(name, value)
          return {
            get: (key) => store.get(key),
            entries: () => [...store.entries()][Symbol.iterator](),
            keys: () => [...store.keys()][Symbol.iterator](),
            get size() {
              return store.size
            },
            put: async (key, value) => {
              store.set(key, checked(value))
            },
            delete: async (key) => store.delete(key),
            update: async (key, fn) => {
              const next = checked(fn(store.get(key)))
              store.set(key, next)
              return next
            },
          }
        },
        close: async () => {
          opened = false
        },
      }
    },
  }
}

/** Minimal Cordis-shaped context: real registries, scripted optional services. */
function fakeCtx({ credentials, storageDomain, optional = {} }) {
  const tools = new Map()
  const effects = []
  const services = { ...optional }
  const waiting = []

  /** Run one inject callback against a child context carrying its services. */
  const settle = (deps, callback) => {
    const child = Object.create(ctx)
    for (const name of deps) child[name] = services[name]
    callback(child, undefined)
  }

  const ctx = {
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    credentials,
    storageDomain,
    get: (name) => services[name],
    effect(body) {
      const result = body()
      effects.push(result)
      return result
    },
    inject(deps, callback) {
      if (deps.every((name) => services[name] !== undefined)) {
        settle(deps, callback)
        return { dispose: async () => {} }
      }
      waiting.push({ deps, callback })
      return { dispose: async () => {} }
    },
    /** Publish a service late, as the Loader settling its siblings does. */
    provide(name, value) {
      services[name] = value
      for (const entry of [...waiting]) {
        if (entry.deps.every((dep) => services[dep] !== undefined)) {
          waiting.splice(waiting.indexOf(entry), 1)
          settle(entry.deps, entry.callback)
        }
      }
    },
  }
  return { ctx, tools, effects }
}

/** One JSON response for the scripted transport. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Install a scripted global fetch.
 * @param routes - path substring -> builder returning the response body or a Response.
 * @returns the recorded requests plus a restore function.
 */
function scriptFetch(routes) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    for (const [fragment, build] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        const built = build(url, init)
        return built instanceof Response ? built : jsonResponse(built)
      }
    }
    return jsonResponse({ code: -404, message: 'not scripted' })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** Minimal job registry: runs the producer at once and lets the test await it. */
function fakeJobs() {
  const started = []
  return {
    started,
    start(spec) {
      const id = `bilibili-sync-${started.length + 1}`
      const hooks = spec.run({ id, append() {}, updateProgress() {} })
      started.push({ spec, hooks })
      return id
    },
  }
}

const NAV_OK = {
  code: 0,
  data: { isLogin: true, mid: 12345, uname: 'tester' },
}

// ── A. the plugin mounts and declares enforceable schemas ───────────────────

const credentials = fakeCredentials()
const storageDomain = fakeStorageDomain()
const jobs = fakeJobs()
const { ctx, tools } = fakeCtx({ credentials, storageDomain, optional: { jobs } })
const dispose = await plugin.apply(ctx, {})

check('A mounted four tools', tools.size === 4, show([...tools.keys()].sort()))
for (const [name, definition] of tools) {
  let ok = true
  let detail = ''
  try {
    assertSupportedJsonSchema(definition.parameters)
    assertSupportedJsonSchema(definition.output.schema)
  } catch (error) {
    ok = false
    detail = error.message
  }
  check(`A ${name} schemas are enforceable`, ok, detail)
}

// ── A2. config and mapping contracts ────────────────────────────────────────

for (const cron of ['61 * * * *', '0 25 * * *', '0 9 * * 8', '0 9 * *', '*/0 * * * *', '5/2 * * * *']) {
  let code = 'accepted'
  try {
    plugin.resolveConfig({ scheduleCron: cron })
  } catch (error) {
    code = error.message
  }
  check(`A2 rejects the cron "${cron}" at load`, code !== 'accepted', code)
}
check(
  'A2 accepts and keeps a valid stepped cron',
  plugin.resolveConfig({ scheduleCron: '*/15 9-17 * * 1-5' }).scheduleCron === '*/15 9-17 * * 1-5',
)
const followed = followingToItem({ mid: 42, uname: 'Alice', mtime: 1_700_000_000 })
check(
  'A2 a followed account keeps one content key across follow times',
  followed.metadata.content_key === 'following:42',
  followed.metadata.content_key,
)

// ── B. a capture commits, deduplicates, and advances the cursor ─────────────

credentials.records.set('bilibili/default', {
  kind: 'grant',
  payload: { sessdata: 'x', dedeuserid: '12345', buvid3: 'b3', buvid4: 'b4' },
})

const watchLaterEntry = (aid, addAt) => ({
  aid,
  add_at: addAt,
  title: `Video ${aid}`,
  bvid: `BV${aid}`,
  upper: { name: `Uploader ${aid}` },
  duration: 300,
})

{
  const transport = scriptFetch({
    '/x/web-interface/nav': () => NAV_OK,
    '/x/v2/history/toview': () => ({
      code: 0,
      data: { list: [watchLaterEntry(101, 1700000001), watchLaterEntry(102, 1700000002)] },
    }),
  })
  const value = await tools.get('bilibili_sync').execute({ datasets: ['watch_later'] }, {})
  check('B sync hands the work to a background job',
    value.status === 'started' && value.jobId === 'bilibili-sync-1', show(value))
  const outcome = await jobs.started[0].hooks.done
  transport.restore()
  check('B the job settled completed', outcome.status === 'completed', show(outcome.status))
  check('B the corpus stored both items', storageDomain.tables.get('items')?.size === 2,
    show(storageDomain.tables.get('items')?.size))
  const cursor = storageDomain.tables.get('cursors')?.get('watch_later')
  check('B the dataset cursor advanced', cursor?.lastSuccessAt !== null && cursor?.state !== undefined, show(cursor?.itemCount))
  check('B the platform status recorded success', storageDomain.globalValue.lastRunStatus === 'succeeded',
    show(storageDomain.globalValue.lastRunStatus))
  check('B the job result carries the per-dataset counts',
    JSON.parse(outcome.result).datasets.watch_later.added === 2, show(outcome.result))
}

// ── C. a second identical capture is a no-op ────────────────────────────────

{
  const transport = scriptFetch({
    '/x/web-interface/nav': () => NAV_OK,
    '/x/v2/history/toview': () => ({
      code: 0,
      data: { list: [watchLaterEntry(101, 1700000001), watchLaterEntry(102, 1700000002)] },
    }),
  })
  await tools.get('bilibili_sync').execute({ datasets: ['watch_later'] }, {})
  const outcome = await jobs.started[1].hooks.done
  transport.restore()
  check('C the re-capture wrote nothing new', storageDomain.tables.get('items').size === 2,
    show(storageDomain.tables.get('items').size))
  check('C the re-capture reported both items unchanged',
    JSON.parse(outcome.result).datasets.watch_later.unchanged === 2, show(outcome.result))
  check('C nothing was reported as new on the re-capture',
    JSON.parse(outcome.result).datasets.watch_later.added === 0, show(outcome.result))
  // The capture-time filter is only precise because re-reading a record leaves
  // its lastSeenAt alone; otherwise every run would re-report the whole corpus.
  const afterRecapture = new Date().toISOString()
  check('C a merely re-confirmed record is not reported as recently seen',
    (await tools.get('bilibili_search').execute({ seenSince: afterRecapture }, {})).total === 0,
    show(afterRecapture))
}

// ── C2. a record whose content changed is updated, not added ────────────────

{
  const transport = scriptFetch({
    '/x/web-interface/nav': () => NAV_OK,
    '/x/v2/history/toview': () => ({
      code: 0,
      data: {
        list: [
          { ...watchLaterEntry(101, 1700000001), title: 'Video 101, retitled' },
          watchLaterEntry(102, 1700000002),
        ],
      },
    }),
  })
  await tools.get('bilibili_sync').execute({ datasets: ['watch_later'] }, {})
  const outcome = await jobs.started[2].hooks.done
  transport.restore()
  const counts = JSON.parse(outcome.result).datasets.watch_later
  check('C2 a changed record counts as updated, not added',
    counts.updated === 1 && counts.added === 0 && counts.unchanged === 1, show(counts))
  check('C2 the corpus still holds one record for it', storageDomain.tables.get('items').size === 2,
    show(storageDomain.tables.get('items').size))
  const renamed = [...storageDomain.tables.get('items').values()]
    .find((item) => item.title === 'Video 101, retitled')
  check('C2 the stored record carries the new title and keeps its first sighting',
    renamed !== undefined && renamed.firstSeenAt <= renamed.lastSeenAt,
    show({ title: renamed?.title, firstSeenAt: renamed?.firstSeenAt }))
}

// ── D. search and detail return values their schemas accept ─────────────────

{
  const search = tools.get('bilibili_search')
  const value = await search.execute({ query: 'video 101' }, {})
  const searchProblems = validateJsonSchemaValue(search.output.schema, value)
  check('D search value satisfies its schema', searchProblems.length === 0, searchProblems.join('; '))
  check('D search matched the title', value.total === 1 && value.items[0].id === 'watch_later:101:1700000001', show(value.items))
  check('D search built the public URL', value.items[0].url === 'https://www.bilibili.com/video/BV101', show(value.items[0].url))
  check('D search reports freshness', value.sync.stale === false && value.sync.running === false, show(value.sync))

  check('D search by upstream field', (await search.execute({ query: 'BV102' }, {})).total === 1)

  const padded = await search.execute({ query: '  video 101  ' }, {})
  check(
    'D a padded query matches and still produces a snippet',
    padded.total === 1 && typeof padded.items[0].snippet === 'string' && padded.items[0].snippet.length > 0,
    show(padded.items[0]?.snippet),
  )

  // Upstream time says when the thing happened; only a capture-time filter can
  // answer "what did that capture touch". Favorites carry upstream dates years
  // old, so `since` cannot stand in for it.
  const all = await search.execute({}, {})
  const now = new Date().toISOString()
  check('D a future capture-time bound matches nothing',
    (await search.execute({ seenSince: '2099-01-01T00:00:00.000Z' }, {})).total === 0)
  check('D a past capture-time bound matches everything',
    (await search.execute({ seenSince: '2000-01-01T00:00:00.000Z' }, {})).total === all.total,
    show(all.total))
  check('D a bound after this capture matches nothing yet',
    (await search.execute({ seenSince: now }, {})).total === 0, show(now))
  check('D dataset filter excludes', (await search.execute({ dataset: 'favorites' }, {})).total === 0)
  check('D a later since bound excludes the records',
    (await search.execute({ since: '2024-01-01T00:00:00.000Z' }, {})).total === 0)
  check('D an earlier since bound keeps them',
    (await search.execute({ since: '2020-01-01T00:00:00.000Z' }, {})).total === 2)
  check('D an until bound excludes them',
    (await search.execute({ until: '2020-01-01T00:00:00.000Z' }, {})).total === 0)
  // A bound carrying an offset names the same instant as its Z form, but it is
  // a different string; resolving it before the store compares keeps rows from
  // falling between the two spellings.
  check('D an offset-bearing since bound resolves to its instant',
    (await search.execute({ since: '2023-11-15T00:00:00+08:00' }, {})).total === 2)
  check('D an offset-bearing until bound resolves to its instant',
    (await search.execute({ until: '2023-11-14T22:00:00-08:00' }, {})).total === 2)
  const offsetNow = new Date(Date.now() - 3_600_000 + 8 * 3_600_000).toISOString().replace('Z', '+08:00')
  check('D an offset-bearing capture bound resolves to its instant',
    (await search.execute({ seenSince: offsetNow }, {})).total === all.total, show(offsetNow))
  let rejected = false
  try {
    await search.execute({ since: 'yesterday' }, {})
  } catch {
    rejected = true
  }
  check('D a malformed bound is rejected', rejected)
  check('D limit clamps', (await search.execute({ limit: 1 }, {})).returned === 1)

  const itemTool = tools.get('bilibili_item')
  const found = await itemTool.execute({ id: 'watch_later:101:1700000001' }, {})
  const missing = await itemTool.execute({ id: 'nope' }, {})
  const itemProblems = [found, missing].flatMap(item => validateJsonSchemaValue(itemTool.output.schema, item))
  check('D both item answers satisfy the declared schema', itemProblems.length === 0, itemProblems.join('; '))
  check('D item returns the full record', found.found === true && found.item.metadata.aid === '101', show(found.item?.title))
  check('D unknown id is reported, not thrown', missing.found === false, show(missing))
}

// ── E. the settings bridge answers and refuses unknown actions ──────────────

{
  const handler = {}
  const bridgeCredentials = fakeCredentials()
  const bridgeDomain = fakeStorageDomain()
  const { ctx: bridgeCtx } = fakeCtx({
    credentials: bridgeCredentials,
    storageDomain: bridgeDomain,
    optional: {
      connection: { fetch: { register: (route) => { handler.route = route; return () => {} } } },
      schedule: undefined,
    },
  })
  await plugin.apply(bridgeCtx, {})
  check('E the bridge registered under /api', handler.route?.path === '/api/plugin-bilibili', show(handler.route?.path))

  const post = (body) =>
    handler.route.fetch(new Request('http://harness.test/api/plugin-bilibili', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))

  const status = await (await post({ action: 'status' })).json()
  check('E status reports an unauthorized account', status.ok === true && status.value.authorized === false, show(status.value?.authorized))
  check('E status reports every dataset', status.value.datasets.length === 5, show(status.value?.datasets?.length))
  check('E status carries the freshness flag', status.value.sync.stale === true, show(status.value?.sync))

  const unknown = await post({ action: 'nope' })
  check('E unknown action is rejected', unknown.status === 400 && (await unknown.json()).error.code === 'unknown_action')

  const malformed = await handler.route.fetch(new Request('http://harness.test/api/plugin-bilibili', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  }))
  check('E malformed body is rejected', malformed.status === 400 && (await malformed.json()).error.code === 'invalid_json')

  const get = await handler.route.fetch(new Request('http://harness.test/api/plugin-bilibili?action=status'))
  check('E GET reads status', get.status === 200 && (await get.json()).ok === true)

  // The Loader mounts Connection while settling sibling rows, so reading it once
  // during apply drops the route silently: the page then sees a 404 it cannot
  // tell apart from a wrong URL, and reports a signed-in account as missing.
  const late = {}
  const { ctx: lateCtx } = fakeCtx({ credentials: fakeCredentials(), storageDomain: fakeStorageDomain() })
  await plugin.apply(lateCtx, {})
  check('E no route exists before Connection mounts', late.route === undefined)
  lateCtx.provide('connection', {
    fetch: {
      register: (route) => {
        late.route = route
        return () => {}
      },
    },
  })
  check('E the route appears when Connection mounts later',
    late.route?.path === '/api/plugin-bilibili' && typeof late.route.fetch === 'function',
    show(late.route?.path))
  const lateStatus = await (await late.route.fetch(new Request('http://harness.test/api/plugin-bilibili', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'status' }),
  }))).json()
  check('E the late route serves the same surface', lateStatus.ok === true && lateStatus.value.datasets.length === 5,
    show(lateStatus.value?.datasets?.length))
}

// ── F. sign-in drives the passport exchange and stores the session ──────────

{
  const loginCredentials = fakeCredentials()
  const loginDomain = fakeStorageDomain()
  const bridge = {}
  const { ctx: pageCtx } = fakeCtx({
    credentials: loginCredentials,
    storageDomain: loginDomain,
    optional: { connection: { fetch: { register: (route) => { bridge.route = route; return () => {} } } } },
  })
  // The login client captures the global transport when it is constructed, so
  // the scripted one has to be in place before the plugin mounts.
  const transport = scriptFetch({
    '/x/passport-login/web/qrcode/generate': () => ({
      code: 0,
      data: { url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=abc', qrcode_key: 'abc' },
    }),
    '/x/passport-login/web/qrcode/poll': () => ({
      code: 0,
      data: {
        code: 0,
        url: 'https://passport.bilibili.com/login?SESSDATA=sess%2Fvalue&DedeUserID=12345&buvid3=b3&buvid4=b4',
      },
    }),
    '/x/web-interface/nav': () => NAV_OK,
  })
  try {
  await plugin.apply(pageCtx, { loginTimeoutSeconds: 30 })
  const ask = async (body) =>
    (await bridge.route.fetch(new Request('http://harness.test/api/plugin-bilibili', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))).json()

  const begin = await ask({ action: 'login.begin' })
  check('F begin returns a challenge', begin.ok === true && begin.value.state === 'waiting', show(begin.value?.state))
  check('F begin returns a scannable image', typeof begin.value.qrImage === 'string'
    && begin.value.qrImage.startsWith('data:image/svg+xml;base64,'), show(begin.value?.qrImage?.slice(0, 32)))
  await new Promise((resolve) => setTimeout(resolve, 2600))
  const state = await ask({ action: 'login.state' })
  check('F the session was stored', loginCredentials.records.get('bilibili/default')?.payload?.sessdata === 'sess/value',
    show(loginCredentials.records.get('bilibili/default')?.payload?.sessdata))
  check('F the state is observable', state.value.state === 'confirmed', show(state.value?.state))

  // A page that gates capture on a known account must not have to run a capture
  // to learn one: sign-in proves the identity and has to record it.
  const afterLogin = await ask({ action: 'status' })
  check('F sign-in recorded the account without a capture',
    afterLogin.value.authorized === true && afterLogin.value.account?.mid === '12345',
    show({ authorized: afterLogin.value.authorized, account: afterLogin.value.account }))

  const signedOut = await ask({ action: 'signout' })
  check('F sign-out clears the session and the account',
    loginCredentials.records.has('bilibili/default') === false && signedOut.value.account === null,
    show(signedOut.value?.account))
  } finally {
    transport.restore()
  }
}

// ── G. a missing credential fails the capture with a stable code ────────────

{
  const emptyCredentials = fakeCredentials()
  const emptyDomain = fakeStorageDomain()
  const { ctx: emptyCtx, tools: emptyTools } = fakeCtx({ credentials: emptyCredentials, storageDomain: emptyDomain })
  await plugin.apply(emptyCtx, {})
  const sync = emptyTools.get('bilibili_sync')
  // No job registry here, so the tool runs the capture inline and returns its outcome.
  const value = await sync.execute({}, {})
  const syncProblems = validateJsonSchemaValue(sync.output.schema, value)
  check('G the sync value satisfies its schema', syncProblems.length === 0, syncProblems.join('; '))
  check('G capture without a credential reports the code',
    value.ok === false && value.errorCodes.includes('credential_unavailable'), show(value))
  check('G the failed capture is not recorded as a success',
    emptyDomain.globalValue.lastRunStatus === 'failed'
    && emptyDomain.globalValue.lastErrorCode === 'credential_unavailable',
    show(emptyDomain.globalValue.lastErrorCode))

  const search = emptyTools.get('bilibili_search')
  const searched = await search.execute({}, {})
  check('G an empty corpus searches cleanly', searched.total === 0 && searched.sync.stale === true, show(searched.sync))

  let refused = false
  try {
    await sync.execute({ datasets: [] }, {})
  } catch {
    refused = true
  }
  check('G refuses an empty dataset selection instead of capturing everything', refused)
}

// ── H. the QR encoder produces a structurally valid symbol ──────────────────

{
  const url = 'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=8f2a4c1d9e&from=main-fe-header'
  const matrix = qrMatrix(url)
  const size = matrix.length
  check('H symbol is square and version-sized', matrix.every((row) => row.length === size) && (size - 17) % 4 === 0,
    show(size))
  const finder = [
    [true, true, true, true, true, true, true],
    [true, false, false, false, false, false, true],
    [true, false, true, true, true, false, true],
    [true, false, true, true, true, false, true],
    [true, false, true, true, true, false, true],
    [true, false, false, false, false, false, true],
    [true, true, true, true, true, true, true],
  ]
  const matchesFinder = (top, left) =>
    finder.every((row, dy) => row.every((want, dx) => matrix[top + dy][left + dx] === want))
  check('H all three finder patterns are present',
    matchesFinder(0, 0) && matchesFinder(0, size - 7) && matchesFinder(size - 7, 0))
  check('H the dark module is dark', matrix[4 * ((size - 17) / 4) + 9][8] === true)
  check('H the timing pattern alternates',
    Array.from({ length: size - 16 }, (_, index) => matrix[6][8 + index] === (index % 2 === 0)).every(Boolean))

  const dataUrl = qrSvgDataUrl(url)
  const svg = Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8')
  const dark = matrix.flat().filter(Boolean).length
  check('H the SVG carries one rectangle per dark module',
    (svg.match(/M/g) ?? []).length === dark, `${(svg.match(/M/g) ?? []).length} vs ${dark}`)
  check('H the SVG scales the symbol', svg.includes(`viewBox="0 0 ${(size + 8) * 8} ${(size + 8) * 8}"`), show(svg.slice(0, 120)))
  let refused = false
  try {
    qrMatrix('x'.repeat(400))
  } catch {
    refused = true
  }
  check('H an oversized payload is refused loudly', refused)
}

// ── J. the browser half loads, registers, and covers every string it asks for ─

{
  const source = await readFile(new URL('../web/client.js', import.meta.url), 'utf8')
  let registration = null
  // The bundle is served as a classic script, so it self-registers on a global
  // the loader provides; stand that in and capture what it hands over.
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  const stubReact = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const moduleUrl = new URL('../web/client.js', import.meta.url).href
  await import(`${moduleUrl}?verify=${Date.now()}`)
  delete globalThis.window
  check('J the bundle self-registers under its package name', registration?.id === 'dsh-bilibili',
    show(registration?.id))

  const dictionaries = {}
  let slot = null
  const clientCtx = {
    locale: {
      bind: (ns) => (key) => `${ns}:${key}`,
      register: (ns, value) => {
        dictionaries.ns = ns
        Object.assign(dictionaries, value)
        return () => {}
      },
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (options) => {
        slot = options
        return () => {}
      },
    },
    effect: (body) => body(),
  }
  const clientPlugin = registration.factory((name) => {
    if (name === 'react') return stubReact
    throw new Error(`the browser half required "${name}", which is not a platform seed module`)
  })
  check('J it declares the services it needs',
    Array.isArray(clientPlugin.inject) && clientPlugin.inject.includes('slots')
    && clientPlugin.inject.includes('locale'), show(clientPlugin.inject))
  clientPlugin.apply(clientCtx)
  check('J it registers both dictionaries', dictionaries.ns === 'settings.bilibili'
    && typeof dictionaries.en?.accountHeading === 'string' && typeof dictionaries.zh?.accountHeading === 'string',
    show(dictionaries.ns))
  check('J it configures this bundle\'s own page', slot?.name === 'plugins.bundle.config'
    && slot.key === 'dsh-bilibili' && slot.locale === 'settings.bilibili',
    show({ name: slot?.name, key: slot?.key }))

  // Every literal key the component asks for must resolve in both languages.
  const keys = new Set([...source.matchAll(/\bt\('([A-Za-z][\w.]*)'/g)].map((match) => match[1]))
  for (const dataset of ['history', 'watch_later', 'favorites', 'following', 'self_dynamic']) {
    keys.add(`datasets.${dataset}`)
  }
  // The locale service indexes a dictionary by exact key; walking `key.split('.')`
  // would accept copy the service can never reach.
  const resolve = (dictionary, key) => dictionary[key]
  const missing = []
  for (const key of keys) {
    if (key === 'datasets') continue
    for (const language of ['en', 'zh']) {
      if (typeof resolve(dictionaries[language], key) !== 'string') missing.push(`${language}:${key}`)
    }
  }
  check('J every requested string exists in both languages', missing.length === 0,
    `${keys.size} keys checked${missing.length === 0 ? '' : `; missing ${missing.join(', ')}`}`)

  // The reverse: a string nobody asks for is dead weight in two languages.
  // Dataset labels are built from a template, so their keys are used without a
  // literal call site.
  const unused = []
  for (const [key, text] of flatten(dictionaries.en)) {
    if (typeof text !== 'string' || keys.has(key) || key.startsWith('datasets.')) continue
    unused.push(key)
  }
  check('J no string is left unused', unused.length === 0, unused.join(', '))

  // A translated string must not promise a placeholder its caller never passes.
  const placeholders = new Set([...source.matchAll(/\bt\('[^']+',\s*\{([^}]*)\}/g)]
    .flatMap((match) => [...match[1].matchAll(/(\w+)\s*:/g)].map((named) => named[1])))
  const unknown = []
  for (const language of ['en', 'zh']) {
    for (const key of keys) {
      const text = resolve(dictionaries[language], key)
      if (typeof text !== 'string') continue
      for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
        if (!placeholders.has(name) && !['count', 'name', 'mid', 'when', 'code', 'seconds', 'message'].includes(name)) {
          unknown.push(`${language}:${key}:{${name}}`)
        }
      }
    }
  }
  check('J every placeholder is one the caller supplies', unknown.length === 0,
    unknown.length === 0 ? `${placeholders.size} call-site parameters` : unknown.join(', '))
}

// ── K. the page never claims an account state it has not read ───────────────

{
  // A Harness restart leaves an open page with no loaded status. Rendering that
  // as "signed out" states something the page cannot know, and it is what made a
  // surviving session look lost.
  let registration = null
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  const states = []
  const tree = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const stubReact = {
    createElement: tree,
    useState: () => [states.shift(), () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const clientUrl = new URL('../web/client.js', import.meta.url).href
  await import(`${clientUrl}?render=${Date.now()}`)
  delete globalThis.window

  let Component = null
  registration.factory((name) => {
    if (name === 'react') return stubReact
    throw new Error(`unexpected require(${name})`)
  }).apply({
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: { inject: (n, cb) => cb(), register: (options, component) => { Component = component; return () => {} } },
    effect: (body) => body(),
  })

  /** Render one state and return the account card's rendered keys. */
  const accountCard = (status) => {
    states.length = 0
    states.push(status, null, null, null, false, null)
    const rendered = Component({ t: (key) => key })
    const texts = (node) => {
      if (typeof node === 'string') return [node]
      if (node === null || typeof node !== 'object') return []
      // A button carries its label as a prop, not as a child.
      const own = typeof node.props?.label === 'string' ? [node.props.label] : []
      return [...own, ...(node.children ?? []).flatMap(texts)]
    }
    return rendered.children.filter((child) => child?.type === 'div')[0].children.flatMap(texts)
  }

  const unloaded = accountCard(null)
  check('K an unread status renders neither claim',
    unloaded.includes('loading') && !unloaded.includes('signedOut') && !unloaded.includes('signIn'),
    show(unloaded))

  const signedOut = accountCard({ authorized: false, account: null, sync: null, datasets: [], schedule: null })
  check('K an unauthorized account offers sign-in',
    signedOut.includes('signedOut') && signedOut.includes('signIn'), show(signedOut))

  const signedIn = accountCard({
    authorized: true,
    account: { mid: '123456789', name: null },
    sync: null,
    datasets: [],
    schedule: null,
  })
  check('K an authorized account reports itself and offers sign-out',
    signedIn.includes('signedInAsId') && signedIn.includes('signOut') && !signedIn.includes('signIn'),
    show(signedIn))

  // The gate that made capture impossible: a session with no learned name yet.
  const nameless = accountCard({
    authorized: true,
    account: null,
    sync: null,
    datasets: [],
    schedule: null,
  })
  check('K an authorized account with no learned name is still signed in',
    nameless.includes('signedIn') && !nameless.includes('signedOut'), show(nameless))
}

// ── teardown ────────────────────────────────────────────────────────────────

await dispose()
check('I the lifecycle disposer released the domain', storageDomain.isOpen === false, show(storageDomain.isOpen))

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\nFAILED: ${failures.join(', ')}`)
process.exitCode = failures.length === 0 ? 0 : 1

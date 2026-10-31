/**
 * Deterministic behaviour checks for the dsh-outlook bundle.
 *
 * Mounts the real plugin through a stub context whose credential store, job
 * registry, schedule service, and HTTP transport are scripted, then exercises
 * the paths a live mailbox cannot produce on demand: corpus commit and
 * deduplication, Chinese and Latin search, the failures each Graph status maps
 * to, one capture's cursor and backoff bookkeeping, the zone a search bound is
 * read in, the scopes a stored sign-in was granted, tool output against its
 * declared schema, the settings bridge, and the mail-only schema migration.
 *
 * Offline: run `node tests/verify-behavior.mjs` from the plugin directory after
 * `pnpm install`.
 */
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as plugin from '../index.js'
import { GraphClient, GraphError } from '../src/graph.js'
import { messageToRecord, resolveExcludedFolders } from '../src/mail.js'
import { OutlookSyncer, errorCode } from '../src/sync.js'
import { openStore } from '../src/store.js'
import { segmentForIndex, toMatchExpression } from '../src/text.js'
import { parseGraphDateTime } from '../src/time.js'
import { buildTools } from '../src/tools.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const show = (value) => JSON.stringify(value ?? null)

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

/** Schedule service stand-in shaped like the real catalog. */
function fakeSchedule() {
  const tasks = []
  return {
    tasks,
    async catalog() {
      return tasks.map((task) => ({ ...task }))
    },
    async create(sessionId, request) {
      const task = {
        id: `task-${tasks.length + 1}`,
        sessionId,
        title: request.title,
        prompt: request.prompt,
        cron: request.cron,
        kind: 'recurring',
        status: 'active',
        scheduledAt: '2026-10-14T01:00:00.000Z',
      }
      tasks.push(task)
      return { ...task }
    },
    async delete(request) {
      const at = tasks.findIndex((task) => task.id === request.id)
      if (at >= 0) tasks.splice(at, 1)
      return { deleted: at >= 0 }
    },
  }
}

/**
 * Mount the plugin the way the Loader does, against scripted services.
 * @param options - Mount options.
 * @param options.databasePath - Corpus path for this mount.
 * @param options.config - Configuration overrides.
 * @returns the mount handle.
 */
async function mount({ databasePath, config = {}, withhold = [] }) {
  const credentials = fakeCredentials()
  const schedule = fakeSchedule()
  const registered = []
  const effects = []
  const routes = []
  const services = {
    schedule,
    jobs: undefined,
    settings: undefined,
    sessionController: { list: async () => ({ items: [{ sessionId: 'session-1' }] }) },
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
    },
  }
  // Withheld services mount later, as sibling Loader rows do.
  for (const name of withhold) delete services[name]
  const waiting = []
  /** Run one inject callback against a child context carrying its services. */
  const settle = (deps, callback) => {
    const child = Object.create(ctx)
    for (const name of deps) child[name] = services[name]
    callback(child, undefined)
  }
  const ctx = {
    credentials,
    logger: { info() {}, warn() {}, debug() {} },
    fiber: { entry: { options: { id: 'outlook' } } },
    tools: { register: (tool) => registered.push(tool) },
    get: (key) => services[key],
    effect: (run) => {
      const started = run()
      effects.push(started)
      return () => {}
    },
    inject: (deps, callback) => {
      if (deps.every((name) => services[name] !== undefined)) {
        settle(deps, callback)
        return { dispose: async () => {} }
      }
      waiting.push({ deps, callback })
      return { dispose: async () => {} }
    },
    /** Publish a service late, as the Loader settling its siblings does. */
    provide: (name, value) => {
      services[name] = value
      for (const entry of [...waiting]) {
        if (entry.deps.every((dep) => services[dep] !== undefined)) {
          waiting.splice(waiting.indexOf(entry), 1)
          settle(entry.deps, entry.callback)
        }
      }
    },
  }
  plugin.apply(ctx, plugin.Config({
    accountId: 'default',
    clientId: '',
    tenant: 'common',
    scopes: ['Mail.Read'],
    databasePath,
    scheduleCron: '0 9 * * *',
    mailInitialDays: 90,
    reconcileDays: 3,
    mailMaxPages: 60,
    backfillMaxPages: 20,
    bodyMaxBytes: 262_144,
    timeZone: 'Asia/Shanghai',
    loginTimeoutSeconds: 300,
    ...config,
  }))
  const disposers = (await Promise.all(effects)).filter((value) => typeof value === 'function')
  return { credentials, schedule, registered, services, routes, ctx, dispose: async () => { for (const dispose of disposers) await dispose() } }
}

const directory = await mkdtemp(join(tmpdir(), 'outlook-behavior-'))
const databasePath = join(directory, 'corpus.db')

// ── A. text preparation ─────────────────────────────────────────────────────

check('A1 CJK characters are indexed one per token',
  segmentForIndex('产品评审') === '产 品 评 审', show(segmentForIndex('产品评审')))
check('A2 Latin words survive segmentation',
  segmentForIndex('Quarterly review') === 'Quarterly review', show(segmentForIndex('Quarterly review')))
check('A3 a CJK query becomes an adjacency phrase',
  toMatchExpression('会议') === '"会 议"', show(toMatchExpression('会议')))
check('A4 mixed queries become ANDed groups',
  toMatchExpression('会议 report') === '"会 议" AND "report"', show(toMatchExpression('会议 report')))
check('A5 FTS syntax in a query is neutralized',
  toMatchExpression('a" OR "b') === '"a" AND "OR" AND "b"', show(toMatchExpression('a" OR "b')))
check('A6 a query with no searchable token yields no expression',
  toMatchExpression('***') === null, show(toMatchExpression('***')))

// ── B. corpus store ─────────────────────────────────────────────────────────

const store = await openStore({ path: databasePath })
const mailRecords = [
  messageToRecord({
    id: 'm1',
    subject: '关于下周产品评审会议的时间安排',
    body: { content: '请确认下周三下午的评审会议时间，会议室已预订。' },
    from: { emailAddress: { name: '张三', address: 'zhang@example.com' } },
    toRecipients: [{ emailAddress: { name: null, address: 'me@example.com' } }],
    receivedDateTime: '2026-10-01T02:00:00Z',
    conversationId: 'c1',
    isRead: false,
    hasAttachments: true,
    webLink: 'https://outlook.office.com/mail/id/m1',
  }, { bodyMaxBytes: 262_144 }),
  messageToRecord({
    id: 'm2',
    subject: 'Quarterly review meeting',
    body: { content: 'The quarterly review is next Tuesday at 10:00.' },
    from: { emailAddress: { name: 'Jane', address: 'jane@example.com' } },
    receivedDateTime: '2026-10-02T02:00:00Z',
    conversationId: 'c2',
  }, { bodyMaxBytes: 262_144 }),
]
const seenAt = store.now()
const firstCommit = await store.commitMail({
  records: mailRecords,
  seenAt,
  bodyMaxBytes: 262_144,
  cursor: { state: { last_received: '2026-10-02T02:00:00.000Z' }, lastSuccessAt: seenAt, itemCount: 2, snapshotComplete: true },
})
check('B1 a first capture writes every record', firstCommit.written === 2 && firstCommit.unchanged === 0, show(firstCommit))
const secondCommit = await store.commitMail({
  records: mailRecords,
  seenAt: store.now(),
  bodyMaxBytes: 262_144,
  cursor: { state: {}, lastSuccessAt: store.now(), itemCount: 2, snapshotComplete: true },
})
check('B2 re-reading the same window changes nothing', secondCommit.written === 0 && secondCommit.unchanged === 2, show(secondCommit))

const chinese = store.search({ query: '会议', limit: 10, offset: 0 })
check('B3 a Chinese word finds the message that contains it', chinese.total === 1 && chinese.rows[0].title.startsWith('关于下周'), show(chinese.total))
const phrase = store.search({ query: '评审会议', limit: 10, offset: 0 })
check('B4 a Chinese phrase matches only adjacent characters', phrase.total === 1, show(phrase.total))
check('B5 a Latin word matches', store.search({ query: 'quarterly', limit: 10, offset: 0 }).total === 1)
check('B6 a Latin substring does not match', store.search({ query: 'eview', limit: 10, offset: 0 }).total === 0)
check('B7 a two-word Latin query requires both words', store.search({ query: 'review meeting', limit: 10, offset: 0 }).total === 1)
check('B8 an unmatched query returns nothing', store.search({ query: 'zzzz', limit: 10, offset: 0 }).total === 0)

const window = store.search({ since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z', limit: 10, offset: 0 })
check('B9 the time window is half-open', window.total === 1 && window.rows[0].title.startsWith('关于下周'), show(window.total))
check('B10 the participant filter matches an address',
  store.search({ from: 'zhang@example.com', limit: 10, offset: 0 }).total === 1)
check('B12 browsing without a query orders newest first',
  store.search({ limit: 10, offset: 0 }).rows[0].title === 'Quarterly review meeting')
check('B13 a snippet is taken from the stored original',
  chinese.rows[0].snippet.includes('评审会议时间'), show(chinese.rows[0].snippet))

const item = store.item(window.rows[0].id)
check('B14 an item reads back in full', item.body.includes('会议室已预订') && item.metadata.conversationId === 'c1', show(item.id))
check('B15 an unknown id reads back as absent', store.item('nope') === undefined)
check('B16 the count reports the corpus size', store.count() === 2, show(store.count()))

// ── C. time conversion ──────────────────────────────────────────────────────

check('C1 a wall-clock value is read in the requested zone',
  parseGraphDateTime('2026-10-13T09:00:00.0000000', 'Asia/Shanghai') === '2026-10-13T01:00:00.000Z',
  show(parseGraphDateTime('2026-10-13T09:00:00.0000000', 'Asia/Shanghai')))
check('C2 a value that carries an offset is taken as written',
  parseGraphDateTime('2026-10-13T09:00:00Z', 'Asia/Shanghai') === '2026-10-13T09:00:00.000Z')
check('C3 a daylight-saving boundary uses the offset in force at that instant',
  parseGraphDateTime('2026-03-08T03:00:00.0000000', 'America/New_York') === '2026-03-08T07:00:00.000Z',
  show(parseGraphDateTime('2026-03-08T03:00:00.0000000', 'America/New_York')))
check('C4 an unparseable value reads back as absent', parseGraphDateTime('', 'UTC') === null)

store.close()

// ── D. Graph client ─────────────────────────────────────────────────────────

/**
 * Scripted transport: one queued response per request.
 * @param responses - Response descriptors or a function of the request.
 * @returns the fetch function and the request log.
 */
function scriptedFetch(responses) {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ?? null,
    })
    const next = typeof responses === 'function'
      ? responses(url, requests.length, init ?? {})
      : responses.shift()
    if (next === undefined) throw new Error(`unscripted request: ${url}`)
    if (next.throws !== undefined) throw next.throws
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    })
  }
  return { fetchImpl, requests }
}

const retryScript = scriptedFetch([
  { status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 'TooManyRequests' } } },
  { status: 200, body: { value: [{ id: 'm1' }] } },
])
const sleeps = []
const retryClient = new GraphClient({
  auth: { accessToken: async () => 'token' },
  fetchImpl: retryScript.fetchImpl,
  sleep: async (ms) => sleeps.push(ms),
})
const retried = await retryClient.get('/me/messages')
check('D1 a throttled request is retried after Retry-After',
  retried.value.length === 1 && sleeps[0] === 1000, `${show(sleeps)} ${show(retried)}`)

const refreshScript = scriptedFetch([
  { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } },
  { status: 200, body: { value: [] } },
])
const tokens = ['stale', 'fresh']
const refreshClient = new GraphClient({
  auth: { accessToken: async () => tokens.shift() ?? 'fresh' },
  fetchImpl: refreshScript.fetchImpl,
  sleep: async () => {},
})
await refreshClient.get('/me/messages')
check('D2 a refused token is retried once against a new one',
  refreshScript.requests[1].headers.authorization === 'Bearer fresh',
  show(refreshScript.requests.map((request) => request.headers.authorization)))

const pagingScript = scriptedFetch([
  { status: 200, body: { value: [{ id: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?page=2' } },
  { status: 200, body: { value: [{ id: 'b' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=1' } },
])
const pagingClient = new GraphClient({
  auth: { accessToken: async () => 'token' },
  fetchImpl: pagingScript.fetchImpl,
  sleep: async () => {},
})
const pages = []
for await (const page of pagingClient.pages('/me/messages')) pages.push(page)
check('D3 paging follows next links to the end', pages.length === 2 && pages[1].value[0].id === 'b', show(pages.length))

const offOrigin = new GraphClient({
  auth: { accessToken: async () => 'token' },
  fetchImpl: scriptedFetch([]).fetchImpl,
  sleep: async () => {},
})
let offOriginCode = null
try {
  await offOrigin.get('https://evil.example/v1.0/me/messages')
} catch (error) {
  offOriginCode = error.code
}
check('D4 a next link off the configured origin is refused', offOriginCode === 'invalid_envelope', show(offOriginCode))

const failing = new GraphClient({
  auth: { accessToken: async () => 'token' },
  fetchImpl: scriptedFetch([{ status: 403, body: {} }]).fetchImpl,
  sleep: async () => {},
})
let forbiddenCode = null
try {
  await failing.get('/me/messages')
} catch (error) {
  forbiddenCode = error.code
}
check('D5 a refused scope maps to auth_required', forbiddenCode === 'auth_required', show(forbiddenCode))
check('D6 a transport failure maps to network_error', errorCode(new GraphError('network_error', 'x')) === 'network_error')

// A connection that accepts the request and then never answers. The client's
// own deadline must end the attempt; the caller passed no cancellation signal.
const stalled = new GraphClient({
  auth: { accessToken: async () => 'token' },
  fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }),
  sleep: async () => {},
  timeoutMs: 20,
})
let stalledCode = null
// The client's deadline timer is unref'd, so a checked-in keep-alive is what
// lets the event loop stay up long enough for it to fire.
const keepAlive = setInterval(() => {}, 1000)
try {
  await stalled.get('/me/messages')
} catch (error) {
  stalledCode = error.code
} finally {
  clearInterval(keepAlive)
}
check('D8 a request that never answers fails as timeout', stalledCode === 'timeout', show(stalledCode))

const tokenSleeps = []
const tokenFailureClient = new GraphClient({
  auth: {
    accessToken: async () => {
      throw Object.assign(new Error('no stored sign-in'), { code: 'auth_required' })
    },
  },
  fetchImpl: scriptedFetch([]).fetchImpl,
  sleep: async (ms) => tokenSleeps.push(ms),
})
let unreachableTokenCode = null
try {
  await tokenFailureClient.get('/me/messages')
} catch (error) {
  unreachableTokenCode = error.code
}
check('D7 a sign-in that cannot produce a token is reported as itself, not as a transport failure',
  unreachableTokenCode === 'auth_required' && tokenSleeps.length === 0,
  `${show(unreachableTokenCode)} ${show(tokenSleeps)}`)

let retryAttempts = 0
const retryFailureClient = new GraphClient({
  auth: { accessToken: async () => 'token' },
  fetchImpl: async () => {
    retryAttempts += 1
    throw new TypeError('socket hang up')
  },
  sleep: async () => {},
})
let retryFailureCode = null
try {
  await retryFailureClient.get('/me/messages')
} catch (error) {
  retryFailureCode = error.code
}
check('D9 a GET that keeps failing in transport is retried and then reports network_error',
  retryFailureCode === 'network_error' && retryAttempts === 4,
  `${show(retryFailureCode)} attempts=${retryAttempts}`)

let tokenCalls = 0
const forcedClient = new GraphClient({
  auth: {
    accessToken: async (options) => {
      tokenCalls += 1
      return options?.force === true ? 'fresh' : 'stale'
    },
  },
  fetchImpl: scriptedFetch([
    { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } },
    { status: 200, body: { value: [] } },
  ]).fetchImpl,
  sleep: async () => {},
})
const forcedBody = await forcedClient.get('/me/messages')
check('D10 a 401 retries with a forced token refresh',
  tokenCalls === 2 && forcedBody.value.length === 0,
  `calls=${tokenCalls} body=${show(forcedBody)}`)

const abortController = new AbortController()
const abortingClient = new GraphClient({
  auth: { accessToken: async () => 'token' },
  fetchImpl: async () => {
    throw new TypeError('down')
  },
  sleep: () => new Promise(() => {}),
  signal: abortController.signal,
})
const aborting = abortingClient.get('/me/messages')
setTimeout(() => abortController.abort(), 10)
let abortCode = null
try {
  await aborting
} catch (error) {
  abortCode = error.code
}
check('D11 cancellation ends a retry pause', abortCode === 'cancelled', show(abortCode))

// ── E. capture orchestration ────────────────────────────────────────────────

const orchestrationPath = join(directory, 'orchestration.db')
const orchestrationStore = await openStore({ path: orchestrationPath })
const messages = [{
  id: 'm9',
  subject: 'report',
  body: { content: 'see attached' },
  receivedDateTime: '2026-10-03T02:00:00Z',
}]
const fakeClient = {
  async *pages(path) {
    if (path === '/me/messages') yield { value: messages }
    else yield { value: [] }
  },
}
const syncerSettings = {
  clientId: 'client',
  tenant: 'common',
  scopes: ['Mail.Read'],
  bodyMaxBytes: 4096,
  initialDays: 90,
  reconcileDays: 3,
  mailMaxPages: 5,
  backfillMaxPages: 5,
}
const syncer = new OutlookSyncer({
  store: orchestrationStore,
  auth: { configured: true },
  settings: () => syncerSettings,
  createClient: () => fakeClient,
  clock: () => Date.parse('2026-10-10T00:00:00.000Z'),
})
const outcome = await syncer.run({ trigger: 'manual' })
check('E1 a capture commits its records and advances the cursor',
  outcome.ok === true && outcome.written === 1
  && orchestrationStore.mailState().state.last_received === '2026-10-03T02:00:00.000Z',
  show(outcome))
check('E2 a successful capture clears the auth flag', orchestrationStore.status().authRequired === false)
const concurrent = await Promise.all([
  syncer.run({ trigger: 'manual' }),
  syncer.run({ trigger: 'manual' }),
])
check('E3 a second capture while one runs is refused, not queued',
  concurrent.filter((result) => result.skipped === true && result.reason === 'busy').length === 1,
  show(concurrent.map((result) => result.reason)))

const failingSyncer = new OutlookSyncer({
  store: orchestrationStore,
  auth: { configured: true },
  settings: () => syncerSettings,
  createClient: () => ({
    async *pages(path) {
      if (path === '/me/messages') throw new GraphError('auth_required', 'refused', { status: 401 })
      yield { value: [] }
    },
  }),
  clock: () => Date.parse('2026-10-11T00:00:00.000Z'),
})
const failed = await failingSyncer.run({ trigger: 'agent' })
check('E4 a refused capture reports the failure and its code',
  failed.ok === false && failed.skipped === false && failed.reason === 'auth_required'
  && failed.status === 'failed' && failed.errorCodes.join() === 'auth_required',
  show(failed))
check('E5 a refused sign-in is recorded on the status row',
  orchestrationStore.status().authRequired === true && orchestrationStore.status().lastErrorCode === 'auth_required',
  show(orchestrationStore.status()))
check('E6 a failed capture keeps the position and records its code',
  orchestrationStore.mailState().lastErrorCode === 'auth_required'
  && orchestrationStore.mailState().state.last_received === '2026-10-03T02:00:00.000Z',
  show(orchestrationStore.mailState()))
const backedOff = await syncer.run({ trigger: 'agent' })
check('E7 a scheduled capture does not retry a refused sign-in',
  backedOff.skipped === true && backedOff.reason === 'auth_required', show(backedOff))
const unconfigured = new OutlookSyncer({
  store: orchestrationStore,
  auth: { configured: false },
  settings: () => syncerSettings,
  createClient: () => fakeClient,
})
check('E8 an unconfigured plugin captures nothing',
  (await unconfigured.run({ trigger: 'agent' })).reason === 'not_configured')
orchestrationStore.close()

// ── E2. excluded folders ────────────────────────────────────────────────────

/**
 * A Graph client that answers folder requests from a script and mail requests
 * with one page.
 * @param options - Scripted answers.
 * @param options.messages - Messages the mail request returns.
 * @param options.aliases - Well-known folder aliases, by name.
 * @param options.topLevel - Top-level folders listed under `/me/mailFolders`.
 * @returns the client.
 */
function folderClient({ messages = [], aliases = {}, topLevel = [] }) {
  return {
    get: async (path) => {
      const alias = decodeURIComponent(String(path).slice('/me/mailFolders/'.length))
      if (String(path).startsWith('/me/mailFolders/') && aliases[alias] !== undefined) return aliases[alias]
      if (path === '/me/mailFolders') return { value: topLevel }
      throw new GraphError('http_404', `no folder ${path}`, { status: 404 })
    },
    async *pages(path) {
      if (path === '/me/messages') yield { value: messages }
    },
  }
}

const folderStore = await openStore({ path: join(directory, 'folders.db') })
const folderMessages = [
  { id: 'x1', subject: 'lottery winner', receivedDateTime: '2026-10-05T02:00:00Z', parentFolderId: 'junk-folder' },
  { id: 'x2', subject: 'review meeting', receivedDateTime: '2026-10-05T03:00:00Z', parentFolderId: 'inbox-folder' },
]
const client = folderClient({
  messages: folderMessages,
  aliases: { junkemail: { id: 'junk-folder', displayName: '垃圾邮件' } },
})
const folderSyncer = (excludeFolders, clock) => new OutlookSyncer({
  store: folderStore,
  auth: { configured: true },
  settings: () => ({ ...syncerSettings, excludeFolders }),
  createClient: () => client,
  clock,
})
const unfiltered = await folderSyncer([], () => Date.parse('2026-10-06T00:00:00.000Z'))
  .run({ trigger: 'manual' })
check('E9 without an exclusion every folder is captured',
  unfiltered.written === 2 && folderStore.search({ query: 'lottery', limit: 10, offset: 0 }).total === 1,
  show(unfiltered))
const filtered = await folderSyncer(['junkemail'], () => Date.parse('2026-10-07T00:00:00.000Z'))
  .run({ trigger: 'manual' })
check('E10 a folder on the exclusion list is skipped and its stored mail dropped',
  filtered.removed === 1 && filtered.written === 0
  && folderStore.search({ query: 'lottery', limit: 10, offset: 0 }).total === 0
  && folderStore.search({ query: 'review', limit: 10, offset: 0 }).total === 1,
  show(filtered))
folderStore.close()

const byDisplayName = await resolveExcludedFolders({
  client: folderClient({ topLevel: [{ id: 'junk-folder', displayName: '垃圾邮件' }, { id: 'other', displayName: 'Game' }] }),
  names: ['垃圾邮件'],
})
check('E11 a folder with no well-known alias is matched by its display name',
  byDisplayName.get('junk-folder') === '垃圾邮件' && byDisplayName.size === 1, show([...byDisplayName]))
let unknownFolderCode = null
try {
  await resolveExcludedFolders({ client: folderClient({}), names: ['nope'] })
} catch (error) {
  unknownFolderCode = error.code
}
check('E12 an excluded folder this mailbox does not have fails the capture',
  unknownFolderCode === 'invalid_settings', show(unknownFolderCode))

// ── F. tools and the settings bridge ────────────────────────────────────────

const mounted = await mount({ databasePath: join(directory, 'mounted.db') })
const tools = new Map(mounted.registered.map((tool) => [tool.name, tool]))
check('F1 the plugin registers its five tools and nothing else',
  ['outlook_sync', 'outlook_search', 'outlook_item', 'outlook_send', 'outlook_schedule'].every((toolName) => tools.has(toolName))
  && tools.size === 5,
  show([...tools.keys()]))

/** Validate one tool value against the schema the tool declares. */
function assertToolValue(tool, value) {
  assertSupportedJsonSchema(tool.output.schema)
  const problems = validateJsonSchemaValue(tool.output.schema, value)
  return problems
}

const syncTool = tools.get('outlook_sync')
const syncValue = await syncTool.execute({}, {})
check('F2 a sync without a client id is refused with a stable reason',
  syncValue.status === 'skipped' && syncValue.reason === 'not_configured', show(syncValue))
check('F3 the sync value matches its declared schema', assertToolValue(syncTool, syncValue).length === 0,
  show(assertToolValue(syncTool, syncValue)))

const searchTool = tools.get('outlook_search')
const searchValue = await searchTool.execute({ query: '会议' }, {})
check('F4 a search on an empty corpus returns the freshness block',
  searchValue.total === 0 && searchValue.sync.configured === false && searchValue.sync.stale === true,
  show(searchValue))
check('F5 the search value matches its declared schema', assertToolValue(searchTool, searchValue).length === 0,
  show(assertToolValue(searchTool, searchValue)))

const itemTool = tools.get('outlook_item')
const missingItem = await itemTool.execute({ id: 'absent' }, {})
check('F6 an absent item reads back as not found', missingItem.found === false)
check('F7 the item value matches its declared schema', assertToolValue(itemTool, missingItem).length === 0,
  show(assertToolValue(itemTool, missingItem)))

const scheduleTool = tools.get('outlook_schedule')
const scheduled = await scheduleTool.execute({}, { agent: { session: { id: 'session-1' } } })
check('F8 the schedule tool creates the capture task',
  scheduled.ok === true && scheduled.status === 'created' && scheduled.tasks.length === 1, show(scheduled))
check('F9 the schedule value matches its declared schema', assertToolValue(scheduleTool, scheduled).length === 0,
  show(assertToolValue(scheduleTool, scheduled)))
const scheduledAgain = await scheduleTool.execute({}, { agent: { session: { id: 'session-1' } } })
check('F10 a second call reports the existing task', scheduledAgain.status === 'exists', show(scheduledAgain.status))
const recreated = await scheduleTool.execute({ recreate: true }, { agent: { session: { id: 'session-1' } } })
check('F11 re-creating replaces it', recreated.status === 'recreated' && mounted.schedule.tasks.length === 1, show(recreated.status))
// A replacement that cannot be created must leave the working task alone, or a
// transient schedule failure would silently remove the automation.
const createTask = mounted.schedule.create
mounted.schedule.create = async () => {
  throw Object.assign(new Error('refused'), { code: 'invalid_cron' })
}
const failedRecreate = await scheduleTool.execute({ recreate: true }, { agent: { session: { id: 'session-1' } } })
mounted.schedule.create = createTask
check('F11 a failed replacement keeps the working task',
  failedRecreate.status === 'failed' && mounted.schedule.tasks.length === 1, show({ status: failedRecreate.status, count: mounted.schedule.tasks.length }))
const noSession = await scheduleTool.execute({}, {})
check('F12 a call without a conversation reports unavailable', noSession.status === 'unavailable', show(noSession))
const tasks = await mounted.services.schedule.catalog()
check('F13 the task carries the marker that identifies it and the current title',
  tasks[0].prompt.includes('[dsh-outlook:auto-sync]') && tasks[0].cron.expression === '0 9 * * *'
  && tasks[0].title === 'Outlook sync', show(tasks[0].prompt.split('\n')[0]))

// A task created before the public rename has the old title and no marker in
// its prompt; it must still be claimed instead of a second task being created.
mounted.schedule.tasks.length = 0
mounted.schedule.tasks.push({
  id: 'legacy-task',
  sessionId: 'session-1',
  title: 'Microsoft Graph sync',
  prompt: 'Sync Microsoft Graph now.',
  cron: { expression: '0 9 * * *', time_zone: 'Asia/Shanghai' },
  kind: 'recurring',
  status: 'active',
  scheduledAt: '2026-10-14T01:00:00.000Z',
})
const legacySchedule = await scheduleTool.execute({}, { agent: { session: { id: 'session-1' } } })
check('F13b a task created before the rename is still claimed',
  legacySchedule.status === 'exists' && mounted.schedule.tasks.length === 1,
  show({ status: legacySchedule.status, count: mounted.schedule.tasks.length }))

// The bridge and the settings surface the page actually reaches, mounted by the
// plugin itself rather than stood in for.
check('F14 the bridge registers its route under /api',
  mounted.routes.length === 1 && mounted.routes[0].path === '/api/plugin-outlook', show(mounted.routes[0]?.path))
const bridge = mounted.routes[0]

const post = (body) => new Request('http://127.0.0.1:3080/api/plugin-outlook', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const statusResponse = await bridge.fetch(post({ action: 'status' }))
const statusValue = await statusResponse.json()
check('F15 the bridge describes the plugin to the page',
  statusResponse.status === 200 && statusValue.ok === true
  && statusValue.value.configured === false
  && statusValue.value.mail.count === 0
  && typeof statusValue.value.database.path === 'string'
  && statusValue.value.schedule.available === true,
  show(statusValue.value))
const loginResponse = await (await bridge.fetch(post({ action: 'login.begin' }))).json()
check('F16 a sign-in without a client id reports why',
  loginResponse.value.state.status === 'failed' && loginResponse.value.state.errorCode === 'not_configured',
  show(loginResponse))
const loginState = await (await bridge.fetch(post({ action: 'login.state' }))).json()
check('F17 the page can poll the login state', loginState.value.state.status === 'failed', show(loginState.value.state))
const ensureResponse = await (await bridge.fetch(post({ action: 'schedule.ensure' }))).json()
check('F18 the page can create the capture task through the bridge',
  ensureResponse.ok === true && ensureResponse.value.sessionId === 'session-1'
  && ensureResponse.value.schedule.tasks.length === 1 && mounted.schedule.tasks.length === 1,
  show(ensureResponse.value))
const unknown = await bridge.fetch(post({ action: 'nope' }))
check('F19 an unknown action is refused', unknown.status === 400, show(unknown.status))
const badBody = await bridge.fetch(new Request('http://127.0.0.1:3080/api/plugin-outlook', {
  method: 'POST',
  body: '{oops',
}))
check('F20 a malformed body is refused', badBody.status === 400, show(badBody.status))
const syncStart = await (await bridge.fetch(post({ action: 'sync.start' }))).json()
check('F21 a capture the plugin cannot run reports why',
  syncStart.value.started === false && syncStart.value.reason === 'not_configured', show(syncStart))
// The two live fields are written through the settings service, which validates
// the complete Config, so the shape check lives in the schema rather than in a
// bridge action the page could bypass.
const refusedWrite = await bridge.fetch(post({ action: 'config.update', clientId: 'x' }))
const badClientId = (() => {
  try {
    plugin.Config({ databasePath: join(directory, 'schema.db'), clientId: 'not-a-guid' })
    return false
  } catch (_error) {
    return true
  }
})()
const guid = '11111111-1111-4111-8111-111111111111'
const acceptedClientId = plugin.Config({ databasePath: join(directory, 'schema.db'), clientId: guid }).clientId.get()
check('F22 the bridge carries no configuration write, and the schema owns the field shape',
  refusedWrite.status === 400 && badClientId && acceptedClientId === guid,
  `${refusedWrite.status} ${badClientId} ${acceptedClientId}`)

await mounted.dispose()
let afterDispose = null
try {
  await searchTool.execute({ query: 'anything' }, {})
} catch (error) {
  afterDispose = error
}
check('F23 the lifecycle disposer released the corpus', afterDispose !== null, String(afterDispose))

// The Loader mounts Connection while settling sibling rows, so reading it once
// during apply drops the route silently: the page then sees a 404 it cannot tell
// apart from a wrong URL, and reports a signed-in account as missing.
{
  const late = await mount({ databasePath: join(directory, 'late.db'), withhold: ['connection'] })
  check('F24 no route exists before Connection mounts', late.routes.length === 0, show(late.routes.length))
  late.ctx.provide('connection', {
    fetch: {
      register: (route) => {
        late.routes.push(route)
        return () => {}
      },
    },
  })
  check('F25 the route appears when Connection mounts later',
    late.routes.length === 1 && late.routes[0].path === '/api/plugin-outlook',
    show(late.routes[0]?.path))
  await late.dispose()
}

// ── G. sign-in state without a network ──────────────────────────────────────

const { GraphAuth, keyFor } = await import('../src/auth.js')
const authCredentials = fakeCredentials()
let signedIn = null
let signedOut = false
const authSettings = { clientId: '', tenant: 'consumers', scopes: ['Mail.Read'], loginTimeoutSeconds: 60 }
const noClient = new GraphAuth({
  credentials: authCredentials,
  accountId: 'default',
  settings: () => authSettings,
  onSignedIn: (account) => {
    signedIn = account
  },
  onSignedOut: () => {
    signedOut = true
  },
})
check('G0 a plugin with no client id reports itself unconfigured', noClient.configured === false)
let tokenCode = null
try {
  await noClient.accessToken()
} catch (error) {
  tokenCode = error.code
}
check('G1 asking for a token without a client id fails with not_configured', tokenCode === 'not_configured', show(tokenCode))
check('G2 a challenge without a client id fails instead of starting one',
  (await noClient.beginLogin()).status === 'failed' && noClient.loginState().errorCode === 'not_configured',
  show(noClient.loginState()))
check('G3 no sign-in is stored yet', (await noClient.authorized()) === false)
check('G4 an account is absent before any sign-in', (await noClient.account()) === null)

authSettings.clientId = '11111111-1111-4111-8111-111111111111'
const configured = new GraphAuth({
  credentials: authCredentials,
  accountId: 'default',
  settings: () => authSettings,
  onSignedOut: () => {
    signedOut = true
  },
})
check('G5 a configured plugin reports itself configured', configured.configured === true)
let silentCode = null
try {
  await configured.accessToken()
} catch (error) {
  silentCode = error.code
}
check('G6 a silent token with no stored sign-in asks for one', silentCode === 'auth_required', show(silentCode))

await authCredentials.modifyRecord(keyFor('default'), () => Promise.resolve({
  kind: 'grant',
  payload: { cache: '{"AccessToken":{}}', account: { username: 'me@example.com', name: null, tenantId: 'consumers', homeAccountId: 'x', checkedAt: '2026-10-13T00:00:00.000Z' }, savedAt: '2026-10-13T00:00:00.000Z' },
}))
check('G7 a stored record is reported as signed in', (await configured.authorized()) === true)
check('G8 the account comes from the stored record', (await configured.account()).username === 'me@example.com',
  show(await configured.account()))
await configured.signOut()
check('G9 signing out removes the record and reports it',
  (await configured.authorized()) === false && signedOut === true && signedIn === null)

await authCredentials.modifyRecord(keyFor('default'), () => Promise.resolve({ kind: 'api-key', key: 'x' }))
let recordCode = null
try {
  await configured.authorized()
} catch (error) {
  recordCode = error.code
}
check('G10 a credential record this plugin did not write is refused', recordCode === 'credential_unavailable', show(recordCode))

// ── H. configuration validation ─────────────────────────────────────────────

/** Mount with a raw configuration object and report what it threw. */
function configFailure(config) {
  try {
    plugin.apply({ effect: (run) => { void run().catch(() => {}) ; return () => {} } }, config)
    return null
  } catch (error) {
    return error.message
  }
}

const defaultConfig = plugin.Config({ databasePath: '/tmp/outlook-default.db' })

const baseConfig = {
  accountId: 'default',
  clientId: '',
  tenant: 'common',
  scopes: ['Mail.Read'],
  databasePath: databasePath,
  scheduleCron: '0 9 * * *',
  mailInitialDays: 90,
  reconcileDays: 3,
  mailMaxPages: 60,
  backfillMaxPages: 20,
  bodyMaxBytes: 262_144,
  timeZone: 'Asia/Shanghai',
  loginTimeoutSeconds: 300,
}
check('H1 an empty database path fails the load',
  (configFailure({ ...baseConfig, databasePath: ' ' }) ?? '').includes('databasePath'),
  show(configFailure({ ...baseConfig, databasePath: ' ' })))
check('H2 a scope list with only reserved scopes fails the load',
  (configFailure({ ...baseConfig, scopes: ['offline_access'] }) ?? '').includes('scopes'),
  show(configFailure({ ...baseConfig, scopes: ['offline_access'] })))
check('H3 an unknown zone fails the load',
  (configFailure({ ...baseConfig, timeZone: 'Mars/Olympus' }) ?? '').includes('timeZone'),
  show(configFailure({ ...baseConfig, timeZone: 'Mars/Olympus' })))
check('H4 a malformed cron fails the load',
  (configFailure({ ...baseConfig, scheduleCron: 'daily' }) ?? '').includes('scheduleCron'),
  show(configFailure({ ...baseConfig, scheduleCron: 'daily' })))
check('H5 a valid configuration loads', configFailure(baseConfig) === null, show(configFailure(baseConfig)))

// ── I. what a stored sign-in was granted ────────────────────────────────────

/** An MSAL-shaped cache with the access tokens the scripted sign-in holds. */
function msalCache(targets) {
  const AccessToken = {}
  targets.forEach((target, index) => {
    AccessToken[`uid.utid-login.microsoftonline.com-accesstoken-fromCache-${index}`] = {
      credential_type: 'AccessToken',
      target,
      secret: 'never read here',
    }
  })
  return JSON.stringify({ AccessToken, RefreshToken: {}, Account: {} })
}

const grantedCredentials = fakeCredentials()
await grantedCredentials.modifyRecord('outlook/default', async () => ({
  kind: 'grant',
  payload: { cache: msalCache(['Mail.Read Mail.Send']), account: null, savedAt: '2026-10-01T00:00:00.000Z' },
}))
const grantedAuth = new GraphAuth({
  credentials: grantedCredentials,
  accountId: 'default',
  settings: () => ({ clientId: '', tenant: 'common', scopes: [], loginTimeoutSeconds: 60 }),
})
check('I1 the scopes a sign-in was granted are read from the stored record',
  show(await grantedAuth.grantedScopes()) === show(['Mail.Read', 'Mail.Send']),
  show(await grantedAuth.grantedScopes()))

await grantedCredentials.modifyRecord('outlook/default', async (current) => ({
  ...current,
  payload: { ...current.payload, cache: msalCache(['Mail.Read tasks.readwrite', 'Tasks.ReadWrite']) },
}))
const rotated = new GraphAuth({
  credentials: grantedCredentials,
  accountId: 'default',
  settings: () => ({ clientId: '', tenant: 'common', scopes: [], loginTimeoutSeconds: 60 }),
})
check('I2 scopes are normalized and deduplicated across the cache\'s tokens',
  show(await rotated.grantedScopes()) === show(['Mail.Read', 'Tasks.ReadWrite', 'tasks.readwrite']),
  show(await rotated.grantedScopes()))

const unreadableCredentials = fakeCredentials()
await unreadableCredentials.modifyRecord('outlook/default', async () => ({
  kind: 'grant',
  payload: { cache: '{not json', account: null, savedAt: '2026-10-01T00:00:00.000Z' },
}))
const unreadable = new GraphAuth({
  credentials: unreadableCredentials,
  accountId: 'default',
  settings: () => ({ clientId: '', tenant: 'common', scopes: [], loginTimeoutSeconds: 60 }),
})
check('I3 a cache this plugin cannot parse grants nothing it can name',
  (await unreadable.grantedScopes()).length === 0, show(await unreadable.grantedScopes()))

// A record some other plugin wrote is refused, not read as a sign-in with no
// scopes: the token request reports it too, and this must not disagree.
await unreadableCredentials.modifyRecord(keyFor('default'), () => Promise.resolve({ kind: 'api-key', key: 'x' }))
let foreignCode = null
try {
  await unreadable.grantedScopes()
} catch (error) {
  foreignCode = error.code
}
check('I4 a credential record this plugin did not write is refused', foreignCode === 'credential_unavailable',
  show(foreignCode))

// The mounted plugin holds no credential record of its own, so the page reads
// the empty answer a fresh install gives rather than another record's tokens.
const grantedStatus = await (await bridge.fetch(post({ action: 'scopes.granted' }))).json()
check('I5 the page reads the granted scopes through the bridge',
  grantedStatus.ok === true && Array.isArray(grantedStatus.value.scopes)
  && grantedStatus.value.scopes.length === 0,
  show(grantedStatus))
check('I6 the removed To Do surface is refused as an unknown action',
  (await bridge.fetch(post({ action: 'tasks.list' }))).status === 400)
check('I7 the default scopes request mail read and send',
  show(defaultConfig.scopes) === show(['Mail.Read', 'Mail.Send']), show(defaultConfig.scopes))

// ── K. the zone a search bound is read in ───────────────────────────────────

// One message received at 03:02 on the 16th in the plugin's own zone, which is
// still the 15th in UTC: it is the record that tells a bare date read locally
// apart from the same date read as UTC midnight.
const boundsPath = join(directory, 'bounds.db')
const boundsStore = await openStore({ path: boundsPath })
await boundsStore.commitMail({
  records: [messageToRecord({
    id: 'm4',
    subject: 'Nightly build report',
    body: { content: 'The nightly build finished.' },
    from: { emailAddress: { name: 'CI', address: 'ci@example.com' } },
    receivedDateTime: '2026-10-15T19:02:21Z',
    conversationId: 'c4',
  }, { bodyMaxBytes: 4096 })],
  seenAt: boundsStore.now(),
  bodyMaxBytes: 4096,
  cursor: { state: {}, lastSuccessAt: boundsStore.now(), itemCount: 1, snapshotComplete: true },
})
boundsStore.close()

const bounds = await mount({ databasePath: boundsPath })
const boundsSearch = new Map(bounds.registered.map((tool) => [tool.name, tool])).get('outlook_search')
const sinceDate = await boundsSearch.execute({ since: '2026-10-16' }, {})
check('K1 a date-only since is midnight in the plugin\'s zone', sinceDate.total === 1, show(sinceDate.total))
const sinceInstant = await boundsSearch.execute({ since: '2026-10-16T00:00:00Z' }, {})
check('K2 the same day written as an instant is the later bound it names', sinceInstant.total === 0, show(sinceInstant.total))
const untilDate = await boundsSearch.execute({ until: '2026-10-16' }, {})
check('K3 a date-only until stops at that local midnight', untilDate.total === 0, show(untilDate.total))
const wallInside = await boundsSearch.execute({ since: '2026-10-16T03:02' }, {})
const wallOutside = await boundsSearch.execute({ since: '2026-10-16T03:04' }, {})
check('K4 a wall-clock bound is read in that zone',
  wallInside.total === 1 && wallOutside.total === 0, `${show(wallInside.total)} ${show(wallOutside.total)}`)
check('K5 a bound value still matches the declared schema',
  assertToolValue(boundsSearch, sinceDate).length === 0, show(assertToolValue(boundsSearch, sinceDate)))
let badBound = false
try {
  await boundsSearch.execute({ since: 'today' }, {})
} catch {
  badBound = true
}
check('K6 an unparseable bound is refused instead of ignored', badBound)
await bounds.dispose()

// ── L. an older corpus is migrated to mail-only, not discarded ──────────────
//
// Generation 1 and generation 2 key a row the same way and carry the same
// columns, and the migration rewrites both through one path, so one legacy
// shape pins it: a mail row and a calendar row, a dataset-keyed cursor table,
// and an index that still stores its own id.

{
  const root = await mkdtemp(join(tmpdir(), 'outlook-migrate-'))
  const path = join(root, 'corpus.db')
  const { DatabaseSync } = await import('node:sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, dataset TEXT NOT NULL CHECK (dataset IN ('mail', 'calendar')),
      source_id TEXT NOT NULL, kind TEXT NOT NULL, ts TEXT, ts_end TEXT, title TEXT,
      sender TEXT, body TEXT, actors TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}', content_key TEXT, content_hash TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, UNIQUE (dataset, source_id)
    ) STRICT;
    CREATE INDEX items_ts ON items (dataset, ts DESC);
    CREATE INDEX items_content_key ON items (content_key);
    CREATE INDEX items_seen ON items (dataset, last_seen_at);
    CREATE VIRTUAL TABLE items_fts USING fts5(
      id UNINDEXED, title, body, actors, tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE cursors (
      dataset TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '{}', last_success_at TEXT,
      last_error_code TEXT, item_count INTEGER NOT NULL DEFAULT 0, snapshot_complete INTEGER
    ) STRICT;
    CREATE TABLE status (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_run_at TEXT, last_run_status TEXT,
      last_error_code TEXT, auth_required INTEGER NOT NULL DEFAULT 0, retry_not_before TEXT
    ) STRICT;
    PRAGMA user_version = 1;
  `)
  const rows = [
    {
      oldId: 'ab'.repeat(16), dataset: 'mail', sourceId: 'm1', kind: 'mail',
      ts: '2026-10-09T06:13:20.000Z', title: '会议', sender: 'Alice',
      body: '会议室已预订', actors: [{ name: 'Alice', id: 'alice@example.com', role: 'from' }],
    },
    {
      oldId: 'cd'.repeat(16), dataset: 'calendar', sourceId: 'e1', kind: 'event',
      ts: '2026-10-10T02:00:00.000Z', title: 'Standup', sender: 'Alice',
      body: 'daily standup', actors: [],
    },
  ]
  const insertItem = legacy.prepare(`INSERT INTO items
    (id, dataset, source_id, kind, ts, ts_end, title, sender, body, actors, metadata, content_key, content_hash, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '{}', NULL, ?, ?, ?)`)
  const insertFts = legacy.prepare('INSERT INTO items_fts (rowid, id, title, body, actors) VALUES (?, ?, ?, ?, ?)')
  for (const row of rows) {
    const actors = JSON.stringify(row.actors)
    const result = insertItem.run(
      row.oldId, row.dataset, row.sourceId, row.kind, row.ts, row.title, row.sender, row.body,
      actors, 'ee'.repeat(32), row.ts, row.ts,
    )
    insertFts.run(
      Number(result.lastInsertRowid), row.oldId, segmentForIndex(row.title),
      segmentForIndex(row.body), segmentForIndex(row.actors.map((actor) => `${actor.name} ${actor.id}`).join('\n')),
    )
  }
  const insertCursor = legacy.prepare(`INSERT INTO cursors
    (dataset, state, last_success_at, last_error_code, item_count, snapshot_complete)
    VALUES (?, ?, ?, NULL, ?, ?)`)
  insertCursor.run('mail', JSON.stringify({ last_received: '2026-10-09T06:13:20.000Z' }),
    '2026-10-09T06:20:00.000Z', 1, 1)
  insertCursor.run('calendar', JSON.stringify({ window_from: '2026-04-01T00:00:00.000Z' }),
    '2026-10-09T06:20:00.000Z', 1, 1)
  legacy.close()

  const migratedStore = await openStore({ path })
  const mailRow = migratedStore.item('m1')
  check('L1 the migrated mail reads back under its Graph id',
    mailRow !== undefined && mailRow.body === '会议室已预订' && mailRow.kind === 'mail', show(mailRow?.id))
  check('L2 the hashed and dataset-prefixed keys are gone',
    migratedStore.item(rows[0].oldId) === undefined && migratedStore.item('mail:m1') === undefined)
  check('L3 the rebuilt index still finds Chinese text',
    migratedStore.search({ query: '会议室', limit: 10, offset: 0 }).total === 1,
    show(migratedStore.search({ query: '会议室', limit: 10, offset: 0 }).total))
  const byActor = migratedStore.search({ query: 'Alice', limit: 10, offset: 0 })
  check('L4 the rebuilt index still finds a participant',
    byActor.total === 1 && byActor.rows[0].id === 'm1', show(byActor.rows.map((row) => row.id)))
  check('L5 the calendar row is dropped with the dataset',
    migratedStore.count() === 1 && migratedStore.item('e1') === undefined
    && migratedStore.search({ query: 'standup', limit: 10, offset: 0 }).total === 0,
    show(migratedStore.count()))
  const carried = migratedStore.mailState()
  check('L6 the mail cursor moves into the mail_state singleton',
    carried.state.last_received === '2026-10-09T06:13:20.000Z'
    && carried.lastSuccessAt === '2026-10-09T06:20:00.000Z' && carried.snapshotComplete === true,
    show(carried))
  migratedStore.close()

  const migrated = new DatabaseSync(path, { readOnly: true })
  const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  check('L7 the dataset-keyed cursor table is gone', !tables.includes('cursors') && tables.includes('mail_state'), show(tables))
  check('L8 the mail-only shape drops the dataset and event-end columns',
    ['dataset', 'ts_end'].every((name) => !migrated.prepare("SELECT name FROM pragma_table_info('items')").all().some((row) => row.name === name)),
    show(migrated.prepare("SELECT name FROM pragma_table_info('items')").all().map((row) => row.name)))
  check('L9 the index is rebuilt without the id column',
    !migrated.prepare("SELECT name FROM pragma_table_info('items_fts')").all().some((row) => row.name === 'id'))
  check('L10 the new generation is stamped', Number(migrated.prepare('PRAGMA user_version').get().user_version) === 3)
  migrated.close()
  await rm(root, { recursive: true, force: true })
}

// ── M. an existing corpus file is made owner-only ───────────────────────────

{
  const directory = await mkdtemp(join(tmpdir(), 'outlook-mode-'))
  const path = join(directory, 'corpus.db')
  await writeFile(path, '')
  await chmod(path, 0o644)
  const store = await openStore({ path })
  store.close()
  const mode = (await stat(path)).mode & 0o777
  check('M an existing corpus file is tightened to 0600', mode === 0o600, mode.toString(8))
  await rm(directory, { recursive: true, force: true })
}

// ── N. sending mail ─────────────────────────────────────────────────────────

const { composeMessage, sendMail } = await import('../src/send.js')

const composed = composeMessage({
  to: ['a@example.com', 'A@example.com'],
  cc: [{ address: 'b@example.com', name: 'Bee' }],
  subject: 'Hi',
  body: 'Hello',
  bodyType: 'html',
  importance: 'high',
})
check('N1 a message composes recipients, deduplicates, and sets the body type',
  composed.message.toRecipients.length === 1
  && composed.message.ccRecipients[0].emailAddress.name === 'Bee'
  && composed.message.body.contentType === 'HTML'
  && composed.message.importance === 'high'
  && composed.summary.to.length === 1,
  show(composed.summary))
let noRecipient = null
try {
  composeMessage({ to: [], subject: 'x', body: 'y' })
} catch (error) {
  noRecipient = error.code
}
check('N2 a message with no recipient is refused before any request', noRecipient === 'no_recipients', show(noRecipient))
let badAddress = null
try {
  composeMessage({ to: ['not-an-address'], subject: 'x', body: 'y' })
} catch (error) {
  badAddress = error.code
}
check('N3 a malformed address fails the whole message', badAddress === 'invalid_recipient', show(badAddress))

const sendScript = scriptedFetch([{ status: 202 }])
const sendGraph = new GraphClient({ auth: { accessToken: async () => 'token' }, fetchImpl: sendScript.fetchImpl })
const sendResult = await sendMail({ client: sendGraph, message: composed.message, saveToSentItems: false })
check('N4 sendMail posts JSON to /me/sendMail and reads the empty 202',
  sendScript.requests[0].method === 'POST'
  && sendScript.requests[0].url === 'https://graph.microsoft.com/v1.0/me/sendMail'
  && sendScript.requests[0].headers['content-type'] === 'application/json'
  && JSON.parse(sendScript.requests[0].body).saveToSentItems === false
  && sendResult === null,
  show({ url: sendScript.requests[0].url, body: sendScript.requests[0].body }))

/** Build one outlook_send tool against scripted sign-in and transport. */
function sendTool({ auth, client }) {
  const built = buildTools({
    ctx: { get: () => undefined },
    store: { search: () => ({ total: 0, rows: [] }), item: () => undefined, mailState: () => null, status: () => ({}), count: () => 0 },
    syncer: { busy: false },
    auth,
    jobs: undefined,
    config: { scheduleCron: '0 9 * * *' },
    createClient: () => client,
    zone: () => 'Asia/Shanghai',
    logger: {},
  })
  return built.find((tool) => tool.name === 'outlook_send')
}

const sending = []
const throwingClient = { post: async () => { throw new Error('must not send') } }
const readyAuth = { configured: true, grantedScopes: async () => ['Mail.Read', 'Mail.Send'] }

const gateTool = sendTool({ auth: readyAuth, client: throwingClient })
const notConfirmed = await gateTool.execute({ to: ['a@example.com'], subject: 'Hi', body: 'Hello' }, {})
check('N5 without confirm the tool returns a preview and sends nothing',
  notConfirmed.status === 'needs_confirmation' && notConfirmed.to[0] === 'a@example.com',
  show(notConfirmed))
check('N5b the preview matches the declared schema', assertToolValue(gateTool, notConfirmed).length === 0,
  show(assertToolValue(gateTool, notConfirmed)))

const scopeTool = sendTool({ auth: { configured: true, grantedScopes: async () => ['Mail.Read'] }, client: throwingClient })
const scopeMissing = await scopeTool.execute({ to: ['a@example.com'], subject: 'Hi', body: 'Hello', confirm: true }, {})
check('N6 a sign-in without Mail.Send is reported as scope_missing and sends nothing',
  scopeMissing.status === 'skipped' && scopeMissing.errorCode === 'scope_missing', show(scopeMissing))

const unconfiguredTool = sendTool({ auth: { configured: false, grantedScopes: async () => [] }, client: throwingClient })
const notConfigured = await unconfiguredTool.execute({ to: ['a@example.com'], subject: 'Hi', body: 'Hello', confirm: true }, {})
check('N7 an unconfigured plugin refuses a confirmed send',
  notConfigured.status === 'skipped' && notConfigured.errorCode === 'not_configured', show(notConfigured))

const okTool = sendTool({ auth: readyAuth, client: { post: async (path, { body }) => { sending.push({ path, body }); return null } } })
const sent = await okTool.execute({ to: ['a@example.com'], subject: 'Hi', body: 'Hello', confirm: true }, {})
check('N8 a confirmed send posts to /me/sendMail and reports sent',
  sent.status === 'sent' && sent.ok === true && sending.length === 1 && sending[0].path === '/me/sendMail',
  show(sent))
check('N8b the sent value matches the declared schema', assertToolValue(okTool, sent).length === 0,
  show(assertToolValue(okTool, sent)))

const failingTool = sendTool({ auth: readyAuth, client: { post: async () => { throw new GraphError('rate_limited', 'throttled') } } })
const failedSend = await failingTool.execute({ to: ['a@example.com'], subject: 'Hi', body: 'Hello', confirm: true }, {})
check('N9 a Graph failure while sending is reported as failed with its code',
  failedSend.status === 'failed' && failedSend.errorCode === 'rate_limited', show(failedSend))

// ── teardown ────────────────────────────────────────────────────────────────

await rm(directory, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\nFAILED: ${failures.join(', ')}`)
process.exitCode = failures.length === 0 ? 0 : 1

/**
 * Deterministic behaviour checks for the dsh-notify bundle: a local HTTP server
 * stands in for PushPlus, so every request the plugin makes is inspected
 * verbatim — what it sends, what it reports, and what it must never leak.
 *
 * Offline: run `node tests/verify-behavior.mjs` from the plugin directory after
 * `pnpm install`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'
import { BRIDGE_PATH, buildSettingsApi } from '../src/bridge.js'
import { resolveConfig } from '../src/config.js'
import { send } from '../src/pushplus.js'
import { clearTarget, keyFor, listTargets, writeTarget } from '../src/targets.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Run one check that must throw, and report its message. */
const throws = (work) => {
  try {
    work()
  } catch (error) {
    return error.message
  }
  return null
}

// ── a stand-in PushPlus ─────────────────────────────────────────────────────

/**
 * Start a server that answers every request from a script, one reply per call.
 * @param replies - Reply builders, the last one repeated once the script runs out.
 * @returns the endpoint, the received requests, and a closer.
 */
async function startUpstream(replies) {
  const requests = []
  let index = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      const entry = { method: request.method, url: request.url, raw, body: parseJson(raw) }
      requests.push(entry)
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      reply(entry, response)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Parse a JSON body without throwing. */
function parseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** A PushPlus acceptance. */
const accepted = (data = 'msg-1') => (_entry, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ code: 200, msg: 'ok', data }))
}

/** A PushPlus rejection carrying its own message. */
const refused = (code, msg) => (_entry, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ code, msg, data: null }))
}

// ── the plugin's two seams ──────────────────────────────────────────────────

/**
 * An in-memory stand-in for the credential service, with the provider's own
 * rule that a mutation returning undefined leaves the record alone.
 * @param entries - `[scope, id, record]` triples to preload.
 * @returns the fake provider.
 */
function fakeCredentials(entries = []) {
  const records = new Map(entries.map(([scope, id, record]) => [`${scope}/${id}`, record]))
  return {
    records,
    async listRecords() {
      return [...records.entries()].map(([key, record]) => {
        const [scope, id] = key.split('/')
        return { key: credentialKey(scope, id), kind: record.kind }
      })
    },
    async readRecord(key) {
      return records.get(String(key))
    },
    async modifyRecord(key, mutate) {
      const current = records.get(String(key))
      const next = await mutate(current)
      if (next === undefined) return current
      records.set(String(key), next)
      return next
    },
    async deleteRecord(key) {
      records.delete(String(key))
    },
  }
}

/**
 * Mount the plugin against stub services, as the Loader would.
 * @param options - Mount inputs.
 * @returns the registered tools, captured warnings, the settings route, and the disposers.
 */
function mount({ provider, config, withConnection = false }) {
  const tools = new Map()
  const logs = []
  /** Disposers for the tool registrations, which the checks dispose directly. */
  const disposers = []
  const serviceDisposers = []
  const services = new Map()
  let route
  const ctx = {
    credentials: provider,
    logger: { warn: (message) => logs.push(message) },
    provide(name, value) {
      services.set(name, value)
      serviceDisposers.push(() => services.delete(name))
      return () => services.delete(name)
    },
    tools: {
      register(definition) {
        assertSupportedJsonSchema(definition.parameters)
        assertSupportedJsonSchema(definition.output.schema)
        tools.set(definition.name, definition)
        const dispose = () => tools.delete(definition.name)
        disposers.push(dispose)
        return dispose
      },
    },
    inject: (names, callback) => {
      if (!withConnection || !names.includes('connection')) return undefined
      const connectionCtx = {
        connection: {
          fetch: {
            register: (registration) => {
              route = registration
              return () => {
                route = undefined
              }
            },
          },
        },
        effect: (work) => {
          const cleanup = work()
          return () => cleanup?.()
        },
      }
      return callback(connectionCtx)
    },
  }
  apply(ctx, config)
  return { tools, logs, disposers, serviceDisposers, services, route: () => route }
}

/** Post one settings action to the captured route. */
async function hit(route, action, body = {}) {
  const response = await route.fetch(
    new Request(`http://127.0.0.1${BRIDGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    }),
  )
  return { status: response.status, payload: await response.json() }
}

/** One stored PushPlus target. */
const targetRecord = (token) => ({ kind: 'grant', payload: { channel: 'pushplus', token, addedAt: '2026-10-14T00:00:00.000Z' } })

/** The notification tool from one mounting. */
const toolOf = (mounted) => mounted.tools.get('notify_send')

// ── configuration ───────────────────────────────────────────────────────────

{
  const defaults = resolveConfig(undefined)
  check(
    'defaults resolve, with the endpoint stripped of trailing slashes',
    defaults.baseUrl === 'https://www.pushplus.plus' && defaults.template === 'txt' && defaults.contentMaxChars === 4000,
    JSON.stringify(defaults),
  )
  check(
    'a trailing slash is dropped',
    resolveConfig({ baseUrl: 'https://example.test/push/' }).baseUrl === 'https://example.test/push',
  )
  check('an unknown config key fails the load', throws(() => resolveConfig({ nope: 1 })) === 'notify: unknown config key "nope"')
  check('a relative endpoint fails the load', (throws(() => resolveConfig({ baseUrl: 'pushplus.plus' })) ?? '').includes('not an absolute URL'))
  check('a non-http endpoint fails the load', (throws(() => resolveConfig({ baseUrl: 'ftp://example.test' })) ?? '').includes('http or https'))
  check('an unknown template fails the load', (throws(() => resolveConfig({ template: 'yaml' })) ?? '').includes('config.template'))
  check('an empty default title fails the load', (throws(() => resolveConfig({ defaultTitle: '  ' })) ?? '').includes('defaultTitle must be a non-empty string'))
  check('a tool timeout below the request timeout fails the load', (throws(() => resolveConfig({ requestTimeoutMs: 5000, toolTimeoutMs: 1000 })) ?? '').includes('at least config.requestTimeoutMs'))
  check('a fractional bound fails the load', (throws(() => resolveConfig({ contentMaxChars: 1.5 })) ?? '').includes('integer from'))
}

// ── one target, one accepted message ────────────────────────────────────────

{
  const upstream = await startUpstream([accepted('msg-42')])
  const provider = fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]])
  const mounted = mount({
    provider,
    config: { baseUrl: upstream.baseUrl, defaultTitle: 'Harness' },
  })
  const tool = toolOf(mounted)
  check('the tool registers under notify_send', tool !== undefined)
  check('the tool declares itself concurrency-safe', tool.isConcurrencySafe() === true)
  check('the pending-call card carries the message', tool.presentCall({ content: 'build finished' }).rawInput === 'build finished')

  const value = await tool.execute({ content: 'build finished' }, {})
  check('an accepted send reports one delivery', value.ok === true && value.delivered === 1 && value.total === 1, JSON.stringify(value))
  check('no truncation is reported for a short message', value.content_truncated === false && value.title_truncated === false)

  const [request] = upstream.requests
  check('the request is a POST to /send', request.method === 'POST' && request.url === '/send', `${request.method} ${request.url}`)
  check(
    'the body carries the token, title, body, and template',
    request.body.token === 'tok-alpha' && request.body.title === 'Harness'
      && request.body.content === 'build finished' && request.body.template === 'txt',
    JSON.stringify(request.body),
  )
  check('the token never appears in the tool result', !JSON.stringify(value).includes('tok-alpha'))
  check('the token never appears in a log line', mounted.logs.every((line) => !line.includes('tok-alpha')), mounted.logs.join(' | '))

  const blank = await tool.execute({ content: '   ' }, {})
  check(
    'a blank message is refused rather than sent',
    blank.ok === false && blank.error?.code === 'invalid_content' && upstream.requests.length === 1,
    JSON.stringify(blank),
  )

  // Disposal: the registration the plugin made is the one that goes away.
  mounted.disposers[0]()
  check('disposing the tool registration removes it', mounted.tools.has('notify_send') === false)
  await upstream.close()
}

// ── a caller-supplied title and a truncated body ────────────────────────────

{
  const upstream = await startUpstream([accepted()])
  const provider = fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]])
  const tool = toolOf(mount({
    provider,
    config: { baseUrl: upstream.baseUrl, contentMaxChars: 20, titleMaxChars: 10 },
  }))

  const value = await tool.execute({ content: 'x'.repeat(50), title: 'a title well over ten' }, {})
  const [request] = upstream.requests
  check('a long body is cut to the configured bound and reported', value.content_truncated === true && request.body.content.length === 20, `${request.body.content.length}`)
  check('a long title is cut to the configured bound and reported', value.title_truncated === true && request.body.title.length === 10, request.body.title)

  const fallback = await tool.execute({ content: 'no title given' }, {})
  check(
    'an omitted title falls back to the configured default, bounded too',
    fallback.title_truncated === true && upstream.requests[1].body.title.length === 10,
    upstream.requests[1].body.title,
  )
  await upstream.close()
}

// ── every target receives every message ─────────────────────────────────────

{
  const upstream = await startUpstream([accepted('one'), accepted('two')])
  const provider = fakeCredentials([
    ['notify', 'default', targetRecord('tok-alpha')],
    ['notify', 'family', targetRecord('tok-beta')],
  ])
  const tool = toolOf(mount({ provider, config: { baseUrl: upstream.baseUrl } }))

  const value = await tool.execute({ content: 'dinner is ready' }, {})
  const tokens = upstream.requests.map((request) => request.body.token).sort()
  check('two targets means two requests', upstream.requests.length === 2)
  check('both tokens are delivered to', tokens.join(',') === 'tok-alpha,tok-beta', tokens.join(','))
  check('a fully delivered send is ok', value.ok === true && value.delivered === 2 && value.total === 2, JSON.stringify(value))
  check('no failure list is carried when nothing failed', value.failures === undefined)
  await upstream.close()
}

// ── one target refuses, the other delivers ──────────────────────────────────

{
  const upstream = await startUpstream([refused(401, 'token 错误'), accepted('two')])
  const provider = fakeCredentials([
    ['notify', 'default', targetRecord('tok-alpha')],
    ['notify', 'family', targetRecord('tok-beta')],
  ])
  const tool = toolOf(mount({ provider, config: { baseUrl: upstream.baseUrl } }))

  const value = await tool.execute({ content: 'partial' }, {})
  check(
    'a partial delivery is not ok, and counts what landed',
    value.ok === false && value.delivered === 1 && value.total === 2,
    JSON.stringify(value),
  )
  const failed = value.failures?.[0]
  check('the refusal is reported per target with its code', failed?.code === 'rejected', JSON.stringify(failed))
  check('a refused token is not retried by the caller', failed?.retryable === false)
  check('the upstream message survives in the failure', (failed?.message ?? '').includes('token 错误'), failed?.message)
  check('the token never appears in a failure', !JSON.stringify(value).includes('tok-alpha') && !JSON.stringify(value).includes('tok-beta'))
  await upstream.close()
}

// ── an upstream that echoes the token back ──────────────────────────────────

{
  const upstream = await startUpstream([refused(500, 'rejected token tok-alpha for good measure')])
  const provider = fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl } })
  const value = await toolOf(mounted).execute({ content: 'echo' }, {})

  check(
    'a token echoed by upstream is redacted from the result',
    !JSON.stringify(value).includes('tok-alpha') && (value.failures?.[0]?.message ?? '').includes('<token>'),
    JSON.stringify(value.failures),
  )
  check('a token echoed by upstream is redacted from the log', mounted.logs.every((line) => !line.includes('tok-alpha')), mounted.logs.join(' | '))
  await upstream.close()
}

// A token longer than the message bound must be removed before the text is cut,
// or its prefix would survive the redaction.
{
  const longToken = 'a'.repeat(300)
  const upstream = await startUpstream([refused(500, `rejected token ${longToken} for good measure`)])
  const provider = fakeCredentials([['notify', 'default', targetRecord(longToken)]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl } })
  const value = await toolOf(mounted).execute({ content: 'echo' }, {})
  check(
    'a token longer than the message bound does not leak its prefix',
    !JSON.stringify(value).includes(longToken.slice(0, 50)) && (value.failures?.[0]?.message ?? '').includes('<token>'),
    JSON.stringify(value.failures),
  )
  await upstream.close()
}

// A response body is read through a byte cap instead of being buffered whole.
{
  const failure = await send({
    baseUrl: 'https://example.test',
    template: 'txt',
    token: 'tok',
    title: 'title',
    content: 'body',
    timeoutMs: 1000,
    fetchImpl: async () => new Response(`{"code":200,"data":{}}${'x'.repeat(70 * 1024)}`),
  }).catch(error => error)
  check('an oversized response body is refused', failure?.code === 'response_too_large', failure?.message)
}

// ── transport, status, and body failures ────────────────────────────────────

{
  const upstream = await startUpstream([(_entry, response) => {
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end('{"code":503,"msg":"busy"}')
  }])
  const tool = toolOf(mount({
    provider: fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]]),
    config: { baseUrl: upstream.baseUrl },
  }))
  const value = await tool.execute({ content: 'status' }, {})
  check('a non-200 status is reported as http_status', value.failures?.[0]?.code === 'http_status', JSON.stringify(value.failures))
  check('a status failure is retryable', value.failures?.[0]?.retryable === true)
  await upstream.close()
}

{
  const upstream = await startUpstream([(_entry, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html>not json</html>')
  }])
  const tool = toolOf(mount({
    provider: fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]]),
    config: { baseUrl: upstream.baseUrl },
  }))
  const value = await tool.execute({ content: 'body' }, {})
  check('a non-JSON body is reported as invalid_response', value.failures?.[0]?.code === 'invalid_response', JSON.stringify(value.failures))
  await upstream.close()
}

{
  const upstream = await startUpstream([accepted()])
  const endpoint = upstream.baseUrl
  await upstream.close()
  const tool = toolOf(mount({
    provider: fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]]),
    config: { baseUrl: endpoint },
  }))
  const value = await tool.execute({ content: 'gone' }, {})
  check('an unreachable endpoint is reported as request_failed', value.failures?.[0]?.code === 'request_failed', JSON.stringify(value.failures))
}

// ── redirects are refused, because the token is in the body ─────────────────

{
  const sink = await startUpstream([accepted()])
  const redirector = await startUpstream([(_entry, response) => {
    response.writeHead(307, { location: `${sink.baseUrl}/collect` })
    response.end()
  }])
  let code
  try {
    await send({
      baseUrl: redirector.baseUrl,
      template: 'txt',
      token: 'tok-alpha',
      title: 't',
      content: 'c',
      timeoutMs: 5000,
    })
  } catch (error) {
    code = error.code
  }
  check('a redirect fails instead of resending the token', code === 'request_failed', String(code))
  check('the redirect target never receives the token', sink.requests.length === 0, JSON.stringify(sink.requests))
  await redirector.close()
  await sink.close()
}

// ── the request timeout, exercised directly ─────────────────────────────────

{
  const upstream = await startUpstream([() => {}])
  let code
  try {
    await send({
      baseUrl: upstream.baseUrl,
      template: 'txt',
      token: 'tok-alpha',
      title: 't',
      content: 'c',
      timeoutMs: 60,
    })
  } catch (error) {
    code = error.code
  }
  check('a request past its timeout fails as request_failed', code === 'request_failed', String(code))
  await upstream.close()
}

// ── stored records the plugin cannot use ────────────────────────────────────

{
  const provider = fakeCredentials([['notify', 'stale', { kind: 'grant', payload: { channel: 'bark', token: 'tok-beta' } }]])
  const mounted = mount({ provider, config: { baseUrl: 'http://127.0.0.1:1' } })
  const value = await toolOf(mounted).execute({ content: 'x' }, {})
  check(
    'an unusable record is a failed delivery, not a skipped target',
    value.ok === false && value.total === 1 && value.delivered === 0 && value.failures?.[0]?.code === 'unusable_target',
    JSON.stringify(value),
  )
  check('an unusable record never fails silently', mounted.logs.some((line) => line.includes('unknown_channel')), mounted.logs.join(' | '))
}

{
  const provider = fakeCredentials([['notify', 'mine', { kind: 'api-key', key: 'not-a-target' }]])
  const value = await toolOf(mount({ provider, config: { baseUrl: 'http://127.0.0.1:1' } })).execute({ content: 'x' }, {})
  check('a record of another kind is unusable', value.failures?.[0]?.code === 'unusable_target', JSON.stringify(value.failures))
}

{
  const value = await toolOf(mount({
    provider: fakeCredentials([['other-plugin', 'default', targetRecord('tok-alpha')]]),
    config: { baseUrl: 'http://127.0.0.1:1' },
  })).execute({ content: 'x' }, {})
  check(
    'another plugin\'s records are not notification targets',
    value.ok === false && value.error?.code === 'not_configured' && value.error?.retryable === false,
    JSON.stringify(value),
  )
}

// ── the settings route ──────────────────────────────────────────────────────

{
  const upstream = await startUpstream([accepted('test-1')])
  const provider = fakeCredentials()
  const api = buildSettingsApi({ provider, config: resolveConfig({ baseUrl: upstream.baseUrl }) })
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl }, withConnection: true })
  const route = mounted.route()
  check('the settings route registers below /api', route?.path === BRIDGE_PATH && BRIDGE_PATH.startsWith('/api/'))

  const empty = await hit(route, 'status')
  check('an empty store reports no targets', empty.status === 200 && empty.payload.value.targets.length === 0, JSON.stringify(empty.payload))

  const saved = await hit(route, 'target.save', { name: 'Default', token: 'tok-alpha' })
  check('saving stores a target under a normalized name', saved.payload.value.targets[0]?.name === 'default', JSON.stringify(saved.payload))
  check(
    'the save answer carries the stored token for the page to show',
    saved.payload.value.targets[0]?.token === 'tok-alpha',
    JSON.stringify(saved.payload.value.targets),
  )

  const stored = provider.records.get('notify/default')
  check(
    'the stored record is a grant carrying the channel',
    stored?.kind === 'grant' && stored.payload.channel === 'pushplus' && stored.payload.token === 'tok-alpha',
    JSON.stringify(stored),
  )

  const tested = await hit(route, 'target.test', { name: 'default', title: 'Test', content: 'Hello from the page' })
  check('a test send reports upstream acceptance', tested.payload.value.ok === true && tested.payload.value.messageId === 'test-1', JSON.stringify(tested.payload))
  const [request] = upstream.requests
  check('the test message uses the page\'s own text', request.body.title === 'Test' && request.body.content === 'Hello from the page', JSON.stringify(request.body))

  const missing = await hit(route, 'target.test', { name: 'ghost', title: 't', content: 'c' })
  check('testing an unknown target reports unknown_target', missing.payload.value.error?.code === 'unknown_target', JSON.stringify(missing.payload))

  const badName = await hit(route, 'target.save', { name: 'Not A Name', token: 'tok-alpha' })
  check('a malformed name is refused as a request defect', badName.status === 400 && badName.payload.error?.code === 'invalid_target_name', JSON.stringify(badName.payload))
  const noToken = await hit(route, 'target.save', { name: 'default', token: '   ' })
  check('an empty token is refused with a code', noToken.status === 400 && noToken.payload.error?.code === 'invalid_token', JSON.stringify(noToken.payload))

  const unknown = await hit(route, 'nope')
  check('an unknown action is refused', unknown.status === 400 && unknown.payload.error?.code === 'unknown_action')

  const oversized = await route.fetch(
    new Request(`http://127.0.0.1${BRIDGE_PATH}`, { method: 'POST', body: JSON.stringify({ action: 'status', pad: 'x'.repeat(40_000) }) }),
  )
  check('an oversized body is refused before it is parsed', oversized.status === 413)

  const removed = await hit(route, 'target.delete', { name: 'default' })
  check('deleting removes the record', provider.records.size === 0 && removed.payload.value.targets.length === 0)
  await upstream.close()
}

// ── the real credential store ───────────────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-check-'))
  const ctx = new Context()
  ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml') })
  const provider = await mountedService(ctx, 'credentials')
  try {
    await writeTarget(provider, 'default', 'tok-real')
    await writeTarget(provider, 'family', 'tok-real-2')
    const targets = await listTargets(provider)
    check(
      'the real credential store accepts these records',
      targets.length === 2 && targets.every((target) => target.status === 'ready' && target.token.startsWith('tok-real')),
      JSON.stringify(targets),
    )

    await writeTarget(provider, 'default', 'tok-real-3')
    const replaced = await listTargets(provider)
    check(
      'replacing a target keeps its name and its add time',
      replaced[0].token === 'tok-real-3' && replaced[0].addedAt === targets[0].addedAt,
      JSON.stringify(replaced[0]),
    )

    await clearTarget(provider, 'family')
    check(
      'clearing removes exactly one record',
      (await listTargets(provider)).map((target) => target.name).join(',') === 'default',
    )

    await provider.modifyRecord(keyFor('stale'), async () => ({ kind: 'grant', payload: { channel: 'bark', token: 'x' } }))
    check(
      'a record of a channel this version does not send reads as unusable',
      (await listTargets(provider)).find((target) => target.name === 'stale')?.reason === 'unknown_channel',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Wait for the service a freshly mounted provider registers.
 * @param ctx - The cordis context.
 * @param name - Service name.
 * @returns the service.
 * @throws when it never mounts.
 */
async function mountedService(ctx, name) {
  const deadline = Date.now() + 5000
  for (;;) {
    const service = ctx.get(name)
    if (service !== undefined) return service
    if (Date.now() > deadline) throw new Error(`${name} never mounted`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ── the plugin's shape ──────────────────────────────────────────────────────

{
  const shape = mount({ provider: fakeCredentials(), config: { baseUrl: 'http://127.0.0.1:1' }, withConnection: true })
  check('apply registers exactly one tool', shape.tools.size === 1, [...shape.tools.keys()].join(','))
}

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`}`)
process.exit(failures.length === 0 ? 0 : 1)

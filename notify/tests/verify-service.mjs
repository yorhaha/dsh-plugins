/**
 * Checks for the `notify` service: the seam other bundles deliver through.
 *
 * The service is the calendar's delivery path, so what matters here is that it is
 * registered under one name, reports closed codes instead of throwing, never
 * carries a token, and produces the same delivery the tool produces.
 *
 * Offline: run `node tests/verify-service.mjs` from the plugin directory after
 * `pnpm install`.
 */
import { createServer } from 'node:http'

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { apply } from '../index.js'
import { resolveConfig } from '../src/config.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/**
 * Start a PushPlus stand-in answering from a script.
 *
 * @param replies - reply builders; the last one repeats.
 * @returns the endpoint, the received requests, and a closer.
 */
async function startUpstream(replies) {
  const requests = []
  let index = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const entry = { method: request.method, url: request.url, body: parseJson(raw), raw }
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
    close: () => new Promise((resolve) => {
      // Global fetch keeps its sockets alive, and `close` waits for them; dropping
      // the connections lets the check exit instead of hanging on a keep-alive.
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

/** Parse a body without throwing. */
function parseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** An acceptance. */
const accepted = (data = 'msg-1') => (_entry, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ code: 200, msg: 'ok', data }))
}

/** A refusal carrying PushPlus's own code. */
const refused = (code, msg) => (_entry, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ code, msg, data: null }))
}

/**
 * An in-memory credential provider.
 *
 * @param entries - `[scope, id, record]` triples.
 * @returns the fake provider.
 */
function fakeCredentials(entries = []) {
  const records = new Map(entries.map(([scope, id, record]) => [`${scope}/${id}`, record]))
  return {
    async listRecords() {
      return [...records.entries()].map(([key, record]) => {
        const [scope, id] = key.split('/')
        return { key: credentialKey(scope, id), kind: record.kind }
      })
    },
    async readRecord(key) { return records.get(String(key)) },
    async modifyRecord(key, mutate) {
      const current = records.get(String(key))
      const next = await mutate(current)
      if (next === undefined) return current
      records.set(String(key), next)
      return next
    },
    async deleteRecord(key) { records.delete(String(key)) },
  }
}

/** One stored PushPlus target. */
const targetRecord = token => ({ kind: 'grant', payload: { channel: 'pushplus', token, addedAt: '2026-10-14T00:00:00.000Z' } })

/**
 * Mount the plugin against stub services.
 *
 * @param options - the credential provider and config.
 * @returns the provided services, the registered tools, and the disposers.
 */
function mount({ provider, config }) {
  const tools = new Map()
  const services = new Map()
  const serviceDisposers = []
  const logs = []
  const ctx = {
    credentials: provider,
    logger: { warn: message => logs.push(message) },
    provide(name, value) {
      services.set(name, value)
      const dispose = () => services.delete(name)
      serviceDisposers.push(dispose)
      return dispose
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    inject: () => undefined,
  }
  apply(ctx, config)
  return { services, tools, serviceDisposers, logs }
}

// ── the service is the seam ─────────────────────────────────────────────────

{
  const upstream = await startUpstream([accepted()])
  const provider = fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl } })
  const notify = mounted.services.get('notify')

  check('apply provides the notify service', notify !== undefined)
  check('the service exposes send and status only', Object.keys(notify).sort().join(',') === 'send,status')

  const value = await notify.send({ title: '日程', content: '09:00 交周报' })
  check('a send reports a full delivery', value.ok === true && value.delivered === 1 && value.total === 1, JSON.stringify(value))
  check('the request carries the composed message', upstream.requests[0].body.content === '09:00 交周报')
  check('a result never carries a token', JSON.stringify(value).includes('tok-alpha') === false)

  const long = await notify.send({ title: 'x'.repeat(200), content: 'y'.repeat(5000) })
  check('a long message is cut to the configured bounds and says so', long.ok === true && long.title_truncated === true && long.content_truncated === true)
  check('the delivered body is within the bound', upstream.requests.at(-1).body.content.length <= 4000)

  const status = await notify.status()
  check('status counts the configured targets without naming them', status.total === 1 && status.ready === 1 && Object.keys(status).length === 2, JSON.stringify(status))

  mounted.serviceDisposers.forEach(dispose => dispose())
  check('disposing the plugin removes the service', mounted.services.has('notify') === false)
  await upstream.close()
}

// ── closed failures instead of thrown errors ────────────────────────────────

{
  const provider = fakeCredentials([])
  const mounted = mount({ provider, config: {} })
  const notify = mounted.services.get('notify')
  const empty = await notify.send({ content: 'anything' })
  check('no target answers not_configured', empty.ok === false && empty.code === 'not_configured' && empty.total === 0)
  const blank = await notify.send({ content: '   ' })
  check('a blank body is refused with its own code', blank.ok === false && blank.code === 'invalid_content')
}

{
  const upstream = await startUpstream([accepted(), refused(903, 'token is not valid')])
  const provider = fakeCredentials([['notify', 'default', targetRecord('tok-alpha')], ['notify', 'family', targetRecord('tok-beta')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl } })
  const notify = mounted.services.get('notify')
  const partial = await notify.send({ content: 'half delivered' })
  check('one refused target reports partial with a failure list', partial.ok === false && partial.code === 'partial' && partial.failures.length === 1, JSON.stringify(partial))
  check('the failure names the target and the code, never the token', partial.failures[0].target === 'family' && JSON.stringify(partial).includes('tok-') === false, JSON.stringify(partial.failures[0]))
  await upstream.close()
}

{
  const upstream = await startUpstream([refused(903, 'token is not valid')])
  const provider = fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl } })
  const notify = mounted.services.get('notify')
  const failed = await notify.send({ content: 'nobody got this' })
  check('every target refusing reports failed', failed.ok === false && failed.code === 'failed' && failed.delivered === 0)
  await upstream.close()
}

// ── the tool and the service agree ──────────────────────────────────────────

{
  const upstream = await startUpstream([accepted()])
  const provider = fakeCredentials([['notify', 'default', targetRecord('tok-alpha')]])
  const mounted = mount({ provider, config: { baseUrl: upstream.baseUrl } })
  const notify = mounted.services.get('notify')
  const tool = mounted.tools.get('notify_send')

  const body = 'z'.repeat(4200)
  await notify.send({ title: 'same', content: body })
  const fromService = upstream.requests.at(-1).body
  const toolValue = await tool.execute({ title: 'same', content: body }, {})
  const fromTool = upstream.requests.at(-1).body
  check('the tool and the service send the same bytes', fromService.content === fromTool.content)
  check('the tool reports the truncation the service applied', toolValue.content_truncated === true)

  const blank = await tool.execute({ content: '' }, {})
  check('the tool still answers a blank body with its own copy', blank.ok === false && blank.error.code === 'invalid_content')
  await upstream.close()
}

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}

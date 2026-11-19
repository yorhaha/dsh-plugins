import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import { fetchQuotas, GatewayError } from '../src/gateway.js'

/**
 * Run one request against a throwaway HTTP server.
 *
 * @param handler - what the server answers with.
 * @param overrides - config keys to replace.
 * @returns the settled outcome, with the server already stopped.
 */
async function against(handler, overrides = {}) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const config = resolveConfig({ gateway: `http://127.0.0.1:${port}`, ...overrides })
  try {
    return { read: await fetchQuotas(config).then(value => ({ value }), error => ({ error })) }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('a listing is read from magpie\u2019s one quota path', async () => {
  const seen = []
  const { read } = await against((request, response) => {
    seen.push(request.url)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ provider: 'x' }] }))
  })
  assert.deepEqual(read.value, { object: 'list', data: [{ provider: 'x' }] })
  assert.deepEqual(seen, ['/v1/magpie/quotas'])
})

test('an error status is reported as such, not parsed', async () => {
  const { read } = await against((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end('{"error":"boom"}')
  })
  assert.ok(read.error instanceof GatewayError)
  assert.equal(read.error.code, 'bad_status')
})

test('a body that is not JSON is refused', async () => {
  const { read } = await against((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('<html>not json</html>')
  })
  assert.equal(read.error.code, 'bad_json')
})

test('a body over the bound is refused before it is parsed', async () => {
  const { read } = await against((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [], padding: 'x'.repeat(8192) }))
  }, { maxBytes: 4096 })
  assert.equal(read.error.code, 'too_large')
})

test('a gateway that stalls is abandoned at the configured timeout', async () => {
  const { read } = await against(() => {
    // Accept the request and never answer it.
  }, { timeoutMs: 150 })
  assert.equal(read.error.code, 'timeout')
})

test('a closed port reads as magpie not running', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  const config = resolveConfig({ gateway: `http://127.0.0.1:${port}` })
  await assert.rejects(fetchQuotas(config), error => error.code === 'unreachable')
})

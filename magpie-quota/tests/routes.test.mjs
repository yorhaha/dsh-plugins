import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../src/config.js'
import { buildRoutes, QUOTAS_PATH } from '../src/routes.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(here, 'fixtures', 'quotas.json'), 'utf8')

/** Serve one fixture from a throwaway magpie and hand back the route. */
async function withRoute(run) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(fixture)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const [route] = buildRoutes(resolveConfig({ gateway: `http://127.0.0.1:${port}` }))
    await run(route)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('the bundle serves exactly one read route', () => {
  const routes = buildRoutes(resolveConfig({}))
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, QUOTAS_PATH)
  assert.equal(routes[0].path, '/api/plugin-magpie-quota/quotas')
  assert.deepEqual(routes[0].methods, ['GET'])
  assert.equal(routes[0].requestBody, 'buffered')
  assert.equal(typeof routes[0].fetch, 'function')
})

test('a read answers the page with accounts and read time', async () => {
  await withRoute(async route => {
    const response = await route.fetch(new Request(`http://harness.test${route.path}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json()
    assert.equal(payload.ok, true)
    // `llmbox` reports no allowance window, so it has no row.
    assert.equal(payload.accounts.length, 2)
    // The default row hides WorkBuddy's aggregate window.
    assert.deepEqual(
      payload.accounts[0].windows.map(window => window.name),
      ['Credits', 'Extra credits'],
    )
    assert.equal(payload.readAt, '2026-11-19T19:46:59.893835+08:00')
    // The page asks nothing about the gateway, so the answer carries it not at all.
    assert.equal('gateway' in payload, false)
    // The projection reaches the page, not magpie's raw window objects.
    assert.ok(!JSON.stringify(payload.accounts).includes('holdsWhy'))
  })
})

test('a stopped magpie answers 503 with a closed code', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  const [route] = buildRoutes(resolveConfig({ gateway: `http://127.0.0.1:${port}` }))
  const response = await route.fetch(new Request(`http://harness.test${route.path}`))
  assert.equal(response.status, 503)
  const payload = await response.json()
  assert.deepEqual(payload, { ok: false, error: 'unreachable' })
})

test('a payload magpie answers that is not a listing answers 502', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"object":"list"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const [route] = buildRoutes(resolveConfig({ gateway: `http://127.0.0.1:${port}` }))
    const response = await route.fetch(new Request(`http://harness.test${route.path}`))
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { ok: false, error: 'bad_payload' })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

/**
 * Wiring tests for the plugin entry point.
 *
 * The other suites cover pure functions and route handlers; this one covers
 * `apply` itself, which is where a registration defect hides. A wrong service
 * name, a missing `inject` declaration, or a section registered under the wrong
 * name all leave the suite green while the plugin fails to activate in a real
 * profile — a failure that only shows up in a running instance.
 *
 * `apply` is therefore called against a context recorder that refuses service
 * access the plugin has not declared, mirroring how Cordis withholds a service
 * from a fiber that never asked for it.
 *
 * @module dsh-file-memory/tests/plugin-apply
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply, inject, name } from '../index.js'

/**
 * Build a plugin context that records every call.
 * @param options - `services` lists the service names made available; `calls`
 *   lets a child context share its parent's recorder, which is required because
 *   the routes register through the context `inject` hands the callback.
 * @returns the context plus the recorded calls.
 */
function makeContext(options = {}) {
  const available = new Set(options.services ?? [])
  const calls = options.calls ?? { effects: [], sections: [], injected: [], routes: [] }

  const service = (serviceName) => new Proxy({}, {
    get(_target, property) {
      if (!available.has(serviceName)) {
        throw new TypeError(`service "${serviceName}" was not injected`)
      }
      if (serviceName === 'systemPrompt' && property === 'section') {
        return (section) => {
          calls.sections.push(section)
          return () => undefined
        }
      }
      if (serviceName === 'systemPrompt' && property === 'getSectionOrder') {
        return orderName => (orderName === 'MCP_SERVERS' ? 3100 : 0)
      }
      // `connection.fetch` is an object carrying `register`, not a callable.
      if (serviceName === 'connection' && property === 'fetch') {
        return {
          register: (route) => {
            calls.routes.push(route)
            return async () => undefined
          },
        }
      }
      return () => undefined
    },
  })

  const ctx = {
    effect: (fn, label) => {
      calls.effects.push(label)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    inject: (services, callback) => {
      calls.injected.push(services)
      // Cordis grants the requested services to the child context.
      callback(makeContext({ services: [...available, ...services], calls }).ctx)
      return () => undefined
    },
    get systemPrompt() { return service('systemPrompt') },
    get connection() { return service('connection') },
  }
  return { ctx, calls }
}

describe('plugin entry', () => {
  it('exports the loader-facing triple', () => {
    assert.equal(name, 'file-memory')
    assert.deepEqual([...inject], ['systemPrompt'])
    assert.equal(typeof apply, 'function')
  })

  it('declares every service its own apply body touches', () => {
    // The defect this guards: reaching a service that `inject` never asked for.
    // Cordis withholds it, so `apply` throws while activating.
    const { ctx } = makeContext({ services: [...inject] })
    assert.doesNotThrow(() => apply(ctx, { root: '/tmp/memory' }))
  })

  it('registers exactly one section, under the plugin name', () => {
    const { ctx, calls } = makeContext({ services: [...inject] })
    apply(ctx, { root: '/tmp/memory' })
    assert.equal(calls.sections.length, 1)
    assert.equal(calls.sections[0].name, 'file-memory')
  })

  it('orders the section from the centrally owned table', () => {
    const { ctx, calls } = makeContext({ services: [...inject] })
    apply(ctx, { root: '/tmp/memory' })
    assert.equal(calls.sections[0].order, 3110)
  })

  it('puts the resolved root in the injected text', () => {
    const { ctx, calls } = makeContext({ services: [...inject] })
    apply(ctx, { root: '/tmp/memory' })
    assert.ok(calls.sections[0].text.includes('/tmp/memory'))
  })

  it('requests connection dynamically, not as a required service', () => {
    const { ctx, calls } = makeContext({ services: [...inject] })
    apply(ctx, { root: '/tmp/memory' })
    assert.deepEqual(calls.injected, [['connection']])
    assert.equal(inject.includes('connection'), false)
  })

  it('registers both routes through connection', () => {
    const { ctx, calls } = makeContext({ services: [...inject] })
    apply(ctx, { root: '/tmp/memory' })
    assert.deepEqual(calls.routes.map(route => route.path).sort(), [
      '/api/plugin-file-memory/mutate',
      '/api/plugin-file-memory/read',
    ])
  })

  it('registers the routes as effects, so they unload with the plugin', () => {
    const { ctx, calls } = makeContext({ services: [...inject] })
    apply(ctx, { root: '/tmp/memory' })
    assert.deepEqual(calls.effects.sort(), [
      'file-memory: /api/plugin-file-memory/mutate',
      'file-memory: /api/plugin-file-memory/read',
    ])
  })

  it('registers nothing at all when disabled', () => {
    const { ctx, calls } = makeContext({ services: [...inject] })
    apply(ctx, { enabled: false, root: '/tmp/memory' })
    assert.deepEqual(calls.sections, [])
    assert.deepEqual(calls.injected, [])
    assert.deepEqual(calls.routes, [])
  })

  it('fails the load on a bad config rather than defaulting', () => {
    const { ctx } = makeContext({ services: [...inject] })
    assert.throws(() => apply(ctx, { root: '/tmp/memory', userRoot: '/tmp/other' }), {
      name: 'TypeError',
    })
  })
})

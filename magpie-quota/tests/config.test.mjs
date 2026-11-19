import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../src/config.js'

test('an absent row keeps every default', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
})

test('the gateway is reduced to its origin', () => {
  assert.equal(resolveConfig({ gateway: 'http://127.0.0.1:3425/' }).gateway, 'http://127.0.0.1:3425')
  assert.equal(resolveConfig({ gateway: ' https://magpie.example:9 ' }).gateway, 'https://magpie.example:9')
})

test('a gateway that is not an absolute http(s) origin is refused', () => {
  for (const gateway of ['127.0.0.1:3425', '/v1', 'ftp://127.0.0.1:3425', 'http://127.0.0.1:3425/v1']) {
    assert.throws(() => resolveConfig({ gateway }), ConfigError, `accepted ${gateway}`)
  }
})

test('a base with a path is refused rather than silently re-rooting the route', () => {
  assert.throws(() => resolveConfig({ gateway: 'http://127.0.0.1:3425/magpie' }), /origin with no path/)
})

test('an unknown option fails the load instead of being ignored', () => {
  assert.throws(() => resolveConfig({ gatewayy: 'http://127.0.0.1:3425' }), ConfigError)
  assert.throws(() => resolveConfig({ gatewayy: 'http://127.0.0.1:3425' }), /not a known option/)
})

test('bounds are enforced at both ends', () => {
  assert.equal(resolveConfig({ timeoutMs: 100 }).timeoutMs, 100)
  assert.equal(resolveConfig({ maxBytes: 4096 }).maxBytes, 4096)
  assert.throws(() => resolveConfig({ timeoutMs: 99 }), ConfigError)
  assert.throws(() => resolveConfig({ timeoutMs: 30001 }), ConfigError)
  assert.throws(() => resolveConfig({ maxBytes: 4095 }), ConfigError)
  assert.throws(() => resolveConfig({ timeoutMs: 1.5 }), /whole number/)
})

test('a non-object row config is refused', () => {
  assert.throws(() => resolveConfig([]), ConfigError)
  assert.throws(() => resolveConfig('http://127.0.0.1:3425'), ConfigError)
})

test('the switch must be a boolean', () => {
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.throws(() => resolveConfig({ enabled: 'no' }), /must be true or false/)
})

test('an aggregate window is hidden by default, and the rule is visible', () => {
  // WorkBuddy's Total credits is Credits plus Extra credits and repeats an
  // expiry, so three rows would carry two facts.
  assert.deepEqual(resolveConfig({}).hiddenWindows, ['workbuddy/Total credits'])
  assert.deepEqual(resolveConfig({ hiddenWindows: [] }).hiddenWindows, [])
})

test('a hidden entry must name a provider and a window', () => {
  assert.deepEqual(
    resolveConfig({ hiddenWindows: ['workbuddy/Total credits'] }).hiddenWindows,
    ['workbuddy/Total credits'],
  )
  for (const hiddenWindows of ['workbuddy', 'workbuddy/', '/Total credits', [''], [42], {}]) {
    assert.throws(() => resolveConfig({ hiddenWindows }), ConfigError, `accepted ${JSON.stringify(hiddenWindows)}`)
  }
})

test('a window name may itself contain a slash', () => {
  // Split on the first slash only: provider ids never contain one.
  const [entry] = resolveConfig({ hiddenWindows: ['traex/每日额度包（gpt_6_1）'] }).hiddenWindows
  assert.equal(entry, 'traex/每日额度包（gpt_6_1）')
})

test('repeated hidden entries collapse', () => {
  assert.deepEqual(
    resolveConfig({ hiddenWindows: ['a/b', 'a/b', 'a/c'] }).hiddenWindows,
    ['a/b', 'a/c'],
  )
})

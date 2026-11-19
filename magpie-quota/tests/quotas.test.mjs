import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { QuotaShapeError, normalizeQuotas } from '../src/quotas.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'quotas.json'), 'utf8'))

test('a real listing projects to one account per provider', () => {
  const { accounts, readAt } = normalizeQuotas(fixture)
  // `llmbox` is signed in but reports no allowance window, so it has no row.
  assert.deepEqual(accounts.map(account => account.provider), ['workbuddy', 'traex'])
  // The newest `readAt` among every account magpie reported, including the one
  // left out: the read happened, so the header must not say it never did.
  assert.equal(readAt, '2026-11-19T19:46:59.893835+08:00')
})

test('used and remaining are percentages, not amounts', () => {
  const { accounts } = normalizeQuotas(fixture)
  const workbuddy = accounts[0]
  const extra = workbuddy.windows.find(window => window.name === 'Extra credits')
  // magpie reports 0.0602 used and 99.94 remaining beside amount 2.58 of 4282;
  // 2.58 / 4282 is 0.06%, so the figures are the percentages they look like.
  assert.ok(Math.abs(extra.remainingPct - 99.93974778164409) < 1e-9)
  // The absolute figures stay in magpie's payload: the page draws one number
  // per window and must not be able to print 4282 as a percentage.
  const raw = fixture.data[0].windows.find(window => window.name === 'Extra credits')
  assert.equal(raw.limit, 4282)
  assert.equal(raw.unit, 'credits')
  for (const dropped of ['usedPct', 'limit', 'unit', 'amount']) {
    assert.equal(dropped in extra, false, `${dropped} should not be projected`)
  }
})

test('a window keeps the provider\u2019s own text verbatim', () => {
  const { accounts } = normalizeQuotas(fixture)
  const traex = accounts.find(account => account.provider === 'traex')
  const daily = traex.windows.find(window => window.name === '每日额度包（gpt_6_1）')
  assert.equal(daily.text, '已用 32.8517 / 80；剩余 47.1483')
  assert.ok(Math.abs(daily.remainingPct - 58.935375) < 1e-9)
  assert.equal(daily.resetsAt, '2026-11-19T22:00:00Z')
})

test('an account with no allowance window is left out entirely', () => {
  const { accounts } = normalizeQuotas(fixture)
  assert.equal(accounts.find(account => account.provider === 'llmbox'), undefined)
  // Its `until` is an account-validity date, not an allowance, so nothing of
  // value to this page is lost with it.
  assert.equal(accounts.length, 2)
})

test('both instants are projected, and the companion quantity is not', () => {
  const { accounts } = normalizeQuotas(fixture)
  const workbuddy = accounts[0]
  const extra = workbuddy.windows.find(window => window.name === 'Extra credits')
  const rawExtra = fixture.data[0].windows.find(window => window.name === 'Extra credits')
  // WorkBuddy's purchased credits expire while almost all of them are unspent:
  // the expiry is the point of the row, not a contradiction of the balance.
  assert.equal(extra.runsOutAt, '2026-11-19T12:19:21Z')
  assert.ok(extra.remainingPct > 99)
  assert.equal(extra.resetsAt, null)
  // The amount that goes with the instant. It is measured against its own
  // bucket rather than this window's `limit`, which is why the page attaches it
  // to the expiry instead of calling it the window's remaining balance.
  assert.ok(Math.abs(extra.runsOut - 497.42000001) < 1e-6)
  assert.notEqual(extra.runsOut, rawExtra.limit - rawExtra.amount)
  for (const account of accounts) {
    for (const window of account.windows) {
      assert.deepEqual(Object.keys(window).sort(), [
        'name', 'remainingPct', 'resetsAt', 'runsOut', 'runsOutAt', 'text',
      ])
    }
  }
})

test('a window without an expiry reports null rather than a fallback instant', () => {
  const { accounts } = normalizeQuotas(fixture)
  const traex = accounts.find(account => account.provider === 'traex')
  for (const window of traex.windows) {
    assert.equal(window.runsOutAt, null)
    assert.equal(window.runsOut, null)
  }
})

test('a missing percentage is derived from amount and limit, then from used', () => {
  const { accounts } = normalizeQuotas({
    data: [
      {
        provider: 'derived',
        windows: [
          { name: 'from amount', amount: 25, limit: 100 },
          { name: 'from used', used: 80 },
          { name: 'from nothing' },
        ],
      },
    ],
  })
  const [fromAmount, fromUsed, fromNothing] = accounts[0].windows
  assert.equal(fromAmount.remainingPct, 75)
  assert.equal(fromUsed.remainingPct, 20)
  assert.equal(fromNothing.remainingPct, null)
})

test('an out-of-range percentage is clamped rather than dropped', () => {
  const { accounts } = normalizeQuotas({
    data: [{ provider: 'clamped', windows: [{ name: 'over', remaining: 140 }, { name: 'under', remaining: -5 }] }],
  })
  assert.equal(accounts[0].windows[0].remainingPct, 100)
  assert.equal(accounts[0].windows[1].remainingPct, 0)
})

test('unusable entries are dropped without failing the read', () => {
  const { accounts } = normalizeQuotas({
    data: [
      { name: 'no provider id' },
      { provider: 'kept', windows: [{ remaining: 50 }, null, 'nope'] },
    ],
  })
  // The window with no name cannot be labelled, so it is not shown; an account
  // left with nothing to show goes with it.
  assert.deepEqual(accounts, [])
})

test('an unreadable instant stays null instead of becoming an epoch', () => {
  const { accounts } = normalizeQuotas({
    data: [{ provider: 'odd', windows: [{ name: 'w', remaining: 10, resetsAt: 'not a date' }] }],
  })
  assert.equal(accounts[0].windows[0].resetsAt, null)
})

test('a body that is not a quota listing is refused', () => {
  for (const payload of [null, 'text', {}, { data: 'no' }]) {
    assert.throws(() => normalizeQuotas(payload), QuotaShapeError)
    try {
      normalizeQuotas(payload)
    } catch (error) {
      assert.equal(error.code, 'bad_payload')
    }
  }
})

test('a hidden window leaves the payload without touching its neighbours', () => {
  const hidden = new Set(['workbuddy/Total credits'])
  const { accounts } = normalizeQuotas(fixture, hidden)
  const workbuddy = accounts[0]
  assert.deepEqual(workbuddy.windows.map(window => window.name), ['Credits', 'Extra credits'])
  // The account itself stays, and other providers are untouched.
  assert.equal(accounts.length, 2)
  assert.equal(accounts.find(account => account.provider === 'traex').windows.length, 4)
})

test('hiding every window of an account drops the account', () => {
  // `llmbox` is already out for reporting nothing; hide workbuddy's three and
  // only traex is left, because a card with an empty body is not a row.
  const hidden = new Set(['workbuddy/Credits', 'workbuddy/Extra credits', 'workbuddy/Total credits'])
  const { accounts } = normalizeQuotas(fixture, hidden)
  assert.deepEqual(accounts.map(account => account.provider), ['traex'])
})

test('a hidden entry that matches nothing hides nothing', () => {
  const { accounts } = normalizeQuotas(fixture, new Set(['workbuddy/Total credit']))
  assert.equal(accounts[0].windows.length, 3)
})

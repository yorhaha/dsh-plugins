/**
 * Projection of magpie's `/v1/magpie/quotas` payload into what the panel shows.
 *
 * The upstream shape is magpie's own, and it varies by provider: a subscription
 * account carries `windows`, a signed-in one may carry none until magpie has
 * read it, and a window's human text arrives in the provider's own language and
 * format (`2.58 / 4282`, `已用 0 / 300；剩余 300`, `0 / 500`). The panel renders
 * one layout, so the variance is absorbed here — once, on the Host, where it can
 * be tested without a browser.
 *
 * Two rules matter:
 *
 * - `used` and `remaining` are **percentages**, not amounts. `Extra credits`
 *   reports `used: 0.0602, remaining: 99.94` beside `amount: 2.58, limit: 4282`,
 *   and 2.58 / 4282 is 0.06%. Treating them as amounts would render 4282 as a
 *   percentage.
 * - A field that is missing stays `null` rather than becoming 0. A window whose
 *   allowance magpie could not read must not read as "empty".
 *
 * A window carries two instants, and they answer different questions:
 *
 * - `resetsAt` is when the allowance **refills**.
 * - `runsOutAt` is when the current allowance **runs out or expires** — the
 *   instant magpie's provider layer calls `resetRunsOut`, and the one its own
 *   copy describes as a reset "about to expire". WorkBuddy is the provider that
 *   reports it today: its purchased credits expire while most of them are still
 *   unspent, so "99.9% left" and "expires in half an hour" are both true at
 *   once. That pair is exactly what a reader needs, which is why both are
 *   projected and labelled apart rather than reconciled away.
 *
 * `runsOut` is the amount that goes with that instant: what is still spendable
 * before it runs out, which is what magpie's own quota view pairs with the
 * countdown. It is measured against its own bucket, **not** the window's
 * `limit` (WorkBuddy reports `runsOut: 489.6` beside `limit: 4282` for the same
 * window), so the page shows it attached to the expiry rather than as the
 * window's remaining balance — labelling it "credits left" would be wrong by an
 * order of magnitude.
 *
 * @module dsh-magpie-quota/quotas
 */

/** Longest provider, account, and window name kept. */
const MAX_NAME_CHARS = 120

/** Longest human text kept from a window's `display`. */
const MAX_TEXT_CHARS = 240

/** The default: hide nothing. */
const EMPTY_HIDDEN = new Set()

/** The upstream payload was not a quota listing. */
export class QuotaShapeError extends Error {
  constructor(reason) {
    super(`magpie-quota: ${reason}`)
    this.name = 'QuotaShapeError'
    this.code = 'bad_payload'
  }
}

/**
 * A finite number, or null.
 * @param value - the raw value.
 * @returns the number, or null.
 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A 0..100 percentage, or null.
 *
 * Clamping rather than refusing is deliberate: magpie sums allowance windows a
 * provider reports separately, and a rounding overshoot past 100 is not a
 * reason to hide the row.
 *
 * @param value - the raw value.
 * @returns the percentage, or null.
 */
function percentOf(value) {
  const number = finiteNumber(value)
  if (number === null) return null
  return Math.min(100, Math.max(0, number))
}

/**
 * One ISO-8601 instant as it arrived, or null.
 *
 * The string is kept rather than converted to a number so the browser formats
 * it in the reader's own clock; only its validity is checked here.
 *
 * @param value - the raw value.
 * @returns the instant string, or null.
 */
function instantOf(value) {
  if (typeof value !== 'string' || value === '') return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/**
 * Trimmed, length-bounded text, or the empty string.
 * @param value - the raw value.
 * @param limit - largest accepted length in characters.
 * @returns the text.
 */
function textOf(value, limit = MAX_NAME_CHARS) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}…`
}

/**
 * Percent remaining derived from an absolute amount and its limit.
 *
 * Used only when the provider reported no percentage of its own.
 *
 * @param amount - absolute amount used, if any.
 * @param limit - absolute limit, if any.
 * @returns the percentage, or null.
 */
function deriveRemaining(amount, limit) {
  const used = finiteNumber(amount)
  const total = finiteNumber(limit)
  if (used === null || total === null || total <= 0) return null
  return Math.min(100, Math.max(0, 100 * (1 - used / total)))
}

/**
 * Project one allowance window.
 * @param raw - the window as magpie reported it.
 * @returns the window, or null when it carries no usable name.
 */
function normalizeWindow(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const name = textOf(raw.name)
  if (name === '') return null
  // `used`, `amount`, `limit`, and `unit` are inputs to the percentage and are
  // not projected: the page draws one number per window, and carrying the
  // absolute figures beside it would invite reading them as that number.
  const usedPct = percentOf(raw.used)
  let remainingPct = percentOf(raw.remaining)
  if (remainingPct === null) {
    remainingPct = deriveRemaining(raw.amount, raw.limit)
    if (remainingPct === null && usedPct !== null) remainingPct = 100 - usedPct
  }
  return {
    name,
    text: textOf(raw.display, MAX_TEXT_CHARS),
    remainingPct,
    resetsAt: instantOf(raw.resetsAt),
    runsOutAt: instantOf(raw.runsOutAt),
    runsOut: finiteNumber(raw.runsOut),
  }
}

/**
 * Project one account.
 * @param raw - the account as magpie reported it.
 * @returns the account, or null when it carries no provider id.
 */
function normalizeAccount(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const provider = textOf(raw.provider, 64)
  if (provider === '') return null
  const windows = Array.isArray(raw.windows)
    ? raw.windows.map(normalizeWindow).filter(window => window !== null)
    : []
  return {
    provider,
    name: textOf(raw.name, 80) || provider,
    plan: textOf(raw.plan, 80) || null,
    user: textOf(raw.user, MAX_NAME_CHARS) || null,
    until: instantOf(raw.until),
    windows,
  }
}

/**
 * Project the whole payload.
 *
 * An entry that cannot be projected is dropped rather than failing the read:
 * one provider magpie reports oddly must not blank the whole panel.
 *
 * @param payload - the decoded `/v1/magpie/quotas` body.
 * @param hidden - `provider/window` entries to leave out. Omitting it filters
 *   nothing, which is the projection before any configuration is applied; the
 *   caller that serves the page always passes the resolved list.
 * @returns the accounts and the newest read time among them.
 * @throws {QuotaShapeError} when the body is not a quota listing at all.
 */
export function normalizeQuotas(payload, hidden = EMPTY_HIDDEN) {
  if (payload === null || typeof payload !== 'object') {
    throw new QuotaShapeError('the quota response is not an object')
  }
  if (!Array.isArray(payload.data)) {
    throw new QuotaShapeError('the quota response carries no `data` array')
  }
  const accounts = []
  let readAt = null
  for (const raw of payload.data) {
    const account = normalizeAccount(raw)
    if (account === null) continue
    // Freshness covers every account magpie reported, including ones dropped
    // below: the read still happened, and the header would otherwise claim this
    // page had never been read.
    const at = instantOf(raw?.readAt)
    if (at !== null && (readAt === null || Date.parse(at) > Date.parse(readAt))) readAt = at
    if (hidden.size > 0) {
      // A hidden window is removed here rather than in the page, so the payload
      // is exactly what the page shows and there is one place to test the rule.
      account.windows = account.windows.filter(
        window => !hidden.has(`${account.provider}/${window.name}`),
      )
    }
    // This page answers "what allowance do I have and when does it reset". An
    // account that reports no windows — signed in but with nothing metered, or
    // with every window configured away — has nothing to say on either count,
    // so it is left out rather than shown as a card reading "no data".
    if (account.windows.length === 0) continue
    accounts.push(account)
  }
  return { readAt, accounts }
}

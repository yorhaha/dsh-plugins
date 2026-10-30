/**
 * The reminder loop: which occurrence is due, what happened to it, and when to
 * look again.
 *
 * Three decisions shape this module.
 *
 * The loop lives in the Host process, not in a Session: a reminder is a clock
 * the person set, and waking a conversation to deliver one would spend tokens
 * and require that conversation to still exist. The harness's `schedule` service
 * is the right tool for "remind me and then keep working on this"; it is the
 * wrong tool for "tell my phone at nine".
 *
 * Every reminder is identified by `occurrence id + offset`, and the document
 * keeps a ledger of what was sent. That key is what makes a tick idempotent: a
 * restart, a clock jump, or two ticks in the same minute cannot deliver the same
 * reminder twice.
 *
 * A failure is not retried forever. One failure is retried once, five minutes
 * later; after that the reminder is recorded as failed and the panel says so.
 * Infinite retries would turn an unreachable phone into a push every minute.
 *
 * The process is the boundary, and it is not hidden: while the Harness is not
 * running nothing fires, and the first tick after it starts delivers what was
 * missed inside the catch-up window as one digest.
 *
 * @module dsh-user-todo/src/reminders
 */

import { formatInstant, instantFromParts, instantOfLocalMidnight, localClockOf, localDateOf, addLocalDays, parseInstant } from './zone.js'

/** How long a failed delivery waits before its one retry. */
const RETRY_MS = 5 * 60_000

/** How many times one reminder may be attempted. */
const MAX_ATTEMPTS = 2

/** How long a "no target configured" answer suppresses further attempts. */
const NOT_CONFIGURED_BACKOFF_MS = 15 * 60_000

/** Shortest delay between two looks at the clock. */
const MIN_TICK_MS = 250

/** How long a tick waits when something is due but the hourly limit is spent. */
const THROTTLED_RETRY_MS = 60_000

/** Longest lead any reminder may ask for, matching the stored bound. */
const MAX_LEAD_MS = 7 * 24 * 60 * 60_000

/**
 * Read a `HH:MM` preference as minutes after local midnight.
 *
 * @param text - the preference.
 * @param fallback - minutes used when the text is unusable.
 * @returns minutes after midnight.
 */
function clockMinutes(text, fallback) {
  const found = typeof text === 'string' ? /^(\d{2}):(\d{2})$/.exec(text) : null
  if (found === null) return fallback
  return Number(found[1]) * 60 + Number(found[2])
}

/**
 * Whether a moment falls inside the quiet window.
 *
 * The window may wrap past midnight (`22:00`–`08:00`), which is the case worth
 * writing down: comparing start and end directly gets it backwards.
 *
 * @param prefs - the preference block.
 * @param now - epoch milliseconds.
 * @param timeZone - the zone the window is read in.
 * @returns true when the moment is quiet.
 */
export function inQuietHours(prefs, now, timeZone) {
  const quiet = prefs?.quietHours
  if (quiet === null || quiet === undefined) return false
  const start = clockMinutes(quiet.start, Number.NaN)
  const end = clockMinutes(quiet.end, Number.NaN)
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) return false
  const minute = clockMinutes(localClockOf(now, timeZone), 0)
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end
}

/**
 * The instant a reminder for one occurrence is due.
 *
 * A timed occurrence counts from its start. An all-day occurrence counts from the
 * reminder clock time (09:00 by default) on that date, because "all day" has no
 * moment of its own to count back from.
 *
 * @param occurrence - the agenda occurrence.
 * @param offset - minutes before the due moment.
 * @param prefs - the preference block, for the all-day clock time.
 * @returns epoch milliseconds.
 */
function reminderAt(occurrence, offset, prefs) {
  const start = parseInstant(occurrence.startAt)
  const base = occurrence.allDay
    ? start + clockMinutes(prefs.allDayReminderTime, 9 * 60) * 60_000
    : start
  return base - offset * 60_000
}

/**
 * The offsets one occurrence asks for, falling back to the preference default.
 *
 * @param occurrence - the agenda occurrence.
 * @param prefs - the preference block.
 * @returns the offsets, ascending.
 */
function offsetsOf(occurrence, prefs) {
  const asked = Array.isArray(occurrence.remindBeforeMin) ? occurrence.remindBeforeMin : []
  if (asked.length > 0) return asked
  return [prefs.defaultRemindBeforeMin ?? 0]
}

/**
 * The outcome the ledger holds for one key.
 *
 * @param ledger - the recorded entries.
 * @param key - the reminder key.
 * @returns whether it was delivered, its last failure, and how many attempts exist.
 */
function ledgerState(ledger, key) {
  let latest = null
  let attempts = 0
  let sent = false
  for (const entry of ledger) {
    if (entry.key !== key) continue
    attempts += 1
    if (entry.status === 'sent') {
      sent = true
      continue
    }
    if (latest === null || entry.at >= latest.at) latest = entry
  }
  return { sent, latest, attempts }
}

/**
 * Build the message one batch of due reminders sends.
 *
 * One message for the batch, not one per reminder: five items due at nine is one
 * thing the person wants to read, and five pushes in a row is how a feature gets
 * switched off.
 *
 * @param due - the due entries.
 * @param timeZone - the zone the clock times are written in.
 * @param now - the moment the batch was assembled.
 * @returns the title and body.
 */
export function buildReminderMessage(due, timeZone, now) {
  const lines = due.map((entry) => {
    const when = entry.allDay ? entry.date : localClockOf(entry.startMillis, timeZone)
    const overdue = entry.startMillis < now ? '（已到期）' : ''
    return `- ${when} ${entry.title}${overdue}`
  })
  const title = due.length === 1 ? '待办提醒' : `待办提醒（${due.length} 项）`
  return { title, content: lines.join('\n') }
}

/**
 * Build the message one day's agenda sends.
 *
 * @param occurrences - today's occurrences.
 * @param timeZone - the zone the clock times are written in.
 * @param date - the day, for the title.
 * @returns the title and body.
 */
export function buildDigestMessage(occurrences, timeZone, date) {
  const lines = occurrences.map((entry) => {
    const when = entry.allDay ? '全天' : localClockOf(parseInstant(entry.startAt), timeZone)
    return `- ${when} ${entry.title}`
  })
  return { title: `今天的安排 · ${date}`, content: lines.join('\n') }
}

/**
 * The reminder scheduler.
 */
export class ReminderScheduler {
  /** @type {object} */
  #store

  /** @type {object} */
  #config

  /** @type {() => object | undefined} */
  #port

  /** @type {object | undefined} */
  #logger

  /** @type {() => number} */
  #now

  /** @type {ReturnType<typeof setTimeout> | null} */
  #timer = null

  #started = false

  #running = false

  /** @type {number} */
  #suppressedUntil = 0

  /**
   * @param options - the list, the bounds, and the delivery port.
   * @param options.store - the open list.
   * @param options.config - the resolved feature bounds.
   * @param options.port - resolves the notification service, or undefined when none is mounted.
   * @param options.logger - the harness logger.
   * @param options.now - clock, replaceable by tests.
   */
  constructor({ store, config, port, logger, now }) {
    this.#store = store
    this.#config = config
    this.#port = port
    this.#logger = logger
    this.#now = now ?? (() => Date.now())
  }

  /**
   * Start looking at the clock. Idempotent.
   */
  start() {
    if (this.#started) return
    this.#started = true
    void this.tick()
  }

  /**
   * Stop looking at the clock and drop any pending wake-up.
   */
  stop() {
    this.#started = false
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Take another look now, for a write that may have made something due.
   */
  kick() {
    if (!this.#started) return
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    void this.tick()
  }

  /**
   * Every reminder whose moment has arrived or will arrive inside the window,
   * minus the ones the ledger already settled.
   *
   * @param now - epoch milliseconds.
   * @param ledger - the recorded entries.
   * @param prefs - the preference block.
   * @returns the pending entries, ascending by their reminder moment.
   */
  pending(now, ledger, prefs) {
    const catchUp = this.#config.remindCatchUpHours * 60 * 60_000
    const lead = Math.max(this.#maxLead(), prefs.defaultRemindBeforeMin * 60_000)
    const occurrences = this.#store.agenda({
      from: now - catchUp,
      to: now + lead + this.#config.schedulerMaxSleepMs + 60 * 60_000,
      includeDone: false,
      limit: this.#config.agendaMaxOccurrences,
    })
    /** @type {Array<object>} */
    const pending = []
    for (const occurrence of occurrences) {
      const startMillis = parseInstant(occurrence.startAt)
      for (const offset of offsetsOf(occurrence, prefs)) {
        const at = reminderAt(occurrence, offset, prefs)
        if (at < now - catchUp) continue
        const key = `${occurrence.occurrenceId}#${offset}`
        const state = ledgerState(ledger, key)
        if (state.sent) continue
        if (state.latest !== null) {
          const lastAt = parseInstant(state.latest.at)
          if (state.attempts >= MAX_ATTEMPTS) continue
          if (Number.isNaN(lastAt) || now - lastAt < RETRY_MS) continue
        }
        pending.push({ key, at, startMillis, allDay: occurrence.allDay, date: occurrence.date, title: occurrence.title })
      }
    }
    pending.sort((left, right) => left.at - right.at)
    return pending
  }

  /**
   * The longest lead any open item asks for, so the window covers it.
   *
   * @returns milliseconds.
   */
  #maxLead() {
    let longest = 0
    for (const item of this.#store.items()) {
      for (const offset of Array.isArray(item.remindBeforeMin) ? item.remindBeforeMin : []) {
        if (offset * 60_000 > longest) longest = offset * 60_000
      }
    }
    return Math.min(longest, MAX_LEAD_MS)
  }

  /**
   * How many pushes the configured limit still allows.
   *
   * @param ledger - the recorded entries.
   * @param now - epoch milliseconds.
   * @returns the remaining allowance.
   */
  #allowance(ledger, now) {
    // Strictly inside the last hour: a push exactly an hour ago must not still
    // count, or the limit would stretch every window by one tick.
    const hourAgo = now - 60 * 60_000
    const sent = ledger.filter(entry => entry.status === 'sent' && parseInstant(entry.at) > hourAgo).length
    return Math.max(0, this.#config.maxPushesPerHour - sent)
  }

  /**
   * The digest this day owes, if the person asked for one.
   *
   * @param now - epoch milliseconds.
   * @param ledger - the recorded entries.
   * @param prefs - the preference block.
   * @returns `{ key, at, message }`, or null.
   */
  #digest(now, ledger, prefs) {
    const at = prefs.digestAt
    if (at === null || at === undefined) return null
    const timeZone = this.#store.timeZone
    const date = localDateOf(now, timeZone)
    const [year, month, day] = date.split('-').map(Number)
    const minutes = clockMinutes(at, 9 * 60)
    const wanted = instantFromParts({ year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60 }, timeZone)
    if (now < wanted) return null
    const key = `digest:${date}`
    if (ledgerState(ledger, key).sent) return null
    const occurrences = this.#store.agenda({
      from: instantOfLocalMidnight(date, timeZone),
      to: instantOfLocalMidnight(addLocalDays(date, 1), timeZone),
      includeDone: false,
      limit: this.#config.agendaMaxOccurrences,
    })
    if (occurrences.length === 0) return null
    return { key, at: wanted, message: buildDigestMessage(occurrences, timeZone, date) }
  }

  /**
   * One look at the clock: send what is due, record what happened, and arm the
   * next look.
   *
   * A tick is callable without `start` so a test can drive the clock directly;
   * the timer is only armed by a started scheduler, so such a call has no
   * side effect on the process.
   *
   * @returns the delivery outcome, or null when nothing was sent.
   */
  async tick() {
    this.#timer = null
    if (this.#running) return null
    this.#running = true
    try {
      const now = this.#now()
      const prefs = this.#store.prefs()
      const quiet = prefs.pushReminders === false || inQuietHours(prefs, now, this.#store.timeZone)
      if (quiet || now < this.#suppressedUntil) return null
      return await this.#deliver({ now, prefs })
    } catch (error) {
      this.#logger?.warn?.(`user-todo: reminder tick failed: ${error?.message ?? error}`)
      return null
    } finally {
      this.#running = false
      // Re-arming reads the store again, so it can fail on its own. It must not
      // propagate: this finally can run inside a timer callback, where a throw
      // is an uncaught exception that would take the whole host down.
      try {
        this.#arm()
      } catch (error) {
        this.#logger?.warn?.(`user-todo: reminder re-arm failed: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Send whatever is due at this moment, reminder batch and digest alike.
   *
   * @param options - the moment and the preference block.
   * @returns the last delivery outcome, or null when nothing was sent.
   */
  async #deliver({ now, prefs }) {
    const ledger = this.#store.notifications()
    /** @type {object | null} */
    let outcome = null
    const due = this.pending(now, ledger, prefs).filter(entry => entry.at <= now)
    if (due.length > 0 && this.#allowance(ledger, now) > 0) {
      outcome = await this.#send(due.map(entry => entry.key), buildReminderMessage(due, this.#store.timeZone, now), now)
    }
    const digest = this.#digest(now, ledger, prefs)
    if (digest !== null && this.#allowance(this.#store.notifications(), now) > 0) {
      outcome = await this.#send([digest.key], digest.message, now)
    }
    return outcome
  }

  /**
   * Deliver one message and record what happened to every key it covers.
   *
   * @param keys - the reminder keys the message covers.
   * @param message - the title and body.
   * @param now - epoch milliseconds.
   * @returns the delivery outcome the port reported.
   */
  async #send(keys, message, now) {
    const port = this.#port()
    const at = formatInstant(now)
    if (port === undefined) {
      // No notification bundle in this profile: the panel still shows the item,
      // and the reminder is considered handled so it does not pile up.
      this.#logger?.warn?.('user-todo: no notification service is mounted; reminder recorded without delivery')
      await this.#store.recordNotifications(keys.map(key => ({ key, at, status: 'sent' })))
      return { ok: false, code: 'notify_absent', delivered: 0, total: 0 }
    }
    const outcome = await port.send({ title: message.title, content: message.content })
    if (!outcome.ok && outcome.code === 'not_configured') {
      // A missing token is a setup state, not a failed delivery: leave the
      // ledger alone and stop asking for a while, so configuring it later can
      // still deliver inside the catch-up window.
      this.#suppressedUntil = now + NOT_CONFIGURED_BACKOFF_MS
      this.#logger?.warn?.('user-todo: reminders are waiting for a notification target to be configured')
      return outcome
    }
    await this.#store.recordNotifications(keys.map(key => ({ key, at, status: outcome.ok ? 'sent' : 'failed' })))
    if (!outcome.ok) {
      this.#logger?.warn?.(`user-todo: reminder delivery failed: ${outcome.code ?? 'unknown'}`)
    }
    return outcome
  }

  /**
   * Arm the next look at the clock.
   *
   * The delay is capped rather than computed exactly: a capped wait also covers
   * a sleeping machine, a clock correction, and a write that lands between two
   * ticks, at the cost of up to one capped interval of lateness.
   */
  #arm() {
    if (!this.#started) return
    const now = this.#now()
    const prefs = this.#store.prefs()
    let next = now + this.#config.schedulerMaxSleepMs
    if (prefs.pushReminders !== false) {
      const ledger = this.#store.notifications()
      const pending = this.pending(now, ledger, prefs)
      const overdue = pending.filter(entry => entry.at <= now)
      if (overdue.length > 0) {
        next = now + (this.#allowance(ledger, now) > 0 ? MIN_TICK_MS : THROTTLED_RETRY_MS)
      } else if (pending.length > 0) {
        next = Math.min(next, pending[0].at)
      }
      const digest = this.#digest(now, ledger, prefs)
      if (digest !== null) next = Math.min(next, Math.max(digest.at, now + MIN_TICK_MS))
    }
    const delay = Math.min(Math.max(next - now, MIN_TICK_MS), this.#config.schedulerMaxSleepMs)
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => { void this.tick() }, delay)
    // A reminder must not keep the process alive on its own.
    this.#timer.unref?.()
  }
}

/**
 * Build the scheduler one plugin instance uses.
 *
 * @param options - the list, the bounds, and the delivery port.
 * @returns the scheduler.
 */
export function createReminderScheduler(options) {
  return new ReminderScheduler(options)
}

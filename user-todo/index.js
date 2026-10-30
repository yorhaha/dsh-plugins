/**
 * user-todo — the person's own todo list and calendar, shared by the
 * Calendar & Todos panel and five Host tools.
 *
 * The list is one durable document owned by this plugin (see
 * {@link module:dsh-user-todo/src/store}). The panel reaches it over the bundle's
 * own `/api` route, the tools over the document the plugin opened, so both
 * surfaces read and write the same items: a checkbox the person clicks and a
 * status an agent sets are the same field.
 *
 * The calendar is the same items with a time: a due date, an all-day flag, a
 * repeat rule, reminder offsets. Nothing is duplicated into a second store, so
 * "the item I see in the list" and "the item I see on Wednesday" cannot drift.
 *
 * Reminders run on this plugin's own clock while the process is up. The
 * notification service is optional and looked up at the moment a reminder fires,
 * so a profile without `dsh-notify` still keeps the calendar — it just records
 * the reminder instead of pushing it.
 *
 * This package writes no session data beyond the ordinary tool call and result
 * the registry logs: the list outlives the conversation that touched it, and
 * that is the whole difference between it and `todo_write`.
 *
 * @module dsh-user-todo
 */

import { instant } from './src/item.js'
import { buildPanelApi, registerRoute } from './src/route.js'
import { openTodoStore } from './src/open.js'
import { createReminderScheduler } from './src/reminders.js'
import { buildTools } from './src/tools.js'
import { isTimeZone, systemTimeZone } from './src/zone.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'user-todo'

/**
 * The services this plugin cannot run without. The list is durable host state,
 * so the storage domain is a hard dependency: a composition without it cannot
 * mount this plugin instead of mounting a list that silently forgets
 * everything. The tool registry carries the five tools and the connection
 * channel carries the panel route.
 *
 * The notification service is deliberately absent: it is optional, and the
 * reminder loop resolves it per delivery through `ctx.get('notify')`.
 */
export const inject = ['tools', 'storageDomain', 'connection']

/**
 * Deployment configuration. Values a person changes from the panel (reminder
 * switches, quiet hours, the digest time) live in the document instead, because
 * changing one must not need a reload.
 *
 * @typedef {object} Config
 * @property {{ list: string, create: string, update: string, agenda: string, remove: string }} toolNames - names of the five tools.
 * @property {number} maxCreateBatch - most items one create call accepts.
 * @property {number} maxUpdateBatch - most changes one update call accepts.
 * @property {number} maxDeleteBatch - most items one delete call accepts.
 * @property {number} maxTitleChars - longest title.
 * @property {number} maxNoteChars - longest note.
 * @property {number} maxItems - most items the list holds.
 * @property {boolean} allowSubagentWrites - whether a delegated child session may write.
 * @property {string | null} timeZone - IANA zone used when an item names none; null means the system zone.
 * @property {number} agendaMaxSpanDays - longest window one agenda read accepts.
 * @property {number} agendaMaxOccurrences - most occurrences one agenda read returns.
 * @property {number} remindCatchUpHours - how long after its moment a reminder may still be delivered.
 * @property {number} maxPushesPerHour - most reminder pushes in one hour.
 * @property {number} schedulerMaxSleepMs - longest wait between two looks at the clock.
 */

/** Tool names must be distinct, non-empty identifiers: the registry keys tools by name. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** Tool keys the row must name, and the ones it may omit. */
const REQUIRED_TOOL_KEYS = ['list', 'create', 'update']
const OPTIONAL_TOOL_KEYS = ['agenda', 'remove']

/** Names a row that predates a tool keeps when it omits that tool's key. */
const OPTIONAL_TOOL_DEFAULTS = { agenda: 'list_user_agenda', remove: 'delete_user_todos' }

/**
 * Validate the configuration block. The plugin declares no schema library, so
 * it checks this itself at load: a bad bound fails the mount instead of
 * silently falling back to another value.
 *
 * @param {unknown} raw - the row's `config`, or undefined when it states none.
 * @returns {Config} the resolved configuration.
 * @throws {TypeError} on any field outside its accepted range.
 */
export function resolveConfig(raw) {
  if (raw === undefined) throw new TypeError('user-todo: the row states no config; see cordis.patch.yml')
  const config = /** @type {Record<string, unknown>} */ (raw)
  const names = config.toolNames
  if (typeof names !== 'object' || names === null) throw new TypeError('user-todo: `toolNames` is required')
  const given = /** @type {Record<string, unknown>} */ (names)
  const toolNames = {}
  for (const key of REQUIRED_TOOL_KEYS) {
    const value = given[key]
    if (typeof value !== 'string' || !TOOL_NAME_PATTERN.test(value)) {
      throw new TypeError(`user-todo: \`toolNames.${key}\` must match ${TOOL_NAME_PATTERN}`)
    }
    toolNames[key] = value
  }
  for (const key of OPTIONAL_TOOL_KEYS) {
    const value = given[key] ?? OPTIONAL_TOOL_DEFAULTS[key]
    if (typeof value !== 'string' || !TOOL_NAME_PATTERN.test(value)) {
      throw new TypeError(`user-todo: \`toolNames.${key}\` must match ${TOOL_NAME_PATTERN}`)
    }
    toolNames[key] = value
  }
  for (const key of Object.keys(given)) {
    if (!REQUIRED_TOOL_KEYS.includes(key) && !OPTIONAL_TOOL_KEYS.includes(key)) {
      throw new TypeError(`user-todo: \`toolNames.${key}\` is not a tool this bundle registers`)
    }
  }
  if (new Set(Object.values(toolNames)).size !== Object.keys(toolNames).length) {
    throw new TypeError('user-todo: the tool names must differ')
  }
  const positive = (key, fallback) => {
    const value = config[key] ?? fallback
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`user-todo: \`${key}\` must be a positive integer`)
    }
    return value
  }
  const maxTitleChars = positive('maxTitleChars', 200)
  const maxNoteChars = positive('maxNoteChars', 2000)
  const maxCreateBatch = positive('maxCreateBatch', 20)
  const maxUpdateBatch = positive('maxUpdateBatch', 50)
  const maxDeleteBatch = positive('maxDeleteBatch', 50)
  const maxItems = positive('maxItems', 5000)
  const agendaMaxSpanDays = positive('agendaMaxSpanDays', 366)
  const agendaMaxOccurrences = positive('agendaMaxOccurrences', 400)
  const maxPushesPerHour = positive('maxPushesPerHour', 6)
  const schedulerMaxSleepMs = positive('schedulerMaxSleepMs', 60_000)
  const remindCatchUpHours = config.remindCatchUpHours ?? 24
  if (!Number.isSafeInteger(remindCatchUpHours) || remindCatchUpHours < 0 || remindCatchUpHours > 24 * 30) {
    throw new TypeError('user-todo: `remindCatchUpHours` must be an integer from 0 to 720')
  }
  if (schedulerMaxSleepMs < 1_000) throw new TypeError('user-todo: `schedulerMaxSleepMs` must be at least 1000')
  const allowSubagentWrites = config.allowSubagentWrites ?? true
  if (typeof allowSubagentWrites !== 'boolean') throw new TypeError('user-todo: `allowSubagentWrites` must be a boolean')
  const timeZone = config.timeZone ?? null
  if (timeZone !== null && !isTimeZone(timeZone)) {
    throw new TypeError(`user-todo: \`timeZone\` must be an IANA zone name or null: ${String(timeZone)}`)
  }
  return {
    toolNames,
    maxCreateBatch,
    maxUpdateBatch,
    maxDeleteBatch,
    maxTitleChars,
    maxNoteChars,
    maxItems,
    allowSubagentWrites,
    timeZone,
    agendaMaxSpanDays,
    agendaMaxOccurrences,
    remindCatchUpHours,
    maxPushesPerHour,
    schedulerMaxSleepMs,
  }
}

/**
 * Delegation accounting: a delegated child session is deeper than zero. Read
 * from the agent itself so this bundle needs no subagent package.
 *
 * @param agent - the calling agent.
 * @returns its delegation depth.
 */
function delegationDepthOf(agent) {
  const depth = agent?.options?.subagentDepth ?? 0
  return typeof depth === 'number' ? depth : 0
}

/**
 * Mount the list, its calendar, its reminders, its route, and its tools.
 *
 * @param ctx - the plugin context.
 * @param {unknown} raw - the row's `config`.
 * @returns the plugin's effect, which closes the domain on unload.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  return ctx.effect(async () => {
    const store = await openTodoStore(ctx.storageDomain, {
      bounds: { maxTitleChars: config.maxTitleChars, maxNoteChars: config.maxNoteChars },
      maxItems: config.maxItems,
      timeZone: config.timeZone ?? systemTimeZone(),
    })
    try {
      const scheduler = createReminderScheduler({
        store,
        config,
        // Resolved per delivery, not injected: a profile without the notification
        // bundle still mounts the calendar, and one where it appears later starts
        // receiving reminders without a remount.
        // Resolved per send rather than captured: the notification bundle may be
        // installed, removed, or reloaded while this plugin stays loaded, and a
        // missing service is a state the loop handles (`notify_absent`).
        port: () => {
          try {
            return ctx.get('notify')
          } catch {
            return undefined
          }
        },
        logger: ctx.logger,
      })
      // Owned by this plugin's fiber: the clock stops whenever the plugin unloads.
      ctx.effect(() => {
        scheduler.start()
        return () => scheduler.stop()
      }, 'user-todo: reminder clock')
      ctx.effect(() => store.onChange(() => {
        ctx.emit('user-todo/changed', instant())
        // A write can make something due right now (a new item with no lead) or
        // move the next moment, so the wait is recomputed rather than kept.
        scheduler.kick()
      }), 'user-todo: change broadcast')
      for (const tool of buildTools({ store, config, delegationDepthOf })) ctx.tools.register(tool)
      // Owned by this plugin's fiber: the route appears whenever Connection
      // mounts, and goes away with the plugin.
      registerRoute(ctx, buildPanelApi(store, config))
    } catch (error) {
      // The domain is open by now, and a registration can throw — a hot reload
      // that disposes this fiber mid-setup does exactly that. Release the domain
      // before the failure escapes: the facility reserves an open name, so a
      // leak here fails every later mount with `already-open` until the process
      // restarts.
      await store.close()
      throw error
    }
    return async () => { await store.close() }
  })
}

/**
 * The recurring task a capture plugin keeps in the harness's automation list.
 *
 * bilibili, outlook, and wechat each keep one such task, and the adapter is the
 * same: the schedule service exposes creation only to Host code (its Remote
 * namespace has no `create`), nothing on a task record marks its owner, and a
 * task belongs to one Session, so creation always names the conversation the
 * task should report into.
 *
 * It lives here, once, because a change to the service or to the way a task is
 * recognized has to reach all three bundles or none — and the three copies had
 * already drifted: two spread the created task when reporting cleanup errors and
 * one mutated it. Only the strings each bundle shows differ, and they are
 * parameters.
 *
 * The bundles reach this file by relative path. That is the price of sharing:
 * a bundle copied out of this repository on its own would not resolve it. They
 * are installed from here by `link:`, so the path holds; a bundle that ever has
 * to stand alone gets its own copy back.
 *
 * @module dsh-plugins/shared/schedule
 */

/** Longest task name the schedule service accepts. */
const MAX_TITLE_LENGTH = 120

/**
 * Build the task adapter for one bundle.
 *
 * @param options - The strings and the prompt that make this bundle's task its own.
 * @param options.name - Bundle name, used in failure messages.
 * @param options.title - Task name shown in the automation list.
 * @param options.marker - Stable marker inside the prompt, so a renamed task is still claimed.
 * @param options.legacyTitles - Titles this task carried before a rename, still claimed.
 * @param options.prompt - Builds the prompt a delivered task sends, from resolved options.
 * @returns the adapter's operations.
 */
export function createSchedule({ name, title, marker, legacyTitles = [], prompt }) {
  /**
   * Whether a catalog entry is this bundle's task.
   * @param entry - One catalog entry.
   * @returns true when the prompt carries the marker or the title is one it has used.
   */
  const owned = (entry) =>
    entry.prompt?.includes(marker) === true
    || entry.title === title
    || legacyTitles.includes(entry.title)

  /**
   * Resolve the schedule service.
   * @param ctx - Plugin context.
   * @returns the service, or undefined in a composition that mounts no schedule.
   */
  const scheduleOf = (ctx) => ctx.get('schedule')

  /**
   * Every retained task this bundle owns, active or not.
   * @param ctx - Plugin context.
   * @returns the matching catalog entries, each carrying its Session.
   */
  async function listTasks(ctx) {
    const schedule = scheduleOf(ctx)
    if (schedule === undefined) return []
    const catalog = await schedule.catalog()
    return catalog.filter(owned)
  }

  /**
   * Create one owned task.
   * @param ctx - Plugin context.
   * @param sessionId - Conversation the task reports into.
   * @param request - `cron`, `timeZone`, and the resolved `options` the prompt is built from.
   * @returns the created task.
   * @throws when the composition mounts no schedule service.
   */
  async function createTask(ctx, sessionId, { cron, timeZone, options }) {
    const schedule = scheduleOf(ctx)
    if (schedule === undefined) {
      throw new Error(`${name}: this composition mounts no schedule service`)
    }
    return schedule.create(sessionId, {
      title: title.slice(0, MAX_TITLE_LENGTH),
      prompt: prompt(options),
      cron: { expression: cron, time_zone: timeZone },
    })
  }

  /**
   * Create the recurring task when no owned task exists.
   * @param ctx - Plugin context.
   * @param sessionId - Conversation the task reports into.
   * @param request - `cron`, `timeZone`, and `options`.
   * @returns the created task, or the existing one.
   * @throws when the composition mounts no schedule service.
   */
  async function ensureTask(ctx, sessionId, request) {
    const existing = await listTasks(ctx)
    if (existing.length > 0) return existing[0]
    return createTask(ctx, sessionId, request)
  }

  /**
   * Replace every owned task with one fresh task, which is how a user recovers
   * after deleting the row from the automation list.
   * @param ctx - Plugin context.
   * @param sessionId - Conversation the task reports into.
   * @param request - `cron`, `timeZone`, and `options`.
   * @returns the created task, plus any cleanup failures when it replaced several.
   * @throws when the composition mounts no schedule service.
   */
  async function recreateTask(ctx, sessionId, request) {
    const schedule = scheduleOf(ctx)
    if (schedule === undefined) {
      throw new Error(`${name}: this composition mounts no schedule service`)
    }
    const existing = await listTasks(ctx)
    // Create before deleting: a rejected `create` (an invalid rule, a session the
    // service refuses, a storage failure) must leave the working task in place
    // instead of destroying it and then failing.
    const created = await createTask(ctx, sessionId, request)
    const cleanupErrors = []
    for (const entry of existing) {
      if (String(entry.id) === String(created.id)) continue
      try {
        await schedule.delete({ sessionId: entry.sessionId, id: entry.id })
      } catch (error) {
        // The replacement already works; a failed cleanup leaves a duplicate,
        // which the user can remove, rather than no task at all.
        cleanupErrors.push({ id: String(entry.id), message: error?.message ?? String(error) })
      }
    }
    return cleanupErrors.length === 0 ? created : { ...created, cleanupErrors }
  }

  /**
   * Summarize the owned tasks for a caller that only displays them.
   * @param ctx - Plugin context.
   * @returns whether an active task exists, plus a compact description of each.
   */
  async function taskState(ctx) {
    if (scheduleOf(ctx) === undefined) return { available: false, active: false, tasks: [] }
    const tasks = await listTasks(ctx)
    return {
      available: true,
      active: tasks.some((entry) => entry.status === 'active'),
      tasks: tasks.map((entry) => ({
        id: String(entry.id),
        title: entry.title,
        status: entry.status,
        kind: entry.kind,
        nextRunAt: entry.scheduledAt,
      })),
    }
  }

  return { scheduleOf, listTasks, ensureTask, recreateTask, taskState }
}

/**
 * The recurring sync task the plugin keeps in the harness's automation list.
 *
 * The task, its marker, and the prompt a delivered task sends are this bundle's;
 * the adapter that reads the catalog, creates the task, and replaces it lives in
 * `shared/schedule.js`, because outlook and wechat keep the same one.
 *
 * Nothing marks a task as this plugin's own: the record carries no owner or
 * source field, and both the title and the prompt are user-editable. Existence
 * is therefore decided by a stable marker inside the prompt, falling back to the
 * title, and is always a fresh read rather than a cached assumption.
 *
 * @module dsh-bilibili/src/schedule
 */

import { createSchedule } from '../../shared/schedule.js'

/** Task name shown in the automation list. */
export const TASK_TITLE = 'Bilibili 数据同步'

/** Marker the task's prompt carries, so renaming the task does not orphan it. */
export const TASK_MARKER = '[dsh-bilibili:auto-sync]'

/** Default recurrence: every day at 09:00 in the configured zone. */
export const DEFAULT_CRON = '0 9 * * *'

/**
 * The prompt a delivered task sends, which becomes a user message in the bound
 * conversation and drives the agent to run the sync itself.
 * @returns the prompt text.
 */
export function taskPrompt() {
  return [
    TASK_MARKER,
    'Sync Bilibili data now: call bilibili_sync, wait for the job to settle, and summarise what is new.',
  ].join('\n')
}

const task = createSchedule({
  name: 'bilibili',
  title: TASK_TITLE,
  marker: TASK_MARKER,
  prompt: taskPrompt,
})

export const { scheduleOf, listTasks, taskState } = task

/**
 * Create the recurring task when no owned task exists.
 * @param ctx - Plugin context.
 * @param sessionId - Conversation the task reports into.
 * @param cron - Five-field expression.
 * @param timeZone - IANA zone the expression is evaluated in.
 * @returns the created task, or the existing one.
 * @throws when the composition mounts no schedule service.
 */
export function ensureTask(ctx, sessionId, cron, timeZone) {
  return task.ensureTask(ctx, sessionId, { cron, timeZone })
}

/**
 * Replace every owned task with one fresh task, which is how a user recovers
 * after deleting the row from the automation list.
 * @param ctx - Plugin context.
 * @param sessionId - Conversation the task reports into.
 * @param cron - Five-field expression.
 * @param timeZone - IANA zone the expression is evaluated in.
 * @returns the created task.
 * @throws when the composition mounts no schedule service.
 */
export function recreateTask(ctx, sessionId, cron, timeZone) {
  return task.recreateTask(ctx, sessionId, { cron, timeZone })
}

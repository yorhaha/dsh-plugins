/**
 * The recurring export-and-import task the plugin keeps in the harness's
 * automation list.
 *
 * The task name, its marker, and the prompt — which names the exporter and the
 * batch archive a delivered run needs — are this bundle's; the adapter that
 * reads the catalog, creates the task, and replaces it lives in
 * `shared/schedule.js`, because bilibili and outlook keep the same one.
 *
 * Nothing marks a task as this plugin's own: the record carries no owner field,
 * and both the title and the prompt are user-editable. Existence is therefore
 * decided by a stable marker inside the prompt, falling back to the title, and
 * is always a fresh read rather than a cached assumption. That also means a task
 * the user created by hand through the harness's own scheduler is adopted rather
 * than duplicated, as long as it carries the marker.
 *
 * @module dsh-wechat/src/schedule
 */

import { createSchedule } from '../../shared/schedule.js'

/** Task name shown in the automation list. */
export const TASK_TITLE = '微信数据导入'

/** Marker the task's prompt carries, so renaming the task does not orphan it. */
export const TASK_MARKER = '[dsh-wechat:auto-import]'

/** Default recurrence: every Monday at 09:00 in the configured zone. */
export const DEFAULT_CRON = '0 9 * * 1'

/**
 * The prompt a delivered task sends, which becomes a user message in the bound
 * conversation and drives the agent to export and import by itself.
 *
 * The paths are written out because the delivered message is the only context
 * the agent is guaranteed to have; they are frozen when the task is created, so
 * changing the exporter's location means recreating the task.
 *
 * @param options - Resolved plugin options.
 * @returns the prompt text.
 */
export function taskPrompt(options) {
  const exportStep =
    options.exporterDir === ''
      ? 'Ask the user to run their WeChat exporter for the last few days with --format jsonl, into this plugin\'s batch archive, because no exporterDir is configured.'
      : `Run \`cd ${options.exporterDir} && .venv/bin/python export.py --format jsonl --days ${options.scheduleExportDays} --output-dir ${options.batchesDir}/wechat-$(date +%Y%m%d-%H%M%S)\`.`
  return [
    TASK_MARKER,
    'Import new WeChat data into the local corpus:',
    `1. ${exportStep}`,
    '2. Call wechat_batches, then wechat_import with the batch that is waiting, which imports private conversations only.',
    '3. Report how many messages were added, and anything that needs attention.',
  ].join('\n')
}

const task = createSchedule({
  name: 'wechat',
  title: TASK_TITLE,
  marker: TASK_MARKER,
  prompt: taskPrompt,
})

export const { scheduleOf, listTasks, taskState } = task

/**
 * Create the recurring task when no owned task exists.
 * @param ctx - Plugin context.
 * @param sessionId - Conversation the task reports into.
 * @param options - Resolved plugin options; its recurrence, zone, and paths go into the task.
 * @returns the created task, or the existing one.
 * @throws when the composition mounts no schedule service.
 */
export function ensureTask(ctx, sessionId, options) {
  return task.ensureTask(ctx, sessionId, {
    cron: options.scheduleCron,
    timeZone: options.timeZone,
    options,
  })
}

/**
 * Replace every owned task with one fresh task, which is how a user recovers
 * after deleting the row from the automation list.
 *
 * @param ctx - Plugin context.
 * @param sessionId - Conversation the task reports into.
 * @param options - Resolved plugin options; its recurrence, zone, and paths go into the task.
 * @returns the created task.
 * @throws when the composition mounts no schedule service.
 */
export function recreateTask(ctx, sessionId, options) {
  return task.recreateTask(ctx, sessionId, {
    cron: options.scheduleCron,
    timeZone: options.timeZone,
    options,
  })
}

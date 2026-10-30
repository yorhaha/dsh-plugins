/**
 * dsh-user-todo Client half — the Calendar & Todos panel in the sidebar and the page it
 * opens: the list, the calendar, and the reminder settings.
 *
 * The page owns two reads from the bundle's `/api/user-todo` route. The list read
 * answers every stored item; the calendar read answers the occurrences a month
 * needs, which only the Host can compute because repeat rules are expanded there
 * (`docs/calendar-plan.md` explains why: a client bundle cannot import a
 * recurrence engine, and two expansions would eventually disagree).
 *
 * Every mutation answers with the state it produced, so the page renders what the
 * Host actually holds instead of predicting it. A change an agent tool makes
 * shows up on the next read; the page re-reads whenever it mounts, after every
 * mutation, and when the window regains focus.
 *
 * The item is the unit of change in the list; the occurrence is the unit in the
 * calendar. Ticking a repeating item in the list completes the next occurrence,
 * because that is what a person means by ticking the row today; ticking a chip in
 * the calendar completes exactly that day's occurrence. Stopping the series is
 * an editor action, not a tick.
 *
 * Colors come from theme tokens, copy comes from this package's own locale
 * namespace, and the controls that have no shared primitive here are copied
 * from the Harness's own patterns rather than imported.
 *
 * @module dsh-user-todo/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-user-todo',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this package. */
    const NS = 'user-todo'

    /** Panel id: the sidebar entry and the page it opens agree on it. */
    const PANEL_ID = 'user-todo'

    /** Host route, document-relative so a Harness under a sub-path still reaches it. */
    const ROUTE = 'api/user-todo'

    /** Where the chosen view is remembered between visits. */
    const VIEW_KEY = 'user-todo:view'

    /** Weekday numbers the repeat editor offers, Monday first. */
    const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]

    /**
     * Short weekday names, Monday first. Written here rather than taken from
     * `Intl` so a Chinese page never falls back to English on a machine whose
     * regional settings say something else, and English never says `Oct`/`Mon`
     * in a way a Chinese reader has to decode.
     */
    const WEEKDAY_SHORT_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const WEEKDAY_SHORT_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    /** Reminder leads the editor offers, in minutes. */
    const REMIND_CHOICES = [0, 5, 15, 30, 60, 120, 1440]

    const zh = {
      'panel.title': '日历与待办',
      'panel.total': '共 {total} 项',
      'header.title': '日历与待办',
      'header.subtitle': '助手也能读写同一份。',
      'header.refresh': '刷新',
      'header.showDone': '显示已完成',
      'header.hideDone': '隐藏已完成',
      'header.agentEdits': 'agent 最近改过',
      'view.list': '列表',
      'view.calendar': '日历',
      'view.label': '视图',
      'filter.all': '全部',
      'filter.open': '未完成',
      'filter.done': '已完成',
      'filter.clearDone': '清除已完成',
      'filter.clearDoneConfirm': '删除 {count} 项已完成待办？此操作无法撤销。',
      'notice.cleared': '已清除 {count} 项已完成',
      'compose.placeholder': '添加一项待办，回车保存',
      'compose.due': '截止',
      'compose.add': '添加',
      'compose.clearDue': '清除截止时间',
      'compose.allDay': '全天',
      'group.overdue': '已逾期',
      'group.today': '今天',
      'group.week': '本周',
      'group.later': '以后',
      'group.none': '无日期',
      'group.done': '已完成',
      'group.overdue.short': '逾期',
      'group.today.short': '今天',
      'group.week.short': '本周',
      'group.later.short': '以后',
      'group.none.short': '无日期',
      'group.done.short': '完成',
      'row.edit': '编辑',
      'row.delete': '删除',
      'row.reopen': '标记未完成',
      'row.complete': '标记完成',
      'row.byAgent': '由 agent 修改',
      'row.byUser': '由我修改',
      'row.due': '截止 {when}',
      'row.overdue': '逾期 {when}',
      'row.dueShort': '{when} 截止',
      'row.overdueShort': '逾期 {when}',
      'row.allDay': '全天',
      'row.repeats': '重复：{rule}',
      'row.next': '下次 {when}',
      'row.reminder': '{count} 次提醒',
      'edit.title': '标题',
      'edit.note': '备注',
      'edit.due': '截止时间',
      'edit.date': '日期',
      'edit.allDay': '全天',
      'edit.save': '保存',
      'edit.cancel': '取消',
      'edit.repeat': '重复',
      'edit.repeatNone': '不重复',
      'edit.repeatDaily': '每天',
      'edit.repeatWeekly': '每周',
      'edit.repeatMonthly': '每月',
      'edit.repeatYearly': '每年',
      'edit.repeatEvery': '每',
      'edit.repeatUnitDays': '天',
      'edit.repeatUnitWeeks': '周',
      'edit.repeatUnitMonths': '月',
      'edit.repeatUnitYears': '年',
      'edit.repeatWeekdays': '重复日',
      'edit.repeatNeedsDate': '先填时间或日期，才能设置重复',
      'edit.remind': '提醒',
      'edit.remindNone': '不提醒',
      'edit.remindAt': '准时',
      'edit.remindBefore': '提前 {minutes} 分钟',
      'edit.remindBeforeHours': '提前 {hours} 小时',
      'edit.remindBeforeDays': '提前 {days} 天',
      'edit.remindTarget': '提醒方式在设置里',
      'empty.none': '还没有待办。在上面输入第一项。',
      'empty.filtered': '没有符合筛选条件的待办。',
      'empty.day': '这一天没有安排。',
      'empty.reset': '清除筛选',
      'state.loading': '正在读取待办…',
      'state.loadFailed': '读取待办失败：{code}',
      'state.retry': '重试',
      'notice.created': '已添加 {count} 项',
      'notice.saved': '已保存',
      'notice.deleted': '已删除',
      'notice.undo': '撤销',
      'notice.failed': '操作失败：{code}',
      'notice.skipped': '{count} 项已跳过（列表已满）',
      'notice.skippedFull': '列表已满，部分条目未能添加',
      'notice.settingsSaved': '设置已保存',
      'calendar.title': '{year} 年 {month} 月',
      'calendar.prev': '上个月',
      'calendar.next': '下个月',
      'calendar.today': '今天',
      'calendar.more': '还有 {count} 项',
      'calendar.dayTitle': '{date}',
      'calendar.addHere': '在这一天添加',
      'calendar.hint': '点日期看当天；在下方勾选只完成这一次。',
      'settings.title': '提醒设置',
      'settings.push': '到期推送提醒',
      'settings.pushHint': '通过通知插件发到手机；没装通知插件时只在这里记录。',
      'settings.quiet': '静默时段',
      'settings.quietFrom': '从',
      'settings.quietTo': '到',
      'settings.quietOff': '关闭静默',
      'settings.digest': '每日议程推送',
      'settings.digestOff': '不推送',
      'settings.allDayTime': '全天条目的提醒时间',
      'settings.close': '关闭',
      'settings.save': '保存设置',
      'error.unreachable': '无法连接到 Harness',
      'error.invalid_title': '标题不能为空',
      'error.invalid_note': '备注过长',
      'error.invalid_due_at': '时间格式不正确',
      'error.invalid_recurrence': '重复设置不正确',
      'error.unsupported_rule': '这种重复方式暂不支持',
      'error.invalid_remind': '提醒设置不正确',
      'error.invalid_occurrence': '这一次已不存在',
      'error.not_recurring': '这一项不是重复待办',
      'error.invalid_window': '日期范围不正确',
      'error.window_too_large': '日期范围太大',
      'error.invalid_status': '状态无效',
      'error.batch_too_large': '一次提交的条目过多',
      'error.too_many_items': '待办列表已满',
      'error.not_found': '这一项已不存在',
      'error.invalid_body': '请求格式不正确',
      'error.unknown_action': '这个操作不存在',
      'error.internal': '内部错误',
    }

    const en = {
      'panel.title': 'Calendar & Todos',
      'panel.total': '{total} items',
      'header.title': 'Calendar & Todos',
      'header.subtitle': 'The agent edits the same items.',
      'header.refresh': 'Refresh',
      'header.showDone': 'Show done',
      'header.hideDone': 'Hide done',
      'header.agentEdits': 'Agent edited recently',
      'view.list': 'List',
      'view.calendar': 'Calendar',
      'view.label': 'View',
      'filter.all': 'All',
      'filter.open': 'Open',
      'filter.done': 'Done',
      'filter.clearDone': 'Clear done',
      'filter.clearDoneConfirm': 'Delete {count} finished item(s)? This cannot be undone.',
      'notice.cleared': 'Cleared {count} finished item(s)',
      'compose.placeholder': 'Add an item, Enter to save',
      'compose.due': 'Due',
      'compose.add': 'Add',
      'compose.clearDue': 'Clear the due time',
      'compose.allDay': 'All day',
      'group.overdue': 'Overdue',
      'group.today': 'Today',
      'group.week': 'This week',
      'group.later': 'Later',
      'group.none': 'No date',
      'group.done': 'Done',
      'group.overdue.short': 'Overdue',
      'group.today.short': 'Today',
      'group.week.short': 'Week',
      'group.later.short': 'Later',
      'group.none.short': 'No date',
      'group.done.short': 'Done',
      'row.edit': 'Edit',
      'row.delete': 'Delete',
      'row.reopen': 'Mark open',
      'row.complete': 'Mark done',
      'row.byAgent': 'Edited by the agent',
      'row.byUser': 'Edited by me',
      'row.due': 'Due {when}',
      'row.overdue': 'Overdue {when}',
      'row.dueShort': '{when}',
      'row.overdueShort': 'Overdue {when}',
      'row.allDay': 'All day',
      'row.repeats': 'Repeats {rule}',
      'row.next': 'Next {when}',
      'row.reminder': '{count} reminders',
      'edit.title': 'Title',
      'edit.note': 'Note',
      'edit.due': 'Due time',
      'edit.date': 'Date',
      'edit.allDay': 'All day',
      'edit.save': 'Save',
      'edit.cancel': 'Cancel',
      'edit.repeat': 'Repeat',
      'edit.repeatNone': 'Does not repeat',
      'edit.repeatDaily': 'Daily',
      'edit.repeatWeekly': 'Weekly',
      'edit.repeatMonthly': 'Monthly',
      'edit.repeatYearly': 'Yearly',
      'edit.repeatEvery': 'Every',
      'edit.repeatUnitDays': 'days',
      'edit.repeatUnitWeeks': 'weeks',
      'edit.repeatUnitMonths': 'months',
      'edit.repeatUnitYears': 'years',
      'edit.repeatWeekdays': 'On',
      'edit.repeatNeedsDate': 'Set a time or date before it can repeat',
      'edit.remind': 'Reminder',
      'edit.remindNone': 'No reminder',
      'edit.remindAt': 'At the due time',
      'edit.remindBefore': '{minutes} min before',
      'edit.remindBeforeHours': '{hours} h before',
      'edit.remindBeforeDays': '{days} d before',
      'edit.remindTarget': 'Delivery is set in the settings',
      'empty.none': 'No items yet. Type the first one above.',
      'empty.filtered': 'No item matches this filter.',
      'empty.day': 'Nothing on this day.',
      'empty.reset': 'Clear the filter',
      'state.loading': 'Reading the list…',
      'state.loadFailed': 'Reading the list failed: {code}',
      'state.retry': 'Retry',
      'notice.created': 'Added {count}',
      'notice.saved': 'Saved',
      'notice.deleted': 'Deleted',
      'notice.undo': 'Undo',
      'notice.failed': 'That failed: {code}',
      'notice.skipped': '{count} skipped (list full)',
      'notice.skippedFull': 'The list is full; some items were not added',
      'notice.settingsSaved': 'Settings saved',
      'calendar.title': '{month} {year}',
      'calendar.prev': 'Previous month',
      'calendar.next': 'Next month',
      'calendar.today': 'Today',
      'calendar.more': '{count} more',
      'calendar.dayTitle': '{date}',
      'calendar.addHere': 'Add on this day',
      'calendar.hint': 'Pick a date to see the day; tick it below to complete only that occurrence.',
      'settings.title': 'Reminder settings',
      'settings.push': 'Push reminders when due',
      'settings.pushHint': 'Sent to your phone through the notification plugin; without it, reminders are only recorded here.',
      'settings.quiet': 'Quiet hours',
      'settings.quietFrom': 'from',
      'settings.quietTo': 'to',
      'settings.quietOff': 'No quiet hours',
      'settings.digest': 'Daily agenda push',
      'settings.digestOff': 'Off',
      'settings.allDayTime': 'Reminder time for all-day items',
      'settings.close': 'Close',
      'settings.save': 'Save settings',
      'error.unreachable': 'Cannot reach the Harness',
      'error.invalid_title': 'A title is required',
      'error.invalid_note': 'The note is too long',
      'error.invalid_due_at': 'That time is not a valid form',
      'error.invalid_recurrence': 'That repeat rule is not valid',
      'error.unsupported_rule': 'That repeat rule is not supported',
      'error.invalid_remind': 'That reminder is not valid',
      'error.invalid_occurrence': 'That occurrence no longer exists',
      'error.not_recurring': 'That item does not repeat',
      'error.invalid_window': 'That date range is not valid',
      'error.window_too_large': 'That date range is too large',
      'error.invalid_status': 'That status is not valid',
      'error.batch_too_large': 'Too many entries in one request',
      'error.too_many_items': 'The list is full',
      'error.not_found': 'That item no longer exists',
      'error.invalid_body': 'That request was malformed',
      'error.unknown_action': 'That action does not exist',
      'error.internal': 'Internal error',
    }

    /** Two digits, for building a `YYYY-MM-DD` key. */
    function pad(value) {
      return String(value).padStart(2, '0')
    }

    /**
     * A time of day as 24-hour `HH:MM`, for every reader and every locale.
     *
     * `hour: '2-digit'` alone does not choose a cycle: a locale that prefers a
     * 12-hour clock (en-US among them) still gets `09:05 AM`, and even a 24-hour
     * locale can spell midnight `24:00`. The cycle is therefore pinned to `h23`
     * and the separator written by hand, so the panel never shows AM or PM.
     *
     * @param at - the date to read the clock from.
     * @returns two digits, a colon, two digits.
     */
    function timeText(at) {
      return `${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /**
     * The page's active language, read from the document the locale service keeps
     * in sync (`<html lang>` is `zh-CN` for 中文 and the language id otherwise).
     *
     * Date and time wording follows the interface language rather than the
     * browser's regional settings, so a Chinese page reads 中文 however the
     * machine is configured.
     *
     * @returns `'zh'` for a Chinese page, `'en'` for every other.
     */
    function uiLanguage() {
      const lang = typeof document !== 'undefined' ? String(document.documentElement?.lang ?? '') : ''
      return /^zh\b/i.test(lang) ? 'zh' : 'en'
    }

    /**
     * One day as a short date: `10月28日` in Chinese, `10-28` in English.
     *
     * The year is left out because every date this page shows is a deadline,
     * a due day, or a calendar day of the month on screen.
     *
     * @param at - the date to format.
     * @returns the text.
     */
    function dateShort(at) {
      if (uiLanguage() === 'zh') return `${at.getMonth() + 1}月${at.getDate()}日`
      return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    }

    /**
     * One day and its clock as `10月28日 19:56` / `10-28 19:56`.
     *
     * @param at - the date to format.
     * @returns the text.
     */
    function dateTimeShort(at) {
      return `${dateShort(at)} ${timeText(at)}`
    }

    /**
     * A weekday name for a UI language: `周一` / `Mon`.
     *
     * @param day - the ISO weekday, Monday 1 … Sunday 7.
     * @param language - the UI language from {@link uiLanguage}.
     * @returns the short name.
     */
    function weekdayText(day, language) {
      const index = Math.max(0, Math.min(6, day - 1))
      return (language === 'zh' ? WEEKDAY_SHORT_ZH : WEEKDAY_SHORT_EN)[index]
    }

    /**
     * A weekday name for an arbitrary date, used by the calendar's header row.
     *
     * @param at - any date; only its weekday is read.
     * @returns the short name.
     */
    function weekdayOfDate(at) {
      const day = at.getDay()
      return weekdayText(day === 0 ? 7 : day, uiLanguage())
    }

    /** The local `YYYY-MM-DD` of one date. */
    function dateKey(at) {
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    }

    /** Parse a `YYYY-MM-DD` into a local date. */
    function dateOf(key) {
      const [year, month, day] = key.split('-').map(Number)
      return new Date(year, month - 1, day)
    }

    /** One date shifted by whole days. */
    function addDays(key, days) {
      const at = dateOf(key)
      at.setDate(at.getDate() + days)
      return dateKey(at)
    }

    /** The ISO weekday of a date: Monday 1 … Sunday 7. */
    function weekdayOf(key) {
      const day = dateOf(key).getDay()
      return day === 0 ? 7 : day
    }

    /** Today's local date. */
    function todayKey() {
      return dateKey(new Date())
    }

    /**
     * The date a week starts on, for a given first weekday.
     *
     * @param key - any date.
     * @param weekStart - 1 for Monday, 7 for Sunday.
     * @returns that week's first date.
     */
    function startOfWeek(key, weekStart) {
      return addDays(key, -((weekdayOf(key) - weekStart + 7) % 7))
    }

    /**
     * The six-week grid one month occupies.
     *
     * @param year - four-digit year.
     * @param month - 1-based month.
     * @param weekStart - 1 for Monday, 7 for Sunday.
     * @returns 42 date keys, ascending.
     */
    function monthGrid(year, month, weekStart) {
      const first = `${year}-${pad(month)}-01`
      const start = startOfWeek(first, weekStart)
      return Array.from({ length: 42 }, (_unused, index) => addDays(start, index))
    }

    /** The CSS the panel installs once. */
    const CSS = `
.dsh-ut-page { display: block; min-height: 100%; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-ut-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.dsh-ut-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
.dsh-ut-subtitle { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-ut-summary { display: flex; align-items: center; gap: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.dsh-ut-compose:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.dsh-ut-compose-title { flex: 1 1 160px; min-width: 0; height: 32px; padding: 0 8px; border: none; outline: none; background: transparent; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dsh-ut-compose-title::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-ut-date { height: 26px; padding: 0 8px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; }
.dsh-ut-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.dsh-ut-button:disabled { cursor: not-allowed; opacity: 0.4; }
.dsh-ut-button[data-variant="primary"]:disabled { opacity: 1; }
.dsh-ut-button[data-variant="outline"] { border: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-ut-button[data-variant="outline"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ut-button[data-variant="ghost"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ut-button[data-variant="toggle"][aria-pressed="true"] { background: var(--dsw-alias-button-ghost-active-fill); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border); }
.dsh-ut-segment { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); }
.dsh-ut-segment .dsh-ut-button { height: 24px; padding: 0 10px; border-radius: 999px; color: var(--dsw-alias-label-secondary); }
.dsh-ut-segment .dsh-ut-button[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-alias-shadow-s); }
.dsh-ut-filters { display: inline-flex; align-items: center; gap: 4px; }
.dsh-ut-pill { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l4); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.dsh-ut-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ut-pill[aria-pressed="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-button-ghost-active-fill); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border); }
.dsh-ut-pill-count { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsh-ut-notice-region { display: flex; align-items: center; min-height: 26px; padding: 2px 20px; }
.dsh-ut-notice { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px; border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dsh-ut-notice[data-tone="error"] { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-ut-notice[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); }
.dsh-ut-notice .dsh-ut-button { height: 22px; padding: 0 6px; color: inherit; }
.dsh-ut-body { display: block; padding: 4px 20px 40px; }
.dsh-ut-group { display: block; padding: 0; }
.dsh-ut-group + .dsh-ut-group { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-ut-card .dsh-ut-group .dsh-ut-group-head { padding: 6px 12px; background: var(--dsw-alias-bg-layer-2); font-size: 11.5px; line-height: 17px; }
.dsh-ut-group-head { display: flex; align-items: center; gap: 6px; padding: 6px 0; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-ut-group-count { font-weight: 500; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsh-ut-row:hover, .dsh-ut-row:focus-within { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l4); }
.dsh-ut-check { flex: 0 0 auto; width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); border-radius: 4px; cursor: pointer; }
.dsh-ut-check:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-ut-check:disabled { cursor: default; opacity: 0.5; }
.dsh-ut-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dsh-ut-row-title { display: block; appearance: none; padding: 0; border: 0; background: none; font: inherit; font-size: 13.5px; line-height: 21px; font-weight: 500; color: var(--dsw-alias-label-primary); text-align: left; word-break: break-word; cursor: text; }
.dsh-ut-row-title:hover { color: var(--dsw-alias-state-business-primary); }
.dsh-ut-row[data-done="true"] .dsh-ut-row-title { font-weight: 400; color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
.dsh-ut-row-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-word; }
.dsh-ut-row-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-ut-chip { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.dsh-ut-chip[data-tone="warning"] { border-color: transparent; color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); }
.dsh-ut-chip[data-tone="danger"] { border-color: transparent; color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-state-error-primary); }
.dsh-ut-chip[data-tone="info"] { border-color: transparent; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-3); }
.dsh-ut-actions { display: flex; align-items: center; gap: 2px; flex: none; opacity: 0; transition: opacity 120ms ease; }
.dsh-ut-row:hover .dsh-ut-actions, .dsh-ut-row:focus-within .dsh-ut-actions { opacity: 1; }
@media (hover: none) { .dsh-ut-actions { opacity: 1; } }
.dsh-ut-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-ut-icon-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-ut-icon-button[data-danger="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.dsh-ut-icon-button:disabled { cursor: not-allowed; opacity: 0.4; }
.dsh-ut-icon-button[aria-pressed="true"] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); }
.dsh-ut-editor { display: flex; flex-direction: column; gap: 10px; width: 100%; padding: 12px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l4); }
.dsh-ut-editor-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.dsh-ut-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsh-ut-field input, .dsh-ut-field textarea, .dsh-ut-field select { height: 32px; padding: 0 8px; border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; }
.dsh-ut-field input:focus, .dsh-ut-field textarea:focus, .dsh-ut-field select:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.dsh-ut-field textarea { height: auto; min-height: 60px; padding: 6px 8px; resize: vertical; }
.dsh-ut-empty > svg { color: var(--dsw-alias-label-dimmed); }
.dsh-ut-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 56px 16px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.dsh-ut-empty-title { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.dsh-ut-empty-action { margin-top: 8px; }
.dsh-ut-header { display: flex; align-items: flex-start; gap: 12px; padding: 20px 20px 14px; flex-wrap: wrap; }
.dsh-ut-header-tools { display: inline-flex; align-items: center; gap: 6px; }
.dsh-ut-card { display: block; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l4); overflow: hidden; }
.dsh-ut-card .dsh-ut-row { border-radius: 0; border: none; }
.dsh-ut-card .dsh-ut-row + .dsh-ut-row { margin-top: 0; }
.dsh-ut-card .dsh-ut-row:hover, .dsh-ut-card .dsh-ut-row:focus-within { border-color: transparent; background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ut-compose-meta { display: inline-flex; align-items: center; gap: 8px; }
.dsh-ut-row { display: flex; padding: 8px 12px; align-items: flex-start; gap: 10px; }
.dsh-ut-compose { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 20px; padding: 6px 6px 6px 10px; border-radius: 22px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l4); }
.dsh-ut-compose-title { height: 32px; }
.dsh-ut-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 20px 6px; }
.dsh-ut-placeholder { height: 26px; padding: 0 10px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.dsh-ut-placeholder:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-ut-button[data-variant="primary"] { background: var(--dsw-alias-button-info-fill); color: var(--dsw-alias-label-primary-foreground); font-weight: 500; }
.dsh-ut-button[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover); }
.dsh-ut-button[data-variant="primary"]:disabled { background: var(--dsw-alias-button-primary-dimmed); color: var(--dsw-alias-label-tertiary); }

/* Calendar */
.dsh-ut-cal-head { display: flex; align-items: center; gap: 8px; padding: 4px 20px 10px; flex-wrap: wrap; }
.dsh-ut-cal-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; min-width: 120px; }
.dsh-ut-cal-scroll { padding: 0 20px; }
.dsh-ut-cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-radius: var(--dsw-radius-lg); border: 0.5px solid var(--dsw-alias-border-l4); overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.dsh-ut-cal-weekday { padding: 6px 8px; font-size: 11px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2); text-align: left; }
.dsh-ut-cal-cell { min-height: 84px; padding: 4px 4px 6px; border-top: 0.5px solid var(--dsw-alias-border-l1); border-left: 0.5px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 2px; align-items: stretch; background: transparent; text-align: left; cursor: pointer; }
.dsh-ut-cal-cell:nth-child(7n + 1) { border-left: none; }
.dsh-ut-cal-cell:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ut-cal-cell[data-outside="true"] { background: var(--dsw-alias-bg-base); }
.dsh-ut-cal-cell[data-outside="true"] .dsh-ut-cal-day { color: var(--dsw-alias-label-dimmed); }
.dsh-ut-cal-cell[data-selected="true"] { box-shadow: inset 0 0 0 1.5px var(--dsw-alias-state-business-primary); }
.dsh-ut-cal-cell:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.dsh-ut-cal-day { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 999px; font-size: 11.5px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-ut-cal-cell[data-today="true"] .dsh-ut-cal-day { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }
.dsh-ut-cal-chip { display: block; width: 100%; border: none; border-radius: 4px; padding: 1px 4px; font: inherit; font-size: 11px; line-height: 15px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-3); cursor: pointer; }
.dsh-ut-cal-chip[data-tone="danger"] { color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-state-error-primary); }
.dsh-ut-cal-chip[data-done="true"] { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
.dsh-ut-cal-chip:hover { color: var(--dsw-alias-label-primary); }
.dsh-ut-cal-more { font-size: 10.5px; line-height: 14px; color: var(--dsw-alias-label-tertiary); padding: 0 4px; }
.dsh-ut-day { margin: 12px 20px 0; }
.dsh-ut-day-head { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-ut-day-hint { padding: 0 20px; font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }

/* Settings sheet */
.dsh-ut-sheet { position: relative; margin: 0 20px 8px; padding: 12px 14px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l4); display: flex; flex-direction: column; gap: 12px; }
.dsh-ut-sheet-head { display: flex; align-items: center; gap: 8px; }
.dsh-ut-sheet-title { font-size: 13px; line-height: 20px; font-weight: 600; flex: 1; }
.dsh-ut-sheet-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-ut-sheet-row > .dsh-ut-sheet-label { min-width: 120px; }
.dsh-ut-sheet-hint { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
.dsh-ut-switch { display: inline-flex; align-items: center; gap: 6px; }
.dsh-ut-switch input { accent-color: var(--dsw-alias-brand-primary); width: 16px; height: 16px; }
.dsh-ut-sheet input[type="time"], .dsh-ut-sheet input[type="date"] { height: 26px; padding: 0 6px; border-radius: var(--dsw-radius-sm); border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
.dsh-ut-weekday-row { display: inline-flex; gap: 4px; flex-wrap: wrap; }

@media (max-width: 560px) {
  .dsh-ut-header, .dsh-ut-toolbar, .dsh-ut-notice-region, .dsh-ut-cal-head { padding-left: 14px; padding-right: 14px; }
  .dsh-ut-compose { margin: 0 14px; }
  .dsh-ut-body, .dsh-ut-cal-scroll { padding-left: 14px; padding-right: 14px; }
  .dsh-ut-day, .dsh-ut-day-hint, .dsh-ut-sheet { margin-left: 14px; margin-right: 14px; }
  .dsh-ut-day-hint { padding: 0 14px; }
  .dsh-ut-compose-title { flex-basis: 100%; }
  .dsh-ut-compose-meta { flex: 1 1 auto; min-width: 0; }
  .dsh-ut-date { min-width: 0; max-width: 180px; }
  .dsh-ut-cal-cell { min-height: 54px; }
  .dsh-ut-cal-chip { font-size: 10px; line-height: 13px; padding: 0 2px; }
}
@media (max-width: 400px) {
  .dsh-ut-title { font-size: 14px; line-height: 20px; letter-spacing: 0; }
  .dsh-ut-row { padding: 8px; gap: 8px; }
  .dsh-ut-pill { padding: 0 7px; }
}

`

    /**
     * Text for one failure code.
     *
     * @param code - the Host's closed code.
     * @param t - the page translator.
     * @returns the copy.
     */
    function failureText(code, t) {
      const key = `error.${typeof code === 'string' && code !== '' ? code : 'internal'}`
      const text = t(key)
      return text === key ? t('error.internal') : text
    }

    /**
     * Fill the `{name}` holes of one translated string. The dictionary keeps an
     * entry's holes as placeholders so every key stays a flat literal.
     *
     * @param text - the translated string.
     * @param values - the hole values.
     * @returns the filled text.
     */
    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
    }

    /**
     * One stored item with every optional field filled.
     *
     * The Host always sends the full shape, but a document written before the
     * calendar existed opens with defaults only on the Host side, and a cached
     * answer could predate a field. Filling here keeps the render total: a
     * missing `recurrence` must read as "does not repeat", not as `undefined`.
     *
     * @param item - the stored item.
     * @returns the item with defaults applied.
     */
    function normalizeItem(item) {
      return {
        dueDate: null,
        timeZone: null,
        recurrence: null,
        recurrenceDoneThrough: null,
        exdates: [],
        remindBeforeMin: [],
        nextAt: null,
        ...item,
      }
    }

    /**
     * Request one panel read.
     *
     * @param params - query parameters.
     * @returns the value the Host answered.
     * @throws an Error carrying the Host's code.
     */
    async function read(params) {
      const url = new URL(ROUTE, document.baseURI)
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
      let response
      try {
        response = await fetch(url, { headers: { accept: 'application/json' } })
      } catch {
        throw Object.assign(new Error('unreachable'), { code: 'unreachable' })
      }
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload.ok !== true) {
        const code = payload?.error?.code ?? `http_${response.status}`
        throw Object.assign(new Error(code), { code })
      }
      return payload.value
    }

    /**
     * The stored list.
     *
     * @returns the items.
     */
    async function readList() {
      const value = await read({})
      return (Array.isArray(value?.items) ? value.items : []).map(normalizeItem)
    }

    /**
     * One window of occurrences.
     *
     * @param from - first date, `YYYY-MM-DD`.
     * @param to - exclusive end date, `YYYY-MM-DD`.
     * @returns the agenda answer.
     */
    async function readAgenda(from, to) {
      return read({ action: 'agenda', from, to })
    }

    /**
     * The person's reminder settings.
     *
     * @returns the prefs.
     */
    async function readPrefs() {
      const value = await read({ action: 'prefs' })
      return value?.prefs ?? {}
    }

    /**
     * Post one panel mutation; the answer carries the state it produced.
     *
     * @param action - the action name.
     * @param body - the action's fields.
     * @returns the outcome and the state.
     */
    async function mutate(action, body) {
      let response
      try {
        response = await fetch(new URL(ROUTE, document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ action, ...body }),
        })
      } catch {
        throw Object.assign(new Error('unreachable'), { code: 'unreachable' })
      }
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload.ok !== true) {
        const code = payload?.error?.code ?? `http_${response.status}`
        throw Object.assign(new Error(code), { code })
      }
      return payload.value
    }

    /**
     * Today's local midnight, the boundary of the date groups.
     *
     * @param now - the clock.
     * @returns the epoch milliseconds of local midnight.
     */
    function startOfToday(now) {
      const at = new Date(now)
      at.setHours(0, 0, 0, 0)
      return at.getTime()
    }

    /**
     * The date bucket of one item, from its deadline.
     *
     * @param item - the item.
     * @param today - start-of-today milliseconds.
     * @returns the bucket key.
     */
    function bucketOf(item, today) {
      if (item.status === 'done') return 'done'
      const due = typeof item.dueDate === 'string'
        ? dateOf(item.dueDate).getTime()
        : (item.dueAt === null ? Number.NaN : Date.parse(item.dueAt))
      if (Number.isNaN(due)) return 'none'
      if (due < today) return 'overdue'
      if (due < today + 24 * 3600 * 1000) return 'today'
      if (due < today + 7 * 24 * 3600 * 1000) return 'week'
      return 'later'
    }

    /** Buckets in display order. */
    const GROUPS = ['overdue', 'today', 'week', 'later', 'none', 'done']

    /**
     * Order items inside a bucket by deadline, then by arrival.
     *
     * @param a - left item.
     * @param b - right item.
     * @returns the comparison.
     */
    function compare(a, b) {
      const left = a.dueAt ?? '9999'
      const right = b.dueAt ?? '9999'
      if (left !== right) return left < right ? -1 : 1
      return a.createdAt.localeCompare(b.createdAt)
    }

    /**
     * The value a `datetime-local` input shows for one instant, in local time.
     *
     * @param iso - the stored instant, or null.
     * @returns the input value.
     */
    function toLocalInput(iso) {
      if (typeof iso !== 'string') return ''
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /**
     * The stored instant for one `datetime-local` value, minutes precision kept.
     *
     * @param value - the input value.
     * @returns the instant, or null when the input is empty.
     */
    function fromLocalInput(value) {
      if (typeof value !== 'string' || value === '') return null
      const at = new Date(value)
      if (Number.isNaN(at.getTime())) return null
      const iso = at.toISOString()
      return `${iso.slice(0, 19)}Z`
    }

    /**
     * A short human form of one instant or date.
     *
     * @param value - `YYYY-MM-DD` or an instant.
     * @param allDay - whether the date, not the instant, is what matters.
     * @returns the text.
     */
    function whenText(value, allDay) {
      if (typeof value !== 'string') return ''
      if (allDay) {
        return dateShort(dateOf(value.slice(0, 10)))
      }
      const at = new Date(value)
      if (Number.isNaN(at.getTime())) return value
      return dateTimeShort(at)
    }

    /**
     * A short human form of one reminder offset.
     *
     * @param minutes - minutes before the due moment.
     * @param t - the page translator.
     * @returns the text.
     */
    function remindText(minutes, t) {
      if (minutes === 0) return t('edit.remindAt')
      if (minutes % 1440 === 0) return fill(t('edit.remindBeforeDays'), { days: minutes / 1440 })
      if (minutes % 60 === 0) return fill(t('edit.remindBeforeHours'), { hours: minutes / 60 })
      return fill(t('edit.remindBefore'), { minutes })
    }

    /**
     * A short human form of one repeat rule.
     *
     * @param rule - the stored rule.
     * @param t - the page translator.
     * @returns the text, or null when there is no rule.
     */
    function repeatText(rule, t) {
      if (rule === null || rule === undefined) return null
      const unit = { daily: 'edit.repeatUnitDays', weekly: 'edit.repeatUnitWeeks', monthly: 'edit.repeatUnitMonths', yearly: 'edit.repeatUnitYears' }[rule.freq]
      const head = rule.interval > 1 ? `${t('edit.repeatEvery')} ${rule.interval} ${t(unit)}` : t({
        daily: 'edit.repeatDaily', weekly: 'edit.repeatWeekly', monthly: 'edit.repeatMonthly', yearly: 'edit.repeatYearly',
      }[rule.freq])
      if (rule.freq !== 'weekly' || !Array.isArray(rule.byWeekday) || rule.byWeekday.length === 0) return head
      const language = uiLanguage()
      const names = rule.byWeekday.map(day => weekdayText(day, language))
      return `${head} ${names.join(' ')}`
    }

    /** Props for every icon this page draws: the Host's 16px glyphs. */
    const ICON_SIZE = 16

    /**
     * The panel icon the sidebar draws.
     *
     * @param props - the sidebar's icon share.
     * @returns the glyph.
     */
    function PanelIcon(props) {
      return h('svg', {
        width: props.size,
        height: props.size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }),
      h('path', { d: 'M8 10.5l1.6 1.6L12.5 9' }),
      h('path', { d: 'M15 10.5h2M8 16h9' }))
    }

    /**
     * A small inline glyph, copied from the Host's own icon set: a plugin cannot
     * import the primitives package, so the strokes are restated here at the same
     * 16px box and 1.6 stroke.
     *
     * @param props - the glyph name.
     * @returns the glyph.
     */
    function Glyph(props) {
      const common = {
        width: ICON_SIZE,
        height: ICON_SIZE,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }
      switch (props.name) {
        case 'plus': return h('svg', common, h('path', { d: 'M12 5v14M5 12h14' }))
        case 'refresh': return h('svg', common, h('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }), h('path', { d: 'M20 4v5h-5' }))
        case 'edit': return h('svg', common, h('path', { d: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z' }), h('path', { d: 'M13.5 6.5l3 3' }))
        case 'trash': return h('svg', common, h('path', { d: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13' }), h('path', { d: 'M10 11v5M14 11v5' }))
        case 'check': return h('svg', common, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))
        case 'close': return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
        case 'list': return h('svg', common, h('path', { d: 'M9 6h11M9 12h11M9 18h11' }), h('path', { d: 'M4 6h.01M4 12h.01M4 18h.01' }))
        case 'calendar': return h('svg', common, h('rect', { x: 4, y: 5, width: 16, height: 15, rx: 2.5 }), h('path', { d: 'M8 3v4M16 3v4M4 10h16' }))
        case 'bell': return h('svg', common, h('path', { d: 'M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10z' }), h('path', { d: 'M10 18.5a2 2 0 0 0 4 0' }))
        case 'repeat': return h('svg', common, h('path', { d: 'M6 8h10a3 3 0 0 1 3 3v1' }), h('path', { d: 'M8.5 5.5L6 8l2.5 2.5' }), h('path', { d: 'M18 16H8a3 3 0 0 1-3-3v-1' }), h('path', { d: 'M15.5 18.5L18 16l-2.5-2.5' }))
        case 'chevronLeft': return h('svg', common, h('path', { d: 'M14.5 6L9 12l5.5 6' }))
        case 'chevronRight': return h('svg', common, h('path', { d: 'M9.5 6L15 12l-5.5 6' }))
        case 'settings': return h('svg', common, h('circle', { cx: 12, cy: 12, r: 3 }), h('path', { d: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4' }))
        default: return null
      }
    }

    /**
     * A labelled control in the editor.
     *
     * @param props - the label and the control.
     * @returns the element.
     */
    function Field(props) {
      return h('label', { className: 'dsh-ut-field' }, props.label, props.children)
    }

    /**
     * The repeat editor: a frequency, an interval, and (for weekly) the days.
     *
     * @param props - the stored rule, the copy, and the change handler.
     * @returns the element.
     */
    function RepeatEditor(props) {
      const { rule, t, onChange, disabled = false } = props
      const freq = rule === null ? '' : rule.freq
      const interval = rule === null ? 1 : rule.interval
      const days = rule === null || !Array.isArray(rule.byWeekday) ? [] : rule.byWeekday
      const unit = { daily: 'edit.repeatUnitDays', weekly: 'edit.repeatUnitWeeks', monthly: 'edit.repeatUnitMonths', yearly: 'edit.repeatUnitYears' }[freq]
      const setFreq = (next) => {
        if (next === '') { onChange(null); return }
        onChange({
          freq: next,
          interval: interval,
          byWeekday: next === 'weekly' ? (days.length > 0 ? days : []) : [],
          count: rule?.count ?? null,
          until: rule?.until ?? null,
          dtstart: null,
        })
      }
      return h('div', { className: 'dsh-ut-editor-row' },
        h(Field, { label: t('edit.repeat') },
          h('select', {
            value: freq,
            disabled,
            title: disabled ? t('edit.repeatNeedsDate') : undefined,
            onChange: event => setFreq(event.target.value),
          },
          h('option', { value: '' }, t('edit.repeatNone')),
          h('option', { value: 'daily' }, t('edit.repeatDaily')),
          h('option', { value: 'weekly' }, t('edit.repeatWeekly')),
          h('option', { value: 'monthly' }, t('edit.repeatMonthly')),
          h('option', { value: 'yearly' }, t('edit.repeatYearly')))),
        disabled ? h('span', { className: 'dsh-ut-sheet-hint' }, t('edit.repeatNeedsDate')) : null,
        freq === '' || disabled ? null : h(Field, { label: t('edit.repeatEvery') },
          h('input', {
            type: 'number',
            min: 1,
            max: 100,
            value: interval,
            style: { width: 64 },
            onChange: (event) => {
              const next = Math.max(1, Math.min(100, Number(event.target.value) || 1))
              onChange({ ...rule, interval: next })
            },
          })),
        freq === '' || disabled ? null : h('span', { className: 'dsh-ut-field' }, t(unit)),
        freq !== 'weekly' || disabled ? null : h(Field, { label: t('edit.repeatWeekdays') },
          h('span', { className: 'dsh-ut-weekday-row' },
            ...WEEKDAYS.map(day => h('button', {
              key: day,
              type: 'button',
              className: 'dsh-ut-pill',
              'aria-pressed': String(days.includes(day)),
              onClick: () => {
                const next = days.includes(day) ? days.filter(entry => entry !== day) : [...days, day].sort()
                onChange({ ...rule, byWeekday: next })
              },
            }, weekdayText(day, uiLanguage()))))))
    }

    /**
     * One row's editor: title, deadline, repeat, reminder, and note.
     *
     * @param props - the item, the locale copy, and the save/cancel handlers.
     * @returns the element.
     */
    function Editor(props) {
      const { item, t, busy, onSave, onCancel } = props
      const allDay = item.dueDate !== null
      const [title, setTitle] = React.useState(item.title)
      const [dateOnly, setDateOnly] = React.useState(allDay)
      const [due, setDue] = React.useState(allDay ? (item.dueDate ?? '') : toLocalInput(item.dueAt))
      const [note, setNote] = React.useState(item.note ?? '')
      const [rule, setRule] = React.useState(item.recurrence ?? null)
      const [remind, setRemind] = React.useState(Array.isArray(item.remindBeforeMin) && item.remindBeforeMin.length > 0 ? item.remindBeforeMin[0] : null)
      const titleRef = React.useRef(null)
      React.useEffect(() => { titleRef.current?.focus() }, [])
      const save = () => {
        if (title.trim() === '') return
        const dueAt = due === '' ? null : (dateOnly ? due : fromLocalInput(due))
        onSave({
          title: title.trim(),
          due: dueAt === null ? null : { dueAt, dueDate: dateOnly ? due : null, timeZone: null },
          recurrence: rule,
          remindBeforeMin: remind === null ? [] : [remind],
          note: note.trim() === '' ? null : note.trim(),
        })
      }
      return h('div', {
        className: 'dsh-ut-editor',
        role: 'group',
        'aria-label': t('edit.title'),
        onKeyDown: (event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save()
        },
      },
      h(Field, { label: t('edit.title') },
        h('input', { ref: titleRef, value: title, maxLength: 200, onChange: event => setTitle(event.target.value) })),
      h('div', { className: 'dsh-ut-editor-row' },
        h(Field, { label: dateOnly ? t('edit.date') : t('edit.due') },
          h('input', {
            type: dateOnly ? 'date' : 'datetime-local',
            value: due,
            onChange: event => setDue(event.target.value),
          })),
        h('label', { className: 'dsh-ut-field' },
          h('span', null, t('edit.allDay')),
          h('span', { className: 'dsh-ut-switch' },
            h('input', {
              type: 'checkbox',
              checked: dateOnly,
              onChange: (event) => {
                const next = event.target.checked
                setDateOnly(next)
                setDue(next ? (due === '' ? '' : due.slice(0, 10)) : (due === '' ? '' : `${due.slice(0, 10)}T09:00`))
              },
            })))),
      h(RepeatEditor, { rule, t, onChange: setRule, disabled: due === '' }),
      h('div', { className: 'dsh-ut-editor-row' },
        h(Field, { label: t('edit.remind') },
          h('select', {
            value: remind === null ? '' : String(remind),
            onChange: event => setRemind(event.target.value === '' ? null : Number(event.target.value)),
          },
          h('option', { value: '' }, t('edit.remindNone')),
          ...REMIND_CHOICES.map(minutes => h('option', { key: minutes, value: String(minutes) }, remindText(minutes, t))))),
        h('span', { className: 'dsh-ut-sheet-hint' }, t('edit.remindTarget'))),
      h(Field, { label: t('edit.note') },
        h('textarea', { value: note, maxLength: 2000, onChange: event => setNote(event.target.value) })),
      h('div', { className: 'dsh-ut-editor-row' },
        h('button', { type: 'button', className: 'dsh-ut-button', 'data-variant': 'primary', disabled: busy || title.trim() === '', onClick: save }, t('edit.save')),
        h('button', { type: 'button', className: 'dsh-ut-button', 'data-variant': 'ghost', disabled: busy, onClick: onCancel }, t('edit.cancel'))))
    }

    /**
     * One item: its state, its text, its labels, and its actions.
     *
     * @param props - the item, the copy, and the row handlers.
     * @returns the element.
     */
    function Row(props) {
      const { item, t, busy, onToggle, onEdit, onDelete } = props
      const today = startOfToday(Date.now())
      const allDay = item.dueDate !== null
      const due = typeof item.dueDate === 'string'
        ? dateOf(item.dueDate).getTime()
        : (item.dueAt === null ? null : Date.parse(item.dueAt))
      const overdue = item.status === 'open' && due !== null && due < today
      const dueText = due === null || Number.isNaN(due) ? null : whenText(allDay ? item.dueDate : item.dueAt, allDay)
      const repeat = repeatText(item.recurrence, t)
      return h('div', { className: 'dsh-ut-row', 'data-done': String(item.status === 'done'), 'data-id': item.id },
        h('input', {
          type: 'checkbox',
          className: 'dsh-ut-check',
          checked: item.status === 'done',
          disabled: busy,
          'aria-label': item.status === 'done' ? t('row.reopen') : t('row.complete'),
          onChange: () => onToggle(item),
        }),
        h('div', { className: 'dsh-ut-main' },
          h('button', {
            type: 'button',
            className: 'dsh-ut-row-title',
            title: t('row.edit'),
            onClick: () => onEdit(item.id),
          }, item.title),
          item.note === null ? null : h('div', { className: 'dsh-ut-row-note' }, item.note),
          h('div', { className: 'dsh-ut-row-meta' },
            dueText === null ? null : h('span', {
              className: 'dsh-ut-chip',
              'data-tone': overdue ? 'danger' : undefined,
              title: fill(t(overdue ? 'row.overdue' : 'row.due'), { when: dueText }),
            }, allDay ? `${t('row.allDay')} · ${dueText}` : fill(t(overdue ? 'row.overdueShort' : 'row.dueShort'), { when: dueText })),
            repeat === null ? null : h('span', { className: 'dsh-ut-chip', 'data-tone': 'info', title: fill(t('row.repeats'), { rule: repeat }) }, `↻ ${repeat}`),
            Array.isArray(item.remindBeforeMin) && item.remindBeforeMin.length > 0
              ? h('span', { className: 'dsh-ut-chip', title: fill(t('row.reminder'), { count: item.remindBeforeMin.length }) }, remindText(item.remindBeforeMin[0], t))
              : null,
            item.nextAt != null && item.status === 'open' && item.recurrence !== null
              ? h('span', { className: 'dsh-ut-chip', title: fill(t('row.next'), { when: item.nextAt }) }, fill(t('row.next'), { when: whenText(item.nextAt, false) }))
              : null,
            item.lastWriter === 'agent'
              ? h('span', { className: 'dsh-ut-chip', 'data-tone': 'info', title: t('row.byAgent') }, 'agent')
              : null)),
        h('div', { className: 'dsh-ut-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-ut-icon-button',
            title: t('row.edit'),
            'aria-label': t('row.edit'),
            onClick: () => onEdit(item.id),
          }, h(Glyph, { name: 'edit' })),
          h('button', {
            type: 'button',
            className: 'dsh-ut-icon-button',
            'data-danger': 'true',
            title: t('row.delete'),
            'aria-label': t('row.delete'),
            disabled: busy,
            onClick: () => onDelete(item),
          }, h(Glyph, { name: 'trash' }))))
    }

    /**
     * One occurrence chip on the month grid.
     *
     * @param props - the occurrence and the handlers.
     * @returns the element.
     */
    function CalendarChip(props) {
      const { occurrence, t, onToggle, onEdit } = props
      const overdue = occurrence.status === 'open' && Date.parse(occurrence.startAt) < Date.now() && !occurrence.allDay
      return h('button', {
        type: 'button',
        className: 'dsh-ut-cal-chip',
        'data-done': String(occurrence.status === 'done'),
        'data-tone': overdue ? 'danger' : undefined,
        title: occurrence.allDay ? occurrence.title : `${timeText(new Date(occurrence.startAt))} ${occurrence.title}`,
        onClick: (event) => {
          event.stopPropagation()
          onEdit(occurrence.itemId)
        },
        onDoubleClick: (event) => {
          event.stopPropagation()
          onToggle(occurrence)
        },
      }, occurrence.allDay ? occurrence.title : `${timeText(new Date(occurrence.startAt))} ${occurrence.title}`)
    }

    /**
     * The month grid plus the selected day's list.
     *
     * The grid is built from 42 date keys so its height never changes when the
     * month does; a month that needs five rows and one that needs six would
     * otherwise jump the day list below them.
     *
     * @param props - the occurrences by date, the cursor, and the handlers.
     * @returns the element.
     */
    function CalendarView(props) {
      const { t, year, month, occurrences, selected, today, onSelect, onShiftMonth, onToday, onToggle, onEdit, onAddHere } = props
      const byDate = new Map()
      for (const occurrence of occurrences) {
        const key = occurrence.date
        if (!byDate.has(key)) byDate.set(key, [])
        byDate.get(key).push(occurrence)
      }
      for (const list of byDate.values()) list.sort((left, right) => left.startAt.localeCompare(right.startAt))
      const grid = monthGrid(year, month, 1)
      const weekdayLabels = WEEKDAYS.map(day => weekdayText(day, uiLanguage()))
      const dayList = byDate.get(selected) ?? []

      /**
       * One occurrence in the day list: a tick that completes only this
       * occurrence, the text, and the time.
       *
       * @param occurrence - the occurrence.
       * @returns the element.
       */
      const dayRow = occurrence => h('div', {
        key: occurrence.occurrenceId,
        className: 'dsh-ut-row',
        'data-done': String(occurrence.status === 'done'),
      },
      h('input', {
        type: 'checkbox',
        className: 'dsh-ut-check',
        checked: occurrence.status === 'done',
        'aria-label': t(occurrence.status === 'done' ? 'row.reopen' : 'row.complete'),
        onChange: () => onToggle(occurrence),
      }),
      h('div', { className: 'dsh-ut-main' },
        h('button', { type: 'button', className: 'dsh-ut-row-title', onClick: () => onEdit(occurrence.itemId) }, occurrence.title),
        h('div', { className: 'dsh-ut-row-meta' },
          h('span', { className: 'dsh-ut-chip' }, occurrence.allDay
            ? t('row.allDay')
            : timeText(new Date(occurrence.startAt))),
          occurrence.recurrence === null
            ? null
            : h('span', { className: 'dsh-ut-chip', 'data-tone': 'info' }, `↻ ${repeatText(occurrence.recurrence, t)}`))))

      return h('div', null,
        h('div', { className: 'dsh-ut-cal-head' },
          h('h2', { className: 'dsh-ut-cal-title' }, fill(t('calendar.title'), { year, month })),
          h('button', { type: 'button', className: 'dsh-ut-icon-button', title: t('calendar.prev'), 'aria-label': t('calendar.prev'), onClick: () => onShiftMonth(-1) }, h(Glyph, { name: 'chevronLeft' })),
          h('button', { type: 'button', className: 'dsh-ut-icon-button', title: t('calendar.next'), 'aria-label': t('calendar.next'), onClick: () => onShiftMonth(1) }, h(Glyph, { name: 'chevronRight' })),
          h('button', { type: 'button', className: 'dsh-ut-button', 'data-variant': 'outline', onClick: onToday }, t('calendar.today')),
          h('button', { type: 'button', className: 'dsh-ut-button', 'data-variant': 'ghost', onClick: () => onAddHere(selected) }, h(Glyph, { name: 'plus' }), t('calendar.addHere'))),
        h('div', { className: 'dsh-ut-cal-scroll' },
          h('div', { className: 'dsh-ut-cal', role: 'grid', 'aria-label': fill(t('calendar.title'), { year, month }) },
            ...weekdayLabels.map(label => h('div', { key: `w-${label}`, className: 'dsh-ut-cal-weekday', role: 'columnheader' }, label)),
            ...grid.map((key) => {
              const list = byDate.get(key) ?? []
              const visible = list.slice(0, 3)
              const outside = Number(key.slice(0, 4)) !== year || Number(key.slice(5, 7)) !== month
              return h('div', {
                key,
                className: 'dsh-ut-cal-cell',
                role: 'gridcell',
                tabIndex: 0,
                'data-outside': String(outside),
                'data-today': String(key === today),
                'data-selected': String(key === selected),
                'aria-label': key,
                'aria-selected': String(key === selected),
                onClick: () => onSelect(key),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(key)
                  }
                },
              },
              h('span', { className: 'dsh-ut-cal-day' }, String(Number(key.slice(8, 10)))),
              ...visible.map(occurrence => h(CalendarChip, {
                key: occurrence.occurrenceId,
                occurrence,
                t,
                onToggle,
                onEdit,
              })),
              list.length > visible.length
                ? h('span', { className: 'dsh-ut-cal-more' }, fill(t('calendar.more'), { count: list.length - visible.length }))
                : null)
            }))),
        h('div', { className: 'dsh-ut-day' },
          h('div', { className: 'dsh-ut-day-head' }, fill(t('calendar.dayTitle'), { date: selected })),
          dayList.length === 0
            ? h('div', { className: 'dsh-ut-empty' }, h(Glyph, { name: 'calendar' }), h('div', { className: 'dsh-ut-empty-title' }, t('empty.day')))
            : h('div', { className: 'dsh-ut-card' }, ...dayList.map(dayRow))),
        h('div', { className: 'dsh-ut-day-hint' }, t('calendar.hint')))
    }

    /**
     * The reminder settings sheet.
     *
     * @param props - the prefs, the copy, and the save handler.
     * @returns the element.
     */
    function SettingsSheet(props) {
      const { t, prefs, busy, onSave, onClose } = props
      const [push, setPush] = React.useState(prefs.pushReminders !== false)
      const quiet = prefs.quietHours ?? null
      const [quietOn, setQuietOn] = React.useState(quiet !== null)
      const [quietStart, setQuietStart] = React.useState(quiet?.start ?? '22:00')
      const [quietEnd, setQuietEnd] = React.useState(quiet?.end ?? '08:00')
      const [digest, setDigest] = React.useState(prefs.digestAt ?? '')
      const [allDayTime, setAllDayTime] = React.useState(prefs.allDayReminderTime ?? '09:00')
      const save = () => onSave({
        pushReminders: push,
        quietHours: quietOn ? { start: quietStart, end: quietEnd } : null,
        digestAt: digest === '' ? null : digest,
        allDayReminderTime: allDayTime,
      })
      return h('div', { className: 'dsh-ut-sheet', role: 'group', 'aria-label': t('settings.title') },
        h('div', { className: 'dsh-ut-sheet-head' },
          h('span', { className: 'dsh-ut-sheet-title' }, t('settings.title')),
          h('button', { type: 'button', className: 'dsh-ut-icon-button', title: t('settings.close'), 'aria-label': t('settings.close'), onClick: onClose }, h(Glyph, { name: 'close' }))),
        h('div', { className: 'dsh-ut-sheet-row' },
          h('label', { className: 'dsh-ut-switch' },
            h('input', { type: 'checkbox', checked: push, onChange: event => setPush(event.target.checked) }),
            h('span', { className: 'dsh-ut-sheet-label' }, t('settings.push')))),
        h('div', { className: 'dsh-ut-sheet-hint' }, t('settings.pushHint')),
        h('div', { className: 'dsh-ut-sheet-row' },
          h('label', { className: 'dsh-ut-switch' },
            h('input', { type: 'checkbox', checked: quietOn, onChange: event => setQuietOn(event.target.checked) }),
            h('span', { className: 'dsh-ut-sheet-label' }, t('settings.quiet'))),
          quietOn ? h('input', { type: 'time', value: quietStart, onChange: event => setQuietStart(event.target.value) }) : null,
          quietOn ? h('span', null, t('settings.quietTo')) : null,
          quietOn ? h('input', { type: 'time', value: quietEnd, onChange: event => setQuietEnd(event.target.value) }) : null),
        h('div', { className: 'dsh-ut-sheet-row' },
          h('span', { className: 'dsh-ut-sheet-label' }, t('settings.digest')),
          h('input', { type: 'time', value: digest, onChange: event => setDigest(event.target.value) }),
          h('button', { type: 'button', className: 'dsh-ut-button', 'data-variant': 'ghost', onClick: () => setDigest('') }, t('settings.digestOff'))),
        h('div', { className: 'dsh-ut-sheet-row' },
          h('span', { className: 'dsh-ut-sheet-label' }, t('settings.allDayTime')),
          h('input', { type: 'time', value: allDayTime, onChange: event => setAllDayTime(event.target.value) })),
        h('div', { className: 'dsh-ut-sheet-row' },
          h('button', { type: 'button', className: 'dsh-ut-button', 'data-variant': 'primary', disabled: busy, onClick: save }, t('settings.save'))))
    }

    /**
     * The Calendar & Todos page: the list and the calendar over one document.
     *
     * @param props - the slot's locale seat.
     * @returns the element.
     */
    function TodosPage(props) {
      const t = props.t
      const [items, setItems] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [view, setView] = React.useState(() => {
        try {
          const stored = globalThis.localStorage?.getItem(VIEW_KEY)
          return stored === 'calendar' ? 'calendar' : 'list'
        } catch {
          return 'list'
        }
      })
      const [filter, setFilter] = React.useState('all')
      const [draft, setDraft] = React.useState('')
      const [draftDue, setDraftDue] = React.useState('')
      const [draftAllDay, setDraftAllDay] = React.useState(false)
      const [datePicking, setDatePicking] = React.useState(false)
      const [busyIds, setBusyIds] = React.useState(() => new Set())
      const [editingId, setEditingId] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [prefs, setPrefs] = React.useState(null)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const todayDate = todayKey()
      const [cursor, setCursor] = React.useState(() => {
        const now = new Date()
        return { year: now.getFullYear(), month: now.getMonth() + 1 }
      })
      const [selected, setSelected] = React.useState(todayDate)
      const [occurrences, setOccurrences] = React.useState([])
      const [agendaError, setAgendaError] = React.useState(null)
      const noticeTimer = React.useRef(null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        // A remount after a cleanup (React's strict double-invoke in development)
        // must be alive again; only the final unmount leaves it false.
        alive.current = true
        return () => {
          alive.current = false
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        }
      }, [])

      React.useEffect(() => {
        try {
          globalThis.localStorage?.setItem(VIEW_KEY, view)
        } catch {
          // A storage-restricted browser keeps the view for this mount only.
        }
      }, [view])

      /**
       * Show one transient notice.
       *
       * @param text - the copy.
       * @param tone - the tone.
       * @param action - an optional button.
       */
      const say = (text, tone = null, action = null) => {
        setNotice({ text, tone, action })
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => { if (alive.current) setNotice(null) }, action === null ? 3500 : 8000)
      }

      const load = React.useCallback(async () => {
        try {
          const next = await readList()
          if (alive.current) {
            setItems(next)
            setLoadError(null)
          }
        } catch (error) {
          if (alive.current) setLoadError(error.code ?? 'internal')
        }
      }, [])

      const loadPrefs = React.useCallback(async () => {
        try {
          const next = await readPrefs()
          if (alive.current) setPrefs(next)
        } catch {
          // The list stays usable without the reminder settings.
        }
      }, [])

      const loadAgenda = React.useCallback(async (year, month) => {
        const grid = monthGrid(year, month, 1)
        try {
          const value = await readAgenda(grid[0], addDays(grid[grid.length - 1], 1))
          if (alive.current) {
            setOccurrences(Array.isArray(value?.occurrences) ? value.occurrences : [])
            setAgendaError(null)
          }
        } catch (error) {
          if (alive.current) setAgendaError(error.code ?? 'internal')
        }
      }, [])

      React.useEffect(() => { void load() }, [load])
      React.useEffect(() => { void loadPrefs() }, [loadPrefs])
      React.useEffect(() => {
        if (view === 'calendar') void loadAgenda(cursor.year, cursor.month)
      }, [view, cursor.year, cursor.month, loadAgenda])
      React.useEffect(() => {
        const onFocus = () => {
          void load()
          if (view === 'calendar') void loadAgenda(cursor.year, cursor.month)
        }
        globalThis.window.addEventListener('focus', onFocus)
        return () => globalThis.window.removeEventListener('focus', onFocus)
      }, [load, loadAgenda, view, cursor.year, cursor.month])

      /**
       * Run one mutation with a busy marker, the state it produced, and a
       * failure notice when it is refused.
       *
       * @param ids - the ids the operation touches.
       * @param work - the mutation.
       * @returns the answer, or undefined when it failed.
       */
      const run = async (ids, work) => {
        setBusyIds(previous => new Set([...previous, ...ids]))
        try {
          const value = await work()
          if (!alive.current) return value
          if (Array.isArray(value?.state?.items)) setItems(value.state.items.map(normalizeItem))
          if (view === 'calendar') void loadAgenda(cursor.year, cursor.month)
          return value
        } catch (error) {
          if (alive.current) say(fill(t('notice.failed'), { code: failureText(error.code, t) }), 'error')
          return undefined
        } finally {
          if (alive.current) {
            setBusyIds((previous) => {
              const next = new Set(previous)
              for (const id of ids) next.delete(id)
              return next
            })
          }
        }
      }

      const add = async () => {
        const title = draft.trim()
        if (title === '') return
        const entry = { title }
        const dueAt = draftDue === '' ? null : (draftAllDay ? draftDue : fromLocalInput(draftDue))
        if (dueAt !== null) entry.dueAt = dueAt
        const value = await run([], () => mutate('create', { items: [entry] }))
        if (value === undefined) return
        setDraft('')
        setDraftDue('')
        setDraftAllDay(false)
        setDatePicking(false)
        const added = value.outcome.added.length
        const skipped = value.outcome.skipped.filter(entry => entry.reason === 'list_full').length
        say(fill(t('notice.created'), { count: added }))
        if (skipped > 0) say(t('notice.skippedFull'), 'warn')
      }

      /**
       * Toggle one item or one occurrence.
       *
       * A repeating item's checkbox completes the next occurrence, so the series
       * survives; an occurrence chip completes exactly that day.
       *
       * @param item - the list row.
       */
      const toggle = async (item) => {
        if (item.status === 'open' && item.recurrence !== null && item.nextAt !== null) {
          await run([item.id], () => mutate('completeOccurrence', { id: item.id, occurrenceId: `${item.id}@${item.nextAt}` }))
          return
        }
        const status = item.status === 'done' ? 'open' : 'done'
        const value = await run([item.id], () => mutate('update', {
          changes: [{ id: item.id, patch: { status } }],
        }))
        if (value === undefined) return
        const result = value.outcome.results[0]
        if (result?.code === 'not_found') say(failureText(result.code, t), 'warn')
      }

      /**
       * Toggle one calendar occurrence.
       *
       * @param occurrence - the chip's occurrence.
       */
      const toggleOccurrence = async (occurrence) => {
        if (occurrence.status === 'done') {
          // Reopening one occurrence of a series is not expressible without a
          // list of skipped dates; reopening the item itself is.
          const value = await run([occurrence.itemId], () => mutate('update', {
            changes: [{ id: occurrence.itemId, patch: { status: 'open' } }],
          }))
          if (value === undefined) return
          return
        }
        await run([occurrence.itemId], () => mutate('completeOccurrence', { id: occurrence.itemId, occurrenceId: occurrence.occurrenceId }))
      }

      const save = async (item, patch) => {
        const value = await run([item.id], () => mutate('update', {
          changes: [{ id: item.id, patch }],
        }))
        if (value === undefined) return
        setEditingId(null)
        say(t('notice.saved'))
      }

      const remove = async (item) => {
        const value = await run([item.id], () => mutate('remove', { ids: [item.id] }))
        if (value === undefined) return
        say(t('notice.deleted'), null, {
          label: t('notice.undo'),
          onPress: () => {
            void run([], () => mutate('create', {
              items: [{
                title: item.title,
                ...(item.dueAt === null ? {} : { dueAt: item.dueAt }),
                ...(item.dueDate === null ? {} : { dueDate: item.dueDate }),
                ...(item.note === null ? {} : { note: item.note }),
                ...(item.recurrence === null ? {} : { recurrence: item.recurrence }),
                ...(item.remindBeforeMin.length === 0 ? {} : { remindBeforeMin: item.remindBeforeMin }),
                status: item.status,
              }],
            }))
          },
        })
      }

      /**
       * Drop every finished item in one write.
       *
       * Deleting one row already has an undo; clearing a batch cannot be undone
       * honestly, so the button asks first and the confirmation says how many
       * items it is about to lose.
       */
      const clearDone = async (count) => {
        if (!globalThis.confirm?.(fill(t('filter.clearDoneConfirm'), { count }))) return
        const value = await run([], () => mutate('remove', { completed: true }))
        if (value === undefined) return
        say(fill(t('notice.cleared'), { count: value.outcome.removed.length }))
      }

      const savePrefs = async (patch) => {
        try {
          const value = await mutate('setPrefs', { prefs: patch })
          if (!alive.current) return
          setPrefs(value.prefs)
          say(t('notice.settingsSaved'))
        } catch (error) {
          if (alive.current) say(fill(t('notice.failed'), { code: failureText(error.code, t) }), 'error')
        }
      }

      if (items === null && loadError === null) {
        return h('div', { className: 'dsh-ut-page' },
          h('div', { className: 'dsh-ut-empty' },
            h('div', { className: 'dsh-ut-empty-title' }, t('state.loading'))))
      }
      if (items === null) {
        return h('div', { className: 'dsh-ut-page' },
          h('div', { className: 'dsh-ut-empty' },
            h(Glyph, { name: 'list' }),
            h('div', { className: 'dsh-ut-empty-title' }, fill(t('state.loadFailed'), { code: failureText(loadError, t) })),
            h('div', { className: 'dsh-ut-empty-action' },
              h('button', {
                type: 'button',
                className: 'dsh-ut-button',
                'data-variant': 'outline',
                onClick: () => { setLoadError(null); void load() },
              }, h(Glyph, { name: 'refresh' }), t('state.retry')))))
      }

      const openCount = items.filter(item => item.status === 'open').length
      const doneCount = items.length - openCount
      const visible = items.filter(item => filter === 'all' || item.status === filter)
      const today = startOfToday(Date.now())
      const buckets = new Map(GROUPS.map(group => [group, []]))
      for (const item of visible) buckets.get(bucketOf(item, today)).push(item)
      for (const list of buckets.values()) list.sort(compare)
      const showDoneBucket = filter !== 'open'
      const editingItem = editingId === null ? null : (items.find(item => item.id === editingId) ?? null)
      const counts = {
        all: items.length,
        open: openCount,
        done: doneCount,
      }

      return h('div', { className: 'dsh-ut-page' },
        h('header', { className: 'dsh-ut-header' },
          h('div', { className: 'dsh-ut-heading' },
            h('h1', { className: 'dsh-ut-title' }, t('header.title')),
            h('p', { className: 'dsh-ut-subtitle' }, t('header.subtitle'))),
          h('div', { className: 'dsh-ut-header-tools' },
            h('div', { className: 'dsh-ut-segment', role: 'group', 'aria-label': t('view.label') },
              h('button', { type: 'button', className: 'dsh-ut-button', 'aria-pressed': String(view === 'list'), onClick: () => setView('list') }, t('view.list')),
              h('button', { type: 'button', className: 'dsh-ut-button', 'aria-pressed': String(view === 'calendar'), onClick: () => setView('calendar') }, t('view.calendar'))),
            h('button', {
              type: 'button',
              className: 'dsh-ut-icon-button',
              title: t('settings.title'),
              'aria-label': t('settings.title'),
              'aria-pressed': String(settingsOpen),
              onClick: () => setSettingsOpen(open => !open),
            }, h(Glyph, { name: 'settings' })),
            h('button', {
              type: 'button',
              className: 'dsh-ut-icon-button',
              title: t('header.refresh'),
              'aria-label': t('header.refresh'),
              onClick: () => { void load(); if (view === 'calendar') void loadAgenda(cursor.year, cursor.month) },
            }, h(Glyph, { name: 'refresh' })))),
        settingsOpen && prefs !== null
          ? h(SettingsSheet, { t, prefs, busy: false, onSave: (patch) => { void savePrefs(patch) }, onClose: () => setSettingsOpen(false) })
          : null,
        h('div', { className: 'dsh-ut-compose' },
          h('input', {
            className: 'dsh-ut-compose-title',
            placeholder: t('compose.placeholder'),
            'aria-label': t('compose.placeholder'),
            value: draft,
            maxLength: 200,
            onChange: event => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); void add() }
            },
          }),
          h('div', { className: 'dsh-ut-compose-meta' },
            // The empty native picker renders its own `年/月/日 ----` glyphs, which
            // read as broken controls; the field appears once the reader asks for
            // a deadline.
            datePicking
              ? h('input', {
                className: 'dsh-ut-date',
                type: draftAllDay ? 'date' : 'datetime-local',
                autoFocus: true,
                'aria-label': t('compose.due'),
                title: t('compose.due'),
                value: draftDue,
                onBlur: () => { if (draftDue === '') setDatePicking(false) },
                onChange: event => setDraftDue(event.target.value),
              })
              : h('button', {
                type: 'button',
                className: 'dsh-ut-placeholder',
                title: t('compose.due'),
                onClick: () => setDatePicking(true),
              }, draftDue === '' ? t('compose.due') : (draftAllDay ? draftDue : dateTimeShort(new Date(draftDue)))),
            datePicking
              ? h('button', {
                type: 'button',
                className: 'dsh-ut-pill',
                'aria-pressed': String(draftAllDay),
                onClick: () => {
                  const next = !draftAllDay
                  setDraftAllDay(next)
                  if (draftDue !== '') setDraftDue(next ? draftDue.slice(0, 10) : `${draftDue.slice(0, 10)}T09:00`)
                },
              }, t('compose.allDay'))
              : null),
          h('button', {
            type: 'button',
            className: 'dsh-ut-button',
            'data-variant': 'primary',
            disabled: draft.trim() === '',
            onClick: () => { void add() },
          }, h(Glyph, { name: 'plus' }), t('compose.add'))),
        view === 'list'
          ? h('div', { className: 'dsh-ut-toolbar' },
            h('div', { className: 'dsh-ut-filters', role: 'group', 'aria-label': t('filter.all') },
              ...[['all', 'filter.all'], ['open', 'filter.open'], ['done', 'filter.done']].map(([value, key]) => h('button', {
                key: value,
                type: 'button',
                className: 'dsh-ut-pill',
                'aria-pressed': String(filter === value),
                onClick: () => setFilter(value),
              }, t(key), h('span', { className: 'dsh-ut-pill-count' }, String(counts[value])))),
              // Shown only when there is something to clear, so the toolbar does
              // not carry a control that would do nothing.
              doneCount === 0 ? null : h('button', {
                type: 'button',
                className: 'dsh-ut-pill',
                onClick: () => { void clearDone(doneCount) },
              }, t('filter.clearDone'))))
          : null,
        h('div', { className: 'dsh-ut-notice-region', role: 'status', 'aria-live': 'polite' },
          notice === null ? null : h('div', { className: 'dsh-ut-notice', 'data-tone': notice.tone ?? undefined },
            notice.tone === 'error' ? h('span', { 'aria-hidden': true }, h(Glyph, { name: 'close' })) : null,
            h('span', null, notice.text),
            notice.action === null ? null : h('button', {
              type: 'button',
              className: 'dsh-ut-button',
              'data-variant': 'ghost',
              onClick: () => { notice.action.onPress(); setNotice(null) },
            }, notice.action.label))),
        editingItem === null ? null : h('div', { className: 'dsh-ut-body' },
          h(Editor, {
            item: editingItem,
            t,
            busy: busyIds.has(editingItem.id),
            onSave: patch => { void save(editingItem, patch) },
            onCancel: () => setEditingId(null),
          })),
        view === 'calendar'
          ? h('div', null,
            agendaError === null ? null : h('div', { className: 'dsh-ut-day-hint' }, fill(t('state.loadFailed'), { code: failureText(agendaError, t) })),
            h(CalendarView, {
              t,
              year: cursor.year,
              month: cursor.month,
              occurrences,
              selected,
              today: todayDate,
              onSelect: setSelected,
              onShiftMonth: (delta) => {
                setCursor((current) => {
                  const month = current.month + delta
                  if (month < 1) return { year: current.year - 1, month: 12 }
                  if (month > 12) return { year: current.year + 1, month: 1 }
                  return { year: current.year, month }
                })
              },
              onToday: () => {
                const now = new Date()
                setCursor({ year: now.getFullYear(), month: now.getMonth() + 1 })
                setSelected(todayDate)
              },
              onToggle: (occurrence) => { void toggleOccurrence(occurrence) },
              onEdit: id => setEditingId(id),
              onAddHere: (key) => {
                setDraftDue(key)
                setDraftAllDay(true)
                setDatePicking(true)
                setView('list')
              },
            }))
          : h('div', { className: 'dsh-ut-body' },
            visible.length === 0
              ? h('div', { className: 'dsh-ut-empty' },
                h(Glyph, { name: 'list' }),
                h('div', { className: 'dsh-ut-empty-title' }, items.length === 0 ? t('empty.none') : t('empty.filtered')),
                items.length === 0 || filter === 'all' ? null : h('button', {
                  type: 'button',
                  className: 'dsh-ut-button dsh-ut-empty-action',
                  'data-variant': 'outline',
                  onClick: () => setFilter('all'),
                }, t('empty.reset')))
              : h('div', { className: 'dsh-ut-card' }, GROUPS.filter(group => group !== 'done' || showDoneBucket).map((group) => {
                const list = buckets.get(group)
                if (list.length === 0) return null
                return h('section', { key: group, className: 'dsh-ut-group', 'aria-label': t(`group.${group}`) },
                  h('div', { className: 'dsh-ut-group-head' },
                    h('span', null, t(`group.${group}`)),
                    h('span', { className: 'dsh-ut-group-count' }, String(list.length))),
                  ...list.map(item => h(Row, {
                    key: item.id,
                    item,
                    t,
                    busy: busyIds.has(item.id),
                    onToggle: (target) => { void toggle(target) },
                    onEdit: id => setEditingId(current => (current === id ? null : id)),
                    onDelete: (target) => { void remove(target) },
                  })))
              }))))
    }

    /** Client services this bundle reads. */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries, the stylesheet, the sidebar entry, and the page
     * it opens.
     *
     * @param ctx - the Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-user-todo: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      }, 'dsh-user-todo: stylesheet')
      // The sidebar selects the page by the entry's id, so the two
      // registrations must agree. `label` names a FLAT key: the locale service
      // indexes dictionaries by exact key.
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        locale: NS,
        label: () => ctx.locale.bind(NS)('panel.title'),
      }, PanelIcon)), 'dsh-user-todo: sidebar entry')
      ctx.effect(() => ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, TodosPage)
      }), 'dsh-user-todo: todos page')
    }

    return { inject, apply }
  },
})

/**
 * Browser half of the WeChat bundle: the configuration this bundle's page shows in
 * the Plugins panel — where the import pipeline stands, and importing a batch
 * that is already in the archive.
 *
 * This file is served verbatim as a classic script and is never bundled, so it
 * declares no imports, carries its own dictionaries, and self-registers under
 * the package name. It reaches its Host half over the Harness's own
 * authenticated API channel; no message body, conversation list, or key value
 * crosses that boundary — the page sees states, counts, and paths.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Button, Tag } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace this section registers its dictionaries under. */
    const NS = 'settings.wechat'

    /**
     * Host route, document-relative so a Harness mounted under a sub-path still
     * reaches the route the Host registered at the server root.
     */
    const ROUTE = 'api/plugin-wechat'

    /** How often a running import is re-read. */
    const POLL_MS = 1500

    const en = {
      loading: 'Loading WeChat pipeline status…',
      loadFailed: 'Failed to load pipeline status ({code}).',
      networkFailed: 'Cannot reach the Harness.',
      overviewHeading: 'Pipeline',
      statusLabel: 'Status',
      databaseLabel: 'WeChat database',
      databaseChangeLabel: 'Database last modified',
      keysLabel: 'Exporter keys',
      keysCoverage: '{covered} of {total} shards',
      exportLabel: 'Latest export',
      importLabel: 'Last import',
      corpusLabel: 'Corpus',
      corpusValue: '{messages} messages across {chats} chats',
      never: 'never',
      unknown: 'unknown',
      exportRoot: 'export root directory',
      shards: '{count} shards',
      keysOk: 'ready',
      keysMissing: 'missing',
      keysInvalid: 'invalid JSON',
      keysUnreadable: 'unreadable',
      keysUnconfigured: 'not configured',
      dbOk: 'found',
      dbNotFound: 'not found',
      dbAmbiguous: 'multiple accounts — set wechatDbDir',
      dbUnreadable: 'unreadable',
      exportOk: 'ready',
      exportNotFound: 'none',
      exportUnreadable: 'unreadable',
      exportUnconfigured: 'exporter directory not configured',
      exportTextOnly: 'text-only ×{count}',
      statusOk: 'Up to date',
      statusActionRequired: 'Action required',
      statusImportPending: 'Batch ready to import',
      statusUpdatesAvailable: 'New messages available to export',
      statusNotice: 'Partial coverage',
      statusUnreadable: 'Some data unreadable',
      statusEmpty: 'Nothing imported yet',
      signalKeysMissing: 'Exporter key file missing. Run extract_keys.py first.',
      signalKeysInvalid: 'Exporter key file is not valid JSON. Run extract_keys.py again.',
      signalKeysUnreadable: 'Could not read the exporter key file.',
      signalImportFailed: 'Last import failed: {error}',
      signalUnimportedBatch: 'Complete batch ready to import: {batches}',
      signalInvalidArchiveBatches: '{count} batch directory(s) in the archive are invalid.',
      signalUnimportedExport: 'Newer export not yet imported: {batch}',
      signalDatabaseNewer: 'WeChat database has new messages since the last export.',
      signalKeysIncomplete: 'Key file covers only {covered} of {total} shards; remaining shards cannot be exported.',
      signalExportShardsIncomplete: 'Latest export covered only {covered} of {total} expected shards.',
      signalInvalidExportBatches: '{count} directory(s) in the export folder are invalid.',
      signalTextOnlyExport:
        '{count} export(s) lack --format jsonl and cannot be imported.',
      batchesHeading: 'Batches',
      batchesEmpty: 'No batches in archive. Export one first, then import it here or via the assistant.',
      columnBatch: 'Batch',
      columnState: 'State',
      columnExport: 'Exported',
      columnChats: 'Chats',
      columnMessages: 'Messages',
      columnImported: 'Imported',
      statePending: 'pending',
      stateImported: 'imported',
      statePartial: 'private only',
      stateInvalid: 'invalid',
      stateIncomplete: 'incomplete',
      stateUnreadable: 'unreadable',
      importPrivate: 'Import',
      importGroups: 'Include groups',
      importing: 'Importing…',
      progressReading: 'Reading batch…',
      progressValidating: 'Validating messages…',
      progressWriting: 'Writing to database…',
      progressDone: 'Finishing…',
      resultHeading: 'Last Import',
      resultImported: 'Imported {messages} messages into {corpus}',
      resultCounts: '{generated} new, {updated} updated, {unchanged} unchanged',
      resultSkipped: '{count} group messages skipped',
      resultSuspected: '{count} messages imported under new IDs; existing copies kept.',
      resultFailed: 'Import failed: {reason}',
      resultOutside:
        'Imported in place; move into the archive before re-exporting to this folder.',
      batchesUnavailable: 'Waiting for export_meta.json (written when export finishes).',
      configHeading: 'Configuration',
      configArchive: 'Archive directory',
      configDatabase: 'Database',
      configExporter: 'Exporter directory',
      configExportDir: 'Export output',
      configKeys: 'Key file',
      configScope: 'Default scope',
      scopePrivate: 'private chats only',
      scopeGroups: 'private and group chats',
      configHint: 'Configured in cordis.patch.yml.',
      refresh: 'Refresh',
      scheduleHeading: 'Scheduled import',
      scheduleActive: 'Active — next run {when}',
      scheduleInactive: 'Paused.',
      scheduleMissing: 'No scheduled import task configured.',
      scheduleUnavailable: 'Scheduling service is not available.',
      scheduleSetUp: 'Set up',
      scheduleRecreate: 'Recreate',
      scheduleRestored: 'Scheduled import task recreated.',
    }

    const zh = {
      loading: '正在加载同步状态…',
      loadFailed: '加载状态失败（{code}）。',
      networkFailed: '无法连接 Harness。',
      overviewHeading: '流水线概览',
      statusLabel: '当前状态',
      databaseLabel: '微信数据库',
      databaseChangeLabel: '数据库更新时间',
      keysLabel: '导出器密钥',
      keysCoverage: '已覆盖 {covered}/{total} 个分片',
      exportLabel: '最近导出',
      importLabel: '最近导入',
      corpusLabel: '本地语料库',
      corpusValue: '{messages} 条消息 · {chats} 个会话',
      never: '从未',
      unknown: '未知',
      exportRoot: '导出根目录',
      shards: '{count} 个分片',
      keysOk: '已就绪',
      keysMissing: '缺失',
      keysInvalid: '格式无效',
      keysUnreadable: '无法读取',
      keysUnconfigured: '未配置',
      dbOk: '已找到',
      dbNotFound: '未找到',
      dbAmbiguous: '存在多个账号，请指定 wechatDbDir',
      dbUnreadable: '无法读取',
      exportOk: '已就绪',
      exportNotFound: '暂无',
      exportUnreadable: '无法读取',
      exportUnconfigured: '未配置导出器目录',
      exportTextOnly: '纯文本 ×{count}',
      statusOk: '已是最新',
      statusActionRequired: '需要处理',
      statusImportPending: '有待导入批次',
      statusUpdatesAvailable: '有新消息待导出',
      statusNotice: '部分覆盖',
      statusUnreadable: '部分内容无法读取',
      statusEmpty: '尚未导入数据',
      signalKeysMissing: '尚未生成密钥文件，请先运行一次 extract_keys.py。',
      signalKeysInvalid: '密钥文件不是有效的 JSON，请重新运行 extract_keys.py。',
      signalKeysUnreadable: '无法读取密钥文件。',
      signalImportFailed: '上次导入失败：{error}',
      signalUnimportedBatch: '检测到完整批次待导入：{batches}',
      signalInvalidArchiveBatches: '归档中有 {count} 个批次目录不可用。',
      signalUnimportedExport: '检测到新的未导入导出批次：{batch}',
      signalDatabaseNewer: '微信数据库有新变动，重新导出可获取最新消息。',
      signalKeysIncomplete: '密钥仅覆盖 {covered}/{total} 个分片，其余分片将无法导出。',
      signalExportShardsIncomplete: '最近一次导出仅处理了 {covered}/{total} 个分片。',
      signalInvalidExportBatches: '导出目录中有 {count} 个无效目录。',
      signalTextOnlyExport: '有 {count} 次导出未启用 --format jsonl，无法导入。',
      batchesHeading: '批次列表',
      batchesEmpty: '归档中暂无批次。请先运行导出器，再在此导入或让助手处理。',
      columnBatch: '批次',
      columnState: '状态',
      columnExport: '导出时间',
      columnChats: '会话数',
      columnMessages: '消息数',
      columnImported: '导入时间',
      statePending: '待导入',
      stateImported: '已导入',
      statePartial: '仅私聊',
      stateInvalid: '无效',
      stateIncomplete: '未写完',
      stateUnreadable: '无法读取',
      importPrivate: '导入',
      importGroups: '含群聊',
      importing: '导入中…',
      progressReading: '正在读取批次…',
      progressValidating: '正在校验消息…',
      progressWriting: '正在写入数据库…',
      progressDone: '正在完成…',
      resultHeading: '最近一次导入',
      resultImported: '已导入 {messages} 条消息至 {corpus}',
      resultCounts: '新增 {generated}，更新 {updated}，未变化 {unchanged}',
      resultSkipped: '已跳过 {count} 条群聊消息',
      resultSuspected: '{count} 条消息以新 ID 写入，原记录保留。',
      resultFailed: '导入失败：{reason}',
      resultOutside:
        '该批次为就地导入；如需覆盖原目录重新导出，请先将其移入归档目录。',
      batchesUnavailable: '等待导出器写入 export_meta.json（导出结束时生成）。',
      configHeading: '配置信息',
      configArchive: '归档目录',
      configDatabase: '语料库路径',
      configExporter: '导出器目录',
      configExportDir: '导出输出目录',
      configKeys: '密钥文件',
      configScope: '默认范围',
      scopePrivate: '仅私聊',
      scopeGroups: '私聊与群聊',
      configHint: '配置项来自 cordis.patch.yml。',
      refresh: '刷新',
      scheduleHeading: '定时导入',
      scheduleActive: '已启用 · 下次运行：{when}',
      scheduleInactive: '任务已暂停。',
      scheduleMissing: '尚未创建定时导入任务。',
      scheduleUnavailable: '定时任务服务不可用。',
      scheduleSetUp: '创建任务',
      scheduleRecreate: '重建任务',
      scheduleRestored: '定时导入任务已重建。',
    }

    const CSS = `
@keyframes dsh-wc-spin { to { transform: rotate(360deg); } }
.dsh-wc-section { max-width: 860px; padding: 4px 2px 32px; color: var(--dsw-alias-label-primary); }
.dsh-wc-card {
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 14px;
}
.dsh-wc-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin-bottom: 12px;
}
.dsh-wc-card-title { font-size: 14px; font-weight: 600; margin: 0; }
.dsh-wc-rows {
  display: grid; grid-template-columns: minmax(120px, 190px) 1fr;
  gap: 8px 16px; font-size: 13px; margin: 0;
}
.dsh-wc-term { color: var(--dsw-alias-label-caption); }
.dsh-wc-value { margin: 0; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.dsh-wc-signals { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.dsh-wc-alert {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 8px;
  font-size: 12.5px; line-height: 1.5;
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.dsh-wc-alert[data-tone="warn"] {
  border-color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary, rgba(184,121,26,.1));
  color: var(--dsw-alias-state-warn-label);
}
.dsh-wc-progress-box {
  margin-top: 12px; padding: 10px 12px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-wc-progress-head {
  display: flex; align-items: center; gap: 8px; font-size: 12.5px;
  color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums;
}
.dsh-wc-spinner {
  width: 12px; height: 12px; border-radius: 999px;
  border: 1.8px solid currentColor; border-top-color: transparent;
  animation: dsh-wc-spin 0.7s linear infinite; flex: none;
}
.dsh-wc-track {
  height: 5px; margin-top: 8px; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.18));
}
.dsh-wc-fill {
  height: 100%; border-radius: 999px;
  background: var(--dsw-alias-brand-primary, #2f6feb);
  transition: width 280ms ease;
}
.dsh-wc-table-box { overflow-x: auto; scrollbar-width: thin; }
.dsh-wc-table { width: 100%; min-width: 560px; border-collapse: collapse; font-size: 13px; }
.dsh-wc-th {
  text-align: left; font-weight: 500; font-size: 12px;
  color: var(--dsw-alias-label-caption);
  padding: 7px 10px 7px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l4);
  white-space: nowrap;
}
.dsh-wc-td {
  padding: 9px 10px 9px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  vertical-align: middle;
}
.dsh-wc-tr:hover .dsh-wc-td { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.06)); }
.dsh-wc-tr:last-child .dsh-wc-td { border-bottom: none; }
.dsh-wc-nowrap { white-space: nowrap; }
.dsh-wc-batch { min-width: 170px; overflow-wrap: anywhere; }
.dsh-wc-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-wc-actions-head { width: 1%; }
.dsh-wc-actions { display: flex; gap: 8px; flex-wrap: nowrap; }
.dsh-wc-result {
  margin-top: 12px; padding: 12px 14px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 13px; line-height: 1.65;
}
.dsh-wc-result p { margin: 2px 0; }
.dsh-wc-muted { color: var(--dsw-alias-label-caption); font-size: 12px; margin: 8px 0 0; }
.dsh-wc-body { font-size: 13px; line-height: 1.7; margin: 0 0 8px; }
.dsh-wc-warn { color: var(--dsw-alias-label-error); font-size: 13px; }
.dsh-wc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
`

    /**
     * Layout for the section. Values are the shell's own semantic tokens, so the
     * page follows the active theme instead of carrying colors of its own.
     */
    const styles = {
      term: { color: 'var(--dsw-alias-label-caption)' },
      value: { margin: 0, minWidth: 0, overflowWrap: 'anywhere' },
    }

    /**
     * Call the Host half.
     * @param {string} action - Action name.
     * @param {object} body - Extra request fields.
     * @returns {Promise<object>} the action's value.
     */
    async function call(action, body = {}) {
      let response
      try {
        response = await fetch(new URL(ROUTE, document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...body }),
        })
      } catch (error) {
        throw Object.assign(new Error(String(error)), { code: 'network_error' })
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw Object.assign(new Error('invalid_response'), { code: `http_${response.status}` })
      }
      if (payload?.ok === true) return payload.value
      throw Object.assign(new Error(payload?.error?.message ?? ''), { code: payload?.error?.code ?? `http_${response.status}` })
    }

    /** One labelled row of the overview grid. */
    function Row(props) {
      return [h('dt', { key: 'k', style: styles.term }, props.label), h('dd', { key: 'v', style: styles.value }, props.value)]
    }

    /** The settings section. The shell passes the namespace's translator in. */
    function WechatSettings(props) {
      const t = props.t
      const [state, setState] = React.useState({ loading: true, error: null, data: null, busy: null, notice: null })

      const refresh = React.useCallback(async () => {
        try {
          const data = await call('status')
          setState((previous) => ({ ...previous, loading: false, error: null, data }))
        } catch (error) {
          setState((previous) => ({ ...previous, loading: false, error: error.code ?? 'internal_error' }))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      const running = state.data?.import?.running === true
      React.useEffect(() => {
        if (!running) return undefined
        // Keep polling on a fixed interval: a failed poll changes neither the
        // running flag nor the data reference, and a timeout rescheduled from
        // those dependencies would stop after the first failure.
        const timer = setInterval(() => {
          void refresh()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [running, refresh])

      const startImport = async (batch, includeGroups) => {
        setState((previous) => ({ ...previous, busy: batch }))
        try {
          await call('import.start', { batch, includeGroups })
        } catch (error) {
          setState((previous) => ({ ...previous, error: error.code ?? 'internal_error' }))
        }
        await refresh()
        setState((previous) => ({ ...previous, busy: null }))
      }

      /**
       * Set up or rebuild the recurring import task.
       *
       * A task the person deleted from the automation list can be recreated
       * from here without asking the agent for the tool; one that already
       * exists is replaced, which is the same recovery the bilibili and
       * Outlook pages offer.
       *
       * @param {object|null} current - the schedule state the page last read.
       */
      const restoreSchedule = async (current) => {
        const exists = (current?.tasks ?? []).length > 0
        setState((previous) => ({ ...previous, busy: 'schedule', notice: null }))
        try {
          const value = await call(exists ? 'schedule.recreate' : 'schedule.ensure')
          setState((previous) => ({ ...previous, notice: value.status === 'recreated' || value.status === 'created' ? 'scheduleRestored' : null }))
        } catch (error) {
          setState((previous) => ({ ...previous, error: error.code ?? 'internal_error' }))
        }
        await refresh()
        setState((previous) => ({ ...previous, busy: null }))
      }

      if (state.loading) {
        return h('div', { className: 'dsh-wc-section' }, h('style', { 'data-plugin-css': 'dsh-wechat' }, CSS), h('p', { className: 'dsh-wc-muted' }, t('loading')))
      }
      if (state.data === null) {
        return h(
          'div',
          { className: 'dsh-wc-section' },
          h('style', { 'data-plugin-css': 'dsh-wechat' }, CSS),
          h('div', { className: 'dsh-wc-alert', 'data-tone': 'warn', role: 'alert' }, state.error === 'network_error' ? t('networkFailed') : t('loadFailed', { code: state.error ?? 'internal_error' })),
        )
      }

      const data = state.data
      const pipeline = data.pipeline
      const statusKey = `status${pipeline.status.charAt(0).toUpperCase()}${pipeline.status.slice(1).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())}`
      const statusTone = pipeline.status === 'ok' ? 'success' : pipeline.status === 'action_required' || pipeline.status === 'unreadable' ? 'warn' : undefined
      const result = data.import.lastResult
      const progress = data.import.progress
      const progressPct =
        running && progress && typeof progress.total === 'number' && progress.total > 0
          ? Math.min(100, Math.round(((progress.processed ?? 0) / progress.total) * 100))
          : null

      // The Plugins panel draws this page's title, version, and description from
      // the bundle's locale metadata, so this renders its cards only.
      return h(
        'div',
        { className: 'dsh-wc-section' },
        h('style', { 'data-plugin-css': 'dsh-wechat' }, CSS),
        h(
          'div',
          { className: 'dsh-wc-card' },
          h(
            'div',
            { className: 'dsh-wc-card-head' },
            h('h2', { className: 'dsh-wc-card-title' }, t('overviewHeading')),
            h(Tag, { tone: statusTone }, t(statusKey)),
          ),
          h(
            'dl',
            { className: 'dsh-wc-rows' },
            h(Row, { label: t('statusLabel'), value: t(statusKey) }),
            h(Row, { label: t('databaseLabel'), value: describeDatabase(t, pipeline.database) }),
            h(Row, { label: t('databaseChangeLabel'), value: pipeline.database.latest_change_at ?? t('never') }),
            h(Row, { label: t('keysLabel'), value: describeKeys(t, pipeline.keys) }),
            h(Row, { label: t('exportLabel'), value: describeExport(t, pipeline.export) }),
            h(Row, { label: t('importLabel'), value: describeImport(t, pipeline.import) }),
            h(Row, { label: t('corpusLabel'), value: t('corpusValue', { messages: pipeline.corpus.messages, chats: pipeline.corpus.chats }) }),
          ),
          pipeline.signals.length > 0
            ? h(
                'div',
                { className: 'dsh-wc-signals' },
                ...pipeline.signals.map((signal, index) =>
                  h(
                    'div',
                    {
                      key: index,
                      className: 'dsh-wc-alert',
                      'data-tone': signal.code === 'import_failed' || signal.code.startsWith('keys_') ? 'warn' : undefined,
                    },
                    signalText(t, signal),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-wc-card' },
          h(
            'div',
            { className: 'dsh-wc-card-head' },
            h('h2', { className: 'dsh-wc-card-title' }, t('batchesHeading')),
          ),
          data.batches.length === 0
            ? h('p', { className: 'dsh-wc-muted' }, t('batchesEmpty'))
            : h(
                'div',
                { className: 'dsh-wc-table-box' },
                h(
                  'table',
                  { className: 'dsh-wc-table' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', { className: 'dsh-wc-th dsh-wc-batch' }, t('columnBatch')),
                      h('th', { className: 'dsh-wc-th dsh-wc-nowrap' }, t('columnState')),
                      h('th', { className: 'dsh-wc-th dsh-wc-nowrap' }, t('columnExport')),
                      h('th', { className: 'dsh-wc-th dsh-wc-num' }, t('columnChats')),
                      h('th', { className: 'dsh-wc-th dsh-wc-num' }, t('columnMessages')),
                      h('th', { className: 'dsh-wc-th dsh-wc-nowrap' }, t('columnImported')),
                      h('th', { className: 'dsh-wc-th dsh-wc-actions-head' }, ''),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    ...data.batches.map((row) => {
                      const importable = row.state === 'pending' || row.state === 'partial'
                      const busy = state.busy === row.batch
                      return h(
                        'tr',
                        { key: row.batch, className: 'dsh-wc-tr' },
                        h(
                          'td',
                          { className: 'dsh-wc-td' },
                          h('div', null, row.batch),
                          row.invalid === null || row.invalid === undefined
                            ? null
                            : h('div', { className: 'dsh-wc-muted' }, row.invalid),
                        ),
                        h(
                          'td',
                          { className: 'dsh-wc-td dsh-wc-nowrap' },
                          h(Tag, { tone: row.state === 'imported' ? 'success' : undefined }, t(stateKey(row.state))),
                        ),
                        h('td', { className: 'dsh-wc-td dsh-wc-nowrap dsh-wc-num', style: { textAlign: 'left' } }, stamp(row.exportInstant ?? row.exportTime) ?? t('unknown')),
                        h('td', { className: 'dsh-wc-td dsh-wc-num' }, row.chatCount ?? '—'),
                        h('td', { className: 'dsh-wc-td dsh-wc-num' }, row.totalMessages ?? '—'),
                        h('td', { className: 'dsh-wc-td dsh-wc-nowrap dsh-wc-num', style: { textAlign: 'left' } }, stamp(row.importedAt) ?? t('never')),
                        h(
                          'td',
                          { className: 'dsh-wc-td dsh-wc-nowrap' },
                          importable
                            ? h(
                                'div',
                                { className: 'dsh-wc-actions' },
                                h(
                                  Button,
                                  { variant: 'primary', size: 'sm', disabled: running || busy, onClick: () => void startImport(row.batch, false) },
                                  busy ? t('importing') : t('importPrivate'),
                                ),
                                h(
                                  Button,
                                  { variant: 'ghost', size: 'sm', disabled: running || busy, onClick: () => void startImport(row.batch, true) },
                                  t('importGroups'),
                                ),
                              )
                            : null,
                        ),
                      )
                    }),
                  ),
                ),
              ),
          running
            ? h(
                'div',
                { className: 'dsh-wc-progress-box' },
                h(
                  'div',
                  { className: 'dsh-wc-progress-head' },
                  h('span', { className: 'dsh-wc-spinner', 'aria-hidden': true }),
                  h('span', null, progressText(t, progress)),
                ),
                progressPct === null
                  ? null
                  : h(
                      'div',
                      { className: 'dsh-wc-track', 'aria-hidden': true },
                      h('div', { className: 'dsh-wc-fill', style: { width: `${progressPct}%` } }),
                    ),
              )
            : null,
          result === null || result === undefined
            ? null
            : h('div', { className: 'dsh-wc-result' }, h('h2', { className: 'dsh-wc-card-title', style: { marginBottom: '6px' } }, t('resultHeading')), ...resultLines(t, result, pipeline.corpus)),
        ),
        h(
          'div',
          { className: 'dsh-wc-card' },
          h(
            'div',
            { className: 'dsh-wc-card-head' },
            h('h2', { className: 'dsh-wc-card-title' }, t('configHeading')),
          ),
          h(
            'dl',
            { className: 'dsh-wc-rows' },
            h(Row, { label: t('configArchive'), value: h('span', { className: 'dsh-wc-mono' }, data.config.batchesDir) }),
            h(Row, { label: t('configDatabase'), value: h('span', { className: 'dsh-wc-mono' }, data.config.databasePath) }),
            h(Row, { label: t('configExporter'), value: h('span', { className: 'dsh-wc-mono' }, data.config.exporterDir === '' ? t('unknown') : data.config.exporterDir) }),
            h(Row, { label: t('configExportDir'), value: h('span', { className: 'dsh-wc-mono' }, data.config.exportDir === '' ? t('unknown') : data.config.exportDir) }),
            h(Row, { label: t('configKeys'), value: h('span', { className: 'dsh-wc-mono' }, data.config.keysFile === '' ? t('unknown') : data.config.keysFile) }),
            h(Row, { label: t('configScope'), value: data.config.includeGroups ? t('scopeGroups') : t('scopePrivate') }),
          ),
          h('p', { className: 'dsh-wc-muted' }, t('configHint')),
        ),
        h(
          'div',
          { className: 'dsh-wc-card' },
          h(
            'div',
            { className: 'dsh-wc-card-head' },
            h('h2', { className: 'dsh-wc-card-title' }, t('scheduleHeading')),
          ),
          ...scheduleBody(t, data.schedule, () => void restoreSchedule(data.schedule), state.busy === 'schedule'),
          state.notice === null ? null : h('p', { className: 'dsh-wc-muted' }, t(state.notice)),
        ),
        h('div', { className: 'dsh-wc-actions' }, h(Button, { variant: 'ghost', size: 'sm', onClick: () => void refresh() }, t('refresh'))),
      )
    }

    /**
     * A batch or import instant as a local `YYYY-MM-DD HH:mm` reading.
     *
     * The exporter's own `export_time` is a naive local reading, and the stored
     * import instant is UTC; both are shown in the reader's zone, and a value
     * neither form parses is passed through unchanged.
     *
     * @param {string|number|null} value - Instant, or an unparsed reading.
     * @returns {string|null} the local reading, or null when there is none.
     */
    function stamp(value) {
      if (value === null || value === undefined || value === '') return null
      const instant = typeof value === 'number' ? value : Date.parse(value)
      if (!Number.isFinite(instant)) return String(value)
      const at = new Date(instant)
      const pad = (number) => String(number).padStart(2, '0')
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /**
     * The database row's value.
     * @param {Function} t - Translator.
     * @param {object} database - The database section.
     * @returns {string} the localized value.
     */
    function describeDatabase(t, database) {
      if (database.status === 'ok') return t('shards', { count: database.shard_count ?? 0 })
      if (database.status === 'not_found') return t('dbNotFound')
      if (database.status === 'ambiguous') return t('dbAmbiguous')
      return t('dbUnreadable')
    }

    /**
     * The keys row's value.
     * @param {Function} t - Translator.
     * @param {object} keys - The keys section.
     * @returns {string} the localized value.
     */
    function describeKeys(t, keys) {
      const key = { ok: 'keysOk', missing: 'keysMissing', invalid: 'keysInvalid', unreadable: 'keysUnreadable', unconfigured: 'keysUnconfigured' }[keys.status]
      if (key === undefined) return t('unknown')
      if (keys.status !== 'ok') return t(key)
      return `${t(key)} · ${t('keysCoverage', { covered: keys.message_shards_covered ?? 0, total: keys.message_shards_total ?? 0 })}`
    }

    /**
     * The export row's value.
     * @param {Function} t - Translator.
     * @param {object} exporter - The export section.
     * @returns {string} the localized value.
     */
    function describeExport(t, exporter) {
      if (exporter.status === 'ok') {
        return `${exporter.batch ?? '(root)'} · ${exporter.export_time ?? t('unknown')} · ${exporter.total_messages ?? 0}`
      }
      if (exporter.status === 'unconfigured') return t('exportUnconfigured')
      if (exporter.status === 'unreadable') return t('exportUnreadable')
      // Nothing importable, but the directory is not empty either.
      if ((exporter.text_only_batches ?? 0) > 0) return t('exportTextOnly', { count: exporter.text_only_batches })
      return t('exportNotFound')
    }

    /**
     * The import row's value.
     * @param {Function} t - Translator.
     * @param {object} section - The import section.
     * @returns {string} the localized value.
     */
    function describeImport(t, section) {
      if (section.status === 'none') return t('never')
      const base = `${section.batch ?? t('unknown')} · ${section.imported_at ?? t('unknown')}`
      if (section.status === 'failed') return `${base} · ${section.last_error_code ?? ''}`
      return `${base} · ${section.messages ?? 0}`
    }

    /**
     * One signal's localized sentence.
     * @param {Function} t - Translator.
     * @param {object} signal - A signal.
     * @returns {string} the sentence.
     */
    function signalText(t, signal) {
      switch (signal.code) {
        case 'keys_missing':
          return t('signalKeysMissing')
        case 'keys_invalid':
          return t('signalKeysInvalid')
        case 'keys_unreadable':
          return t('signalKeysUnreadable')
        case 'import_failed':
          return t('signalImportFailed', { error: signal.error ?? t('unknown') })
        case 'unimported_batch':
          return t('signalUnimportedBatch', { batches: (signal.batches ?? []).join(', ') })
        case 'invalid_archive_batches':
          return t('signalInvalidArchiveBatches', { count: signal.count ?? 0 })
        case 'unimported_export':
          return t('signalUnimportedExport', { batch: signal.batch ?? t('exportRoot') })
        case 'database_newer':
          return t('signalDatabaseNewer')
        case 'keys_incomplete':
          return t('signalKeysIncomplete', { covered: signal.covered ?? 0, total: signal.total ?? 0 })
        case 'export_shards_incomplete':
          return t('signalExportShardsIncomplete', { covered: signal.covered ?? 0, total: signal.total ?? 0 })
        case 'invalid_export_batches':
          return t('signalInvalidExportBatches', { count: signal.count ?? 0 })
        case 'text_only_export':
          return t('signalTextOnlyExport', { count: signal.count ?? 0 })
        default:
          return signal.code
      }
    }

    /**
     * A batch state's dictionary key.
     * @param {string} state - The stored state.
     * @returns {string} the dictionary key.
     */
    function stateKey(state) {
      switch (state) {
        case 'pending':
          return 'statePending'
        case 'imported':
          return 'stateImported'
        case 'partial':
          return 'statePartial'
        case 'invalid':
          return 'stateInvalid'
        case 'incomplete':
          return 'stateIncomplete'
        default:
          return 'stateUnreadable'
      }
    }

    /**
     * The progress line for a running import.
     * @param {Function} t - Translator.
     * @param {object|null} progress - The progress event.
     * @returns {string} the line.
     */
    function progressText(t, progress) {
      if (progress === null || progress === undefined) return t('importing')
      const key = { reading: 'progressReading', validating: 'progressValidating', writing: 'progressWriting', done: 'progressDone' }[progress.phase]
      if (key === undefined) return t('importing')
      return progress.total === null || progress.total === undefined
        ? t(key)
        : `${t(key)} ${progress.processed ?? 0}/${progress.total}`
    }

    /**
     * The recurring import card's body.
     *
     * The task belongs to a conversation, which the page cannot name, so the
     * button hands that decision to the Host and reports only what came back:
     * active, stopped, missing, or a composition with no schedule service.
     *
     * @param {Function} t - Translator.
     * @param {object|undefined} schedule - the state read with the pipeline.
     * @param {Function} onRestore - sets up or rebuilds the task.
     * @param {boolean} busy - whether that request is running.
     * @returns {Array} the card body.
     */
    function scheduleBody(t, schedule, onRestore, busy) {
      if (schedule === undefined || schedule === null) return [h('p', { key: 'loading', className: 'dsh-wc-muted' }, t('loading'))]
      if (schedule.available === false) return [h('p', { key: 'unavail', className: 'dsh-wc-muted' }, t('scheduleUnavailable'))]
      const first = (schedule.tasks ?? [])[0]
      const state = first === undefined
        ? t('scheduleMissing')
        : schedule.active
          ? t('scheduleActive', { when: stamp(first.nextRunAt) ?? t('unknown') })
          : t('scheduleInactive')
      return [
        h('p', { key: 'state', className: 'dsh-wc-body' }, state),
        h(
          'div',
          { key: 'action', className: 'dsh-wc-actions' },
          h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: onRestore }, first === undefined ? t('scheduleSetUp') : t('scheduleRecreate')),
        ),
      ]
    }

    /**
     * The result panel's lines.
     * @param {Function} t - Translator.
     * @param {object} result - The last import result.
     * @param {object} corpus - The corpus totals.
     * @returns {Array} rendered lines.
     */
    function resultLines(t, result, corpus) {
      if (result.progress !== null && result.progress !== undefined) {
        return [h('p', { key: 'progress', className: 'dsh-wc-muted' }, progressText(t, result.progress))]
      }
      if (result.ok !== true) {
        return [h('p', { key: 'failed', className: 'dsh-wc-warn' }, t('resultFailed', { reason: result.reason ?? t('unknown') }))]
      }
      const lines = [
        h(
          'p',
          { key: 'head' },
          t('resultImported', {
            messages: result.messages ?? 0,
            corpus: t('corpusValue', { messages: corpus.messages, chats: corpus.chats }),
          }),
        ),
        h('p', { key: 'counts' }, t('resultCounts', { generated: result.generated ?? 0, updated: result.updated ?? 0, unchanged: result.unchanged ?? 0 })),
      ]
      if ((result.groupSkipped ?? 0) > 0) lines.push(h('p', { key: 'skipped' }, t('resultSkipped', { count: result.groupSkipped })))
      if ((result.suspectedReplacements ?? 0) > 0) {
        lines.push(h('p', { key: 'suspected' }, t('resultSuspected', { count: result.suspectedReplacements })))
      }
      if (result.outsideArchive === true) lines.push(h('p', { key: 'outside' }, t('resultOutside')))
      return lines
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries and the configuration this bundle's page shows
       * in the Plugins panel.
       * @param {object} ctx - Client context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-wechat: dictionaries')
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                { name: 'plugins.bundle.config', key: 'dsh-wechat', locale: NS },
                WechatSettings,
              ),
            ),
          'dsh-wechat: bundle configuration',
        )
      },
    }
  },
})

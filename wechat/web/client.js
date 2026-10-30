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
      loading: 'Reading the WeChat pipeline…',
      loadFailed: 'Could not read the pipeline state ({code}).',
      networkFailed: 'Could not reach the Harness.',
      overviewHeading: 'Pipeline',
      statusLabel: 'State',
      databaseLabel: 'WeChat database',
      databaseChangeLabel: 'Database last changed',
      keysLabel: 'Exporter keys',
      keysCoverage: '{covered} of {total} message shards',
      exportLabel: 'Newest export',
      importLabel: 'Last import',
      corpusLabel: 'Corpus',
      corpusValue: '{messages} messages in {chats} conversations',
      never: 'never',
      unknown: 'unknown',
      exportRoot: 'the export directory',
      shards: '{count} shards',
      keysOk: 'present',
      keysMissing: 'missing',
      keysInvalid: 'unreadable',
      keysUnreadable: 'unreadable',
      keysUnconfigured: 'not configured',
      dbOk: 'found',
      dbNotFound: 'not found',
      dbAmbiguous: 'two accounts — set wechatDbDir',
      dbUnreadable: 'unreadable',
      exportOk: 'ready',
      exportNotFound: 'none yet',
      exportUnreadable: 'unreadable',
      exportUnconfigured: 'exporter directory not configured',
      exportTextOnly: 'text only ×{count}',
      statusOk: 'Up to date',
      statusActionRequired: 'Needs attention',
      statusImportPending: 'A batch is waiting',
      statusUpdatesAvailable: 'New messages are waiting to be exported',
      statusNotice: 'Partly covered',
      statusUnreadable: 'Could not read everything',
      statusEmpty: 'Nothing imported yet',
      signalKeysMissing: 'The exporter has not written its key file yet. Run extract_keys.py once.',
      signalKeysInvalid: 'The exporter key file is not readable JSON. Run extract_keys.py again.',
      signalKeysUnreadable: 'The exporter key file could not be read.',
      signalImportFailed: 'The last import failed: {error}',
      signalUnimportedBatch: 'A complete batch is waiting to be imported: {batches}',
      signalInvalidArchiveBatches: '{count} batch directories in the archive are unusable.',
      signalUnimportedExport: 'A newer export has never been imported: {batch}',
      signalDatabaseNewer: 'WeChat changed after the newest export, so a fresh export would add messages.',
      signalKeysIncomplete: 'The key file covers {covered} of {total} message shards; an export cannot read the rest.',
      signalExportShardsIncomplete: 'The newest export processed {covered} of {total} shards it should have.',
      signalInvalidExportBatches: '{count} directories in the exporter output are unusable.',
      signalTextOnlyExport:
        '{count} export(s) were written without --format jsonl, so they hold no messages to import; the newest one that can be imported is shown above.',
      batchesHeading: 'Batches',
      batchesEmpty: 'No batch is in the archive yet. Export one, then import it here or ask the assistant.',
      columnBatch: 'Batch',
      columnState: 'State',
      columnExport: 'Exported',
      columnChats: 'Chats',
      columnMessages: 'Messages',
      columnImported: 'Imported',
      statePending: 'waiting',
      stateImported: 'imported',
      statePartial: 'private only',
      stateInvalid: 'invalid',
      stateIncomplete: 'incomplete',
      stateUnreadable: 'unreadable',
      importPrivate: 'Import',
      importGroups: 'With groups',
      importing: 'Importing…',
      progressReading: 'Reading the batch…',
      progressValidating: 'Validating messages…',
      progressWriting: 'Writing messages…',
      progressDone: 'Finishing…',
      resultHeading: 'Last import',
      resultImported: '{messages} messages imported into {corpus}',
      resultCounts: '{generated} new, {updated} updated, {unchanged} unchanged',
      resultSkipped: '{count} group messages skipped',
      resultSuspected: '{count} messages arrived without their earlier identity; the identical copy already stored under another id stays.',
      resultFailed: 'Import failed: {reason}',
      resultOutside:
        'This batch was imported where it lies, outside the archive. A later export over the same directory will make the next import refuse until the batch is moved into the archive.',
      batchesUnavailable: 'The exporter has not written export_meta.json yet; it writes that file last.',
      configHeading: 'Configuration',
      configArchive: 'Archive',
      configDatabase: 'Corpus',
      configExporter: 'Exporter project',
      configExportDir: 'Exporter output',
      configKeys: 'Key file',
      configScope: 'Default scope',
      scopePrivate: 'private conversations',
      scopeGroups: 'private and group conversations',
      configHint: 'These come from the plugin row in cordis.yml; edit them there.',
      refresh: 'Refresh',
      scheduleHeading: 'Recurring import',
      scheduleActive: 'Active — next run {when}',
      scheduleInactive: 'The task is still there but stopped.',
      scheduleMissing: 'No import task is set up.',
      scheduleUnavailable: 'This Harness mounts no schedule service.',
      scheduleSetUp: 'Set up the task',
      scheduleRecreate: 'Rebuild the task',
      scheduleRestored: 'The import task is set up again.',
    }

    const zh = {
      loading: '正在读取微信流水线状态…',
      loadFailed: '读取流水线状态失败（{code}）。',
      networkFailed: '无法连接 Harness。',
      overviewHeading: '流水线',
      statusLabel: '状态',
      databaseLabel: '微信数据库',
      databaseChangeLabel: '数据库最近变动',
      keysLabel: '导出器密钥',
      keysCoverage: '{covered}/{total} 个消息分片',
      exportLabel: '最近导出',
      importLabel: '最近导入',
      corpusLabel: '语料库',
      corpusValue: '{messages} 条消息，{chats} 个会话',
      never: '从未',
      unknown: '未知',
      exportRoot: '导出目录本身',
      shards: '{count} 个分片',
      keysOk: '已就绪',
      keysMissing: '缺失',
      keysInvalid: '无法解析',
      keysUnreadable: '无法读取',
      keysUnconfigured: '未配置',
      dbOk: '已找到',
      dbNotFound: '未找到',
      dbAmbiguous: '存在两个账号，请设置 wechatDbDir',
      dbUnreadable: '无法读取',
      exportOk: '已就绪',
      exportNotFound: '暂无',
      exportUnreadable: '无法读取',
      exportUnconfigured: '未配置导出器目录',
      exportTextOnly: '仅文本 ×{count}',
      statusOk: '已同步',
      statusActionRequired: '需要处理',
      statusImportPending: '有批次等待导入',
      statusUpdatesAvailable: '微信有新消息，可以再导出一次',
      statusNotice: '覆盖不完整',
      statusUnreadable: '有部分无法读取',
      statusEmpty: '尚未导入任何批次',
      signalKeysMissing: '导出器还没有写出密钥文件，请先运行一次 extract_keys.py。',
      signalKeysInvalid: '导出器密钥文件不是可解析的 JSON，请重新运行 extract_keys.py。',
      signalKeysUnreadable: '导出器密钥文件无法读取。',
      signalImportFailed: '上一次导入失败：{error}',
      signalUnimportedBatch: '有完整批次等待导入：{batches}',
      signalInvalidArchiveBatches: '归档中有 {count} 个批次目录不可用。',
      signalUnimportedExport: '有一次更新的导出还没有导入：{batch}',
      signalDatabaseNewer: '微信数据库比最近一次导出更新，再导出一次可以拿到新消息。',
      signalKeysIncomplete: '密钥只覆盖 {covered}/{total} 个消息分片，其余分片导不出来。',
      signalExportShardsIncomplete: '最近一次导出只处理了 {covered}/{total} 个应有的分片。',
      signalInvalidExportBatches: '导出目录中有 {count} 个目录不可用。',
      signalTextOnlyExport: '有 {count} 次导出没有用 --format jsonl，里面没有可导入的消息；上面显示的是最近一次可导入的导出。',
      batchesHeading: '批次',
      batchesEmpty: '归档里还没有批次。先导出一次，然后在这里导入，或让助手导入。',
      columnBatch: '批次',
      columnState: '状态',
      columnExport: '导出时间',
      columnChats: '会话',
      columnMessages: '消息',
      columnImported: '导入时间',
      statePending: '待导入',
      stateImported: '已导入',
      statePartial: '仅私聊',
      stateInvalid: '不可用',
      stateIncomplete: '未写完',
      stateUnreadable: '无法读取',
      importPrivate: '导入',
      importGroups: '含群聊',
      importing: '导入中…',
      progressReading: '正在读取批次…',
      progressValidating: '正在校验消息…',
      progressWriting: '正在写入消息…',
      progressDone: '正在收尾…',
      resultHeading: '最近一次导入',
      resultImported: '已导入 {messages} 条消息到 {corpus}',
      resultCounts: '新增 {generated}，更新 {updated}，未变化 {unchanged}',
      resultSkipped: '跳过 {count} 条群聊消息',
      resultSuspected: '有 {count} 条消息以新身份到达；语料里内容相同的旧副本仍然保留。',
      resultFailed: '导入失败：{reason}',
      resultOutside:
        '该批次是就地导入的，不在归档目录里。下次导出覆盖同一目录后，再导入会被拒绝，直到把它移进归档。',
      batchesUnavailable: '导出器还没有写出 export_meta.json（它最后才写这个文件）。',
      configHeading: '配置',
      configArchive: '归档目录',
      configDatabase: '语料库',
      configExporter: '导出器项目',
      configExportDir: '导出输出目录',
      configKeys: '密钥文件',
      configScope: '默认范围',
      scopePrivate: '仅私聊',
      scopeGroups: '私聊与群聊',
      configHint: '这些值来自 cordis.yml 的插件行，在那里修改。',
      refresh: '刷新',
      scheduleHeading: '定时导入',
      scheduleActive: '已启用 —— 下次运行 {when}',
      scheduleInactive: '任务还在，但已停止。',
      scheduleMissing: '尚未建立导入任务。',
      scheduleUnavailable: '当前 Harness 未挂载定时任务服务。',
      scheduleSetUp: '建立任务',
      scheduleRecreate: '重建任务',
      scheduleRestored: '导入任务已重新建立。',
    }

    /**
     * Layout for the section. Values are the shell's own semantic tokens, so the
     * page follows the active theme instead of carrying colors of its own.
     */
    const styles = {
      section: { maxWidth: '860px', padding: '4px 2px 32px', color: 'var(--dsw-alias-label-primary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: '10px',
        padding: '16px 18px',
        marginBottom: '14px',
      },
      cardTitle: { fontSize: '14px', fontWeight: 600, margin: '0 0 12px' },
      rows: { display: 'grid', gridTemplateColumns: 'minmax(120px, 190px) 1fr', gap: '6px 16px', fontSize: '13px', margin: 0 },
      term: { color: 'var(--dsw-alias-label-caption)' },
      value: { margin: 0, minWidth: 0, overflowWrap: 'anywhere' },
      signals: { margin: '12px 0 0', paddingLeft: '18px', fontSize: '13px', lineHeight: 1.7 },
      // The seven columns keep their own widths and the box scrolls when the
      // settings column is narrow; compressing them is what wrapped the buttons.
      tableBox: { overflowX: 'auto' },
      table: { width: '100%', minWidth: '560px', borderCollapse: 'collapse', fontSize: '13px' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-caption)',
        padding: '6px 10px 6px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l4)',
        whiteSpace: 'nowrap',
      },
      td: { padding: '8px 10px 8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'middle' },
      // Shrink-to-fit: the actions cell takes the buttons' width and the
      // conversation name absorbs whatever is left.
      nowrap: { whiteSpace: 'nowrap' },
      // The conversation name wraps rather than being crushed; the box above it
      // takes over once even this does not fit.
      batch: { minWidth: '170px', overflowWrap: 'anywhere' },
      num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      actionsHead: { width: '1%' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'nowrap' },
      muted: { color: 'var(--dsw-alias-label-caption)', fontSize: '12px', margin: '8px 0 0' },
      body: { fontSize: '13px', lineHeight: 1.7 },
      warn: { color: 'var(--dsw-alias-label-error)', fontSize: '13px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
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
        return h('div', { style: styles.section }, h('p', { style: styles.muted }, t('loading')))
      }
      if (state.data === null) {
        return h(
          'div',
          { style: styles.section },
          h('p', { style: styles.warn }, state.error === 'network_error' ? t('networkFailed') : t('loadFailed', { code: state.error ?? 'internal_error' })),
        )
      }

      const data = state.data
      const pipeline = data.pipeline
      const statusKey = `status${pipeline.status.charAt(0).toUpperCase()}${pipeline.status.slice(1).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())}`
      const result = data.import.lastResult

      // The Plugins panel draws this page's title, version, and description from
      // the bundle's locale metadata, so this renders its cards only.
      return h(
        'div',
        { style: styles.section },
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('overviewHeading')),
          h(
            'dl',
            { style: styles.rows },
            h(Row, { label: t('statusLabel'), value: t(statusKey) }),
            h(Row, { label: t('databaseLabel'), value: describeDatabase(t, pipeline.database) }),
            h(Row, { label: t('databaseChangeLabel'), value: pipeline.database.latest_change_at ?? t('never') }),
            h(Row, { label: t('keysLabel'), value: describeKeys(t, pipeline.keys) }),
            h(Row, { label: t('exportLabel'), value: describeExport(t, pipeline.export) }),
            h(Row, { label: t('importLabel'), value: describeImport(t, pipeline.import) }),
            h(Row, { label: t('corpusLabel'), value: t('corpusValue', { messages: pipeline.corpus.messages, chats: pipeline.corpus.chats }) }),
          ),
          pipeline.signals.length > 0
            ? h('ul', { style: styles.signals }, ...pipeline.signals.map((signal, index) => h('li', { key: index }, signalText(t, signal))))
            : null,
        ),
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('batchesHeading')),
          data.batches.length === 0
            ? h('p', { style: styles.muted }, t('batchesEmpty'))
            : h(
                'div',
                { style: styles.tableBox },
                h(
                  'table',
                  { style: styles.table },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', { style: { ...styles.th, ...styles.batch } }, t('columnBatch')),
                      h('th', { style: { ...styles.th, ...styles.nowrap } }, t('columnState')),
                      h('th', { style: { ...styles.th, ...styles.nowrap } }, t('columnExport')),
                      h('th', { style: { ...styles.th, ...styles.num } }, t('columnChats')),
                      h('th', { style: { ...styles.th, ...styles.num } }, t('columnMessages')),
                      h('th', { style: { ...styles.th, ...styles.nowrap } }, t('columnImported')),
                      h('th', { style: { ...styles.th, ...styles.actionsHead } }, ''),
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
                        { key: row.batch },
                        h(
                          'td',
                          { style: styles.td },
                          h('div', null, row.batch),
                          row.invalid === null || row.invalid === undefined
                            ? null
                            : h('div', { style: styles.muted }, row.invalid),
                        ),
                        h(
                          'td',
                          { style: { ...styles.td, ...styles.nowrap } },
                          h(Tag, { tone: row.state === 'imported' ? 'success' : undefined }, t(stateKey(row.state))),
                        ),
                        h('td', { style: { ...styles.td, ...styles.nowrap } }, stamp(row.exportInstant ?? row.exportTime) ?? t('unknown')),
                        h('td', { style: { ...styles.td, ...styles.num } }, row.chatCount ?? '—'),
                        h('td', { style: { ...styles.td, ...styles.num } }, row.totalMessages ?? '—'),
                        h('td', { style: { ...styles.td, ...styles.nowrap } }, stamp(row.importedAt) ?? t('never')),
                        h(
                          'td',
                          { style: { ...styles.td, ...styles.nowrap } },
                          importable
                            ? h(
                                'div',
                                { style: styles.actions },
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
          running ? h('p', { style: styles.muted }, progressText(t, data.import.progress)) : null,
          result === null || result === undefined
            ? null
            : h('div', { style: styles.body }, h('h2', { style: styles.cardTitle }, t('resultHeading')), ...resultLines(t, result, pipeline.corpus)),
        ),
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('configHeading')),
          h(
            'dl',
            { style: styles.rows },
            h(Row, { label: t('configArchive'), value: h('span', { style: styles.mono }, data.config.batchesDir) }),
            h(Row, { label: t('configDatabase'), value: h('span', { style: styles.mono }, data.config.databasePath) }),
            h(Row, { label: t('configExporter'), value: h('span', { style: styles.mono }, data.config.exporterDir === '' ? t('unknown') : data.config.exporterDir) }),
            h(Row, { label: t('configExportDir'), value: h('span', { style: styles.mono }, data.config.exportDir === '' ? t('unknown') : data.config.exportDir) }),
            h(Row, { label: t('configKeys'), value: h('span', { style: styles.mono }, data.config.keysFile === '' ? t('unknown') : data.config.keysFile) }),
            h(Row, { label: t('configScope'), value: data.config.includeGroups ? t('scopeGroups') : t('scopePrivate') }),
          ),
          h('p', { style: styles.muted }, t('configHint')),
        ),
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('scheduleHeading')),
          scheduleBody(t, data.schedule, () => void restoreSchedule(data.schedule), state.busy === 'schedule'),
          state.notice === null ? null : h('p', { style: styles.muted }, t(state.notice)),
        ),
        h('div', { style: styles.actions }, h(Button, { variant: 'ghost', size: 'sm', onClick: () => void refresh() }, t('refresh'))),
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
      if (schedule === undefined || schedule === null) return [h('p', { style: styles.muted }, t('loading'))]
      if (schedule.available === false) return [h('p', { style: styles.muted }, t('scheduleUnavailable'))]
      const first = (schedule.tasks ?? [])[0]
      const state = first === undefined
        ? t('scheduleMissing')
        : schedule.active
          ? t('scheduleActive', { when: stamp(first.nextRunAt) ?? t('unknown') })
          : t('scheduleInactive')
      return [
        h('p', { key: 'state', style: styles.body }, state),
        h(
          'div',
          { key: 'action', style: styles.actions },
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
        return [h('p', { key: 'progress', style: styles.muted }, progressText(t, result.progress))]
      }
      if (result.ok !== true) {
        return [h('p', { key: 'failed', style: styles.warn }, t('resultFailed', { reason: result.reason ?? t('unknown') }))]
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

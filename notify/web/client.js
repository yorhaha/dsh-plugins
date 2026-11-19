/**
 * Browser half of the notification bundle: the configuration this bundle's page
 * shows in the Plugins panel — the PushPlus targets the assistant pushes to.
 *
 * This file is served verbatim as a classic script and is never bundled, so it
 * declares no imports, carries its own dictionaries, and self-registers under the
 * package name. It reaches its Host half over the Harness's own authenticated API
 * channel, which returns the stored tokens so this page can show them in the clear.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this section registers its dictionaries under. */
    const NS = 'settings.notify'

    /**
     * Host route, document-relative so a Harness mounted under a sub-path still
     * reaches the route the Host registered at the server root.
     */
    const ROUTE = 'api/plugin-notify'

    const en = {
      loading: 'Loading notification targets…',
      targetsHeading: 'Targets',
      targetsEmpty: 'No targets configured. Add a PushPlus token below.',
      addedAt: 'added {when}',
      unusable: 'unusable: {reason}',
      test: 'Send test',
      remove: 'Delete',
      addHeading: 'Add or update target',
      nameLabel: 'Name',
      nameHint:
        'Lowercase letters, digits, and hyphens (up to 32 chars). Using an existing name updates its token.',
      tokenLabel: 'PushPlus Token',
      tokenHint: 'Saved in the local credential store.',
      save: 'Save',
      saved: 'Saved.',
      configHeading: 'Delivery Settings',
      configBaseUrl: 'Endpoint',
      configTemplate: 'Template',
      configTitleLimit: 'Max title length',
      configBodyLimit: 'Max body length',
      configChars: '{count} chars',
      configNote: 'Configured in cordis.patch.yml.',
      testTitle: 'Harness Test Notification',
      testContent: 'Test notification from DeepSeek Harness.',
      testSent: 'Test notification sent.',
      testFailed: 'Test failed: {reason}',
      loadFailed: 'Failed to load plugin status: {code}',
        'reasons.record_missing': 'record not found',
        'reasons.not_a_target': 'record is not a notification target',
        'reasons.unknown_channel': 'record belongs to another channel',
        'reasons.no_token': 'record contains no token',
        'errors.unknown': 'unexpected error ({code})',
        'errors.invalid_target_name': 'use lowercase letters, digits, and hyphens (up to 32 chars)',
        'errors.invalid_token': 'please enter a PushPlus token',
        'errors.invalid_body': 'message content cannot be empty',
        'errors.unknown_target': 'target no longer exists; please refresh',
        'errors.unusable_target': 'stored token is unreadable; please delete and re-add',
        'errors.unreachable': 'cannot reach Harness; make sure it is running',
        'errors.body_too_large': 'request body too large',
        'errors.invalid_json': 'invalid JSON request',
        'errors.unknown_action': 'unsupported action',
        'errors.request_failed': 'cannot reach PushPlus; check network and endpoint',
        'errors.http_status': 'PushPlus returned an error status',
        'errors.invalid_response': 'unexpected response from PushPlus',
        'errors.rejected': 'rejected by PushPlus (token may be invalid or expired)',
        'errors.aborted': 'send cancelled',
    }

    const zh = {
      loading: '正在加载通知目标…',
      targetsHeading: '推送目标',
      targetsEmpty: '暂无推送目标，请在下方添加 PushPlus token。',
      addedAt: '添加于 {when}',
      unusable: '不可用：{reason}',
      test: '发送测试',
      remove: '删除',
      addHeading: '添加或更新目标',
      nameLabel: '目标名称',
      nameHint: '支持小写字母、数字和连字符（最多 32 个字符）；同名目标将覆盖更新其 token。',
      tokenLabel: 'PushPlus Token',
      tokenHint: '保存在本机凭据库中。',
      save: '保存',
      saved: '已保存。',
      configHeading: '发送设置',
      configBaseUrl: '接口地址',
      configTemplate: '消息模板',
      configTitleLimit: '标题长度上限',
      configBodyLimit: '正文长度上限',
      configChars: '{count} 字符',
      configNote: '配置项来自 cordis.patch.yml。',
      testTitle: 'Harness 测试通知',
      testContent: '这是一条来自 DeepSeek Harness 的测试通知。',
      testSent: '测试消息已发送。',
      testFailed: '发送失败：{reason}',
      loadFailed: '加载插件状态失败：{code}',
        'reasons.record_missing': '未找到存储记录',
        'reasons.not_a_target': '记录不是有效的通知目标',
        'reasons.unknown_channel': '记录属于其他通知通道',
        'reasons.no_token': '记录中缺少 token',
        'errors.unknown': '未知错误（{code}）',
        'errors.invalid_target_name': '名称仅限小写字母、数字和连字符，最多 32 个字符',
        'errors.invalid_token': '请输入 PushPlus token',
        'errors.invalid_body': '消息正文不能为空',
        'errors.unknown_target': '该目标已不存在，请刷新列表',
        'errors.unusable_target': '已存 token 无法读取，请删除后重新添加',
        'errors.unreachable': '无法连接 Harness，请确认服务正在运行',
        'errors.body_too_large': '请求体过大',
        'errors.invalid_json': '请求 JSON 格式无效',
        'errors.unknown_action': '不支持的操作',
        'errors.request_failed': '无法连接 PushPlus，请检查网络或接口地址',
        'errors.http_status': 'PushPlus 返回错误状态码',
        'errors.invalid_response': 'PushPlus 返回格式异常',
        'errors.rejected': 'PushPlus 拒绝了该消息，可能是 token 无效或已过期',
        'errors.aborted': '发送已取消',
    }

    /**
     * Failure codes the dictionaries carry copy for. A dictionary is indexed by
     * exact key, so the error entries sit flat beside every other key and the
     * code set is read back off that prefix.
     */
    const KNOWN_ERRORS = new Set(
      Object.keys(en).filter((key) => key.startsWith('errors.')).map((key) => key.slice('errors.'.length)),
    )

    /** Record reasons the dictionaries carry copy for, read off the same prefix. */
    const KNOWN_REASONS = new Set(
      Object.keys(en).filter((key) => key.startsWith('reasons.')).map((key) => key.slice('reasons.'.length)),
    )

    /**
     * Resolve one failure code to text.
     * @param {function} t - Bound locale function.
     * @param {string} code - Failure code from the Host.
     * @returns {string} the text.
     */
    function errorText(t, code) {
      return KNOWN_ERRORS.has(code) ? t(`errors.${code}`) : t('errors.unknown', { code })
    }

    /**
     * Resolve one stored-record reason to text.
     * @param {function} t - Bound locale function.
     * @param {string} reason - Reason code from the Host.
     * @returns {string} the text.
     */
    function reasonText(t, reason) {
      return KNOWN_REASONS.has(reason) ? t(`reasons.${reason}`) : String(reason)
    }

    const styles = {
      page: { padding: '4px 2px 32px', color: 'var(--dsw-alias-label-primary)', maxWidth: '720px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: '10px',
        padding: '14px 16px',
        marginBottom: '14px',
      },
      cardTitle: { fontSize: '14px', fontWeight: 600, margin: '0 0 8px' },
      line: { fontSize: '13px', lineHeight: 1.6, margin: '0 0 6px' },
      caption: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-caption)' },
      warn: { fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-state-warn-label)' },
      ok: { fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-state-success-primary)' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px' },
      targetRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '8px 0',
        borderTop: '1px solid var(--dsw-alias-border-l4)',
      },
      targetMain: { display: 'flex', flex: '1 1 auto', flexDirection: 'column', minWidth: 0 },
      targetName: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '13px',
        lineHeight: 1.7,
      },
      targetToken: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        lineHeight: 1.7,
        wordBreak: 'break-all',
        color: 'var(--dsw-alias-label-secondary)',
      },
      field: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px' },
      fieldLabel: { flex: '0 0 96px', fontSize: '13px' },
      input: {
        flex: '1 1 220px',
        minWidth: '160px',
        boxSizing: 'border-box',
        fontSize: '13px',
        padding: '6px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      button: {
        fontSize: '13px',
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-button-elevated-fill)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      primaryButton: {
        fontSize: '13px',
        padding: '6px 14px',
        borderRadius: '8px',
        border: 'none',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        cursor: 'pointer',
      },
      disabled: { opacity: 0.5, cursor: 'default' },
      list: { margin: '8px 0 0', padding: 0, listStyle: 'none' },
      listItem: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '12px',
        fontSize: '13px',
        lineHeight: 1.9,
        borderTop: '1px solid var(--dsw-alias-border-l4)',
        paddingTop: '2px',
      },
    }

    /**
     * Call one Host action.
     * @param {string} action - Action name.
     * @param {object} [body] - Extra request fields.
     * @returns {Promise<object>} the action's value.
     */
    async function call(action, body) {
      let response
      try {
        response = await fetch(new URL(ROUTE, document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ action, ...(body ?? {}) }),
        })
      } catch {
        // A page left open across a Harness restart has no route to reach until
        // one comes back; that is a transport failure, not an action failure.
        throw Object.assign(new Error('unreachable'), { code: 'unreachable' })
      }
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload.ok !== true) {
        const code = payload?.error?.code ?? `http_${response.status}`
        throw Object.assign(new Error(code), { code })
      }
      return payload.value
    }

    /** Two digits, for the parts of a date and a clock. */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** The interface language the locale service keeps on `<html lang>`. */
    function uiLanguage() {
      const lang = typeof document !== 'undefined' ? String(document.documentElement?.lang ?? '') : ''
      return /^zh\b/i.test(lang) ? 'zh' : 'en'
    }

    /**
     * Render one instant, falling back to the raw value when it is unparseable.
     *
     * The clock is always 24-hour, so no reader ever sees AM or PM — not even one
     * whose regional settings default to a 12-hour clock. The date follows the
     * interface language rather than the machine's locale: 中文 writes
     * `2026-10-28 19:56` with Chinese wording where this page adds any, and English
     * writes the same ISO digits instead of an English month name.
     */
    function when(iso) {
      if (typeof iso !== 'string') return '—'
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return iso
      return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
    }

    /** One button that disables itself while its action runs. */
    function Action(props) {
      const { label, onClick, busy, primary, disabled } = props
      const inactive = busy === true || disabled === true
      return h(
        'button',
        {
          type: 'button',
          style: inactive
            ? { ...(primary ? styles.primaryButton : styles.button), ...styles.disabled }
            : primary
              ? styles.primaryButton
              : styles.button,
          disabled: inactive,
          onClick,
        },
        label,
      )
    }

    /** One target, with its state, its last test result, and its two actions. */
    function TargetRow(props) {
      const { t, target, busy, result, onTest, onDelete } = props
      const ready = target.status === 'ready'
      const state = ready ? t('addedAt', { when: when(target.addedAt) }) : t('unusable', { reason: reasonText(t, target.reason) })
      return h(
        'li',
        { style: styles.targetRow },
        h(
          'div',
          { style: styles.targetMain },
          h('span', { style: styles.targetName }, target.name),
          ready ? h('span', { style: styles.targetToken }, `${t('tokenLabel')}: ${target.token}`) : null,
          h('span', { style: ready ? styles.caption : styles.warn }, state),
          result === undefined
            ? null
            : h(
                'span',
                { style: result.ok ? styles.ok : styles.warn },
                result.ok ? t('testSent') : t('testFailed', { reason: errorText(t, result.error.code) }),
              ),
          // The Host's own words for a refusal carry upstream detail the
          // dictionaries cannot: a wrong token reads differently from a throttled
          // account, and both are worth showing verbatim.
          result === undefined || result.ok ? null : h('span', { style: styles.caption }, result.error.message),
        ),
        h(
          'div',
          { style: styles.row },
          h(Action, {
            label: t('test'),
            onClick: onTest,
            busy: busy === `test:${target.name}`,
            disabled: !ready,
          }),
          h(Action, { label: t('remove'), onClick: onDelete, busy: busy === `delete:${target.name}` }),
        ),
      )
    }

    /** One read-only configuration fact. */
    function ConfigRow(props) {
      return h(
        'li',
        { style: styles.listItem },
        h('span', null, props.label),
        h('span', { style: styles.caption }, props.value),
      )
    }

    /**
     * The settings section.
     * @param {object} props - Slot props, carrying the locale `t` seat.
     * @returns {object} the rendered section.
     */
    function NotifySettings(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [name, setName] = React.useState('default')
      const [token, setToken] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [results, setResults] = React.useState({})

      const refresh = React.useCallback(async () => {
        try {
          setStatus(await call('status'))
          setError(null)
        } catch (failure) {
          setError(failure.code)
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      // Retry until the first read lands: a page open across a Harness restart
      // recovers on its own instead of claiming the user has no target.
      const loaded = status !== null
      React.useEffect(() => {
        if (loaded) return undefined
        const timer = setInterval(() => {
          void refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [loaded, refresh])

      const run = React.useCallback(async (label, work) => {
        setBusy(label)
        try {
          await work()
          setError(null)
        } catch (failure) {
          setError(failure.code)
        } finally {
          setBusy(null)
        }
      }, [])

      const save = () =>
        run('save', async () => {
          setStatus(await call('target.save', { name, token }))
          setToken('')
          setNotice({ tone: 'ok', text: t('saved') })
        })

      const remove = (target) =>
        run(`delete:${target}`, async () => {
          setStatus(await call('target.delete', { name: target }))
          setNotice(null)
          setResults((current) => {
            const next = { ...current }
            delete next[target]
            return next
          })
        })

      const test = (target) =>
        run(`test:${target}`, async () => {
          const value = await call('target.test', {
            name: target,
            title: t('testTitle'),
            content: t('testContent'),
          })
          setResults((current) => ({ ...current, [target]: value }))
        })

      const targets = status?.targets ?? []
      const config = status?.config ?? null

      // The Plugins panel draws this page's title, version, and description from
      // the bundle's locale metadata, so this renders its cards only.
      return h(
        'div',
        { style: styles.page },
        error === null ? null : h('p', { style: styles.warn }, t('loadFailed', { code: error })),
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('targetsHeading')),
          status === null
            ? h('p', { style: styles.caption }, t('loading'))
            : targets.length === 0
              ? h('p', { style: styles.caption }, t('targetsEmpty'))
              : h(
                  'ul',
                  { style: styles.list },
                  targets.map((target) =>
                    h(TargetRow, {
                      key: target.name,
                      t,
                      target,
                      busy,
                      result: results[target.name],
                      onTest: () => test(target.name),
                      onDelete: () => remove(target.name),
                    }),
                  ),
                ),
        ),
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('addHeading')),
          h(
            'div',
            { style: styles.field },
            h('label', { style: styles.fieldLabel }, t('nameLabel')),
            h('input', {
              style: styles.input,
              value: name,
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setName(event.target.value.toLowerCase()),
            }),
          ),
          h('p', { style: styles.caption }, t('nameHint')),
          h(
            'div',
            { style: styles.field },
            h('label', { style: styles.fieldLabel }, t('tokenLabel')),
            h('input', {
              style: styles.input,
              type: 'text',
              value: token,
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setToken(event.target.value),
            }),
          ),
          h('p', { style: styles.caption }, t('tokenHint')),
          h(
            'div',
            { style: styles.row },
            h(Action, {
              label: t('save'),
              onClick: save,
              busy: busy === 'save',
              primary: true,
              disabled: token.trim() === '' || name.trim() === '',
            }),
          ),
          notice === null ? null : h('p', { style: styles.ok }, notice.text),
        ),
        config === null
          ? null
          : h(
              'div',
              { style: styles.card },
              h('h2', { style: styles.cardTitle }, t('configHeading')),
              h(
                'ul',
                { style: styles.list },
                h(ConfigRow, { label: t('configBaseUrl'), value: config.baseUrl }),
                h(ConfigRow, { label: t('configTemplate'), value: config.template }),
                h(ConfigRow, {
                  label: t('configTitleLimit'),
                  value: t('configChars', { count: config.titleMaxChars }),
                }),
                h(ConfigRow, {
                  label: t('configBodyLimit'),
                  value: t('configChars', { count: config.contentMaxChars }),
                }),
              ),
              h('p', { style: styles.caption }, t('configNote')),
            ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries and the configuration this bundle's page shows
       * in the Plugins panel.
       * @param {object} ctx - Client context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-notify: dictionaries')
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: 'dsh-notify',
                  locale: NS,
                },
                NotifySettings,
              ),
            ),
          'dsh-notify: bundle configuration',
        )
      },
    }
  },
})

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
      loading: 'Reading notification targets…',
      targetsHeading: 'Targets',
      targetsEmpty: 'No target yet. Add a PushPlus token below.',
      addedAt: 'added {when}',
      unusable: 'unusable — {reason}',
      test: 'Send test',
      remove: 'Delete',
      addHeading: 'Add or replace a target',
      nameLabel: 'Name',
      nameHint:
        'Lowercase letters, digits, and hyphens, up to 32 characters. Saving an existing name replaces its token.',
      tokenLabel: 'PushPlus token',
      tokenHint: 'Stored in the local credential store. A stored token is shown in the list above in the clear.',
      save: 'Save',
      saved: 'Saved. The assistant can send to it now.',
      configHeading: 'Delivery',
      configBaseUrl: 'Endpoint',
      configTemplate: 'Template',
      configTitleLimit: 'Longest title',
      configBodyLimit: 'Longest body',
      configChars: '{count} characters',
      configNote: 'These come from the plugin configuration in cordis.patch.yml.',
      testTitle: 'Harness test notification',
      testContent:
        'This is a test notification from DeepSeek Harness. Receiving it means the stored PushPlus token works.',
      testSent: 'Test message sent.',
      testFailed: 'Test failed — {reason}',
      loadFailed: 'Could not read the plugin state: {code}',
        'reasons.record_missing': 'the stored record is gone',
        'reasons.not_a_target': 'the stored record is not a notification target',
        'reasons.unknown_channel': 'the stored record belongs to another notification channel',
        'reasons.no_token': 'the stored record carries no token',
        'errors.unknown': 'unexpected failure ({code})',
        'errors.invalid_target_name': 'use lowercase letters, digits, and hyphens, up to 32 characters',
        'errors.invalid_token': 'enter the PushPlus token',
        'errors.invalid_body': 'the message is empty',
        'errors.unknown_target': 'that target no longer exists; reload the list',
        'errors.unusable_target': 'the stored token is unusable; delete the target and add it again',
        'errors.unreachable': 'the Harness is not reachable; is it still running?',
        'errors.body_too_large': 'the request was too large',
        'errors.invalid_json': 'the Harness could not read the request',
        'errors.unknown_action': 'this page asked for something the Harness does not know',
        'errors.request_failed': 'PushPlus could not be reached; check the network and the endpoint',
        'errors.http_status': 'PushPlus answered with an error status',
        'errors.invalid_response': 'PushPlus answered something unexpected',
        'errors.rejected': 'PushPlus refused the message, usually because the token is wrong or expired',
        'errors.aborted': 'the send was cancelled',
    }

    const zh = {
      loading: '正在读取通知目标…',
      targetsHeading: '目标',
      targetsEmpty: '还没有目标。在下面填入一个 PushPlus token。',
      addedAt: '添加于 {when}',
      unusable: '不可用 —— {reason}',
      test: '发送测试',
      remove: '删除',
      addHeading: '添加或替换目标',
      nameLabel: '名称',
      nameHint: '小写字母、数字和连字符，最多 32 个字符。保存已有名称会替换它的 token。',
      tokenLabel: 'PushPlus token',
      tokenHint: '保存在本机凭据库。已保存的 token 会在上方列表中明文显示。',
      save: '保存',
      saved: '已保存，助手现在可以发送到它了。',
      configHeading: '发送设置',
      configBaseUrl: '发送地址',
      configTemplate: '模板',
      configTitleLimit: '标题上限',
      configBodyLimit: '正文上限',
      configChars: '{count} 字符',
      configNote: '这几项来自 cordis.patch.yml 里的插件配置。',
      testTitle: 'Harness 测试通知',
      testContent: '这是一条来自 DeepSeek Harness 的测试通知。能收到它，说明保存的 PushPlus token 可用。',
      testSent: '测试消息已发送。',
      testFailed: '测试失败 —— {reason}',
      loadFailed: '无法读取插件状态：{code}',
        'reasons.record_missing': '存储的记录已不存在',
        'reasons.not_a_target': '存储的记录不是通知目标',
        'reasons.unknown_channel': '存储的记录属于其他通知通道',
        'reasons.no_token': '存储的记录里没有 token',
        'errors.unknown': '意外失败（{code}）',
        'errors.invalid_target_name': '请使用小写字母、数字和连字符，最多 32 个字符',
        'errors.invalid_token': '请填入 PushPlus token',
        'errors.invalid_body': '消息内容为空',
        'errors.unknown_target': '该目标已不存在，请刷新列表',
        'errors.unusable_target': '保存的 token 不可用，请删除该目标后重新添加',
        'errors.unreachable': '连不上 Harness，它还在运行吗？',
        'errors.body_too_large': '请求体过大',
        'errors.invalid_json': 'Harness 无法解析这次请求',
        'errors.unknown_action': '这个页面请求了 Harness 不认识的动作',
        'errors.request_failed': '连不上 PushPlus，请检查网络与发送地址',
        'errors.http_status': 'PushPlus 返回了错误状态码',
        'errors.invalid_response': 'PushPlus 返回了预期之外的内容',
        'errors.rejected': 'PushPlus 拒绝了这条消息，通常是 token 错误或已失效',
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

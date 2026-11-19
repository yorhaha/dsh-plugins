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
      targetsCount: '{count}',
      targetsEmpty: 'No targets configured. Add a PushPlus token below.',
      statusReady: 'Ready',
      statusUnusable: 'Unusable',
      addedAt: 'added {when}',
      unusable: 'unusable: {reason}',
      showToken: 'Show',
      hideToken: 'Hide',
      copyToken: 'Copy',
      copied: 'Copied',
      test: 'Send test',
      remove: 'Delete',
      confirmRemove: 'Confirm delete',
      cancel: 'Cancel',
      addHeading: 'Add or update target',
      nameLabel: 'Name',
      nameHint:
        'Lowercase letters, digits, and hyphens (up to 32 chars). Using an existing name updates its token.',
      tokenLabel: 'PushPlus Token',
      tokenPlaceholder: 'Paste PushPlus token…',
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
      targetsCount: '{count}',
      targetsEmpty: '暂无推送目标，请在下方添加 PushPlus token。',
      statusReady: '可用',
      statusUnusable: '不可用',
      addedAt: '添加于 {when}',
      unusable: '不可用：{reason}',
      showToken: '显示',
      hideToken: '隐藏',
      copyToken: '复制',
      copied: '已复制',
      test: '发送测试',
      remove: '删除',
      confirmRemove: '确认删除',
      cancel: '取消',
      addHeading: '添加或更新目标',
      nameLabel: '目标名称',
      nameHint: '支持小写字母、数字和连字符（最多 32 个字符）；同名目标将覆盖更新其 token。',
      tokenLabel: 'PushPlus Token',
      tokenPlaceholder: '粘贴 PushPlus token…',
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

    const CSS = `
@keyframes dsh-ntf-spin { to { transform: rotate(360deg); } }
.dsh-ntf-page { padding: 4px 2px 32px; color: var(--dsw-alias-label-primary); max-width: 740px; }
.dsh-ntf-card {
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 14px;
}
.dsh-ntf-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin-bottom: 10px;
}
.dsh-ntf-card-title { font-size: 14px; font-weight: 600; margin: 0; }
.dsh-ntf-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px; border-radius: 999px; font-size: 11.5px; line-height: 17px; font-weight: 500;
  font-variant-numeric: tabular-nums;
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-secondary);
}
.dsh-ntf-badge[data-tone="ok"] {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l4);
  color: var(--dsw-alias-state-success-primary);
}
.dsh-ntf-badge[data-tone="warn"] {
  background: var(--dsw-alias-state-warn-tertiary, rgba(184,121,26,.12));
  color: var(--dsw-alias-state-warn-label);
}
.dsh-ntf-dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; flex: none; }
.dsh-ntf-caption { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-caption); margin: 4px 0 0; }
.dsh-ntf-alert {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 9px 12px; border-radius: 8px; margin-top: 10px; margin-bottom: 10px;
  font-size: 12.5px; line-height: 1.55;
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-ntf-alert[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dsh-ntf-alert[data-tone="warn"] {
  border-color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary, rgba(184,121,26,.1));
  color: var(--dsw-alias-state-warn-label);
}
.dsh-ntf-alert-body { flex: 1; min-width: 0; }
.dsh-ntf-alert-detail { font-size: 11.5px; color: var(--dsw-alias-label-caption); margin-top: 2px; word-break: break-word; }
.dsh-ntf-target-list { margin: 4px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.dsh-ntf-target-item {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 10px 12px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-ntf-target-main { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-ntf-target-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ntf-target-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px; font-weight: 600;
}
.dsh-ntf-token-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-ntf-token {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; word-break: break-all;
  color: var(--dsw-alias-label-secondary);
}
.dsh-ntf-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ntf-field { display: flex; flex-direction: column; gap: 5px; margin-top: 12px; }
.dsh-ntf-field:first-of-type { margin-top: 4px; }
.dsh-ntf-label { font-size: 12.5px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-ntf-input-wrap { display: flex; align-items: center; gap: 6px; }
.dsh-ntf-input {
  flex: 1 1 auto; min-width: 0; width: 100%; box-sizing: border-box;
  font-size: 13px; padding: 7px 11px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  transition: border-color 120ms ease;
}
.dsh-ntf-input[data-mono="true"] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.dsh-ntf-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #2f6feb); }
.dsh-ntf-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font-size: 12.5px; font-weight: 500; padding: 6px 13px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  cursor: pointer; transition: background 120ms ease, opacity 120ms ease, border-color 120ms ease;
}
.dsh-ntf-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ntf-btn:focus-visible, .dsh-ntf-micro:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #2f6feb); outline-offset: 1px;
}
.dsh-ntf-btn[data-variant="primary"] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsh-ntf-btn[data-variant="primary"]:hover:not(:disabled) { opacity: 0.9; }
.dsh-ntf-btn[data-variant="danger"] {
  border-color: var(--dsw-alias-state-error-primary);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-ntf-btn[data-variant="danger"]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,.12));
}
.dsh-ntf-btn[data-size="sm"] { padding: 4px 10px; font-size: 12px; border-radius: 7px; }
.dsh-ntf-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-ntf-micro {
  font-size: 11px; padding: 2px 7px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dsh-ntf-micro:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-ntf-spinner {
  width: 12px; height: 12px; border-radius: 999px;
  border: 1.8px solid currentColor; border-top-color: transparent;
  animation: dsh-ntf-spin 0.7s linear infinite; flex: none;
}
.dsh-ntf-list { margin: 4px 0 0; padding: 0; list-style: none; }
.dsh-ntf-list-item {
  display: flex; justify-content: space-between; align-items: baseline; gap: 14px; flex-wrap: wrap;
  font-size: 13px; padding: 7px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l4));
}
.dsh-ntf-list-item:first-child { border-top: none; padding-top: 2px; }
.dsh-ntf-list-value {
  font-size: 12px; color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right;
}
`

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

    /** Mask a stored token while preserving its tail for quick recognition. */
    function maskToken(value) {
      if (typeof value !== 'string' || value.length <= 6) return '••••••'
      return `${'•'.repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`
    }

    /** One button that disables itself and shows a spinner while its action runs. */
    function Action(props) {
      const { label, onClick, busy, primary, danger, size, disabled } = props
      const inactive = busy === true || disabled === true
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-ntf-btn',
          'data-variant': danger ? 'danger' : primary ? 'primary' : undefined,
          'data-size': size,
          disabled: inactive,
          onClick,
        },
        busy === true ? h('span', { className: 'dsh-ntf-spinner', 'aria-hidden': true }) : null,
        label,
      )
    }

    /** One target, with its state, masked/copyable token, test result, and confirmed delete. */
    function TargetRow(props) {
      const { t, target, busy, result, onTest, onDelete } = props
      const [revealed, setRevealed] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [confirming, setConfirming] = React.useState(false)
      const ready = target.status === 'ready'
      const state = ready ? t('addedAt', { when: when(target.addedAt) }) : t('unusable', { reason: reasonText(t, target.reason) })

      const copy = async () => {
        if (!target.token) return
        try {
          await navigator.clipboard.writeText(target.token)
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          setCopied(false)
        }
      }

      return h(
        'li',
        { className: 'dsh-ntf-target-item' },
        h(
          'div',
          { className: 'dsh-ntf-target-main' },
          h(
            'div',
            { className: 'dsh-ntf-target-head' },
            h('span', { className: 'dsh-ntf-target-name' }, target.name),
            h(
              'span',
              { className: 'dsh-ntf-badge', 'data-tone': ready ? 'ok' : 'warn' },
              h('span', { className: 'dsh-ntf-dot', 'aria-hidden': true }),
              ready ? t('statusReady') : t('statusUnusable'),
            ),
          ),
          ready
            ? h(
                'div',
                { className: 'dsh-ntf-token-row' },
                h('span', { className: 'dsh-ntf-token' }, revealed ? target.token : maskToken(target.token)),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ntf-micro',
                    onClick: () => setRevealed((prev) => !prev),
                  },
                  revealed ? t('hideToken') : t('showToken'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ntf-micro',
                    onClick: () => void copy(),
                  },
                  copied ? t('copied') : t('copyToken'),
                ),
              )
            : null,
          h('span', { className: 'dsh-ntf-caption' }, state),
          result === undefined
            ? null
            : h(
                'div',
                { className: 'dsh-ntf-alert', 'data-tone': result.ok ? 'ok' : 'warn', style: { marginBottom: 0 } },
                h(
                  'div',
                  { className: 'dsh-ntf-alert-body' },
                  h('div', null, result.ok ? t('testSent') : t('testFailed', { reason: errorText(t, result.error.code) })),
                  result.ok ? null : h('div', { className: 'dsh-ntf-alert-detail' }, result.error.message),
                ),
              ),
        ),
        h(
          'div',
          { className: 'dsh-ntf-row' },
          h(Action, {
            label: t('test'),
            size: 'sm',
            onClick: onTest,
            busy: busy === `test:${target.name}`,
            disabled: !ready,
          }),
          confirming
            ? h(
                React.Fragment,
                null,
                h(Action, {
                  label: t('confirmRemove'),
                  size: 'sm',
                  danger: true,
                  busy: busy === `delete:${target.name}`,
                  onClick: () => {
                    setConfirming(false)
                    onDelete()
                  },
                }),
                h(Action, {
                  label: t('cancel'),
                  size: 'sm',
                  onClick: () => setConfirming(false),
                }),
              )
            : h(Action, {
                label: t('remove'),
                size: 'sm',
                onClick: () => setConfirming(true),
              }),
        ),
      )
    }

    /** One read-only configuration fact. */
    function ConfigRow(props) {
      return h(
        'li',
        { className: 'dsh-ntf-list-item' },
        h('span', null, props.label),
        h('span', { className: 'dsh-ntf-list-value' }, props.value),
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
      const [showTokenInput, setShowTokenInput] = React.useState(false)
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
        { className: 'dsh-ntf-page' },
        h('style', { 'data-plugin-css': 'dsh-notify' }, CSS),
        error === null
          ? null
          : h('div', { className: 'dsh-ntf-alert', 'data-tone': 'warn', role: 'alert' },
              h('div', { className: 'dsh-ntf-alert-body' }, t('loadFailed', { code: error }))),
        h(
          'div',
          { className: 'dsh-ntf-card' },
          h(
            'div',
            { className: 'dsh-ntf-card-head' },
            h('h2', { className: 'dsh-ntf-card-title' }, t('targetsHeading')),
            status === null ? null : h('span', { className: 'dsh-ntf-badge' }, t('targetsCount', { count: targets.length })),
          ),
          status === null
            ? h('p', { className: 'dsh-ntf-caption' }, t('loading'))
            : targets.length === 0
              ? h('p', { className: 'dsh-ntf-caption' }, t('targetsEmpty'))
              : h(
                  'ul',
                  { className: 'dsh-ntf-target-list' },
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
          { className: 'dsh-ntf-card' },
          h(
            'div',
            { className: 'dsh-ntf-card-head' },
            h('h2', { className: 'dsh-ntf-card-title' }, t('addHeading')),
          ),
          h(
            'div',
            { className: 'dsh-ntf-field' },
            h('label', { className: 'dsh-ntf-label' }, t('nameLabel')),
            h('input', {
              className: 'dsh-ntf-input',
              'data-mono': 'true',
              value: name,
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setName(event.target.value.toLowerCase()),
            }),
            h('p', { className: 'dsh-ntf-caption' }, t('nameHint')),
          ),
          h(
            'div',
            { className: 'dsh-ntf-field' },
            h('label', { className: 'dsh-ntf-label' }, t('tokenLabel')),
            h(
              'div',
              { className: 'dsh-ntf-input-wrap' },
              h('input', {
                className: 'dsh-ntf-input',
                'data-mono': 'true',
                type: showTokenInput ? 'text' : 'password',
                value: token,
                placeholder: t('tokenPlaceholder'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => setToken(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && token.trim() !== '' && name.trim() !== '' && busy === null) {
                    event.preventDefault()
                    void save()
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ntf-btn',
                  'data-size': 'sm',
                  onClick: () => setShowTokenInput((prev) => !prev),
                },
                showTokenInput ? t('hideToken') : t('showToken'),
              ),
            ),
            h('p', { className: 'dsh-ntf-caption' }, t('tokenHint')),
          ),
          h(
            'div',
            { className: 'dsh-ntf-row', style: { marginTop: '14px' } },
            h(Action, {
              label: t('save'),
              onClick: save,
              busy: busy === 'save',
              primary: true,
              disabled: token.trim() === '' || name.trim() === '',
            }),
          ),
          notice === null
            ? null
            : h('div', { className: 'dsh-ntf-alert', 'data-tone': notice.tone, style: { marginBottom: 0 } },
                h('div', { className: 'dsh-ntf-alert-body' }, notice.text)),
        ),
        config === null
          ? null
          : h(
              'div',
              { className: 'dsh-ntf-card' },
              h(
                'div',
                { className: 'dsh-ntf-card-head' },
                h('h2', { className: 'dsh-ntf-card-title' }, t('configHeading')),
              ),
              h(
                'ul',
                { className: 'dsh-ntf-list' },
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
              h('p', { className: 'dsh-ntf-caption', style: { marginTop: '10px' } }, t('configNote')),
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

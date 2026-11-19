/**
 * Browser half of the DeepXiv bundle: the configuration this bundle's page shows
 * in the Plugins panel — the token the research tools authenticate with and the
 * account's quota.
 *
 * This file is served verbatim as a classic script and is never bundled, so it
 * declares no imports, carries its own dictionaries, and self-registers under the
 * package name. It reaches its Host half over the Harness's own authenticated API
 * channel, which returns the stored token so this page can show it in the clear.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepxiv',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this section registers its dictionaries under. */
    const NS = 'settings.deepxiv'

    /**
     * Host route, document-relative so a Harness mounted under a sub-path still
     * reaches the route the Host registered at the server root.
     */
    const ROUTE = 'api/plugin-deepxiv'

    const en = {
      loading: 'Loading DeepXiv status…',
      tokenHeading: 'API Token',
      statusConfigured: 'Configured',
      statusUnset: 'Not configured',
      statusUnusable: 'Unusable',
      tokenStateSet: 'Token saved (added {when}).',
      tokenStateUnset: 'No token configured (limited to free test content).',
      tokenStateUnusable: 'Stored token is unusable: {reason}',
      tokenLabel: 'DeepXiv Token',
      tokenHint: 'Saved locally; replaces any existing token.',
      showToken: 'Show',
      hideToken: 'Hide',
      save: 'Save token',
      saved: 'Saved.',
      remove: 'Delete token',
      confirmRemove: 'Confirm delete',
      cancel: 'Cancel',
      removed: 'Token deleted.',
      verify: 'Verify & Check Quota',
      verifying: 'Verifying…',
      verifyRefused: 'Verification failed: {reason}',
      quotaHeading: 'Quota',
      quotaAccount: 'Account',
      quotaTier: 'Tier',
      quotaGeneral: 'General requests',
      quotaAgentic: 'Agentic calls',
      quotaUnknown: 'not reported',
      quotaUsedOf: '{used} / {limit} used',
      quotaUsed: '{used} used',
      quotaRemaining: '{remaining} remaining today',
      quotaNote: 'General and agentic quotas are tracked separately.',
      quotaRawHeading: 'Raw response',
      quotaRawNote: 'Full response:',
      copyRaw: 'Copy',
      copied: 'Copied',
      quotaWithheld: 'Response hidden because it contains the token.',
      configHeading: 'Reading Limits',
      configBaseUrl: 'Endpoint',
      configRequestTimeout: 'Request timeout',
      configToolTimeout: 'Tool timeout',
      configQueryLimit: 'Max query length',
      configSearchTopK: 'Results per search',
      configPreview: 'Preview length',
      configFull: 'Full-paper limit',
      configMs: '{count} ms',
      configChars: '{count} chars',
      configRange: 'default {fallback}, max {max}',
      configNote: 'Configured in cordis.patch.yml.',
      loadFailed: 'Failed to load plugin status: {code}',
        'reasons.record_missing': 'no record stored',
        'reasons.not_a_token': 'record is not a DeepXiv token',
        'reasons.unknown_channel': 'record belongs to another service',
        'reasons.no_token': 'record contains no token',
        'errors.unknown': 'unexpected error ({code})',
        'errors.unreachable': 'cannot reach Harness; make sure it is running',
        'errors.body_too_large': 'request body too large',
        'errors.invalid_json': 'invalid JSON request',
        'errors.invalid_body': 'invalid request format',
        'errors.unknown_action': 'unsupported action',
        'errors.method_not_allowed': 'POST method required',
        'errors.invalid_token': 'please enter a DeepXiv token',
        'errors.token_missing': 'no token configured',
        'errors.unusable_token': 'stored token is unreadable; please delete and re-add it',
        'errors.token_rejected': 'invalid or expired token',
        'errors.forbidden': 'token lacks permission for this tier',
        'errors.not_found': 'paper or query not found',
        'errors.section_not_found': 'section not found in this paper',
        'errors.invalid_request': 'invalid request parameters',
        'errors.unprocessable': 'request could not be processed',
        'errors.rate_limited': 'daily quota exhausted; resets tomorrow',
        'errors.upstream_unavailable': 'DeepXiv is temporarily unavailable; try again later',
        'errors.response_too_large': 'response exceeded size limit',
        'errors.invalid_response': 'unexpected response from DeepXiv',
        'errors.view_unsupported': 'unsupported view for this corpus',
        'errors.http_status': 'DeepXiv returned an error status',
        'errors.request_failed': 'cannot reach DeepXiv; check network and endpoint',
        'errors.timeout': 'DeepXiv request timed out',
        'errors.aborted': 'request cancelled',
    }

    const zh = {
      loading: '正在加载状态…',
      tokenHeading: 'API Token',
      statusConfigured: '已配置',
      statusUnset: '未配置',
      statusUnusable: '凭据异常',
      tokenStateSet: '已配置 token（添加于 {when}）。',
      tokenStateUnset: '尚未配置 token（未配置时仅支持免费测试内容）。',
      tokenStateUnusable: '凭据异常：{reason}',
      tokenLabel: 'DeepXiv Token',
      tokenHint: '保存至本地，新值将覆盖旧 token。',
      showToken: '显示',
      hideToken: '隐藏',
      save: '保存 token',
      saved: '已保存。',
      remove: '删除 token',
      confirmRemove: '确认删除',
      cancel: '取消',
      removed: '已删除 token。',
      verify: '验证并查询额度',
      verifying: '正在验证…',
      verifyRefused: '验证失败：{reason}',
      quotaHeading: '额度',
      quotaAccount: '账号',
      quotaTier: '级别',
      quotaGeneral: '普通请求',
      quotaAgentic: 'Agentic 调用',
      quotaUnknown: '未返回',
      quotaUsedOf: '已用 {used} / {limit}',
      quotaUsed: '已用 {used}',
      quotaRemaining: '今日剩余 {remaining}',
      quotaNote: '普通读写与 Agentic 调用使用独立额度池。',
      quotaRawHeading: '原始响应',
      quotaRawNote: '完整响应内容：',
      copyRaw: '复制',
      copied: '已复制',
      quotaWithheld: '响应包含 token，已隐藏展示。',
      configHeading: '阅读限制',
      configBaseUrl: '接口地址',
      configRequestTimeout: '单次请求超时',
      configToolTimeout: '工具整体超时',
      configQueryLimit: '检索词上限',
      configSearchTopK: '单次检索条数',
      configPreview: '预览长度',
      configFull: '全文长度上限',
      configMs: '{count} 毫秒',
      configChars: '{count} 字符',
      configRange: '默认 {fallback}，上限 {max}',
      configNote: '以上设置来自插件配置，可在 cordis.patch.yml 中修改。',
      loadFailed: '加载插件状态失败：{code}',
        'reasons.record_missing': '未找到存储记录',
        'reasons.not_a_token': '记录不是有效的 DeepXiv token',
        'reasons.unknown_channel': '记录属于其他服务',
        'reasons.no_token': '记录中缺少 token',
        'errors.unknown': '未知错误（{code}）',
        'errors.unreachable': '无法连接 Harness，请确认服务正在运行',
        'errors.body_too_large': '请求体过大',
        'errors.invalid_json': '请求 JSON 格式无效',
        'errors.invalid_body': '请求格式无效',
        'errors.unknown_action': '不支持的操作',
        'errors.method_not_allowed': '该操作需使用 POST 请求',
        'errors.invalid_token': '请输入 DeepXiv token',
        'errors.token_missing': '尚未配置 token',
        'errors.unusable_token': '已存 token 无法读取，请删除后重新添加',
        'errors.token_rejected': 'token 无效、已过期或不属于当前账号',
        'errors.forbidden': '当前 token 无权访问该级别服务',
        'errors.not_found': '未找到对应的论文或检索结果',
        'errors.section_not_found': '论文中不存在该标题的章节',
        'errors.invalid_request': '请求参数无效',
        'errors.unprocessable': '请求无法处理',
        'errors.rate_limited': '今日额度已耗尽，将于明日重置',
        'errors.upstream_unavailable': 'DeepXiv 服务暂不可用，请稍后再试',
        'errors.response_too_large': '返回内容超出插件读取上限',
        'errors.invalid_response': 'DeepXiv 返回格式异常',
        'errors.view_unsupported': '该语料库不支持此阅读视图',
        'errors.http_status': 'DeepXiv 返回错误状态码',
        'errors.request_failed': '无法连接 DeepXiv，请检查网络或接口地址',
        'errors.timeout': 'DeepXiv 请求超时',
        'errors.aborted': '请求已取消',
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
@keyframes dsh-dxv-spin { to { transform: rotate(360deg); } }
.dsh-dxv-page { padding: 4px 2px 32px; color: var(--dsw-alias-label-primary); max-width: 740px; }
.dsh-dxv-card {
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 14px;
}
.dsh-dxv-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin-bottom: 10px;
}
.dsh-dxv-card-title { font-size: 14px; font-weight: 600; margin: 0; }
.dsh-dxv-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px; border-radius: 999px; font-size: 11.5px; line-height: 17px; font-weight: 500;
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-secondary);
}
.dsh-dxv-badge[data-tone="ok"] {
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l4);
  color: var(--dsw-alias-state-success-primary);
}
.dsh-dxv-badge[data-tone="warn"] {
  background: var(--dsw-alias-state-warn-tertiary, rgba(184,121,26,.12));
  color: var(--dsw-alias-state-warn-label);
}
.dsh-dxv-dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; flex: none; }
.dsh-dxv-line { font-size: 13px; line-height: 1.6; margin: 0 0 6px; }
.dsh-dxv-caption { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-caption); margin: 4px 0 0; }
.dsh-dxv-alert {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 9px 12px; border-radius: 8px; margin-top: 10px; margin-bottom: 10px;
  font-size: 12.5px; line-height: 1.55;
  border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-dxv-alert[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dsh-dxv-alert[data-tone="warn"] {
  border-color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary, rgba(184,121,26,.1));
  color: var(--dsw-alias-state-warn-label);
}
.dsh-dxv-field { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
.dsh-dxv-label { font-size: 12.5px; font-weight: 500; }
.dsh-dxv-input-wrap { display: flex; align-items: center; gap: 6px; }
.dsh-dxv-input {
  flex: 1 1 auto; min-width: 0; width: 100%; box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
  padding: 7px 11px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  transition: border-color 120ms ease;
}
.dsh-dxv-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #2f6feb); }
.dsh-dxv-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.dsh-dxv-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font-size: 12.5px; font-weight: 500; padding: 6px 13px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  cursor: pointer; transition: background 120ms ease, opacity 120ms ease;
}
.dsh-dxv-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dxv-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6feb); outline-offset: 1px; }
.dsh-dxv-btn[data-variant="primary"] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsh-dxv-btn[data-variant="primary"]:hover:not(:disabled) { opacity: 0.9; }
.dsh-dxv-btn[data-variant="danger"] {
  border-color: var(--dsw-alias-state-error-primary);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-dxv-btn[data-variant="danger"]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,.12));
}
.dsh-dxv-btn[data-size="sm"] { padding: 4px 10px; font-size: 12px; border-radius: 7px; }
.dsh-dxv-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-dxv-spinner {
  width: 12px; height: 12px; border-radius: 999px;
  border: 1.8px solid currentColor; border-top-color: transparent;
  animation: dsh-dxv-spin 0.7s linear infinite; flex: none;
}
.dsh-dxv-list { margin: 4px 0 0; padding: 0; list-style: none; }
.dsh-dxv-list-item {
  display: flex; justify-content: space-between; align-items: baseline; gap: 14px; flex-wrap: wrap;
  font-size: 13px; padding: 7px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l4));
}
.dsh-dxv-list-item:first-child { border-top: none; padding-top: 2px; }
.dsh-dxv-list-value {
  font-size: 12px; color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right;
}
.dsh-dxv-meter-list { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.dsh-dxv-meter {
  padding: 10px 12px; border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l4);
}
.dsh-dxv-meter-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.dsh-dxv-meter-label { font-weight: 500; }
.dsh-dxv-meter-stat { font-size: 12px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dsh-dxv-track {
  height: 5px; margin-top: 7px; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.18));
}
.dsh-dxv-fill { height: 100%; border-radius: 999px; transition: width 280ms ease; }
.dsh-dxv-details { margin-top: 10px; }
.dsh-dxv-summary {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  font-size: 12px; color: var(--dsw-alias-label-secondary); user-select: none;
}
.dsh-dxv-raw-head { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 4px; }
.dsh-dxv-raw {
  margin: 0; padding: 10px 12px; max-height: 220px; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
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

    /** One button that disables itself and shows a spinner while its action runs. */
    function Action(props) {
      const { label, onClick, busy, primary, danger, size, disabled } = props
      const inactive = busy === true || disabled === true
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-dxv-btn',
          'data-variant': danger ? 'danger' : primary ? 'primary' : undefined,
          'data-size': size,
          disabled: inactive,
          onClick,
        },
        busy === true ? h('span', { className: 'dsh-dxv-spinner', 'aria-hidden': true }) : null,
        label,
      )
    }

    /** One read-only configuration fact. */
    function ConfigRow(props) {
      return h(
        'li',
        { className: 'dsh-dxv-list-item' },
        h('span', null, props.label),
        h('span', { className: 'dsh-dxv-list-value' }, props.value),
      )
    }

    /**
     * Describe one quota pool in words.
     * @param {function} t - Bound locale function.
     * @param {object|null} pool - The pool the Host normalized, if any.
     * @returns {string} the text.
     */
    function quotaText(t, pool) {
      if (pool === null || pool === undefined) return t('quotaUnknown')
      const parts = []
      if (pool.limit !== null && pool.limit !== undefined) {
        parts.push(t('quotaUsedOf', { used: pool.used ?? 0, limit: pool.limit }))
      } else if (pool.used !== null && pool.used !== undefined) {
        parts.push(t('quotaUsed', { used: pool.used }))
      }
      if (pool.remaining !== null && pool.remaining !== undefined) {
        parts.push(t('quotaRemaining', { remaining: pool.remaining }))
      }
      return parts.length === 0 ? t('quotaUnknown') : parts.join(' · ')
    }

    /** Visual meter for a single DeepXiv quota pool. */
    function QuotaMeter(props) {
      const { t, label, pool } = props
      const limit = pool?.limit
      const remaining = pool?.remaining
      const used = pool?.used
      let pct = null
      if (typeof limit === 'number' && limit > 0) {
        const left = typeof remaining === 'number' ? remaining : Math.max(0, limit - (used ?? 0))
        pct = Math.max(0, Math.min(100, (left / limit) * 100))
      }
      const color =
        pct === null
          ? 'var(--dsw-alias-state-idle-primary, #9aa0a6)'
          : pct < 20
            ? 'var(--dsw-alias-state-error-primary, #c0392b)'
            : pct < 50
              ? 'var(--dsw-alias-state-warn-primary, #b8791a)'
              : 'var(--dsw-alias-state-success-primary, #1f8f5f)'

      return h(
        'div',
        { className: 'dsh-dxv-meter' },
        h(
          'div',
          { className: 'dsh-dxv-meter-head' },
          h('span', { className: 'dsh-dxv-meter-label' }, label),
          h('span', { className: 'dsh-dxv-meter-stat' }, quotaText(t, pool)),
        ),
        pct === null
          ? null
          : h(
              'div',
              { className: 'dsh-dxv-track', 'aria-hidden': true },
              h('div', { className: 'dsh-dxv-fill', style: { width: `${pct}%`, background: color } }),
            ),
      )
    }

    /**
     * The settings section.
     * @param {object} props - Slot props, carrying the locale `t` seat.
     * @returns {object} the rendered section.
     */
    function DeepXivSettings(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [showToken, setShowToken] = React.useState(false)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [copiedRaw, setCopiedRaw] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [quota, setQuota] = React.useState(null)

      // The field mirrors the stored token until the user edits it: `null` means
      // "whatever the store holds", and any string is what the user typed.
      const shown = draft ?? status?.token ?? ''

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
      // recovers on its own instead of claiming no token is stored.
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
          setStatus(await call('token.save', { token: shown }))
          setDraft(null)
          setQuota(null)
          setConfirmDelete(false)
          setNotice({ tone: 'ok', text: t('saved') })
        })

      const remove = () =>
        run('remove', async () => {
          setStatus(await call('token.delete'))
          setDraft(null)
          setQuota(null)
          setConfirmDelete(false)
          setNotice({ tone: 'ok', text: t('removed') })
        })

      const verify = () =>
        run('verify', async () => {
          const value = await call('token.verify')
          setQuota(value)
          setNotice(null)
        })

      const copyRaw = async () => {
        if (!quota?.raw) return
        try {
          await navigator.clipboard.writeText(quota.raw)
          setCopiedRaw(true)
          setTimeout(() => setCopiedRaw(false), 1800)
        } catch {
          setCopiedRaw(false)
        }
      }

      const configured = status?.configured === true
      // A record that exists but cannot be read is exactly the state the copy
      // tells the user to fix, so delete stays available for it.
      const recordExists =
        status !== null && (configured || (status.reason !== undefined && status.reason !== 'record_missing'))
      const unusable = status !== null && !configured && status.reason !== undefined && status.reason !== 'record_missing'
      const config = status?.config ?? null
      const state =
        status === null
          ? t('loading')
          : configured
            ? t('tokenStateSet', { when: when(status.addedAt) })
            : status.reason === undefined || status.reason === 'record_missing'
              ? t('tokenStateUnset')
              : t('tokenStateUnusable', { reason: reasonText(t, status.reason) })

      // The Plugins panel draws this page's title, version, and description from
      // the bundle's locale metadata, so this renders its cards only.
      return h(
        'div',
        { className: 'dsh-dxv-page' },
        h('style', { 'data-plugin-css': 'dsh-deepxiv' }, CSS),
        error === null
          ? null
          : h('div', { className: 'dsh-dxv-alert', 'data-tone': 'warn', role: 'alert' }, t('loadFailed', { code: error })),
        h(
          'div',
          { className: 'dsh-dxv-card' },
          h(
            'div',
            { className: 'dsh-dxv-card-head' },
            h('h2', { className: 'dsh-dxv-card-title' }, t('tokenHeading')),
            status === null
              ? null
              : h(
                  'span',
                  {
                    className: 'dsh-dxv-badge',
                    'data-tone': configured ? 'ok' : unusable ? 'warn' : 'neutral',
                  },
                  h('span', { className: 'dsh-dxv-dot', 'aria-hidden': true }),
                  configured ? t('statusConfigured') : unusable ? t('statusUnusable') : t('statusUnset'),
                ),
          ),
          h('p', { className: configured ? 'dsh-dxv-line' : 'dsh-dxv-caption' }, state),
          h(
            'div',
            { className: 'dsh-dxv-field' },
            h('label', { className: 'dsh-dxv-label' }, t('tokenLabel')),
            h(
              'div',
              { className: 'dsh-dxv-input-wrap' },
              h('input', {
                className: 'dsh-dxv-input',
                type: showToken ? 'text' : 'password',
                value: shown,
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && draft !== null && shown.trim() !== '' && busy === null) {
                    event.preventDefault()
                    void save()
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-dxv-btn',
                  'data-size': 'sm',
                  onClick: () => setShowToken((prev) => !prev),
                },
                showToken ? t('hideToken') : t('showToken'),
              ),
            ),
            h('p', { className: 'dsh-dxv-caption' }, t('tokenHint')),
          ),
          h(
            'div',
            { className: 'dsh-dxv-row' },
            h(Action, {
              label: t('save'),
              onClick: save,
              busy: busy === 'save',
              primary: true,
              // Nothing to write until the user edits the field: an untouched
              // field already mirrors the store, and an emptied one is refused.
              disabled: draft === null || shown.trim() === '',
            }),
            h(Action, {
              label: busy === 'verify' ? t('verifying') : t('verify'),
              onClick: verify,
              busy: busy === 'verify',
              disabled: !configured,
            }),
            confirmDelete
              ? h(
                  React.Fragment,
                  null,
                  h(Action, { label: t('confirmRemove'), danger: true, onClick: remove, busy: busy === 'remove' }),
                  h(Action, { label: t('cancel'), onClick: () => setConfirmDelete(false), disabled: busy === 'remove' }),
                )
              : h(Action, {
                  label: t('remove'),
                  onClick: () => setConfirmDelete(true),
                  disabled: !recordExists,
                }),
          ),
          notice === null
            ? null
            : h('div', { className: 'dsh-dxv-alert', 'data-tone': notice.tone, style: { marginBottom: 0 } }, notice.text),
        ),
        quota === null
          ? null
          : h(
              'div',
              { className: 'dsh-dxv-card' },
              h(
                'div',
                { className: 'dsh-dxv-card-head' },
                h('h2', { className: 'dsh-dxv-card-title' }, t('quotaHeading')),
                quota.ok === true && quota.tier
                  ? h('span', { className: 'dsh-dxv-badge' }, quota.tier)
                  : null,
              ),
              quota.ok !== true
                ? h(
                    'div',
                    { className: 'dsh-dxv-alert', 'data-tone': 'warn', role: 'alert', style: { marginBottom: 0 } },
                    t('verifyRefused', { reason: errorText(t, quota.error?.code ?? 'unknown') }),
                  )
                : h(
                    'div',
                    null,
                    h(
                      'ul',
                      { className: 'dsh-dxv-list' },
                      h(ConfigRow, { label: t('quotaAccount'), value: quota.account ?? t('quotaUnknown') }),
                      h(ConfigRow, { label: t('quotaTier'), value: quota.tier ?? t('quotaUnknown') }),
                    ),
                    h(
                      'div',
                      { className: 'dsh-dxv-meter-list' },
                      h(QuotaMeter, { t, label: t('quotaGeneral'), pool: quota.general }),
                      h(QuotaMeter, { t, label: t('quotaAgentic'), pool: quota.agentic }),
                    ),
                    h('p', { className: 'dsh-dxv-caption', style: { marginTop: '10px' } }, t('quotaNote')),
                    // A body that echoes the credential back is never rendered;
                    // the Host withholds it and says so.
                    quota.raw_withheld === true
                      ? h('div', { className: 'dsh-dxv-alert', 'data-tone': 'warn', style: { marginBottom: 0 } }, t('quotaWithheld'))
                      : quota.raw === null || quota.raw === undefined
                        ? null
                        : h(
                            'details',
                            { className: 'dsh-dxv-details' },
                            h('summary', { className: 'dsh-dxv-summary' }, t('quotaRawHeading')),
                            h(
                              'div',
                              { className: 'dsh-dxv-raw-head' },
                              h('span', { className: 'dsh-dxv-caption', style: { margin: 0 } }, t('quotaRawNote')),
                              h(
                                'button',
                                { type: 'button', className: 'dsh-dxv-btn', 'data-size': 'sm', onClick: () => void copyRaw() },
                                copiedRaw ? t('copied') : t('copyRaw'),
                              ),
                            ),
                            h('pre', { className: 'dsh-dxv-raw' }, quota.raw),
                          ),
                  ),
            ),
        config === null
          ? null
          : h(
              'div',
              { className: 'dsh-dxv-card' },
              h(
                'div',
                { className: 'dsh-dxv-card-head' },
                h('h2', { className: 'dsh-dxv-card-title' }, t('configHeading')),
              ),
              h(
                'ul',
                { className: 'dsh-dxv-list' },
                h(ConfigRow, { label: t('configBaseUrl'), value: config.baseUrl }),
                h(ConfigRow, {
                  label: t('configRequestTimeout'),
                  value: t('configMs', { count: config.requestTimeoutMs }),
                }),
                h(ConfigRow, {
                  label: t('configToolTimeout'),
                  value: t('configMs', { count: config.toolTimeoutMs }),
                }),
                h(ConfigRow, {
                  label: t('configQueryLimit'),
                  value: t('configChars', { count: config.queryMaxChars }),
                }),
                h(ConfigRow, {
                  label: t('configSearchTopK'),
                  value: t('configRange', { fallback: config.searchDefaultTopK, max: config.searchMaxTopK }),
                }),
                h(ConfigRow, {
                  label: t('configPreview'),
                  value: t('configRange', { fallback: config.previewDefaultChars, max: config.previewMaxChars }),
                }),
                h(ConfigRow, {
                  label: t('configFull'),
                  value: t('configChars', { count: config.fullMaxChars }),
                }),
              ),
              h('p', { className: 'dsh-dxv-caption', style: { marginTop: '10px' } }, t('configNote')),
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
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-deepxiv: dictionaries')
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: 'dsh-deepxiv',
                  locale: NS,
                },
                DeepXivSettings,
              ),
            ),
          'dsh-deepxiv: bundle configuration',
        )
      },
    }
  },
})

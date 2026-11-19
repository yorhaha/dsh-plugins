/**
 * Browser half of the Zhihu bundle: the page this bundle shows in the Plugins
 * panel, where the cookie is connected, verified, or deleted, and where the
 * current pacing state is visible.
 *
 * This file is served verbatim as a classic script and is never bundled, so it
 * declares no imports, carries its own dictionaries, and self-registers under
 * the package name. It reaches its Host half over the Harness's own
 * authenticated API channel. The stored cookie itself never crosses that
 * channel: the page only ever learns whether one is stored, when it was saved,
 * and which account the last verification proved.
 */
window.__ModuleLoader__.load({
  id: 'dsh-zhihu',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this section registers its dictionaries under. */
    const NS = 'settings.zhihu'

    /**
     * Host route, document-relative so a Harness mounted under a sub-path still
     * reaches the route the Host registered at the server root.
     */
    const ROUTE = 'api/plugin-zhihu'

    const en = {
      loading: 'Loading Zhihu status…',
      connectHeading: 'Connection',
      stateConnected: 'Cookie saved (added {when}).',
      stateDisconnected: 'Not connected. Copy the Cookie header from a signed-in zhihu.com session and paste it below.',
      stateUnusable: 'Stored cookie is unusable: {reason}',
      accountHeading: 'Account',
      accountUnknown: 'Account not yet verified. Click “Verify stored cookie” to check.',
      accountToken: 'Profile',
      accountVerified: 'Verified {when}.',
      cookieLabel: 'Zhihu Cookie',
      cookieHint:
        'Paste the Cookie header (requires z_c0 and d_c0); verified before saving.',
      cookiePlaceholder: 'z_c0=...; d_c0=...; _xsrf=...',
      saveConnect: 'Save & Verify',
      saving: 'Verifying…',
      verify: 'Verify stored cookie',
      verifying: 'Verifying…',
      disconnect: 'Delete cookie',
      disconnecting: 'Deleting…',
      noticeSaved: 'Saved and verified: {name}.',
      noticeVerified: 'Verified: {name}.',
      noticeDisconnected: 'Cookie deleted.',
      errorRetryAt: 'Rate limited until {when}.',
      pacingHeading: 'Request Pacing',
      pacingInterval: 'Minimum interval',
      pacingBudget: 'Hourly request budget',
      pacingUsed: 'Used this hour',
      pacingUsedOf: '{used} / {limit}',
      pacingReset: 'Budget resets',
      pacingPaused: 'Paused until',
      pacingPausedNone: 'active',
      pacingCache: 'Response cache',
      pacingCacheValue: '{entries} entries ({seconds}s TTL)',
      pacingTotal: 'Session requests',
      pacingLast: 'Last request',
      pacingNote:
        'Requests are rate-limited, budgeted, and cached; automatically pauses on risk control.',
      limitsHeading: 'Reading Limits',
      limitsContent: 'Max characters per item',
      limitsChars: '{count} chars',
      limitsList: 'List default / max',
      limitsListValue: '{fallback} / {max} items',
      limitsComments: 'Comments default / max',
      limitsTimeout: 'Request / tool timeout',
      limitsTimeoutValue: '{request} / {tool} ms',
      limitsNote: 'Configured in cordis.patch.yml.',
      seconds: '{count} s',
      minutes: '{count} min',
      none: '—',
      'errors.unknown': 'Action failed ({code}).',
      'errors.unreachable': 'Cannot reach Harness; make sure it is running.',
      'errors.body_too_large': 'Request body too large.',
      'errors.invalid_json': 'Invalid JSON request.',
      'errors.invalid_body': 'Invalid request format.',
      'errors.unknown_action': 'Unsupported action.',
      'errors.cookie_missing': 'Please paste a Zhihu cookie first.',
      'errors.cookie_invalid': 'Incomplete cookie: requires z_c0 and d_c0 with no line breaks.',
      'errors.not_connected': 'No Zhihu cookie configured.',
      'errors.not_authorized': 'Cookie expired or signed out. Copy a fresh one from your browser.',
      'errors.credential_invalid': 'Stored credential is unreadable. Delete it and re-add your cookie.',
      'errors.risk_control': 'Verification required; paused to protect your account.',
      'errors.rate_limited': 'Rate limited (429); paused temporarily.',
      'errors.signature_required': 'Endpoint unsupported; use question, answer, article, or list tools instead.',
      'errors.request_budget_exhausted': 'Hourly request budget exhausted. Wait for the reset window.',
      'errors.temporarily_blocked': 'Plugin is paused to protect your account from risk control.',
      'errors.forbidden': 'Request refused (403), typically due to risk control or missing permission.',
      'errors.cookie_stale': 'Zhihu returned a zse-ck challenge. Your cookie is stale or bound to another browser/network; paste a fresh one.',
      'errors.not_found': 'Resource not found (may be deleted or private).',
      'errors.page_not_recognized': 'Could not parse Zhihu page data; the layout may have changed.',
      'errors.invalid_response': 'Unexpected response from Zhihu.',
      'errors.upstream_error': 'Zhihu returned an API error.',
      'errors.upstream_unavailable': 'Zhihu is temporarily unavailable; try again later.',
      'errors.http_status': 'Zhihu returned an error HTTP status.',
      'errors.request_failed': 'Cannot reach Zhihu; check your network.',
      'errors.timeout': 'Zhihu request timed out.',
      'errors.aborted': 'Request cancelled.',
    }

    const zh = {
      loading: '正在加载状态…',
      connectHeading: '账号连接',
      stateConnected: '已保存 Cookie（添加于 {when}）。',
      stateDisconnected: '尚未配置 Cookie。请在浏览器登录知乎后，复制完整的 Cookie 请求头粘贴至下方。',
      stateUnusable: '已存 Cookie 异常：{reason}',
      accountHeading: '账号信息',
      accountUnknown: '尚未验证账号，可点击「验证已保存的 Cookie」检查。',
      accountToken: '个人主页',
      accountVerified: '验证于 {when}。',
      cookieLabel: '知乎 Cookie',
      cookieHint:
        '粘贴完整 Cookie 请求头（需包含 z_c0 与 d_c0），验证后保存至本地。',
      cookiePlaceholder: 'z_c0=...; d_c0=...; _xsrf=...',
      saveConnect: '保存并验证',
      saving: '正在验证…',
      verify: '验证已保存的 Cookie',
      verifying: '正在验证…',
      disconnect: '删除 Cookie',
      disconnecting: '正在删除…',
      noticeSaved: '验证成功并已保存：{name}。',
      noticeVerified: '验证通过：{name}。',
      noticeDisconnected: '已删除 Cookie。',
      errorRetryAt: '冷却中，请在 {when} 后重试。',
      pacingHeading: '请求节奏',
      pacingInterval: '最小请求间隔',
      pacingBudget: '每小时请求上限',
      pacingUsed: '本小时已用',
      pacingUsedOf: '{used} / {limit}',
      pacingReset: '额度重置时间',
      pacingPaused: '暂停至',
      pacingPausedNone: '未暂停',
      pacingCache: '响应缓存',
      pacingCacheValue: '{entries} 条 · 有效期 {seconds} 秒',
      pacingTotal: '本进程请求总数',
      pacingLast: '最近请求',
      pacingNote:
        '请求已启用串行限速、小时配额与结果缓存，触发风控或限流时自动暂停。',
      limitsHeading: '读取限制',
      limitsContent: '单条正文上限',
      limitsChars: '{count} 字符',
      limitsList: '列表默认 / 上限',
      limitsListValue: '{fallback} / {max} 条',
      limitsComments: '评论默认 / 上限',
      limitsTimeout: '请求 / 工具超时',
      limitsTimeoutValue: '{request} / {tool} 毫秒',
      limitsNote: '配置项来自 cordis.patch.yml。',
      seconds: '{count} 秒',
      minutes: '{count} 分钟',
      none: '—',
      'errors.unknown': '操作失败（{code}）。',
      'errors.unreachable': '无法连接 Harness，请确认服务正在运行。',
      'errors.body_too_large': '请求体过大。',
      'errors.invalid_json': '请求 JSON 格式无效。',
      'errors.invalid_body': '请求格式无效。',
      'errors.unknown_action': '不支持的操作。',
      'errors.cookie_missing': '请先粘贴知乎 Cookie。',
      'errors.cookie_invalid': 'Cookie 格式不完整：须包含 z_c0 与 d_c0，且不能换行。',
      'errors.not_connected': '尚未保存知乎 Cookie。',
      'errors.not_authorized': 'Cookie 已过期或失效，请从浏览器重新复制。',
      'errors.credential_invalid': '已存凭据无法读取，请删除后重新添加。',
      'errors.risk_control': '触发知乎安全验证或验证码，已自动暂停，请勿立即重试。',
      'errors.rate_limited': '触发 429 限流，已暂时暂停。',
      'errors.signature_required': '该接口暂不支持，请改用问题、回答、文章或列表工具。',
      'errors.request_budget_exhausted': '本小时请求额度已用尽，请等待重置后再试。',
      'errors.temporarily_blocked': '当前处于风控冷却期，请稍后再试。',
      'errors.forbidden': '请求被拒（403），通常为风控或权限不足。',
      'errors.cookie_stale': '知乎返回了 zse-ck 验证页，Cookie 可能已过期或绑定其他浏览器/网络，请重新复制并保存。',
      'errors.not_found': '未找到该内容，可能已被删除或设为私密。',
      'errors.page_not_recognized': '无法解析知乎页面内嵌数据，可能是页面结构已更新。',
      'errors.invalid_response': '知乎返回格式异常。',
      'errors.upstream_error': '知乎接口返回错误。',
      'errors.upstream_unavailable': '知乎服务暂不可用，请稍后再试。',
      'errors.http_status': '知乎返回错误状态码。',
      'errors.request_failed': '无法连接知乎，请检查网络。',
      'errors.timeout': '知乎请求超时。',
      'errors.aborted': '请求已取消。',
    }

    /** Failure codes the dictionaries carry copy for. */
    const KNOWN_ERRORS = new Set(
      Object.keys(en).filter((key) => key.startsWith('errors.')).map((key) => key.slice('errors.'.length)),
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

    const styles = {
      page: { padding: '4px 2px 32px', color: 'var(--dsw-alias-label-primary)', maxWidth: '760px' },
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
      fieldLabel: { display: 'block', fontSize: '13px', margin: '12px 0 6px' },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '74px',
        resize: 'vertical',
        fontSize: '12px',
        lineHeight: 1.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '8px 10px',
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
        throw Object.assign(new Error('unreachable'), { code: 'unreachable' })
      }
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload.ok !== true) {
        const code = payload?.error?.code ?? `http_${response.status}`
        throw Object.assign(new Error(payload?.error?.message ?? code), {
          code,
          retryAt: payload?.error?.retry_at,
        })
      }
      return payload.value
    }

    /** Two digits, for the parts of a date and a clock. */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /**
     * Render one instant as `YYYY-MM-DD HH:MM`.
     *
     * The clock is always 24-hour and the digits never depend on the machine's
     * regional settings, so an `en-US` machine sees no AM/PM and no month name.
     * @param {string} iso - the instant.
     * @returns {string} the text, or the raw value when it does not parse.
     */
    function when(iso) {
      if (typeof iso !== 'string') return ''
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return iso
      return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
    }

    /**
     * Describe a duration in the page's language.
     * @param {function} t - Bound locale function.
     * @param {number} ms - the duration.
     * @returns {string} the text.
     */
    function durationText(t, ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return t('none')
      return ms >= 60_000 ? t('minutes', { count: Math.round(ms / 60_000) }) : t('seconds', { count: Math.round(ms / 1_000) })
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
     * The account name, falling back to the URL slug.
     * @param {object|null} account - the last verified account.
     * @returns {string} the text.
     */
    function accountName(account) {
      if (account === null || account === undefined) return ''
      return account.name !== '' ? account.name : (account.url_token ?? '')
    }

    /**
     * The settings section.
     * @param {object} props - Slot props, carrying the locale `t` seat.
     * @returns {object} the rendered section.
     */
    function ZhihuSettings(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          setStatus(await call('status'))
          setFailure(null)
        } catch (error) {
          setFailure(error)
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      // Retry until the first read lands: a page left open across a Harness
      // restart recovers on its own instead of claiming no cookie is stored.
      const loaded = status !== null
      React.useEffect(() => {
        if (loaded) return undefined
        const timer = setInterval(() => {
          void refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [loaded, refresh])

      /**
       * Run one Host action, then show its notice or failure.
       * @param {string} action - Action name.
       * @param {object} [body] - Extra request fields.
       * @param {function} done - Builds the notice from the action's value.
       */
      async function run(action, body, done) {
        setBusy(action)
        setFailure(null)
        setNotice(null)
        try {
          const value = await call(action, body)
          setStatus(value.status ?? (await call('status')))
          setNotice(done(value))
        } catch (error) {
          setFailure(error)
        } finally {
          setBusy(null)
        }
      }

      if (status === null) {
        return h(
          'div',
          { style: styles.page },
          h('p', { style: styles.caption }, t('loading')),
          failure === null ? null : h('p', { style: styles.warn }, errorText(t, failure.code)),
        )
      }

      const account = status.account
      const stats = status.stats
      const config = status.config
      return h(
        'div',
        { style: styles.page },

        // Connection
        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('connectHeading')),
          h(
            'p',
            { style: status.connected ? styles.line : styles.warn },
            status.connected
              ? t('stateConnected', { when: when(status.saved_at) || t('none') })
              : t('stateDisconnected'),
          ),
          status.cookie_error === null || status.cookie_error === undefined
            ? null
            : h('p', { style: styles.warn }, t('stateUnusable', { reason: status.cookie_error })),
          h(
            'p',
            { style: styles.line },
            account === null || account === undefined
              ? t('accountUnknown')
              : `${t('accountHeading')}: ${accountName(account)}${account.headline === '' || account.headline === undefined ? '' : ` · ${account.headline}`}${account.url_token === '' || account.url_token === undefined ? '' : ` · ${account.url_token}`}`,
          ),
          account === null || account === undefined || status.verified_at === null
            ? null
            : h('p', { style: styles.caption }, t('accountVerified', { when: when(status.verified_at) })),
          h('label', { style: styles.fieldLabel }, t('cookieLabel')),
          h('textarea', {
            style: styles.textarea,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: t('cookiePlaceholder'),
            value: draft,
            onChange: (event) => setDraft(event.target.value),
          }),
          h('p', { style: styles.caption }, t('cookieHint')),
          h(
            'div',
            { style: styles.row },
            h(Action, {
              label: busy === 'connect' ? t('saving') : t('saveConnect'),
              busy: busy === 'connect',
              disabled: busy !== null,
              primary: true,
              onClick: () => {
                if (draft.trim() === '') {
                  setFailure(Object.assign(new Error('cookie_missing'), { code: 'cookie_missing' }))
                  return
                }
                void run('connect', { cookie: draft }, (value) => {
                  setDraft('')
                  return t('noticeSaved', { name: accountName(value.account) })
                })
              },
            }),
            h(Action, {
              label: busy === 'verify' ? t('verifying') : t('verify'),
              busy: busy === 'verify',
              disabled: busy !== null || !status.connected,
              onClick: () =>
                void run('verify', undefined, (value) => t('noticeVerified', { name: accountName(value.account) })),
            }),
            h(Action, {
              label: busy === 'disconnect' ? t('disconnecting') : t('disconnect'),
              busy: busy === 'disconnect',
              disabled: busy !== null || !status.connected,
              onClick: () => void run('disconnect', undefined, () => t('noticeDisconnected')),
            }),
          ),
          notice === null ? null : h('p', { style: styles.ok }, notice),
          failure === null
            ? null
            : h(
                'div',
                null,
                h('p', { style: styles.warn }, errorText(t, failure.code)),
                failure.retryAt === undefined || failure.retryAt === null
                  ? null
                  : h('p', { style: styles.caption }, t('errorRetryAt', { when: when(failure.retryAt) })),
              ),
        ),

        // Pacing
        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('pacingHeading')),
          h(
            'ul',
            { style: styles.list },
            h(ConfigRow, { label: t('pacingInterval'), value: durationText(t, config.minIntervalMs) }),
            h(ConfigRow, {
              label: t('pacingUsed'),
              value: t('pacingUsedOf', {
                used: stats.requests_last_hour,
                limit: stats.hourly_budget,
              }),
            }),
            h(ConfigRow, {
              label: t('pacingReset'),
              value: stats.budget_reset_at === null ? t('none') : when(stats.budget_reset_at),
            }),
            h(ConfigRow, {
              label: t('pacingPaused'),
              value: stats.paused_until === null ? t('pacingPausedNone') : when(stats.paused_until),
            }),
            h(ConfigRow, {
              label: t('pacingCache'),
              value: t('pacingCacheValue', {
                entries: stats.cache_entries,
                seconds: Math.round(config.cacheTtlMs / 1000),
              }),
            }),
            h(ConfigRow, { label: t('pacingTotal'), value: String(stats.total_requests) }),
            h(ConfigRow, {
              label: t('pacingLast'),
              value: stats.last_request_at === null ? t('none') : when(stats.last_request_at),
            }),
          ),
          h('p', { style: styles.caption }, t('pacingNote')),
        ),

        // Limits
        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('limitsHeading')),
          h(
            'ul',
            { style: styles.list },
            h(ConfigRow, { label: t('limitsContent'), value: t('limitsChars', { count: config.contentChars }) }),
            h(ConfigRow, {
              label: t('limitsList'),
              value: t('limitsListValue', { fallback: config.listDefaultLimit, max: config.listMaxLimit }),
            }),
            h(ConfigRow, {
              label: t('limitsComments'),
              value: t('limitsListValue', {
                fallback: config.commentsDefaultLimit,
                max: config.commentsMaxLimit,
              }),
            }),
            h(ConfigRow, {
              label: t('limitsTimeout'),
              value: t('limitsTimeoutValue', {
                request: config.requestTimeoutMs,
                tool: config.toolTimeoutMs,
              }),
            }),
          ),
          h('p', { style: styles.caption }, t('limitsNote')),
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
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-zhihu: dictionaries')
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: 'dsh-zhihu',
                  locale: NS,
                },
                ZhihuSettings,
              ),
            ),
          'dsh-zhihu: bundle configuration',
        )
      },
    }
  },
})

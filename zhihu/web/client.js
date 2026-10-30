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
      loading: 'Reading the Zhihu state…',
      connectHeading: 'Connection',
      stateConnected: 'A cookie is saved, added {when}.',
      stateDisconnected: 'No cookie yet. Copy the whole Cookie request header from a signed-in zhihu.com page and paste it below.',
      stateUnusable: 'The stored cookie is unusable — {reason}',
      accountHeading: 'Account',
      accountUnknown: 'The account has not been verified yet. Use “Verify stored cookie” to read it once.',
      accountToken: 'Profile',
      accountVerified: 'Verified {when}.',
      cookieLabel: 'Zhihu cookie',
      cookieHint:
        'Pasted as a Cookie header, with at least z_c0 and d_c0. It is verified once before it is saved to the local credential store; the saved value is never shown again.',
      cookiePlaceholder: 'z_c0=...; d_c0=...; _xsrf=...',
      saveConnect: 'Save and verify',
      saving: 'Verifying…',
      verify: 'Verify stored cookie',
      verifying: 'Asking Zhihu…',
      disconnect: 'Delete cookie',
      disconnecting: 'Deleting…',
      noticeSaved: 'Saved and verified: {name}.',
      noticeVerified: 'Verified: {name}.',
      noticeDisconnected: 'Deleted. The reading tools now answer not_connected.',
      errorRetryAt: 'This process may ask Zhihu again after {when}.',
      pacingHeading: 'Request pacing',
      pacingInterval: 'Minimum gap between requests',
      pacingBudget: 'Hourly request budget',
      pacingUsed: 'Used this hour',
      pacingUsedOf: '{used} of {limit}',
      pacingReset: 'Budget resets',
      pacingPaused: 'Paused until',
      pacingPausedNone: 'not paused',
      pacingCache: 'Response cache',
      pacingCacheValue: '{entries} entries, {seconds} s each',
      pacingTotal: 'Requests this process',
      pacingLast: 'Last request',
      pacingNote:
        'Zhihu risk control reacts to rate. The plugin serializes requests, spaces them by the minimum gap, caps them per hour, and answers identical reads from the cache; a 403, captcha page, or 429 pauses the whole process instead of retrying.',
      limitsHeading: 'Reading limits',
      limitsContent: 'Content kept per item',
      limitsChars: '{count} characters',
      limitsList: 'List default / maximum',
      limitsListValue: '{fallback} / {max} items',
      limitsComments: 'Comments default / maximum',
      limitsTimeout: 'Request / tool timeout',
      limitsTimeoutValue: '{request} / {tool} ms',
      limitsNote: 'These come from the plugin configuration in cordis.patch.yml.',
      seconds: '{count} s',
      minutes: '{count} min',
      none: '—',
      'errors.unknown': 'The action failed with code {code}.',
      'errors.unreachable': 'The Harness is not reachable; is it still running?',
      'errors.body_too_large': 'The request was too large.',
      'errors.invalid_json': 'The Harness could not read the request.',
      'errors.invalid_body': 'The request had an unexpected form.',
      'errors.unknown_action': 'This page asked for something the Harness does not know.',
      'errors.cookie_missing': 'Paste a Zhihu cookie first.',
      'errors.cookie_invalid': 'That cookie is incomplete: it needs z_c0 and d_c0 and must not contain a newline.',
      'errors.not_connected': 'No Zhihu cookie is stored yet.',
      'errors.not_authorized': 'Zhihu no longer treats that cookie as signed in. Copy a fresh one from the browser.',
      'errors.credential_invalid': 'The stored credential record cannot be read. Delete it and add the cookie again.',
      'errors.risk_control': 'Zhihu answered with a verification or captcha page, which is risk control. The plugin is paused; do not retry immediately.',
      'errors.rate_limited': 'Zhihu answered 429 and the plugin is paused for a while.',
      'errors.signature_required': 'That Zhihu endpoint requires the web client\'s signed headers, and this plugin does not forge them. Use the question, answer, article, or list tools.',
      'errors.request_budget_exhausted': 'The hourly request budget is used up. Wait for it to reset before reading again.',
      'errors.temporarily_blocked': 'The plugin is in a pause that protects the cookie from risk control.',
      'errors.forbidden': 'Zhihu refused the request with 403, usually risk control or a missing permission.',
      'errors.not_found': 'Zhihu has no such resource; it may be deleted or private.',
      'errors.page_not_recognized': 'Zhihu served a page without the embedded state this plugin reads, so its layout has probably changed.',
      'errors.invalid_response': 'Zhihu answered something unexpected.',
      'errors.upstream_error': 'Zhihu answered with an error payload.',
      'errors.upstream_unavailable': 'Zhihu is unavailable right now; try again later.',
      'errors.http_status': 'Zhihu answered with an error status.',
      'errors.request_failed': 'Zhihu could not be reached; check the network.',
      'errors.timeout': 'Zhihu did not answer in time.',
      'errors.aborted': 'The request was cancelled.',
    }

    const zh = {
      loading: '正在读取知乎状态…',
      connectHeading: '连接',
      stateConnected: '已保存 cookie，添加于 {when}。',
      stateDisconnected: '还没有 cookie。从已登录的知乎页面复制整个 Cookie 请求头，粘贴到下面。',
      stateUnusable: '存储的 cookie 不可用 —— {reason}',
      accountHeading: '账号',
      accountUnknown: '还没有验证过账号。点「验证已保存的 cookie」读一次。',
      accountToken: '主页',
      accountVerified: '验证于 {when}。',
      cookieLabel: '知乎 cookie',
      cookieHint:
        '按 Cookie 请求头的格式粘贴，至少包含 z_c0 与 d_c0。保存前会先验证一次，通过后写入本机凭据库；已保存的值不会再显示。',
      cookiePlaceholder: 'z_c0=...; d_c0=...; _xsrf=...',
      saveConnect: '保存并验证',
      saving: '正在验证…',
      verify: '验证已保存的 cookie',
      verifying: '正在询问知乎…',
      disconnect: '删除 cookie',
      disconnecting: '正在删除…',
      noticeSaved: '已保存并验证：{name}。',
      noticeVerified: '验证通过：{name}。',
      noticeDisconnected: '已删除。读取工具现在会返回 not_connected。',
      errorRetryAt: '本进程在 {when} 之后才能再次请求知乎。',
      pacingHeading: '请求节奏',
      pacingInterval: '最小请求间隔',
      pacingBudget: '每小时请求上限',
      pacingUsed: '本小时已用',
      pacingUsedOf: '{used} / {limit}',
      pacingReset: '额度恢复时间',
      pacingPaused: '暂停至',
      pacingPausedNone: '没有暂停',
      pacingCache: '响应缓存',
      pacingCacheValue: '{entries} 条，每条 {seconds} 秒',
      pacingTotal: '本进程请求总数',
      pacingLast: '最近请求',
      pacingNote:
        '知乎风控看频率。插件让请求串行、按最小间隔发送、每小时有上限、相同请求走缓存；遇到 403、验证码页或 429 时整体暂停一段时间，而不是继续重试。',
      limitsHeading: '读取上限',
      limitsContent: '单条内容保留',
      limitsChars: '{count} 个字符',
      limitsList: '列表默认 / 最大',
      limitsListValue: '{fallback} / {max} 条',
      limitsComments: '评论默认 / 最大',
      limitsTimeout: '请求 / 工具超时',
      limitsTimeoutValue: '{request} / {tool} 毫秒',
      limitsNote: '这些值来自插件配置（cordis.patch.yml 的 config）。',
      seconds: '{count} 秒',
      minutes: '{count} 分钟',
      none: '—',
      'errors.unknown': '操作失败，错误码 {code}。',
      'errors.unreachable': '连不上 Harness，它可能已经停止。',
      'errors.body_too_large': '请求体过大。',
      'errors.invalid_json': 'Harness 读不了这个请求。',
      'errors.invalid_body': '请求格式不对。',
      'errors.unknown_action': '页面请求了 Harness 不认识的操作。',
      'errors.cookie_missing': '请先粘贴知乎 cookie。',
      'errors.cookie_invalid': 'cookie 不完整：需要包含 z_c0 与 d_c0，且不能有换行。',
      'errors.not_connected': '还没有保存知乎 cookie。',
      'errors.not_authorized': 'cookie 已失效或被登出，请在浏览器里重新复制。',
      'errors.credential_invalid': '本机保存的凭据记录读不出来，请删除后重新添加。',
      'errors.risk_control': '知乎返回了安全验证或验证码页，已触发风控；插件暂停一段时间，不要立刻重试。',
      'errors.rate_limited': '知乎返回 429 限流，插件暂停一段时间。',
      'errors.signature_required': '这个知乎接口要求网页端的签名头，本插件不伪造签名；请改用问题、回答、文章或列表工具。',
      'errors.request_budget_exhausted': '本小时请求额度已用完，请等额度恢复后再读。',
      'errors.temporarily_blocked': '插件正在暂停期，避免继续触发风控。',
      'errors.forbidden': '知乎以 403 拒绝了请求，通常是风控或权限问题。',
      'errors.not_found': '知乎没有这个资源，可能已删除或设为私密。',
      'errors.page_not_recognized': '知乎页面结构似乎变了，插件读不到页面内嵌的数据。',
      'errors.invalid_response': '知乎返回了预期之外的内容。',
      'errors.upstream_error': '知乎接口返回了错误。',
      'errors.upstream_unavailable': '知乎暂时不可用，稍后再试。',
      'errors.http_status': '知乎返回了错误状态码。',
      'errors.request_failed': '连不上知乎，请检查网络。',
      'errors.timeout': '知乎没有在超时前返回。',
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

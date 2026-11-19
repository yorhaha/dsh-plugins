/**
 * Browser half of the Xiaohongshu bundle: the page shown under Plugins.
 *
 * The page manages the cookie and shows the pacing and corpus state. It never
 * receives the cookie itself, a note body, or an xsec token; the Host answers
 * with counts and states only. The file is served verbatim as a classic script,
 * so it has no imports and carries both dictionaries inline.
 */
window.__ModuleLoader__.load({
  id: 'dsh-xhs-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this section registers its dictionaries under. */
    const NS = 'settings.xiaohongshu'

    /** Host route, document-relative so a sub-path mount still works. */
    const ROUTE = 'api/plugin-xiaohongshu'

    const en = {
      loading: 'Loading Xiaohongshu status…',
      connectHeading: 'Connection',
      stateConnected: 'Cookie saved (added {when}).',
      stateDisconnected: 'Not connected. Copy the Cookie header from a signed-in xiaohongshu.com session and paste it below.',
      stateUnusable: 'Stored cookie is unusable: {reason}',
      accountHeading: 'Account',
      accountUnknown: 'Account not yet verified. Save a cookie to verify.',
      accountVerified: 'Verified as {name}{red}.',
      cookieLabel: 'Xiaohongshu Cookie',
      cookieHint:
        'Paste the Cookie header (requires a1 and web_session); verified before saving.',
      cookiePlaceholder: 'a1=...; web_session=...; webId=...',
      saveConnect: 'Save & Verify',
      saving: 'Verifying…',
      disconnect: 'Delete cookie',
      disconnecting: 'Deleting…',
      noticeSaved: 'Saved and verified: {name}.',
      noticeDisconnected: 'Cookie deleted.',
      errorRetryAt: 'Rate limited until {when}.',
      pacingHeading: 'Request Pacing',
      pacingInterval: 'Minimum interval',
      pacingHour: 'Global requests (hour / day)',
      pacingHourValue: '{hour} / {hourLimit} this hour · {day} / {dayLimit} today',
      pacingSearch: 'Search requests (hour / day)',
      pacingSearchValue: '{hour} / {hourLimit} this hour · {day} / {dayLimit} today',
      pacingReset: 'Hourly budget resets',
      pacingPaused: 'Paused until',
      pacingPausedNone: 'active',
      pacingCache: 'Response cache',
      pacingCacheValue: '{entries} entries ({seconds}s TTL)',
      pacingTotal: 'Session requests',
      pacingLast: 'Last request',
      pacingNote:
        'Requests are rate-limited, budgeted, and cached; automatically pauses on risk control.',
      corpusHeading: 'Local Corpus',
      corpusNotes: 'Notes',
      corpusComments: 'Comments',
      corpusMedia: 'Downloaded images',
      corpusSize: 'Database size',
      corpusLast: 'Last capture',
      corpusClear: 'Clear corpus',
      corpusClearing: 'Clearing…',
      corpusClearConfirm: 'Delete all saved notes, comments, and downloaded images? This cannot be undone.',
      corpusClearCancel: 'Cancel',
      corpusClearNotice: 'Corpus cleared ({notes} notes remaining).',
      limitsHeading: 'Reading Settings',
      limitsContent: 'Max characters per note',
      limitsChars: '{count} chars',
      limitsMedia: 'Download images while reading',
      limitsMediaOn: 'on',
      limitsMediaOff: 'off',
      limitsBudget: 'Global budget',
      limitsBudgetValue: '{hour} / hr · {day} / day',
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
      'errors.cookie_missing': 'Please paste a Xiaohongshu cookie first.',
      'errors.cookie_invalid': 'Incomplete cookie: requires a1 and web_session with no line breaks.',
      'errors.not_connected': 'No Xiaohongshu cookie configured.',
      'errors.auth_expired': 'Cookie expired or signed out. Copy a fresh one from your browser.',
      'errors.credential_invalid': 'Stored credential is unreadable. Delete it and re-add your cookie.',
      'errors.risk_control': 'Verification required; paused to protect your account.',
      'errors.account_restricted': 'Account flagged as abnormal; paused. Try another account later.',
      'errors.rate_limited': 'Rate limited (429); paused temporarily.',
      'errors.signature_outdated': 'Request signature rejected; paused.',
      'errors.signature_rejected': 'Request signature rejected (406).',
      'errors.signature_unavailable': 'Failed to generate request signature headers.',
      'errors.search_permission_denied': 'This account lacks search API permission.',
      'errors.ip_blocked': 'Current IP blocked by Xiaohongshu. Plugin paused.',
      'errors.request_budget_exhausted': 'Request budget exhausted. Wait for the reset window.',
      'errors.temporarily_blocked': 'Plugin is paused to avoid triggering risk control.',
      'errors.forbidden': 'Request refused (403), typically due to risk control or missing permission.',
      'errors.not_found': 'Note or resource not found (may be deleted or private).',
      'errors.missing_xsec_token': 'Missing xsec_token; pass a full share URL or search first.',
      'errors.invalid_query': 'Query is empty or out of allowed range.',
      'errors.invalid_response': 'Unexpected response from Xiaohongshu.',
      'errors.upstream_error': 'Xiaohongshu returned an API error.',
      'errors.upstream_unavailable': 'Xiaohongshu is temporarily unavailable; try again later.',
      'errors.http_status': 'Xiaohongshu returned an error HTTP status.',
      'errors.network_error': 'Cannot reach Xiaohongshu; check your network.',
      'errors.timeout': 'Xiaohongshu request timed out.',
      'errors.aborted': 'Request cancelled.',
    }

    const zh = {
      loading: '正在加载状态…',
      connectHeading: '账号连接',
      stateConnected: '已保存 Cookie（添加于 {when}）。',
      stateDisconnected: '尚未配置 Cookie。请在浏览器登录小红书后，复制完整的 Cookie 请求头粘贴至下方。',
      stateUnusable: '已存 Cookie 异常：{reason}',
      accountHeading: '账号信息',
      accountUnknown: '尚未验证账号，保存 Cookie 后将自动验证。',
      accountVerified: '已验证：{name}{red}。',
      cookieLabel: '小红书 Cookie',
      cookieHint:
        '粘贴完整 Cookie 请求头（需包含 a1 与 web_session），验证后保存至本地。',
      cookiePlaceholder: 'a1=...; web_session=...; webId=...',
      saveConnect: '保存并验证',
      saving: '正在验证…',
      disconnect: '删除 Cookie',
      disconnecting: '正在删除…',
      noticeSaved: '验证成功并已保存：{name}。',
      noticeDisconnected: '已删除 Cookie。',
      errorRetryAt: '冷却中，请在 {when} 后重试。',
      pacingHeading: '请求节奏',
      pacingInterval: '最小请求间隔',
      pacingHour: '全局请求（本小时 / 今日）',
      pacingHourValue: '本小时 {hour}/{hourLimit} · 今日 {day}/{dayLimit}',
      pacingSearch: '搜索请求（本小时 / 今日）',
      pacingSearchValue: '本小时 {hour}/{hourLimit} · 今日 {day}/{dayLimit}',
      pacingReset: '小时额度重置',
      pacingPaused: '暂停至',
      pacingPausedNone: '未暂停',
      pacingCache: '响应缓存',
      pacingCacheValue: '{entries} 条 · 有效期 {seconds} 秒',
      pacingTotal: '本进程请求总数',
      pacingLast: '最近请求',
      pacingNote:
        '请求已启用串行限速、预算控制与结果缓存，触发风控时自动暂停。',
      corpusHeading: '本地语料',
      corpusNotes: '已存笔记',
      corpusComments: '已存评论',
      corpusMedia: '已下载图片',
      corpusSize: '数据库大小',
      corpusLast: '上次抓取',
      corpusClear: '清空语料',
      corpusClearing: '正在清空…',
      corpusClearConfirm: '确定删除所有已抓取的笔记、评论和图片吗？此操作无法撤销。',
      corpusClearCancel: '取消',
      corpusClearNotice: '语料已清空（剩余 {notes} 条笔记）。',
      limitsHeading: '读取设置',
      limitsContent: '单篇笔记保留字数',
      limitsChars: '{count} 字符',
      limitsMedia: '读取时下载图片',
      limitsMediaOn: '开启',
      limitsMediaOff: '关闭',
      limitsBudget: '全局请求预算',
      limitsBudgetValue: '每小时 {hour} 次 · 每天 {day} 次',
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
      'errors.cookie_missing': '请先粘贴小红书 Cookie。',
      'errors.cookie_invalid': 'Cookie 格式不完整：须包含 a1 与 web_session，且不能换行。',
      'errors.not_connected': '尚未保存小红书 Cookie。',
      'errors.auth_expired': 'Cookie 已过期或失效，请从浏览器重新复制。',
      'errors.credential_invalid': '已存凭据无法读取，请删除后重新添加。',
      'errors.risk_control': '触发小红书安全验证，已自动暂停，请勿立即重试。',
      'errors.account_restricted': '小红书提示账号异常，已自动暂停，请更换账号后再试。',
      'errors.rate_limited': '触发 429 限流，已暂时暂停。',
      'errors.signature_outdated': '请求签名被拒，已自动暂停。',
      'errors.signature_rejected': '请求签名被拒（406）。',
      'errors.signature_unavailable': '本地签名模块无法生成请求头。',
      'errors.search_permission_denied': '当前账号暂无搜索接口权限。',
      'errors.ip_blocked': '当前 IP 已被小红书封禁，插件已暂停。',
      'errors.request_budget_exhausted': '请求额度已用尽，请等待重置后再试。',
      'errors.temporarily_blocked': '当前处于风控冷却期，请稍后再试。',
      'errors.forbidden': '请求被拒（403），通常为风控或权限不足。',
      'errors.not_found': '未找到该内容，可能已被删除或设为私密。',
      'errors.missing_xsec_token': '缺少 xsec_token，请传入完整分享链接或先执行一次搜索。',
      'errors.invalid_query': '搜索词为空或超出允许范围。',
      'errors.invalid_response': '小红书返回格式异常。',
      'errors.upstream_error': '小红书接口返回错误。',
      'errors.upstream_unavailable': '小红书服务暂不可用，请稍后再试。',
      'errors.http_status': '小红书返回错误状态码。',
      'errors.network_error': '无法连接小红书，请检查网络。',
      'errors.timeout': '小红书请求超时。',
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
      dangerButton: {
        fontSize: '13px',
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
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
     * Render one instant as `YYYY-MM-DD HH:MM`, in 24-hour clock, independent
     * of the machine's regional settings.
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

    /** Format a byte count. */
    function bytesText(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${bytes} B`
    }

    /** One button that disables itself while its action runs. */
    function Action(props) {
      const { label, onClick, busy, primary, danger, disabled } = props
      const inactive = busy === true || disabled === true
      const base = danger ? styles.dangerButton : primary ? styles.primaryButton : styles.button
      return h(
        'button',
        { type: 'button', style: inactive ? { ...base, ...styles.disabled } : base, disabled: inactive, onClick },
        label,
      )
    }

    /** One read-only fact row. */
    function ConfigRow(props) {
      return h('li', { style: styles.listItem }, h('span', null, props.label), h('span', { style: styles.caption }, props.value))
    }

    /** The settings section. */
    function XiaohongshuSettings(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [confirmClear, setConfirmClear] = React.useState(false)

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

      const loaded = status !== null
      React.useEffect(() => {
        if (loaded) return undefined
        const timer = setInterval(() => {
          void refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [loaded, refresh])

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
      const pacing = status.pacing
      const corpus = status.corpus
      const config = status.config
      const accountName = account?.nickname ?? account?.red_id ?? ''
      const red = account?.red_id ? ` · ${account.red_id}` : ''

      return h(
        'div',
        { style: styles.page },

        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('connectHeading')),
          h(
            'p',
            { style: status.connected ? styles.line : styles.warn },
            status.connected ? t('stateConnected', { when: when(status.saved_at) || t('none') }) : t('stateDisconnected'),
          ),
          status.credential_error === null || status.credential_error === undefined
            ? null
            : h('p', { style: styles.warn }, t('stateUnusable', { reason: status.credential_error })),
          account === null || account === undefined
            ? h('p', { style: styles.line }, t('accountUnknown'))
            : h('p', { style: styles.line }, t('accountVerified', { name: accountName || t('none'), red })),
          status.auth_required ? h('p', { style: styles.warn }, errorText(t, 'auth_expired')) : null,
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
                  return t('noticeSaved', { name: value.account?.nickname ?? value.account?.red_id ?? t('none') })
                })
              },
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

        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('pacingHeading')),
          h(
            'ul',
            { style: styles.list },
            h(ConfigRow, { label: t('pacingInterval'), value: durationText(t, config.minIntervalMs) }),
            h(ConfigRow, {
              label: t('pacingHour'),
              value: t('pacingHourValue', {
                hour: pacing.requests_last_hour,
                hourLimit: pacing.hourly_budget,
                day: pacing.requests_last_day,
                dayLimit: pacing.daily_budget,
              }),
            }),
            h(ConfigRow, {
              label: t('pacingSearch'),
              value: t('pacingSearchValue', {
                hour: pacing.searches_last_hour,
                hourLimit: pacing.search_hourly_budget,
                day: pacing.searches_last_day,
                dayLimit: pacing.search_daily_budget,
              }),
            }),
            h(ConfigRow, { label: t('pacingReset'), value: pacing.budget_reset_at === null ? t('none') : when(pacing.budget_reset_at) }),
            h(ConfigRow, { label: t('pacingPaused'), value: pacing.paused_until === null ? t('pacingPausedNone') : when(pacing.paused_until) }),
            h(ConfigRow, { label: t('pacingCache'), value: t('pacingCacheValue', { entries: pacing.cache_entries, seconds: Math.round(config.cacheTtlMs / 1000) }) }),
            h(ConfigRow, { label: t('pacingTotal'), value: String(pacing.total_requests) }),
            h(ConfigRow, { label: t('pacingLast'), value: pacing.last_request_at === null ? t('none') : when(pacing.last_request_at) }),
          ),
          h('p', { style: styles.caption }, t('pacingNote')),
        ),

        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('corpusHeading')),
          h(
            'ul',
            { style: styles.list },
            h(ConfigRow, { label: t('corpusNotes'), value: String(corpus.note_count) }),
            h(ConfigRow, { label: t('corpusComments'), value: String(corpus.comment_count) }),
            h(ConfigRow, { label: t('corpusMedia'), value: String(corpus.media_count) }),
            h(ConfigRow, { label: t('corpusSize'), value: bytesText(corpus.database_bytes) }),
            h(ConfigRow, { label: t('corpusLast'), value: corpus.last_capture_at === null ? t('none') : when(corpus.last_capture_at) }),
          ),
          confirmClear
            ? h(
                'div',
                null,
                h('p', { style: styles.warn }, t('corpusClearConfirm')),
                h(
                  'div',
                  { style: styles.row },
                  h(Action, {
                    label: busy === 'clear_corpus' ? t('corpusClearing') : t('corpusClear'),
                    busy: busy === 'clear_corpus',
                    danger: true,
                    disabled: busy !== null,
                    onClick: () =>
                      void run('clear_corpus', undefined, (value) => {
                        setConfirmClear(false)
                        return t('corpusClearNotice', { notes: value.note_count })
                      }),
                  }),
                  h(Action, { label: t('corpusClearCancel'), disabled: busy !== null, onClick: () => setConfirmClear(false) }),
                ),
              )
            : h(
                'div',
                { style: styles.row },
                h(Action, { label: t('corpusClear'), danger: true, disabled: busy !== null || corpus.note_count === 0, onClick: () => setConfirmClear(true) }),
              ),
        ),

        h(
          'section',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('limitsHeading')),
          h(
            'ul',
            { style: styles.list },
            h(ConfigRow, { label: t('limitsContent'), value: t('limitsChars', { count: config.contentChars }) }),
            h(ConfigRow, { label: t('limitsMedia'), value: config.downloadMedia ? t('limitsMediaOn') : t('limitsMediaOff') }),
            h(ConfigRow, {
              label: t('limitsBudget'),
              value: t('limitsBudgetValue', { hour: config.hourlyBudget, day: config.dailyBudget }),
            }),
          ),
          h('p', { style: styles.caption }, t('limitsNote')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-xhs-reader: dictionaries')
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-xhs-reader', locale: NS }, XiaohongshuSettings),
            ),
          'dsh-xhs-reader: bundle configuration',
        )
      },
    }
  },
})

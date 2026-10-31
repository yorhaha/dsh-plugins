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
      loading: 'Reading the Xiaohongshu state…',
      connectHeading: 'Connection',
      stateConnected: 'A cookie is saved, added {when}.',
      stateDisconnected: 'No cookie yet. Copy the whole Cookie request header from a signed-in xiaohongshu.com page and paste it below.',
      stateUnusable: 'The stored cookie is unusable — {reason}',
      accountHeading: 'Account',
      accountUnknown: 'The account has not been verified yet. Save a cookie to verify it once.',
      accountVerified: 'Verified as {name}{red}.',
      cookieLabel: 'Xiaohongshu cookie',
      cookieHint:
        'Pasted as a Cookie header, with at least a1 and web_session. It is verified once before it is saved to the local credential store; the saved value is never shown again.',
      cookiePlaceholder: 'a1=...; web_session=...; webId=...',
      saveConnect: 'Save and verify',
      saving: 'Verifying…',
      disconnect: 'Delete cookie',
      disconnecting: 'Deleting…',
      noticeSaved: 'Saved and verified: {name}.',
      noticeDisconnected: 'Deleted. The reading tools now answer not_connected.',
      errorRetryAt: 'This process may ask Xiaohongshu again after {when}.',
      pacingHeading: 'Request pacing',
      pacingInterval: 'Minimum gap between requests',
      pacingHour: 'Requests this hour / day',
      pacingHourValue: '{hour} / {hourLimit} this hour · {day} / {dayLimit} today',
      pacingSearch: 'Search requests this hour / day',
      pacingSearchValue: '{hour} / {hourLimit} this hour · {day} / {dayLimit} today',
      pacingReset: 'Hourly budget resets',
      pacingPaused: 'Paused until',
      pacingPausedNone: 'not paused',
      pacingCache: 'Response cache',
      pacingCacheValue: '{entries} entries, {seconds} s each',
      pacingTotal: 'Requests this process',
      pacingLast: 'Last request',
      pacingNote:
        'Xiaohongshu risk control reacts to rate, and search is the most sensitive endpoint. The plugin serializes requests, spaces them by the minimum gap with jitter, keeps separate search budgets, caches identical reads, and pauses the whole process after a refusal instead of retrying.',
      corpusHeading: 'Local corpus',
      corpusNotes: 'Notes',
      corpusComments: 'Comments',
      corpusMedia: 'Downloaded images',
      corpusSize: 'Database size',
      corpusLast: 'Last capture',
      corpusClear: 'Clear corpus',
      corpusClearing: 'Clearing…',
      corpusClearConfirm: 'Delete every captured note, comment and downloaded image? This cannot be undone.',
      corpusClearCancel: 'Cancel',
      corpusClearNotice: 'Corpus cleared: {notes} notes remain.',
      limitsHeading: 'Reading settings',
      limitsContent: 'Body characters kept per note',
      limitsChars: '{count} characters',
      limitsMedia: 'Download images while reading',
      limitsMediaOn: 'on',
      limitsMediaOff: 'off',
      limitsBudget: 'Global request budget',
      limitsBudgetValue: '{hour} per hour · {day} per day',
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
      'errors.cookie_missing': 'Paste a Xiaohongshu cookie first.',
      'errors.cookie_invalid': 'That cookie is incomplete: it needs a1 and web_session and must not contain a newline.',
      'errors.not_connected': 'No Xiaohongshu cookie is stored yet.',
      'errors.auth_expired': 'Xiaohongshu no longer treats that cookie as signed in. Copy a fresh one from the browser.',
      'errors.credential_invalid': 'The stored credential record cannot be read. Delete it and add the cookie again.',
      'errors.risk_control': 'Xiaohongshu answered with a verification page. The plugin is paused; do not retry immediately.',
      'errors.account_restricted': 'Xiaohongshu reports the account as abnormal. The plugin is paused; try a healthy account later.',
      'errors.rate_limited': 'Xiaohongshu answered 429 and the plugin is paused for a while.',
      'errors.signature_outdated': 'Xiaohongshu rejected the request signature. The local signer probably needs an update; the plugin is paused.',
      'errors.signature_rejected': 'Xiaohongshu rejected the request signature with 406.',
      'errors.signature_unavailable': 'The local signer could not build request headers.',
      'errors.search_permission_denied': 'This account has no search API permission. That is an account-level limit, not a cookie problem.',
      'errors.ip_blocked': 'Xiaohongshu blocked this IP. The plugin is paused.',
      'errors.request_budget_exhausted': 'The request budget is used up. Wait for it to reset before reading again.',
      'errors.temporarily_blocked': 'The plugin is in a pause that protects the account from risk control.',
      'errors.forbidden': 'Xiaohongshu refused the request with 403, usually risk control or a missing permission.',
      'errors.not_found': 'Xiaohongshu has no such resource; it may be deleted or private.',
      'errors.missing_xsec_token': 'This note needs the xsec_token carried by a search result or a full share URL.',
      'errors.invalid_query': 'The query is empty or outside the accepted range.',
      'errors.invalid_response': 'Xiaohongshu answered something unexpected.',
      'errors.upstream_error': 'Xiaohongshu answered with an error payload.',
      'errors.upstream_unavailable': 'Xiaohongshu is unavailable right now; try again later.',
      'errors.http_status': 'Xiaohongshu answered with an error status.',
      'errors.network_error': 'Xiaohongshu could not be reached; check the network.',
      'errors.timeout': 'Xiaohongshu did not answer in time.',
      'errors.aborted': 'The request was cancelled.',
    }

    const zh = {
      loading: '正在读取小红书状态…',
      connectHeading: '连接',
      stateConnected: '已保存 cookie，添加于 {when}。',
      stateDisconnected: '还没有 cookie。从已登录的小红书页面复制整个 Cookie 请求头，粘贴到下面。',
      stateUnusable: '存储的 cookie 不可用 —— {reason}',
      accountHeading: '账号',
      accountUnknown: '还没有验证过账号。保存一次 cookie 即可验证。',
      accountVerified: '已验证：{name}{red}。',
      cookieLabel: '小红书 cookie',
      cookieHint:
        '按 Cookie 请求头的格式粘贴，至少包含 a1 与 web_session。保存前会先验证一次，通过后写入本机凭据库；已保存的值不会再显示。',
      cookiePlaceholder: 'a1=...; web_session=...; webId=...',
      saveConnect: '保存并验证',
      saving: '正在验证…',
      disconnect: '删除 cookie',
      disconnecting: '正在删除…',
      noticeSaved: '已保存并验证：{name}。',
      noticeDisconnected: '已删除。读取工具现在会返回 not_connected。',
      errorRetryAt: '本进程在 {when} 之后才能再次请求小红书。',
      pacingHeading: '请求节奏',
      pacingInterval: '最小请求间隔',
      pacingHour: '本小时 / 今日请求',
      pacingHourValue: '本小时 {hour} / {hourLimit} · 今日 {day} / {dayLimit}',
      pacingSearch: '搜索请求 本小时 / 今日',
      pacingSearchValue: '本小时 {hour} / {hourLimit} · 今日 {day} / {dayLimit}',
      pacingReset: '小时额度恢复时间',
      pacingPaused: '暂停至',
      pacingPausedNone: '没有暂停',
      pacingCache: '响应缓存',
      pacingCacheValue: '{entries} 条，每条 {seconds} 秒',
      pacingTotal: '本进程请求总数',
      pacingLast: '最近请求',
      pacingNote:
        '小红书风控看频率，搜索接口最敏感。插件让请求串行、按最小间隔加随机抖动发送、搜索单独限额、相同请求走缓存；遇到拒绝时整体暂停，而不是继续重试。',
      corpusHeading: '本地语料',
      corpusNotes: '笔记',
      corpusComments: '评论',
      corpusMedia: '已下载图片',
      corpusSize: '数据库大小',
      corpusLast: '上次抓取',
      corpusClear: '清空语料',
      corpusClearing: '正在清空…',
      corpusClearConfirm: '删除所有已抓取的笔记、评论和已下载图片？此操作不可恢复。',
      corpusClearCancel: '取消',
      corpusClearNotice: '语料已清空，当前剩余 {notes} 条笔记。',
      limitsHeading: '读取设置',
      limitsContent: '单篇笔记保留正文',
      limitsChars: '{count} 个字符',
      limitsMedia: '读取时下载图片',
      limitsMediaOn: '开启',
      limitsMediaOff: '关闭',
      limitsBudget: '全局请求预算',
      limitsBudgetValue: '每小时 {hour} 次 · 每天 {day} 次',
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
      'errors.cookie_missing': '请先粘贴小红书 cookie。',
      'errors.cookie_invalid': 'cookie 不完整：需要包含 a1 与 web_session，且不能有换行。',
      'errors.not_connected': '还没有保存小红书 cookie。',
      'errors.auth_expired': 'cookie 已失效或被登出，请在浏览器里重新复制。',
      'errors.credential_invalid': '本机保存的凭据记录读不出来，请删除后重新添加。',
      'errors.risk_control': '小红书返回了安全验证页，插件暂停一段时间，不要立刻重试。',
      'errors.account_restricted': '小红书报告账号异常，插件已暂停；请换一个健康账号再试。',
      'errors.rate_limited': '小红书返回 429 限流，插件暂停一段时间。',
      'errors.signature_outdated': '小红书拒绝了请求签名，内置签名可能需要更新；插件已暂停。',
      'errors.signature_rejected': '小红书以 406 拒绝了请求签名。',
      'errors.signature_unavailable': '本地签名模块无法生成请求头。',
      'errors.search_permission_denied': '这个账号没有搜索接口权限，属于账号级限制，不是 cookie 问题。',
      'errors.ip_blocked': '小红书封了当前 IP，插件已暂停。',
      'errors.request_budget_exhausted': '请求额度已用完，请等额度恢复后再读。',
      'errors.temporarily_blocked': '插件正在暂停期，避免继续触发风控。',
      'errors.forbidden': '小红书以 403 拒绝了请求，通常是风控或权限问题。',
      'errors.not_found': '小红书没有这个资源，可能已删除或设为私密。',
      'errors.missing_xsec_token': '这篇笔记需要搜索或分享链接里的 xsec_token。',
      'errors.invalid_query': '查询为空或超出允许范围。',
      'errors.invalid_response': '小红书返回了预期之外的内容。',
      'errors.upstream_error': '小红书接口返回了错误。',
      'errors.upstream_unavailable': '小红书暂时不可用，稍后再试。',
      'errors.http_status': '小红书返回了错误状态码。',
      'errors.network_error': '连不上小红书，请检查网络。',
      'errors.timeout': '小红书没有在超时前返回。',
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

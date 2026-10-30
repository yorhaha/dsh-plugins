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
      loading: 'Reading the DeepXiv state…',
      tokenHeading: 'API token',
      tokenStateSet: 'A token is stored, added {when}.',
      tokenStateUnset: 'No token yet. The free test papers and the three free queries work without one.',
      tokenStateUnusable: 'The stored record is unusable — {reason}',
      tokenLabel: 'DeepXiv token',
      tokenHint:
        'Saved to the local credential store, replacing any token already there. The stored token is shown above in the clear.',
      save: 'Save token',
      saved: 'Saved. The research tools can authenticate with it now.',
      remove: 'Delete token',
      removed: 'Deleted. The research tools are back to the free test papers.',
      verify: 'Verify and read quota',
      verifying: 'Asking DeepXiv…',
      verifyRefused: 'DeepXiv refused it — {reason}',
      quotaHeading: 'Quota',
      quotaAccount: 'Account',
      quotaTier: 'Tier',
      quotaGeneral: 'General requests',
      quotaAgentic: 'Agentic calls',
      quotaUnknown: 'not reported',
      quotaUsedOf: '{used} used of {limit}',
      quotaUsed: '{used} used',
      quotaRemaining: '{remaining} left today',
      quotaNote: 'The two pools are independent: reading papers spends general requests, agentic answers spend the other.',
      quotaRawHeading: 'Raw answer',
      quotaRawNote: 'DeepXiv reported fields this page does not know, so it shows the whole body.',
      quotaWithheld: 'DeepXiv echoed the token back in its answer, so this page withheld the body.',
      configHeading: 'Reading limits',
      configBaseUrl: 'Endpoint',
      configRequestTimeout: 'Request timeout',
      configToolTimeout: 'Tool timeout',
      configQueryLimit: 'Longest query',
      configSearchTopK: 'Results per search',
      configPreview: 'Preview length',
      configFull: 'Whole-paper limit',
      configMs: '{count} ms',
      configChars: '{count} characters',
      configRange: '{fallback} by default, up to {max}',
      configNote: 'These come from the plugin configuration in cordis.patch.yml.',
      loadFailed: 'Could not read the plugin state: {code}',
        'reasons.record_missing': 'nothing is stored',
        'reasons.not_a_token': 'the stored record is not a DeepXiv token',
        'reasons.unknown_channel': 'the stored record belongs to another service',
        'reasons.no_token': 'the stored record carries no token',
        'errors.unknown': 'unexpected failure ({code})',
        'errors.unreachable': 'the Harness is not reachable; is it still running?',
        'errors.body_too_large': 'the request was too large',
        'errors.invalid_json': 'the Harness could not read the request',
        'errors.invalid_body': 'the request had an unexpected form',
        'errors.unknown_action': 'this page asked for something the Harness does not know',
        'errors.method_not_allowed': 'this action must be sent as a POST request',
        'errors.invalid_token': 'enter the DeepXiv token',
        'errors.token_missing': 'no token is stored yet',
        'errors.unusable_token': 'the stored token cannot be read; delete it and add it again',
        'errors.token_rejected': 'DeepXiv refused the stored token — it is wrong, expired, or from another account',
        'errors.forbidden': 'this token is registered for a different tier of the service',
        'errors.not_found': 'DeepXiv has no paper or query for that request',
        'errors.section_not_found': 'DeepXiv has no section by that title in that paper',
        'errors.invalid_request': 'DeepXiv rejected the request parameters',
        'errors.unprocessable': 'DeepXiv could not accept the request',
        'errors.rate_limited': 'the daily quota is used up; it resets tomorrow',
        'errors.upstream_unavailable': 'DeepXiv is unavailable right now; try again later',
        'errors.response_too_large': 'the answer was larger than this plugin reads',
        'errors.invalid_response': 'DeepXiv answered something unexpected',
        'errors.view_unsupported': 'that reading view does not exist for this corpus',
        'errors.http_status': 'DeepXiv answered with an error status',
        'errors.request_failed': 'DeepXiv could not be reached; check the network and the endpoint',
        'errors.timeout': 'DeepXiv did not answer in time',
        'errors.aborted': 'the request was cancelled',
    }

    const zh = {
      loading: '正在读取 DeepXiv 状态…',
      tokenHeading: 'API token',
      tokenStateSet: '已保存 token，添加于 {when}。',
      tokenStateUnset: '还没有 token。免费测试论文和三个免费检索词无需 token 也能用。',
      tokenStateUnusable: '存储的记录不可用 —— {reason}',
      tokenLabel: 'DeepXiv token',
      tokenHint: '保存到本机凭据库，会替换已有的 token。保存的 token 在上面明文显示。',
      save: '保存 token',
      saved: '已保存，检索与阅读工具现在可以用它认证了。',
      remove: '删除 token',
      removed: '已删除。检索与阅读工具回到免费测试论文。',
      verify: '验证并查询额度',
      verifying: '正在询问 DeepXiv…',
      verifyRefused: 'DeepXiv 拒绝了它 —— {reason}',
      quotaHeading: '额度',
      quotaAccount: '账号',
      quotaTier: '层级',
      quotaGeneral: '普通请求',
      quotaAgentic: 'Agentic 调用',
      quotaUnknown: '未返回',
      quotaUsedOf: '已用 {used} / {limit}',
      quotaUsed: '已用 {used}',
      quotaRemaining: '今天还剩 {remaining}',
      quotaNote: '两个额度池互相独立：读论文花普通请求，Agentic 回答花另一个。',
      quotaRawHeading: '原始返回',
      quotaRawNote: 'DeepXiv 返回了本页不认识的字段，因此直接展示完整响应。',
      quotaWithheld: 'DeepXiv 在响应里回显了 token，本页因此不展示响应体。',
      configHeading: '阅读上限',
      configBaseUrl: '接口地址',
      configRequestTimeout: '单次请求超时',
      configToolTimeout: '单次工具调用超时',
      configQueryLimit: '检索词上限',
      configSearchTopK: '每次检索条数',
      configPreview: '预览长度',
      configFull: '全文上限',
      configMs: '{count} 毫秒',
      configChars: '{count} 字符',
      configRange: '默认 {fallback}，最大 {max}',
      configNote: '这几项来自 cordis.patch.yml 里的插件配置。',
      loadFailed: '无法读取插件状态：{code}',
        'reasons.record_missing': '没有存储任何记录',
        'reasons.not_a_token': '存储的记录不是 DeepXiv token',
        'reasons.unknown_channel': '存储的记录属于其他服务',
        'reasons.no_token': '存储的记录里没有 token',
        'errors.unknown': '意外失败（{code}）',
        'errors.unreachable': '连不上 Harness，它还在运行吗？',
        'errors.body_too_large': '请求体过大',
        'errors.invalid_json': 'Harness 无法解析这次请求',
        'errors.invalid_body': '请求格式不符合预期',
        'errors.unknown_action': '这个页面请求了 Harness 不认识的动作',
        'errors.method_not_allowed': '该操作必须以 POST 请求发送',
        'errors.invalid_token': '请填入 DeepXiv token',
        'errors.token_missing': '还没有保存 token',
        'errors.unusable_token': '保存的 token 读不出来，请删除后重新添加',
        'errors.token_rejected': 'DeepXiv 拒绝了保存的 token：它可能错误、已失效，或属于另一个账号',
        'errors.forbidden': '这个 token 未开通该层级的服务',
        'errors.not_found': 'DeepXiv 没有找到对应的论文或检索结果',
        'errors.section_not_found': '这篇论文里没有该标题的章节',
        'errors.invalid_request': 'DeepXiv 拒绝了请求参数',
        'errors.unprocessable': 'DeepXiv 无法接受这次请求',
        'errors.rate_limited': '当天额度已用完，明天重置',
        'errors.upstream_unavailable': 'DeepXiv 暂时不可用，稍后再试',
        'errors.response_too_large': '返回内容超过了本插件的读取上限',
        'errors.invalid_response': 'DeepXiv 返回了预期之外的内容',
        'errors.view_unsupported': '该语料不支持这个阅读视图',
        'errors.http_status': 'DeepXiv 返回了错误状态码',
        'errors.request_failed': '连不上 DeepXiv，请检查网络与接口地址',
        'errors.timeout': 'DeepXiv 没有在超时前返回',
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
      raw: {
        margin: '6px 0 0',
        padding: '8px 10px',
        maxHeight: '220px',
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
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
          setNotice({ tone: 'ok', text: t('saved') })
        })

      const remove = () =>
        run('remove', async () => {
          setStatus(await call('token.delete'))
          setDraft(null)
          setQuota(null)
          setNotice({ tone: 'ok', text: t('removed') })
        })

      const verify = () =>
        run('verify', async () => {
          const value = await call('token.verify')
          setQuota(value)
          setNotice(null)
        })

      const configured = status?.configured === true
      // A record that exists but cannot be read is exactly the state the copy
      // tells the user to fix, so delete stays available for it.
      const recordExists =
        status !== null && (configured || (status.reason !== undefined && status.reason !== 'record_missing'))
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
        { style: styles.page },
        error === null ? null : h('p', { style: styles.warn }, t('loadFailed', { code: error })),
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('tokenHeading')),
          h('p', { style: configured ? styles.line : styles.caption }, state),
          h(
            'div',
            { style: styles.field },
            h('label', { style: styles.fieldLabel }, t('tokenLabel')),
            h('input', {
              style: styles.input,
              type: 'text',
              value: shown,
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setDraft(event.target.value),
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
              // Nothing to write until the user edits the field: an untouched
              // field already mirrors the store, and an emptied one is refused.
              disabled: draft === null || shown.trim() === '',
            }),
            h(Action, {
              label: t('verify'),
              onClick: verify,
              busy: busy === 'verify',
              disabled: !configured,
            }),
            h(Action, { label: t('remove'), onClick: remove, busy: busy === 'remove', disabled: !recordExists }),
          ),
          notice === null ? null : h('p', { style: styles.ok }, notice.text),
        ),
        quota === null
          ? null
          : h(
              'div',
              { style: styles.card },
              h('h2', { style: styles.cardTitle }, t('quotaHeading')),
              quota.ok !== true
                ? h(
                    'p',
                    { style: styles.warn },
                    t('verifyRefused', { reason: errorText(t, quota.error?.code ?? 'unknown') }),
                  )
                : h(
                    'div',
                    null,
                    h(
                      'ul',
                      { style: styles.list },
                      h(ConfigRow, { label: t('quotaAccount'), value: quota.account ?? t('quotaUnknown') }),
                      h(ConfigRow, { label: t('quotaTier'), value: quota.tier ?? t('quotaUnknown') }),
                      h(ConfigRow, { label: t('quotaGeneral'), value: quotaText(t, quota.general) }),
                      h(ConfigRow, { label: t('quotaAgentic'), value: quotaText(t, quota.agentic) }),
                    ),
                    h('p', { style: styles.caption }, t('quotaNote')),
                    // A body that echoes the credential back is never rendered;
                    // the Host withholds it and says so.
                    quota.raw_withheld === true
                      ? h('p', { style: styles.warn }, t('quotaWithheld'))
                      : quota.raw === null || quota.raw === undefined
                        ? null
                        : h(
                            'div',
                            null,
                            h('p', { style: styles.caption }, t('quotaRawHeading')),
                            h('pre', { style: styles.raw }, quota.raw),
                            h('p', { style: styles.caption }, t('quotaRawNote')),
                          ),
                  ),
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

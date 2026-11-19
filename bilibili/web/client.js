/**
 * Browser half of the Bilibili bundle: the configuration this bundle's page shows
 * in the Plugins panel — the account, the local corpus, and the recurring
 * capture task.
 *
 * This file is served verbatim as a classic script and is never bundled, so it
 * declares no imports, carries its own dictionaries, and self-registers under
 * the package name. It reaches its Host half over the Harness's own
 * authenticated API channel; no cookie value ever crosses that boundary.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bilibili',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this section registers its dictionaries under. */
    const NS = 'settings.bilibili'

    /**
     * Host route, document-relative so a Harness mounted under a sub-path still
     * reaches the route the Host registered at the server root.
     */
    const ROUTE = 'api/plugin-bilibili'

    /** How often a running login or capture is re-read. */
    const POLL_MS = 2000

    const en = {
      loading: 'Loading plugin status…',
      accountHeading: 'Account',
      signedIn: 'Signed in. Username will appear after your first sync.',
      signedInAs: 'Signed in as {name}',
      signedInAsId: 'Signed in as account {mid}',
      signedOut:
        'Not signed in. Scan the QR code with the Bilibili app.',
      signIn: 'Sign in with QR code',
      signOut: 'Sign out',
      scanHint: 'Open the Bilibili app and scan this QR code.',
      waiting: 'Waiting for scan…',
      scanned: 'Scanned. Confirm sign-in on your phone.',
      confirmed: 'Signed in.',
      expired: 'QR code expired. Please try again.',
      failed: 'Sign-in failed. Please try again.',
      cancel: 'Cancel',
      urlFallback: 'Could not render QR code. Open this link in the Bilibili app:',
      dataHeading: 'Data',
      never: 'Not synced yet.',
      lastRunAt: 'Last sync started at {when}',
      stale: 'Data is over 24 hours old.',
      running: 'Syncing…',
      syncNow: 'Sync now',
      backfill: 'Backfill older history (slower)',
      authRequired: 'Session expired or rejected by Bilibili. Please sign in again.',
      retryAt: 'Rate limited by Bilibili. Next attempt available after {when}.',
      failedRun: 'Last sync failed: {code}',
      items: '{count} items',
      pending: 'not synced',
      partial: 'partial snapshot',
      complete: 'complete snapshot',
      scheduleHeading: 'Scheduled sync',
      scheduleActive: 'Active — next run at {when}',
      scheduleInactive: 'Paused.',
      scheduleMissing: 'No scheduled sync task configured.',
      scheduleUnavailable: 'Scheduling service is not available.',
      setUp: 'Set up',
      recreate: 'Recreate',
      loadFailed: 'Failed to load plugin status: {code}',
        'datasets.history': 'Watch history',
        'datasets.watch_later': 'Watch later',
        'datasets.favorites': 'Favorites',
        'datasets.following': 'Following',
        'datasets.self_dynamic': 'My dynamics',
    }

    const zh = {
      loading: '正在加载状态…',
      accountHeading: '账号',
      signedIn: '已登录，首次同步后将显示用户名。',
      signedInAs: '已登录：{name}',
      signedInAsId: '已登录：账号 {mid}',
      signedOut: '尚未登录，请使用 B 站 App 扫码登录。',
      signIn: '扫码登录',
      signOut: '退出登录',
      scanHint: '请打开 B 站 App「扫一扫」扫描下方二维码。',
      waiting: '等待扫码…',
      scanned: '已扫码，请在手机上确认登录。',
      confirmed: '登录成功。',
      expired: '二维码已过期，请重新获取。',
      failed: '登录失败，请重试。',
      cancel: '取消',
      urlFallback: '无法生成二维码，请在 B 站 App 中打开以下链接：',
      dataHeading: '数据',
      never: '尚未同步。',
      lastRunAt: '上次同步开始于 {when}',
      stale: '数据已超过 24 小时未更新。',
      running: '正在同步…',
      syncNow: '立即同步',
      backfill: '回溯更早历史（较慢）',
      authRequired: '登录凭证已失效，请重新扫码登录。',
      retryAt: '触发 B 站限流，请在 {when} 后重试。',
      failedRun: '上次同步失败：{code}',
      items: '{count} 条',
      pending: '尚未同步',
      partial: '部分快照',
      complete: '完整快照',
      scheduleHeading: '自动同步',
      scheduleActive: '已启用 · 下次运行：{when}',
      scheduleInactive: '任务已暂停。',
      scheduleMissing: '尚未创建自动同步任务。',
      scheduleUnavailable: '定时任务服务不可用。',
      setUp: '创建任务',
      recreate: '重建任务',
      loadFailed: '加载插件状态失败：{code}',
        'datasets.history': '观看历史',
        'datasets.watch_later': '稍后再看',
        'datasets.favorites': '收藏',
        'datasets.following': '关注',
        'datasets.self_dynamic': '我的动态',
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
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px' },
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
      qr: {
        display: 'block',
        width: '220px',
        height: '220px',
        marginTop: '10px',
        borderRadius: '8px',
        background: '#ffffff',
      },
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
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
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

    /** One labelled row of the dataset list. */
    function DatasetRow(props) {
      const { t, entry } = props
      const label = t(`datasets.${entry.dataset}`)
      const state =
        entry.count === 0 && entry.lastSuccessAt === null
          ? t('pending')
          : `${t('items', { count: entry.count })} · ${
              entry.lastErrorCode !== null
                ? t('failedRun', { code: entry.lastErrorCode })
                : entry.snapshotComplete === true
                  ? t('complete')
                  : entry.snapshotComplete === false
                    ? t('partial')
                    : when(entry.lastSuccessAt)
            }`
      return h(
        'li',
        { style: styles.listItem },
        h('span', null, label),
        h('span', { style: styles.caption }, state),
      )
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

    /**
     * The settings section.
     * @param {object} props - Slot props, carrying the locale `t` seat.
     * @returns {object} the rendered section.
     */
    function BilibiliSettings(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [login, setLogin] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [backfill, setBackfill] = React.useState(false)
      // Set when this page asked for a capture, cleared once the run it asked
      // for has settled. The Host starts the capture asynchronously, so the
      // first poll can arrive before `running` turns true; without this the
      // page would miss the progress of its own request.
      const [awaiting, setAwaiting] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('status')
          setStatus(next)
          setAwaiting((asked) =>
            asked !== null && next.sync.lastRunAt !== null && next.sync.lastRunAt >= asked
            && next.sync.running === false
              ? null
              : asked,
          )
          setError(null)
        } catch (failure) {
          setError(failure.code)
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      // Retry until the first read lands: a page open across a Harness restart
      // recovers on its own instead of sitting on a stale claim about the account.
      const loaded = status !== null
      React.useEffect(() => {
        if (loaded) return undefined
        const timer = setInterval(() => {
          void refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [loaded, refresh])

      const pending = login !== null && (login.state === 'waiting' || login.state === 'scanned')
      const capturing = status?.sync?.running === true || awaiting !== null

      React.useEffect(() => {
        if (!pending && !capturing) return undefined
        const timer = setInterval(() => {
          void (async () => {
            try {
              if (pending) setLogin(await call('login.state'))
              setStatus(await call('status'))
            } catch (failure) {
              setError(failure.code)
            }
          })()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [pending, capturing])

      const run = React.useCallback(async (name, work) => {
        setBusy(name)
        try {
          await work()
          setError(null)
        } catch (failure) {
          setError(failure.code)
        } finally {
          setBusy(null)
        }
      }, [])

      const signIn = () => run('login', async () => setLogin(await call('login.begin')))
      const cancelLogin = () =>
        run('cancel', async () => {
          await call('login.cancel')
          setLogin(null)
        })
      const signOut = () =>
        run('signout', async () => {
          setStatus(await call('signout'))
          setLogin(null)
        })
      const capture = () =>
        run('sync', async () => {
          await call('sync.start', { backfill })
          await refresh()
        })

      const account = status?.account ?? null
      const schedule = status?.schedule ?? null
      const sync = status?.sync ?? null

      const accountBody = []
      if (login !== null && login.state !== 'confirmed') {
        accountBody.push(h('p', { key: 'hint', style: styles.line }, t('scanHint')))
        if (login.qrImage !== null) {
          accountBody.push(h('img', { key: 'qr', src: login.qrImage, alt: '', style: styles.qr }))
        } else if (login.url !== null) {
          accountBody.push(h('p', { key: 'fallback', style: styles.line }, t('urlFallback')))
          accountBody.push(h('p', { key: 'url', style: styles.mono }, login.url))
        }
        const stateText = {
          waiting: t('waiting'),
          scanned: t('scanned'),
          expired: t('expired'),
          failed: t('failed'),
        }[login.state]
        if (stateText !== undefined) {
          accountBody.push(h('p', { key: 'state', style: styles.caption }, stateText))
        }
        accountBody.push(
          h(
            'div',
            { key: 'actions', style: styles.row },
            h(Action, { label: t('cancel'), onClick: cancelLogin, busy: busy === 'cancel' }),
          ),
        )
      } else if (login !== null && login.state === 'confirmed') {
        accountBody.push(h('p', { key: 'ok', style: styles.line }, t('confirmed')))
      } else if (status === null) {
        // Nothing is loaded yet, so nothing is known about the account. Claiming
        // it is signed out would be a statement the page cannot support.
        accountBody.push(h('p', { key: 'unknown', style: styles.caption }, t('loading')))
      } else if (status.authorized === true) {
        // Authorization, not the stored account record, is what makes a capture
        // possible: the record carries a display name that only a capture can
        // learn, so gating on it would deadlock a freshly signed-in account.
        accountBody.push(
          h(
            'p',
            { key: 'who', style: styles.line },
            account === null
              ? t('signedIn')
              : account.name === null
                ? t('signedInAsId', { mid: account.mid })
                : t('signedInAs', { name: account.name }),
          ),
        )
        accountBody.push(
          h(
            'div',
            { key: 'actions', style: styles.row },
            h(Action, { label: t('signOut'), onClick: signOut, busy: busy === 'signout' }),
          ),
        )
      } else {
        accountBody.push(h('p', { key: 'out', style: styles.line }, t('signedOut')))
        accountBody.push(
          h(
            'div',
            { key: 'actions', style: styles.row },
            h(Action, { label: t('signIn'), onClick: signIn, busy: busy === 'login', primary: true }),
          ),
        )
      }

      const dataBody = []
      if (status === null) {
        dataBody.push(h('p', { key: 'unknown', style: styles.caption }, t('loading')))
      } else if (sync !== null) {
        dataBody.push(
          h(
            'p',
            { key: 'when', style: styles.line },
            sync.lastRunAt === null ? t('never') : t('lastRunAt', { when: when(sync.lastRunAt) }),
          ),
        )
        if (sync.authRequired === true) {
          dataBody.push(h('p', { key: 'auth', style: styles.warn }, t('authRequired')))
        } else if (sync.retryNotBefore !== null && sync.retryNotBefore !== undefined) {
          dataBody.push(
            h('p', { key: 'retry', style: styles.warn }, t('retryAt', { when: when(sync.retryNotBefore) })),
          )
        } else if (sync.running === true) {
          dataBody.push(
            h('p', { key: 'run', style: styles.line }, sync.progress?.message ?? t('running')),
          )
        } else if (sync.lastErrorCode !== null) {
          dataBody.push(
            h('p', { key: 'err', style: styles.warn }, t('failedRun', { code: sync.lastErrorCode })),
          )
        } else if (sync.stale === true) {
          dataBody.push(h('p', { key: 'stale', style: styles.warn }, t('stale')))
        }
      }
      if (status !== null) {
        dataBody.push(
          h(
            'ul',
            { key: 'list', style: styles.list },
            status.datasets.map((entry) =>
              h(DatasetRow, { key: entry.dataset, t, entry }),
            ),
          ),
        )
      }
      dataBody.push(
        h(
          'div',
          { key: 'actions', style: styles.row },
          h(Action, {
            label: t('syncNow'),
            onClick: capture,
            busy: busy === 'sync' || capturing,
            primary: true,
            disabled: status?.authorized !== true,
          }),
          h(
            'label',
            { style: styles.caption },
            h('input', {
              type: 'checkbox',
              checked: backfill,
              onChange: (event) => setBackfill(event.target.checked),
            }),
            ` ${t('backfill')}`,
          ),
        ),
      )

      const scheduleBody = []
      if (status === null) {
        scheduleBody.push(h('p', { key: 'unknown', style: styles.caption }, t('loading')))
      } else if (schedule !== null && schedule.available === false) {
        scheduleBody.push(h('p', { key: 'na', style: styles.line }, t('scheduleUnavailable')))
      } else if (schedule !== null) {
        const first = schedule.tasks[0]
        scheduleBody.push(
          h(
            'p',
            { key: 'state', style: styles.line },
            first === undefined
              ? t('scheduleMissing')
              : schedule.active
                ? t('scheduleActive', { when: when(first.nextRunAt) })
                : t('scheduleInactive'),
          ),
        )
        scheduleBody.push(
          h(
            'div',
            { key: 'actions', style: styles.row },
            h(Action, {
              label: first === undefined ? t('setUp') : t('recreate'),
              onClick: () =>
                run('schedule', async () => {
                  const value = await call(first === undefined ? 'schedule.ensure' : 'schedule.recreate')
                  setStatus((current) => (current === null ? current : { ...current, schedule: value.schedule }))
                }),
              busy: busy === 'schedule',
            }),
          ),
        )
      }

      // The Plugins panel draws this page's title, version, and description from
      // the bundle's locale metadata, so this renders its cards only.
      return h(
        'div',
        { style: styles.page },
        error === null ? null : h('p', { style: styles.warn }, t('loadFailed', { code: error })),
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('accountHeading')),
          ...accountBody,
        ),
        h('div', { style: styles.card }, h('h2', { style: styles.cardTitle }, t('dataHeading')), ...dataBody),
        h(
          'div',
          { style: styles.card },
          h('h2', { style: styles.cardTitle }, t('scheduleHeading')),
          ...scheduleBody,
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
        ctx.effect(
          () => ctx.locale.register(NS, { en, zh }),
          'dsh-bilibili: dictionaries',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: 'dsh-bilibili',
                  locale: NS,
                },
                BilibiliSettings,
              ),
            ),
          'dsh-bilibili: bundle configuration',
        )
      },
    }
  },
})

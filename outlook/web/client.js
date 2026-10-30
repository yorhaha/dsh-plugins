/**
 * Browser half of the Outlook bundle: the configuration this bundle's page
 * shows in the Plugins panel — the Azure app registration over the shared
 * settings form, the device-code sign-in, the local corpus, and the recurring
 * sync task.
 *
 * This file is served verbatim as a classic script and is never bundled, so it
 * declares no imports, carries its own dictionaries, and self-registers under
 * the package name. It reaches its Host half over the Harness's own
 * authenticated API channel; no access token ever crosses that boundary — the
 * page only ever sees URLs, codes, statuses, and counts.
 */
window.__ModuleLoader__.load({
  id: 'dsh-outlook',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // The platform module table serves the shared atoms to every dynamic bundle,
    // so the panel is built from the same controls the rest of the shell uses
    // instead of a second set drawn with inline styles.
    const {
      Button,
      SettingsForm, SettingsFormModel, SettingsValueField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace this section registers its dictionaries under. */
    const NS = 'settings.outlook'

    /**
     * Host route, document-relative so a Harness mounted under a sub-path still
     * reaches the route the Host registered at the server root.
     */
    const ROUTE = 'api/plugin-outlook'

    /** How often a running sign-in or sync is re-read. */
    const POLL_MS = 2000

    /** A corpus whose newest successful capture is older than this reads stale. */
    const STALE_MS = 24 * 60 * 60 * 1000

    /**
     * The profile entry whose live fields this bundle's page edits, and the key
     * the Plugins panel dispatches the page by: the bundle's package name.
     */
    const CONFIG_ENTRY = 'outlook'
    const CONFIG_BUNDLE = 'dsh-outlook'

    /** An Azure application (client) id is a GUID. */
    const CLIENT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

    /** A tenant is a name, a domain, or a GUID. */
    const TENANT = /^[A-Za-z0-9.-]+$/

    /**
     * The two live fields, with the shape check the Config schema also
     * carries: a draft the Host would refuse is shown as invalid here, so the
     * page names the mistake instead of reporting a refused save.
     */
    const CLIENT_ID_FIELD = {
      field: 'clientId',
      format: (value) => (typeof value === 'string' ? value : ''),
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        return CLIENT_ID.test(trimmed) ? { kind: 'set', value: trimmed } : undefined
      },
    }
    const TENANT_FIELD = {
      field: 'tenant',
      format: (value) => (typeof value === 'string' ? value : ''),
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        return TENANT.test(trimmed) ? { kind: 'set', value: trimmed } : undefined
      },
    }

    const en = {
      accountHeading: 'Account',
      setupIntro:
        'An Azure app registration is required before this plugin can sign in. Register a public client (native) app, then paste its Application (client) ID and tenant below.',
      setupWhere:
        'Azure portal → App registrations → New registration; under Authentication, allow public client flows — this plugin signs in with the device code flow.',
      scopesInUse: 'Scopes requested at sign-in: {scopes}',
      formUnavailable: 'This Harness does not serve this bundle’s configuration, so these fields cannot be edited here.',
      readOnly: 'This Harness stores settings read-only, so these fields cannot be saved here.',
      formSaveFailed: 'The Host did not accept the change; check the values and save again.',
      clientIdLabel: 'Application (client) ID',
      clientIdHint: "The GUID on the app registration's Overview page.",
      clientIdInvalid: 'An application (client) ID is a GUID.',
      tenantLabel: 'Directory (tenant) ID or domain',
      tenantHint: "Use 'common' to accept both personal and work accounts.",
      tenantInvalid: 'A tenant is a name, a domain, or a GUID.',
      save: 'Save',
      saving: 'Saving…',
      overridden: 'Changed',
      reset: 'Reset',
      cancel: 'Cancel',
      signIn: 'Sign in with device code',
      signInAgain: 'Sign in again',
      deviceHint:
        'Open the sign-in page below and enter this code to authorize this machine. Keep this page open until the sign-in finishes.',
      copyCode: 'Copy code',
      copied: 'Copied',
      codeExpires: 'The code is valid until {when}.',
      loginWaiting: 'Waiting for you to finish signing in…',
      loginSucceeded: 'Signed in.',
      loginExpired: 'The code expired. Start again to get a new one.',
      loginCancelled: 'Sign-in cancelled.',
      loginFailed: 'Sign-in failed.',
      loginFailedCode: 'Reported reason: {code}',
      signedInAs: 'Signed in as {name}.',
      signOut: 'Sign out',
      authRequired: 'Microsoft rejected the stored sign-in. Sign in again below.',
      signInNeedsClientId: 'Set the Application (client) ID above before signing in.',
      grantedScopes: 'Scopes this sign-in was granted: {scopes}',
      grantedScopesNone: 'The scopes of this sign-in have not been read yet.',
      dataHeading: 'Data',
      never: 'Never synced yet.',
      lastRunAt: 'Last sync started {when}.',
      runStatus: 'Last result: {status}.',
      runSucceeded: 'succeeded',
      runFailed: 'failed',
      runSkipped: 'skipped',
      runUnknown: 'unknown',
      failedRun: 'Failed: {code}',
      stale: 'The newest capture is over a day old, or nothing has been captured yet. Sync now.',
      running: 'Syncing…',
      retryAt: 'Microsoft is rate-limiting this app; the next attempt is allowed after {when}.',
      items: '{count} messages',
      pending: 'not captured yet',
      lastSuccessAt: 'last success {when}',
      bounded: 'bounded snapshot',
      mailLabel: 'Mail',
      databaseLine: 'Corpus file: {path} ({mb} MB)',
      syncNow: 'Sync now',
      backfill: 'Walk mail history further back (slower)',
      syncNeedsClientId: 'Set the Application (client) ID above before syncing.',
      syncNeedsSignIn: 'Sign in above before syncing.',
      notStarted: 'The sync did not start: {reason}.',
        'reasons.busy': 'a sync is already running',
        'reasons.not_configured': 'no client id is set',
        'reasons.auth_required': 'sign-in is required',
      scheduleHeading: 'Automatic sync',
      scheduleUnavailable: 'This Harness mounts no schedule service.',
      scheduleMissing: 'No sync task is set up.',
      scheduleNextRun: 'next run {when}',
      taskActive: 'active',
      taskInactive: 'stopped',
      scheduleNote:
        'A sync task belongs to one conversation: the Host binds it to the session that asked for it, and deleting it there does not restore it.',
      setUp: 'Set up',
      recreate: 'Re-create',
      loadFailed: 'Could not read the plugin state: {code}',
      networkFailed: 'Could not reach the Harness. Check the connection and try again.',
    }

    const zh = {
      accountHeading: '账号',
      setupIntro:
        '本插件需要先有一个 Azure 应用注册才能登录。请注册一个公共客户端（本机）应用，再把它的「应用程序(客户端) ID」与租户填在下面。',
      setupWhere:
        'Azure 门户 → 应用注册 → 新注册；再到「身份验证」里允许公共客户端流 —— 本插件用设备代码流登录。',
      scopesInUse: '登录时申请的权限：{scopes}',
      formUnavailable: '当前 Harness 没有提供这个 bundle 的配置，这两个字段暂时无法在这里编辑。',
      readOnly: '当前 Harness 以只读方式保存设置，这两个字段无法在这里保存。',
      formSaveFailed: 'Host 没有接受这次修改，请检查取值后重新保存。',
      clientIdLabel: '应用程序(客户端) ID',
      clientIdHint: '填应用注册「概述」页里的 GUID。',
      clientIdInvalid: '应用程序(客户端) ID 必须是一个 GUID。',
      tenantLabel: '目录(租户) ID 或域名',
      tenantHint: '填 common 可以同时接受个人账号与工作账号。',
      tenantInvalid: '租户只能是名称、域名或 GUID。',
      save: '保存',
      saving: '正在保存…',
      overridden: '已修改',
      reset: '重置',
      cancel: '取消',
      signIn: '使用设备代码登录',
      signInAgain: '重新登录',
      deviceHint: '打开下面的登录页并输入这串代码，即可授权本机。登录完成前请不要关闭本页。',
      copyCode: '复制代码',
      copied: '已复制',
      codeExpires: '代码有效期至 {when}。',
      loginWaiting: '等待你在浏览器中完成登录…',
      loginSucceeded: '已登录。',
      loginExpired: '代码已过期，请重新获取。',
      loginCancelled: '已取消登录。',
      loginFailed: '登录失败。',
      loginFailedCode: '上游返回的原因：{code}',
      signedInAs: '已登录：{name}',
      signOut: '退出登录',
      authRequired: '微软已拒绝当前登录，请在下面重新登录。',
      signInNeedsClientId: '请先在上面填好应用程序(客户端) ID，再登录。',
      grantedScopes: '这份登录实际获得的权限：{scopes}',
      grantedScopesNone: '还没读过这份登录的授权范围。',
      dataHeading: '数据',
      never: '尚未同步过。',
      lastRunAt: '上次同步开始于 {when}。',
      runStatus: '上次结果：{status}。',
      runSucceeded: '成功',
      runFailed: '失败',
      runSkipped: '已跳过',
      runUnknown: '未知',
      failedRun: '失败：{code}',
      stale: '最新一次抓取已超过一天，或者还没抓取过。可以现在同步。',
      running: '正在同步…',
      retryAt: '微软正在限流该应用，{when} 之后才允许再次尝试。',
      items: '{count} 封',
      pending: '尚未抓取',
      lastSuccessAt: '上次成功 {when}',
      bounded: '有界快照',
      mailLabel: '邮件',
      databaseLine: '数据文件：{path}（{mb} MB）',
      syncNow: '立即同步',
      backfill: '继续向前补邮件历史（较慢）',
      syncNeedsClientId: '请先在上面填好应用程序(客户端) ID，再同步。',
      syncNeedsSignIn: '请先在上面登录，再同步。',
      notStarted: '同步没有启动：{reason}。',
        'reasons.busy': '已有同步在运行',
        'reasons.not_configured': '还没有设置客户端 ID',
        'reasons.auth_required': '需要先登录',
      scheduleHeading: '自动同步',
      scheduleUnavailable: '当前 Harness 未挂载定时任务服务。',
      scheduleMissing: '尚未建立同步任务。',
      scheduleNextRun: '下次运行 {when}',
      taskActive: '已启用',
      taskInactive: '已停止',
      scheduleNote:
        '同步任务属于某一个会话：由 Host 绑定到发起它的会话，在「自动化任务」里删除后不会自动恢复。',
      setUp: '建立任务',
      recreate: '重新建立',
      loadFailed: '无法读取插件状态：{code}',
      networkFailed: '无法连接 Harness，请检查连接后重试。',
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
      link: { color: 'var(--dsw-alias-link)', textDecoration: 'underline', wordBreak: 'break-all' },
      codeBox: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
        marginTop: '10px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '20px',
        fontWeight: 600,
        letterSpacing: '0.12em',
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
    }

    /**
     * Call one Host action.
     * @param {string} action - Action name.
     * @param {object} [body] - Extra request fields.
     * @returns {Promise<object>} the action's value.
     */
    async function call(action, body) {
      const response = await fetch(new URL(ROUTE, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action, ...(body ?? {}) }),
      })
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload.ok !== true) {
        const code = payload?.error?.code ?? `http_${response.status}`
        throw Object.assign(new Error(code), { code })
      }
      return payload.value
    }

    /**
     * Read the stable code out of a failed call.
     * @param {object} failure - Whatever `call` threw.
     * @returns {string} the Host's code, or `network_error` when the request
     *   never reached the Host and no code came back.
     */
    function codeOf(failure) {
      const code = failure?.code
      return typeof code === 'string' ? code : 'network_error'
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

    /** Corpus size in MB, one decimal. */
    function megabytes(bytes) {
      return (bytes / (1024 * 1024)).toFixed(1)
    }

    /**
     * When the corpus was last captured successfully.
     * @param {object|null} mail - `status.mail`.
     * @returns {number|null} that instant in epoch milliseconds, or null when no
     *   capture has ever succeeded.
     */
    function newestSuccessAt(mail) {
      if (mail === null || mail.lastSuccessAt === null) return null
      const at = Date.parse(mail.lastSuccessAt)
      return Number.isNaN(at) ? null : at
    }

    /**
     * Localized text for one `sync.lastRunStatus`.
     * @param {Function} t - Bound locale lookup.
     * @param {string} status - Host status token.
     * @returns {string} the localized label.
     */
    function runStatusText(t, status) {
      if (status === 'succeeded') return t('runSucceeded')
      if (status === 'failed') return t('runFailed')
      if (status === 'skipped') return t('runSkipped')
      return t('runUnknown')
    }

    /** The corpus row: how many messages are stored and how fresh they are. */
    function MailRow(props) {
      const { t, entry } = props
      const parts = [t('items', { count: entry.count })]
      if (entry.lastErrorCode !== null) {
        parts.push(t('failedRun', { code: entry.lastErrorCode }))
      } else if (entry.lastSuccessAt === null) {
        parts.push(t('pending'))
      } else {
        parts.push(t('lastSuccessAt', { when: when(entry.lastSuccessAt) }))
      }
      if (entry.snapshotComplete === false) parts.push(t('bounded'))
      return h(
        'li',
        { style: styles.listItem },
        h('span', null, t('mailLabel')),
        h('span', { style: styles.caption }, parts.join(' · ')),
      )
    }

    /** One button that disables itself while its action runs. */
    function Action(props) {
      const { label, onClick, busy, primary, disabled } = props
      return h(
        Button,
        {
          variant: primary === true ? 'primary' : 'ghost',
          size: 'sm',
          disabled: busy === true || disabled === true,
          onClick,
        },
        label,
      )
    }

    function OutlookSettings(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [login, setLogin] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [backfill, setBackfill] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      // Scopes the stored sign-in was granted; null until read or when no sign-in is stored.
      const [granted, setGranted] = React.useState(null)
      // Set when this page asked for a sync, cleared once the run it asked for
      // has settled. The Host starts a sync asynchronously, so the first poll
      // can arrive before `running` turns true; without this the page would
      // miss the progress of its own request.
      const [awaiting, setAwaiting] = React.useState(null)

      const applyStatus = React.useCallback((next) => {
        setStatus(next)
        setAwaiting((asked) =>
          asked !== null && next.sync.lastRunAt !== null && next.sync.lastRunAt >= asked
          && next.sync.running === false
            ? null
            : asked,
        )
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          applyStatus(await call('status'))
          setError(null)
        } catch (failure) {
          setError(codeOf(failure))
        }
      }, [applyStatus])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      // The two live fields the Host serves, plus the section it accepted.
      // Re-reading the status when an accepted value moves makes the page's own
      // `configured` state follow a save made on this page.
      const form = props.useOutlookForm((snapshot) => snapshot)
      const accepted = form.accepted
      const acceptedClientId = accepted === undefined ? null : (accepted.clientId ?? '')
      const acceptedTenant = accepted === undefined ? null : (accepted.tenant ?? '')

      React.useEffect(() => {
        if (acceptedClientId === null) return
        void refresh()
      }, [acceptedClientId, acceptedTenant, refresh])

      const waiting = login !== null && login.status === 'waiting'
      const syncing = status?.sync?.running === true || awaiting !== null
      const authorized = status?.authorized === true

      // What the stored sign-in was actually granted. No call reports it and
      // the configured scopes say only what the next sign-in would ask for, so
      // it is read from the record whenever the page describes a sign-in.
      React.useEffect(() => {
        if (!authorized) {
          setGranted(null)
          return
        }
        let current = true
        call('scopes.granted')
          .then((value) => {
            if (current) setGranted(value.scopes)
          })
          .catch(() => {
            // A record that cannot be read is reported by every action that
            // needs a token; this line simply stays unstated.
            if (current) setGranted(null)
          })
        return () => {
          current = false
        }
      }, [authorized])

      React.useEffect(() => {
        if (!waiting && !syncing) return undefined
        const timer = setInterval(() => {
          void (async () => {
            try {
              if (waiting) {
                const next = (await call('login.state')).state
                setLogin(next)
                if (next.status === 'succeeded') await refresh()
              }
              if (syncing) await refresh()
            } catch (failure) {
              setError(codeOf(failure))
            }
          })()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [waiting, syncing, refresh])

      const run = React.useCallback(async (name, work) => {
        setBusy(name)
        setNotice(null)
        try {
          await work()
          setError(null)
        } catch (failure) {
          setError(codeOf(failure))
        } finally {
          setBusy(null)
        }
      }, [])

      const signIn = () =>
        run('login', async () => {
          setCopied(false)
          setLogin((await call('login.begin')).state)
        })
      const cancelLogin = () =>
        run('cancel', async () => {
          setCopied(false)
          setLogin((await call('login.cancel')).state)
        })
      const signOut = () =>
        run('signout', async () => {
          setLogin(null)
          applyStatus(await call('signout'))
        })
      const syncNow = () =>
        run('sync', async () => {
          const outcome = await call('sync.start', { backfill })
          if (outcome.started !== true) {
            setNotice(outcome.reason ?? 'busy')
            return
          }
          setAwaiting(new Date().toISOString())
          await refresh()
        })
      const copyCode = async () => {
        if (login?.userCode == null) return
        try {
          await navigator.clipboard.writeText(login.userCode)
          setCopied(true)
        } catch (failure) {
          // A browser may refuse clipboard access; the code stays selectable in
          // the box above, so a refused copy needs no further report.
          setCopied(false)
        }
      }

      const account = status?.account ?? null
      const schedule = status?.schedule ?? null
      const sync = status?.sync ?? null
      const configured = status?.configured === true
      const canSync = configured && authorized
      const accountName =
        account === null
          ? (status?.accountId ?? '')
          : (account.username ?? account.name ?? status.accountId)
      const newestSuccess = status === null ? null : newestSuccessAt(status.mail)
      const stale = status !== null && (newestSuccess === null || Date.now() - newestSuccess > STALE_MS)
      const disabledReason =
        status === null
          ? null
          : !configured
            ? t('syncNeedsClientId')
            : !authorized
              ? t('syncNeedsSignIn')
              : null

      const accountBody = []
      if (status !== null && !configured) {
        accountBody.push(h('p', { key: 'intro', style: styles.line }, t('setupIntro')))
        accountBody.push(h('p', { key: 'where', style: styles.caption }, t('setupWhere')))
      }
      if (status !== null) {
        accountBody.push(
          h(
            'p',
            { key: 'scopes', style: styles.caption },
            t('scopesInUse', { scopes: status.config.scopes.join(', ') }),
          ),
        )
      }
      // The app registration is edited through the shared settings form over
      // this entry's live fields: the Plugins page owns the write, so this page
      // stages drafts and saves instead of talking to the Host itself.
      accountBody.push(
        h(
          SettingsForm,
          {
            key: 'config',
            labels: {
              unavailable: t('formUnavailable'),
              readOnly: t('readOnly'),
              saveFailed: t('formSaveFailed'),
              save: t('save'),
              saving: t('saving'),
            },
            state: form.shell,
            onSave: props.save,
            onDiscard: props.discard,
          },
          h(SettingsValueField, {
            key: 'clientId',
            id: 'outlook-client-id',
            label: t('clientIdLabel'),
            hint: t('clientIdHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('clientIdInvalid'),
            disabled: !form.shell.writable,
            text: form.clientId.text,
            overridden: form.clientId.overridden,
            invalid: form.clientId.invalid,
            onEdit: (text) => props.edit('clientId', text),
            onReset: () => props.resetField('clientId'),
          }),
          h(SettingsValueField, {
            key: 'tenant',
            id: 'outlook-tenant',
            label: t('tenantLabel'),
            hint: t('tenantHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('tenantInvalid'),
            disabled: !form.shell.writable,
            text: form.tenant.text,
            overridden: form.tenant.overridden,
            invalid: form.tenant.invalid,
            onEdit: (text) => props.edit('tenant', text),
            onReset: () => props.resetField('tenant'),
          }),
        ),
      )
      if (sync !== null && sync.authRequired === true) {
        accountBody.push(h('p', { key: 'authRequired', style: styles.warn }, t('authRequired')))
      }
      if (login !== null) {
        if (login.status === 'waiting') {
          accountBody.push(h('p', { key: 'hint', style: styles.line }, t('deviceHint')))
          if (login.verificationUri !== null) {
            accountBody.push(
              h(
                'p',
                { key: 'link', style: styles.line },
                h(
                  'a',
                  {
                    href: login.verificationUri,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: styles.link,
                  },
                  login.verificationUri,
                ),
              ),
            )
          }
          if (login.userCode !== null) {
            accountBody.push(
              h(
                'div',
                { key: 'code', style: styles.codeBox },
                h('span', { key: 'value', style: styles.code }, login.userCode),
                h(Action, { key: 'copy', label: copied ? t('copied') : t('copyCode'), onClick: copyCode }),
              ),
            )
          }
        }
        if (login.message !== null) {
          accountBody.push(h('p', { key: 'message', style: styles.caption }, login.message))
        }
        const stateText = {
          waiting: t('loginWaiting'),
          succeeded: t('loginSucceeded'),
          expired: t('loginExpired'),
          failed: t('loginFailed'),
          cancelled: t('loginCancelled'),
        }[login.status]
        if (stateText !== undefined) {
          const severe = login.status === 'failed' || login.status === 'expired'
          accountBody.push(h('p', { key: 'state', style: severe ? styles.warn : styles.line }, stateText))
        }
        if (login.errorCode !== null) {
          accountBody.push(
            h('p', { key: 'why', style: styles.caption }, t('loginFailedCode', { code: login.errorCode })),
          )
        }
        if (login.status === 'waiting') {
          if (login.expiresAt !== null) {
            accountBody.push(
              h('p', { key: 'expires', style: styles.caption }, t('codeExpires', { when: when(login.expiresAt) })),
            )
          }
          accountBody.push(
            h(
              'div',
              { key: 'cancel', style: styles.row },
              h(Action, { label: t('cancel'), onClick: cancelLogin, busy: busy === 'cancel' }),
            ),
          )
        }
      }
      if (authorized) {
        accountBody.push(h('p', { key: 'who', style: styles.line }, t('signedInAs', { name: accountName })))
        accountBody.push(
          h(
            'div',
            { key: 'signOut', style: styles.row },
            h(Action, { label: t('signOut'), onClick: signOut, busy: busy === 'signout' }),
          ),
        )
      } else if (!waiting && (login === null || login.status !== 'succeeded')) {
        accountBody.push(
          h(
            'div',
            { key: 'signIn', style: styles.row },
            h(Action, {
              label: login === null ? t('signIn') : t('signInAgain'),
              onClick: signIn,
              busy: busy === 'login',
              primary: true,
              disabled: !configured,
            }),
          ),
        )
        if (status !== null && !configured) {
          accountBody.push(h('p', { key: 'signInWhy', style: styles.caption }, t('signInNeedsClientId')))
        }
      }

      const dataBody = []
      if (sync !== null) {
        dataBody.push(
          h(
            'p',
            { key: 'lastRun', style: styles.line },
            sync.lastRunAt === null ? t('never') : t('lastRunAt', { when: when(sync.lastRunAt) }),
          ),
        )
        if (sync.lastRunStatus !== null) {
          dataBody.push(
            h(
              'p',
              { key: 'lastStatus', style: styles.caption },
              t('runStatus', { status: runStatusText(t, sync.lastRunStatus) }),
            ),
          )
        }
        if (sync.lastErrorCode !== null) {
          dataBody.push(h('p', { key: 'lastError', style: styles.warn }, t('failedRun', { code: sync.lastErrorCode })))
        }
        if (sync.retryNotBefore !== null && Date.parse(sync.retryNotBefore) > Date.now()) {
          dataBody.push(
            h('p', { key: 'retry', style: styles.warn }, t('retryAt', { when: when(sync.retryNotBefore) })),
          )
        }
        if (sync.running === true || awaiting !== null) {
          dataBody.push(h('p', { key: 'running', style: styles.line }, sync.progress ?? t('running')))
        } else if (stale) {
          dataBody.push(h('p', { key: 'stale', style: styles.warn }, t('stale')))
        }
      }
      if (notice !== null) {
        const known =
          notice === 'busy' || notice === 'not_configured' || notice === 'auth_required'
            ? t(`reasons.${notice}`)
            : notice
        dataBody.push(h('p', { key: 'notice', style: styles.warn }, t('notStarted', { reason: known })))
      }
      if (status !== null) {
        dataBody.push(
          h('ul', { key: 'corpus', style: styles.list }, h(MailRow, { t, entry: status.mail })),
        )
        dataBody.push(
          h(
            'p',
            { key: 'database', style: styles.caption },
            t('databaseLine', { path: status.database.path, mb: megabytes(status.database.bytes) }),
          ),
        )
      }
      dataBody.push(
        h(
          'div',
          { key: 'actions', style: styles.row },
          h(Action, {
            label: t('syncNow'),
            onClick: syncNow,
            busy: busy === 'sync' || awaiting !== null,
            primary: true,
            disabled: !canSync,
          }),
          h(
            'label',
            { style: styles.caption },
            h('input', {
              type: 'checkbox',
              checked: backfill,
              disabled: !canSync,
              onChange: (event) => setBackfill(event.target.checked),
            }),
            ` ${t('backfill')}`,
          ),
        ),
      )
      if (disabledReason !== null) {
        dataBody.push(h('p', { key: 'why', style: styles.caption }, disabledReason))
      }

      const scheduleBody = []
      if (schedule !== null && schedule.available === false) {
        scheduleBody.push(h('p', { key: 'na', style: styles.line }, t('scheduleUnavailable')))
      } else if (schedule !== null) {
        const first = schedule.tasks[0]
        if (first === undefined) {
          scheduleBody.push(h('p', { key: 'missing', style: styles.line }, t('scheduleMissing')))
        } else {
          scheduleBody.push(
            h(
              'ul',
              { key: 'tasks', style: styles.list },
              schedule.tasks.map((task) =>
                h(
                  'li',
                  { key: task.id, style: styles.listItem },
                  h('span', null, task.title),
                  h(
                    'span',
                    { style: styles.caption },
                    `${task.status === 'active' ? t('taskActive') : t('taskInactive')} · ${
                      t('scheduleNextRun', { when: when(task.nextRunAt) })
                    }`,
                  ),
                ),
              ),
            ),
          )
        }
        scheduleBody.push(h('p', { key: 'note', style: styles.caption }, t('scheduleNote')))
        scheduleBody.push(
          h(
            'div',
            { key: 'actions', style: styles.row },
            h(Action, {
              label: first === undefined ? t('setUp') : t('recreate'),
              onClick: () =>
                run('schedule', async () => {
                  const value = await call(first === undefined ? 'schedule.ensure' : 'schedule.recreate')
                  setStatus((current) =>
                    current === null ? current : { ...current, schedule: value.schedule },
                  )
                }),
              busy: busy === 'schedule',
            }),
          ),
        )
      }

      // The configured list says what the next sign-in asks for; only the
      // record says what the current one got, which is what decides whether the
      // next capture works.
      if (authorized) {
        accountBody.push(
          h(
            'p',
            { key: 'granted', style: styles.caption },
            granted === null
              ? t('grantedScopesNone')
              : t('grantedScopes', { scopes: granted.length === 0 ? '—' : granted.join(', ') }),
          ),
        )
      }

      // The Plugins panel draws this page's title, version, and description from
      // the bundle's locale metadata, so this renders its cards only.
      return h(
        'div',
        { style: styles.page },
        error === null
          ? null
          : h(
              'p',
              { style: styles.warn },
              error === 'network_error' ? t('networkFailed') : t('loadFailed', { code: error }),
            ),
        h('div', { style: styles.card }, h('h2', { style: styles.cardTitle }, t('accountHeading')), ...accountBody),
        h('div', { style: styles.card }, h('h2', { style: styles.cardTitle }, t('dataHeading')), ...dataBody),
        h('div', { style: styles.card }, h('h2', { style: styles.cardTitle }, t('scheduleHeading')), ...scheduleBody),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries and the configuration this bundle's page
       * shows in the Plugins panel.
       * @param {object} ctx - Client context.
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(
          () => ctx.locale.register(NS, { en, zh }),
          'dsh-outlook: dictionaries',
        )
        // The bundle page edits this entry's live fields through the settings
        // service, so it waits for that service: a composition that mounts none
        // shows no configuration.
        ctx.inject(['slots', 'configForms'], (child) => {
          const scope = child.configForms.get(CONFIG_ENTRY)
          const form = new SettingsFormModel(scope, [CLIENT_ID_FIELD, TENANT_FIELD])
          child.effect(() => () => { form.dispose() }, 'dsh-outlook: settings form')
          const store = form.bind(() => ({
            shell: form.shell(),
            clientId: form.field('clientId'),
            tenant: form.field('tenant'),
            accepted: scope.getSnapshot().value,
          }))
          child.slots.inject('plugins.bundle.config', () => child.slots.register(
            {
              name: 'plugins.bundle.config',
              key: CONFIG_BUNDLE,
              locale: NS,
              inject: () => ({ hooks: { outlookForm: store }, ...form.actions() }),
            },
            OutlookSettings,
          ))
        })
      },
    }
  },
})

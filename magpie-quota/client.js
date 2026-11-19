/**
 * magpie allowances, browser half: one page in the right sidebar.
 *
 * magpie tracks what is left of every provider subscription and API key this
 * machine routes through. This plugin shows exactly that: every account, every
 * allowance window, and when each resets.
 *
 * ## Where the page lives
 *
 * The right sidebar is a tab pane. Its one plugin-facing extension point is the
 * `ctx.betterSidebar` service published by `dsh-better-sidebar`: a type
 * registered through `registerTab` also lands in the native right Sidebar's
 * new-tab list. That service is a hard dependency here — declared in `inject`,
 * so a profile without it loads this plugin and registers nothing, rather than
 * showing the same numbers somewhere the person did not ask for.
 *
 * ## Styling
 *
 * A plain-JavaScript plugin gets React from the browser module table and must
 * not load any `@deepseek-ai/dsh-client-*` package as a module, so styling is
 * limited to theme tokens, each written with a plain value as its `var()`
 * fallback: a token this deployment does not define degrades to something
 * legible rather than to an unstyled element.
 *
 * @module dsh-magpie-quota/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-magpie-quota',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'magpieQuota'

    /** The Host route this page reads. */
    const QUOTAS_PATH = '/api/plugin-magpie-quota/quotas'

    /** The right-sidebar tab type this plugin registers. */
    const TAB_ID = 'dsh-magpie-quota'

    /** The class the header's button hangs its hover and focus rules from. */
    const BUTTON_CLASS = 'magpie-quota-btn'

    /**
     * An allowance expiring within this window is called out rather than
     * footnoted: a day is long enough to act on and short enough to notice.
     */
    const EXPIRY_SOON_MS = 24 * 60 * 60 * 1000

    /** How often the page re-reads while it is visible. */
    const REFRESH_MS = 60000

    const en = {
      title: 'Magpie Quotas',
      tabDescription: 'Display Magpie provider quotas',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      updatedAt: 'Updated {when}',
      notRead: 'Not loaded yet',
      noAccounts: 'No quota data',
      remaining: '{pct}% left',
      resetsAt: 'resets {when}',
      expiresAt: 'expires {when}',
      expired: 'expired',
      expiresNow: 'expiring soon',
      expiresInMinutes: 'expires in {n} min',
      expiresInHours: 'expires in {n} h',
      expiresInDays: 'expires in {n} d',
      loading: 'Loading…',
      loadFailed: 'Failed to load quotas: {code}',
      stale: 'Cached data',
      validUntil: 'valid until {when}',
    }
    const zh = {
      title: 'Magpie 额度',
      tabDescription: '显示 Magpie 额度',
      refresh: '刷新',
      refreshing: '刷新中…',
      updatedAt: '更新于 {when}',
      notRead: '尚未加载',
      noAccounts: 'Magpie 暂未返回任何额度数据',
      remaining: '剩余 {pct}%',
      resetsAt: '{when} 重置',
      expiresAt: '{when} 过期',
      expired: '已过期',
      expiresNow: '即将过期',
      expiresInMinutes: '{n} 分钟后过期',
      expiresInHours: '{n} 小时后过期',
      expiresInDays: '{n} 天后过期',
      loading: '加载中…',
      loadFailed: '加载额度失败：{code}',
      stale: '缓存数据',
      validUntil: '有效期至 {when}',
    }

    /**
     * Failure codes the Host can return, in the page's second language.
     *
     * These live outside the locale dictionaries on purpose: they are a closed
     * set the Host produces, not page copy a translator should be inventing
     * keys for, and a code with no line here still reaches the page as itself
     * rather than as a blank.
     */
    const ERROR_TEXT = {
      unreachable: 'Cannot reach Magpie gateway. Make sure Magpie is running.',
      timeout: 'Magpie request timed out.',
      bad_status: 'Magpie returned an error status.',
      bad_json: 'Could not parse response from Magpie.',
      too_large: 'Response from Magpie exceeded the size limit.',
      bad_payload: 'Magpie response did not include quota data.',
      internal: 'Internal error. Check the Harness log for details.',
    }

    /** Failure codes the Host can return, in the page's first language. */
    const ERROR_TEXT_ZH = {
      unreachable: '无法连接 Magpie 网关，请确认应用正在运行。',
      timeout: 'Magpie 请求超时。',
      bad_status: 'Magpie 返回了错误状态。',
      bad_json: '无法解析 Magpie 返回的数据。',
      too_large: 'Magpie 返回的数据超出读取上限。',
      bad_payload: 'Magpie 响应中缺少额度列表。',
      internal: '内部错误，详情见 Harness 日志。',
    }

    /**
     * Theme tokens this page draws with.
     *
     * These are DSH's own design tokens, the same ones `dsh-better-sidebar`'s
     * panels use, so this page inherits the shell's type scale, elevation
     * steps, and hover fills instead of approximating them. Every `var()` keeps
     * a plain fallback: a renamed token degrades the look, never the layout.
     */
    const TOKEN = {
      base: 'var(--dsw-alias-bg-base, transparent)',
      layer1: 'var(--dsw-alias-bg-layer-1, transparent)',
      track: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.18))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
      text: 'var(--dsw-alias-label-primary, #1a1a1a)',
      muted: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #6b6b6b))',
      border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
      focus: 'var(--dsw-alias-brand-primary, #2f6feb)',
      ok: 'var(--dsw-alias-state-success-primary, #1f8f5f)',
      warn: 'var(--dsw-alias-state-warn-primary, #b8791a)',
      low: 'var(--dsw-alias-state-error-primary, #c0392b)',
      idle: 'var(--dsw-alias-state-idle-primary, #9aa0a6)',
      // Font shorthands: weight, size, line-height and family in one token.
      fontXxxs: 'var(--dsw-font-xxxs-11, 400 11px/16px sans-serif)',
      fontXxs: 'var(--dsw-font-xxs-12, 400 12px/18px sans-serif)',
      fontStrong: 'var(--dsw-font-xxs-strong-12, 600 12px/18px sans-serif)',
    }

    /**
     * Namespace-bound translate, assigned by `apply`.
     *
     * Assigned at apply time rather than captured at registration time so the
     * page reads the active dictionary on every render: a language change
     * re-renders with the new text, and the tab title thunk re-resolves without
     * re-registering the type.
     */
    let translate = key => key

    /**
     * Two digits, zero-padded.
     * @param value - a non-negative integer.
     * @returns the padded text.
     */
    function pad2(value) {
      return value < 10 ? `0${value}` : String(value)
    }

    /**
     * One instant as `YYYY-MM-DD HH:MM` in the reader's own clock.
     *
     * Deliberately not `toLocaleString`: a locale decides the clock, and one
     * that prefers 12 hours reintroduces AM/PM beside Chinese text. Every
     * magpie reset time is far enough away that the day matters, so the date is
     * always shown.
     *
     * @param iso - the instant as the Host reported it.
     * @returns the formatted instant, or the empty string when it is not one.
     */
    function when(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      const day = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
      return `${day} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
    }

    /**
     * A percentage truncated to one decimal.
     *
     * Truncated rather than rounded, because rounding reports an account that
     * has spent credits as untouched (`99.94` → `100`) and one with a little
     * left as empty (`0.4` → `0`). Truncation can only ever understate what is
     * left, which is the safe direction to be wrong in about an allowance.
     *
     * @param pct - the percentage, or null.
     * @returns the text, or an em dash when unread.
     */
    /**
     * A number truncated to one decimal, never rounded.
     *
     * Truncating rather than rounding is what keeps `99.94` from reading `100`
     * and `0.4` from reading empty: a balance may only ever be understated.
     * One helper rather than one per caller, so the rule cannot drift between
     * the percentage and the amount beside it.
     *
     * @param value - the number.
     * @returns its text, with a decimal only when it needs one.
     */
    function tenthText(value) {
      const truncated = Math.floor(value * 10) / 10
      return Number.isInteger(truncated) ? String(truncated) : truncated.toFixed(1)
    }

    /** A percentage, or an em dash when magpie reported none. */
    function percentText(pct) {
      return pct === null ? '—' : tenthText(pct)
    }

    /** A remaining quantity, or the empty string when there is nothing to show. */
    function amountText(value) {
      return value === null ? '' : tenthText(value)
    }

    /**
     * How long until an instant, in the reader's own words.
     *
     * A countdown rather than a timestamp because the question this answers is
     * "how long have I got", and the answer is only useful in the unit that
     * fits it — minutes, then hours, then days. The exact instant stays in the
     * row's tooltip.
     *
     * @param iso - the instant as the Host reported it.
     * @returns the countdown text, or the empty string when it is not an instant.
     */
    function countdown(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const at = Date.parse(iso)
      if (Number.isNaN(at)) return ''
      const ms = at - Date.now()
      if (ms <= 0) return t('expired')
      const minutes = Math.floor(ms / 60000)
      if (minutes < 1) return t('expiresNow')
      if (minutes < 60) return t('expiresInMinutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('expiresInHours', { n: hours })
      return t('expiresInDays', { n: Math.floor(hours / 24) })
    }

    /** The interface language, as a two-letter prefix. */
    function uiLanguage() {
      const lang = typeof document === 'undefined' ? '' : (document.documentElement.lang || '')
      return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /** The page's translate call, with `{name}` placeholders filled. */
    function t(key, values) {
      const template = translate(key)
      if (values === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
      ))
    }

    /**
     * One JSON request to the Host route.
     *
     * @param path - the exact route.
     * @returns the decoded payload.
     * @throws {Error} carrying the Host's failure code as `message`.
     */
    async function call(path) {
      const response = await fetch(new URL(path, window.location.origin), {
        credentials: 'same-origin',
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('internal')
      }
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? 'internal')
      return payload
    }

    /**
     * The colour a percentage earns.
     *
     * Thresholds are advisory, not provider policy: magpie reports what is left
     * and nothing about what is comfortable, so the bands are this page's own
     * reading of "fine", "watch", and "nearly out".
     *
     * @param pct - the percentage remaining, or null when unread.
     * @returns the CSS colour.
     */
    function pressureColor(pct) {
      if (pct === null) return TOKEN.idle
      if (pct < 20) return TOKEN.low
      if (pct < 50) return TOKEN.warn
      return TOKEN.ok
    }

    /**
     * Readable failure text for one code.
     *
     * A code with no line in the active language's table still names itself,
     * so a future Host failure is visible rather than silent.
     *
     * @param code - the Host's failure code.
     * @returns the text.
     */
    function errorText(code) {
      const table = uiLanguage() === 'zh' ? ERROR_TEXT_ZH : ERROR_TEXT
      return table[code] ?? t('loadFailed', { code })
    }

    /**
     * Read the allowances, once now and then on an interval.
     *
     * A failed read keeps the last good payload and marks it stale instead of
     * blanking the page: magpie being restarted is not a reason to lose the
     * numbers the person was looking at.
     *
     * `manual` is tracked separately from the read itself so that a click the
     * person just made can acknowledge itself without the interval poll
     * relabelling the Refresh control once a minute — and the control stays
     * enabled while a read is in flight, because disabling it would move
     * keyboard focus off it to the document body mid-interaction.
     *
     * @param active - whether this tab is the visible one. The host pauses a
     *   hidden tab's live views, and a poll that kept running there would ask a
     *   local gateway for numbers nobody is looking at; leaving the effect
     *   uninstalled is also what makes returning to the tab read immediately.
     * @returns the latest snapshot, the manual flag, and refresh.
     */
    function useQuotas(active) {
      const [snapshot, setSnapshot] = useState({ status: 'loading', data: null, error: null })
      const [manual, setManual] = useState(false)
      const [generation, setGeneration] = useState(0)

      useEffect(() => {
        if (!active) return undefined
        let cancelled = false
        let timer = null

        const load = async () => {
          try {
            const payload = await call(QUOTAS_PATH)
            if (cancelled) return
            setSnapshot({ status: 'ready', data: payload, error: null })
          } catch (failure) {
            if (cancelled) return
            setSnapshot(previous => ({
              status: previous.data === null ? 'failed' : 'stale',
              data: previous.data,
              error: failure.message,
            }))
          } finally {
            if (!cancelled) setManual(false)
          }
        }

        const schedule = () => {
          timer = setTimeout(() => {
            // A second gate behind `active`: the browser itself may be
            // hidden, which the sidebar's `visible` cannot know about.
            if (typeof document === 'undefined' || document.visibilityState === 'visible') {
              void load()
            }
            if (!cancelled) schedule()
          }, REFRESH_MS)
        }

        void load()
        schedule()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [generation, active])

      const refresh = useCallback(() => {
        setManual(true)
        setGeneration(previous => previous + 1)
      }, [])
      return { snapshot, manual, refresh }
    }

    /**
     * The page's styles.
     *
     * The vocabulary is `dsh-better-sidebar`'s own, because this page renders
     * inside its pane and must not look like a foreign widget: the `--dsw-font-*`
     * shorthand tokens for every piece of type, the `bg-base` → `bg-layer-1` →
     * `bg-layer-3` elevation steps for surfaces, `border-l1` hairlines for
     * separation, `interactive-bg-hover` for anything clickable, and pill radii
     * for magnitude bars. Each `var()` carries a plain fallback so a token this
     * deployment does not define degrades to a legible value rather than to an
     * unstyled element.
     *
     * The layout follows their sidebar panels: a fixed 36px header row that does
     * not scroll, above a body that owns the scrolling, with full-bleed hairline
     * separators inside each card.
     */
    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        width: '100%',
        // The pane does not scroll for its tabs; each tab body does. `flex` and
        // `minHeight` cover a flex parent, `height` a definite-height one.
        flex: '1 1 auto',
        minHeight: 0,
        height: '100%',
        color: TOKEN.text,
        background: TOKEN.base,
      },
      header: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 36,
        boxSizing: 'border-box',
        padding: '0 8px',
        borderBottom: `1px solid ${TOKEN.border}`,
      },
      headerText: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        font: TOKEN.fontXxxs,
        color: TOKEN.muted,
      },
      staleTag: {
        flex: 'none',
        font: TOKEN.fontXxxs,
        color: TOKEN.warn,
      },
      ghostButton: {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 22,
        padding: '0 8px',
        boxSizing: 'border-box',
        border: 'none',
        borderRadius: 4,
        background: 'transparent',
        color: TOKEN.muted,
        font: TOKEN.fontXxxs,
        cursor: 'pointer',
      },
      body: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '8px',
      },
      banner: {
        flex: 'none',
        padding: '8px 10px',
        boxSizing: 'border-box',
        border: `1px solid ${TOKEN.low}`,
        borderRadius: 8,
        background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.08))',
        color: TOKEN.low,
        font: TOKEN.fontXxxs,
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
      },
      // One account: the card recipe, with rows running full-bleed inside it
      // so the hairlines reach the card's edges.
      card: {
        flex: 'none',
        boxSizing: 'border-box',
        border: `1px solid ${TOKEN.border}`,
        borderRadius: 10,
        background: TOKEN.layer1,
        overflow: 'hidden',
      },
      cardHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        flexWrap: 'wrap',
        padding: '9px 12px',
      },
      cardTitle: {
        flex: 'none',
        font: TOKEN.fontStrong,
        color: TOKEN.text,
      },
      cardMeta: {
        flex: '1 1 auto',
        minWidth: 0,
        font: TOKEN.fontXxxs,
        color: TOKEN.muted,
        overflowWrap: 'anywhere',
      },
      window: {
        padding: '8px 12px',
        borderTop: `1px solid ${TOKEN.border}`,
      },
      windowHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
      },
      windowName: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        font: TOKEN.fontXxs,
        color: TOKEN.text,
      },
      windowValue: {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        font: TOKEN.fontXxxs,
        fontVariantNumeric: 'tabular-nums',
        color: TOKEN.muted,
      },
      pressureDot(color) {
        return {
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          flex: 'none',
        }
      },
      track: {
        height: 4,
        marginTop: 6,
        borderRadius: 999,
        background: TOKEN.track,
        overflow: 'hidden',
      },
      fill(pct, color) {
        return {
          width: `${pct === null ? 0 : pct}%`,
          height: '100%',
          borderRadius: 999,
          background: color,
          transition: 'width 280ms ease',
        }
      },
      windowFoot: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        flexWrap: 'wrap',
        rowGap: 2,
        marginTop: 4,
        font: TOKEN.fontXxxs,
        color: TOKEN.muted,
      },
      // The provider's own figures are the only absolute numbers on the row, so
      // they wrap rather than being ellipsized away.
      windowFigures: {
        flex: '1 1 120px',
        minWidth: 0,
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
      },
      windowReset: { flex: 'none', fontVariantNumeric: 'tabular-nums' },
      // An allowance about to be lost matters more than one about to come
      // back: warning ink inside a day, error ink once it has passed, footnote
      // grey otherwise.
      windowExpiry: { flex: 'none', fontVariantNumeric: 'tabular-nums' },
      notice: {
        padding: '9px 12px',
        font: TOKEN.fontXxxs,
        color: TOKEN.muted,
      },
    }

    /** The page's mark: a disc with half its face filled. */
    function QuotaGlyph(props) {
      const size = props.size ?? 12
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16',
        'aria-hidden': true, focusable: false, style: { display: 'block' },
      },
        h('circle', {
          cx: 8, cy: 8, r: 6,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.55,
        }),
        h('path', { d: 'M8 2a6 6 0 0 1 0 12Z', fill: 'currentColor', opacity: 0.8 }))
    }

    /**
     * One allowance window: its name and percentage, then its bar, the
     * provider's own text, and when it resets.
     */
    /**
     * One allowance window: its name and remaining amount, the magnitude bar,
     * then the provider's own figures and when it resets.
     */
    function WindowRow(props) {
      const window = props.window
      const color = pressureColor(window.remainingPct)
      const reset = window.resetsAt === null
        ? ''
        : t('resetsAt', { when: when(window.resetsAt) })
      // `runsOutAt` is when this allowance stops being spendable, and `runsOut`
      // is how much of it is still there — the pair magpie's own quota view
      // shows. The amount is attached to the expiry rather than to the window,
      // because it is measured against its own bucket: WorkBuddy reports
      // `runsOut: 489.6` beside `limit: 4282` for one window, so printing it as
      // "credits left" would be wrong by an order of magnitude.
      const expiryMs = window.runsOutAt === null ? null : Date.parse(window.runsOutAt)
      const hasExpiry = expiryMs !== null && Number.isFinite(expiryMs)
      const expired = hasExpiry && expiryMs <= Date.now()
      const losingSoon = hasExpiry && !expired && expiryMs - Date.now() <= EXPIRY_SOON_MS
      const amount = amountText(window.runsOut)
      const countdownText = countdown(window.runsOutAt)
      const expiry = countdownText === ''
        ? ''
        : amount === '' ? countdownText : `${amount} · ${countdownText}`
      const expiryTitle = hasExpiry ? t('expiresAt', { when: when(window.runsOutAt) }) : undefined
      const value = window.remainingPct === null
        ? '—'
        : t('remaining', { pct: percentText(window.remainingPct) })
      return h('div', { style: styles.window },
        h('div', { style: styles.windowHead },
          h('span', { style: styles.windowName, title: window.name }, window.name),
          h('span', { style: styles.windowValue },
            h('span', { style: styles.pressureDot(color), 'aria-hidden': true }),
            value)),
        h('div', { style: styles.track, 'aria-hidden': true },
          h('div', { style: styles.fill(window.remainingPct, color) })),
        h('div', { style: styles.windowFoot },
          window.text === ''
            ? null
            : h('span', { style: styles.windowFigures }, window.text),
          expiry === ''
            ? null
            : h('span', {
              style: expired
                ? { ...styles.windowExpiry, color: TOKEN.low }
                : losingSoon ? { ...styles.windowExpiry, color: TOKEN.warn } : styles.windowExpiry,
              title: expiryTitle,
            }, expiry),
          reset === ''
            ? null
            : h('span', { style: styles.windowReset }, reset)))
    }

    /** One account card: who it is, when it is valid until, and every window. */
    function AccountBlock(props) {
      const account = props.account
      // magpie repeats the account name inside `plan` and `user` for some
      // providers ("已登录", "LLMBox · 当前登录"); showing it twice reads as two
      // different facts.
      const meta = [account.plan, account.user]
        .filter(value => value !== null && value !== '' && !value.includes(account.name))
      if (account.until !== null) meta.push(t('validUntil', { when: when(account.until) }))
      return h('section', { style: styles.card, className: 'magpie-quota-card' },
        h('div', { style: styles.cardHead },
          h('span', { style: styles.cardTitle }, account.name),
          meta.length === 0
            ? null
            : h('span', { style: styles.cardMeta }, meta.join(' · '))),
        account.windows.map((window, index) => h(WindowRow, {
          key: `${window.name}#${index}`,
          window,
        })))
    }

    /** Small refresh glyph for the header action. */
    function RefreshGlyph(props) {
      return h('svg', {
        width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
        className: props.spin ? 'magpie-quota-spin' : undefined,
      },
        h('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
        h('path', { d: 'M20 4v5h-5' }))
    }

    /** The hover and focus treatments, which inline styles cannot express.
     *
     * Rendered as a React element so unmounting removes it, and written only in
     * theme tokens so both themes follow.
     */
    function PageStyles() {
      const css = [
        `@keyframes magpie-quota-spin { to { transform: rotate(360deg); } }`,
        `.magpie-quota-spin { animation: magpie-quota-spin 0.8s linear infinite; }`,
        `.${BUTTON_CLASS} { transition: background 120ms ease, color 120ms ease; }`,
        `.${BUTTON_CLASS}:hover { background: ${TOKEN.hover}; color: ${TOKEN.text}; }`,
        `.${BUTTON_CLASS}:focus-visible { outline: 2px solid ${TOKEN.focus}; outline-offset: 1px; }`,
        `.${BUTTON_CLASS}[aria-disabled="true"]:hover { background: transparent; color: ${TOKEN.muted}; }`,
        '.magpie-quota-card { transition: border-color 140ms ease; }',
        `.magpie-quota-card:hover { border-color: var(--dsw-alias-border-l2, ${TOKEN.border}) !important; }`,
        '.magpie-quota-body { scrollbar-width: thin; }',
      ].join('\n')
      return h('style', { 'data-plugin-css': 'dsh-magpie-quota' }, css)
    }

    /** The right-sidebar page: a fixed header, then every account and window. */
    function MagpieTab(props) {
      // `visible` is "this tab is active AND the panel is open". Older hosts
      // pass nothing, and an absent prop must mean visible, not hidden.
      const active = !props || props.visible !== false
      const { snapshot, manual, refresh } = useQuotas(active)
      const data = snapshot.data
      const accounts = data === null || !Array.isArray(data.accounts) ? [] : data.accounts
      const failed = snapshot.error !== null

      const readAtText = data === null || data.readAt === null
        ? t('notRead')
        : t('updatedAt', { when: when(data.readAt) })

      let body
      if (data === null && !failed) {
        body = h('div', { style: styles.notice }, t('loading'))
      } else if (accounts.length === 0) {
        body = h('div', { style: styles.notice }, t('noAccounts'))
      } else {
        body = accounts.map((account, index) => h(AccountBlock, {
          key: `${account.provider}#${index}`,
          account,
        }))
      }

      return h('div', { style: styles.page },
        h(PageStyles),
        h('div', { style: styles.header },
          h('span', { style: styles.headerText }, readAtText),
          snapshot.status === 'stale'
            ? h('span', { style: styles.staleTag }, t('stale'))
            : null,
          h('button', {
            type: 'button',
            className: BUTTON_CLASS,
            style: styles.ghostButton,
            'aria-disabled': manual ? true : undefined,
            onClick: () => {
              if (!manual) refresh()
            },
          }, h(RefreshGlyph, { spin: manual }), manual ? t('refreshing') : t('refresh'))),
        h('div', { style: styles.body, className: 'magpie-quota-body' },
          failed
            ? h('div', { style: styles.banner }, errorText(snapshot.error))
            : null,
          body))
    }

    return {
      /**
       * Hard dependencies.
       *
       * `betterSidebar` is the right sidebar's only plugin-facing extension
       * point, and this plugin's whole result is a page there. Declaring it
       * rather than probing for it means a profile without that bundle loads
       * this one and registers nothing — visible in the Plugins page, instead
       * of a page that quietly never appears somewhere else.
       */
      inject: ['locale', 'betterSidebar'],
      apply(ctx) {
        translate = ctx.locale.bind(NS)
        ctx.effect(
          () => ctx.locale.register(NS, { en, zh }),
          'magpie-quota: dictionaries',
        )
        ctx.effect(
          () => ctx.betterSidebar.registerTab({
            id: TAB_ID,
            // Thunks, so a language change re-resolves the label without
            // re-registering the tab type.
            title: () => translate('title'),
            description: () => translate('tabDescription'),
            icon: size => h(QuotaGlyph, { size }),
            order: 60,
            single: true,
            component: MagpieTab,
          }),
          'magpie-quota: right sidebar page',
        )
      },
    }
  },
})

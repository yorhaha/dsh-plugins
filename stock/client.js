/**
 * dsh-stock Client half — the conversation card for one of the quote tools, and
 * the watchlist panel the sidebar opens.
 *
 * `stock_quote` and `stock_watchlist` normally render as the generic Tool row.
 * This module claims those keys of the open `tool.call.toolview` slot and draws
 * the settled result as data the row already carries: a card is derived from the
 * single JSON text block the Host tool returned, so nothing is fetched, nothing
 * is duplicated into result metadata, and replaying an old Session renders the
 * same card.
 *
 * The panel is the one surface that talks to the Host: it reads and mutates the
 * watchlist over the bundle's own `/api` route, which serves quotes through the
 * Host's serialized client rather than letting the browser reach upstream. It
 * registers both halves of the panel — the sidebar entry and the page it opens —
 * and one `shell.overlay` entry that announces an edit's outcome, so the notice
 * outlives the panel that asked for it.
 *
 * Every derivation is defensive. Malformed text, a failed call, or an empty
 * item list falls back to a plain row with the raw text behind a disclosure.
 * The components must not throw: a throwing entry blanks the whole Chat row.
 *
 * Colors come from theme tokens; copy comes from this package's own locale
 * namespace, registered in `apply`.
 *
 * @module dsh-stock/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-stock',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const {
      Button,
      IconChevronDownOutlineRegular,
      IconChevronLeftOutlineRegular,
      IconChevronRightOutlineRegular,
      IconChevronUpOutlineRegular,
      IconCloseOutlineRegular,
      IconEllipsisOutlineMedium,
      IconGaugeOutlineRegular,
      IconPauseOutlineRegular,
      IconPinOutlineRegular,
      IconPlayOutlineRegular,
      IconPlusOutlineRegular,
      IconRefreshOutlineRegular,
      IconSearchOutlineRegular,
      IconTrashOutlineRegular,
      IconWarningOutlineRegular,
      Input,
      Menu,
      StateDot,
      Tag,
      Toast,
      Tooltip,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Dictionary namespace owned by this package. */
    const NS = 'stock'

    /** The sidebar entry and the panel page it opens, which the sidebar pairs by id. */
    const PANEL_ID = 'watchlist'

    /** Host route, document-relative so a Harness mounted under a sub-path still reaches it. */
    const ROUTE = 'api/plugin-stock/watchlist'

    /** Shortest keyword the search box sends, so a first keystroke does not query upstream. */
    const SEARCH_MIN_CHARS = 2

    /** How long typing settles before the search box asks the Host, in milliseconds. */
    const SEARCH_DEBOUNCE_MS = 400

    /**
     * Where this page keeps its own switches. The panel is unmounted whenever
     * the sidebar opens another page, so a switch held only in memory would
     * reset on every visit.
     */
    const SETTINGS_KEY = 'dsh.stock.watchlist.settings'

    /** The switches a document that has never been to this page starts with. */
    const SETTINGS_DEFAULTS = { autoRefresh: true }

    /**
     * Read the page's stored switches. Storage that refuses to be read — it is
     * unavailable in some embedded documents — falls back to the defaults.
     *
     * @returns the stored switches, or the defaults.
     */
    function readSettings() {
      try {
        const stored = window.localStorage.getItem(SETTINGS_KEY)
        if (stored === null) return { ...SETTINGS_DEFAULTS }
        const parsed = JSON.parse(stored)
        return { autoRefresh: typeof parsed?.autoRefresh === 'boolean' ? parsed.autoRefresh : SETTINGS_DEFAULTS.autoRefresh }
      } catch {
        // Unreadable or malformed storage is not worth reporting: the page's own
        // defaults are always usable.
        return { ...SETTINGS_DEFAULTS }
      }
    }

    /**
     * Store the page's switches. A document that refuses the write keeps the
     * choice for as long as the page is open.
     *
     * @param settings - the switches to store.
     */
    function writeSettings(settings) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch {
        // A private-mode or full-quota document refuses the write; the page
        // still follows the choice it was just given.
      }
    }

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'quote.title': '实时行情',
      'watchlist.title': '自选股',
      'index.title': '指数',
      'action.raw': '原始数据',
      'action.hide': '收起',
      'state.running': '读取中…',
      'state.failed': '调用失败',
      'state.empty': '上游没有返回可显示的数据。',
      'state.noItems': '没有可显示的行情。',
      'quote.summary': '{count} 个代码',
      'watchlist.summary': '{count} 只自选',
      'index.summary': '{count} 个指数',
      'quote.missing': '上游未返回：{codes}',
      'metric.open': '今开',
      'metric.prevClose': '昨收',
      'metric.high': '最高',
      'metric.low': '最低',
      'metric.volume': '成交量',
      'metric.amount': '成交额',
      'metric.turnover': '换手率',
      'metric.pe': '市盈率',
      'metric.pb': '市净率',
      'metric.marketCap': '总市值',
      'metric.floatCap': '流通市值',
      'metric.amplitude': '振幅',
      'metric.limitUp': '涨停',
      'metric.limitDown': '跌停',
      'metric.high52w': '52 周最高',
      'metric.low52w': '52 周最低',
      'book.bid': '买',
      'book.ask': '卖',
      'unit.lot': '手',
      'unit.share': '股',
      'format.system': 'cn',
      'panel.title': '自选股',
      'panel.count': '{count} 只',
      'panel.add': '添加自选',
      'panel.clear': '清空自选股',
      'panel.clearConfirm': '清空全部自选股？此操作不可撤销。',
      'panel.cleared': '已清空自选股',
      'panel.refresh': '刷新行情',
      'panel.autoPause': '暂停自动刷新',
      'panel.autoResume': '开启自动刷新',
      'panel.autoEvery': '每 {seconds} 秒自动刷新',
      'panel.autoPaused': '自动刷新已暂停',
      'panel.actions': '更多操作',
      'panel.moveUp': '上移',
      'panel.moveDown': '下移',
      'panel.moveLeft': '左移',
      'panel.moveRight': '右移',
      'panel.remove': '删除',
      'panel.indices': '指数',
      'panel.indexAdd': '添加指数',
      'panel.indexEmptyHint': '指数行还是空的，点右上角加一个。',
      'panel.indexClear': '清空指数行',
      'panel.indexClearConfirm': '清空全部指数？此操作不可撤销。',
      'panel.indexCleared': '已清空指数行',
      'panel.indexAdded': '已加入指数：{name}',
      'panel.indexRemoved': '已移出指数：{name}',
      'panel.indexAddFailed': '添加指数失败 —— {reason}',
      'panel.indexRemoveFailed': '删除指数失败 —— {reason}',
      'panel.indexMoveFailed': '指数排序失败 —— {reason}',
      'panel.indexClearFailed': '清空指数失败 —— {reason}',
      'panel.indexSearchPlaceholder': '指数名称或代码',
      'panel.indexSearchEmpty': '没有匹配的指数。',
      'panel.trading': '交易中（{markets}）',
      'panel.closed': '已收盘',
      'panel.updated': '更新于 {time}',
      'panel.loading': '正在读取自选股…',
      'panel.empty': '还没有自选股',
      'panel.emptyHint': '搜索代码或名称，把第一只加进来。',
      'panel.searchPlaceholder': '代码、名称或拼音',
      'panel.searchClose': '收起搜索',
      'panel.searchHint': '至少输入 {count} 个字符。',
      'panel.searchEmpty': '没有匹配的证券。',
      'panel.searchAdd': '加入',
      'panel.noQuote': '无行情',
      'panel.invalidCode': '代码无效',
      'panel.sparkline': '当日分时',
      'panel.position': '持仓',
      'panel.mark': '标记持仓',
      'panel.editPosition': '编辑持仓',
      'panel.unmark': '取消持仓',
      'panel.positionCostLabel': '成本价（可留空）',
      'panel.positionQuantityLabel': '数量（可留空）',
      'panel.positionSave': '保存',
      'panel.positionCancel': '取消',
      'panel.positionInvalid': '成本价与数量都要是正数，或留空。',
      'panel.positionCost': '成本 {value}',
      'panel.positionQuantity': '数量 {value}',
      'panel.positionValue': '市值 {value}',
      'panel.positionProfit': '盈亏 {amount}（{percent}）',
      'panel.positionProfitBare': '{amount}（{percent}）',
      'panel.positionReturn': '收益率 {percent}',
      'panel.marked': '已标记持仓：{name}',
      'panel.unmarked': '已取消持仓：{name}',
      'panel.markFailed': '标记持仓失败 —— {reason}',
      'panel.unmarkFailed': '取消持仓失败 —— {reason}',
      'panel.autoNextOpen': '下次开盘 {time} 自动刷新',
      'panel.autoClosed': '休市期间不自动刷新',
      'panel.loadFailed': '读取自选股失败 —— {reason}',
      'panel.quotesFailed': '{count} 个代码的行情没取到 —— {reason}',
      'panel.retry': '重试',
      'panel.added': '已加入自选：{name}',
      'panel.addDuplicate': '列表里已有「{name}」',
      'panel.addFull': '列表已满，没有加入「{name}」',
      'panel.removed': '已移出自选：{name}',
      'panel.addFailed': '添加失败 —— {reason}',
      'panel.removeFailed': '删除失败 —— {reason}',
      'panel.moveFailed': '排序失败 —— {reason}',
      'panel.clearFailed': '清空失败 —— {reason}',
      'panel.searchFailed': '搜索失败 —— {reason}',
      'errors.unknown': '意外失败（{code}）',
      'errors.unreachable': '连不上 Harness，它还在运行吗？',
      'errors.invalid_body': 'Harness 无法解析这次请求',
      'errors.invalid_json': 'Harness 无法解析这次请求',
      'errors.invalid_code': '这不是本插件能查询的代码',
      'errors.invalid_keyword': '关键词不合法',
      'errors.invalid_position': '目标位置不存在',
      'errors.invalid_position_value': '成本价与数量需为正数',
      'errors.unknown_action': 'Harness 不认识这个操作',
      'errors.body_too_large': '请求体过大',
      'errors.internal': 'Harness 内部错误',
    }

    /** English dictionary, complete against the Chinese key set. */
    const en = {
      'quote.title': 'Quote snapshot',
      'watchlist.title': 'Watchlist',
      'index.title': 'Indexes',
      'action.raw': 'Raw data',
      'action.hide': 'Collapse',
      'state.running': 'Reading…',
      'state.failed': 'The call failed',
      'state.empty': 'Upstream returned no data this card can show.',
      'state.noItems': 'No quote to show.',
      'quote.summary': '{count} codes',
      'watchlist.summary': '{count} followed',
      'index.summary': '{count} indexes',
      'quote.missing': 'Not returned upstream: {codes}',
      'metric.open': 'Open',
      'metric.prevClose': 'Prev close',
      'metric.high': 'High',
      'metric.low': 'Low',
      'metric.volume': 'Volume',
      'metric.amount': 'Amount',
      'metric.turnover': 'Turnover',
      'metric.pe': 'PE (TTM)',
      'metric.pb': 'PB',
      'metric.marketCap': 'Market cap',
      'metric.floatCap': 'Float cap',
      'metric.amplitude': 'Amplitude',
      'metric.limitUp': 'Limit up',
      'metric.limitDown': 'Limit down',
      'metric.high52w': '52w high',
      'metric.low52w': '52w low',
      'book.bid': 'Bid',
      'book.ask': 'Ask',
      'unit.lot': 'lots',
      'unit.share': 'shares',
      'format.system': 'western',
      'panel.title': 'Watchlist',
      'panel.count': '{count} followed',
      'panel.add': 'Add',
      'panel.clear': 'Clear the watchlist',
      'panel.clearConfirm': 'Remove every followed security? This cannot be undone.',
      'panel.cleared': 'The watchlist is empty',
      'panel.refresh': 'Refresh quotes',
      'panel.autoPause': 'Pause auto-refresh',
      'panel.autoResume': 'Start auto-refresh',
      'panel.autoEvery': 'Auto-refreshes every {seconds}s',
      'panel.autoPaused': 'Auto-refresh paused',
      'panel.actions': 'More actions',
      'panel.moveUp': 'Move up',
      'panel.moveDown': 'Move down',
      'panel.moveLeft': 'Move left',
      'panel.moveRight': 'Move right',
      'panel.remove': 'Remove',
      'panel.indices': 'Indexes',
      'panel.indexAdd': 'Add index',
      'panel.indexEmptyHint': 'No index yet; add one from the top right.',
      'panel.indexClear': 'Clear the index row',
      'panel.indexClearConfirm': 'Remove every index? This cannot be undone.',
      'panel.indexCleared': 'The index row is empty',
      'panel.indexAdded': 'Added the index {name}',
      'panel.indexRemoved': 'Removed the index {name}',
      'panel.indexAddFailed': 'Could not add the index — {reason}',
      'panel.indexRemoveFailed': 'Could not remove the index — {reason}',
      'panel.indexMoveFailed': 'Could not reorder the indexes — {reason}',
      'panel.indexClearFailed': 'Could not clear the indexes — {reason}',
      'panel.indexSearchPlaceholder': 'Index name or code',
      'panel.indexSearchEmpty': 'No matching index.',
      'panel.trading': 'Trading ({markets})',
      'panel.closed': 'Market closed',
      'panel.updated': 'Updated {time}',
      'panel.loading': 'Reading the watchlist…',
      'panel.empty': 'No followed security yet',
      'panel.emptyHint': 'Search a code or a name to add the first one.',
      'panel.searchPlaceholder': 'Code, name, or pinyin',
      'panel.searchClose': 'Close the search',
      'panel.searchHint': 'Type at least {count} characters.',
      'panel.searchEmpty': 'No matching security.',
      'panel.searchAdd': 'Add',
      'panel.noQuote': 'No quote',
      'panel.invalidCode': 'Unusable code',
      'panel.sparkline': 'Intraday trend',
      'panel.position': 'Holding',
      'panel.mark': 'Mark as held',
      'panel.editPosition': 'Edit holding',
      'panel.unmark': 'Clear holding',
      'panel.positionCostLabel': 'Cost per share (optional)',
      'panel.positionQuantityLabel': 'Shares (optional)',
      'panel.positionSave': 'Save',
      'panel.positionCancel': 'Cancel',
      'panel.positionInvalid': 'Cost and shares must be positive numbers, or left blank.',
      'panel.positionCost': 'Cost {value}',
      'panel.positionQuantity': 'Shares {value}',
      'panel.positionValue': 'Value {value}',
      'panel.positionProfit': 'P/L {amount} ({percent})',
      'panel.positionProfitBare': '{amount} ({percent})',
      'panel.positionReturn': 'Return {percent}',
      'panel.marked': 'Marked {name} as held',
      'panel.unmarked': 'Cleared the holding on {name}',
      'panel.markFailed': 'Could not mark the holding — {reason}',
      'panel.unmarkFailed': 'Could not clear the holding — {reason}',
      'panel.autoNextOpen': 'Auto-refreshes when the market opens at {time}',
      'panel.autoClosed': 'No auto-refresh while the market is closed',
      'panel.loadFailed': 'Could not read the watchlist — {reason}',
      'panel.quotesFailed': 'No quote for {count} codes — {reason}',
      'panel.retry': 'Retry',
      'panel.added': 'Added {name}',
      'panel.addDuplicate': '"{name}" is already in the list',
      'panel.addFull': 'The list is full; "{name}" was not added',
      'panel.removed': 'Removed {name}',
      'panel.addFailed': 'Could not add it — {reason}',
      'panel.removeFailed': 'Could not remove it — {reason}',
      'panel.moveFailed': 'Could not reorder it — {reason}',
      'panel.clearFailed': 'Could not clear the list — {reason}',
      'panel.searchFailed': 'Search failed — {reason}',
      'errors.unknown': 'unexpected failure ({code})',
      'errors.unreachable': 'The Harness is not reachable; is it still running?',
      'errors.invalid_body': 'the Harness could not read the request',
      'errors.invalid_json': 'the Harness could not read the request',
      'errors.invalid_code': 'this plugin cannot query that code',
      'errors.invalid_keyword': 'that keyword is not usable',
      'errors.invalid_position': 'that position does not exist',
      'errors.invalid_position_value': 'cost and shares must be positive numbers',
      'errors.unknown_action': 'the Harness does not know that action',
      'errors.body_too_large': 'the request was too large',
      'errors.internal': 'the Harness failed internally',
    }

    /**
     * The narrow-panel layout, shared by both queries below: the viewport one
     * for a phone, and the container one for a panel squeezed inside a wide
     * window (the main column can fall well below the frame width). Keeping one
     * copy means the two paths can never drift.
     */
    const NARROW_CSS = `
/* Header: the market line drops below the title and tools instead of squeezing
   them, and the frame's side air shrinks. */
.dsh-stock-panel-head { flex-wrap: wrap; gap: 6px 8px; padding: 12px 14px; }
.dsh-stock-panel-title { font-size: 18px; line-height: 24px; }
.dsh-stock-panel-status { flex: 1 1 100%; order: 9; font-size: 12px; line-height: 17px; }
.dsh-stock-panel-tools { gap: 4px; }
.dsh-stock-panel-search { padding: 10px 14px; }
/* A followed security becomes a small card: the name line keeps its menu on
   the right, then the price and day change span the full width, then the
   intraday line sits under them rather than in a fixed side column. */
.dsh-stock-panel-body { padding: 4px 8px calc(16px + env(safe-area-inset-bottom, 0px)); }
.dsh-stock-panel-row { flex-wrap: wrap; align-items: flex-start; column-gap: 10px; row-gap: 4px; padding: 12px 10px; margin: 0 -6px; }
.dsh-stock-panel-row + .dsh-stock-panel-row::before { inset-inline: 10px; }
/* display:contents lifts the name line, the metrics, and the position editor out of
   their wrapper so the row's own order can put the price above them. */
.dsh-stock-panel-main { display: contents; }
.dsh-stock-panel-row .dsh-stock-panel-line { order: 1; flex: 1 1 auto; min-width: 0; }
.dsh-stock-row-menu { order: 2; flex: none; align-self: flex-start; }
.dsh-stock-panel-price { order: 3; flex: 1 1 100%; min-width: 0; padding-top: 2px; }
.dsh-stock-panel-row .dsh-stock-sparkline { order: 4; flex: 1 1 100%; width: 100%; height: 34px; }
.dsh-stock-panel-row .dsh-stock-panel-metrics { order: 5; flex: 1 1 100%; }
.dsh-stock-panel-row .dsh-stock-panel-position-form { order: 6; flex: 1 1 100%; }
.dsh-stock-panel-change { min-width: 0; }
/* The index row keeps two compact columns rather than one tall stack. Each
   cell shrinks its figures and lets the day's change take its own line, so the
   intraday line gets the cell's width instead of a sliver beside the numbers. */
.dsh-stock-panel-indices { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); padding: 2px 4px 4px; }
.dsh-stock-index { max-width: none; padding: 7px 8px; }
.dsh-stock-index-body { flex-wrap: wrap; gap: 4px 8px; }
.dsh-stock-index-figures { display: contents; }
.dsh-stock-index .dsh-stock-index-price { order: 1; flex: none; font-size: 15px; line-height: 20px; }
.dsh-stock-index .dsh-stock-index-placeholder { order: 1; flex: none; font-size: 11px; line-height: 18px; }
.dsh-stock-index .dsh-stock-sparkline { order: 2; flex: 1 1 48px; min-width: 48px; height: 30px; }
.dsh-stock-index .dsh-stock-index-change { order: 3; flex: 1 1 100%; font-size: 10px; line-height: 15px; padding: 0 5px; }
.dsh-stock-panel-group-head { padding: 4px; }
`
    /** The narrowest phones lose a little more air and column width. */
    const TINY_CSS = `
.dsh-stock-panel-head { padding: 10px 12px; }
.dsh-stock-panel-title { font-size: 17px; line-height: 22px; }
.dsh-stock-panel-body { padding: 2px 6px calc(14px + env(safe-area-inset-bottom, 0px)); }
.dsh-stock-panel-row { padding: 10px 8px; margin: 0 -4px; }
.dsh-stock-panel-row + .dsh-stock-panel-row::before { inset-inline: 8px; }
.dsh-stock-panel-metrics { grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 2px 10px; }
.dsh-stock-panel-price-value { font-size: 15px; }
.dsh-stock-panel-indices { grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); }
.dsh-stock-index .dsh-stock-index-price { font-size: 14px; line-height: 19px; }
.dsh-stock-index .dsh-stock-sparkline { min-width: 42px; height: 28px; }
.dsh-stock-index .dsh-stock-index-change { font-size: 10px; padding: 0 4px; }
.dsh-stock-panel-row .dsh-stock-sparkline { height: 30px; }
`

    /**
     * Stylesheet for the card and the panel. Every color is a theme token: the
     * shared `--dsw-*` semantic aliases, never a literal, so both themes follow
     * the theme owner.
     */
    const CSS = `
.dsh-stock-card { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-stock-head { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; }
.dsh-stock-icon { display: inline-flex; flex: none; color: var(--dsw-alias-label-secondary); }
.dsh-stock-title { flex: none; font-weight: 600; }
.dsh-stock-summary { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.dsh-stock-toggle { flex: none; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; }
.dsh-stock-toggle:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dsh-stock-note { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-stock-note.is-error { color: var(--dsw-alias-state-error-primary); }
.dsh-stock-raw { max-height: 240px; margin: 0; padding: 8px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-all; }
.dsh-stock-quotes { display: flex; flex-direction: column; gap: 10px; }
.dsh-stock-quote { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-stock-quote:first-child { padding-top: 0; border-top: none; }
.dsh-stock-quote-head { display: flex; align-items: baseline; gap: 8px; }
.dsh-stock-quote-name { font-size: 13px; font-weight: 600; }
.dsh-stock-quote-code { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-stock-quote-price { margin-left: auto; font-size: 18px; font-variant-numeric: tabular-nums; }
.dsh-stock-quote-change { font-variant-numeric: tabular-nums; }
.dsh-stock-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 4px 12px; }
.dsh-stock-metric { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 18px; }
.dsh-stock-metric-label { color: var(--dsw-alias-label-secondary); }
.dsh-stock-metric-value { font-variant-numeric: tabular-nums; }
.dsh-stock-book { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; font-size: 12px; line-height: 18px; }
.dsh-stock-book-side { display: flex; flex-direction: column; }
.dsh-stock-book-row { display: flex; justify-content: space-between; gap: 8px; font-variant-numeric: tabular-nums; }
.dsh-stock-book-row .label { color: var(--dsw-alias-label-secondary); }
/* The page surface. One inline axis governs everything on it: the head, a
   group's heading, and a row's own content all start at 20px from the panel's
   leading edge, so nothing steps left or right between sections. */
.dsh-stock-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); container-type: inline-size; container-name: stock-panel; }
/* The page reaches the window's top-left corner. While the sidebar column is
   hidden the frame publishes the band its chrome occupies, and the whole page
   moves clear of it; the variable is absent otherwise. */
html[data-platform='darwin'] .dsh-stock-panel { padding-inline-start: var(--dsh-frame-leading-clearance, 0px); }
.dsh-stock-panel-head { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
/* macOS keeps its titlebar inside the frame's top strip, over the page. */
html[data-platform='darwin'] .dsh-stock-panel-head { padding-top: calc(14px + var(--dsh-frame-top-clearance, 0px)); }
.dsh-stock-panel-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
/* A capsule keeps the page title's line box only at this geometry. */
.dsh-stock-panel-count { height: 18px; padding: 0 7px; font-size: 10px; line-height: 1; font-variant-numeric: tabular-nums; }
.dsh-stock-panel-status { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.dsh-stock-panel-tools { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.dsh-stock-panel-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-caption); cursor: pointer; }
.dsh-stock-panel-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dsh-stock-panel-icon:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dsh-stock-panel-icon:disabled { opacity: 0.5; cursor: default; }
/* A switch that is on holds its ink up at rest, so the page reads as polling
   before the pointer arrives. */
.dsh-stock-panel-icon[aria-pressed='true'] { color: var(--dsw-alias-label-secondary); }
.dsh-stock-panel-icon[aria-pressed='true']:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsh-stock-panel-search { display: flex; flex-direction: column; gap: 8px; padding: 12px 20px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-stock-panel-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-stock-panel-results { display: flex; flex-direction: column; max-height: 240px; overflow: auto; }
.dsh-stock-panel-result { display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-stock-panel-result:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-stock-panel-result-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-stock-panel-result-code { color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dsh-stock-panel-result-add { margin-left: auto; color: var(--dsw-alias-brand-primary); font-size: 12px; }
.dsh-stock-panel-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 12px 16px; }
/* One followed security. A row is a reading target, not a control: every action
   it has lives behind its own menu, and the row's box only tracks the pointer. */
.dsh-stock-panel-row { position: relative; display: flex; align-items: center; gap: 12px; margin: 0 -8px; padding: 10px 16px; border-radius: var(--dsw-radius-md); }
.dsh-stock-panel-row + .dsh-stock-panel-row::before { content: ''; position: absolute; inset-inline: 16px; top: 0; height: 0.5px; background: var(--dsw-alias-border-l2); }
@media (hover: hover) { .dsh-stock-panel-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-stock-panel-main { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 2px; }
.dsh-stock-panel-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dsh-stock-panel-name { font-size: 13px; line-height: 18px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-stock-panel-code { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 18px; font-variant-numeric: tabular-nums; }
/* The day's figures in fixed columns, so the same metric reads straight down
   the page. A field the quote does not carry keeps its cell and shows a dash:
   the columns must not shift from one row to the next. The cap is three columns
   wide enough for a five-digit price; a narrower panel wraps them instead. */
.dsh-stock-panel-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: 2px 16px; max-width: 368px; }
.dsh-stock-panel-metric { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.dsh-stock-panel-metric-label { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 18px; }
.dsh-stock-panel-metric-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.dsh-stock-sparkline { display: block; flex: none; width: 68px; height: 26px; color: var(--dsw-alias-label-secondary); }
.dsh-stock-sparkline.up { color: var(--dsw-alias-state-error-primary); }
.dsh-stock-sparkline.down { color: var(--dsw-alias-state-success-primary); }
.dsh-stock-sparkline-line { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.dsh-stock-sparkline-baseline { stroke: var(--dsw-alias-border-l2); stroke-width: 1; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
/* The latest price and the day's change, with a marked holding's own figures
   beneath them. The block is right-aligned in the row and uses the row's
   existing second line; its children fill the block so the figures start under
   the price's left edge. */
.dsh-stock-panel-price { display: flex; flex: none; flex-direction: column; align-items: stretch; justify-content: center; min-width: 212px; }
.dsh-stock-panel-price-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dsh-stock-panel-price-value { font-size: 16px; line-height: 20px; font-variant-numeric: tabular-nums; }
.dsh-stock-panel-change { min-width: 104px; justify-content: center; font-variant-numeric: tabular-nums; }
.dsh-stock-panel-placeholder { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 12px; }
/* A holding mark: the badge sits with the name; its bare figures sit in the
   price block, so a marked row keeps the columns the unmarked rows use. */
.dsh-stock-panel-pill { flex: none; height: 18px; padding: 0 6px; font-size: 11px; line-height: 1; }
/* Bare holding figures: cost at the left edge, the profit or value at the
   right. The element's title names each figure and carries its currency. */
.dsh-stock-panel-position { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-stock-panel-position-profit.up { color: var(--dsw-alias-state-error-primary); }
.dsh-stock-panel-position-profit.down { color: var(--dsw-alias-state-success-primary); }
.dsh-stock-panel-position-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 10px; margin-top: 4px; }
.dsh-stock-panel-position-fields { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-stock-panel-field { display: flex; flex-direction: column; gap: 2px; }
.dsh-stock-panel-field-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-stock-panel-field-input { width: 104px; }
.dsh-stock-panel-position-actions { display: flex; align-items: center; gap: 6px; }
.dsh-stock-panel-form-hint { flex-basis: 100%; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 16px; }
/* The market's own row above the followed securities. */
.dsh-stock-panel-group { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 10px; padding-bottom: 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-stock-panel-group-head { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
.dsh-stock-panel-group-title { font-size: 13px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dsh-stock-panel-group-count { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.dsh-stock-panel-group-tools { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.dsh-stock-panel-group-empty { padding: 2px 8px 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
/* One index cell: equal tracks, capped, so a short row keeps the strip's shape
   instead of stretching two cells across the page. */
.dsh-stock-panel-indices { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; padding: 2px 8px 6px; }
.dsh-stock-index { display: flex; max-width: 260px; flex-direction: column; gap: 2px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); }
.dsh-stock-index-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dsh-stock-index-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-stock-index .dsh-stock-panel-icon { flex: none; width: 22px; height: 22px; border-radius: var(--dsw-radius-sm); }
.dsh-stock-index-body { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-stock-index-figures { display: flex; flex: none; flex-direction: column; gap: 2px; }
.dsh-stock-index-price { font-size: 18px; line-height: 24px; font-variant-numeric: tabular-nums; }
.dsh-stock-index-placeholder { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-stock-index-change { align-self: flex-start; font-variant-numeric: tabular-nums; }
/* The index line takes the width the figures leave, so the strip reads as a
   row of small charts rather than a row of identical fixed boxes. */
.dsh-stock-index .dsh-stock-sparkline { flex: 1 1 auto; width: auto; min-width: 32px; height: 30px; }
.dsh-stock-panel-notice { display: flex; align-items: center; gap: 8px; margin: 4px 8px 10px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
/* A state-colored border is a real border: it keeps the full hairline weight. */
.dsh-stock-panel-notice.is-error { border-width: 1px; border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-stock-panel-center { display: flex; flex: 1 1 auto; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 32px 20px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.dsh-stock-panel-center-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; }
.dsh-stock-panel-center-body { max-width: 320px; }
/* A narrow panel: phones by viewport, and any squeezed main column by container
   width. Both paths carry the same rules so neither can fall behind. */
@media (max-width: 640px) {${NARROW_CSS}}
@container stock-panel (max-width: 640px) {${NARROW_CSS}}
@media (max-width: 420px) {${TINY_CSS}}
@container stock-panel (max-width: 420px) {${TINY_CSS}}
/* Touch screens: a bigger hit target than the pointer-tuned 28px control. */
@media (pointer: coarse) {
  .dsh-stock-panel-icon { width: 34px; height: 34px; }
  .dsh-stock-index .dsh-stock-panel-icon { width: 30px; height: 30px; }
  .dsh-stock-panel-result { padding: 10px 8px; }
}
/* The conversation card at phone width: its summary wraps under the title
   instead of being clipped, and its metric grid keeps two readable columns. */
@media (max-width: 640px) {
  .dsh-stock-card { padding: 8px; }
  .dsh-stock-head { flex-wrap: wrap; }
  .dsh-stock-summary { flex-basis: 100%; order: 5; white-space: normal; }
  .dsh-stock-metrics { grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 4px 10px; }
}
`

    // ── shared derivations ────────────────────────────────────────────────────

    /**
     * Read the settled result value of one Tool block.
     *
     * @param block - the phase's Tool block.
     * @returns the parsed `ok: true` payload, or null when the card must fall back.
     */
    function resultValue(block) {
      if (typeof block !== 'object' || block === null) return null
      if (block.isError === true) return null
      if (!Array.isArray(block.content) || block.content.length !== 1) return null
      const only = block.content[0]
      if (typeof only !== 'object' || only === null || only.type !== 'text') return null
      if (typeof only.text !== 'string') return null
      let parsed
      try {
        parsed = JSON.parse(only.text)
      } catch {
        return null
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      if (parsed.ok !== true) return null
      return parsed
    }

    /**
     * Read the single text block for the raw-data disclosure.
     *
     * @param block - the phase's Tool block.
     * @returns the text, or null when the block carries none.
     */
    function resultText(block) {
      if (typeof block !== 'object' || block === null) return null
      if (!Array.isArray(block.content) || block.content.length !== 1) return null
      const only = block.content[0]
      if (typeof only !== 'object' || only === null || only.type !== 'text') return null
      return typeof only.text === 'string' ? only.text : null
    }

    /**
     * Read one finite number, or null for anything else.
     *
     * @param value - the candidate.
     * @returns the number, or null.
     */
    function finite(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    /**
     * Narrow one candidate to an object record.
     *
     * @param value - the candidate.
     * @returns the record, or null.
     */
    function record(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
    }

    // ── number formatting ─────────────────────────────────────────────────────

    /**
     * Format a price with the precision its magnitude warrants.
     *
     * @param value - the price, or null.
     * @returns the text, or an em dash for a missing value.
     */
    function formatPrice(value) {
      if (value === null) return '—'
      const magnitude = Math.abs(value)
      const digits = magnitude >= 1 ? 2 : magnitude >= 0.01 ? 3 : 4
      return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    }

    /**
     * Format a signed change, always carrying its sign. A change is quoted in
     * the currency's cents, so it keeps two decimals however small it is.
     *
     * @param value - the change, or null.
     * @returns the text.
     */
    function formatSigned(value) {
      if (value === null) return '—'
      const digits = Math.abs(value) >= 0.01 ? 2 : 3
      return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
    }

    /**
     * Format a signed percentage, always carrying its sign.
     *
     * @param value - the percentage, or null.
     * @returns the text.
     */
    function formatPercent(value) {
      if (value === null) return '—'
      return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
    }

    /**
     * Format an unsigned ratio such as turnover or amplitude.
     *
     * @param value - the percentage, or null.
     * @returns the text.
     */
    function formatRatio(value) {
      return value === null ? '—' : `${value.toFixed(2)}%`
    }

    /**
     * Format a large magnitude with the unit convention of the active locale.
     *
     * @param value - the magnitude, or null.
     * @param t - the namespace-bound translate.
     * @returns the text.
     */
    function formatCompact(value, t) {
      if (value === null) return '—'
      const magnitude = Math.abs(value)
      if (magnitude < 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
      const units = t('format.system') === 'cn'
        ? [[1e12, '万亿'], [1e8, '亿'], [1e4, '万']]
        : [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
      for (const [scale, suffix] of units) {
        if (magnitude >= scale) return `${(value / scale).toFixed(2)}${suffix}`
      }
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
    }

    /**
     * Format a market capitalization. Upstream reports both cap fields in
     * hundred-million units of the traded currency, so the ladder is applied
     * to the value scaled back to that currency.
     *
     * @param value - the cap in hundred-millions, or null.
     * @param t - the namespace-bound translate.
     * @returns the text.
     */
    function formatCap(value, t) {
      return value === null ? '—' : formatCompact(value * 1e8, t)
    }

    /**
     * Format a volume with its unit word.
     *
     * @param value - the volume, or null.
     * @param unit - `lot` or `share`.
     * @param t - the namespace-bound translate.
     * @returns the text.
     */
    function formatVolume(value, unit, t) {
      if (value === null) return '—'
      const word = t(unit === 'share' ? 'unit.share' : 'unit.lot')
      const amount = formatCompact(value, t)
      return t('format.system') === 'cn' ? `${amount}${word}` : `${amount} ${word}`
    }

    // ── the day's move ────────────────────────────────────────────────────────

    /**
     * The shared badge palette for one day's move. The mainland convention
     * paints a rise red and a fall green, so the rising tone is the error
     * palette and the falling tone the success one.
     */
    const TAG_TONE = { up: 'danger', down: 'success', flat: 'neutral' }

    /**
     * One day's change as the shared read-only badge.
     *
     * @param key - React key.
     * @param tone - the move's tone, `up`, `down`, or `flat`.
     * @param change - the change, or null.
     * @param changePct - the change in percent, or null.
     * @param className - the badge's own class, which places it.
     * @returns the element.
     */
    function changeBadge(key, tone, change, changePct, className) {
      return h(Tag, {
        key,
        tone: TAG_TONE[tone],
        className,
      }, `${formatSigned(change)} ${formatPercent(changePct)}`)
    }

    // ── quote card ────────────────────────────────────────────────────────────

    /**
     * One metric cell.
     *
     * @param key - React key.
     * @param label - the localized label.
     * @param value - the formatted value.
     * @returns the element.
     */
    function metric(key, label, value) {
      return h('div', { className: 'dsh-stock-metric', key },
        h('span', { className: 'dsh-stock-metric-label' }, label),
        h('span', { className: 'dsh-stock-metric-value' }, value))
    }

    /**
     * One side of the five-level order book.
     *
     * @param key - React key.
     * @param label - the localized side label.
     * @param levels - the levels, best first.
     * @returns the element.
     */
    function bookSide(key, label, levels) {
      return h('div', { className: 'dsh-stock-book-side', key }, levels.map((level, index) => h('div', {
        className: 'dsh-stock-book-row',
        key: index,
      },
      h('span', { className: 'label' }, `${label}${index + 1}`),
      h('span', null, formatPrice(level.price)),
      h('span', { className: 'label' }, String(level.volume)))))
    }

    /**
     * Normalize one order-book side.
     *
     * @param value - the raw side.
     * @returns the levels, or null when the side cannot be shown.
     */
    function bookLevels(value) {
      if (!Array.isArray(value) || value.length === 0) return null
      const levels = []
      for (const raw of value) {
        const level = record(raw)
        if (level === null) return null
        const price = finite(level.price)
        const volume = finite(level.volume)
        if (price === null || volume === null) return null
        levels.push({ price, volume })
      }
      return levels
    }

    /**
     * Draw one quote item.
     *
     * @param item - the raw quote item.
     * @param index - its position, used as the React key and the detail switch.
     * @param detailed - whether this call carries enough room for full metrics.
     * @param t - the namespace-bound translate.
     * @returns the element, or null when the item cannot be shown.
     */
    function quoteRow(item, index, detailed, t) {
      const quote = record(item)
      if (quote === null) return null
      const price = finite(quote.price)
      const change = finite(quote.change)
      const changePct = finite(quote.change_pct)
      const tone = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down'
      const volumeUnit = quote.volume_unit === 'share' ? 'share' : 'lot'
      const metrics = [
        ['metric.open', formatPrice(finite(quote.open))],
        ['metric.prevClose', formatPrice(finite(quote.prev_close))],
        ['metric.high', formatPrice(finite(quote.high))],
        ['metric.low', formatPrice(finite(quote.low))],
        ['metric.volume', formatVolume(finite(quote.volume), volumeUnit, t)],
        ['metric.amount', formatCompact(finite(quote.amount), t)],
        ['metric.turnover', formatRatio(finite(quote.turnover_rate))],
        ['metric.amplitude', formatRatio(finite(quote.amplitude))],
        ['metric.marketCap', formatCap(finite(quote.market_cap), t)],
        ['metric.floatCap', formatCap(finite(quote.float_market_cap), t)],
      ]
      for (const [key, field] of [['metric.pe', 'pe_ttm'], ['metric.pb', 'pb'], ['metric.limitUp', 'limit_up'], ['metric.limitDown', 'limit_down'], ['metric.high52w', 'high_52w'], ['metric.low52w', 'low_52w']]) {
        const value = finite(quote[field])
        if (value !== null) metrics.push([key, formatPrice(value)])
      }
      const bids = detailed ? bookLevels(quote.bids) : null
      const asks = detailed ? bookLevels(quote.asks) : null
      const name = typeof quote.name === 'string' && quote.name !== '' ? quote.name : typeof quote.code === 'string' ? quote.code : '—'
      const code = typeof quote.code === 'string' ? quote.code : ''
      const currency = typeof quote.currency === 'string' ? quote.currency : ''
      const timezone = typeof quote.timezone === 'string' ? quote.timezone : ''
      return h('div', { className: 'dsh-stock-quote', key: index },
        h('div', { className: 'dsh-stock-quote-head' },
          h('span', { className: 'dsh-stock-quote-name' }, name),
          h('span', { className: 'dsh-stock-quote-code' }, [code, currency].filter(part => part !== '').join(' · ')),
          h('span', { className: 'dsh-stock-quote-price' }, formatPrice(price)),
          changeBadge('change', tone, change, changePct, 'dsh-stock-quote-change')),
        h('div', { className: 'dsh-stock-metrics' }, metrics.map(([key, value]) => metric(key, t(key), value))),
        bids === null || asks === null ? null : h('div', { className: 'dsh-stock-book' }, [
          bookSide('bids', t('book.bid'), bids),
          bookSide('asks', t('book.ask'), asks),
        ]),
        detailed && timezone !== '' ? h('div', { className: 'dsh-stock-note' }, `${quote.as_of ?? ''} ${timezone}`.trim()) : null)
    }

    // ── cards ─────────────────────────────────────────────────────────────────

    /** The card's inline glyph, drawn as artwork. */
    const QUOTE_ICON = 'M2 3 h12 M2 7 h12 M2 11 h7'

    /**
     * Render the tool's inline icon.
     *
     * @returns the SVG element.
     */
    function toolIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: QUOTE_ICON }))
    }

    /**
     * Render one Tool row: a header every phase shares, the body for the
     * current data, and the raw text behind a disclosure.
     *
     * @param props - the slot's composed props.
     * @param options - the tool's title key and body builder.
     * @returns the element.
     */
    function card(props, options) {
      const { block, phase, t, useDisclosure } = props
      const disclosure = useDisclosure()
      const settled = phase === 'result'
      const value = React.useMemo(() => (settled ? resultValue(block) : null), [block, settled])
      const text = React.useMemo(() => (settled ? resultText(block) : null), [block, settled])
      const build = React.useMemo(() => {
        if (value === null) return null
        try {
          return options.build(value, t)
        } catch {
          // A card must never break the Chat row: an unexpected payload falls back to the plain form.
          return null
        }
      }, [value, t, options])

      const body = (() => {
        if (!settled) return h('div', { className: 'dsh-stock-note' }, t('state.running'))
        if (block.isError === true) return h('div', { className: 'dsh-stock-note is-error' }, t('state.failed'))
        if (build === null) return h('div', { className: 'dsh-stock-note' }, t('state.empty'))
        return build.view
      })()

      return h('div', { className: 'dsh-stock-card' },
        h('div', { className: 'dsh-stock-head' },
          h('span', { className: 'dsh-stock-icon' }, toolIcon()),
          h('span', { className: 'dsh-stock-title' }, (build === null ? undefined : build.title) ?? t(options.titleKey)),
          h('span', { className: 'dsh-stock-summary' }, build === null ? '' : build.summary),
          text === null ? null : h('button', {
            type: 'button',
            className: 'dsh-stock-toggle',
            onClick: disclosure.toggle,
            'aria-expanded': disclosure.expanded,
          }, t(disclosure.expanded ? 'action.hide' : 'action.raw'))),
        body,
        disclosure.expanded && text !== null ? h('pre', { className: 'dsh-stock-raw' }, text) : null)
    }

    /**
     * Build the quote card body.
     *
     * @param value - the settled payload.
     * @param t - the namespace-bound translate.
     * @returns the summary and the rows, or the fallback note.
     */
    function buildQuote(value, t) {
      const items = Array.isArray(value.items) ? value.items : []
      const missing = Array.isArray(value.missing)
        ? value.missing.map(entry => record(entry)).filter(entry => entry !== null && typeof entry.code === 'string').map(entry => entry.code)
        : []
      const summary = t('quote.summary', { count: items.length })
      const rows = items.map((item, index) => quoteRow(item, index, items.length === 1, t)).filter(row => row !== null)
      if (rows.length === 0) return { summary, view: h('div', { className: 'dsh-stock-note' }, t('state.noItems')) }
      return {
        summary,
        view: h('div', { className: 'dsh-stock-quotes' }, [
          ...rows,
          missing.length === 0 ? null : h('div', { className: 'dsh-stock-note', key: 'missing' }, t('quote.missing', { codes: missing.join(', ') })),
        ]),
      }
    }

    /** Stable card options; a fresh object would defeat the body memo. */
    const QUOTE_OPTIONS = { titleKey: 'quote.title', build: buildQuote }

    /**
     * The quote card component.
     *
     * @param props - the slot's composed props.
     * @returns the element.
     */
    function QuoteCard(props) {
      return card(props, QUOTE_OPTIONS)
    }

    // ── watchlist card ────────────────────────────────────────────────────────

    /**
     * Build the watchlist card body: the quote rows in the order the list holds
     * them, and a named placeholder for an entry upstream did not answer for.
     *
     * @param value - the settled payload.
     * @param t - the namespace-bound translate.
     * @returns the title, the summary, and the rows, or the fallback note.
     */
    function buildWatchlist(value, t) {
      const entries = (Array.isArray(value.entries) ? value.entries : [])
        .map(record)
        .filter(entry => entry !== null && typeof entry.code === 'string')
      const quotes = new Map()
      for (const item of Array.isArray(value.items) ? value.items : []) {
        const quote = record(item)
        if (quote !== null && typeof quote.code === 'string') quotes.set(quote.code, quote)
      }
      const index = value.scope === 'index'
      const title = t(index ? 'index.title' : 'watchlist.title')
      const summary = t(index ? 'index.summary' : 'watchlist.summary', { count: entries.length })
      const rows = []
      for (const entry of entries) {
        const quote = quotes.get(entry.code)
        const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.code
        if (quote === undefined) {
          rows.push(h('div', { className: 'dsh-stock-quote', key: entry.code },
            h('div', { className: 'dsh-stock-quote-head' },
              h('span', { className: 'dsh-stock-quote-name' }, name),
              h('span', { className: 'dsh-stock-quote-code' }, entry.code),
              h('span', { className: 'dsh-stock-note' }, t('panel.noQuote')))))
          continue
        }
        const row = quoteRow(quote, entry.code, entries.length === 1, t)
        if (row !== null) rows.push(row)
      }
      if (rows.length === 0) return { title, summary, view: h('div', { className: 'dsh-stock-note' }, t('state.noItems')) }
      return { title, summary, view: h('div', { className: 'dsh-stock-quotes' }, rows) }
    }

    /** Stable watchlist card options; a fresh object would defeat the body memo. */
    const WATCHLIST_OPTIONS = { titleKey: 'watchlist.title', build: buildWatchlist }

    /**
     * The watchlist card component.
     *
     * @param props - the slot's composed props.
     * @returns the element.
     */
    function WatchlistCard(props) {
      return card(props, WATCHLIST_OPTIONS)
    }

    // ── watchlist panel ───────────────────────────────────────────────────────

    /**
     * Failure codes the dictionaries carry copy for. Dictionaries are indexed
     * by exact key, so the error entries sit beside every other flat key and
     * the code set is read back off that prefix.
     */
    const KNOWN_ERRORS = new Set(
      Object.keys(en).filter(key => key.startsWith('errors.')).map(key => key.slice('errors.'.length)),
    )

    /**
     * Resolve one failure code to text.
     *
     * @param t - the namespace-bound translate.
     * @param code - the failure code the Host reported.
     * @returns the text.
     */
    function errorText(t, code) {
      return KNOWN_ERRORS.has(code) ? t(`errors.${code}`) : t('errors.unknown', { code })
    }

    /**
     * Read the failure code of a thrown value.
     *
     * @param failure - the thrown value.
     * @returns the code.
     */
    function failureCode(failure) {
      return typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'unknown'
    }

    /** Two digits, for the parts of a date and a clock. */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /**
     * The interface language, read from the document the locale service keeps in
     * sync. Date wording follows it rather than the machine's regional settings.
     *
     * @returns 'zh' for a Chinese page, 'en' for every other.
     */
    function uiLanguage() {
      const lang = typeof document !== 'undefined' ? String(document.documentElement?.lang ?? '') : ''
      return /^zh\b/i.test(lang) ? 'zh' : 'en'
    }

    /**
     * A weekday name for the interface language, Monday first.
     *
     * @param index - 0 for Monday … 6 for Sunday.
     * @returns the short name: 周一 … 周日, or Mon … Sun.
     */
    function weekdayName(index) {
      return (uiLanguage() === 'zh'
        ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
        : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])[index]
    }

    /**
     * Render one instant as a wall-clock time; an unparseable value is shown as it arrived.
     *
     * Always 24-hour, so a reader whose regional settings prefer a 12-hour clock
     * still never sees AM or PM.
     *
     * @param iso - the instant.
     * @returns the text.
     */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return iso
      return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
    }

    /**
     * Format a future market opening. A time later today stays a clock time; a
     * later day also names the weekday, so a weekend wait cannot read as a
     * time that already passed. The date and weekday follow the interface
     * language (`10-29 周三` / `10-29 Wed`), never an English month name.
     *
     * @param iso - the RFC 3339 instant.
     * @returns the text, or an em dash for a missing value.
     */
    function formatOpening(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return iso
      const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
      if (at.toDateString() === new Date().toDateString()) return clock
      const day = `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
      return `${day} ${weekdayName((at.getDay() + 6) % 7)} ${clock}`
    }

    /**
     * One request to the panel's Host route.
     *
     * @param init - the request init.
     * @returns the action's value.
     * @throws an Error carrying the Host's `code`, or `unreachable` when no route answered.
     */
    async function request(init) {
      let response
      try {
        response = await fetch(new URL(ROUTE, document.baseURI), init)
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

    /**
     * Post one action to the panel's Host route.
     *
     * @param action - the action name.
     * @param body - the action's fields.
     * @returns the action's value.
     */
    function call(action, body) {
      return request({
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action, ...body }),
      })
    }

    /**
     * The one place a settled watchlist edit is announced. The panel reports
     * into it and the `shell.overlay` entry renders it, so an outcome outlives
     * the panel that asked for it.
     *
     * @returns the notice store the overlay entry reads and the panel writes.
     */
    function createToastSource() {
      let state = null
      let seq = 0
      const listeners = new Set()
      const publish = (next) => {
        state = next
        for (const listener of listeners) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot: () => state,
        /**
         * Show one settled outcome.
         *
         * @param tone - 'ok' or 'error'.
         * @param key - the dictionary key of the message.
         * @param values - the message's placeholders.
         */
        report(tone, key, values) {
          publish({ tone, key, values, seq: ++seq })
        },
        dismiss() {
          publish(null)
        },
      }
    }

    const toasts = createToastSource()

    /**
     * The outcome banner for settled watchlist edits.
     *
     * @param props - the slot's composed props.
     * @returns the banner on display, or null.
     */
    function WatchlistToast(props) {
      const toast = React.useSyncExternalStore(toasts.subscribe, toasts.getSnapshot)
      if (toast === null) return null
      const shared = {
        key: `stock-watchlist-${toast.seq}`,
        text: props.t(toast.key, toast.values),
        holdMs: toast.tone === 'ok' ? 3000 : 6000,
        onDone: toasts.dismiss,
      }
      return toast.tone === 'ok'
        ? h(Toast, { ...shared, tone: 'success' })
        : h(Toast, { ...shared, icon: h(IconWarningOutlineRegular, { size: 16 }) })
    }

    /**
     * One icon-only control of the panel.
     *
     * @param props - label, glyph, click handler, whether it is inert, and whether it is a switch that is currently on.
     * @returns the element.
     */
    function IconButton(props) {
      return h(Tooltip, { label: props.label },
        h('button', {
          type: 'button',
          className: 'dsh-stock-panel-icon',
          'aria-label': props.label,
          'aria-pressed': props.pressed === undefined ? undefined : props.pressed === true,
          disabled: props.disabled === true,
          onClick: props.onClick,
        }, props.icon))
    }

    /**
     * The fields one panel row shows, in order. Every row renders all of them: a
     * quote that does not carry one keeps its column and shows a dash, so the
     * columns read down the page.
     */
    const ROW_METRICS = [['metric.open', 'open'], ['metric.high', 'high'], ['metric.low', 'low']]

    /** The box one row's intraday line is drawn in, in SVG user units. */
    const SPARKLINE_WIDTH = 68
    const SPARKLINE_HEIGHT = 26

    /**
     * One security's or index's intraday line.
     *
     * The Host sends the session as prices in time order, thinned to what this
     * box can show; the line is scaled to the row's own box and drawn in the tone
     * the day's change carries, with the previous close as a baseline where it
     * falls inside the session's range. A series that has not arrived — or that
     * upstream has none for — draws the empty box instead, so the rows below
     * never move.
     *
     * @param props - the series, the previous close, the day's tone, the accessible label, and an optional placing class.
     * @returns the element.
     */
    function Sparkline(props) {
      const { series, prevClose, tone, label, className } = props
      const points = (Array.isArray(series?.points) ? series.points : [])
        .filter(value => typeof value === 'number' && Number.isFinite(value))
      const emptyClass = className === undefined ? 'dsh-stock-sparkline' : `dsh-stock-sparkline ${className}`
      if (points.length < 2) return h('span', { className: emptyClass, 'aria-hidden': true })
      const low = Math.min(...points)
      const high = Math.max(...points)
      // A session that has not moved yet is a flat line through the middle
      // rather than a division by zero.
      const span = high - low
      const at = value => (span === 0 ? SPARKLINE_HEIGHT / 2 : SPARKLINE_HEIGHT - ((value - low) / span) * SPARKLINE_HEIGHT)
      const step = SPARKLINE_WIDTH / (points.length - 1)
      const line = points.map((value, index) => `${(index * step).toFixed(1)},${at(value).toFixed(1)}`).join(' ')
      const baseline = span > 0 && finite(prevClose) !== null && prevClose >= low && prevClose <= high
        ? at(prevClose).toFixed(1)
        : null
      return h('svg', {
        className: className === undefined ? `dsh-stock-sparkline ${tone}` : `dsh-stock-sparkline ${tone} ${className}`,
        viewBox: `0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`,
        width: SPARKLINE_WIDTH,
        height: SPARKLINE_HEIGHT,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': label,
      }, [
        baseline === null ? null : h('line', {
          key: 'baseline',
          className: 'dsh-stock-sparkline-baseline',
          x1: 0,
          x2: SPARKLINE_WIDTH,
          y1: baseline,
          y2: baseline,
        }),
        h('polyline', { key: 'line', className: 'dsh-stock-sparkline-line', points: line }),
      ])
    }

    /**
     * Format a share count.
     *
     * @param value - the count, or null.
     * @returns the text, or an em dash for a missing value.
     */
    function formatQuantity(value) {
      if (value === null) return '—'
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
    }

    /**
     * Format a signed money amount with the active locale's unit convention.
     *
     * @param value - the amount, or null.
     * @param t - the namespace-bound translate.
     * @returns the text, carrying an explicit plus for a gain.
     */
    function formatSignedCompact(value, t) {
      const amount = formatCompact(Math.abs(value), t)
      return value > 0 ? `+${amount}` : value < 0 ? `-${amount}` : amount
    }

    /**
     * Read one position input.
     *
     * @param value - the input's text.
     * @returns the positive number, null for a blank field, or NaN for invalid input.
     */
    function readPositionInput(value) {
      const text = value.trim()
      if (text === '') return null
      const parsed = Number(text)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN
    }

    /**
     * One followed security's holding figures, derived from the quote the row
     * already draws. A figure the user left blank is absent rather than zero, so
     * a marked entry with no cost never claims a profit or loss.
     *
     * @param t - the namespace-bound translate.
     * @param entry - the followed security, carrying its position.
     * @param quote - the compact quote, or undefined when the row holds none.
     * @returns the compact figures, with the full detail in the title, or null when the entry stores none.
     */
    function positionLine(t, entry, quote) {
      const position = record(entry.position)
      if (position === null) return null
      const cost = finite(position.cost)
      const quantity = finite(position.quantity)
      const price = quote === undefined ? null : finite(quote.price)
      const currency = quote !== undefined && typeof quote.currency === 'string' && quote.currency !== ''
        ? ` ${quote.currency}`
        : ''
      const details = []
      if (cost !== null) details.push({ key: 'cost', text: t('panel.positionCost', { value: formatPrice(cost) }) })
      if (quantity !== null) details.push({ key: 'quantity', text: t('panel.positionQuantity', { value: formatQuantity(quantity) }) })
      if (price !== null && quantity !== null) {
        details.push({
          key: 'value',
          text: t('panel.positionValue', { value: `${formatCompact(price * quantity, t)}${currency}` }),
        })
      }
      let visibleRight = null
      if (price !== null && cost !== null && cost > 0) {
        const percent = (price / cost - 1) * 100
        if (quantity !== null) {
          const amount = (price - cost) * quantity
          const tone = amount === 0 ? 'flat' : amount > 0 ? 'up' : 'down'
          const figure = formatSignedCompact(amount, t)
          details.push({
            key: 'profit',
            tone,
            text: t('panel.positionProfit', { amount: `${figure}${currency}`, percent: formatPercent(percent) }),
          })
          visibleRight = { tone, text: t('panel.positionProfitBare', { amount: figure, percent: formatPercent(percent) }) }
        } else {
          const tone = percent === 0 ? 'flat' : percent > 0 ? 'up' : 'down'
          details.push({ key: 'return', tone, text: t('panel.positionReturn', { percent: formatPercent(percent) }) })
          visibleRight = { tone, text: formatPercent(percent) }
        }
      } else if (price !== null && quantity !== null) {
        visibleRight = { tone: null, text: formatCompact(price * quantity, t) }
      }
      if (details.length === 0) return null
      const base = cost !== null ? formatPrice(cost) : quantity !== null ? formatQuantity(quantity) : null
      return h('div', { className: 'dsh-stock-panel-position', title: details.map(part => part.text).join(' · ') },
        base === null ? null : h('span', { key: 'base' }, base),
        visibleRight === null ? null : h('span', {
          key: 'right',
          className: visibleRight.tone === null ? undefined : `dsh-stock-panel-position-profit ${visibleRight.tone}`,
        }, visibleRight.text))
    }

    /**
     * One followed security: its latest quote, its position, and its actions.
     *
     * @param props - the row's locale, entry, quote, position, and handlers.
     * @returns the element.
     */
    function WatchlistRow(props) {
      const { t, entry, quote, sparkline, invalid, first, last, busy, onMove, onRemove, onMark, onUnmark } = props
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [marking, setMarking] = React.useState(false)
      const [costText, setCostText] = React.useState('')
      const [quantityText, setQuantityText] = React.useState('')
      const [markHint, setMarkHint] = React.useState(null)
      const position = record(entry.position)
      const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.code
      const price = quote === undefined ? null : finite(quote.price)
      const change = quote === undefined ? null : finite(quote.change)
      const tone = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down'
      const metrics = ROW_METRICS.map(([key, field]) => [
        key,
        quote === undefined ? '—' : formatPrice(finite(quote[field])),
      ])
      const beginMark = () => {
        setCostText(position?.cost === null || position?.cost === undefined ? '' : String(position.cost))
        setQuantityText(position?.quantity === null || position?.quantity === undefined ? '' : String(position.quantity))
        setMarkHint(null)
        setMarking(true)
      }
      const saveMark = () => {
        const cost = readPositionInput(costText)
        const quantity = readPositionInput(quantityText)
        if (Number.isNaN(cost) || Number.isNaN(quantity)) {
          setMarkHint(t('panel.positionInvalid'))
          return
        }
        setMarkHint(null)
        setMarking(false)
        onMark({ cost, quantity })
      }
      const items = [
        { id: 'up', label: t('panel.moveUp'), icon: h(IconChevronUpOutlineRegular, { size: 16 }), disabled: first },
        { id: 'down', label: t('panel.moveDown'), icon: h(IconChevronDownOutlineRegular, { size: 16 }), disabled: last },
        { type: 'separator', id: 'separator-order' },
        {
          id: 'mark',
          label: t(position === null ? 'panel.mark' : 'panel.editPosition'),
          icon: h(IconPinOutlineRegular, { size: 16 }),
        },
        { type: 'separator', id: 'separator-remove' },
        { id: 'remove', label: t('panel.remove'), icon: h(IconTrashOutlineRegular, { size: 16 }), danger: true },
      ]
      const select = (id) => {
        setMenuOpen(false)
        if (id === 'up') onMove(-1)
        else if (id === 'down') onMove(1)
        else if (id === 'mark') beginMark()
        else if (id === 'remove') onRemove()
      }
      const editor = marking ? h('div', { className: 'dsh-stock-panel-position-form' },
        h('div', { className: 'dsh-stock-panel-position-fields' },
          h('label', { className: 'dsh-stock-panel-field' },
            h('span', { className: 'dsh-stock-panel-field-label' }, t('panel.positionCostLabel')),
            h(Input, {
              className: 'dsh-stock-panel-field-input',
              type: 'number',
              min: '0',
              step: 'any',
              inputMode: 'decimal',
              value: costText,
              onChange: event => setCostText(event.target.value),
            })),
          h('label', { className: 'dsh-stock-panel-field' },
            h('span', { className: 'dsh-stock-panel-field-label' }, t('panel.positionQuantityLabel')),
            h(Input, {
              className: 'dsh-stock-panel-field-input',
              type: 'number',
              min: '0',
              step: 'any',
              inputMode: 'decimal',
              value: quantityText,
              onChange: event => setQuantityText(event.target.value),
            }))),
        h('div', { className: 'dsh-stock-panel-position-actions' },
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: saveMark }, t('panel.positionSave')),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => setMarking(false) }, t('panel.positionCancel')),
          position === null
            ? null
            : h(Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: busy,
                onClick: () => { setMarking(false); onUnmark() },
              }, t('panel.unmark'))),
        markHint === null ? null : h('div', { className: 'dsh-stock-panel-form-hint' }, markHint))
        : null
      return h('div', { className: 'dsh-stock-panel-row' },
        h('div', { className: 'dsh-stock-panel-main' },
          h('div', { className: 'dsh-stock-panel-line' },
            h('span', { className: 'dsh-stock-panel-name' }, name),
            h('span', { className: 'dsh-stock-panel-code' }, entry.code),
            position === null ? null : h(Tag, { tone: 'outline', className: 'dsh-stock-panel-pill' }, t('panel.position'))),
          h('div', { className: 'dsh-stock-panel-metrics' },
            metrics.map(([key, value]) => h('span', { className: 'dsh-stock-panel-metric', key },
              h('span', { className: 'dsh-stock-panel-metric-label' }, t(key)),
              h('span', { className: 'dsh-stock-panel-metric-value' }, value)))),
          editor),
        h(Sparkline, {
          key: 'sparkline',
          series: sparkline,
          prevClose: quote === undefined ? null : finite(quote.prev_close),
          tone,
          label: t('panel.sparkline'),
        }),
        h('div', { className: 'dsh-stock-panel-price' },
          h('div', { className: 'dsh-stock-panel-price-line' },
            price === null
              ? h('span', { className: 'dsh-stock-panel-placeholder' }, invalid ? t('panel.invalidCode') : t('panel.noQuote'))
              : [
                  h('span', { className: 'dsh-stock-panel-price-value', key: 'price' }, formatPrice(price)),
                  changeBadge('change', tone, change, finite(quote.change_pct), 'dsh-stock-panel-change'),
                ]),
          positionLine(t, entry, quote)),
        h(Menu, {
          open: menuOpen,
          className: 'dsh-stock-row-menu',
          anchor: h(IconButton, {
            label: t('panel.actions'),
            icon: h(IconEllipsisOutlineMedium, { size: 16 }),
            disabled: busy,
            onClick: () => setMenuOpen((open) => !open),
          }),
          items,
          onSelect: select,
          onClose: () => setMenuOpen(false),
          align: 'end',
          portal: true,
        }))
    }

    /**
     * One index of the strip above the watchlist: its name, latest value,
     * change, and current session, with the same reorder and remove actions a
     * followed security has — left and right, because the strip runs across the
     * panel.
     *
     * @param props - the cell's locale, entry, quote, intraday series, position, and handlers.
     * @returns the element.
     */
    function IndexCell(props) {
      const { t, entry, quote, sparkline, invalid, first, last, busy, onMove, onRemove } = props
      const [menuOpen, setMenuOpen] = React.useState(false)
      const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.code
      const price = quote === undefined ? null : finite(quote.price)
      const change = quote === undefined ? null : finite(quote.change)
      const tone = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down'
      const items = [
        { id: 'left', label: t('panel.moveLeft'), icon: h(IconChevronLeftOutlineRegular, { size: 16 }), disabled: first },
        { id: 'right', label: t('panel.moveRight'), icon: h(IconChevronRightOutlineRegular, { size: 16 }), disabled: last },
        { type: 'separator', id: 'separator' },
        { id: 'remove', label: t('panel.remove'), icon: h(IconTrashOutlineRegular, { size: 16 }), danger: true },
      ]
      const select = (id) => {
        setMenuOpen(false)
        if (id === 'left') onMove(-1)
        else if (id === 'right') onMove(1)
        else if (id === 'remove') onRemove()
      }
      return h('div', { className: 'dsh-stock-index' },
        h('div', { className: 'dsh-stock-index-head' },
          h('span', { className: 'dsh-stock-index-name', title: name }, name),
          h(Menu, {
            open: menuOpen,
            anchor: h(IconButton, {
              label: t('panel.actions'),
              icon: h(IconEllipsisOutlineMedium, { size: 14 }),
              disabled: busy,
              onClick: () => setMenuOpen((open) => !open),
            }),
            items,
            onSelect: select,
            onClose: () => setMenuOpen(false),
            align: 'end',
            portal: true,
          })),
        h('div', { className: 'dsh-stock-index-body' },
          h('div', { className: 'dsh-stock-index-figures' },
            price === null
              ? h('span', { className: 'dsh-stock-index-placeholder' }, invalid ? t('panel.invalidCode') : t('panel.noQuote'))
              : h('span', { className: 'dsh-stock-index-price' }, formatPrice(price)),
            price === null
              ? null
              : changeBadge('change', tone, change, finite(quote.change_pct), 'dsh-stock-index-change')),
          h(Sparkline, {
            className: 'dsh-stock-index-sparkline',
            series: sparkline,
            prevClose: quote === undefined ? null : finite(quote.prev_close),
            tone,
            label: t('panel.sparkline'),
          })))
    }

    /**
     * The watchlist panel: the index row above the followed securities, the
     * search box that adds to either list, and the refresh policy the Host
     * publishes.
     *
     * @param props - the slot's composed props.
     * @returns the element.
     */
    function WatchlistPanel(props) {
      const t = props.t
      const [state, setState] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [searchTarget, setSearchTarget] = React.useState(null)
      const [keyword, setKeyword] = React.useState('')
      const [results, setResults] = React.useState(null)
      const [searchFailure, setSearchFailure] = React.useState(null)
      const [searching, setSearching] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [indexMenuOpen, setIndexMenuOpen] = React.useState(false)
      const [series, setSeries] = React.useState({})
      const [settings, setSettings] = React.useState(readSettings)
      const lineTimer = React.useRef(null)
      const linePending = React.useRef(null)

      /**
       * Read the intraday line of every followed security and every index in
       * the row above it.
       *
       * The lines arrive from their own request, so the list is on screen before
       * the first upstream minute read is even queued behind the client's pacing.
       * A line the Host did not send keeps whatever the last read drew, because
       * the Host refetches a long list a few codes per request. Those pending
       * codes are asked for again on a short timer, so a closed market still
       * fills its lines even though the quote poll that used to retry them has
       * stopped; one round that shrinks nothing ends the retry so a disabled
       * read budget cannot become a request loop.
       *
       * @param next - the panel state the read belongs to.
       * @param filling - whether this is a follow-up round for pending codes.
       */
      const loadSparklines = React.useCallback(async (next, filling = false) => {
        if (lineTimer.current !== null) {
          clearTimeout(lineTimer.current)
          lineTimer.current = null
        }
        if (!filling) linePending.current = null
        const entries = Array.isArray(next?.entries) ? next.entries : []
        const indices = Array.isArray(next?.indices) ? next.indices : []
        const unusable = new Set(Array.isArray(next?.invalid) ? next.invalid : [])
        const codes = [...entries, ...indices]
          .map(entry => entry?.code)
          .filter(code => typeof code === 'string' && code !== '' && !unusable.has(code))
        if (codes.length === 0) {
          setSeries({})
          return
        }
        try {
          const value = await call('sparklines', { codes })
          setSeries((current) => {
            const kept = {}
            for (const code of codes) {
              const ready = value?.series?.[code]
              if (ready !== undefined) kept[code] = ready
              else if (current[code] !== undefined) kept[code] = current[code]
            }
            return kept
          })
          const pending = Array.isArray(value?.pending) ? value.pending : []
          const previous = linePending.current
          if (pending.length > 0 && (previous === null || pending.length < previous)) {
            linePending.current = pending.length
            lineTimer.current = setTimeout(() => {
              lineTimer.current = null
              void loadSparklines(next, true)
            }, 1000)
          } else {
            linePending.current = null
          }
        } catch {
          // A line is decoration: the list and its own notice already report an
          // unreachable Host, and a code upstream holds no intraday series for
          // simply has no line. The lines already drawn stay.
          linePending.current = null
        }
      }, [])

      // One settled read or edit: the list, then the lines that belong to it.
      const apply = React.useCallback((next) => {
        setState(next)
        void loadSparklines(next)
      }, [loadSparklines])

      React.useEffect(() => () => {
        if (lineTimer.current !== null) clearTimeout(lineTimer.current)
      }, [])

      // A poll that is still running must not be joined by the next interval
      // tick: at ten seconds a long list can spend the interval queued behind
      // the Host's own request pacing, and overlapping status reads would only
      // add more of the same work.
      const pendingRefresh = React.useRef(null)
      const refresh = React.useCallback(() => {
        if (pendingRefresh.current !== null) return pendingRefresh.current
        const work = (async () => {
          try {
            const value = await request({ method: 'GET', headers: { accept: 'application/json' } })
            apply(value)
            setFailure(null)
          } catch (error) {
            setFailure(failureCode(error))
          }
        })()
        pendingRefresh.current = work.finally(() => { pendingRefresh.current = null })
        return pendingRefresh.current
      }, [apply])

      // One search field serves both lists: opening it for one of them closes
      // it for the other and drops the keyword the previous list was searched
      // with, so a result is never offered to the list it was not found for.
      const toggleSearch = (target) => {
        setSearchTarget(current => (current === target ? null : target))
        setKeyword('')
        setResults(null)
      }

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      const refreshMs = state?.panel?.refreshMs ?? 0
      const trading = state?.market?.open === true
      const nextOpenAt = typeof state?.market?.next_open_at === 'string' ? Date.parse(state.market.next_open_at) : Number.NaN
      const resumesAt = Number.isFinite(nextOpenAt) ? nextOpenAt : null
      const autoRefresh = refreshMs > 0 && settings.autoRefresh
      // Poll on the interval the Host publishes only while a market the list
      // holds is in session and the page is visible. A closed market has
      // nothing live to read: the panel stops polling and waits for the next
      // opening instant the Host reports, so a quote is never re-read on a
      // closed market just to discover it is still closed.
      React.useEffect(() => {
        if (!autoRefresh || !trading) return undefined
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void refresh()
        }, refreshMs)
        // Coming back to the tab is the one moment a reader expects numbers
        // newer than the last interval that fired while it was hidden.
        const onVisible = () => {
          if (document.visibilityState === 'visible') void refresh()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [autoRefresh, trading, refreshMs, refresh])

      // With the market closed there is no interval, but the panel still has to
      // resume by itself when the bell rings. The Host reports when the next
      // session opens, so one wake-up replaces a poll that has nothing to read.
      React.useEffect(() => {
        if (!autoRefresh || trading || resumesAt === null) return undefined
        const delay = Math.max(250, resumesAt - Date.now() + 250)
        if (delay > 2_147_483_647) return undefined
        const timer = setTimeout(() => { void refresh() }, delay)
        return () => clearTimeout(timer)
      }, [autoRefresh, trading, resumesAt, refresh])

      // A page open across a Harness restart recovers on its own instead of
      // claiming the user has no watchlist.
      const loaded = state !== null
      React.useEffect(() => {
        if (loaded) return undefined
        const timer = setInterval(() => { void refresh() }, 3000)
        return () => clearInterval(timer)
      }, [loaded, refresh])

      // One debounced search per settled keyword; an answer that a later
      // keystroke superseded is dropped rather than shown.
      React.useEffect(() => {
        const wanted = keyword.trim()
        if (searchTarget === null || wanted.length < SEARCH_MIN_CHARS) {
          setResults(null)
          setSearchFailure(null)
          setSearching(false)
          return undefined
        }
        let current = true
        const timer = setTimeout(() => {
          setSearching(true)
          void call('search', { keyword: wanted })
            .then((value) => {
              if (!current) return
              const found = value?.search
              setResults(found?.ok === true && Array.isArray(found.items) ? found.items : [])
              setSearchFailure(found?.ok === false ? found.error?.code ?? 'unknown' : null)
            })
            .catch((error) => {
              if (!current) return
              setResults([])
              setSearchFailure(failureCode(error))
            })
            .finally(() => {
              if (current) setSearching(false)
            })
        }, SEARCH_DEBOUNCE_MS)
        return () => {
          current = false
          clearTimeout(timer)
          setSearching(false)
        }
      }, [keyword, searchTarget])

      const run = React.useCallback(async (failureKey, work) => {
        setBusy(failureKey)
        try {
          await work()
        } catch (error) {
          toasts.report('error', failureKey, { reason: errorText(t, failureCode(error)) })
        } finally {
          setBusy(null)
        }
      }, [t])

      const entries = Array.isArray(state?.entries) ? state.entries : []
      const indices = Array.isArray(state?.indices) ? state.indices : []
      const quotes = new Map()
      for (const item of Array.isArray(state?.quotes?.items) ? state.quotes.items : []) {
        if (typeof item?.code === 'string') quotes.set(item.code, item)
      }
      const invalid = new Set(Array.isArray(state?.invalid) ? state.invalid : [])
      const failedBatches = Array.isArray(state?.quotes?.failed) ? state.quotes.failed : []
      const failedCodes = failedBatches.reduce((total, batch) => total + (Array.isArray(batch?.codes) ? batch.codes.length : 0), 0)
      // An index row takes indexes only; everything else belongs to the list above.
      const offered = searchTarget === 'index'
        ? (results ?? []).filter(item => item?.type === 'ZS')
        : results

      const add = (item) => run(searchTarget === 'index' ? 'panel.indexAddFailed' : 'panel.addFailed', async () => {
        const value = await call('add', { scope: searchTarget === 'index' ? 'index' : 'watchlist', codes: [item.code] })
        apply(value.state)
        setKeyword('')
        setResults(null)
        // The store answers what it actually did: a full list and a duplicate
        // both leave it unchanged, and reporting "added" for either is a lie.
        const outcome = value?.outcome ?? {}
        if (Array.isArray(outcome.full) && outcome.full.length > 0) {
          toasts.report('error', 'panel.addFull', { name: item.name })
        } else if (Array.isArray(outcome.duplicates) && outcome.duplicates.length > 0) {
          toasts.report('error', 'panel.addDuplicate', { name: item.name })
        } else {
          toasts.report('ok', searchTarget === 'index' ? 'panel.indexAdded' : 'panel.added', { name: item.name })
        }
      })

      const remove = (entry, scope) => run(scope === 'index' ? 'panel.indexRemoveFailed' : 'panel.removeFailed', async () => {
        const value = await call('remove', { scope, codes: [entry.code] })
        apply(value.state)
        toasts.report('ok', scope === 'index' ? 'panel.indexRemoved' : 'panel.removed', { name: entry.name ?? entry.code })
      })

      const markPosition = (entry, fields) => run('panel.markFailed', async () => {
        const value = await call('mark', { scope: 'watchlist', code: entry.code, cost: fields.cost, quantity: fields.quantity })
        apply(value.state)
        toasts.report('ok', 'panel.marked', { name: entry.name ?? entry.code })
      })

      const unmarkPosition = (entry) => run('panel.unmarkFailed', async () => {
        const value = await call('unmark', { scope: 'watchlist', code: entry.code })
        apply(value.state)
        toasts.report('ok', 'panel.unmarked', { name: entry.name ?? entry.code })
      })

      const move = (entry, scope, delta) => run(scope === 'index' ? 'panel.indexMoveFailed' : 'panel.moveFailed', async () => {
        const list = scope === 'index' ? indices : entries
        const from = list.findIndex(candidate => candidate.code === entry.code)
        const value = await call('move', { scope, code: entry.code, to: from + delta + 1 })
        apply(value.state)
      })

      const clear = (scope) => {
        if (scope === 'watchlist') setMenuOpen(false)
        if (!window.confirm(t(scope === 'index' ? 'panel.indexClearConfirm' : 'panel.clearConfirm'))) return
        void run(scope === 'index' ? 'panel.indexClearFailed' : 'panel.clearFailed', async () => {
          const value = await call('clear', { scope })
          apply(value.state)
          toasts.report('ok', scope === 'index' ? 'panel.indexCleared' : 'panel.cleared')
        })
      }

      // The switch is the reader's, so it outlives this mount: the page keeps
      // polling exactly as they left it the next time they open it.
      const toggleAutoRefresh = () => setSettings((current) => {
        const next = { ...current, autoRefresh: !current.autoRefresh }
        writeSettings(next)
        return next
      })

      const body = () => {
        if (state === null) {
          return failure === null
            ? h('div', { className: 'dsh-stock-panel-center' },
                h(StateDot, { state: 'ongoing' }),
                h('span', null, t('panel.loading')))
            : h('div', { className: 'dsh-stock-panel-center' },
                h('span', { className: 'dsh-stock-panel-center-title' }, t('panel.loadFailed', { reason: errorText(t, failure) })),
                h(Button, { variant: 'outline', size: 'sm', onClick: () => void refresh() }, t('panel.retry')))
        }
        // The index row keeps its own header and its own edit controls, so it
        // reads as the market's row rather than as the first followed security.
        const indexGroup = h('section', { className: 'dsh-stock-panel-group' },
          h('header', { className: 'dsh-stock-panel-group-head' },
            h('span', { className: 'dsh-stock-panel-group-title' }, t('panel.indices')),
            h('span', { className: 'dsh-stock-panel-group-count' }, t('panel.count', { count: indices.length })),
            h('div', { className: 'dsh-stock-panel-group-tools' },
              h(Button, {
                variant: searchTarget === 'index' ? 'primary' : 'outline',
                size: 'sm',
                icon: h(searchTarget === 'index' ? IconCloseOutlineRegular : IconPlusOutlineRegular, { size: 16 }),
                onClick: () => toggleSearch('index'),
                'aria-expanded': searchTarget === 'index',
              }, t(searchTarget === 'index' ? 'panel.searchClose' : 'panel.indexAdd')),
              h(Menu, {
                open: indexMenuOpen,
                anchor: h(IconButton, {
                  label: t('panel.actions'),
                  icon: h(IconEllipsisOutlineMedium, { size: 16 }),
                  disabled: busy !== null,
                  onClick: () => setIndexMenuOpen(open => !open),
                }),
                items: [{ id: 'clear', label: t('panel.indexClear'), icon: h(IconTrashOutlineRegular, { size: 16 }), danger: true, disabled: indices.length === 0 }],
                onSelect: () => clear('index'),
                onClose: () => setIndexMenuOpen(false),
                align: 'end',
                portal: true,
              }))),
          indices.length === 0
            ? h('div', { className: 'dsh-stock-panel-group-empty' }, t('panel.indexEmptyHint'))
            : h('div', { className: 'dsh-stock-panel-indices' },
                indices.map((entry, index) => h(IndexCell, {
                  key: entry.code,
                  t,
                  entry,
                  quote: quotes.get(entry.code),
                  sparkline: series[entry.code],
                  invalid: invalid.has(entry.code),
                  first: index === 0,
                  last: index === indices.length - 1,
                  busy: busy !== null,
                  onMove: delta => void move(entry, 'index', delta),
                  onRemove: () => void remove(entry, 'index'),
                }))))
        return h('div', { className: 'dsh-stock-panel-body' },
          failedBatches.length === 0 ? null : h('div', { className: 'dsh-stock-panel-notice is-error' },
            h(IconWarningOutlineRegular, { size: 16 }),
            h('span', null, t('panel.quotesFailed', {
              count: failedCodes,
              reason: errorText(t, failedBatches[0]?.error?.code ?? 'unknown'),
            }))),
          indexGroup,
          entries.length === 0
            ? h('div', { className: 'dsh-stock-panel-center' },
                h('span', { className: 'dsh-stock-panel-center-title' }, t('panel.empty')),
                h('span', { className: 'dsh-stock-panel-center-body' }, t('panel.emptyHint')))
            : entries.map((entry, index) => h(WatchlistRow, {
                key: entry.code,
                t,
                entry,
                quote: quotes.get(entry.code),
                sparkline: series[entry.code],
                invalid: invalid.has(entry.code),
                first: index === 0,
                last: index === entries.length - 1,
                busy: busy !== null,
                onMove: delta => void move(entry, 'watchlist', delta),
                onRemove: () => void remove(entry, 'watchlist'),
                onMark: fields => void markPosition(entry, fields),
                onUnmark: () => void unmarkPosition(entry),
              })))
      }

      const search = () => {
        if (searchTarget === null) return null
        const forIndex = searchTarget === 'index'
        const wanted = keyword.trim()
        let content = null
        if (searching) content = h(StateDot, { state: 'ongoing' })
        else if (searchFailure !== null) content = h('span', { className: 'dsh-stock-panel-hint' }, t('panel.searchFailed', { reason: errorText(t, searchFailure) }))
        else if (offered !== null && offered.length === 0) content = h('span', { className: 'dsh-stock-panel-hint' }, t(forIndex ? 'panel.indexSearchEmpty' : 'panel.searchEmpty'))
        else if (wanted.length > 0 && wanted.length < SEARCH_MIN_CHARS) content = h('span', { className: 'dsh-stock-panel-hint' }, t('panel.searchHint', { count: SEARCH_MIN_CHARS }))
        return h('div', { className: 'dsh-stock-panel-search' },
          h(Input, {
            icon: h(IconSearchOutlineRegular, { size: 16 }),
            value: keyword,
            placeholder: t(forIndex ? 'panel.indexSearchPlaceholder' : 'panel.searchPlaceholder'),
            'aria-label': t(forIndex ? 'panel.indexSearchPlaceholder' : 'panel.searchPlaceholder'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: event => setKeyword(event.target.value),
          }),
          content,
          offered === null || searching ? null : h('div', { className: 'dsh-stock-panel-results' },
            offered.map(item => h('button', {
              type: 'button',
              className: 'dsh-stock-panel-result',
              key: item.code,
              disabled: busy !== null,
              onClick: () => void add(item),
            },
            h('span', { className: 'dsh-stock-panel-result-name' }, item.name),
            h('span', { className: 'dsh-stock-panel-result-code' }, item.code),
            h('span', { className: 'dsh-stock-panel-result-add' }, t('panel.searchAdd'))))))
      }

      const status = state === null
        ? ''
        : [
            trading ? t('panel.trading', { markets: (state.market?.trading ?? []).join(' ') }) : t('panel.closed'),
            t('panel.updated', { time: formatTime(state.snapshot?.queried_at) }),
            // What the page does on its own belongs beside what it last read:
            // the interval while it polls, the pause it is under when not, and
            // the next opening when the market is closed.
            refreshMs <= 0
              ? null
              : !autoRefresh
                ? t('panel.autoPaused')
                : trading
                  ? t('panel.autoEvery', { seconds: Math.round(refreshMs / 1000) })
                  : resumesAt === null
                    ? t('panel.autoClosed')
                    : t('panel.autoNextOpen', { time: formatOpening(state.market?.next_open_at) }),
          ].filter(part => part !== null).join(' · ')

      return h('section', { className: 'dsh-stock-panel' },
        h('header', { className: 'dsh-stock-panel-head' },
          h('h1', { className: 'dsh-stock-panel-title' }, t('panel.title')),
          state === null ? null : h(Tag, { className: 'dsh-stock-panel-count' }, t('panel.count', { count: entries.length })),
          status === '' ? null : h('span', { className: 'dsh-stock-panel-status' }, status),
          h('div', { className: 'dsh-stock-panel-tools' },
            h(Button, {
              variant: searchTarget === 'watchlist' ? 'primary' : 'outline',
              size: 'sm',
              icon: h(searchTarget === 'watchlist' ? IconCloseOutlineRegular : IconPlusOutlineRegular, { size: 16 }),
              onClick: () => toggleSearch('watchlist'),
              'aria-expanded': searchTarget === 'watchlist',
            }, t(searchTarget === 'watchlist' ? 'panel.searchClose' : 'panel.add')),
            h(IconButton, {
              label: t('panel.refresh'),
              icon: h(IconRefreshOutlineRegular, { size: 16 }),
              disabled: busy !== null,
              onClick: () => void refresh(),
            }),
            // Only a Host that publishes an interval can be asked to keep
            // polling, so a deployment that turned it off shows no switch.
            refreshMs <= 0 ? null : h(IconButton, {
              label: t(autoRefresh ? 'panel.autoPause' : 'panel.autoResume'),
              icon: h(autoRefresh ? IconPauseOutlineRegular : IconPlayOutlineRegular, { size: 16 }),
              pressed: autoRefresh,
              onClick: toggleAutoRefresh,
            }),
            h(Menu, {
              open: menuOpen,
              anchor: h(IconButton, {
                label: t('panel.actions'),
                icon: h(IconEllipsisOutlineMedium, { size: 16 }),
                disabled: busy !== null,
                onClick: () => setMenuOpen(open => !open),
              }),
              items: [{ id: 'clear', label: t('panel.clear'), icon: h(IconTrashOutlineRegular, { size: 16 }), danger: true, disabled: entries.length === 0 }],
              onSelect: () => clear('watchlist'),
              onClose: () => setMenuOpen(false),
              align: 'end',
              portal: true,
            }))),
        search(),
        body())
    }

    // ── plugin body ───────────────────────────────────────────────────────────

    /**
     * The sidebar entry's glyph, at the size the sidebar asks for and as its
     * direct icon child. The sidebar owns the entry's accessible name.
     *
     * @param props - the sidebar's icon share.
     * @returns the glyph.
     */
    function PanelIcon(props) {
      return h(IconGaugeOutlineRegular, { size: props.size })
    }

    /** Client services this bundle reads. */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries, the stylesheet, both Tool views, the sidebar
     * entry with the page it opens, and the outcome banner.
     *
     * @param ctx - the Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-stock: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      }, 'dsh-stock: stylesheet')
      ctx.slots.inject('tool.call.toolview', function* () {
        yield ctx.slots.register({ name: 'tool.call.toolview', key: 'stock_quote', locale: NS }, QuoteCard)
        yield ctx.slots.register({ name: 'tool.call.toolview', key: 'stock_watchlist', locale: NS }, WatchlistCard)
      })
      // The sidebar selects the page by the entry's id, so the two
      // registrations must agree. `label` is what the sidebar shows and names a
      // FLAT key: the locale service indexes dictionaries by exact key.
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => ctx.locale.bind(NS)('panel.title'),
      }, PanelIcon)), 'dsh-stock: sidebar entry')
      ctx.effect(() => ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, WatchlistPanel)
      }), 'dsh-stock: watchlist page')
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'stock.watchlist-toast',
        locale: NS,
      }, WatchlistToast)), 'dsh-stock: watchlist toast')
    }

    return { inject, apply }
  },
})

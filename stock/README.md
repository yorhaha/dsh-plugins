# dsh-stock

Stock, index, news, and macro queries as thirteen DeepSeek Harness Host tools
over public Tencent and East Money endpoints. Each tool call issues one GET,
coerces the response through strict field checks, and returns a bounded JSON
value to the model. What this package stores is the watchlist, the positions
marked on it, and the index row the panel shows above it.

The bundle also ships a Client half: a card for a settled result in the Web
conversation, and the watchlist panel the sidebar opens.

## Conversation card

`client.js` claims the `stock_quote` and `stock_watchlist` keys of the open
`tool.call.toolview` slot, so a settled call renders as a card instead of the
generic row: price, change, and metrics per code, plus the five-level order book
when the call asked for a single code. The watchlist card lists the followed
codes in their own order and names the ones upstream did not answer for. Every
other tool keeps the generic row.

The card derives everything from the JSON text block the tool already returned,
so it adds no model tokens, fetches nothing, and renders identically when an old
Session is replayed. Colors are theme tokens, copy is registered in this
package's own locale namespace (`zh` and `en`), and every derivation is
defensive: a failed call, malformed text, a quote whose items cannot be read, or
an empty item list falls back to a plain row with the raw text behind a
disclosure.

The two halves reach a running `dsh web` differently. A Host file — this
package's `index.js` — reloads the plugin in place: the profile's HMR entry
watches the linked plugin sources, so saving the file disposes and re-applies
the plugin with no restart. The Client half is served verbatim from the profile's
composed client module graph; the HMR transport stat-polls each bundle and
pushes a rebuilt frame to an open page, so saving `client.js` also lands without
a restart or a manual refresh.

## Watchlist

The sidebar entry (自选股 in Chinese, Watchlist in English) opens a panel over
the same lists the `stock_watchlist` tool edits. An **index row** sits above the
followed securities under its own heading: one horizontal strip of compact cells,
each carrying a mainland index's name, latest value, change, and the current
session as an intraday line. The strip has its own `+` control that searches
indexes only, its own `⋯` menu that clears it, and its own `indexMaxEntries`
bound; each cell's `⋯` menu moves that index along the strip or removes it. A
document that has never held an index row starts with the Shanghai composite, the
Shenzhen component, ChiNext, STAR 50, and the CSI 300; from then on the row holds
exactly what the user put there, and emptying it stays empty across restarts.

The followed securities sit below that row. Their rows carry the latest price,
change, and the session's open, high, and low; the day's amount and turnover rate
stay on the `stock_quote` card. Each row's `⋯` menu reorders or removes it, and
holds the action that marks the security as held. Marking opens an editor for an
optional average cost per share and share count; the row then keeps a `持仓`
badge and, in the price block, the cost and the profit or loss as bare figures.
The figures' hover title and the editor name the cost, share count, market value,
and profit. A mark with neither figure is valid and keeps only the badge. The
mark is stored with the entry, survives a restart, and the
`stock_watchlist` tool reads and writes it too. The header holds the search box
that adds a security and the action that clears the list after a confirmation. A
settled edit is announced by a toast that outlives the panel.

The page draws in the Web app's own page chrome rather than in its own: a 20px
title row with the count as a shared `Tag`, the same hairline rules and row
heights as the plugin page, the shared `Tag` badge for the day's move, and the
window-clearance insets a macOS frame publishes for the strip its titlebar and
controls occupy. The three figures of a row keep fixed columns and show a dash for
a field the quote does not carry, so the same metric reads straight down the list
and a row never changes height as quotes settle; a marked row keeps its holding
figures inside the price block, where they share the height of the row's metric
columns.

Each followed row and each index cell also draws the current session as an
intraday line, in the tone the day's change carries and with the previous close as
a baseline where it falls inside the session's range. The line is the series
`stock_minute` reads, thinned to `sparklinePoints`. It arrives in its own request
after the list, so a quote poll never waits on an upstream minute read; the Host
caches a series for `sparklineRefreshMs` and refetches at most
`sparklineMaxFetches` codes per request, so a list longer than that fills in over
successive polls — or over the panel's own follow-up rounds when a closed market
has stopped the quote poll — instead of pacing one whole refresh at a time. A row
or index cell whose line has not arrived — or that upstream holds no intraday
series for — keeps an empty box of the same size.

### Mobile

The panel reflows against its own width, not the window's: `.dsh-stock-panel` is
an inline-size query container, and a 640px / 420px pair of rules is emitted both
as `@container` queries (a narrow main column inside a wide window) and as
`@media` queries (a phone, including one whose browser predates container
queries). Below 640px the header wraps the market line under the title instead of
squeezing the tools, a followed security becomes a small card — the name line
keeps its `⋯` menu, the price and the day's change span the full width, the
intraday line and then the open/high/low figures follow it, and a holding's
editor takes the last line — and the index strip keeps two compact cells
per line rather than one tall stack. Inside an index cell the value shrinks and
the day's change moves onto its own line, so the intraday line takes the cell's
width instead of a sliver beside the numbers. The narrowest phones tighten the padding and
the metric grid, a coarse pointer gets a 34px hit target instead of the
pointer-tuned 28px control, and the conversation cards let their summary wrap
under the title. The desktop layout above is unchanged above 640px.

The panel reads and mutates over this bundle's own route,
`/api/plugin-stock/watchlist`, which the browser reaches with its session cookie.
The route serves quotes through the Host's own serialized, paced client: the page
never calls an upstream endpoint, so nothing in the browser can outrun the
request spacing, and search runs through the same rate-limited path.

It reads on open, and then on its own every `panelRefreshMs` — ten seconds by
default — for as long as the page is visible, auto-refresh is on, and at least one
market the two lists hold is in session. Outside a trading window it stops
polling and waits for the opening instant the Host reports in
`market.next_open_at`, so a closed market is not re-read just to discover it is
still closed. Coming back to the tab while a market is trading re-reads at once.
The switch beside the refresh control pauses and resumes that polling, its state
carried in the document's own storage (`dsh.stock.watchlist.settings`) so it
outlives the page; a deployment that sets `panelRefreshMs` to 0 polls nothing and
shows no switch. The refresh control always works, and a read that fails reports
itself with a retry instead of claiming an empty list.

Both lists are durable: one `stock` domain in the Harness storage root
(`$DSH_HOME/storages/stock.json`), holding `entries`, `indices`, and the instant
the last mutation landed, validated by the domain's own zod schema at every write
and again at every open. Each list behaves like this:

- A code is stored canonical (`sh600519`, `hk00700`), as `stock_search` returns
  it; adding an entry already present is reported instead of duplicated.
- Order is the user's, and `move` takes a 1-based position within the list the
  call named.
- `watchlistMaxEntries` bounds the followed securities and `indexMaxEntries` the
  index row; an addition that would pass either bound is reported in the result's
  `note` and is not stored.
- One unusable code rejects the whole call, so a batch never lands half-applied.
- `clear` needs `confirm: true`, from the tool and from the panel alike, and
  clears only the list it named.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `stock_search` | `keyword` (1–32 characters) | Canonical codes for matches in Shanghai, Shenzhen, Hong Kong, and the US; upstream matches a name or pinyin by prefix and takes at most 23 bytes of keyword, so a longer keyword is searched as its longest prefix within that and the result says so; Beijing is not searchable here |
| `stock_quote` | `codes` (1–20) | Price, change, volume and amount, valuation, market capitalization, the five-level order book, and the quote time |
| `stock_kline` | `code`, `count` (1–800, default 120), `adjust` (`auto`/`qfq`/`hfq`/`none`) | The newest daily bars for the code |
| `stock_minute` | `code` | The intraday minute series of the most recent trading day: time, price, and cumulative volume (some markets add the cumulative amount) |
| `stock_bars` | `code`, `period` (`m1`/`m5`/`m15`/`m30`/`m60`/`m120`, default `m5`), `count` (1–320, default 120) | Minute bars for a Shanghai or Shenzhen code or index, spanning as many sessions as `count` reaches; each bar carries its open, close, high, low, volume in lots, and the turnover rate it contributed |
| `stock_minute_history` | `code`, `days` (1–5), `detail` (`summary`/`rows`) | The intraday series of the most recent trading days upstream holds: each day's aggregates, computed from its rows, or the rows themselves |
| `stock_moneyflow` | `code`, `range` (`daily`/`intraday`), `days` (1–60, default 20) | Net main, small, medium, large, and extra-large order amounts, their share of turnover, the close, and the day's change; `intraday` returns the session's running totals |
| `stock_fundamentals` | `code`, `periods` (1–12, default 4) | Revenue and net profit with their year-on-year change, basic and deducted EPS, weighted ROE, gross margin, book value and operating cash flow per share, the industry, and the notice date |
| `stock_market` | none | Six mainland indexes with their open, high, low, previous close, volume, amount, and the advance, decline, and unchanged counts of the market each tracks |
| `stock_rank` | `scope` (`sector`/`stock`), `board`, `sort` (`change_pct`/`turnover`/`volume`), `order` (`top`/`bottom`), `count` (1–50), `offset` | A ranked board list: sector boards over the `hy`/`dy`/`gn`/`all` sets, or the securities of the `aStock`/`cyb` boards |
| `stock_news` | `code`, `limit` (1–20, default 10) | The newest news items upstream holds for one code, newest first: time, title, publisher, link, and the summary when upstream carries one. The endpoint answers one fixed block of 20 and takes no page, so a larger limit reaches no further back |
| `stock_macro` | `indicator` (`gdp`/`cpi`/`ppi`/`pmi`/`m2`), `periods` (1–24, default 6) | The newest periods of one mainland macro indicator, newest first, with that indicator's own value fields: GDP in 100 million yuan, consumer and producer prices in percent, the two purchasing-manager readings, and the M2 and M1 stock in 100 million yuan |
| `stock_watchlist` | `action` (`list`/`add`/`remove`/`move`/`mark`/`unmark`/`clear`), `scope` (`watchlist`/`index`), `codes` (1–50), `code`, `to` (1-based position), `cost` and `quantity` (mark only, positive), `confirm` | The addressed list with its quotes and holding marks in the list's own order, and what the action changed; the same two lists the sidebar panel edits, `watchlist` by default. `mark` records a holding on a followed security, keeping a figure the call omits; `unmark` clears it. `holdings` repeats every marked entry with `price`, `market_value`, `profit`, and `profit_pct`, derived the way the panel derives them (in the security's own currency, rounded to two places); a figure whose input is missing is `null`, and a cost of zero yields no return rather than a division by zero. |

Codes are `sh600519`, `sz399001`, `bj920008`, `hk00700`, and `usAAPL`; a US code
takes its exchange suffix (`.OQ`, `.N`, `.PS`, `.AM`) where the endpoint needs
one, and `stock_kline` and `stock_moneyflow` require it. An index accepts only
the `none` adjustment, and a US daily bar is available only as `qfq`.

Coverage differs by endpoint, and each tool says so in its own description:

| Tool | Served for |
|---|---|
| `stock_bars` | Shanghai and Shenzhen only; Hong Kong, US, and Beijing codes are rejected with a pointer to `stock_minute` |
| `stock_minute_history` | Shanghai, Shenzhen, Beijing, and Hong Kong; upstream holds five trading days and takes no date |
| `stock_moneyflow` | Every served market for `daily`; `intraday` is limited to Shanghai, Shenzhen, and Beijing, where the running totals reconcile with the daily row |
| `stock_fundamentals` | Shanghai, Shenzhen, and Beijing |
| `stock_market`, `stock_rank` | Mainland listings; the ranking endpoint serves only the `aStock` and `cyb` boards and the three sort keys above |
| `stock_news` | Every served market, one code per call; upstream holds one fixed block of 20 items and takes no page |
| `stock_macro` | Mainland macro reports only, one indicator per call, from the closed catalog in `index.js` |

Every quote, bar, row, and report value carries a `snapshot.queried_at`, the
instant this process issued the request; how old the value itself is comes from
the item's own `as_of` where the endpoint reports one (a ranking row carries
none, so it is a snapshot of the moment it was read). An upstream-omitted field
is `null` rather than absent. A `note` appears only when that particular result
needs one: no match, matches outside the served markets, no bars, an adjustment
upstream did not apply, a bar that may not have settled, or a series shorter
than the days requested. The standing caveats live once in a constant
`stock:caveats` prompt section, registered beside the tools: the quote endpoints
carry no stability guarantee, no market data is stored locally, complete
coverage is not claimed, and quotes are not investment advice. A caveat that
concerns one tool alone — the Beijing gap in `stock_search`, the US exchange
suffix for daily bars — stays in that tool's own description.

## Failures

Argument validation throws, so the model sees the correction it has to make.
Everything after that comes back as a value instead of losing the call:

```json
{ "ok": false, "source": "stock", "error": { "code": "not_found", "message": "…", "retryable": false } }
```

The closed codes are `invalid_response`, `not_found`, `timeout`,
`network_error`, `rate_limited`, `access_denied`, `upstream_unavailable`,
`response_too_large`, and `temporarily_blocked`. A backoff failure adds
`retry_at`, the wall-clock instant this process may request that host again.

## Requests

One process-local client serves all thirteen tools and the panel route —
including the intraday line every panel row and index cell draws — so requests
are serialized, spaced by `minIntervalMs`, and backed off per host after a
transport, 5xx, 403, or 429 failure. A host that fails or refuses requests
stops only itself: the other hosts keep answering, so one unreliable endpoint
family cannot take the working ones down with it. Seven hosts, sixteen endpoint
paths, and each path's parameter keys, and the values this plugin derives for
them, are a closed whitelist; no redirect is followed, no ambient proxy is read,
and a response body is capped at `responseLimitBytes`. That state disappears
when the process exits; the watchlist does not.

Three upstream families sit behind those paths. Tencent's `qt.gtimg.cn`,
`web.ifzq.gtimg.cn`, and `smartbox.gtimg.cn` serve the search, quote, daily-bar,
and intraday endpoints; `proxy.finance.qq.com` serves minute bars, the board
rankings, and per-symbol news, because the `web.ifzq.gtimg.cn` path for minute
bars now answers with a redirect to a host that does not resolve. `stock_minute`
reads the intraday series through `web.ifzq.gtimg.cn`'s multi-day path and
reports its newest day, because the single-day path answers every request with
an anti-bot challenge page that no header and no cookie clears; the US series
keeps its own single-day endpoint. East Money's
`push2.eastmoney.com`, `push2his.eastmoney.com`, and
`datacenter-web.eastmoney.com` serve the market overview, money flow,
report-period fundamentals, and the macro reports, none of which Tencent still
publishes. A redirect or a rejection is reported as `invalid_response`
rather than followed or retried against another host.

## Configuration

`cordis.patch.yml` carries every key at its default; override the row from your
own patch layer to change one.

| Key | Default | Meaning |
|---|---|---|
| `userAgent` | `dsh-stock/0.1` | Request `User-Agent` |
| `requestTimeoutMs` | `10000` | Per-attempt timeout |
| `responseLimitBytes` | `1048576` | Largest body read |
| `minIntervalMs` | `1000` | Minimum spacing between requests |
| `retryDelayMs` | `1000` | Wait before the single retry |
| `pauseNetworkMs` | `60000` | Backoff after a transport or 5xx failure |
| `pauseBlockedMs` | `300000` | Backoff after 429 or 403 |
| `keywordMaxChars` | `32` | Largest search keyword |
| `quoteMaxCodes` | `20` | Largest quote batch |
| `klineDefaultCount` | `120` | Bars returned when `count` is absent |
| `klineMaxCount` | `800` | Largest accepted `count` |
| `barsDefaultCount` | `120` | Minute bars returned when `count` is absent |
| `barsMaxCount` | `320` | Largest accepted minute-bar `count`, which is also the endpoint's own cap |
| `minuteHistoryMaxDays` | `5` | Largest accepted `days`, which is also every day upstream holds |
| `moneyflowDefaultDays` | `20` | Daily money-flow rows returned when `days` is absent |
| `moneyflowMaxDays` | `60` | Largest accepted money-flow `days` |
| `fundamentalsDefaultPeriods` | `4` | Report periods returned when `periods` is absent |
| `fundamentalsMaxPeriods` | `12` | Largest accepted `periods` |
| `newsDefaultLimit` | `10` | News items returned when `limit` is absent |
| `newsMaxLimit` | `20` | Largest accepted `limit`, which is also the size of the block upstream holds |
| `macroDefaultPeriods` | `6` | Macro periods returned when `periods` is absent |
| `macroMaxPeriods` | `24` | Largest accepted macro `periods` |
| `rankDefaultCount` | `20` | Ranking rows returned when `count` is absent |
| `rankMaxCount` | `50` | Largest accepted ranking `count` |
| `rankMaxOffset` | `5000` | Largest accepted ranking `offset` |
| `toolTimeoutMs` | `60000` | Tool-call budget attached to each tool |
| `watchlistMaxEntries` | `50` | Largest stored watchlist |
| `indexMaxEntries` | `10` | Largest stored index row |
| `panelRefreshMs` | `10000` | Interval the open panel re-reads while at least one listed market is in session and the page is visible; `0` disables polling |
| `sparklinePoints` | `60` | Points one row's intraday line keeps, at least 2 |
| `sparklineRefreshMs` | `120000` | How long a cached intraday series is reused before it is read again |
| `sparklineMaxFetches` | `4` | Intraday reads one panel request waits for; `0` stops asking for lines |

## Verifying a change

`index.js` is plain dependency-free ESM, so `node --check` and a direct import
both work. `pnpm test` in this directory runs the three offline checks. Each
also runs on its own from this directory after `pnpm install`:

```sh
node tests/verify-watchlist.mjs   # the list, its store, and the panel route
node tests/verify-endpoints.mjs   # the endpoint quirks a live series cannot produce on demand
node tests/verify-cards.mjs       # the quote card
```

`verify-watchlist.mjs` scripts the transport and stands in for the mounted
storage domain, then covers what a live series cannot produce on demand:
canonicalization, deduplication, the configured maximum, the atomic reject of an
unusable code, the concurrent adds the store's mutation chain serializes, the
same list reopening after a restart, holding marks and their persistence, the
next opening instant a closed market reports, and the panel route's row
compaction, defect responses, and body limit — including the intraday series its
own action serves, the read budget that leaves a long list pending, the cache
that keeps a series inside its window, and the failure a code with no series is
reported as rather than retried forever.

`verify-endpoints.mjs` scripts the same transport for the search, intraday, and
multi-day intraday paths, and covers the upstream quirks a live series cannot be
asked for: a keyword longer than the 23 bytes upstream matches is searched as its
longest prefix and the result says so, the newest intraday row may restate the
cumulative amount below the row before it, and a decrease anywhere else still
fails the call.

The Client half is checked against the JSON those same tools return.
`verify-cards.mjs` loads `client.js` under the module-loader contract, renders
the quote card with real React in both locales, drives its raw-data disclosure
with real events in jsdom, and asserts that every malformed payload still falls
back instead of claiming data it cannot show. It also asserts that every locale
key resolves and that every primitive the bundle requests exists in the shared
library.

The card's payloads are recorded in `tests/fixtures/`, so the check needs no
network and replays the same bytes every run; `--record` replaces them from the
live endpoints. React, ReactDOM, and jsdom come from this package's
devDependencies, so the Client check needs `pnpm install` but no harness
checkout.

## Limitations

The endpoints carry no stability guarantee, so a value is the latest snapshot
upstream returned and may be delayed, stale, or internally inconsistent. The
newest intraday row may restate the day's cumulative amount below the row before
it while upstream is still finalizing that session; the series is returned as
upstream writes it, and `stock_minute` notes the restatement. Search matches a
name or pinyin by prefix only and takes at most 23 bytes of keyword, so an exact
long name can match nothing. Coverage of securities, history, and trading sessions is not complete: search
skips the Beijing exchange, which accepts only the current 920 stock codes and
899 index codes; the intraday series describes the most recent trading day
upstream has rather than today; minute bars exist only for Shanghai and
Shenzhen; the multi-day series covers five trading days and cannot name a
date; fundamentals and rankings cover mainland listings only; and the ranking
endpoint serves three sort keys over two security boards. `stock_news` returns
the one block of items upstream holds, so it cannot page, carries no article
text beyond the link, and keeps each item's title as upstream wrote it; its
times are Beijing wall-clock time. `stock_macro` covers the mainland reports in
its catalog, states each period as its publisher labels it, and reports the
money-supply fields by magnitude — the report calls M2 `BASIC_CURRENCY`. A row's or index cell's
intraday line describes the same session `stock_minute` reports, so outside a
trading window it is the last session upstream holds; a list longer than one
request's read budget draws its lines over successive polls. A marked position's
market value and profit or loss are derived from the latest quote in that
security's own currency, without conversion or fees. The watchlist panel's open
or closed indicator and next-opening instant read the weekday and the session
clock: they do not model exchange holidays. Quotes are not investment advice.

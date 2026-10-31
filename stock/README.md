# dsh-stock

Stock, index, news, and macro queries as thirteen DeepSeek Harness Host tools
over public Tencent and East Money endpoints. Each call issues one GET, coerces
the response through strict field checks, and returns a bounded JSON value. What
this package stores is the watchlist, the positions marked on it, and the index
row the panel shows above it.

The bundle also ships a Client half: a card for a settled `stock_quote` or
`stock_watchlist` call, and the watchlist panel the sidebar opens.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `stock_search` | `keyword` (1–32 characters) | Canonical codes for matches in Shanghai, Shenzhen, Hong Kong, and the US; upstream matches a name or pinyin by prefix and takes at most 23 bytes of keyword, so a longer keyword is searched as its longest prefix; Beijing is not searchable here |
| `stock_quote` | `codes` (1–20) | Price, change, volume and amount, valuation, market capitalization, the five-level order book, and the quote time |
| `stock_kline` | `code`, `count` (1–800, default 120), `adjust` (`auto`/`qfq`/`hfq`/`none`) | The newest daily bars |
| `stock_minute` | `code` | The intraday minute series of the most recent trading day: time, price, cumulative volume (some markets add the amount) |
| `stock_bars` | `code`, `period` (`m1`/`m5`/`m15`/`m30`/`m60`/`m120`, default `m5`), `count` (1–320, default 120) | Minute bars for a Shanghai or Shenzhen code, spanning as many sessions as `count` reaches |
| `stock_minute_history` | `code`, `days` (1–5), `detail` (`summary`/`rows`) | The intraday series of the most recent trading days upstream holds |
| `stock_moneyflow` | `code`, `range` (`daily`/`intraday`), `days` (1–60, default 20) | Net main, small, medium, large, and extra-large order amounts with their share of turnover, the close, and the day's change |
| `stock_fundamentals` | `code`, `periods` (1–12, default 4) | Revenue and net profit with year-on-year change, basic and deducted EPS, weighted ROE, gross margin, book value and operating cash flow per share, industry, notice date |
| `stock_market` | none | Six mainland indexes with their OHLC, previous close, volume, amount, and the advance/decline/unchanged counts of the market each tracks |
| `stock_rank` | `scope` (`sector`/`stock`), `board`, `sort` (`change_pct`/`turnover`/`volume`), `order`, `count` (1–50), `offset` | A ranked board list: sector boards over `hy`/`dy`/`gn`/`all`, or the securities of `aStock`/`cyb` |
| `stock_news` | `code`, `limit` (1–20, default 10) | The newest news items upstream holds for one code: time, title, publisher, link, summary when present. One fixed block of 20, no paging |
| `stock_macro` | `indicator` (`gdp`/`cpi`/`ppi`/`pmi`/`m2`), `periods` (1–24, default 6) | The newest periods of one mainland macro indicator |
| `stock_watchlist` | `action` (`list`/`add`/`remove`/`move`/`mark`/`unmark`/`clear`), `scope`, `codes`, `code`, `to`, `cost`, `quantity`, `confirm` | The addressed list with quotes and holding marks, and what changed. `holdings` repeats every marked entry with `price`, `market_value`, `profit`, `profit_pct` |

Codes are `sh600519`, `sz399001`, `bj920008`, `hk00700`, `usAAPL`; a US code
takes its exchange suffix (`.OQ`, `.N`, `.PS`, `.AM`) where the endpoint needs
one, and `stock_kline` and `stock_moneyflow` require it. An index accepts only
the `none` adjustment; a US daily bar is available only as `qfq`.

Coverage differs by endpoint, and each tool says so in its own description:

| Tool | Served for |
|---|---|
| `stock_bars` | Shanghai and Shenzhen only; other codes are rejected with a pointer to `stock_minute` |
| `stock_minute_history` | Shanghai, Shenzhen, Beijing, and Hong Kong; upstream holds five trading days and takes no date |
| `stock_moneyflow` | Every served market for `daily`; `intraday` only for Shanghai, Shenzhen, and Beijing |
| `stock_fundamentals` | Shanghai, Shenzhen, and Beijing |
| `stock_market`, `stock_rank` | Mainland listings; ranking serves only `aStock` and `cyb` |
| `stock_news`, `stock_macro` | Every served market, one code per call / mainland macro reports only |

Every quote, bar, row, and report carries a `snapshot.queried_at`, the instant
this process issued the request; the value's own age comes from the item's
`as_of` where the endpoint reports one. An upstream-omitted field is `null`
rather than absent. A `note` appears only when that result needs one. The
standing caveats live once in a constant `stock:caveats` prompt section: the
quote endpoints carry no stability guarantee, no market data is stored locally,
complete coverage is not claimed, and quotes are not investment advice.

## Watchlist

The sidebar entry (自选股 / Watchlist) edits the same two lists the tool edits,
over this bundle's own route `/api/plugin-stock/watchlist`. The page never calls
an upstream endpoint: quotes go through the Host's serialized, paced client, so
nothing in the browser can outrun the request spacing.

An **index row** sits above the followed securities, each cell carrying a
mainland index's name, latest value, change, and the session as an intraday
line. It has its own `+` control (searching indexes only), its own `⋯` menu that
clears it, and its own `indexMaxEntries` bound. A document that has never held an
index row starts with the Shanghai composite, the Shenzhen component, ChiNext,
STAR 50, and the CSI 300; from then on it holds exactly what the user put there,
and emptying it stays empty across restarts.

Followed rows carry the latest price, change, and the session's open, high, and
low; amount and turnover rate stay on the `stock_quote` card. Each row's `⋯`
menu reorders or removes it and marks the security as held, with an optional
average cost per share and share count. A marked row keeps a `持仓` badge plus
the cost and profit as bare figures; a mark with neither figure is valid and
keeps only the badge. The mark is stored with the entry, survives a restart, and
the tool reads and writes it too.

Each followed row and index cell also draws the current session as an intraday
line, in the tone the day's change carries, with the previous close as a
baseline where it falls inside the range. The line is the series `stock_minute`
reads, thinned to `sparklinePoints`, fetched in its own request after the list so
a quote poll never waits on it; the Host caches a series for
`sparklineRefreshMs` and refetches at most `sparklineMaxFetches` codes per
request, so a long list fills in over successive polls.

The panel reflows against its own width (a container query plus a matching
`@media` pair at 640px and 420px), so a phone and a narrow main column behave the
same. It reads on open, then every `panelRefreshMs` while the page is visible,
auto-refresh is on, and at least one listed market is in session; outside a
trading window it waits for `market.next_open_at` instead of re-reading a closed
market. The switch beside the refresh control pauses that polling and its state
lives in the document's storage; `panelRefreshMs: 0` polls nothing and shows no
switch.

Both lists are durable: one `stock` domain in the storage root
(`$DSH_HOME/storages/stock.json`) holding `entries`, `indices`, and the instant
of the last mutation, validated by the domain's zod schema at every write and
every open. A code is stored canonical as `stock_search` returns it, adding a
duplicate is reported instead of duplicated, order is the user's, `move` takes a
1-based position within the list named, the two `*MaxEntries` bounds report an
addition in `note` without storing it, one unusable code rejects the whole call,
and `clear` needs `confirm: true` and clears only the list it named.

## Failures

Argument validation throws, so the model sees the correction it has to make.
Everything after that comes back as a value:

```json
{ "ok": false, "source": "stock", "error": { "code": "not_found", "message": "…", "retryable": false } }
```

The closed codes are `invalid_response`, `not_found`, `timeout`,
`network_error`, `rate_limited`, `access_denied`, `upstream_unavailable`,
`response_too_large`, and `temporarily_blocked`. A backoff failure adds
`retry_at`.

## Requests

One process-local client serves all thirteen tools and the panel route, so
requests are serialized, spaced by `minIntervalMs`, and backed off per host after
a transport, 5xx, 403, or 429 failure. A host that fails stops only itself.
Seven hosts, sixteen endpoint paths, and each path's parameter keys are a closed
whitelist; no redirect is followed, no ambient proxy is read, and a body is
capped at `responseLimitBytes`.

Tencent's `qt.gtimg.cn`, `web.ifzq.gtimg.cn`, and `smartbox.gtimg.cn` serve
search, quote, daily bars, and intraday; `proxy.finance.qq.com` serves minute
bars, board rankings, and per-symbol news, because the `web.ifzq` path for
minute bars now redirects to a host that does not resolve. `stock_minute` reads
through `web.ifzq`'s multi-day path and reports its newest day, because the
single-day path answers every request with an anti-bot challenge; the US series
keeps its own single-day endpoint. East Money's `push2.eastmoney.com`,
`push2his.eastmoney.com`, and `datacenter-web.eastmoney.com` serve the market
overview, money flow, fundamentals, and macro reports.

## Configuration

`cordis.patch.yml` carries every key at its default; override the row from your
own patch layer.

| Key | Default | Meaning |
|---|---|---|
| `userAgent` | `dsh-stock/0.1` | Request `User-Agent` |
| `requestTimeoutMs` | `10000` | Per-attempt timeout |
| `responseLimitBytes` | `1048576` | Largest body read |
| `minIntervalMs` / `retryDelayMs` | `1000` / `1000` | Minimum spacing; wait before the single retry |
| `pauseNetworkMs` / `pauseBlockedMs` | `60000` / `300000` | Backoff after a transport or 5xx failure; after 429 or 403 |
| `keywordMaxChars` / `quoteMaxCodes` | `32` / `20` | Largest search keyword; largest quote batch |
| `klineDefaultCount` / `klineMaxCount` | `120` / `800` | Bars returned when `count` is absent; largest accepted |
| `barsDefaultCount` / `barsMaxCount` | `120` / `320` | Minute bars default and cap |
| `minuteHistoryMaxDays` | `5` | Largest `days`, also every day upstream holds |
| `moneyflowDefaultDays` / `moneyflowMaxDays` | `20` / `60` | Money-flow rows |
| `fundamentalsDefaultPeriods` / `fundamentalsMaxPeriods` | `4` / `12` | Report periods |
| `newsDefaultLimit` / `newsMaxLimit` | `10` / `20` | News items |
| `macroDefaultPeriods` / `macroMaxPeriods` | `6` / `24` | Macro periods |
| `rankDefaultCount` / `rankMaxCount` / `rankMaxOffset` | `20` / `50` / `5000` | Ranking rows and offset |
| `toolTimeoutMs` | `60000` | Tool-call budget |
| `watchlistMaxEntries` / `indexMaxEntries` | `50` / `10` | Largest stored watchlist; largest index row |
| `panelRefreshMs` | `10000` | Interval the open panel re-reads; `0` disables polling |
| `sparklinePoints` | `60` | Points one row's intraday line keeps, at least 2 |
| `sparklineRefreshMs` / `sparklineMaxFetches` | `120000` / `4` | Cache window for a series; intraday reads one panel request waits for (`0` stops asking) |

## Verifying a change

`index.js` is plain dependency-free ESM, so `node --check` and a direct import
both work. `pnpm test` runs the three offline checks:

```sh
node tests/verify-watchlist.mjs   # the list, its store, and the panel route
node tests/verify-endpoints.mjs   # the endpoint quirks a live series cannot produce on demand
node tests/verify-cards.mjs       # the quote card
```

`verify-watchlist.mjs` scripts the transport and stands in for the mounted
storage domain, then covers canonicalization, deduplication, the configured
maximum, the atomic reject, the concurrent adds the store's mutation chain
serializes, reopening after a restart, holding marks, the next opening instant,
and the route's row compaction, defect responses, body limit, read budget,
series cache, and the failure a code with no series reports. `verify-endpoints.mjs`
covers the 23-byte keyword prefix, the newest intraday row restating the
cumulative amount below the row before it, and a decrease anywhere else failing
the call. `verify-cards.mjs` loads `client.js` under the module-loader contract,
renders the card with real React in both locales, drives its raw-data disclosure
in jsdom, and asserts every malformed payload still falls back. Card payloads are
recorded in `tests/fixtures/`; `--record` replaces them from the live endpoints.

## Limitations

The endpoints carry no stability guarantee, so a value is the latest snapshot
upstream returned and may be delayed, stale, or internally inconsistent. The
newest intraday row may restate the day's cumulative amount while upstream
finalizes that session, and the series is returned as written. Search matches by
prefix only and takes at most 23 bytes, so an exact long name can match nothing.
Coverage is not complete: search skips the Beijing exchange (which accepts only
current 920 stock codes and 899 index codes), the intraday series describes the
most recent trading day upstream has rather than today, minute bars exist only
for Shanghai and Shenzhen, the multi-day series covers five trading days and
cannot name a date, fundamentals and rankings cover mainland listings only, and
ranking serves three sort keys over two boards. `stock_news` cannot page, carries
no article text beyond the link, and uses Beijing wall-clock time.
`stock_macro` states each period as its publisher labels it and reports the
money-supply fields by magnitude — the report calls M2 `BASIC_CURRENCY`. A row's
intraday line describes the same session `stock_minute` reports. A marked
position's market value and profit are derived from the latest quote in that
security's own currency, without conversion or fees. The panel's open/closed
indicator reads the weekday and the session clock; it does not model exchange
holidays. Quotes are not investment advice.

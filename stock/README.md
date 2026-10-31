# dsh-stock

沪深、港股、美股的行情、指数、新闻与宏观查询，注册为十三个 Host 工具，走腾讯与东方财富的公开接口。每次调用发一个 GET，按严格字段校验转换响应，返回有界的 JSON。本地只存三样东西：自选股、在自选股上标的持仓，以及面板上方那行指数。

本 bundle 还带浏览器半边：`stock_quote` / `stock_watchlist` 的结果卡，以及侧栏打开的自选股面板。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `stock_search` | `keyword`（1–32 字符） | 沪深、港、美匹配项的标准代码；上游按名称或拼音前缀匹配且只取 23 字节，更长的关键词按最长前缀搜索；北交所不可搜 |
| `stock_quote` | `codes`（1–20） | 价格、涨跌、成交量与成交额、估值、市值、五档盘口、报价时间 |
| `stock_kline` | `code`、`count`（1–800，默认 120）、`adjust`（`auto`/`qfq`/`hfq`/`none`） | 最新日线 |
| `stock_minute` | `code` | 上游最近一个交易日的分时：时间、价格、累计成交量（部分市场另有成交额） |
| `stock_bars` | `code`、`period`（`m1`/`m5`/`m15`/`m30`/`m60`/`m120`，默认 `m5`）、`count`（1–320，默认 120） | 沪深分钟线，`count` 够大时跨多个交易日 |
| `stock_minute_history` | `code`、`days`（1–5）、`detail`（`summary`/`rows`） | 上游持有的最近几个交易日的分时 |
| `stock_moneyflow` | `code`、`range`（`daily`/`intraday`）、`days`（1–60，默认 20） | 主力、小单、中单、大单、超大单净额及各自占比、收盘价、当日涨跌 |
| `stock_fundamentals` | `code`、`periods`（1–12，默认 4） | 营收与净利及其同比、基本与扣非 EPS、加权 ROE、毛利率、每股净资产与经营现金流、行业、公告日 |
| `stock_market` | 无 | 六个内地指数及其 OHLC、昨收、成交量、成交额，以及该指数所覆盖市场的涨/跌/平家数 |
| `stock_rank` | `scope`（`sector`/`stock`）、`board`、`sort`（`change_pct`/`turnover`/`volume`）、`order`、`count`（1–50）、`offset` | 榜单：`sector` 取 `hy`/`dy`/`gn`/`all` 板块，`stock` 取 `aStock`/`cyb` 个股 |
| `stock_news` | `code`、`limit`（1–20，默认 10） | 上游为该代码持有的最新新闻：时间、标题、来源、链接，有摘要时带摘要；固定一块 20 条，不能翻页 |
| `stock_macro` | `indicator`（`gdp`/`cpi`/`ppi`/`pmi`/`m2`）、`periods`（1–24，默认 6） | 某项内地宏观指标的最新若干期 |
| `stock_watchlist` | `action`（`list`/`add`/`remove`/`move`/`mark`/`unmark`/`clear`）、`scope`、`codes`、`code`、`to`、`cost`、`quantity`、`confirm` | 被寻址的清单连同行情与持仓标记，以及本次改了什么；`holdings` 逐条给出 `price`、`market_value`、`profit`、`profit_pct` |

代码形如 `sh600519`、`sz399001`、`bj920008`、`hk00700`、`usAAPL`；美股在接口需要时带交易所后缀（`.OQ`、`.N`、`.PS`、`.AM`），`stock_kline` 与 `stock_moneyflow` 必须有。指数只接受 `none` 复权；美股日线只有 `qfq`。

覆盖范围按接口而异，每个工具在自己的描述里都写了：

| 工具 | 支持的市场 |
| --- | --- |
| `stock_bars` | 只有沪深；其他代码被拒绝，并指向 `stock_minute` |
| `stock_minute_history` | 沪深、北交所、港股；上游只留五个交易日，不接受日期 |
| `stock_moneyflow` | `daily` 覆盖全部已支持市场；`intraday` 只有沪深北 |
| `stock_fundamentals` | 沪深北 |
| `stock_market`、`stock_rank` | 内地上市；榜单只服务 `aStock` 与 `cyb` |
| `stock_news`、`stock_macro` | 全部已支持市场，一次一个代码 / 只有内地宏观报告 |

每条行情、K 线、榜单行与财报都带 `snapshot.queried_at`（本进程发出请求的时刻），数据自身的时点看接口给出的 `as_of`。上游省略的字段记 `null` 而不是不出现。`note` 只在这次结果需要说明时出现。长期有效的免责说明集中在一个常量提示段 `stock:caveats`：行情接口没有稳定性承诺、本地不存行情、不保证覆盖完整、行情不构成投资建议。

## 自选股

侧栏「自选股」面板与工具改的是同两份清单，走本 bundle 自己的路由 `/api/plugin-stock/watchlist`。面板从不直接请求上游：行情都经 Host 那条串行、有节奏的客户端，浏览器跑不过请求间隔。

清单上方有一行**指数行**，每格是一个内地指数的名称、最新值、涨跌，以及当日分时线。它有独立的 `+`（只搜指数）、独立的 `⋯`（清空）和独立的 `indexMaxEntries` 上限。从未放过指数行的文档初始为上证、深证成指、创业板指、科创 50、沪深 300；此后只保留用户放进去的，清空后就一直是空的，重启也一样。

自选行显示最新价、涨跌和当日开盘、最高、最低；成交额与换手率留在 `stock_quote` 的结果卡上。每行的 `⋯` 可重排、删除，或把它标为持仓，可带平均成本与股数。标记过的行带 `持仓` 徽标，成本与盈亏按裸数字显示；两个数字都不给的标记同样有效，只留徽标。标记随条目存储、重启后仍在，工具也读写它。

每个自选行与指数格还会画当日分时线，颜色取当日涨跌方向，昨收在区间内时作为基准线。数据就是 `stock_minute` 读的那条序列，按 `sparklinePoints` 抽稀，在清单之后单独发一次请求，所以行情轮询从不等它；Host 按 `sparklineRefreshMs` 缓存一条序列，每次请求最多取 `sparklineMaxFetches` 个代码，长清单靠后续轮询逐步补齐。

面板按自身宽度重排（容器查询加配套的 `@media`，断点 640px 与 420px），手机与窄主栏表现一致。打开时读一次，之后在页面可见、自动刷新打开、且至少一个已列市场在交易时段内时每 `panelRefreshMs` 读一次；收盘时段改为等 `market.next_open_at`，不反复读已收盘的市场。刷新控件旁的开关暂停轮询，状态存在文档里；`panelRefreshMs: 0` 不轮询，也不显示开关。

两份清单都持久化：storage 根下的一个 `stock` domain（`$DSH_HOME/storages/stock.json`），装 `entries`、`indices` 和最后一次改动的时刻，每次写入与每次打开都过 domain 的 zod schema。代码按 `stock_search` 返回的原样规范存储，加重复项会被报告而不是重复写入，顺序就是用户的顺序，`move` 取所指清单内从 1 开始的位置，两个 `*MaxEntries` 上限在 `note` 里报告「没存进去」，一个不可用的代码会整次拒绝，`clear` 需要 `confirm: true` 且只清它点名的清单。

## 失败

参数校验直接抛错，模型能看到要改什么。之后的失败都作为值返回：

```json
{ "ok": false, "source": "stock", "error": { "code": "not_found", "message": "…", "retryable": false } }
```

`code` 是封闭集合：`invalid_response`、`not_found`、`timeout`、`network_error`、`rate_limited`、`access_denied`、`upstream_unavailable`、`response_too_large`、`temporarily_blocked`。退避类失败另带 `retry_at`。

## 请求

一个进程内客户端服务全部十三个工具与面板路由，所以请求串行、按 `minIntervalMs` 间隔，并在传输失败、5xx、403 或 429 后按 host 退避。某个 host 失败只停它自己。七个 host、十五条端点路径，每条路径的参数键是封闭白名单；不跟随重定向，不读环境代理，响应体上限 `responseLimitBytes`。

腾讯侧：`qt.gtimg.cn`、`web.ifzq.gtimg.cn`、`smartbox.gtimg.cn` 提供搜索、行情、日线、分时；`proxy.finance.qq.com` 提供分钟线、板块榜单与个股新闻，因为 `web.ifzq` 的分钟线路径已重定向到一个解析不了的 host。`stock_minute` 走 `web.ifzq` 的多日路径并报告其中最新一天，因为单日路径对每个请求都回反爬挑战；美股序列保留自己的单日端点。东方财富侧：`push2.eastmoney.com`、`push2his.eastmoney.com`、`datacenter-web.eastmoney.com` 提供市场总览、资金流、财务与宏观报告。

## 配置

`cordis.patch.yml` 的行里不写 config，默认值只有一份，在 `index.js` 的 `DEFAULT_CONFIG`。要改就在自己的 patch 层按行 `id` 覆盖——注意 `config` 是整体替换、不做深合并，没写进去的键回到默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `userAgent` | `dsh-stock/0.1` | 请求的 `User-Agent` |
| `requestTimeoutMs` | `10000` | 单次尝试超时 |
| `responseLimitBytes` | `1048576` | 最大读取字节 |
| `minIntervalMs` / `retryDelayMs` | `1000` / `1000` | 最小间隔；唯一那次重试前的等待 |
| `pauseNetworkMs` / `pauseBlockedMs` | `60000` / `300000` | 传输或 5xx 失败后的退避；429 或 403 后的退避 |
| `keywordMaxChars` / `quoteMaxCodes` | `32` / `20` | 搜索词上限；行情批量上限 |
| `klineDefaultCount` / `klineMaxCount` | `120` / `800` | 省略 `count` 时返回的条数；可接受的最大值 |
| `barsDefaultCount` / `barsMaxCount` | `120` / `320` | 分钟线的默认与上限 |
| `minuteHistoryMaxDays` | `5` | `days` 的上限，也是上游持有的全部天数 |
| `moneyflowDefaultDays` / `moneyflowMaxDays` | `20` / `60` | 资金流行数 |
| `fundamentalsDefaultPeriods` / `fundamentalsMaxPeriods` | `4` / `12` | 报告期数 |
| `newsDefaultLimit` / `newsMaxLimit` | `10` / `20` | 新闻条数 |
| `macroDefaultPeriods` / `macroMaxPeriods` | `6` / `24` | 宏观期数 |
| `rankDefaultCount` / `rankMaxCount` / `rankMaxOffset` | `20` / `50` / `5000` | 榜单行数与偏移 |
| `toolTimeoutMs` | `60000` | 单次工具调用预算 |
| `watchlistMaxEntries` / `indexMaxEntries` | `50` / `10` | 自选股上限；指数行上限 |
| `panelRefreshMs` | `10000` | 打开的面板重读间隔；`0` 关闭轮询 |
| `sparklinePoints` | `60` | 一行分时线保留的点数，至少 2 |
| `sparklineRefreshMs` / `sparklineMaxFetches` | `120000` / `4` | 一条序列的缓存窗口；一次面板请求最多等几条分时（`0` 表示不再请求） |

## 验证改动

`index.js` 是无依赖的纯 ESM，`node --check` 与直接 import 都能用。`pnpm test` 跑三个离线检查：

```sh
node tests/verify-watchlist.mjs   # 清单、它的存储与面板路由
node tests/verify-endpoints.mjs   # 真实序列无法按需复现的接口怪癖
node tests/verify-cards.mjs       # 行情卡
```

`verify-watchlist.mjs` 脚本化传输层并顶替挂载的 storage domain，覆盖规范化、去重、配置上限、整次拒绝、存储变更链串行化的并发新增、重启后重开、持仓标记、下一次开盘时刻，以及路由的行压缩、缺陷响应、体积上限、读取预算、序列缓存和「代码没有序列」时的失败。`verify-endpoints.mjs` 覆盖 23 字节关键词前缀、最新分时行把当日累计成交额重述到前一行之下、以及别处出现递减时整次调用失败。`verify-cards.mjs` 按模块加载器契约加载 `client.js`，用真实 React 在两种语言下渲染结果卡，在 jsdom 里驱动其原始数据展开，并断言每种畸形载荷仍然回退。结果卡载荷记录在 `tests/fixtures/`，`--record` 会用线上接口重新录制。

## 限制

接口没有稳定性承诺，所以值是上游最后一次返回的快照，可能延迟、过期或自相矛盾。最新分时行在上游结算当日时可能重述累计成交额，序列按原样返回。搜索只做前缀匹配且只取 23 字节，精确的长名称可能搜不到。覆盖不完整：搜索跳过北交所（它只接受现行 920 股票码与 899 指数码），分时序列描述的是上游最近一个交易日而不是今天，分钟线只有沪深，多日序列覆盖五个交易日且无法指定日期，财务与榜单只有内地上市，榜单只有三种排序键两个板块。`stock_news` 不能翻页、除链接外没有正文、用北京时间。`stock_macro` 按期发布方自己的标签给出期间，并按量级报告货币供应字段——报告里把 M2 叫作 `BASIC_CURRENCY`。一行的分时线与 `stock_minute` 报告的是同一个交易日。持仓的市值与盈亏按该证券自身货币的最新行情推算，不换算、不计费用。面板的开/收盘指示只看星期与交易时段，不建模交易所节假日。行情不构成投资建议。

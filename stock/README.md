# dsh-stock

沪深、港股、美股的行情、指数、新闻与宏观查询，注册为十二个 Host 工具，走腾讯与东方财富的公开接口。每次调用发一个 GET，按严格字段校验转换响应，返回有界的 JSON。本 bundle 只有 Host 半边：没有浏览器入口，也不落盘——行情读出即随结果丢弃。

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

## 失败

参数校验直接抛错，模型能看到要改什么。之后的失败都作为值返回：

```json
{ "ok": false, "source": "stock", "error": { "code": "not_found", "message": "…", "retryable": false } }
```

`code` 是封闭集合：`invalid_response`、`not_found`、`timeout`、`network_error`、`rate_limited`、`access_denied`、`upstream_unavailable`、`response_too_large`、`temporarily_blocked`。退避类失败另带 `retry_at`。

## 请求

一个进程内客户端服务全部十二个工具，所以请求串行、按 `minIntervalMs` 间隔，并在传输失败、5xx、403 或 429 后按 host 退避。某个 host 失败只停它自己。七个 host、十六条端点路径（十五条固定路径加报价前缀 `/q=`），每条路径的参数键是封闭白名单；不跟随重定向，不读环境代理，响应体上限 `responseLimitBytes`。

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

## 验证改动

`index.js` 是无依赖的纯 ESM，`node --check` 与直接 import 都能用。`pnpm test` 跑一个离线检查：

```sh
node tests/verify-endpoints.mjs   # 真实序列无法按需复现的接口怪癖
```

`verify-endpoints.mjs` 用 `tests/host-harness.mjs` 按 Loader 的方式挂载真正的插件（只顶替 tool registry 与 system prompt），脚本化传输层，覆盖 23 字节关键词前缀、最新分时行把当日累计成交额重述到前一行之下、别处出现递减时整次调用失败，以及按 host 的退避：某个 host 连败两次后只停它自己，其余 host 照常可用。

## 升级说明

本版本去掉了浏览器半边与工具 `stock_watchlist`：自选股、自选股上标的持仓、指数行与侧栏面板都不再存在。旧版本写到 `$DSH_HOME/storages/stock.json` 的清单不再被读取，可以自行删除；插件本身也不再申请 storage domain，因此不带 storage 的组合也能挂载它。

## 限制

接口没有稳定性承诺，所以值是上游最后一次返回的快照，可能延迟、过期或自相矛盾。最新分时行在上游结算当日时可能重述累计成交额，序列按原样返回。搜索只做前缀匹配且只取 23 字节，精确的长名称可能搜不到。覆盖不完整：搜索跳过北交所（它只接受现行 920 股票码与 899 指数码），分时序列描述的是上游最近一个交易日而不是今天，分钟线只有沪深，多日序列覆盖五个交易日且无法指定日期，财务与榜单只有内地上市，榜单只有三种排序键两个板块。`stock_news` 不能翻页、除链接外没有正文、用北京时间。`stock_macro` 按期发布方自己的标签给出期间，并按量级报告货币供应字段——报告里把 M2 叫作 `BASIC_CURRENCY`。行情不构成投资建议。

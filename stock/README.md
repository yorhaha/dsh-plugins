# dsh-stock

沪深、港股、美股行情与财经数据查询插件：注册 12 个 Host 工具，对接腾讯财经与东方财富公开接口，无前端界面，不落盘缓存数据。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `stock_search` | `keyword`（1–32 字符） | 搜索沪深、港股、美股代码（不支持北交所；上游前缀限制 23 字节） |
| `stock_quote` | `codes`（1–20 个） | 实时价格、涨跌幅、成交量/额、估值、市值与五档盘口 |
| `stock_kline` | `code`、`count`（默认 120，上限 800）、`adjust`（`auto`/`qfq`/`hfq`/`none`） | 日 K 线（指数仅支持 `none`，美股仅支持 `qfq`） |
| `stock_minute` | `code` | 最近一个交易日的分时走势 |
| `stock_bars` | `code`、`period`（`m1`–`m120`，默认 `m5`）、`count`（默认 120，上限 320） | 沪深分钟 K 线 |
| `stock_minute_history` | `code`、`days`（1–5）、`detail`（`summary`/`rows`） | 近 5 个交易日分时（沪深、北交所、港股） |
| `stock_moneyflow` | `code`、`range`（`daily`/`intraday`）、`days`（默认 20，上限 60） | 资金流向（`intraday` 仅支持沪深北） |
| `stock_fundamentals` | `code`、`periods`（默认 4，上限 12） | 沪深北财务指标（营收、净利、EPS、ROE、毛利率等） |
| `stock_market` | 无 | 六大内地指数与市场涨跌家数 |
| `stock_rank` | `scope`（`sector`/`stock`）、`board`、`sort`、`order`、`count`、`offset` | 内地板块与个股（`aStock`/`cyb`）涨跌榜 |
| `stock_news` | `code`、`limit`（默认 10，上限 20） | 个股最新新闻（固定最多 20 条，不支持翻页） |
| `stock_macro` | `indicator`（`gdp`/`cpi`/`ppi`/`pmi`/`m2`）、`periods`（默认 6，上限 24） | 内地宏观经济指标 |

代码格式如 `sh600519`、`sz399001`、`bj920008`、`hk00700`、`usAAPL`（美股在 `stock_kline` 与 `stock_moneyflow` 需带 `.OQ`/`.N`/`.PS`/`.AM` 等交易所后缀）。

## 配置

可在 profile 的 `cordis.patch.yml` 中按 `id: stock` 覆盖 `config`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `userAgent` | `dsh-stock/0.1` | 请求 `User-Agent` |
| `requestTimeoutMs` / `toolTimeoutMs` | `10000` / `60000` | 单次请求与工具整体超时（毫秒） |
| `responseLimitBytes` | `1048576` | 响应体字节上限 |
| `minIntervalMs` / `retryDelayMs` | `1000` / `1000` | 请求最小间隔与重试等待时长 |
| `pauseNetworkMs` / `pauseBlockedMs` | `60000` / `300000` | 网络/5xx 退避与 403/429 退避时长 |
| `keywordMaxChars` / `quoteMaxCodes` | `32` / `20` | 搜索词与批量行情代码数上限 |
| `klineDefaultCount` / `klineMaxCount` | `120` / `800` | 日 K 线默认条数与上限 |
| `barsDefaultCount` / `barsMaxCount` | `120` / `320` | 分钟线默认条数与上限 |
| `minuteHistoryMaxDays` | `5` | 历史分时天数上限 |
| `moneyflowDefaultDays` / `moneyflowMaxDays` | `20` / `60` | 资金流向默认天数与上限 |
| `fundamentalsDefaultPeriods` / `fundamentalsMaxPeriods` | `4` / `12` | 财报默认期数与上限 |
| `newsDefaultLimit` / `newsMaxLimit` | `10` / `20` | 新闻默认条数与上限 |
| `macroDefaultPeriods` / `macroMaxPeriods` | `6` / `24` | 宏观指标默认期数与上限 |
| `rankDefaultCount` / `rankMaxCount` / `rankMaxOffset` | `20` / `50` / `5000` | 榜单条数与偏移上限 |

## 失败码与退避

错误码：`invalid_response`、`not_found`、`timeout`、`network_error`、`rate_limited`、`access_denied`、`upstream_unavailable`、`response_too_large`、`temporarily_blocked`。请求在进程内按 `minIntervalMs` 串行发送，遇到错误按域名独立退避。

> 旧版本在 `$DSH_HOME/storages/stock.json` 留下的自选股文件已不再读取，可自行删除。行情数据仅供参考，不构成投资建议。

## 测试

```sh
pnpm test
```

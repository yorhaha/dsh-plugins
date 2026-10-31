# dsh-taobao

全网商品比价插件：把 maishou88.com（买手）聚合接口的查询注册成四个 Host 工具，覆盖淘宝/天猫、京东、拼多多、苏宁、唯品会、抖音、快手。不登录电商账号，不读也不写本地文件。移植自 CodeBuddy 技能市场里的 `taobao` 技能。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `taobao_channels` | 没有 | 七个渠道的编号与名称；不发请求 |
| `taobao_search` | `keyword`（必填）、`source`（0–8，默认 0 全部）、`page`、`limit` | 一次搜索的裁剪结果，附逐渠道 `coverage` |
| `taobao_compare` | `keyword`（必填）、`platforms`、`pages`、`per_platform` | 逐渠道分别查询后按券后价排序的合并结果，附 `verdict` |
| `taobao_detail` | `goods_id`、`source`（均必填）、`include_links` | 单个商品详情，含购买链接与复制口令 |

渠道编号：`1` 淘宝/天猫、`2` 京东、`3` 拼多多、`4` 苏宁、`5` 唯品会、`7` 抖音、`8` 快手；`0` 只对 `search` 有效，表示一次请求取全部渠道。

`coverage` 逐渠道给出 `ok` / `no_results` / 具体错误码 / `not_attempted`。`verdict` 只有 `all` / `partial` / `none`，只有每个被查询渠道都返回记录才可能是 `all`，否则 `verdict_note` 列出缺少的渠道。接口没返回的价格记 `null`，插件不做估算；`taobao_detail` 的 `queried.goods_id` 保留搜索时的原值，平台重编码时用 `id_changed` 标出。购买链接、口令与 `detail` 的 `commission` 带推广属性，由结果中的 `affiliate` 字段披露。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/taobao
```

插件无依赖，由插件在加载阶段自行校验配置。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `inviteCode` | 空 | 转发给 maishou88.com 的推广码；留空则链接不带推广参数 |
| `discloseAffiliate` | `true` | 结果里是否带佣金披露；`inviteCode` 为空时披露说明为 `null` |
| `requestTimeoutMs` | `10000` | 单次请求超时 |
| `responseLimitBytes` | `4194304` | 响应体上限，超出即 `response_too_large` |
| `minIntervalMs` / `retryDelayMs` | `800` / `1000` | 请求最小间隔、重试前等待 |
| `pauseNetworkMs` / `pauseForbiddenMs` / `pauseDefaultMs` | `60000` / `1800000` / `600000` | 传输失败、401/403、429 无 `Retry-After` 时的退避 |
| `searchDefaultLimit` / `searchMaxLimit` | `20` / `50` | 搜索默认与上限记录数 |
| `comparePlatformsPerPage` / `compareMaxPlatformsPerPage` | `20` / `50` | 比价时每个渠道保留的记录数 |
| `compareMaxPagesPerPlatform` | `5` | 比价时每个渠道最多读取几页 |
| `outputChars` | `20000` | 单次结果的渲染字符上限，超出截断并注明 |
| `toolTimeoutMs` | `120000` | 工具调用的协作式超时预算 |

## 失败

参数校验失败抛出错误；已发出的请求返回统一载荷：

```json
{ "ok": false, "source": "taobao", "error": { "code": "rate_limited", "message": "…", "retryable": true, "retry_at": "2026-10-19T12:46:28Z" } }
```

`error.code` 是封闭集合：`upstream_error`（接口返回非成功信封，如「商品不存在」）、`not_found`、`invalid_response`、`response_too_large`、`timeout`、`network_error`、`upstream_unavailable`、`rate_limited`、`access_denied`、`temporarily_blocked`。一个渠道被拒绝不会连坐其他渠道：`taobao_compare` 停止发新请求，把剩余渠道标成 `not_attempted`。

## 已知边界

- 数据源是第三方聚合服务，插件靠固定的 App 请求头与匿名 `openid` 访问其非公开接口；对方改鉴权或封禁时返回 `access_denied` 或 `upstream_error`，不会悄悄返回空结果。
- 价格、库存、优惠实时变动，接口返回的是快照，权威报价以各平台为准。
- `source=0` 把各渠道混在一页里（每页每渠道约 20 条）；要逐渠道判定请用 `taobao_compare`。
- 部分渠道对常见关键词经常返回空列表，此时只能记录 `no_results`；没有商品去重与同款匹配，按价格排序。

## 测试

```sh
node tests/verify-behavior.mjs   # 脚本化 fetch：成功、失败、重试、退避、比价、披露与配置校验
```

先在本目录 `pnpm install`，脚本从 devDependencies 的 `@deepseek-ai/dsh-tools` 取 schema 校验器。

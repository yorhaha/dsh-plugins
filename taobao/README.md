# dsh-taobao

全网商品比价插件：通过 maishou88.com 聚合接口查询并比对淘宝/天猫、京东、拼多多、苏宁、唯品会、抖音、快手七大电商平台商品价格，无需登录电商账号。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `taobao_channels` | 无 | 列出 7 个渠道编号与名称（`1` 淘宝/天猫、`2` 京东、`3` 拼多多、`4` 苏宁、`5` 唯品会、`7` 抖音、`8` 快手） |
| `taobao_search` | `keyword`（必填）、`source`（`0` 全部或指定渠道）、`page`、`limit` | 单次检索，返回结果与各渠道 `coverage` |
| `taobao_compare` | `keyword`（必填）、`platforms`、`pages`、`per_platform` | 逐渠道查询后按券后价排序，附带完整度 `verdict` |
| `taobao_detail` | `goods_id`、`source`（均必填）、`include_links` | 商品详情、购买链接与口令 |

仅当所有请求的渠道均返回记录时 `verdict` 为 `all`，否则通过 `verdict_note` 说明缺失渠道；配置了 `inviteCode` 时会在结果中通过 `affiliate` 字段披露推广佣金属性。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/taobao
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `inviteCode` | 空 | maishou88.com 推广邀请码 |
| `discloseAffiliate` | `true` | 是否在返回中披露推广属性 |
| `requestTimeoutMs` / `toolTimeoutMs` | `10000` / `120000` | 单请求超时与工具整体超时（毫秒） |
| `responseLimitBytes` | `4194304` | 响应体字节上限 |
| `minIntervalMs` / `retryDelayMs` | `800` / `1000` | 请求最小间隔与重试等待时长 |
| `pauseNetworkMs` / `pauseForbiddenMs` / `pauseDefaultMs` | `60000` / `1800000` / `600000` | 传输失败、401/403、无 `Retry-After` 的 429 退避时长 |
| `searchDefaultLimit` / `searchMaxLimit` | `20` / `50` | 搜索条数默认与上限 |
| `comparePlatformsPerPage` / `compareMaxPlatformsPerPage` | `20` / `50` | 比价时单渠道保留条数默认与上限 |
| `compareMaxPagesPerPlatform` | `5` | 比价时单渠道最多翻页数 |
| `outputChars` | `20000` | 输出文本字符上限 |

## 失败码

`upstream_error`、`not_found`、`invalid_response`、`response_too_large`、`timeout`、`network_error`、`upstream_unavailable`、`rate_limited`、`access_denied`、`temporarily_blocked`。比价时若某渠道被限流拒绝，剩余渠道记为 `not_attempted`。

## 测试

```sh
pnpm install && node tests/verify-behavior.mjs
```

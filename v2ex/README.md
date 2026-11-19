# dsh-v2ex

V2EX 只读查询插件：通过 V2EX 公开 API 提供 5 个 Host 工具查询热门、最新、节点主题与回复。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `v2ex_hot` | `limit`（1–50，默认 20） | 当前热门主题 |
| `v2ex_latest` | `limit`（1–50，默认 20） | 最新主题 |
| `v2ex_node` | `node_name`（必填，如 `python`）、`limit` | 指定节点第一页主题 |
| `v2ex_topic` | `topic_id`（必填） | 主题详情（含正文） |
| `v2ex_replies` | `topic_id`、`limit`（1–100，默认 30）、`order`（`latest`/`oldest`） | 主题回复列表 |

正文超出上限时自动截断（摘要 500、主题正文 20000、回复 1000），并通过 `content_chars` 与 `content_truncated` 标记。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/v2ex
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `userAgent` | `dsh-v2ex/0.1` | 请求 `User-Agent` |
| `requestTimeoutMs` / `toolTimeoutMs` | `10000` / `60000` | 单请求超时与工具整体超时（毫秒） |
| `responseLimitBytes` | `1048576` | 响应体字节上限 |
| `minIntervalMs` / `retryDelayMs` | `1000` / `1000` | 请求最小间隔与重试等待 |
| `pauseNetworkMs` | `60000` | 网络/5xx 失败退避时长 |
| `pauseForbiddenMs` / `pauseDefaultMs` | `3600000` | 403 或限流未返回重置时间时的退避时长 |
| `rateLimitWatermark` | `60` | 剩余额度低于此值时告警并暂停请求 |
| `listDefaultLimit` / `listMaxLimit` | `20` / `50` | 列表条数默认与上限 |
| `replyDefaultLimit` / `replyMaxLimit` | `30` / `100` | 回复条数默认与上限 |
| `excerptChars` / `topicContentChars` / `replyContentChars` | `500` / `20000` / `1000` | 摘要、正文与回复截断上限 |

## 失败码与注意事项

错误码：`not_found`、`invalid_response`、`response_too_large`、`timeout`、`network_error`、`upstream_unavailable`、`rate_limited`、`access_denied`、`temporarily_blocked`。

公开接口均不支持翻页，`v2ex_replies` 一次拉取全部回复再截取窗口；当回复为空时无法区分主题不存在或暂无回复。

## 测试

```sh
pnpm install && node tests/verify-behavior.mjs
```

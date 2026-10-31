# dsh-v2ex

V2EX 只读查询插件：把公开 API 的五个查询注册成 Host 工具，只读，不写入任何数据。移植自 yorha 的 `core/yorha/v2ex.py`。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `v2ex_hot` | `limit`（1–50，默认 20） | 当前热门主题快照 |
| `v2ex_latest` | `limit`（1–50，默认 20） | 最新创建的主题 |
| `v2ex_node` | `node_name`（必填，例如 `python`）、`limit` | 该节点第一页主题 |
| `v2ex_topic` | `topic_id`（必填） | 主题详情，含正文 |
| `v2ex_replies` | `topic_id`、`limit`（1–100，默认 30）、`order`（`latest`/`oldest`） | 主题回复的一个窗口 |

每次调用只发一次 GET，只允许四个白名单端点；不跟随重定向，不读环境代理。正文按字符上限裁剪（摘要 500、正文 20000、回复 1000），同时返回 `content_chars` 与 `content_truncated`。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/v2ex
```

安装后 profile 的 `cordis.patch.yml` 会多出一行 `id: v2ex`。插件无依赖，因此没有 schemastery 的 `Config` 导出，由插件在加载阶段自行校验，写错会直接导致加载失败。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `userAgent` | `dsh-v2ex/0.1` | 请求的 `User-Agent` |
| `requestTimeoutMs` | `10000` | 单次请求超时 |
| `responseLimitBytes` | `1048576` | 解压后正文上限，超出即 `response_too_large` |
| `minIntervalMs` | `1000` | 两次请求之间的最小间隔 |
| `retryDelayMs` | `1000` | 重试前的等待 |
| `pauseNetworkMs` | `60000` | 传输失败/超时/5xx 后的退避 |
| `pauseForbiddenMs` / `pauseDefaultMs` | `3600000` | 403 后、额度重置时间不可用时的退避 |
| `rateLimitWatermark` | `60` | 剩余额度低于它时告警并在重置前停止发请求 |
| `listDefaultLimit` / `listMaxLimit` | `20` / `50` | 列表工具默认与上限 |
| `replyDefaultLimit` / `replyMaxLimit` | `30` / `100` | 回复工具默认与上限 |
| `excerptChars` / `topicContentChars` / `replyContentChars` | `500` / `20000` / `1000` | 正文裁剪上限 |
| `toolTimeoutMs` | `60000` | 工具调用的协作式超时预算 |

## 返回与失败

每个成功值带 `snapshot`：`cache_age_seconds`（响应头 `Age`，没有则 `null`）、`cache_status`（`fresh`/`cached`/`unknown`）、`rate_limit_remaining`、`rate_limit_reset_at`，剩余额度低于 `rateLimitWatermark` 时另有 `warning`。

参数校验失败抛出错误；已发出的请求与被退避拦下的请求返回统一载荷：

```json
{ "ok": false, "source": "v2ex", "error": { "code": "rate_limited", "message": "…", "retryable": true, "retry_at": "2026-10-13T09:56:34Z" } }
```

`error.code` 是封闭集合：`not_found`、`invalid_response`、`response_too_large`、`timeout`、`network_error`、`upstream_unavailable`、`rate_limited`、`access_denied`、`temporarily_blocked`。请求串行并按最小间隔排队，传输失败、超时、5xx 各重试一次；这些状态只存在于当前进程。串行、间隔、退避与失败载荷复用 `shared/http.js`，端点白名单与额度水位留在本插件。

## 已知边界

- 四个端点都没有分页：`hot`/`latest` 是 V2EX 缓存里的一张快照，`v2ex_node` 只有第一页，`v2ex_replies` 一次取回全部回复再由插件裁剪窗口。
- 回复列表为空时无法区分「主题不存在」与「暂无回复」，返回值顶层的 `note` 会说明。
- 403/429 后的退避最长一小时，命中期间后续调用只拿到 `temporarily_blocked`。
- 不登录，因此看不到需要登录的内容；内容与可用性由 V2EX 决定。

## 测试

```sh
node tests/verify-behavior.mjs   # 脚本化 fetch：成功、失败、重试、退避、裁剪与配置校验
```

先在本目录 `pnpm install`，脚本从 devDependencies 的 `@deepseek-ai/dsh-tools` 取 schema 校验器。

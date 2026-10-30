# dsh-v2ex

给 DeepSeek Harness 用的 V2EX 只读查询插件。它把 V2EX 公开 API 的五个查询注册成 Host 工具，供模型在对话中按需调用；不发帖、不登录、不写任何会话外的数据。

移植自 yorha 的 `core/yorha/v2ex.py`，保留了它的请求白名单、串行限速、退避策略、响应裁剪与结构化错误语义。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `v2ex_hot` | `limit`（1–50，默认 20） | V2EX 当前热门主题快照 |
| `v2ex_latest` | `limit`（1–50，默认 20） | 最新创建的主题快照 |
| `v2ex_node` | `node_name`（必填，如 `python`）、`limit` | 该节点第一页主题 |
| `v2ex_topic` | `topic_id`（必填） | 主题详情，含正文 |
| `v2ex_replies` | `topic_id`（必填）、`limit`（1–100，默认 30）、`order`（`latest`/`oldest`） | 主题回复的一个窗口 |

每个工具只发一次 HTTP 请求，且只允许 `GET` 到四个公开端点的白名单路径；不跟随重定向，不读取环境代理。正文按字符上限裁剪（主题摘要 500、主题正文 20000、回复正文 1000），同时返回 `content_chars` 与 `content_truncated`，模型能看出被截断。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/v2ex
```

或者让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。安装后 profile 的 `cordis.patch.yml` 会多出一行 `id: v2ex`，可以按下面的字段改写默认值。

## 配置

这一行插件的 `config` 全部可省；省略即用下表默认值。插件不带任何依赖，因此没有 schemastery 的 `Config` 导出，改由插件自己在加载时校验，写错会在加载阶段直接报错而不是悄悄用默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `userAgent` | `dsh-v2ex/0.1` | 请求的 `User-Agent` |
| `requestTimeoutMs` | `10000` | 单次请求超时 |
| `responseLimitBytes` | `1048576` | 解压后正文上限，超出即 `response_too_large` |
| `minIntervalMs` | `1000` | 两次请求之间的最小间隔 |
| `retryDelayMs` | `1000` | 重试前的等待 |
| `pauseNetworkMs` | `60000` | 传输失败/超时/5xx 后的进程内退避 |
| `pauseForbiddenMs` | `3600000` | 403 后的退避 |
| `pauseDefaultMs` | `3600000` | 额度重置时间不可用时的退避 |
| `rateLimitWatermark` | `60` | 剩余额度低于它时告警并在重置前停止发请求 |
| `listDefaultLimit` / `listMaxLimit` | `20` / `50` | 列表工具默认与上限 |
| `replyDefaultLimit` / `replyMaxLimit` | `30` / `100` | 回复工具默认与上限 |
| `excerptChars` | `500` | 列表里的正文摘要上限 |
| `topicContentChars` | `20000` | 主题正文上限 |
| `replyContentChars` | `1000` | 单条回复上限 |
| `toolTimeoutMs` | `60000` | 工具调用的协作式超时预算 |

## 成功返回里的 `snapshot`

每个成功值都带一个 `snapshot`，报告这次响应的缓存与额度状态：

| 字段 | 说明 |
| --- | --- |
| `cache_age_seconds` | 响应头 `Age` 的秒数；V2EX 未提供时为 `null` |
| `cache_status` | `fresh`（`Age` 为 0）、`cached`（`Age` 大于 0）、`unknown`（没有 `Age` 头） |
| `rate_limit_remaining` | 剩余额度；未提供时为 `null` |
| `rate_limit_reset_at` | 额度重置的 Unix 秒；未提供时为 `null` |
| `warning` | 只在剩余额度低于 `rateLimitWatermark` 时出现 |

`cache_status: "unknown"` 不等于新鲜，它只表示 V2EX 这次没报年龄；只有 `fresh` 才说明这次拿到的值没有可测的缓存年龄。插件不再往返回值里塞固定的说明段落，新鲜度由这两个字段表达。

## 失败怎么返回

参数校验失败会抛错，模型看到一次失败的调用。已经发出的请求（以及被进程内退避拦下的请求）不会抛错，而是返回统一载荷：

```json
{ "ok": false, "source": "v2ex", "error": { "code": "rate_limited", "message": "…", "retryable": true, "retry_at": "2026-10-13T09:56:34Z" } }
```

`error.code` 是封闭集合：`not_found`、`invalid_response`、`response_too_large`、`timeout`、`network_error`、`upstream_unavailable`、`rate_limited`、`access_denied`、`temporarily_blocked`。`retryable` 为真时带 `retry_at`，模型据此决定等多久再试。

请求会串行执行，并按最小间隔排队；传输失败、超时、5xx 各重试一次，之后按上表退避。这些状态只存在于当前进程，进程退出即清空。串行、最小间隔、退避、响应体上限与失败载荷这几件与 `taobao` 共用一份实现（仓库根目录的 `shared/http.js`）；V2EX 自己的部分——端点白名单、状态码阶梯、`x-rate-limit-*` 水位与正文裁剪——仍在本插件里。

## 已知边界

- 四个端点都没有分页：`hot`/`latest` 返回的是 V2EX 缓存里的一张快照，`v2ex_node` 只有节点第一页，`v2ex_replies` 一次取回该主题的全部回复再由插件裁剪窗口。这个事实写在工具描述里，新鲜度写在 `snapshot.cache_status` 里。
- 公开接口的回复列表在空数组时无法区分「主题不存在」与「主题暂无回复」，此时返回值顶层的 `note` 会说明（这是返回值里唯一的说明文字）。
- 403/429 后的退避最长一小时，命中期间同一进程内的后续调用只会拿到 `temporarily_blocked`。
- 拉取的是 V2EX 公开接口，内容与可用性由 V2EX 决定；插件不做登录，因此看不到需要登录才可见的内容。

## 开发时怎么验

`index.js` 是纯 ESM、零依赖，可以直接 `node --check` 或 import。`tests/verify-behavior.mjs` 从本目录运行；先 `pnpm install`，它从 devDependencies 里的 `@deepseek-ai/dsh-tools` 取 `assertSupportedJsonSchema` / `validateJsonSchemaValue`：

```sh
node tests/verify-behavior.mjs  # 用脚本化 fetch 走成功、失败、重试、退避、裁剪与配置校验分支
```

脚本把成功与失败两条路径都固定在脚本化 fetch 上，并校验 `output.schema`；会限流的真实 V2EX 调用已移除。

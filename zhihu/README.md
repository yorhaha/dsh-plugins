# dsh-zhihu

知乎插件：使用本人网页端 Cookie 读取知乎热榜、问题、回答、专栏文章、用户资料与评论，并在插件页管理 Cookie 与请求节奏。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `zhihu_connect` / `zhihu_disconnect` | `cookie` / 无 | 验证并保存或删除本地 Cookie |
| `zhihu_me` | `fresh` | 查看当前账号信息 |
| `zhihu_hot` | `limit`（1–20，默认 10） | 知乎热榜 |
| `zhihu_question` | `question_id` | 问题详情与最多 3 条回答预览 |
| `zhihu_answers` | `question_id`、`limit`、`offset`、`order` | 问题下的回答分页 |
| `zhihu_answer` | `answer_id`、`question_id`（选填） | 单条回答完整正文 |
| `zhihu_article` | `article_id` | 专栏文章完整正文 |
| `zhihu_user` | `url_token` | 用户主页资料 |
| `zhihu_user_answers` / `zhihu_user_articles` | `url_token`、`limit`、`offset`、`sort_by` | 用户的回答或专栏文章列表 |
| `zhihu_comments` | `answer_id`、`limit`、`offset`、`order` | 回答评论分页 |

在「插件 → 知乎」粘贴包含 `z_c0` 与 `d_c0` 的完整 `Cookie` 请求头即可保存验证，凭据存入 `$DSH_HOME/.credentials.yaml`。

> 站内搜索与部分接口依赖网页端签名，本插件未提供 `zhihu_search`，可配合联网搜索获取知乎链接后再传 ID 读取。

## 限流与风控保护

所有请求串行排队发送并缓存结果；触发异常时自动暂停并记录 `retry_at`：

| 机制 | 默认值 | 说明 |
| --- | --- | --- |
| 请求间隔 / 缓存 | `3 秒` / `10 分钟`（32 条） | 相同 URL 命中缓存不消耗预算 |
| 每小时预算 | `60 次` | 耗尽返回 `request_budget_exhausted` |
| 异常暂停时长 | 风控 `15m` · 限流 `10m` · 签名接口 `1h` · 网络 `60s` | 遇到 `zse-ck` 验证页仅返回 `cookie_stale` 提示更换 Cookie |

重新连接新 Cookie 时会自动清除旧的暂停状态。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/zhihu
cd dsh-plugins/zhihu && pnpm install
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据槽位名 |
| `minIntervalMs` / `hourlyBudget` | `3000` / `60` | 最小间隔（毫秒）与每小时请求上限 |
| `cacheTtlMs` / `cacheMaxEntries` | `600000` / `32` | 缓存有效期与条数 |
| `listDefaultLimit` / `listMaxLimit` | `10` / `20` | 列表默认与上限条数 |
| `commentsDefaultLimit` / `commentsMaxLimit` | `10` / `20` | 评论默认与上限条数 |
| `contentChars` / `commentChars` / `excerptChars` | `20000` / `1000` / `500` | 正文、评论与摘要截断上限 |
| `requestTimeoutMs` / `toolTimeoutMs` | `20000` / `120000` | 单请求超时与工具整体超时（毫秒） |

## 失败码

`not_connected`、`cookie_invalid`、`credential_invalid`、`not_authorized`、`cookie_stale`、`risk_control`、`forbidden`、`rate_limited`、`signature_required`、`request_budget_exhausted`、`temporarily_blocked`、`not_found`、`page_not_recognized`、`invalid_response`、`upstream_error`、`upstream_unavailable`、`http_status`、`request_failed`、`timeout`、`aborted`、`response_too_large`。

## 测试

```sh
pnpm test
```

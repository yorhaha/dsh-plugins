# dsh-xhs-reader

小红书插件：使用本人网页端 Cookie 搜索笔记、读取正文与图片、查看评论和用户主页，并支持归档至本地 SQLite 语料库。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `xhs_connect` / `xhs_disconnect` | `cookie` / 无 | 验证并保存或删除本地 Cookie |
| `xhs_me` | `fresh` | 查看当前账号信息 |
| `xhs_search` | `query`、`sort`、`note_type`、`limit`、`page` | 搜索笔记（结果带 `xsec_token`） |
| `xhs_note` | `note_id`（ID 或完整 URL）、`download_images`、`include_comments`、`comment_limit` | 读取笔记正文、图片与评论 |
| `xhs_comments` | `note_id`、`limit`、`cursor` | 获取笔记评论分页 |
| `xhs_user` | `user_id`（ID 或主页 URL）、`include_notes` | 查看用户资料与近期笔记 |
| `xhs_capture` | `query` 或 `note_ids`、`limit`、`detail_limit`、`comments` | 后台抓取笔记及图片写入本地语料库 |
| `xhs_corpus_search` | `query`、`since`、`until`、`author`、`limit`、`offset` | 离线检索本地语料库 |
| `xhs_item` | `note_id` | 读取本地语料中的单篇笔记 |

在「插件 → 小红书」粘贴包含 `a1` 与 `web_session` 的完整 `Cookie` 请求头（建议保留 `webId`、`gid`、`xsecappid`）即可保存验证，凭据存入 `$DSH_HOME/.credentials.yaml`。

## 限流与风控保护

所有请求串行排队、叠加随机抖动发送，并附带缓存与预算控制；遇到风控或异常状态自动全局暂停：

| 机制 | 默认值 | 说明 |
| --- | --- | --- |
| 请求间隔 / 缓存 | `12 秒`（+0–30% 抖动）/ `10 分钟`（64 条） | 降低并发与重复请求 |
| 全局 / 搜索预算 | `20 次/时, 60 次/天` / `6 次/时, 20 次/天` | 超出返回 `request_budget_exhausted` |
| 异常暂停时长 | 风控/签名 `24h` · 限流 `30m` · 网络 `5m` | 暂停期间返回 `temporarily_blocked` 与 `retry_at` |

遇到 461/471 验证时，请先在浏览器完成人工验证并确认搜索正常。签名实现参考 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)，首次连接会为账号生成固定设备指纹。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/xiaohongshu
cd dsh-plugins/xiaohongshu && pnpm install
```

本地语料与下载图片保存在 `$DSH_HOME/storages/xiaohongshu/`。主要配置项：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据槽位名 |
| `minIntervalMs` / `jitterRatio` | `12000` / `0.3` | 最小请求间隔（毫秒）与抖动比例 |
| `hourlyBudget` / `dailyBudget` | `20` / `60` | 全局小时与每日预算 |
| `searchHourlyBudget` / `searchDailyBudget` | `6` / `20` | 搜索接口独立预算 |
| `cacheTtlMs` / `cacheMaxEntries` | `600000` / `64` | 缓存有效期与条数 |
| `downloadMedia` | `true` | 是否自动下载笔记图片 |
| `contentChars` / `commentChars` / `excerptChars` | `20000` / `800` / `300` | 正文、评论与摘要截断上限 |
| `toolTimeoutMs` | `240000` | 工具整体超时预算（毫秒） |

## 失败码

`not_connected`、`cookie_invalid`、`credential_invalid`、`auth_expired`、`search_permission_denied`、`account_restricted`、`ip_blocked`、`risk_control`、`rate_limited`、`signature_outdated`、`request_budget_exhausted`、`temporarily_blocked`、`not_found`、`missing_xsec_token`、`invalid_response`、`upstream_error`、`network_error`、`timeout`、`aborted`、`response_too_large`。

## 测试

```sh
pnpm test
```

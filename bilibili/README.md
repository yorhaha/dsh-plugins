# dsh-bilibili

B 站个人账号插件：同步观看历史、稍后再看、收藏、关注与动态到本地以供检索，并在插件页管理扫码登录与定时任务。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `bilibili_sync` | `datasets`（五个数据集之一或多个）、`backfill` | 后台任务 id 与各数据集同步结果 |
| `bilibili_search` | `query`、`dataset`、`since`、`until`、`limit`、`offset` | 匹配总数、当前页条目及同步状态 `sync` |
| `bilibili_item` | `id`（必填，来自搜索结果） | 单条完整记录 |
| `bilibili_schedule` | `recreate` | 定时抓取任务的创建或重建结果 |

`bilibili_sync` 通过 `ctx.jobs` 在后台执行抓取，模型可使用 `job_output` 获取结果。检索时在内存中对标题、正文、作者及原始字段（含 BV 号、UP 主）做全量扫描，按上游时间倒序返回。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/bilibili
cd dsh-plugins/bilibili && pnpm install
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据槽位名（`^[a-z][a-z0-9-]*$`） |
| `scheduleCron` | `0 9 * * *` | 定时抓取 cron 表达式（宿主时区） |
| `loginTimeoutSeconds` | `180` | 二维码有效期（秒，最小 30） |

登录凭据保存在 `$DSH_HOME/.credentials.yaml`（`0600`），中途关闭插件页不影响扫码登录完成。

## 失败码与退避

错误码包括：`credential_unavailable`、`auth_required`、`risk_control`、`rate_limited`、`wbi_signature_failed`、`api_<code>`、`network_error`、`upstream_5xx`、`http_<status>`、`invalid_json`、`invalid_envelope`、`history_cursor_stalled`、`history_backfill_cursor_stalled`、`dynamic_cursor_stalled`。

触发风控后按连续次数分别退避 6、24、72 小时；`429` 按 `Retry-After` 退避。

## 注意事项

- `history` 仅保留近期窗口，补全更早记录需传 `backfill: true`；收藏与关注存在单次页数上限，未抓完时 `snapshotComplete` 为 `false`，下次继续。
- 定时任务绑定创建它的会话，该会话被归档停止后任务一并删除。

## 测试

```sh
pnpm test
```

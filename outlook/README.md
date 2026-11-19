# dsh-outlook

Outlook 邮件插件：将邮件同步至本地 SQLite（FTS5 全文索引）以供检索，并在授权 `Mail.Send` 后支持二次确认发信。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `outlook_sync` | `backfill` | 后台任务 id 与同步统计 |
| `outlook_search` | `query`、`since`、`until`、`from`、`limit`、`offset` | 匹配总数、当前页邮件及同步状态 `sync` |
| `outlook_item` | `id`（必填） | 单封邮件完整内容与正文 |
| `outlook_send` | `to`、`cc`、`bcc`、`subject`、`body`、`bodyType`、`importance`、`saveToSentItems`、`confirm` | 无 `confirm: true` 返回预览；确认后发送 |
| `outlook_schedule` | `recreate` | 定时同步任务的创建或重建结果 |

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/outlook
cd dsh-plugins/outlook && pnpm install
```

首次使用需在插件页填写 Azure 应用注册的 `clientId`（需启用公共客户端流）并使用设备代码登录。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据槽位名（`^[a-z][a-z0-9-]*$`） |
| `clientId` | 空 | Azure 应用注册客户端 ID（支持热更新） |
| `tenant` | `consumers` | 个人账号填 `consumers`，工作和个人均允许填 `common` |
| `scopes` | `['Mail.Read', 'Mail.Send']` | 委托权限列表（修改后需重新登录） |
| `databasePath` | `$DSH_HOME/storages/outlook/outlook.db` | 本地 SQLite 路径 |
| `scheduleCron` | `0 9 * * *` | 定时同步 cron 表达式（宿主时区） |
| `mailInitialDays` | `90` | 首次同步回溯天数（`0` 表示全量） |
| `mailExcludeFolders` | `['junkemail']` | 排除同步的文件夹 |
| `reconcileDays` | `3` | 每次同步回扫天数（同步已读状态与移动） |
| `mailMaxPages` / `backfillMaxPages` | `60` / `20` | 单次同步与回溯最大页数 |
| `bodyMaxBytes` | `262144` | 入库正文字节上限 |
| `requestTimeoutMs` | `30000` | 单次 Graph 请求超时（毫秒） |
| `timeZone` | 宿主时区 | 纯日期与无偏移时间解析时区 |
| `loginTimeoutSeconds` | `300` | 设备代码有效时长（秒，最小 30） |

## 失败码与注意事项

错误码：`not_configured`、`credential_unavailable`、`auth_required`、`token_failed`、`scope_missing`、`rate_limited`、`network_error`、`upstream_5xx`、`http_<status>`、`invalid_json`、`invalid_envelope`、`invalid_settings`、`cancelled`。

- 仅处理邮件（不请求日历权限）；附件仅记录 `hasAttachments` 标记，不下载附件正文。
- `outlook_send` 单封合计最多 100 名收件人，且必须传 `confirm: true` 才会真正发信。
- 定时任务绑定创建它的会话，该会话被归档停止后任务一并删除。

## 测试

```sh
pnpm test
```

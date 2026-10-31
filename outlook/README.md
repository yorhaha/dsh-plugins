# dsh-outlook

Outlook 邮件插件：邮件抓取到本机 SQLite 语料库，助手按时间与文本检索。默认只读抓取；授予 `Mail.Send` 后可以用 `outlook_send` 发信，这是本插件唯一的写操作，需要确认。日历不在范围内（不请求 `Calendars.Read`）。

移植自 yorha 的 `core/yorha/connectors/{graph,mail}.py`，保留设备代码流登录、`Prefer` 头约定、Graph 重试语义与时间戳游标；持久化改用 `node:sqlite` 自行维护一个库文件。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `outlook_sync` | `backfill` | 后台任务 id 与本轮页数/写入/未变化/删除计数 |
| `outlook_search` | `query`、`since`、`until`、`from`、`limit`、`offset` | 匹配总数与本页条目，附数据新鲜度 |
| `outlook_item` | `id`（必填） | 单条完整记录（含正文） |
| `outlook_send` | `to`、`cc`、`bcc`、`subject`、`body`、`bodyType`、`importance`、`saveToSentItems`、`confirm` | 发送结果；没有 `confirm: true` 时只返回预览 |
| `outlook_schedule` | `recreate` | 定时抓取任务的建立/重建结果 |

抓取受 Microsoft 限流，`outlook_sync` 用 `ctx.jobs` 起后台任务并立刻返回 id，模型用 `job_output` 收结果（没有 job registry 时退化为同步）。`outlook_search` 的结果带 `sync` 块（`lastRunAt` / `stale` / `running` / `configured` / `authRequired`），状态出现在模型正在看的地方。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/outlook
cd dsh-plugins/outlook && pnpm install   # 依赖 @azure/msal-node、dsh-credentials、schemastery
```

首次使用要在插件页填入 Azure 应用注册的 `clientId`（公共客户端 + 设备代码流）。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据记录槽位，须匹配 `^[a-z][a-z0-9-]*$` |
| `clientId` | 空 | Azure 应用注册的客户端 id（GUID），支持热更新 |
| `tenant` | `consumers` | 个人账号用 `consumers`，工作和个人都用 `common` |
| `scopes` | `['Mail.Read', 'Mail.Send']` | 委托权限，`offline_access` 由登录库附加；改列表后要重新登录一次 |
| `databasePath` | `$DSH_HOME/storages/outlook/outlook.db` | 语料库文件，一个账号一个 |
| `scheduleCron` | `0 9 * * *` | 定时抓取的 5 段 cron，按宿主时区求值 |
| `mailInitialDays` | `90` | 首次抓取回看天数；`0` 表示全量 |
| `mailExcludeFolders` | `['junkemail']` | 不写入语料的文件夹，先按 Graph 别名解析，再按顶层显示名匹配 |
| `reconcileDays` | `3` | 每次抓取在游标之前回扫的天数，覆盖已读状态与文件夹移动 |
| `mailMaxPages` / `backfillMaxPages` | `60` / `20` | 单次向前抓取、单次 `backfill` 的页数上限 |
| `bodyMaxBytes` | `262144` | 写入语料库与建索引的正文上限 |
| `requestTimeoutMs` | `30000` | 单次 Graph 请求截止时间，超时按网络失败重试 |
| `timeZone` | 宿主时区 | `since`/`until` 的纯日期与不带偏移的时间按此解释 |
| `loginTimeoutSeconds` | `300` | 设备代码有效期，最小 30 |

## 语料库

`items`（按 Graph message id 去重）、`items_fts`（FTS5 全文索引，只存分词后的 title/body/participants）、`mail_state`（游标、上次成功时间、条目数、是否完成首轮）、`status`（上次抓取时间、是否需要重新登录、退避截止时间）四张表。

## 发信

`outlook_send` 直接 `POST /me/sendMail`，一次一封。

- 二次确认：不带 `confirm: true` 只返回预览（收件人、主题、正文格式、是否存 Sent Items），不联网；用户确认后再带 `confirm: true` 调用。
- 权限预检：发送前读取本次登录实际授予的 scope，缺 `Mail.Send` 返回 `scope_missing`；没有登录记录才报 `auth_required`。
- 只发一封、限收件人：to/cc/bcc 合计上限 100，地址逐个校验，有一个非法就拒绝整封邮件。
- `/me/sendMail` 返回 202，工具报 `status: 'sent'`；保留的副本会在下次抓取时从「已发送」自然进语料，之后可以被 `outlook_search` 搜到。
- 发信不经过 `/api/plugin-outlook`，页面无法发信；定时任务也只抓取、不发送。

## 失败码

`not_configured`、`credential_unavailable`、`auth_required`、`token_failed`、`scope_missing`、`rate_limited`、`network_error`、`upstream_5xx`、`http_<status>`、`invalid_json`、`invalid_envelope`、`invalid_settings`、`cancelled`。参数校验失败抛出错误。

## 已知边界

- 上游由微软决定，字段与可用性随时会变。抓取只读 `/me/messages` 与 `/me/mailFolders`，发信只调 `/me/sendMail`。
- 附件只记录 `hasAttachments`，不下载内容；正文不含附件正文。
- 删除在本地不可见：时间戳游标只会被「收到得更晚」的邮件推动，被删的邮件会留在语料里，直到 `backfill` 覆盖或手动清理。
- 凭据缓存以明文保存在 `$DSH_HOME/.credentials.yaml`（0600，无加密、无 OS keychain）。
- 定时任务绑定会话：该会话被归档（并选择停止活动）时任务一并删除。
- `/api/plugin-outlook` 是本机 HTTP 接口，挡不住同机其他进程；它不返回令牌，能触发的只有「同步一次」「退出登录」「重建任务」和一次只读的已授权限查询。

## 测试

```sh
node tests/verify-behavior.mjs   # 离线：建表与去重、中英文检索、时区边界、Graph 重试与分页、游标与退避、权限解析、输出 schema、设置桥、旧库迁移
```

使用本地伪 Graph 与临时 SQLite，不读真实邮箱。先在本目录 `pnpm install`。

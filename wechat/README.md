# dsh-wechat

微信导出批次插件：把本机导出器写出的批次（每个会话一个 JSONL + 根目录 `export_meta.json`）导入成本机 SQLite 语料，向助手开放跨会话、跨时间的检索；插件页报告流水线状态并就地导入批次。

移植自 yorha 的 `core/yorha/connectors/wechat`，保留批次契约、严格校验、两套身份策略与状态信号词表；持久化改用本机 SQLite，`runs` 表、物化联系人索引、联系人画像与「驱动导出器」都没有移植。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `wechat_batches` | — | 归档里的批次、各自状态与计数，附数据新鲜度 |
| `wechat_import` | `batch` / `source`（路径或 `latest`）、`includeGroups`、`copy` | 导入结果；超过阈值时是后台任务 id |
| `wechat_search` | `query`、`chat`、`kind`、`direction`、`sender`、`since`、`until`、`limit`、`offset` | 匹配总数与本页消息，附数据新鲜度 |
| `wechat_item` | `id`（必填） | 单条完整记录，图片提供绝对路径 |
| `wechat_chats` | `chat`、`since`、`until`、`limit` | 每个会话的消息数、文本数、活跃天数、首末时间 |
| `wechat_status` | — | 五段只读探测 + 信号 + 主状态 |
| `wechat_schedule` | `recreate` | 在 Automation tasks 里建立/恢复「定期导出并导入」任务 |

超过 `inlineImportLimit`（默认 5000 条）的批次交给 `ctx.jobs` 后台任务（没有 job registry 时退化为同步）。`wechat_search` 的结果带 `state` 块（`lastImportedAt` / `pendingBatches` / `databaseNewerThanImport` / `importFailed`），它只读一行 meta、微信库文件时间与批次目录，不扫描消息表。

`wechat_schedule` 建的任务属于创建它的会话，到点回到该会话由助手运行导出再调用 `wechat_import`。默认每周一 09:00 导出最近 7 天。任务靠 prompt 里的固定标记 `[dsh-wechat:auto-import]`（其次看标题）认领，重复创建不会产生第二份；`recreate: true` 删旧建新。没有挂载 schedule 服务时返回 `unavailable`。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/wechat
cd dsh-plugins/wechat && pnpm install   # 依赖 @deepseek-ai/schemastery
```

## 标准流程

导出器是另一个项目，需要运行在登录微信客户端的机器上。**要导入必须用 `--format jsonl`**（`text` 会在写入 txt 后删掉 JSONL）。

```sh
python export.py --days 1 --format jsonl -o <exportDir>
```

常用参数：`--days N`（默认 3，`0` 表示全部历史）、`--start`/`--end`（与 `--days` 互斥）、`--chats`/`--contacts`（逗号分隔）、`--output-dir`、`--include-images`（仅群聊，需要 PaddleOCR）、`--list`（只列出群聊与联系人）。

导出后由助手调用 `wechat_import`（`source: latest` 取最新完整批次，或给批次名与路径），或直接运行 `wechat_schedule` 建的任务。导入是增量且幂等的：同一批次重复导入只补新增，导入后就地保留批次目录，不删除原始数据。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `exporterDir` | 空 | 导出器根目录；留空则关闭 `latest` 发现 |
| `exportDir` / `keysFile` | `<exporterDir>/data`、`<exporterDir>/meta/wechat-keys.json` | `latest` 的发现目录；密钥文件只读字段名 |
| `wechatDbParent` / `wechatDbDir` | 微信容器目录 / 空 | `*/db_storage` 的发现父目录；多账号时指定具体目录 |
| `batchesDir` | `$DSH_HOME/wechat/batches` | 批次归档根 |
| `databasePath` | `$DSH_HOME/wechat/wechat.db` | SQLite 语料 |
| `defaultIncludeGroups` | `false` | 没有传 `includeGroups` 时的默认范围 |
| `inlineImportLimit` | `5000` | 超过这个条数就交给后台任务 |
| `localTimeZone` | 宿主时区 | 解释没有偏移的导出时间与纯日期检索边界 |
| `scheduleCron` | `0 9 * * 1` | 定时任务何时运行（按 `localTimeZone` 求值） |
| `scheduleExportDays` | `7` | 每次导出多少天历史 |

配置在加载阶段校验：相对路径、未知时区、非整数阈值都会直接导致加载失败。

## 语料与检索

`items` 表按 `(chat_id, ts_unix DESC)` 建索引，一个会话一个事务，整批先校验后写入；`chats` 是导入结束时刷新的派生表。全语料子串扫描是 O(n)（80 万条约 0.25 s 有命中、1.0 s 无命中），会话或时间窗限定降到毫秒级。没有全文索引，因为中文分词在这里只会降低召回。

语料文件带 schema 版本（当前 generation 2）：generation 1 的文件在打开时就地迁移，不丢消息；比本版本新的文件会被拒绝。

## 失败码

`batch_not_found`、`batch_incomplete`（导出器还没写完）、`batch_exists`、`batch_invalid`（校验失败，消息里带文件与行号）、`batch_changed`、`unsupported_batch_name`、`source_missing`、`copy_failed`、`busy`（另一处导入持锁）、`cancelled`、`db_unavailable`、`internal_error`；桥另加 `body_too_large`、`invalid_json`、`invalid_body`、`unknown_action`。

## 已知边界

- 导出器决定字段与可用性；插件只读批次，不驱动 `export.py`。
- 群聊在真实批次里通常占多数，所以默认只导入私聊，需要群聊时传 `includeGroups`。
- 批次目录被手工删除后，条目里的媒体路径失效（消息本身不受影响），`wechat_item` 报 `available: false`。
- 检索到的正文会进入会话日志，导出或共享会话就包含微信内容。
- `node:sqlite` 目前仍带 ExperimentalWarning；`outlook` 与 `xiaohongshu` 用同一个驱动。
- `/api/plugin-wechat` 是本机 HTTP 接口，挡不住同机其他进程；能触发的只有「导入一次」。页面不显示正文与密钥，也不浏览文件系统。
- `chats` 由导入结束时刷新；若进程在写消息与刷新之间被终止，这些会话的聚合会暂时偏旧，重跑同一批次即可修正。

## 测试

```sh
node tests/verify-behavior.mjs   # 离线：配置、时区、导入计数、身份、检索、输出 schema、桥、状态分段
```

使用临时语料库与合成批次，不读本机微信数据。先在本目录 `pnpm install`。

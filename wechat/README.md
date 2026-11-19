# dsh-wechat

微信聊天记录导入插件：将本机微信导出批次（按会话拆分的 JSONL + `export_meta.json`）导入本地 SQLite 数据库以供跨会话检索，并在插件页查看同步流水线状态。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `wechat_batches` | 无 | 列出归档中的批次、状态与统计 |
| `wechat_import` | `batch` / `source`（路径或 `latest`）、`includeGroups`、`copy` | 导入批次（超过内联阈值时转为后台任务） |
| `wechat_search` | `query`、`chat`、`kind`、`direction`、`sender`、`since`、`until`、`limit`、`offset` | 跨会话、跨时间检索消息 |
| `wechat_item` | `id`（必填） | 获取单条完整消息记录（图片附绝对路径） |
| `wechat_chats` | `chat`、`since`、`until`、`limit` | 统计各会话消息数与活跃时间 |
| `wechat_status` | 无 | 查看导出器、密钥与归档状态 |
| `wechat_schedule` | `recreate` | 创建或重建「定期导出并导入」任务 |

## 标准使用流程

使用独立的微信导出器导出聊天记录（**必须指定 `--format jsonl`**）：

```sh
python export.py --days 1 --format jsonl -o <exportDir>
```

导出后可在插件页点击导入，或让助手调用 `wechat_import`（支持 `source: "latest"` 自动选取最新完整批次）。导入过程增量幂等，默认仅导入私聊（群聊需传 `includeGroups: true`）。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/wechat
cd dsh-plugins/wechat && pnpm install
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `exporterDir` | 空 | 导出器项目目录（留空则关闭 `latest` 自动发现） |
| `exportDir` / `keysFile` | `<exporterDir>/data`、`<exporterDir>/meta/wechat-keys.json` | 导出目录与密钥文件路径 |
| `wechatDbParent` / `wechatDbDir` | 微信容器目录 / 空 | 微信库扫描父目录或指定账号库目录 |
| `batchesDir` | `$DSH_HOME/wechat/batches` | 批次归档目录 |
| `databasePath` | `$DSH_HOME/wechat/wechat.db` | 本地 SQLite 路径 |
| `defaultIncludeGroups` | `false` | 默认是否包含群聊 |
| `inlineImportLimit` | `5000` | 超过该条数转为后台异步导入 |
| `localTimeZone` | 宿主时区 | 解析导出时间与日期检索边界 |
| `scheduleCron` / `scheduleExportDays` | `0 9 * * 1` / `7` | 定时任务的执行周期与导出天数 |

## 失败码

`batch_not_found`、`batch_incomplete`、`batch_exists`、`batch_invalid`、`batch_changed`、`unsupported_batch_name`、`source_missing`、`copy_failed`、`busy`、`cancelled`、`db_unavailable`、`internal_error`。

## 测试

```sh
pnpm test
```

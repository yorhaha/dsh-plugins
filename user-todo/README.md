# dsh-user-todo

跨会话个人待办与日历插件：在左侧栏提供「日历与待办」面板，同时注册 5 个 Host 工具供助手读写同一份清单，支持重复日程与手机到期提醒。

## 侧栏面板

- **列表视图**：按 `已逾期 / 今天 / 本周 / 以后 / 无日期 / 已完成` 分组并支持筛选；单条删除可撤销，批量清除不可撤销。
- **日历视图**：月历网格与当日安排列表；在日历中勾选重复待办仅完成当天那一次，在列表中勾选则推进到下一次。
- **提醒设置**：支持配置到期推送开关、静默时段、每日议程推送及全天条目提醒时间（需配合 `dsh-notify` 推送至手机，未安装时仅本地记录）。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `list_user_todos` | `status`（`open` / `done` / `all`） | 查询待办列表 |
| `create_user_todos` | `items`（`title` 必填，支持 `due_at`/`due_date`/`note`/重复规则/`remind_before_min`） | 批量新增，同名自动跳过 |
| `update_user_todos` | `changes`（支持修改字段或传 `complete_occurrence`/`exclude_occurrence`） | 批量更新条目或处理单次重复日程 |
| `list_user_agenda` | `from` / `to`（`YYYY-MM-DD`）、`include_done` | 展开时间窗内的所有日程实例 |
| `delete_user_todos` | `ids`、`open_only` | 删除指定待办或清空已完成项 |

重复规则支持 `daily` / `weekly` / `monthly` / `yearly`，可搭配 `repeat_interval`、`repeat_by_weekday`（`1` 为周一）、`repeat_count` / `repeat_until`；必须先设置截止时间才可开启重复。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/user-todo
```

数据默认保存在 `$DSH_HOME/storages/user_todo.json`。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `toolNames` | 5 个默认工具名 | 自定义注册工具名（`list`/`create`/`update` 必填） |
| `maxCreateBatch` / `maxUpdateBatch` / `maxDeleteBatch` | `20` / `50` / `50` | 单次批量操作上限 |
| `maxTitleChars` / `maxNoteChars` | `200` / `2000` | 标题与备注字数上限 |
| `maxItems` | `5000` | 清单总条目上限 |
| `allowSubagentWrites` | `true` | 是否允许子会话修改待办 |
| `timeZone` | `null` | 解析本地日期与时间的 IANA 时区（`null` 取本机时区） |
| `agendaMaxSpanDays` / `agendaMaxOccurrences` | `366` / `400` | 议程查询最大天数与展开条数上限 |
| `remindCatchUpHours` | `24` | 启动后补发多少小时内错过的提醒（`0` 关闭） |
| `maxPushesPerHour` | `6` | 每小时推送上限 |
| `schedulerMaxSleepMs` | `60000` | 提醒调度器最长轮询间隔（毫秒，最小 `1000`） |

## 失败码

- 整次调用失败：`open_items_present`、`subagent_denied`、`invalid_body`、`invalid_recurrence`、`unsupported_rule`。
- 逐条状态码：`duplicate`、`list_full`（新增跳过）；`changed`、`unchanged`、`not_found`、`invalid_occurrence`、`not_recurring`、`invalid_recurrence`（更新结果）。

## 测试

```sh
npm test
```

# dsh-user-todo

个人待办插件：一份跨会话持久的清单，同时出现在侧栏「日历与待办」面板和五个 Host 工具里。清单带月历视图与到期提醒，提醒经 `notify` 服务推到手机。

这个插件管用户自己的待办；会话的工作步骤仍然用 `todo_write`。

## 面板

侧栏只有一个入口，页内用 `[列表] [日历]` 切换。

- 列表按 `已逾期 / 今天 / 本周 / 以后 / 无日期 / 已完成` 分组，可按状态筛选；行内标签显示截止时间、重复规则与提醒。有已完成条目时出现「清除已完成」，单条删除可以撤销，批量清除没有撤销。
- 日历是月网格加当天清单，每格最多三条，其余折叠；点击某天查看安排，点击条目打开编辑器。
- 勾选重复条目完成的是「下一次」，系列继续；日历里勾选某天只完成那一次。终止系列要在编辑器里改为「不重复」。
- 设置（齿轮）：到期推送开关、静默时段、每日议程推送时间、全天条目的提醒时间。值存在文档里，改完立刻生效。
- 时间统一 24 小时制，`en-US` 区域也显示 `HH:MM`；日期跟随界面语言（`10月28日 19:56` / `10-28 19:56`），不出现 `Oct 28`。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `list_user_todos` | `status`（`open` 默认 / `done` / `all`） | 条目，含 `due_at`/`due_date`/`all_day`/`repeat`/`remind_before_min`/`next_at` |
| `create_user_todos` | `items`（`title` 必填，其余选填：`due_at`/`due_date`/`note`/`repeat`/`repeat_by_weekday`/`repeat_interval`/`repeat_count`/`repeat_until`/`remind_before_min`） | 新增结果；标题已命名的条目会被跳过，重试不会重复 |
| `update_user_todos` | `changes`（每条含 `id`，可改 `status`/`title`/`due_at`/`due_date`/`note`/`repeat`/`remind_before_min`；或用 `complete_occurrence`/`exclude_occurrence` 只处理某一次） | 更新结果；未知 id 返回 `not_found` |
| `list_user_agenda` | `from`/`to`（`YYYY-MM-DD`，缺省今天起七天）、`include_done` | `now`、`time_zone` 与窗口内展开好的 `occurrences` |
| `delete_user_todos` | `ids`（最多 `maxDeleteBatch` 条；省略即删除全部已完成）、`open_only` | `removed`、`absent`、`count`、`remaining` |

### 时间与重复

`due_at: "2026-11-05"` 是全天条目，记成 `due_date`，`due_at` 取该日在 `timeZone` 的零点；`due_at: "2026-11-02T15:00"` 按 `timeZone`（未配置则用本机时区）换算；带 `Z` 的按 UTC 原样收下。输出里 `all_day` 与 `due_date` 一起给出。

重复规则是结构化子集：`daily`/`weekly`/`monthly`/`yearly`，可带 `repeat_interval`、`repeat_by_weekday`（仅 `weekly`，1=周一）、`repeat_count`/`repeat_until`。每小时、每月第 N 个周几、`RDATE`/`RECURRENCE-ID` 返回 `unsupported_rule`。没有截止时间的条目设置重复会被拒绝（`invalid_recurrence`）——规则需要起点。展开在 Host 完成，面板与工具看到同一份结果。

### 提醒

由 Host 进程内的定时循环投递，只在 Harness 运行期间有效。启动后 `remindCatchUpHours` 内错过的提醒合并成一条补发；每小时最多 `maxPushesPerHour` 条；静默时段内不推送。没装 `notify` 时提醒仍然记账（面板可见），日志里会说明没有可用的通知服务。

### 批量与写入

`create_user_todos` 单次最多 `maxCreateBatch` 条，超过 `maxItems` 时返回 `list_full` 而不拒绝整批。`delete_user_todos` 传空数组返回 `invalid_body`；不带 `ids` 时只删除已完成条目，还有未完成条目则整个调用返回 `open_items_present`。写入没有版本号或冲突检测，全部串行、后写覆盖先写。

## 存储

清单、提醒记录与设置由挂载的 storage 后端承载（json 后端下是 `$DSH_HOME/storages/user_todo.json`）；面板、工具与提醒循环读写同一份数据。文档版本仍是 1：日历相关字段全部带默认值，旧文档可以直接打开并在写回时补齐，不需要迁移。`tags` 已从 schema 移除，旧文档里的标签在打开时丢弃。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/user-todo
```

推送要真正到手机，还需要安装 `dsh-notify` 并配好 token；两个插件互不依赖。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `toolNames` | 五个默认名 | 五个工具的名字；老行省略时各自使用默认名 |
| `maxCreateBatch` / `maxUpdateBatch` / `maxDeleteBatch` | 20 / 50 / 50 | 单次批量上限 |
| `maxTitleChars` / `maxNoteChars` | 200 / 2000 | 标题与备注字数上限 |
| `maxItems` | 5000 | 清单总条目上限 |
| `allowSubagentWrites` | `true` | 是否允许委派子会话写入 |
| `timeZone` | `null` | 日期与本地时间按哪个 IANA 时区解读；`null` 用本机时区 |
| `agendaMaxSpanDays` / `agendaMaxOccurrences` | 366 / 400 | 一次议程读取的跨度与次数上限 |
| `remindCatchUpHours` | 24 | 过期多久内的提醒仍然补发（0 表示不补发） |
| `maxPushesPerHour` | 6 | 每小时最多推送几条提醒 |
| `schedulerMaxSleepMs` | 60000 | 提醒循环两次看表之间的最长间隔（下限 1000） |

## 测试

```sh
npm test
```

八个文件共 142 项，全部离线：时区换算、重复展开、议程、提醒限流与补发、路由、存储，以及用真实定时器跑完一次提醒投递的组装检查（装与不装 `notify` 各一次）。

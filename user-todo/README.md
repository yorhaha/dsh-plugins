# dsh-user-todo

给 DeepSeek Harness 用的个人待办插件。它维护一份**跨会话持久**的待办清单，同时出现在两个界面：Web UI 侧栏的「日历与待办」面板，以及五个 Host 工具，供模型在对话中读写。清单自带日历视图和到期提醒，提醒通过 `notify` 服务推送到手机。

注意区分两份清单：这个插件管的是**用户自己的**待办，会话的工作步骤仍然用 `todo_write`。

## 面板

侧栏入口仍然只有「日历与待办」一个，页面内用 `[列表] [日历]` 切换；日历不是新的侧栏入口。

- **列表**：按 `已逾期 / 今天 / 本周 / 以后 / 无日期 / 已完成` 分组，可按状态筛选。行内的标签块显示截止时间、重复规则、提醒，以及 `agent` 最近改动。筛选条右侧在有已完成条目时出现「清除已完成」，点一次先确认数量再一次性删除；删除单条时通知栏里有「撤销」（按原字段重建），批量清除没有撤销。
- **日历**：月网格加当天清单。左右箭头换月，「今天」回到当前月；每格最多显示三条，其余折叠成「还有 N 项」。点某一天看当天安排，点条目打开编辑器。
- **完成语义**：列表里勾一个**重复**条目，完成的是它**下一次**那一项，系列继续；日历里勾某一天，只完成**那一天**那一次。要终止系列，在编辑器里改成「不重复」，或直接标记整条完成。
- **设置**（右上角齿轮）：到期推送开关、静默时段、每日议程推送时间、全天条目的提醒时间。这些值存在文档里，改完立刻生效，不需要重启 Harness。
- **时间一律 24 小时制**：列表、日历、当天清单里的时间都写成 `HH:MM`，任何时候都不显示 AM/PM，读者用 `en-US` 这类 12 小时制区域时也一样；午夜写作 `00:00` 而不是 `24:00`。日期跟随界面语言，不看机器区域设置：中文界面写 `10月28日 19:56`，英文界面写 `10-28 19:56`，星期用 `周一…周日` / `Mon…Sun`，不出现 `Oct 28` 这类英文月名。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `list_user_todos` | `status`（`open` 默认 / `done` / `all`） | 按状态筛选的条目，含 `due_at`/`due_date`/`all_day`/`repeat`/`remind_before_min`/`next_at` |
| `create_user_todos` | `items`（`title` 必填；`due_at`/`due_date`/`note`/`repeat`/`repeat_by_weekday`/`repeat_interval`/`repeat_count`/`repeat_until`/`remind_before_min` 可选） | 新增结果；标题已命名的条目会被跳过，重试不会重复 |
| `update_user_todos` | `changes`（每条含 `id`，可改 `status`/`title`/`due_at`/`due_date`/`note`/`repeat`/`remind_before_min`；或用 `complete_occurrence`/`exclude_occurrence` 只处理某一次） | 更新结果；未知 id 返回 `not_found` |
| `list_user_agenda` | `from`/`to`（`YYYY-MM-DD`，缺省为今天起七天）、`include_done` | `now`、`time_zone`、窗口内展开好的 `occurrences`（每条带 `occurrence_id`/`start_at`/`date`/`status`） |
| `delete_user_todos` | `ids`（可选，最多 `maxDeleteBatch` 条；省略即删除全部已完成）、`open_only`（`true` 时拒绝删除未完成条目，把它们放进 `absent`） | `removed`（被删条目）、`absent`（没找到或被 `open_only` 挡下的 id）、`count`、`remaining` |

**时间的两种写法**。`due_at: "2026-11-05"` 是**全天**条目，记成 `due_date`，`due_at` 取该日在 `timeZone` 的零点；`due_at: "2026-11-02T15:00"` 是本地挂钟时间，按 `timeZone`（没配就是这台机器的时区）换算；带 `Z` 的写法按 UTC 原样收下。工具输出里 `all_day` 和 `due_date` 一起给出，模型不需要自己判断。

一条规则必须有起点：条目没有截止时间时，设置重复会被拒绝（`invalid_recurrence`），面板里的重复选项在填时间或日期之前是灰的。

**重复规则**是结构化子集，不是完整 RRULE：`daily`/`weekly`/`monthly`/`yearly`，可带 `repeat_interval`（每 N 个周期）、`repeat_by_weekday`（周几，1=周一…7=周日，仅 `weekly`），以及 `repeat_count`/`repeat_until` 截止。每小时、每月第 N 个周几、`RDATE`/`RECURRENCE-ID` 不在子集内，会返回 `unsupported_rule`。展开在 Host 完成，面板和工具看到的是同一份结果。

**提醒**由 Host 进程里的定时循环投递，只在 Harness 运行期间有效。启动后 24 小时内（`remindCatchUpHours`）错过的提醒会合并成一条补发；每小时最多 `maxPushesPerHour` 条；静默时段内不推。没装通知插件时提醒仍然记账（面板上可见），日志里会说明没有可用的通知服务。

`create_user_todos` 单次最多 `maxCreateBatch` 条（默认 20），`update_user_todos` 单次最多 `maxUpdateBatch` 条（默认 50）；超过 `maxItems`（默认 5000）时 `create_user_todos` 返回 `list_full`，而不是拒绝整批。 `delete_user_todos` 单次最多 `maxDeleteBatch` 条（默认 50）；传空数组返回 `invalid_body`，不带 `ids` 则只删已完成条目，没有已完成的条目就什么都不写。

**删除与完成**。标记完成会保留条目，删除会连它的重复规则、`exdates` 和提醒账本里属于它的记录一起清掉——账本键以 `occurrenceId` 开头，而 `occurrenceId` 就是 `${itemId}@${instant}`，所以按条目 id 能精确删干净；每日摘要的 `digest:` 键不属于任何条目，会保留。`open_only` 是给「清空已完成」兜底用的：不带 `ids` 且还有未完成条目时，整个调用返回 `open_items_present` 而不是删掉半份清单。

**写入语义**：没有版本号或冲突检测。所有写操作串行执行，后一次写入覆盖前一次（last-write-wins）；需要避免覆盖时，先 `list_user_todos` 读取当前值再改。日历里的「只完成这一次」记在 `recurrenceDoneThrough` 水位线上，不是给每次出现存一行。

## 存储

清单、提醒记录和提醒设置存为 Host 的持久状态，由挂载的 storage 后端承载（json 后端下是 `$DSH_HOME/storages/user_todo.json`）。面板、工具和提醒循环读写的是同一份数据。

文档版本仍是 1：日历相关字段（`dueDate`/`timeZone`/`recurrence`/`recurrenceDoneThrough`/`exdates`/`remindBeforeMin`、`notifications`、`prefs`）全部带默认值，所以旧文档能直接打开，写回时补齐，不需要迁移。

`tags` 已从条目的 schema 里移除（列表行不再分组标签，只有状态筛选）：旧文档里的标签在打开时被丢弃，下一次写入就清干净。工具的 `create`/`update` 参数里没有 `tags`，传了会被参数校验拒绝，而不是静默保存。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/user-todo
```

或者让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。安装后 profile 的 `cordis.patch.yml` 会多出一行 `id: user-todo`，可按下面的字段改写默认值。

提醒要真正推到手机，还需要装 `dsh-notify`（它 `provide` 了 `notify` 服务）并在它的行页面里配好 PushPlus token。两个插件互不依赖：没有通知插件时提醒只记账。

## 配置

全部字段都在 `cordis.patch.yml` 的 `config` 下，列出的都是默认值：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `toolNames` | `list_user_todos` / `create_user_todos` / `update_user_todos` / `delete_user_todos` / `list_user_agenda` | 五个工具的名字；老行省略 `agenda` 或 `remove` 时，各自用默认名 |
| `maxCreateBatch` | 20 | 单次创建上限 |
| `maxUpdateBatch` | 50 | 单次更新上限 |
| `maxDeleteBatch` | 50 | 单次删除上限 |
| `maxTitleChars` | 200 | 标题字数上限 |
| `maxNoteChars` | 2000 | 备注字数上限 |
| `maxItems` | 5000 | 清单总条目上限 |
| `allowSubagentWrites` | `true` | 是否允许委派子会话写入 |
| `timeZone` | `null` | 日期和本地时间按哪个 IANA 时区解读；`null` 用本机时区（如 `Asia/Shanghai`） |
| `agendaMaxSpanDays` | 366 | 一次议程读取的最长跨度（天） |
| `agendaMaxOccurrences` | 400 | 一次议程读取的最多次数 |
| `remindCatchUpHours` | 24 | 过期多久内的提醒仍然补发（0 表示不补发） |
| `maxPushesPerHour` | 6 | 每小时最多推送几条提醒 |
| `schedulerMaxSleepMs` | 60000 | 提醒循环两次看表之间的最长间隔（下限 1000） |

## 测试

```sh
cd user-todo && pnpm install && npm test
```

八个文件、135 项检查：时区换算、重复展开、议程窗口、提醒循环、存储语义、路由、组合挂载（含一次真实的提醒投递，走注入的 `notify` 桩），以及客户端渲染。之后 `../verify-client-locales.mjs` 再核对 `locale/` 的中英文案和浏览器半边用到的每个键。

# 日历与待办：日历与提醒（方案）

> 状态：**第 1、2 阶段已实现**（见第 17 节）；本文件保留为当时的调研与设计记录。文中沿用写作时的旧名「我的待办」，侧栏入口现在叫「日历与待办」，以各插件 README 为准。
> 影响范围：`dsh-user-todo`（主体）、`dsh-notify`（新增一个服务）。
> 结论先行：日历长在 `dsh-user-todo` 里，复用同一份文档与同一个侧栏面板；重复规则在 Host 展开；提醒由 Host 自己的定时器触发，经 `dsh-notify` 新增的 `notify.send()` 发到手机。

---

## 1. 现状：这次要接住的东西

| 部件 | 位置 | 与日历的关系 |
| --- | --- | --- |
| 条目模型 | `user-todo/src/item.js:44-81`、`src/domain.js:45-62` | 已有 `dueAt`（UTC 瞬时），缺时区、全天、重复、提醒 |
| 持久化 | `src/domain.js:68-77`：一个 domain `user_todo`、`layout: 'single'`、一份 global 文档 | 新增字段必须兼容旧文档；**无迁移机制** |
| 写入 | `src/store.js`：串行链 + 每次整体文档写入 | 新顶层字段必须一起写回，否则被 schema `.strip()` 掉 |
| 面板 | `user-todo/client.js`（929 行，其中约 95 行是内联 CSS） | 已有分组列表；缺日历视图 |
| 面板接口 | `src/route.js`：`/api/user-todo`，GET 只读、POST 写入 | 需要新增只读的窗口查询 |
| 工具 | `src/tools.js`：`list/create/update_user_todos` | 需要时间语义与第 4 个窗口查询工具 |
| 通知 | `notify`：只有 `notify_send` 工具（`notify/src/tools.js:115`），**没有服务** | 联动需要先把它做成可编程的服务 |

---

## 2. 平台约束：为什么不做"重型日历"

这几条决定了下面所有取舍，值得先看：

1. **浏览器半边不能引 npm 包。** `client.js` 是被原样下发的 classic script，`factory(require)` 只认白名单（`react` 与少数 `dsh.client.external`，见 `package.json` 的 `dsh.client` 段），没有打包步骤。所以 **FullCalendar / react-big-calendar / rrule.js 这类客户端依赖进不来**；要么自己写、要么把计算留在 Host。→ 选定：**Host 算 occurrence，浏览器只渲染**。
2. **一个侧栏项对一个页面。** `main` 槽按侧栏 id 分派（`Slots` 里 `main.keyDomain: "open: any string the owner dispatches"`），加第二个侧栏项＝加一个页面，不是加一个 tab。
3. **domain 没有迁移。** 存储单元版本与 spec 版本不一致会直接拒开；字段退休靠 zod `.strip()`。所以新字段必须是**可选 + 有默认值**，版本号不动。
4. **`schedule` 服务不是提醒器。** 它把任务绑在某个 Session 上，投递时会唤醒会话、由 agent 消费（`Service.schedule.create` 的说明：「bound to the caller-selected Session」）。拿它做个人提醒＝烧 token、依赖会话存在、面板里根本点不了。→ 提醒必须是 Host 侧的进程级定时器。
5. **现在没有任何插件 `provide` 服务。** 全仓库 `ctx.provide(` 零命中；`notify` 也只有工具。要做联动，得先定义服务契约——这是本方案里唯一改动到别的 bundle 的地方。
6. **Host 只在 Harness 运行时存在。** 关掉 App 就没有定时器。这条不能藏，必须变成产品语义（第 7.6 节）。

---

## 3. 参考项目：调研结论与取舍

尺子只有三把：**客户端能不能用**（§2.1：不能引包）、**离线可测**、**许可干净**。版本与发布时间是 2026-10 直接查 npm registry 的结果。

### 3.1 重复规则库

| 库 | 版本 / 最近发布 | 许可 | 体积（解包 / gzip） | 判断 |
| --- | --- | --- | --- | --- |
| `rrule`（rrule.js） | 2.8.1 / 2023-11-10 | BSD-3-Clause | 687 KB / 13.5 KB | 下载量仍大（11.6M/月），但已近三年没有提交与发布。**不引入** |
| `rrule-temporal` | 2.2.8 / 2026-10-01 | MIT（npm 元数据） | 49 KB gzip | 仍在维护，但建立在 `Temporal` 上 |
| `@rschedule/core` | 1.5.0 / 2023-02-03 | Unlicense | ~4 KB + 日期适配器 | 已放弃 |
| `ical.js` 的 `RecurExpansion` | 2.2.1 / 2025-08-08 | MPL-2.0 | 22.8 KB gzip，零依赖 | 若做 `.ics` 才需要 |

三条关键事实：

- rrule.js 的 README **自己写明不符合 RFC**：`dtstart` 不自动成为第一个实例（继承自 python-dateutil），"任何关键字在任何频率下都合法"，返回的 `Date` 是"浮动/按 UTC 解释的本地时间"。用它做"每周一 09:00（America/New_York）"必须自己补齐时区语义，等于把省下的工作量还回去。
- `Temporal` 在本机 Node v22.22.0 上**默认不可用**（实测 `typeof Temporal === 'undefined'`，`--harmony-temporal` 下才有）；Node 24 未验证，不能写进设计前提。真要 Temporal 就得背 `temporal-polyfill`（19 KB gzip）。
- RFC 5545 的 recurrence set 是 **`(RRULE ∪ RDATE) \ EXDATE`**，`RECURRENCE-ID` 表示单实例改期。我们的子集只覆盖其中第一项加 `EXDATE`，这个"只做子集"的决定要在 README 里写明，避免用户以为支持全量 RRULE。

结论：自写 `src/recurrence.js`（约 200 行 + 测试），对外只暴露 `expand(item, { from, to, limit })`。将来子集不够用，换 `ical.js` 的 `RecurExpansion` 时存储与调用方都不动。

### 3.2 日历 UI 组件

| 库 | 版本 / 最近发布 | 许可 | gzip | 备注 |
| --- | --- | --- | --- | --- |
| FullCalendar | core 7.1.3 / 2026-10-16 | MIT（标准视图） | `@fullcalendar/react` 31 KB | v7 改了打包结构，React 包 **peer 依赖 `temporal-polyfill`**；resource/timeline 等是商业授权（`@fullcalendar/resource-timeline` 的 license 就写着 `SEE LICENSE IN LICENSE.md`） |
| react-big-calendar | 1.20.0 / 2026-06-01 | MIT | 53 KB | 自带 **agenda 视图**；peer 覆盖 React 16–19；拖拽要走 react-dnd 插件 |
| Schedule-X | `@schedule-x/calendar` 4.9.1 / 2026-09-29 | MIT | 38 KB | React 包 peer 依赖 **preact + @preact/signals**，等于再拖一个渲染器进来 |
| react-day-picker | 10.0.2 / 2026-09-30 | MIT | 19.7 KB | 只是日期网格，不是事件日历 |

四个都卡在同一条约束上：**客户端半边不能引包**（§2.1）。所以问题不是"选哪个"，而是"自己画多少"：自建 7 列 CSS Grid 月视图约 300 行（含样式），换来完全用 `--dsw-alias-*` token、深浅色自动跟随、`role="grid"` 键盘导航自己写对。**借鉴** Schedule-X / FullCalendar 的"月格 + 点开弹层"交互，不借鉴代码；react-big-calendar 的 agenda 视图正好证明"列表式议程"是正经形态，我们本来就有（现有分组列表）。

### 3.3 iCalendar 互操作

| 库 | 版本 / 最近发布 | 许可 | 用途 |
| --- | --- | --- | --- |
| `ical.js`（Mozilla） | 2.2.1 / 2025-08-08（仓库仍有提交） | MPL-2.0 | 解析 + 生成，零依赖；MPL 是文件级 copyleft，只调用不改文件无影响。Firefox/Thunderbird 日历用它 |
| `node-ical` | 0.27.3 / 2026-10-03 | Apache-2.0 | 只解析；带 `expandRecurringEvent({from,to})`，能处理 EXDATE/RECURRENCE-ID/DST，但依赖 rrule-temporal + temporal-polyfill |

互操作的现实，两条硬事实：

- CalConnect 2024 的任务扩展规范直言 VTODO「**采用有限，主要用于个人提醒与待办**」。实际能读 VTODO 的是 Apple 提醒事项（CalDAV）、Thunderbird、Nextcloud；Google Tasks 没有公开的 CalDAV VTODO 面。
- **Google Tasks 的 `due` 只存日期**，官方文档原话：「截止日期仅记录日期信息；在设置截止日期时，系统会舍弃时间戳的时间部分。您无法通过 API 读取或写入任务的截止时间」。

结论：Phase 3 只做**导出**，而且导成 `VEVENT`（兼容性远好于 VTODO），提醒用 `VALARM` + `TRIGGER;RELATED=END`——这正好就是"N 分钟前提醒"的语义。导入放到最后，且只接受 §5.2 的子集，其余明确报 `unsupported_rule`。

### 3.4 产品模型参照：抄什么、不抄什么

- **Google Calendar**：`start.dateTime`（带时区）与 `start.date`（仅日期）是**两种类型**，不能混用；官方明确"时区字段对全天事件没有意义"，且重复事件"必须指定时区"才能展开。→ 全天必须是**日期类型**，不是一个"零点瞬时 + 标志位"。
- **Google Tasks**：单一 `due`，只有日期，没有时间。
- **Todoist**：due 分 *full-day / floating with time / with time and fixed timezone* 三型，**另有 Deadlines**，说明"什么时候做"与"什么时候截止"是两件事。
- **Apple 提醒事项**：日期 + 可选时刻 + 重复 + 基于时间/地点的提醒。
- **完成语义**：日历类应用预生成实例；任务类应用（Things/Reminders/Todoist）通常在完成当前次时**生成下一次**，旧的留作历史。

据此改两处：

1. **全天用 `dueDate`（`YYYY-MM-DD`）而不是"当地零点的瞬时"**，见 §5.1 与 §5.5。
2. **完成语义仍用"水位线"而不是"生成副本"**，但理由是本仓库的存储形态（§6.3）。

"安排/截止"分离（Things 的 When/Deadline）留到 Phase 3 的 `startAt`：每多一个日期字段，重复展开、排序、分组、提醒、界面五处都要乘二；单人本地待办里大多数条目只需要一个时间。

### 3.5 本地应用怎么做到期提醒

- 通式（Thunderbird 的 alarm 服务、Obsidian Reminder 插件之类）：**把下一次触发时间物化存下来**，触发后推进；持久化"已提醒"账本做去重；启动时扫一遍补偿错过的。Obsidian Reminder 是个很好的参照：只在应用运行时通知，但把 **Overdue 分区、单条静音、"提醒我稍后"、全局"暂停通知"** 都做成了正式功能——说明静默时段不是补丁，是一等配置。
- 可靠性的排序（"人不在电脑前"这个前提）：**远程推送 ≫ launchd + `terminal-notifier` > 进程内循环**。远程推送是唯一"App 关着也能到"的通道；`terminal-notifier` 仍维护（2026-08 有提交），但要一次性授权、且以它自己的身份出现；`osascript -e 'display notification'` 会归属到脚本宿主并受专注模式影响；cron/launchd 也补不回任意错过的时刻。
- 参考价值最大的是 **dsh 自带的 `schedule` 服务**：`at / after_seconds / every / daily / weekly / cron` 六种形态的"下一次何时"算得很干净，值得照抄数学；但它绑定 Session，投递方式不能照抄（§2.4）。

结论：§7 的形状——单计时器 + 物化下次触发 + 账本去重 + 启动补偿 + 远程推送。

### 3.6 agent 侧的工具形态

`nspady/google-calendar-mcp`（MIT，事实上的参考实现）暴露的是 `list-events` / `search-events` / `get-event` / `create-event` / `create-events` / `update-event` / `delete-event` / `get-freebusy` / **`get-current-time`**：**窗口式查询 + 结构化时间 + 一个"现在几点"的锚点**。它甚至提供 `--enable-tools` 白名单，README 的理由是"每个工具都消耗上下文"。

对我们的三条启示：

1. 只加**一个**窗口工具 `list_user_agenda(from, to, tz?)`，不要 `list-today` / `list-week` / `list-overdue` 三个。
2. 时间入参接受当地墙钟字符串（§5.4），把"算 UTC"从模型手里拿走。
3. 每个结果都回显 `now` 与 `time_zone`，等价于免费送了一个 `get-current-time`，模型不必另调一次。

参考：<https://github.com/jkbrzt/rrule> · <https://www.npmjs.com/package/rrule-temporal> · <https://www.rfc-editor.org/rfc/rfc5545> · <https://fullcalendar.io/license> · <https://github.com/jquense/react-big-calendar> · <https://schedule-x.dev/> · <https://github.com/mozilla/ical.js> · <https://github.com/jens-maus/node-ical> · <https://standards.calconnect.org/cc/cc-11001-2024.html> · <https://developers.google.com/workspace/calendar/api/concepts/events-calendars> · <https://developers.google.com/tasks/reference/rest/v1/tasks> · <https://developer.todoist.com/api/v1/> · <https://github.com/nspady/google-calendar-mcp> · <https://uphy.github.io/obsidian-reminder/guide/notification.html> · <https://github.com/julienXX/terminal-notifier>

---

## 4. 方案对比

| | A. 扩展 `dsh-user-todo`（推荐） | B. 新建 `dsh-calendar` bundle | C. 双 bundle：calendar 只做界面 |
| --- | --- | --- | --- |
| 数据 | 同一份文档、同一套 id | 第二个 domain，靠 id 关联 | 借 user-todo 的 route |
| 一次改动 | 一个 bundle | 两个 bundle + 迁移/同步 | 两个 bundle + 跨包协议 |
| 面板 | 页内视图切换 | 新侧栏项 + 新页面 | 新侧栏项 + 新页面 |
| 工具 | 复用 3 个 + 增 1 个 | 新增一套 calendar 工具，语义重叠 | 界面无工具，模型看不到日历 |
| 失败面 | 单插件变大（client 约 1500 行） | 两份数据可能不一致 | 最脆的一条 |
| 成本 | 中 | 高 | 高 |

**推荐 A**。理由是"日历"在这里不是新实体，而是**待办的一个视图 + 时间语义**：一条"周三 15:00 交周报"既是待办也是日程。拆成两个 bundle 会立刻面临"在日历里改了标题，列表里还是旧的"这类双写问题。

为避免单文件失控，实现时把 Host 侧切成 `src/zone.js`、`src/recurrence.js`、`src/agenda.js`、`src/reminders.js`；`client.js` 内部按 `views/` 分节（仍是单文件，但分区）。将来真要做"非待办的纯事件"，再把 recurrence/agenda 两个模块抽成 B 方案。

---

## 5. 数据模型

### 5.1 新增字段（全部可选，缺省即旧语义）

| 字段 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `dueDate` | `string \| null` | `null` | **全天**条目的日历日 `YYYY-MM-DD`。有值即全天，是这一天的**权威值** |
| `dueAt` | `string \| null` | `null` | 定时条目的到期瞬时（UTC）。全天条目也有一份 `dueAt`，**由 store 从 `dueDate` 派生的当地零点**，只用于排序与提醒计算，不手写 |
| `timeZone` | `string \| null` | `null` | IANA 名，如 `Asia/Shanghai`；`null` 用配置默认值。定时条目的重复按它的墙钟推进，全天条目只用它算"当天几点提醒" |
| `recurrence` | `object \| null` | `null` | 重复规则，见 5.2 |
| `recurrenceDoneThrough` | `string \| null` | `null` | 序列中"已完成到哪一次"（occurrence 起点），序列级完成语义 |
| `exdates` | `string[]` | `[]` | 被跳过的 occurrence 起点（"这次不做"） |
| `remindBeforeMin` | `number[]` | `[]` | 提前分钟数，如 `[0, 15]`；`[]` 表示按 `prefs` 默认。全天条目相对"当天的提醒时刻"（`prefs.allDayReminderTime`，默认 `09:00`） |

注意 `allDay` **不落库**：它由 `dueDate !== null` 推导。两个字段互相印证只会制造"标志位说全天、日期字段却是空"的坏状态；工具与接口里的 `all_day` 只是投影。

文档顶层再加两块（不是 item 字段）：

```jsonc
{
  "items": [ /* ... */ ],
  "notifications": [ { "key": "todo-…@2026-11-02T01:00:00Z#15", "at": "2026-11-02T00:45:00Z", "status": "sent" } ],
  "prefs": {
    "pushReminders": true,
    "defaultRemindBeforeMin": 0,
    "allDayReminderTime": "09:00",
    "quietHours": null,          // 或 { "start": "22:00", "end": "08:00" }
    "digestAt": null,            // 或 "08:30"，每天早上的当日议程推送
    "weekStart": 1               // 1=周一 7=周日，仅界面用
  },
  "updatedAt": "2026-10-28T09:51:13Z"
}
```

### 5.2 重复规则（结构化，不是 RRULE 文本）

```jsonc
"recurrence": {
  "freq": "weekly",          // daily | weekly | monthly | yearly
  "interval": 1,             // 每 N 个周期
  "byWeekday": [1, 3, 5],    // 仅 weekly 用，1=Mon … 7=Sun
  "count": null,             // 与 until 二选一，都给则以先到者为准
  "until": null,             // UTC 瞬时
  "dtstart": "2026-11-02T01:00:00Z"   // 序列第一次发生；默认取 dueAt
}
```

为什么**不直接存 RRULE 字面量**：

- Host 只需要一个可控子集，结构化对象用 zod 一次校验，出错能定位到字段；RRULE 字符串要自己写解析器，等于多一层可能有 bug 的中间层。
- 导出 `.ics` 时由 `toRRule()` 生成标准 RRULE；导入时 `parseRRule()` 只接受同一子集，其余规则**明确报 `unsupported_rule`**，而不是悄悄忽略（这比"支持一半"诚实）。
- 将来若子集不够用，换成 rrule.js 只需替换 `src/recurrence.js` 的实现，存储不动。

### 5.3 版本策略：**保持 `DOMAIN_VERSION = 1`**

旧文档没有这些键；`itemSchema` 用 `z.boolean().default(false)`、`z.array(...).default([])`、`.nullable().default(null)` 之类，`.strip()` 继续负责丢未知字段。因此老文档能开、新文档老版本打不开是单向兼容（回退需备份，写进 README 即可）。

> ⚠️ 一个必须先修的隐患：`src/store.js` 里三处写入都是 **重新构造文档**——
> `documentSchema.parse({ items, updatedAt })`（`store.js:293`、`:372`、`:400`）。
> 一旦文档多了 `notifications`/`prefs` 两个顶层字段，这三处会把它们 strip 掉。实现第一步就是把它们改成展开原文档：`{ ...document, items, updatedAt: at }`，并补一条"写入不丢顶层字段"的回归测试。

### 5.4 时间写法：三种输入，一种存储

工具与接口都接受三种写法，存储只有两种形状（`dueDate` 或 `dueAt`，§5.5）：

| 输入 | 落库 |
| --- | --- |
| `2026-11-02` | 全天：`dueDate: "2026-11-02"`，`dueAt` 派生为 `timeZone` 下当地零点 |
| `2026-11-02T15:00` | 定时：按 `timeZone`（缺省用配置时区）换算成瞬时，`dueDate: null` |
| `2026-11-02T07:00:00Z` | 定时：已是 UTC 瞬时；`timeZone` 仍记录来源时区，供重复规则使用 |

这一条是专门为模型加的：让它算"明天下午三点是几点 UTC"是稳定性最差的一环（这个仓库的时区是 `Asia/Shanghai`，模型经常多/少 8 小时）。附带好处——工具结果里回显 `now` 与 `time_zone`，模型就能自己对齐。

### 5.5 为什么全天是"日期"而不是"零点的瞬时"

如果全天存成"当地零点瞬时 + `allDay` 标志"，那么用户在另一个时区打开时，同一个瞬时会被渲染成前一天 16:00——日期就漂了。Google Calendar 的处理是把全天做成**另一种类型**（`start.date` vs `start.dateTime`），官方文档明确"时区字段对全天事件没有意义"。

所以这里的规则只有一条：

> **`dueDate` 有值 → 一律按日历日处理，任何时区下都渲染成同一天；`dueAt` 只是派生的排序/提醒输入。**

派生在 `src/store.js` 一处完成（`dueDate` + `timeZone` → 当地零点瞬时），写入路径只有两个（面板、工具），因此不会出现两边算法不一致。读的时候谁都不许反推 `dueDate`。

代价是 `dueAt` 在两种条目里含义不同（权威 vs 派生），所以类型注释与工具投影里要写清楚：模型看到的是 `due_at` / `due_date` / `all_day` 三个字段，`all_day` 由 `due_date` 是否存在推出。

---

## 6. 重复规则的展开

### 6.1 谁算、算多少

- **只有 Host 算**（约束 1）。面板按窗口问：`GET /api/user-todo?action=agenda&from=…&to=…`。
- 展开函数是纯函数：`expand(item, { from, to, limit, now }) → Occurrence[]`，无 I/O、无时钟依赖（`now` 注入），可离线测。
- 上限：单次窗口 ≤ 400 个 occurrence、≤ 366 天；`freq` 未知或 `interval > 100` 直接拒绝，避免 `COUNT=10^6` 把进程拖死。

### 6.2 occurrence 的身份

```js
occurrenceId = `${item.id}@${startInstant}`   // startInstant 用 dueAt 的存储形式，秒精度
```

稳定、可推导、不需要额外 id 表。工具里完成"这一次"就传 `occurrence_id`，完成"整个序列"就改 `status`。

### 6.3 完成语义（这是产品分歧点，先定死）

- **不复制条目**。勾掉 11 月 2 日那次"跑步"，只把 `recurrenceDoneThrough` 推到该 occurrence 起点；序列仍是 `open`，日历上下一期照常出现。
- 序列走到 `until`/`count` 尽头且最后一次已完成 → `status: 'done'`，`completedAt` 记最后一次时间。
- 列表视图里，重复条目显示"下一次"：`下次 11月4日 · 每周一三五`；今天没有下一次时置灰。

不做"完成即生成下一条副本"（很多任务类应用的做法，例如 Things/Reminders 在完成当前次时生成下一次，旧的留作历史）。理由是本仓库的存储形态：

- 一份 JSON 文档 + `maxItems: 5000`。每天一期的习惯，一年就是 365 条条目，三年撞上限；而水位线方案**零增长**。
- 副本方案让"改标题""改时间"变成"改哪个副本"的问题（旧副本要不要一起改？），而这里没有层级与历史视图，收益兑现不了。
- 代价要承认：**不支持乱序完成**（先勾掉 11 月 4 日、再勾 11 月 2 日），也不保留每次的备注。真要这两样，第二期加 `completions: string[]`（有界、与 `exdates` 同构），而不是把条目拆成副本。

### 6.4 时区与夏令时

- 重复按**当地墙钟**推进：`America/New_York` 每周一 09:00 的序列，跨 DST 仍是 09:00。
- `src/zone.js` 提供两个原语，全部基于 `Intl.DateTimeFormat`（Node 自带 ICU，无依赖）：
  - `zonedParts(instant, tz) → {year,month,day,hour,minute}`
  - `instantFromParts(parts, tz) → instant`（两轮偏移回推）
- 夏令时边界按 RFC 5545 的口径：本地时刻**不存在**时（春季跳表）顺延到第一个有效瞬时；**出现两次**时（秋季重叠）取较早的那个。两种情形各写一条测试。
- `Asia/Shanghai` 无 DST，但测试必须用有 DST 的区固定住行为。

---

## 7. 提醒

### 7.1 状态放在哪

不放内存——重启就丢。放文档：

- 每个 item：`remindBeforeMin`（意图）。
- 文档顶层 `notifications`（账本）：`{ key, at, status }`，环形最多 500 条、保留 30 天。
- `key = occurrenceId + '#' + offsetMin`，天然幂等。

### 7.2 调度器

```
插件挂载 → 计算最近的待发时刻 → setTimeout(最多 60s) → tick
             ↑                                          │
             └────────── 任何写入/配置变化 ──────────────┘
```

- 一个 `setTimeout`，间隔 = `min(下一个待发时刻 - now, 60s)`。60s 封顶是为了对系统休眠、时钟调整、写入风暴都无感，不追求秒级精确。
- tick 时把"已到期且未发"的聚成**一条**推送（`3 项待办：A / B / C`），避免连点 5 条。
- 定时器归插件 fiber 所有：`ctx.effect(() => { scheduler.start(); return () => scheduler.stop() })`。卸载/热重载自动清。

### 7.3 幂等与失败

- 先发、**成功后再记账**：宁可崩溃后重复一次，也不静默漏一条（at-least-once + 键去重）。
- `status: 'failed'` 的条目 5 分钟后重试一次；仍失败则留痕、在面板显示"上次推送失败"，不再重试（不制造无限重试）。
- `not_configured`（没配 PushPlus token）不是失败：降级为面板内提示，并**不记账**——配好 token 后还能补发（在同一补偿窗口内）。

### 7.4 错过与补偿

- 启动时扫一遍：`remindAt < now` 且未记账、且 `dueAt > now - 24h` → 合并成一条"错过的提醒"推送。
- 超过 24h 的过期提醒不再推，只把条目标成逾期（日历上红色）。这条要靠配置可调（`remindCatchUpHours`，默认 24）。

### 7.5 静默时段与限流

- `prefs.quietHours` 命中时：不推送，攒到窗口结束发一条汇总（不是逐条补发）。
- 全局限流：`maxPushesPerHour`（默认 6）；超出的合并到下一次 tick。
- 所有推送内容截断到 `notify` 的 `contentMaxChars`，标题带 `[待办]` 前缀便于在微信里扫读。

### 7.6 进程边界（必须写进 README）

> 提醒只在 Harness 运行时触发。App 关闭期间不会推送；下次启动会补一条"错过的提醒"（24h 内）。

可靠性按"人不在电脑前"这个目标排：**远程推送 ≫ 进程外定时器（launchd + `terminal-notifier`）> 进程内循环**。远程推送是唯一不受"App 是否开着"影响的通道，代价是它有网络依赖、且内容会落在第三方；进程外定时器要授权、有自己的应用身份、也补不回错过的时刻。

三条路径，按成本排序：

1. **只做进程内 + PushPlus**（推荐 v1）——把语义写清楚，别让用户误以为关掉 App 也会响。
2. `dsh-notify` 页面提供"测试推送"，用户自己确认链路（几乎零成本，建议顺带做）。
3. 真要离线可靠：`launchd` 定时跑的小脚本直连 PushPlus（读 `~/.dsh/.credentials.yaml`），或 `terminal-notifier` 做本机提示。这是另一个工程，不进本方案。

### 7.7 与"agent 提醒"的分工

`create_goal`/`schedule_create` 那套是**会话绑定**的：适合"20 分钟后提醒我回来看看这个任务"，由 agent 消费、能在对话里继续干活。日历提醒是**人看的闹钟**，与任何会话无关。两者不互相替代，README 里要说清楚，避免以后有人把日历提醒接回 `schedule` 服务。

---

## 8. 与 `dsh-notify` 的联动

### 8.1 现状

`notify` 只有工具：`notify_send` 的 `execute` 里直接调 `deliver()`（`notify/src/tools.js:158`）。别的插件没有任何办法复用这条链路。

### 8.2 改动：暴露一个最小服务

```js
// notify/index.js
export const provide = 'notify'          // 供 Loader 诊断

export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  const send = async ({ title, content, signal }) => {
    const out = await deliver({
      provider: ctx.credentials, config,
      title: truncate(title ?? config.defaultTitle, config.titleMaxChars),
      content: truncate(content, config.contentMaxChars),
      signal, logger: ctx.logger,
    })
    // 只回传计数与失败码，不回传 token / target
    return out.total === 0
      ? { ok: false, code: 'not_configured', delivered: 0, total: 0 }
      : { ok: out.delivered === out.total, code: out.delivered === out.total ? null : 'partial',
          delivered: out.delivered, total: out.total,
          failures: out.results.filter(r => !r.ok).map(r => ({ target: r.target, code: r.code, retryable: r.retryable })) }
  }
  ctx.provide('notify', { send, status: async () => … })
  // notify_send 工具改为调用同一个 send，保证只有一条投递路径
}
```

关键点：

- `ctx.provide(name, value)` 是 fiber effect，插件卸载自动摘掉（`cordis/src/reflect.ts:277`）。
- 服务只暴露 `send` / `status`，**不暴露 token、目标列表、`deliver` 细节**。
- `notify_send` 工具与 `notify.send()` 走同一份截断/投递/失败码逻辑，避免两套行为。
- 服务是**无状态**的：幂等、去重、限流、静默时段全部归调用方（本期就是 user-todo 的调度器）。等真有第二条通道（系统通知、邮件）再加 `channel` 字段，现在加就是空参数。

### 8.3 user-todo 侧怎么用

调度器持有一个"发送口"，触发时解析：

```js
const port = ctx.get('notify')       // 不在 inject 里：notify 可有可无
const result = port === undefined
  ? { ok: false, code: 'notify_absent' }
  : await port.send({ title, content })
```

不用 `inject: ['notify']` 硬依赖，也不用 `ctx.inject(['notify'], …)` 包一层重启逻辑：提醒是**可降级**的，缺 notify 时面板内提示仍然工作。测试时直接注入假的 `send`。

### 8.4 降级矩阵

| 情形 | 行为 |
| --- | --- |
| 没装 notify | 面板内提示条 + 条目标"已提醒"；日志记 `notify_absent` |
| 装了但没配 token | `not_configured`；不记账，配好后 24h 内可补发 |
| 部分目标失败 | 记 `partial` + 失败目标名；不算成功，按重试策略处理 |
| 全失败 | `failed`，5 分钟后一次重试 |

---

## 9. 面板：怎么放日历

### 9.1 位置：页内视图切换（推荐）

侧栏仍是**一个**「日历与待办」入口（写作时叫「我的待办」）；页面头部加分段控件：

```
[ 列表 ] [ 日历 ]                         ‹ 2026 年 11 月 ›   [今天]
```

- 好处：一份数据、一个路由、一处状态；用户不会在两个页面间困惑"我改的是哪份"。
- 代价：`main` 槽只能注册一个页面（本来也够用）。
- 若将来要独立入口：`sidebar.panellist` 再加一条 id、`main` 再注册一个 key 即可，约 30 行，不用改数据。

### 9.2 三种视图

| 视图 | 结构 | 成本 |
| --- | --- | --- |
| 月 | CSS Grid 7 列 × 5–6 行；格内最多 3 条 chip + "+N"；点某天在下方展开当日议程 | 中 |
| 周 | 7 列，只分"全天 / 有具体时间"两段，不做 24 小时时间轴 | 低 |
| 议程 | 现有分组列表 + 日期范围头（今天/本周/自定义） | **复用现有实现** |

v1 只做**月 + 议程**；周视图留到第二期（时间轴是真正昂贵的部分，收益却不如月视图）。

### 9.3 交互

- 点空格子 → 组合框预填该日期（全天），回车即建。
- 点 chip → 打开现有 `Editor`（标题/备注/标签/时间），新增"重复""提醒"两行。
- 勾选 chip 左侧的框 → 完成**这一次**（`occurrence_id`）。
- 拖拽改期 → 第三期（HTML5 drag events，无依赖），v1 用"编辑里改时间"。
- 键盘：格子 `tabIndex`，方向键移动选中日，Enter 建条目；`role="grid"` + `aria-label` 日期。

### 9.4 取数与缓存

- 列表视图：`action=list`（不变）。
- 日历视图：`action=agenda&from&to`（新增，只读）。
- 任何写入后：用响应里的 `state` 更新列表，同时让日历窗口**失效重取**（occurrence 只有 Host 会算，客户端不猜）。
- 预取：切月时先渲染已有 chips，再补请求；请求失败保留上次结果并显示"读取失败"条。

### 9.5 视觉

只用主题 token：`--dsw-alias-bg-layer-1/2`（格子与卡片）、`--dsw-alias-border-l1/l2`（网格线）、`--dsw-alias-brand-primary`（今天）、`--dsw-alias-state-error-primary`（逾期）、`--dsw-alias-label-secondary/tertiary`（次要文字）。深浅色自动生效，不写死颜色。

---

## 10. 工具面

### 10.1 新增一个工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `list_user_agenda` | `from`、`to`（可选，默认今天~+7 天）、`include_done`（默认 false） | `{ now, time_zone, occurrences: [{ occurrence_id, item_id, title, all_day, start_at, date, status, recurrence, tags }] }` |

返回里全天条目的 `start_at` 是派生的当地零点，`date` 才是给模型看的那一天——和 §5.5 同一条规矩：**渲染与推理用 `date`，排序才用 `start_at`**。

为什么单开一个而不是扩 `list_user_todos`：列表是"全部条目的状态"，agenda 是"某窗口内的发生"。混在一个工具里会让可选参数爆炸，模型也更容易误用。`toolNames` 配置加第 4 个键（`agenda`）。

### 10.2 既有工具的扩展（只加可选参数）

`create_user_todos` 的 item 增加：

```jsonc
{
  "title": "交周报",
  "due_at": "2026-11-02T15:00",     // 当地墙钟（也可写 Z 或纯日期）
  "remind_before_min": 15,           // 数字或数组
  "repeat": { "freq": "weekly", "by_weekday": [1, 3, 5] }
}
```

纯日期形式走全天：

```jsonc
{ "title": "体检", "due_at": "2026-11-05", "remind_before_min": 0 }   // 落库 dueDate，09:00 提醒
```

`update_user_todos` 的 change 增加 `repeat`、`remind_before_min`、`complete_occurrence`、`exclude_occurrence`；`null` 仍是"清除"。`all_day`、`due_date` 作为**输出**字段出现，输入只需要一个 `due_at`（写纯日期即全天），这样模型不必记两个字段。

### 10.3 典型对话

| 用户说 | 模型调用 |
| --- | --- |
| 明天下午三点提醒我交周报 | `create_user_todos({items:[{title:"交周报", due_at:"<明天>T15:00", remind_before_min:0}]})` |
| 每周一三五早上九点跑步 | `create_user_todos({items:[{title:"跑步", due_at:"<下周一>T09:00", repeat:{freq:"weekly", by_weekday:[1,3,5]}}]})` |
| 这周还有什么没做 | `list_user_agenda({from:"<今天>", to:"<本周日>"})` |
| 周三那次不去了 | `update_user_todos({changes:[{id:"todo-…", exclude_occurrence:"todo-…@2026-11-04T01:00:00Z"}]})` |

工具返回里带 `now` 与 `time_zone`，模型下一次相对时间推算就有锚点。

---

## 11. 面板接口（`src/route.js`）

新增一个**只读** action，保持"GET 只能读"的既有约束（`route.js:34` 的 `READ_ACTIONS` 里加 `agenda`）：

```
GET /api/user-todo?action=agenda&from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z
→ 200 { ok: true, value: { from, to, timeZone, now, occurrences: [...] } }
```

窗口语义：`from` 含、`to` 不含；两者都接受瞬时或纯日期（纯日期按当地零点解释，方便面板直接传 `2026-11-01`）。缺省时取"今天 00:00 起 7 天"。

错误码沿用现有风格：`invalid_window`（缺 from/to、跨度超限）、`window_too_large`（>366 天）、`unsupported_rule`（文档里存在未知规则——只可能在手改文件时出现）。

> 实现细节：现在 `dispatch` 只从 query 里读 `action`，参数一律取自 body；而 GET 的 body 恒为 `{}`（`route.js:172`）。所以要么在 GET 时把 query 合并进 body（`{ ...Object.fromEntries(url.searchParams), ...body }`），要么让 handler 拿到 `url`。推荐前者，一行改动，且不破坏"GET 只读"。

---

## 12. 配置项（`cordis.patch.yml` 的 `config`）

沿用 `resolveConfig` 的严格校验（未知字段、越界值直接让加载失败）。新增字段与 `user-todo` 的既有默认值风格一致：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `toolNames.agenda` | `list_user_agenda` | 第 4 个工具名；四处名字必须互不相同（现在 `resolveConfig` 里写死了 `size !== 3`，要跟着改） |
| `timeZone` | `null`（系统时区） | 解析"当地墙钟"与推进重复时用；`null` 时取 `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| `agendaMaxSpanDays` | 366 | 一次窗口查询最长跨度 |
| `agendaMaxOccurrences` | 400 | 一次窗口查询最多展开多少条 |
| `remindCatchUpHours` | 24 | 启动补偿窗口；超出的过期提醒只标逾期不推送 |
| `maxPushesPerHour` | 6 | 推送限流，超出合并到下一次 tick |
| `schedulerMaxSleepMs` | 60000 | 单次 `setTimeout` 上限，决定"最多晚多久发现到期" |
| `allDayReminderTime` | `09:00` | 全天条目默认提醒时刻（文档 `prefs` 可覆盖） |

注意 `prefs`（用户可改的开关/静默时段/摘要时间）**不进配置**，进文档——它要能被面板改，而配置改了要重载插件。

---

## 13. 测试计划（全部离线）

| 文件 | 覆盖 |
| --- | --- |
| `tests/verify-zone.mjs` | 本地墙钟 ↔ 瞬时；DST 跳表/重叠两种边界；无 DST 时区 |
| `tests/verify-recurrence.mjs` | 四种 freq、interval、BYDAY、count/until、exdates、上限拒绝 |
| `tests/verify-agenda.mjs` | 窗口裁剪、全天排序、已完成序列的"下一次"、`recurrenceDoneThrough`、`dueDate` 派生 |
| `tests/verify-store.mjs`（扩） | **写入不丢 `notifications`/`prefs`**；旧文档（无新字段）能开、能写 |
| `tests/verify-reminders.mjs` | 假时钟：到期聚合、幂等、重启补偿、静默时段、限流、失败重试 |
| `tests/verify-notify-service.mjs` | `provide` 出现/消失；`not_configured`/`partial`/全失败三种返回 |
| `tests/verify-route.mjs`（扩） | `agenda` 只读、POST 拒绝、窗口参数校验、query 合并 |
| `tests/verify-client.mjs`（扩） | 月网格渲染、点日建条目、切视图、键盘导航、旧数据不崩 |

沿用现有 harness（`tests/harness.js` 的 `fakeStorageDomain`/`fakeConnection`/`fakeContext`）；提醒测试加 `fakeClock` 与 `fakeNotify`。

---

## 14. 分期

### Phase 1：日历（读 + 建）— 约 1200–1500 行（含注释与测试）

- `src/zone.js`、`src/recurrence.js`、`src/agenda.js`（新增）
- `src/item.js`/`src/domain.js`：新字段 + 类型
- `src/store.js`：校验、`dueDate` 派生、occ 完成/跳过、**写入展开文档的修复**
- `src/route.js`：`agenda` + GET 的 query 合并
- `src/tools.js`：4 个工具的参数与投影
- `client.js`：视图切换、月网格、当日议程、编辑器两行
- `locale`：约 30 个键（中英）
- 测试 4 个新文件 + 3 个扩写

交付即可用：能建带时间/重复的条目，能在月历里看，模型能按窗口查。**不带任何推送副作用**。

### Phase 2：提醒 + 通知联动 — 约 600–800 行

- `notify`：`provide` 服务 + `notify_send` 改走同一路径（约 100 行，含测试）
- `src/reminders.js`（新增）、`index.js` 接线
- `client.js`：提醒 chip、设置弹层（开关/静默时段/摘要时间）、失败提示
- 测试：`verify-reminders.mjs`、`verify-notify-service.mjs`

### Phase 3：打磨（按需）

拖拽改期、周视图时间轴、`.ics` 导入导出（含 `parseRRule` 子集）、`startAt`（"开始做"与"截止"分离）、每日议程由 agent 写一段摘要、`completions` 支持乱序完成。

---

## 15. 风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| App 关闭期间的提醒丢失 | 用户以为会响 | 明确写入 README；启动补偿 24h；可选 launchd 方案 |
| 时区/DST 处理错 | 重复条目漂移一小时 | 全部走 `zone.js`，用有 DST 的时区做测试 |
| `client.js` 从 929 涨到约 1500 行 | 可维护性 | 分区注释 + 单文件仍按 view 切分；超过 1800 行再考虑拆第二个 bundle |
| 写入丢顶层字段（现有 bug 面） | 提醒账本静默丢失 | Phase 1 先修 + 回归测试 |
| 手改 JSON / 未来加必填字段 | 拒开、列表看起来"没了" | 新字段全可选；README 写清"改结构和备份" |
| 通知轰炸 | 用户关掉整个功能 | 聚合 + 限流 + 静默时段，默认值保守 |
| 推送内容含隐私 | 微信里可见标题 | 标题只放条目标题，不放备注；备注截断 |

---

## 16. 需要你拍板的三件事

1. **日历放哪**：页内 tab（推荐，改动小）还是独立侧栏项"日历"（更显眼，多一个页面与条目）。
2. **要不要每日议程推送**（`digestAt`，比如每天 08:30 推"今天 3 件事"）——它是"日历 × 通知"最有感知的一环，但也最容易变成噪声。
3. **要不要 `.ics` 导入导出**：要的话 Phase 3 会多出约 300 行与一堆兼容性测试；不要的话结构化规则就够。

---

## 17. 实现记录（2026-10-28）

方案 A 已按第 1、2 阶段完整落地。与原计划不同的地方只有三处，都记在这里。

**定下的三件事**：日历放进「日历与待办」页内 tab（不加新侧栏入口，入口当时叫「我的待办」）；`digestAt` 实现但默认关闭（`null`），在面板设置里填时间才开；`.ics` 导入导出留在第 3 阶段，本次未做。

**实际文件**（行数是实现后的数量）：

| 文件 | 内容 |
| --- | --- |
| `user-todo/src/zone.js` | 时区换算：`instantFromParts`、`instantOfLocalMidnight`、`localDateOf`、`addLocalDays`、`weekdayOf`、`startOfWeek`、`formatInstant`/`parseInstant`，DST 缺口向后顺延、歧义取较早 |
| `user-todo/src/recurrence.js` | 结构化规则归一化与展开：`normalizeRecurrence`、`expandOccurrences`、`nextOccurrence`、`describeRule`；上限 `MAX_OCCURRENCES=400`，不支持的模式抛 `unsupported_rule` |
| `user-todo/src/agenda.js` | 议程窗口：`buildAgenda`、`parseWindowPoint`、`resolveWindow`；occurrence id 为 `${itemId}@${startInstant}`，完成水位线 `recurrenceDoneThrough` 加 `exdates` 两种跳过方式 |
| `user-todo/src/reminders.js` | `ReminderScheduler`：`pending()` 算待发、`tick()` 聚合投递、`#allowance` 按小时限流、`#digest` 每日议程；账本 `notifications[{key,at,status}]`，键为 `${occurrenceId}#${offsetMin}` |
| `user-todo/src/item.js`、`domain.js`、`store.js` | 数据模型与写入；**所有写都展开旧文档**（`{ ...document, items }`），修掉了会丢顶层字段的老 bug，并有回归检查 |
| `user-todo/src/tools.js` | 第四个工具 `list_user_agenda`；create/update 接受扁平重复参数与 `remind_before_min` |
| `user-todo/src/route.js` | 新增 `agenda`、`prefs`、`setPrefs`、`completeOccurrence`、`excludeOccurrence`；读操作限定在 `READ_ACTIONS`，GET 不能改数据 |
| `user-todo/client.js` | 页内 `[列表] [日历]` 切换、月网格、当天清单、编辑器里的重复与提醒、设置面板；编辑卡片提到页面级（列表行和日历芯片都指向同一张卡） |
| `notify/src/service.js`、`notify/index.js` | `ctx.provide('notify', ...)`，`notify_send` 与服务共用同一发送路径 |

**与原计划的三处偏差**：

1. **提醒循环不依赖 `schedule` 服务**。计划里考虑过复用 `schedule`，实现时确认它是会话绑定、触发会唤醒 agent，会把「提醒」变成「新会话」，因此改为 Host 进程内 `setTimeout` 循环，并明确写进 README。
2. **面板的 `list` 多给一个派生字段 `nextAt`**。列表里勾选重复条目要完成「下一次」，而浏览器不能自己展开规则；由 Host 在每次返回状态时算好，客户端不持有第二个展开器。
3. **编辑器不再嵌在行内**。列表行和日历芯片都只是「选中要编辑的条目」，编辑卡片在页面上方渲染一次；否则日历视图里选中条目没有地方显示编辑器。

**测试**：`user-todo` 八个文件 142 项（agenda 16、client 17、composition 10、recurrence 16、reminders 16、route 30、store 28、zone 9），`notify` 两个文件 17 项，外加仓库根的 locale 一致性检查。其中 `verify-composition.mjs` 用真实定时器跑完了一次提醒投递（装/不装 `notify` 各一次），`verify-reminders.mjs` 覆盖限流、静默、补发、摘要。

**仍未做**（第 3 阶段）：周视图与时间轴、拖拽改期、`.ics` 导入导出、`startAt`（开始与截止分离）、每日摘要里由 agent 写的一段话、乱序完成。

# 日历与提醒：设计决策记录

> 状态：已实现。日历、重复规则、提醒与通知联动落在 `dsh-user-todo`，`dsh-notify` 因此新增一个服务。工具与面板的行为以 [`user-todo/README.md`](../user-todo/README.md) 为准，本文件只记录当时为什么这样选。

## 平台约束（决定了所有选择）

1. **浏览器端不能引入 npm 包。** `client.js` 是原样下发的 classic script，`factory(require)` 只接受白名单（`react` 与少数 `dsh.client.external`），没有打包步骤。因此 FullCalendar、react-big-calendar、rrule.js 这类依赖都进不来：日期与重复规则的计算留在 Host，浏览器只负责渲染。
2. **一个侧栏项对应一个页面。** `main` 槽按侧栏 id 分派，加第二个侧栏项就等于加一个页面。
3. **domain 没有迁移机制。** 存储单元版本与 spec 不一致会直接拒绝打开，字段退役靠 zod `.strip()`。因此新字段必须可选且有默认值，版本号保持 1。
4. **`schedule` 服务不承担提醒。** 它把任务绑定到 Session，投递时唤醒会话由 agent 消费：拿来做个人提醒会消耗 token、依赖会话存在，面板里也点不了。提醒必须由 Host 侧的进程级定时器实现。
5. **Host 只在 Harness 运行期间存在。** App 关闭就没有定时器，这条要写进产品语义，不能省略。

## 采用的设计

日历放在 `dsh-user-todo` 内部，作为待办的一个视图与一套时间语义，复用同一份文档、同一套 id 和同一个面板。这样「周三 15:00 交周报」既是一条待办也是日历上的一项，不会出现日历与列表双写不一致。

Host 侧按 `src/zone.js`（时区换算，DST 缺口向后顺延、歧义取较早）、`src/recurrence.js`（规则归一化与展开，`MAX_OCCURRENCES=400`）、`src/agenda.js`（窗口与 occurrence id）、`src/reminders.js`（`ReminderScheduler`，账本 `notifications[{key,at,status}]`）拆分；`client.js` 仍是单文件，内部按 `views/` 分节。

重复规则只做结构化子集（`daily`/`weekly`/`monthly`/`yearly` + `interval`/`by_weekday`/`count`/`until`），每小时、每月第 N 个周几、`RDATE`/`RECURRENCE-ID` 返回 `unsupported_rule`。结构化对象比 RRULE 字符串更好校验，也足够覆盖个人待办；`.ics` 互操作大约还要 300 行加一批兼容性测试，因此不做。

## 与最初设计的三处差异

1. 提醒循环用 Host 进程内的 `setTimeout`，不依赖 `schedule` 服务（理由见约束 4）。
2. 面板 `list` 多返回一个派生字段 `nextAt`：列表里勾选重复条目完成的是「下一次」，而浏览器无法展开规则，由 Host 每次算好，客户端不持有第二个展开器。
3. 编辑器提到页面级渲染，不嵌在行内：列表行与日历芯片只负责选中条目，编辑卡片统一渲染一次，日历视图里选中也有位置显示它。

## 已知风险与未做

| 风险 | 处置 |
| --- | --- |
| App 关闭期间提醒丢失 | 写入 README；启动补偿 24 小时；可选 launchd 实现 |
| 时区/DST 处理错误 | 全部经 `zone.js`，用有 DST 的时区测试 |
| `client.js` 变大 | 分区注释 + 按 view 切分；超过 1800 行时评估拆成第二个 bundle |
| 推送含隐私 | 标题只放条目标题，不放备注 |

未实现：周视图与时间轴、拖拽改日期、`.ics` 导入导出、`startAt`（开始与截止分离）、每日摘要里由 agent 写的一段、乱序完成。

# dsh-bilibili

给 DeepSeek Harness 用的 B 站本人账号数据插件。它把你自己账号的**观看历史、稍后再看、收藏、关注、我的动态**抓取到本机持久化，向助手开放跨时间检索，并提供一个管理账号与抓取节奏的插件页（左侧栏「插件」里选中它，配置就在详情页描述下面）。

移植自 yorha 的 `core/yorha/connectors/bilibili`，保留了它的接口白名单、WBI 签名、分页游标状态机、退避策略与封闭错误码；**但持久化层换掉了**——不再依赖 Postgres，全部走 Harness 自己的存储与凭据 seam。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `bilibili_sync` | `datasets`（可选，五个数据集之一或多个）、`backfill`（可选） | 后台任务 id 与逐数据集结果 |
| `bilibili_search` | `query`、`dataset`、`since`、`until`、`limit`、`offset` | 匹配总数与本页条目，附数据新鲜度 |
| `bilibili_item` | `id`（必填，搜索返回的 id） | 单条完整记录 |
| `bilibili_schedule` | `recreate`（可选） | 定时抓取任务的建立/重建结果 |

抓取是每分钟几十次受限请求，因此 `bilibili_sync` **不在工具调用里同步等待**：它用 `ctx.jobs` 起一个后台任务并立刻返回 id，模型用 `job_output` 收结果。没有 job registry 的组装会退化为同步执行。

`bilibili_search` 的结果里始终带一个 `sync` 块（`lastRunAt` / `stale` / `running` / `authRequired`），所以"上次同步超过一天"这件事出现在模型正在看的地方，而不是要求它额外查一次状态。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/bilibili
```

或者在工作区里让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。装完后 profile 的 `cordis.patch.yml` 会多出一行 `id: bilibili`。

这个包是**有依赖的**（和 `dsh-plugins/v2ex`、`dsh-plugins/stock` 不同）：它需要 `@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-credentials` 与 `zod`，前两个来自 npm 上的 `0.2.1-rc.3` 发布线，所以**第一次使用前要在插件目录里装一次依赖**：

```sh
cd dsh-plugins/bilibili && pnpm install
```

插件目录自带一份 `pnpm-workspace.yaml`（`packages: ["."]`），用来切断向上查找，使它成为一个独立工程而不进入仓库的 workspace——`dsh-plugins/*` 不是 workspace 成员，仓库的各类 gate 也不会扫到它。

## 配置

`config` 全部可省，省略即用默认值。插件不自带 schema 库，因此由自己校验：写错会在加载阶段直接报错，而不是悄悄用默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据记录槽位，取值须匹配 `^[a-z][a-z0-9-]*$`；一个账号一个槽位 |
| `scheduleCron` | `0 9 * * *` | 定时抓取的 5 段 cron 表达式，按宿主时区求值 |
| `loginTimeoutSeconds` | `180` | 二维码有效期，最小 30 |

## 持久化：原来那套 Postgres 依赖去哪了

yorha 里的"数据库依赖"其实是六件互不相关的事。移植时逐项重新归属，其中三件在 DSH 里根本不需要：

| yorha | 它真正在做什么 | 这里 | 说明 |
| --- | --- | --- | --- |
| `credentials` 表 | 存一份本机凭据 | `ctx.credentials` 的 record 半边 | `GrantRecord.payload` 放 `{sessdata, dedeuserid, buvid3, buvid4}`，seam 原样保存不解释 |
| `source_state` 表 | 每个数据集的增量游标 | `storageDomain` 的 `cursors` 表 | 一个数据集一条记录 |
| `items` 表 | 去重后的条目 | `storageDomain` 的 `items` 表 | 键是 `sha256(sourceId)` |
| 根游标上的平台状态 | 退避/鉴权/风险计数 | domain 的 `global` 单例 | 正好是"每域一个"的语义 |
| `raw` 对象库 | 上游响应体的审计归档 | **删掉** | 存储层只收 JSON（没有二进制列）；响应体本身可重取 |
| `runs` 表 | 定时任务的运行留痕 | **删掉** | session log 就是留痕；工具调用与结果都在里面 |
| `source_lock` 咨询锁 | CLI 与 Web 可能并发采集 | **塌缩** | 见下 |

于是最终只有**一个 storage domain**（`bilibili`，`per-record` 布局，`invalidRecords: 'backup-and-skip'`）加一条凭据记录，没有新数据库，也不用新装任何东西——`base` bundle 已经挂了整套存储栈（`storage` + `storage-json` 落在 `$DSH_HOME/storages` + `storage-domain`），数据落在 `$DSH_HOME/storages/bilibili/{items,cursors}/*.json`。

几个必须知道的移植细节：

- **记录键必须路径安全。** `per-record` 布局把键当路径段，只接受 `[a-zA-Z0-9_-]+`，而 yorha 的 `source_id` 形如 `history:archive:123:0:1700000000`，带冒号。所以键取 `sha256(sourceId)` 的十六进制，`sourceId` 放在值里，仍然可读可搜。
- **没有事务，也没有锁。** 条目写入与游标推进是两次独立提交，中间崩溃会让游标落后于数据。这个方向是安全的：下一次重取同样的页，已入库的条目按内容字段（标题、正文、参与者、元数据）比对后全部去重成空操作，既不会丢也不会重复。这也是不需要 workspace 那套 `pendingMutation` 恢复标记的原因。
- **写入不做 schema 校验。** 校验只在 open 时（durable read boundary）发生，所以每次 `put` 之前由插件自己校验；脏记录会让下一次 open 整个 domain 失败，除非声明 `invalidRecords: 'backup-and-skip'`（已声明）。
- **并发是进程内的。** 存储层只保证单次写入原子且持久，不保证整个同步串行，也没有跨进程互斥。插件用一条自己的 promise 链把同步串起来，第二个并发同步被拒绝而不是排队。

## 搜索

搜索是在内存里对全部条目做一次扫描，匹配标题、正文、作者、上游字段（所以按 BV 号、UP 主、标题里的词都能搜到），支持数据集与时间范围过滤，按上游时间倒序。

代价要说清楚：domain 层在 open 时把全部记录读进内存并逐条校验，**没有二级索引、没有全文索引、没有排序权重**。个人量级（几千到几万条）下扫描是毫秒级的，启动校验则随条目数线性增长；这是这个方案的实际上限。

`contentKey`（yorha 的 `content_key`）被保留下来：同一支视频看了两次、或者同一个 UP 主关注时间变过，`sourceId` 不同但 `contentKey` 相同，模型据此能认出"这是同一个东西"。

## 扫码登录

登录由 **Host 侧**完整驱动：申请二维码、定时轮询、校验会话、写入凭据记录。浏览器半边只拿到要渲染的 URL 和状态，**任何 cookie 都不会跨到浏览器**。页面中途关掉也不会中断或污染这次登录。

二维码由 Host 用自带的编码器（`src/qr.js`，字节模式 / 纠错等级 M / 版本 1–10 自动选版）编成 SVG data URL 交给页面。插件不带第三方二维码库。

## 插件页

左侧栏「插件」里选中哔哩哔哩这个 bundle，配置就在它详情页的描述下面、「包含的组件」之前；标题、版本与描述由插件页自己画（取自本包的 `locale/*.json` 元信息），页面本身三块内容：

- **账号**：登录状态、扫码登录（含二维码与状态轮询）、退出登录。
- **数据**：上次抓取时间、过期与限流提示、逐数据集条目数与快照完整度、"立即抓取"与"补历史"。
- **自动抓取**：定时任务的当前状态，以及"建立 / 重新建立"。

### 这个页面是怎么和 Host 说话的

一个装在 profile 里的插件**无法自建 Remote namespace**——客户端的 namespace 是编译进 Web 应用的一张固定表。所以这里走的是 Harness 自己的连接通道：Host 用 `ctx.connection.fetch.register` 在 `/api/plugin-bilibili` 注册一条 fetch 路由，浏览器半边用 `fetch(new URL('api/plugin-bilibili', document.baseURI))` 调用。

注册必须用 `ctx.inject(['connection'], ...)` 等这个服务出现，**不能**在 `apply` 里直接 `ctx.get('connection')`：Connection 是在 Loader 结算兄弟行时才挂载的（它自己要先 await `BrowserAuth.create`），一次性读取会读空并静默丢掉路由，而页面只会看到一个 404。这条路由挂在 `/api` 前缀下，意味着 Harness 的 Host/Origin 围栏与浏览器鉴权**在到达处理函数之前已经跑过**，插件自己不加鉴权，也不能把它挂到这条通道之外。

### 定时任务的两个硬约束

`ctx.schedule` 的 `create` **没有 Remote 方法**（只有 `catalog`/`list`/`update`/`delete`/`history`），所以浏览器无法创建任务，只有 Host 进程内的代码可以；而且每个任务都**绑定一个 Session**，不存在 profile 级任务。派生的结果是：

- 任务由 Host 侧创建：助手通过 `bilibili_schedule` 工具绑定**当前会话**创建；页面上的"建立/重新建立"则由 Host 解析会话后创建，页面自己做不到。
- 任务在「自动化任务」列表里靠 **标题**（`Bilibili 数据同步`）辨认——记录里没有 owner/source 字段，而且标题和提示词用户都能改，所以存在性判定是"提示词里的稳定标记，或标题匹配"，并且**每次都是重新读 catalog**，不缓存。
- 到点投递是**一次真实的模型回合**（会唤起绑定的会话，即使它已经关闭），不是回调。所以任务提示词写的是"调用 `bilibili_sync` 并汇总新增"。
- 在「自动化任务」里删掉任务后不会自动恢复，这正是页面要提供"重新建立"的原因。

## 失败怎么返回

参数校验失败会抛错；运行期的失败返回封闭错误码，模型据此决定重试时机。工具层面：`credential_unavailable`、`auth_required`、`risk_control`、`rate_limited`、`wbi_signature_failed`、`api_<code>`、`network_error`、`upstream_5xx`、`http_<status>`、`invalid_json`、`invalid_envelope`，以及游标状态机自己的 `history_cursor_stalled`、`history_backfill_cursor_stalled`、`dynamic_cursor_stalled`。

触发风控会按连续次数退避 6 / 24 / 72 小时，`429` 按 `Retry-After` 退避；退避期间同步被跳过并说明原因，而不是反复撞墙。这些状态只存在于本机存储里。

## 已知边界

- 上游接口是 B 站自己决定的，字段与可用性随时会变；这里只读白名单内的七个路径，不发帖、不点赞、不关注。
- `history` 是**有损**数据源（B 站只服务最近窗口），所以补历史靠 `backfill` 一点点向前走；其余四个数据集随时可重取完整快照。
- 收藏与关注的抓取有单次页数上限，未走完时游标会把下次续上，`snapshotComplete` 为 `false` 表示这次只是有界快照。
- 凭据明文存在 `$DSH_HOME/.credentials.yaml`（0600，无加密，也没有 OS keychain provider）。同机同用户的其他进程可以读到，这一点由凭据 seam 决定，不是本插件能改善的。
- 定时任务绑定到会话：那个会话被归档（并选择停止活动）时会一并删除任务。
- `/api/plugin-bilibili` 是**本机 HTTP 接口**：Harness 的围栏挡的是跨站请求，挡不住同机其他进程。它不返回 cookie，能被触发的只有"同步一次""退出登录""重建任务"这类动作。

## 开发时怎么验

`index.js` 与 `src/` 是纯 ESM，可以直接 `node --check` 或 import。`tests/verify-behavior.mjs` 从本目录运行；先 `pnpm install`，它从 devDependencies 里的 `@deepseek-ai/dsh-tools` 取 `assertSupportedJsonSchema` / `validateJsonSchemaValue`：

```sh
node tests/verify-behavior.mjs  # 离线：domain 提交与去重、搜索、工具输出 schema、桥分发、二维码结构
```

脚本用本地伪上游与临时目录覆盖抓取、检索、页面动作和登录态，不读真实账号。需要真实登录态的联网校验已移除。

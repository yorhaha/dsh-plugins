# dsh-outlook

给 DeepSeek Harness 用的 Outlook 邮件插件。邮件抓取到本机 SQLite 语料库，供助手按时间与文本检索。

界面名是「Outlook 邮件」/「Outlook Mail」；包名、行 id、凭据 scope 与库文件统一用 `outlook`，与「只读 Outlook」的定位一致。

邮件抓取移植自 yorha 的 `core/yorha/connectors/{graph,mail}.py`，保留了它的设备代码流登录、`Prefer` 头约定、Graph 重试语义与时间戳游标；**持久化层换掉了**——不再依赖 Postgres，改用 `node:sqlite`（Node 内置）自持一个数据库文件。

日历不在这个插件的范围内：`Calendars.Read` 不请求，语料库里也不存日程。generation 3 的 schema 会把旧库里已抓到的日历行一并删掉。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `outlook_sync` | `backfill`（可选） | 后台任务 id 与本轮页数/写入/未变/删除计数 |
| `outlook_search` | `query`、`since`、`until`、`from`、`limit`、`offset` | 匹配总数与本页条目，附数据新鲜度 |
| `outlook_item` | `id`（必填，搜索返回的 id） | 单条完整记录（含正文） |
| `outlook_schedule` | `recreate`（可选） | 定时抓取任务的建立/重建结果 |

前三个工具只读本机语料库，`outlook_schedule` 只动本插件的定时任务；插件不向账号写入任何内容。

抓取受 Microsoft 限流，因此 `outlook_sync` **不在工具调用里同步等待**：它用 `ctx.jobs` 起一个后台任务并立刻返回 id，模型用 `job_output` 收结果。没有 job registry 的组装会退化为同步执行。

`outlook_search` 的结果里始终带一个 `sync` 块（`lastRunAt` / `stale` / `running` / `configured` / `authRequired`），所以"上次同步超过一天""还没登录"这些事出现在模型正在看的地方，而不是要求它额外查一次状态。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/outlook
```

或者让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。装完后 profile 会多出 `id: outlook` 这一行。

这个包**有依赖**：`@azure/msal-node`（微软官方的认证库，v7 起是纯 ESM）、`@deepseek-ai/dsh-credentials` 与 `@deepseek-ai/schemastery`，后两个来自 npm 上的 `0.2.1-rc.3` 发布线。**第一次使用前要在插件目录里装一次依赖**：

```sh
cd dsh-plugins/outlook && pnpm install
```

插件目录自带一份 `pnpm-workspace.yaml`（`packages: ["."]`），用来切断向上查找，使它成为一个独立工程而不是某个 workspace 的成员。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据记录槽位，取值须匹配 `^[a-z][a-z0-9-]*$`；一个账号一个槽位 |
| `clientId` | 空 | Azure 应用注册的客户端 id（公共客户端 + 设备代码流）；首次使用需自行注册并填入，**可热改**，在插件页的 Outlook 邮件行里编辑（须是 GUID） |
| `tenant` | `consumers` | 授权租户；个人账号用 `consumers`，工作和个人都要用 `common`；**可热改** |
| `scopes` | `Mail.Read` | 委托权限；`offline_access` 由登录库自动附加。改动这个列表后需要重新登录一次以同意新权限 |
| `databasePath` | `$DSH_HOME/storages/outlook/outlook.db` | 语料库文件；一个账号一个库 |
| `scheduleCron` | `0 9 * * *` | 定时抓取的 5 段 cron 表达式，按宿主时区求值 |
| `mailInitialDays` | `90` | 首次抓取回看的天数；`0` 表示全量。更早的邮件按需 `backfill` |
| `mailExcludeFolders` | `['junkemail']` | 抓取时不入库的文件夹：先按 Graph well-known 别名（`junkemail`、`deleteditems`……）解析，解析不到再按顶层文件夹显示名匹配；空数组表示每个文件夹都抓 |
| `reconcileDays` | `3` | 每次抓取在游标之前回扫的天数，用来吸收已读状态与文件夹移动 |
| `mailMaxPages` | `60` | 单次向前抓取的页数上限，未走完时游标下次续上 |
| `backfillMaxPages` | `20` | 单次 `backfill` 向前走的页数上限 |
| `bodyMaxBytes` | `262144` | 单条记录入库与建索引的正文上限 |
| `requestTimeoutMs` | `30000` | 单次 Graph 请求的截止时间；超时按网络失败重试，避免一条卡住的连接拖住抓取和卸载 |
| `timeZone` | 宿主时区 | 搜索里 `since`/`until` 的纯日期与不带偏移的日期时间按哪个 IANA 时区解释 |
| `loginTimeoutSeconds` | `300` | 设备代码的有效期，最小 30 |

配置在加载阶段校验：空路径、只有保留 scope 的权限表、写错的时区名或不是 5 段的 cron 都会直接报错，而不是悄悄用默认值。

## 持久化：为什么是一个 SQLite 文件

`storageDomain` 那条路是**内存权威**的：open 时把全部记录读进内存并逐条按 schema 校验（bilibili 的 README 写明了这个上限）。邮件语料是几万条、正文以 KB 计的数据，走那条路会把启动时间与内存都拖垮；后端换成 SQLite 也不改变这一点，因为 domain 层仍然全量载入。

所以这里自持一个数据库，用的是 Node 自带的 `node:sqlite`（**不新增驱动依赖**，仓库里 `session-query-sqlite` 是同样的先例）。`src/schema.js` 的 `SCHEMA_VERSION` 单调递增，写在 SQLite 自己的 `PRAGMA user_version` 上；旧库在打开时**就地迁移**，比本版本更新的库会被拒绝打开，而不是按错误的含义去读。

当前 generation 是 3，**纯邮件**：主键就是 Graph message id，没有 `dataset`、也没有事件结束时间 `ts_end`，`cursors` 表收成 `mail_state` 单例。generation 1 与 2 的库都**一次改写**到 3——两代的行都按 `(dataset, source_id)` 存着，改写时只保留 `dataset = 'mail'` 的行、用它重建 FTS 索引，**日历行随之删除**；generation 2 曾把 `dataset:source_id` 当主键、generation 1 用的是它的哈希，这两个键都不再需要。

四张表：

| 表 | 作用 |
| --- | --- |
| `items` | 去重后的邮件，键是 Graph message id |
| `items_fts` | FTS5 全文索引，与 `items` 用 `rowid` 对齐；只存分词后的 title/body/participants |
| `mail_state` | 单例：邮件增量游标、上次成功时间/错误码、条目数、是否走完首轮 |
| `status` | 单例：上次抓取时间/状态/错误码、是否需要重新登录、退避截止时间 |

**写入是事务性的**：一次抓取先在网络上收集全部记录，然后 `BEGIN IMMEDIATE` 里写条目、写删除、推进游标、提交。这比"没有事务、崩溃后靠幂等重取"更强——条目与游标要么一起前进，要么都不动。

**单进程独占**：SQLite 允许多进程打开（WAL + `busy_timeout`），但这个插件假设一个 profile 只有一个 Host 在跑。

**文件权限**：库以 `0600` 创建；已存在的库在打开时收紧一次，`-wal`/`-shm` 继承同一权限——语料里是邮件正文，不该让同机其他用户读到。

## 搜索

FTS5 的 `unicode61` 分词器会把一整串中文当成**一个** token（"产品评审会议的时间安排"搜不到），而 `trigram` 虽然能做子串匹配，却要求查询至少 3 个字符、索引膨胀 3–4 倍。所以入库与检索时把 CJK **逐字切开**：索引里存 `产 品 评 审 会 议`，查询 `会议` 翻译成短语 `"会 议"`，于是任意长度的中文子串都能走索引。拉丁词保持整词语义（`review` 能搜到，`eview` 搜不到——后者是子串，不是词）。查询里的 FTS 语法字符会被当作数据丢弃，模型传什么都进不了 FTS5 的语法层。

摘要片段取自**入库的原文**而不是索引里的切分文本，所以模型读到的是发件人写的样子。

时间窗 `since`/`until` 收 ISO-8601 日期或日期时间：**纯日期表示该时区的当地午夜**（`timeZone`，默认宿主时区），不带偏移的日期时间也在那个时区里读，带 `Z` 或偏移的值按字面照收。语料库存的是 UTC 瞬时，所以"今天"这类本地一天必须在这里换算成瞬时再比较；把纯日期当成 UTC 午夜，东八区的"今天"会从当地 08:00 才开始。

代价说清楚：`items_fts` 是独立 FTS5 表，正文会存两份（原文一份、切分索引一份）。5 万封 × 平均 3 KB 正文大约 250–400 MB。`bodyMaxBytes` 控制单条上限。

## 设备代码登录

登录由 **Host 侧**完整驱动：申请设备代码、轮询令牌端点、把令牌缓存写进凭据记录。浏览器半边只拿到要渲染的网址和用户码，**任何令牌都不会跨到浏览器**。页面中途关掉也不会中断或污染这次登录。

- 令牌缓存是 MSAL 序列化出来的 JSON，作为 `outlook/<accountId>` 凭据记录的 `payload.cache` 原样保存；凭据 seam 不解释它。插件页上「这份登录实际获得的权限」是唯一读它的地方：它把缓存里各 access token 的 `target` 合并去重，因为账号块不含权限列表，而配置里的 `scopes` 只说"下次登录会申请什么"。
- 重新登录**从空缓存开始**，成功后整体替换旧缓存——半途而废的尝试不会留下两个账号的混合体。
- 退出登录只删本地记录，不撤销微软账号侧的授权。

## 抓取

- **邮件**走时间戳游标。个人微软账号**不支持** `/me/messages/delta`（会返回 400「Change tracking is not supported」），yorha 已经踩过；所以首次取 `mailInitialDays` 天，之后按 `receivedDateTime ge 游标 − reconcileDays` 增量拉取，`backfill` 用 `receivedDateTime lt 最旧` 向前走。请求带 `Prefer: IdType="ImmutableId"`，邮件在文件夹之间移动时 id 保持稳定，不会被当成新邮件。
- **垃圾邮件不入库**。`/me/messages` 返回的是整个邮箱的邮件，Outlook 自己判定成垃圾的同样在里面；`mailExcludeFolders` 里的文件夹在这次抓取里按 id 跳过，同一次提交还删掉此前已入库的同文件夹记录，所以把一个文件夹加进列表对旧语料也生效。名字先按 Graph 的 well-known 别名解析（`junkemail`、`deleteditems`、`drafts`……），解析不到再比顶层文件夹的显示名（中文账号里就是「垃圾邮件」这种名字）；两边都对不上会让这次抓取以 `invalid_settings` 失败，而不是把整个文件夹默默抓进来。按名字匹配的是**文件夹本身**，它下面的子文件夹不受影响。
- 429/503/504 按 `Retry-After` 有界重试（4 次、封顶 60s），限流后写 `retryNotBefore`。定时任务在退避窗口内、或上次被拒了登录时直接跳过并说明原因，手动触发仍可强行重试。

## 插件页

左侧栏「插件」面板里选中「Outlook 邮件」这个 bundle，配置就在它详情页的描述下面、「包含的组件」之前，三块内容：

- **账号**：Azure 应用注册（客户端 id / 租户，走 Harness 共享的设置表单：改完点保存才写入，热更新生效）、登录状态与账号身份、设备代码登录（网址链接 + 用户码 + 复制 + 状态轮询 + 取消）、退出登录，以及这份登录**实际获得**的权限。
- **数据**：上次抓取时间与状态、邮件条数与首轮是否走完、库文件路径与大小、过期与限流提示、"立即抓取"与"补历史"。
- **自动抓取**：定时任务的当前状态，以及"建立 / 重新建立"。

页面注册在 `plugins.bundle.config` 上，key 是包名（`dsh-outlook`）：标题、版本与描述由插件页自己画（取自本包的 `locale/*.json` 元信息），所以页面只渲染这几张卡片。

### 这个页面是怎么和 Host 说话的

两个热字段（`clientId`、`tenant`）不经过本插件的路由：它们由 `ctx.configForms` 提供的共享表单读写，写入最终落到 profile 的 patch 里，形状校验在 Config schema（`.pattern()`）里，浏览器半边再镜像一份同样的检查，好让输错时就地报错而不是只报"保存失败"。

其余部分（状态、登录、抓取、已授权限）走 Harness 自己的连接通道：一个装在 profile 里的插件**无法自建 Remote namespace**——客户端的 namespace 是编译进 Web 应用的一张固定表。所以 Host 用 `ctx.connection.fetch.register` 在 `/api/plugin-outlook` 注册一条 fetch 路由，浏览器半边用 `fetch(new URL('api/plugin-outlook', document.baseURI))` 调用。这条路由挂在 `/api` 前缀下，意味着 Harness 的 Host/Origin 围栏与浏览器鉴权**在到达处理函数之前已经跑过**，插件自己不加鉴权，也不能把它挂到这条通道之外。

### 定时任务的两个硬约束

`ctx.schedule` 的 `create` **没有 Remote 方法**（只有 `catalog`/`list`/`update`/`delete`/`history`），所以浏览器无法创建任务，只有 Host 进程内的代码可以；而且每个任务都**绑定一个 Session**，不存在 profile 级任务。派生的结果是：

- 任务由 Host 侧创建：助手通过 `outlook_schedule` 工具绑定**当前会话**创建；页面上的"建立/重新建立"则由 Host 解析会话后创建，页面自己做不到。
- 任务在「自动化任务」列表里靠提示词里的稳定标记辨认，标题只作后备（新建的是 `Outlook sync`，更早的仍是 `Microsoft Graph sync`）；而且**每次都是重新读 catalog**，不缓存。
- 到点投递是**一次真实的模型回合**（会唤起绑定的会话，即使它已经关闭），所以任务提示词写的是"调用 `outlook_sync` 并汇总新增"。
- 在「自动化任务」里删掉任务后不会自动恢复，这正是页面要提供"重新建立"的原因。

## 失败怎么返回

参数校验失败会抛错；运行期的失败返回封闭错误码，模型据此决定重试时机：`not_configured`、`credential_unavailable`、`auth_required`、`token_failed`、`rate_limited`、`network_error`、`upstream_5xx`、`http_<status>`、`invalid_json`、`invalid_envelope`、`invalid_settings`、`cancelled`。Graph 自己解释的 4xx 原文只出现在 `http_<status>` 上。

## 已知边界

- 上游接口由微软决定，字段与可用性随时会变。插件只读 `/me/messages` 与 `/me/mailFolders`，不发信、不改日程、不写账号里的任何内容。
- **附件只记 `hasAttachments`**，不下载附件内容；正文不含附件正文。
- 邮件的删除在本地是**看不见**的：时间戳游标只会被"收到得更晚"的邮件推动，一封被删除的邮件会留在语料里，直到 `backfill` 覆盖到或手动清理。
- 凭据缓存明文存在 `$DSH_HOME/.credentials.yaml`（0600，无加密，也没有 OS keychain provider）。
- 定时任务绑定到会话：那个会话被归档（并选择停止活动）时会一并删除任务。
- `/api/plugin-outlook` 是**本机 HTTP 接口**：Harness 的围栏挡的是跨站请求，挡不住同机其他进程。它不返回令牌，它能触发的只有"同步一次""退出登录""重建定时任务"，外加一次只读的"已授权限"查询。

## 开发时怎么验

`index.js` 与 `src/` 是纯 ESM，可以直接 `node --check` 或 import。`tests/verify-behavior.mjs` 从本目录运行；先 `pnpm install`，它从 devDependencies 里的 `@deepseek-ai/dsh-tools` 取 `assertSupportedJsonSchema` / `validateJsonSchemaValue`：

```sh
node tests/verify-behavior.mjs  # 离线：建表与去重、中英文检索、搜索边界时区、Graph 重试与分页、游标与退避、排除文件夹、已授权限解析、工具输出 schema、设置桥、配置校验、旧库迁移
```

脚本用本地伪 Graph 与临时 SQLite 覆盖登录、抓取、检索和设置桥，不读真实邮箱。需要 Azure 应用注册的联网校验已移除。

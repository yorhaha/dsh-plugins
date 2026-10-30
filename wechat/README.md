# dsh-wechat

给 DeepSeek Harness 用的微信导出批次插件。它把本机微信导出器写出的批次（每个会话一个 JSONL + 根目录 `export_meta.json`）导入成本机 SQLite 语料，向助手开放跨会话、跨时间的检索，并提供一个报告流水线状态、就地导入批次的插件页（左侧栏「插件」里选中它，配置就在详情页描述下面）。

移植自 yorha 的 `core/yorha/connectors/wechat`（D-007 / D-018）：批次契约、严格校验、两套身份策略、只读状态探测与信号词表都保留；**持久化层换了**（不再依赖 Postgres 与 raw 对象库），`runs` 表、物化联系人索引、联系人画像，以及 yorha Web 那套「驱动导出器」（`export → rename → import`）没有移植——后者见 §后续。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `wechat_batches` | — | 归档里的批次、各自状态与计数，附数据新鲜度 |
| `wechat_import` | `batch` / `source`（路径或 `latest`）、`includeGroups`、`copy` | 导入结果；超过阈值时是后台任务 id |
| `wechat_search` | `query`、`chat`、`kind`、`direction`、`sender`、`since`、`until`、`limit`、`offset` | 匹配总数与本页消息，附数据新鲜度 |
| `wechat_item` | `id`（必填，搜索返回的 id） | 单条完整记录，图片给绝对路径 |
| `wechat_chats` | `chat`、`since`、`until`、`limit` | 每个会话的消息数、文本数、活跃天数、首末时间 |
| `wechat_status` | — | 五段只读探测 + 信号 + 主状态 |
| `wechat_schedule` | `recreate` | 在 Automation tasks 列表里建立/恢复「定期导出并导入」任务；返回任务 id 与下次运行时间 |

导入是几秒到几十秒的解析与写入，所以超过 `inlineImportLimit`（默认 5000 条）的批次走 `ctx.jobs` 后台任务并立刻返回 id，模型用 `job_output` 收结果；没有 job registry 的组装退化为同步执行。

`wechat_schedule` 把「定期导出并导入」放进 Harness 的 Automation tasks 列表：任务属于创建它的那个会话，到点会回到那个会话说一句话，由助手去跑导出、再调 `wechat_import` 导入。默认每周一 09:00（`scheduleCron`）导出最近 7 天（`scheduleExportDays`）。任务记录里没有 owner 字段，所以它靠 prompt 里的固定标记 `[dsh-wechat:auto-import]`（其次看标题「微信数据导入」）认领——**你自己用 Harness 的定时任务手建一个带这个标记的任务也一样会被认领**，不会被重复创建；`recreate: true` 会删掉旧的再建一个新的（改了配置里的路径或 cron 之后用它刷新）。组合里没挂 schedule 服务时返回 `unavailable`，不会报错。插件页也有同一件事：**「定时导入」卡片**显示任务是否在跑、下次运行时间，任务不存在时给「建立任务」、存在时给「重建任务」，不用再让助手调工具。页面拿不到会话 id，Host 按「最近一个会话」绑定任务（与工具语义一致）。

`wechat_search` 的结果始终带一个 `state` 块（`lastImportedAt` / `pendingBatches` / `databaseNewerThanImport` / `importFailed`），所以「有批次没导」「微信库比上次导入新」出现在模型正在看的地方，而不是要求它额外查一次状态。这个块不扫消息表：它只读一行 meta、WeChat 自己的文件时间，以及批次目录。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/wechat
```

或者在工作区里让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。装完后 profile 的 `cordis.patch.yml` 会多出一行 `id: wechat`。

这个包有一个依赖（`@deepseek-ai/schemastery`，npm 上的 `~3.18.5`），所以**第一次使用前要在插件目录里装一次依赖**：

```sh
cd dsh-plugins/wechat && pnpm install
```

插件目录自带一份 `pnpm-workspace.yaml`（`packages: ["."]`），用来切断向上查找，使它成为一个独立工程而不进入仓库的 workspace——`dsh-plugins/*` 不是 workspace 成员，仓库的各类 gate 也不会扫到它。

## 配置

`config` 里的每一项都可以从 cordis.yml 覆盖；插件自带的 `cordis.patch.yml` 已经把本机可用的默认值写好。配置在加载阶段校验：相对路径、未知时区、非整数阈值都会直接让加载失败，而不是悄悄退回默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `exporterDir` | 空 | 导出器根目录；留空则关闭 `latest` 发现，`exportDir` 与 `keysFile` 也随之为空 |
| `exportDir` | `<exporterDir>/data` | `source: latest` 的发现目录，也是状态探测「最近导出」的来源 |
| `keysFile` | `<exporterDir>/meta/wechat-keys.json` | 只读字段名，绝不读值 |
| `wechatDbParent` | 微信容器目录 | `*/db_storage` 的发现父目录 |
| `wechatDbDir` | 空 | 显式指定 `db_storage`；父目录下有多个账号时需要 |
| `batchesDir` | `$DSH_HOME/wechat/batches` | 批次归档根；批次就地导入，导入后不删除 |
| `databasePath` | `$DSH_HOME/wechat/wechat.db` | SQLite 语料 |
| `defaultIncludeGroups` | `false` | 不传 `includeGroups` 时的默认范围 |
| `inlineImportLimit` | `5000` | 超过这个条数就走后台任务 |
| `localTimeZone` | 宿主时区 | 解释无偏移的导出时间与纯日期检索边界 |
| `scheduleCron` | `0 9 * * 1` | `wechat_schedule` 建的任务何时跑（五段 cron，按 `localTimeZone` 求值） |
| `scheduleExportDays` | `7` | 该任务每次导出多少天历史 |

## 标准流程

导出器是**另一个项目**（本机在 `exporterDir`，即 `/path/to/wechat-exporter`），必须跑在登录着微信客户端的机器上。它自带 `.venv`，系统 `python3` 没有 `pycryptodome` / `zstandard`，所以要用 `.venv/bin/python`；密钥只提取一次（`extract_keys.py`，需要 Frida），之后 `meta/wechat-keys.json` 一直在。

```sh
cd /绝对路径/wechat                                    # exporterDir
.venv/bin/python export.py --list                      # 先看有哪些联系人和群
.venv/bin/python export.py --format jsonl --days 3 \
  --output-dir ~/.dsh/wechat/batches/wechat-$(date +%Y%m%d-%H%M)
```

| 参数 | 说明 |
| --- | --- |
| `--days N` / `-d N` | 最近 N 天，默认 **3**；`--days 0` 是全部历史 |
| `--start` / `--end` | `YYYY-MM-DD`，与 `--days` 互斥（给了日期就用日期） |
| `--chats` / `--contacts` | 只导指定群 / 联系人，逗号分隔，名字与 `--list` 输出一致 |
| `--format jsonl\|text\|both` | 默认 **`text`**，而 `text` 会在写完 txt 后**删掉 JSONL**——要导入必须写 `jsonl`（或 `both`） |
| `--output-dir` / `-o` | 输出目录；不给就是当前目录下的 `data/` |
| `--include-images` | 只对群聊生效，导出图片并 OCR，需要 PaddleOCR |
| `--list` | 只列出所有群聊和联系人，不导出 |

输出布局：每个会话一个 `<会话名>.jsonl`，群聊另有一个 `<会话名>/` 目录（按天拆的 txt、`_voice_map.json`、图片），`export_meta.json` **最后写**——所以「目录里有 `export_meta.json`」就是「这个批次写完了」的判据，写到一半的目录不会被导入，只会被报成 `incomplete`。批次导入后就地保留：目录本身就是原始记录，重跑同一次导入是幂等的空操作。

**三点使用注意**：

1. **`--format jsonl` 是硬要求。** 默认的 `text` 会删掉 JSONL，留下一个「完整但读不出消息」的目录：这种目录不会成为 `source: "latest"` 选中的对象，状态探测会把它单独计数并给出 `text_only_export` 信号（插件页也会写明），归档里遇到它则直接标成 `invalid`。
2. **`-o` 指到 `batchesDir`（`~/.dsh/wechat/batches/<名字>`）最省事**：批次出生就在归档里，导入后不再移动。不指也行，那批次就在导出器的 `data/` 下——`source: "latest"` 或绝对路径都能导入，只是不在归档里（工具会提示 `outsideArchive`，下次导出覆盖同一目录后再导入会被 `batch_changed` 拒绝）。想让外部批次进归档，用 `copy: true`。若最新导出的名字与归档里已有批次同名，`latest` 会报 `batch_exists`，不会悄悄导入归档里的旧内容。
3. **群聊是真实批次的大头**（真实批次里群聊通常占多数），默认只导私聊；要群聊得显式 `includeGroups`。

导入的两条路：插件页对**归档里的**批次点「导入 / 含群聊」；或者让助手调 `wechat_import`（`batch: "<归档目录名>"`、`source: "latest"`、或一个绝对路径）。

### 增量导入

窗口与已有语料重叠是**免费**的：同一条消息的内容哈希没变，导入就一个字段都不动（不刷新 `last_seen_at`，不重算聚合）。所以宁可把窗口开大一点，也不要有缝——漏掉的那段只能靠再导一次补，而重复的那段不花代价。

```sh
cd /path/to/wechat-exporter
.venv/bin/python export.py --format jsonl --days 7 \
  --output-dir ~/.dsh/wechat/batches/wechat-$(date +%Y%m%d-%H%M%S)
```

**每次都要换一个新目录名。** 同一个目录被重新导出之后，它的内容与导入时记录的不一致，再导入会被 `batch_changed` 拦下——这是刻意的，否则半个新批次会悄悄混进语料。名字带秒就够了，同一秒跑两次的概率可以忽略。

然后导入：插件页点那个待导入批次的「导入」，或者让助手 `wechat_batches` → `wechat_import { batch }`。助手自己就能跑导出命令（它有 shell），所以一句话「导出最近一周并导入」它能一次做完；如果会话的 shell 被限制在工作区内、碰不到微信容器目录，那就你跑导出、它只做导入。

耗时参考：

| 步骤 | 规模 | 耗时 |
| --- | --- | --- |
| 导出 `--days 1` | 数百条 / 数个会话 | 约 1 分钟 |
| 导入（只私聊） | 百余条私聊，多数新增，少量与已有语料重合 | 亚秒级 |

导出器每次都要解密并扫描**全部**消息分片，所以 `--days 1` 和 `--days 0` 的耗时差不多（本机约 1 分钟）；随窗口变化的只有导入这一步。归档会随每次导出增长（一天约几 MB，全历史批次数百 MB）；删掉旧的归档目录是安全的——目录不在了，批次行还在但列表会跳过它，语料本身不受影响。

## 持久化：yorha 那套 Postgres 依赖去哪了

| yorha | 这里 | 说明 |
| --- | --- | --- |
| `items` 表 + `items_wechat_chat_ts_idx` | SQLite `items` 表 + `(chat_id, ts_unix DESC)` 索引 | 一个会话一个事务，整批先校验后写入 |
| `contacts` 派生索引（D-020） | `chats` 表 | 同样是从消息派生、可重建；导入结束时只刷新被写入的会话 |
| `contact_profiles`（模型生成画像） | 无 | 助手自己就能做：`wechat_chats` → `wechat_search` → `wechat_item`；画像没有移植，连它的缓存键也没有保留 |
| `raw/wechat/objects/<sha256>` | 不复制 | 批次留在 `batchesDir`，媒体按 `sha256` + 批次内相对路径引用；省掉 yorha 那份上万对象 / 数百 MB 的第二份字节 |
| `raw/wechat/manifests/<import_id>.json`（0444） | `batches` 表一行 | 只保留读得回来的事实：目录、导出时间、消息数、计数、`source_files_hash`；`export_meta` 的其余内容留在批次目录里，不再抄进库；也不逐文件存清单（全历史批次有上万个文件） |
| `source_state` 游标 | `batches` 行 + `meta` 表 | 最近一次导入结果与最近错误码 |
| `runs` 表 | 无 | session log 与 `ctx.jobs` 已经是留痕 |
| `source_lock` 咨询锁 | 进程内串行 + `import.lock` | 锁文件带 pid，持有进程已死时自动回收 |
| CLI `--status` | `wechat_status` 工具 + 插件页 | 分段与信号词表基本原样保留 |

语料文件按 `0600` 打开：新建时以此权限创建，已存在的库在打开时收紧一次，`-wal`/`-shm` 继承同一权限——里面是私聊原文，不该让同机其他用户读到。

三处**刻意的语义差异**：

1. **`content_hash` 只覆盖内容与媒体身份**（规范化 JSON、`ensure_ascii=False`），不含本地路径。yorha 把 `object_path` 也算进去；路径由 sha 派生所以结论一样，但排除路径后，「同一张图出现在另一个批次」不会读成内容变化。
2. **不再逐文件存清单**。yorha 靠 manifest 的完整 `source_files[]` 判断「同一 import_id 是否被不同内容占用」；这里用 `source_files_hash`（排序后的 `path\0sha256\0size` 取 sha256）+ 文件数 + 字节数，判断能力等价。
3. **批次行是可替换的当前状态，不是一次性 manifest**：先只导私聊、之后 `includeGroups: true` 重导会补齐群聊并把计数刷新，`state` 从 `partial` 变 `imported`。整批校验仍在第一次写入之前完成（yorha 的「整批解析成功才写」不变），但写入按会话提交：把数百 MB 的解析包在一个事务里会让所有读都被挡住，而重跑本身是幂等收敛的。

## 检索语义

`query` 是**大小写不敏感的子串**（ASCII 折叠；中文不受影响），匹配消息正文、会话名、发送者名字与 id、上游字段（含 quote/OCR/语音转录）、以及消息 id 本身——所以人名、短语、号码、微信号、id 都能直接搜。

用子串而不是分词，是因为中文没有可依赖的词边界：本仓库 `session-query-sqlite` 的 FTS5 用的是 `unicode61`，实测（Node 22 / SQLite 3.50）「今天天气不错…」搜「天气」命中 0，`trigram` 又要求至少 3 个字，搜「天气」同样 0。

性能取舍（本机实测，800k 条合成消息）：

| 查询 | 耗时 |
| --- | --- |
| 写入 800k 条（分块事务） | 16.3 s |
| 全量重建 `chats` 派生表 | 1.7 s |
| 会话限定（`chats` 表解析名字 → `chat_id IN (…)` + `(chat_id, ts_unix)` 索引） | 2 ms |
| 全语料子串扫描、有命中 | 0.25 s |
| 全语料子串扫描、无命中（计数与取页各扫一遍） | 1.0 s |
| 深翻页（`offset` 40 万） | 0.27 s |

同一查询用 `instr(lower(col))` 写要慢一个数量级，所以用 `LIKE`：SQLite 的 `lower()` 只折 ASCII，两者语义相同。分页查询单独发一条 `COUNT(*)`，而不是在取页的语句里用 `COUNT(*) OVER ()`——后者会把全部命中物化出来，800k 行时实测 2.3 s。

会话名过滤先经过 `chats` 表解析成 id 再去消息表，所以「按人名搜」不会退化成全表扫描——这是把 yorha 的 `contacts` 索引保留下来的直接理由。

## 身份与幂等

导出器目前**不往 JSONL 里写 `local_id`**（实测现有真实记录都没有），所以主路径是退化键：

- 有 `local_id` 时：`local:<sha256(chat_id, local_id)>`。
- 没有时：`fallback_base = sha256(chat_id, timestamp, sender_id, msg_type)` 与内容指纹一起构成 `fallback:<…>`，同一会话内完全相同的记录按文件顺序附上从 0 开始的重复序号并全部保留，重复数记进 `batch.collisions`。
- `identity` 不存列：它就是 id 的前缀（`local:` / `fallback:`），读取时现算。同一事实不再在 `items` 的列和 `metadata_json` 里各写一份——`metadata_json` 只留 `source_file`、`source_line`、可选的 `local_id` 和引用字段。
- `batch.suspected_replacements` 数的是**身份丢了、但语料里还留着一条内容完全相同的副本**的消息——重复序号在两次导出之间移动过，同一条消息因此被归档两次（旧副本不会被删除，也从不做模糊合并）。它由一张临时表在第一次写入之前对照旧语料算出。三类近似情况都不计入：普通重导（消息自己的身份仍在语料里）、同一批次自己的重复项（那是 `collisions`）、以及同一秒同一发送者的另一条消息（指纹基相同但内容不同）。
- 这个计数看不见**内容变化**：后补的 OCR / 语音转录会让内容和身份一起变，导入器会多写一条，而两个计数器都不报（旧副本内容不同，所以不算「相同副本」）。要判断某条消息是否被后补过，按会话和时间窗搜一次就能同时看到新旧两条。

`content_hash` 未变化的消息**一个字段都不动**（包括 `last_seen_at`），这正是「同一个窗口重复导出」成为真正空操作的原因。

## 插件页

左侧栏「插件」里选中微信这个 bundle，配置就在它详情页的描述下面、「包含的组件」之前；标题、版本与描述由插件页自己画（取自本包的 `locale/*.json` 元信息）。页面内容：流水线概览（主状态、本机数据库与最近变动、密钥覆盖、最近导出、最近导入、语料库规模）、信号列表、批次表（含「导入」「含群聊」两个按钮）、最近一次导入的结果与进度、以及只读的配置摘要。批次表把导出/导入时间按阅读者所在时区显示成 `YYYY-MM-DD HH:mm`；列宽不够时表格横向滚动，而不是把按钮挤成两行。

页面只显示状态、计数与路径：**不显示消息正文，不下发会话列表，也不显示任何密钥值**。它无法浏览文件系统（插件页没有原生选择器），所以「从任意路径导入」只能走工具；页面只对已经在归档目录里的批次操作。

Host 侧路由是 `/api/plugin-wechat`，走 Harness 自己的 `/api` 认证围栏，插件自己不做鉴权。

## 失败怎么返回

工具与桥都用封闭词表：

`batch_not_found`、`batch_incomplete`（导出器还没写完）、`batch_exists`、`batch_invalid`（校验失败，消息里带文件与行号）、`batch_changed`（同名批次的内容变了）、`unsupported_batch_name`、`source_missing`、`copy_failed`、`busy`（另一处导入持锁）、`cancelled`、`db_unavailable`、`internal_error`；桥另加 `body_too_large`、`invalid_json`、`invalid_body`、`unknown_action`。

校验消息保留原文（它是你自己的批次内容，不是凭据），例如「`Alice.jsonl:1` 缺少字段: content」「JSONL 消息数与 `export_meta.total_messages` 不一致: 3 != 4」。

## 已知边界

- 上游导出器是另一个项目：它决定字段与可用性，也必须跑在登录微信客户端的机器上。这个插件只读批次，不驱动 `export.py`。
- 群聊是真实批次的大头（一个全量批次里群聊通常占多数），所以默认只导私聊；要群聊必须显式 `includeGroups`。
- 全语料子串扫描是 O(n)：有命中约 0.25 s、无命中约 1.0 s @800k 条（见上表），会话限定或时间窗限定降到毫秒级。没有全文索引，因为中文分词在这里只会降低召回。
- 批次目录被手工删除后，条目里的媒体路径失效（消息本身不受影响）；`wechat_item` 会如实报告 `available: false`。
- 语料文件带 schema 版本（当前 generation 2）：generation 1 的文件在打开时就地迁移（去掉重复列、收窄 `metadata_json`、删掉没人读的批次列），不丢消息；比本版本新的文件会被拒绝而不是误读。
- `node:sqlite` 目前仍带 ExperimentalWarning；`outlook` 与 `session-query-sqlite` 也在用同一个驱动。
- 检索到的消息正文会进入会话日志（harness 的 model-visible ⟺ logged 规则），所以导出或共享某个会话就包含微信内容。
- `/api/plugin-wechat` 是**本机 HTTP 接口**：Harness 的围栏挡的是跨站请求，挡不住同机其他进程；它能触发的只有「导入一次」。
- `chats` 派生表由导入结束时刷新。若进程在写入消息与刷新之间被杀，那些会话的聚合会暂时偏旧，重跑同一批次即可修正；`store.rebuildChats()` 是完整重建入口。

## 后续（未做）

插件自己驱动导出器（把 `export.py` 的调用从「助手跑 shell」变成插件内的 `ctx.subprocess`，含超时与错误映射；现在的定时任务是把命令写进 prompt 交给助手执行）、侧栏会话浏览面板、图片内容寻址归档、导入期用 `_voice_map.json` 回填语音转录。

## 开发时怎么验

`index.js` 与 `src/` 是纯 ESM，可以直接 `node --check` 或 import。脚本从本目录运行；先 `pnpm install`，它从 devDependencies 里的 `@deepseek-ai/dsh-tools` 取 `assertSupportedJsonSchema` / `validateJsonSchemaValue`：

```sh
node tests/verify-behavior.mjs   # 离线：配置、时区、导入计数、身份、检索、工具输出 schema、桥、状态分段
```

脚本用临时语料库与合成的导出批次覆盖全部规则，不读本机微信数据。需要本机导出器的联网校验已移除。

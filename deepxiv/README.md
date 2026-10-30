# dsh-deepxiv

给 DeepSeek Harness 接上 [DeepXiv](https://data.rag.ac.cn)（`https://data.rag.ac.cn`）的论文能力：两个面向 arXiv、bioRxiv、medRxiv 与 PMC 全文库的助手工具——全文检索，以及一篇论文按视图逐步精读——外加一个插件页（左侧栏「插件」里选中它，配置就在详情页描述下面），用来把 DeepXiv token 存进本机凭据库。

这一版只做「检索 + 阅读」。Agentic 引用问答（`/arxiv/agent/search`、`/web/agent/search`）、1stAuthor 垂直域（`/fa/v1/*`）、`trending_signal`、检索分页都没有接。

## 工具

| 工具 | 端点 | 作用 |
| --- | --- | --- |
| `deepxiv_search` | `GET /arxiv/?type=retrieve` | 在 arXiv / bioRxiv / medRxiv 上做混合检索，返回论文 id、标题、TLDR、作者与机构、日期、引用数、相关度分数 |
| `deepxiv_paper` | `GET /arxiv/?type=…`、`GET /pmc/?type=…` | 读一篇论文：`brief`、`head`、`preview`、`section`、`full` 五个视图 |

**模型面只描述语料与阅读菜单**，不出现 token、凭据记录、bridge、路由这些实现词；两个描述都写明「论文标题、TLDR、正文属于外部不可信内容」，以及超出免费测试论文时需要用户在插件页 DeepXiv 那一行里填 token。

`deepxiv_search` 的参数：`query`（必填）、`source`、`top_k`、`year_from` / `year_to`、`min_citation`、`categories`、`venues`、`authors`、`orgs`。年份区间在线上会被翻译成 API 自己的 `date_search_type` + `date_str`：区间用 `between` 加两个日期，只给下界用 `after`，只给上界用 `before`。`authors` 与 `orgs` 既是过滤也影响排序，其余过滤项只过滤。结果里的 `id_kind` 说明这个 id 属于哪个语料，**只有 `arxiv` 的 id 能交给 `deepxiv_paper`**。

`deepxiv_paper` 的视图与两个语料的关系：

| view | arXiv | PMC | 说明 |
| --- | --- | --- | --- |
| `brief` | ✅ `type=brief` | ❌ | 标题、TLDR、关键词、引用数 |
| `head` | ✅ `type=head` | ✅ `type=head` | 元数据 + 每个章节的标题与 TLDR，也就是 `section` 视图要用的菜单 |
| `preview` | ✅ `type=preview` | ❌ | 前 `characters` 个字符，默认 10000 |
| `section` | ✅ `type=section` | ❌ | 一节正文；`section` 参数必须与 `head` 给出的标题逐字一致（例如 `1. Introduction`） |
| `full` | ✅ `type=raw` | ✅ `type=json` | 全文；PMC 的结构化 `body` 会被摊平成 markdown，含任意深度的 `subsections` |

`paper_id` 按前缀判定语料：`2409.05591` 走 arXiv，`PMC544940` 走 PMC（大小写不敏感，上行前统一转大写）。arXiv 的版本后缀（`2409.05591v2`）会被去掉再上行——该路由只供最新版本，带后缀会 400。PMC 只支持 `head` 与 `full`，其它视图返回 `view_unsupported`。

两处 PMC 与 arXiv 的字段差异在映射时已抹平：PMC 的作者机构在 `affiliations` 而不是 `orgs`；PMC 的 `categories` 是逗号分隔的一个字符串，会被拆成列表。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/deepxiv
```

或者让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。安装后 profile 的 `cordis.patch.yml` 会多出一行 `id: deepxiv`。

这个包有一个依赖：`@deepseek-ai/dsh-credentials`（npm 上的 `0.2.1-rc.3`），所以第一次使用前要在插件目录里装一次依赖：

```sh
cd dsh-plugins/deepxiv && pnpm install
```

插件目录自带一份 `pnpm-workspace.yaml`（`packages: ["."]`），用来切断向上查找，使它成为一个独立工程而不进入仓库的 workspace。

## 配置

这一行插件的 `config` 全部可省；省略即用下表默认值。插件不带 schema 库，改由自己在加载时校验：写错的 endpoint、未知字段、默认值超过上限、小于请求超时的工具超时，都会在加载阶段直接报错，而不是悄悄用默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://data.rag.ac.cn` | 接口地址；尾斜杠会被去掉，路径前缀会保留并拼在路由前面，带查询串或 fragment 会在加载期报错 |
| `requestTimeoutMs` | `30000` | 单次上游请求超时 |
| `toolTimeoutMs` | `90000` | 一次工具调用的整体超时，必须不小于请求超时 |
| `responseLimitBytes` | `4194304` | 单次响应体读取上限，超出即失败且不解析 |
| `queryMaxChars` | `500` | 检索词长度上限（API 硬限 2000） |
| `searchDefaultTopK` / `searchMaxTopK` | `10` / `50` | 模型不指定时的条数，以及可接受的上限（API 允许 100） |
| `titleMaxChars` | `300` | 单条结果标题上限 |
| `tldrMaxChars` | `800` | 单条 TLDR / 章节 TLDR 上限 |
| `abstractMaxChars` | `1500` | 摘要上限 |
| `previewDefaultChars` / `previewMaxChars` | `10000` / `100000` | 预览默认长度与上限 |
| `sectionMaxChars` | `20000` | 单节正文上限 |
| `fullMaxChars` | `200000` | 全文上限（实测一篇 2.3 万 token 的论文约 8.5 万字符） |
| `authorsMax` / `orgsMax` | `20` / `10` | 作者、机构列表上限 |
| `categoriesMax` / `keywordsMax` | `10` / `20` | 分类、关键词列表上限 |
| `sectionsMax` | `50` | `head` 返回的章节菜单上限 |
| `userAgent` | `dsh-deepxiv/0.1` | 上行 User-Agent |

被截断的字段名会出现在结果的 `truncated` 数组里，`content_chars` 报告裁剪前的完整长度——模型据此知道读到的不是全部。

失败分类同样覆盖「响应头已到、正文没读完」这一段：那时取消或超时会得到 `aborted` / `timeout`，而不是被报成「连不上 DeepXiv、可以重试」。

**token 不在这里。** 它是密钥，放在 Harness 的凭据库（`~/.dsh/.credentials.yaml`，600 权限）里，由该插件的页面管理。

## 凭据记录

token 是凭据库 scope `deepxiv` 下的一条固定记录 `default`：

```yaml
records:
  deepxiv/default:
    kind: grant
    payload:
      channel: deepxiv
      token: '……'
      addedAt: '2026-10-14T08:00:00.000Z'
```

用 `kind: grant` 而不是 `api-key`，因为 `api-key` 只装得下 key 与环境变量表，装不下用来区分服务的 `channel`。写入只走 `modifyRecord`（读改写串行化，保留首次写入时间）；记录存在但读不出来时按原因上报（`record_missing` / `not_a_token` / `unknown_channel` / `no_token`），不会被当成「没有 token」。

## 插件页

左侧栏「插件」里选中 DeepXiv 这个 bundle，配置就在它详情页的描述下面、「包含的组件」之前；标题、版本与描述由插件页自己画（取自本包的 `locale/*.json` 元信息）：

- token 输入框（`type=text`，预填存下的 token，直接可读可改）、保存、删除，以及状态行（已保存 + 添加时间，或记录不可用的原因）；
- **验证并查询额度**：用存下的 token 调 `GET /fa/v1/whoami`，页面显示 token 属于哪个账号、层级，以及两个额度池（普通请求、Agentic 调用）的已用 / 上限 / 剩余。该接口实际返回的是 `{source, name, subject, quota:{daily_limit,used,remaining}, agent:{tier,daily_limit,used_today,remaining_today}}`，插件按这套字段归一化，同时保留文档里的旧拼写作为兜底；两者都不匹配时，退回展示有界的原始响应体；
- 只读配置卡：接口地址、两个超时、检索词上限、检索条数、预览长度、全文上限。

## 失败怎么返回

上游失败不会抛出工具调用，而是返回 `{ ok: false, source: 'deepxiv', error: { code, message, retryable } }`；只有参数校验才抛。页面动作同理，用 `{ ok, value }` / `{ ok: false, error }` 信封。

| 触发 | code | retryable |
| --- | --- | --- |
| 未存 token 且上游 401 | `token_missing` | false |
| 存了 token 但 401 | `token_rejected` | false |
| 403 | `forbidden` | false |
| 404 | `not_found` / `section_not_found` | false |
| 400 / 422 | `invalid_request` / `unprocessable` | false |
| 429 | `rate_limited` | false |
| 503 及其它 5xx | `upstream_unavailable` | true |
| 传输失败 / 超时 / 取消 | `request_failed` / `timeout` / `aborted` | true / true / false |
| 响应不是 JSON、结构不符 | `invalid_response` | false |
| 响应体超过 `responseLimitBytes` | `response_too_large` | false |
| PMC 不支持的视图 | `view_unsupported` | false |
| 其它状态码 | `http_status` | false |

页面另有请求体层面的码：`body_too_large`(413)、`invalid_json`、`invalid_body`、`unknown_action`(400)、`invalid_token`(400)，以及内部错误的 `internal_<CtorName>`。

## 安全边界

1. **token 只在这个页面明文出现。** `status` 会把存下的 token 一起返回，页面用它预填输入框（没有单独的「读 token」动作）；工具结果、日志与失败信息里都不出现 token。
2. **token 不进 URL。** 只用 `Authorization: Bearer` 头，不用 API 也支持的 `?token=` 查询串，因此任何一层记录的 URL 里都没有密钥。
3. **回显会被挡掉。** 上游 `detail`、失败信息、日志在进入模型或页面前都会被 redact；额度响应体一旦包含 token，整段被扣下，页面只显示「已扣下」。
4. **不跟随跳转。** 所有请求设 `redirect: 'error'`：带凭据的请求在跳转前就失败，目标地址不会被访问（`verify-behavior.mjs` 用真实的 302 + 第二个服务器证明了目标零请求）。
5. **响应有界。** 响应体按 `responseLimitBytes` 流式读取，超限即中止；所有进入模型的文本按配置上限裁剪，并把被裁字段名回报给模型。

## 已知边界

- **不接 Agentic 问答**（`/arxiv/agent/search`、`/web/agent/search`）。它需要 registered key，且与普通请求额度独立。
- **不接 1stAuthor 垂直域**（`/fa/v1/{domain}`：talent、law、cases 等），只在这个页面用了它的 `/fa/v1/whoami` 查额度。
- **不做检索分页**：`offset` 没有暴露给模型。
- **不做客户端节流**：上游是日额度（注册 key 10000 次/天）而不是秒级限速，模型驱动的调用频率不需要本插件加闸门；额度用尽会以 `rate_limited` 返回。
- **不缓存**：本地不存任何论文内容或查询结果。
- **`deepxiv_paper` 只读得动 arXiv 与 PMC**：bioRxiv / medRxiv 的检索结果能看，但没有对应的阅读路由。
- 上游没有稳定性承诺：同一查询在不同时间可能返回不同结果集，`score` 的语义未文档化，本插件原样透出、不做解释。

## 开发时怎么验

```sh
node tests/verify-behavior.mjs   # 离线：本地伪上游，逐字段检查请求、映射、失败分类、token 不进日志与结果
```

脚本从本目录运行；先 `pnpm install`，它从 npm 的 devDependencies 解析 `@deepseek-ai/dsh-tools`，不需要同级 `deepseek-harness` checkout，也不需要 `pnpm run build`。`pnpm test` 跑完它，再跑根目录的 `verify-client-locales.mjs` 校验页面词典。

`verify-behavior.mjs` 覆盖：配置校验；检索参数与年份区间到线上参数的逐字段映射；token 在头里而不在 URL 里；列表过滤器的重复参数；结果裁剪与 `truncated` 回报；五个阅读视图与 PMC 的元数据 / 全文摊平；401/403/400/404/422/429/503 的码映射；超时、取消、超限响应、非 JSON；302 不被跟随且目标未被访问；参数校验发生在发请求之前；凭据记录的写入 / 替换保留时间 / 删除（用真实的 `LocalCredentialProvider` 落在临时文件上）；页面动作与请求体上限；注册的 disposer 卸载后工具消失。需要真实 token 的联网校验已移除。

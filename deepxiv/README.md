# dsh-deepxiv

把 [DeepXiv](https://data.rag.ac.cn) 的论文能力接进 DeepSeek Harness：两个工具覆盖 arXiv、bioRxiv、medRxiv 的检索与 PMC 全文精读，一个插件页管理 token。Agentic 问答（`/arxiv/agent/search`）、1stAuthor 垂直域、`trending_signal` 与检索分页尚未接入。

## 工具

| 工具 | 端点 | 作用 |
| --- | --- | --- |
| `deepxiv_search` | `GET /arxiv/?type=retrieve` | 混合检索，返回论文 id、标题、TLDR、作者与机构、日期、引用数、相关度分数 |
| `deepxiv_paper` | `GET /arxiv/?type=…`、`GET /pmc/?type=…` | 读取一篇论文：`brief`、`head`、`preview`、`section`、`full` 五个视图 |

`paper_id` 按前缀判定语料：`2409.05591` 交给 arXiv，`PMC544940` 交给 PMC（大小写不敏感）。arXiv 的版本后缀（`v2`）会被移除，该路由只提供最新版，带后缀会返回 400。PMC 只支持 `head` 与 `full`，其他视图返回 `view_unsupported`。

| view | arXiv | PMC | 说明 |
| --- | --- | --- | --- |
| `brief` | ✅ | ❌ | 标题、TLDR、关键词、引用数 |
| `head` | ✅ | ✅ | 元数据与每章标题、TLDR，也是 `section` 使用的菜单 |
| `preview` | ✅ | ❌ | 前 `characters` 个字符，默认 10000 |
| `section` | ✅ | ❌ | 一节正文；标题需与 `head` 给出的逐字一致 |
| `full` | ✅ | ✅ | 全文；PMC 的结构化 `body` 展开为 markdown |

被裁剪的字段名出现在结果的 `truncated` 数组中，`content_chars` 报告裁剪前的完整长度。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/deepxiv
cd dsh-plugins/deepxiv && pnpm install   # 依赖 @deepseek-ai/dsh-credentials
```

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://data.rag.ac.cn` | 接口地址；末尾斜杠移除，路径前缀保留并拼在路由前 |
| `requestTimeoutMs` / `toolTimeoutMs` | `30000` / `90000` | 单次请求超时、工具整体超时（不得小于前者） |
| `responseLimitBytes` | `4194304` | 响应体上限，超出即失败且不解析 |
| `queryMaxChars` | `500` | 检索词长度上限（API 限制 2000） |
| `searchDefaultTopK` / `searchMaxTopK` | `10` / `50` | 检索条数默认与上限（API 允许 100） |
| `titleMaxChars` / `tldrMaxChars` / `abstractMaxChars` | `300` / `800` / `1500` | 文本裁剪上限 |
| `previewDefaultChars` / `previewMaxChars` | `10000` / `100000` | 预览默认长度与上限 |
| `sectionMaxChars` / `fullMaxChars` | `20000` / `200000` | 单节与全文上限 |
| `authorsMax` / `orgsMax` | `20` / `10` | 作者、机构列表上限 |
| `categoriesMax` / `keywordsMax` / `sectionsMax` | `10` / `20` / `50` | 分类、关键词、章节菜单上限 |
| `userAgent` | `dsh-deepxiv/0.1` | 上行 `User-Agent` |

写错的 endpoint、未知字段、越界默认值、小于请求超时的工具超时都会在加载阶段报错。

## 凭据

token 保存在凭据库 scope `deepxiv` 的固定记录 `default` 中：

```yaml
records:
  deepxiv/default:
    kind: grant
    payload:
      channel: deepxiv
      token: '……'
      addedAt: '2026-10-14T08:00:00.000Z'
```

写入只经 `modifyRecord`（保留首次写入时间）。记录存在但读不出来时按原因上报（`record_missing` / `not_a_token` / `unknown_channel` / `no_token`），不会被当成「没有 token」。

插件页负责录入与删除 token，并且可以用 `GET /fa/v1/whoami` 验证并查看额度（普通请求与 Agentic 两个池的已用、上限、剩余）。

## 失败码

| 触发 | code | retryable |
| --- | --- | --- |
| 没有 token 且上游 401 | `token_missing` | false |
| 有 token 但上游 401 | `token_rejected` | false |
| 403 / 404 / 400 / 422 / 429 | `forbidden` / `not_found`、`section_not_found` / `invalid_request`、`unprocessable` / `rate_limited` | false |
| 503 及其它 5xx | `upstream_unavailable` | true |
| 传输失败 / 超时 / 取消 | `request_failed` / `timeout` / `aborted` | true / true / false |
| 响应不可解析或结构不符 / 超过上限 | `invalid_response` / `response_too_large` | false |
| PMC 不支持的视图 | `view_unsupported` | false |

参数校验失败抛出错误，其余失败返回上述载荷。

## 安全边界

- token 只在这个页面以明文出现（页面用它预填输入框）；工具结果、日志与失败信息中都没有它。请求只用 `Authorization: Bearer`，不用 `?token=` 查询串。
- 上游 `detail`、失败信息与日志在进入模型或页面前都会 redact；额度响应体含 token 时整段扣下。
- 所有请求 `redirect: 'error'`：带凭据的请求在跳转前就失败，目标地址不会被访问。
- 响应体按 `responseLimitBytes` 流式读取，超限即中止。

## 已知边界

- 只读 arXiv 与 PMC：bioRxiv / medRxiv 的检索结果可以查看，但没有对应的阅读路由。
- 没有客户端节流：上游按日额度（注册 key 10000 次/天），额度用尽时以 `rate_limited` 返回。
- 没有缓存，本地不保存任何论文内容或查询结果。
- 上游不承诺结果稳定，`score` 的语义缺少文档说明，插件原样返回。

## 测试

```sh
node tests/verify-behavior.mjs   # 离线：本地伪上游，逐字段检查请求、映射、失败分类与 token 不外泄
```

先在本目录 `pnpm install`；`pnpm test` 还会运行根目录的 `verify-client-locales.mjs`。

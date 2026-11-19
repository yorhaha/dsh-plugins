# dsh-deepxiv

DeepXiv 学术检索与阅读插件：覆盖 arXiv、bioRxiv、medRxiv 检索与 PMC 全文精读，并提供插件页管理 API token 与查询额度。

## 工具

| 工具 | 端点 | 作用 |
| --- | --- | --- |
| `deepxiv_search` | `GET /arxiv/?type=retrieve` | 混合检索，返回论文 ID、标题、TLDR、作者机构、日期、引用数与相关度 |
| `deepxiv_paper` | `GET /arxiv/?type=…`、`GET /pmc/?type=…` | 读取论文，支持 `brief`、`head`、`preview`、`section`、`full` 五种视图 |

`paper_id` 按前缀路由：`2409.05591` 类编号走 arXiv（自动剥离 `v2` 等版本后缀），`PMC544940` 类编号走 PMC（仅支持 `head` 与 `full` 视图，其余返回 `view_unsupported`）。

| 视图 | arXiv | PMC | 说明 |
| --- | --- | --- | --- |
| `brief` | ✅ | ❌ | 标题、TLDR、关键词、引用数 |
| `head` | ✅ | ✅ | 元数据及各章节标题与 TLDR（用于定位 `section` 标题） |
| `preview` | ✅ | ❌ | 前 `characters` 个字符（默认 10000） |
| `section` | ✅ | ❌ | 指定章节正文（标题须与 `head` 返回一致） |
| `full` | ✅ | ✅ | 完整正文 |

字段截断时会记录在 `truncated` 数组中，`content_chars` 表示原始长度。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/deepxiv
cd dsh-plugins/deepxiv && pnpm install
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://data.rag.ac.cn` | 接口地址 |
| `requestTimeoutMs` / `toolTimeoutMs` | `30000` / `90000` | 单次请求超时与工具整体超时 |
| `responseLimitBytes` | `4194304` | 响应体字节上限 |
| `queryMaxChars` | `500` | 检索词长度上限（API 限制 2000） |
| `searchDefaultTopK` / `searchMaxTopK` | `10` / `50` | 检索条数默认与上限（API 允许 100） |
| `titleMaxChars` / `tldrMaxChars` / `abstractMaxChars` | `300` / `800` / `1500` | 文本裁剪上限 |
| `previewDefaultChars` / `previewMaxChars` | `10000` / `100000` | 预览字符默认与上限 |
| `sectionMaxChars` / `fullMaxChars` | `20000` / `200000` | 单节与全文字符上限 |
| `authorsMax` / `orgsMax` | `20` / `10` | 作者与机构列表上限 |
| `categoriesMax` / `keywordsMax` / `sectionsMax` | `10` / `20` / `50` | 分类、关键词与章节目录上限 |
| `userAgent` | `dsh-deepxiv/0.1` | 请求 `User-Agent` |

token 保存在凭据库 `deepxiv/default` 中，可在插件页录入、删除并调用 `GET /fa/v1/whoami` 查看普通请求与 Agentic 额度。

## 失败码

| 触发条件 | code | retryable |
| --- | --- | --- |
| 未配置 token / token 被拒（401） | `token_missing` / `token_rejected` | false |
| 403 / 404 / 400 / 422 / 429 | `forbidden` / `not_found`、`section_not_found` / `invalid_request`、`unprocessable` / `rate_limited` | false |
| 503 及其他 5xx | `upstream_unavailable` | true |
| 传输失败 / 超时 / 取消 | `request_failed` / `timeout` / `aborted` | true / true / false |
| 响应异常 / 超限 / 不支持视图 | `invalid_response` / `response_too_large` / `view_unsupported` | false |

## 注意事项

- bioRxiv / medRxiv 论文仅支持在检索结果中查看摘要，暂不支持读取正文；本地不缓存论文内容。
- 上游日额度上限为 10000 次/天（注册 Key），耗尽后返回 `rate_limited`。

## 测试

```sh
pnpm test
```

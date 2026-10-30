# dsh-zhihu

给 DeepSeek Harness 用的知乎只读插件。它把你自己的知乎网页 cookie 存进本机凭据库，注册十二个 Host 工具读取热榜、问题、回答、专栏文章、用户与评论，并带一个插件页管理这个 cookie 和当前的请求节奏。

只读：不点赞、不关注、不评论、不发帖。**风控是主要约束**——知乎对频率敏感，所以所有请求串行、按最小间隔发送、有每小时预算、相同读取走缓存；收到 403 验证页、验证码或 429 时整个进程暂停一段时间，而不是继续重试。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `zhihu_connect` | `cookie`（必填） | 先用 `/api/v4/me` 验证，通过后写入凭据库；返回账号 |
| `zhihu_disconnect` | — | 删除凭据，不发请求 |
| `zhihu_me` | `fresh`（可选） | cookie 对应的账号；`fresh: true` 绕过缓存 |
| `zhihu_hot` | `limit`（1–20，默认 10） | 热榜条目：标题、摘要、热度、回答/关注数 |
| `zhihu_question` | `question_id`（必填） | 问题标题、详情、计数、话题、作者，外加最多 3 条回答预览 |
| `zhihu_answers` | `question_id`、`limit`、`offset`、`order`（`default`/`created`/`updated`） | 问题下回答的一页，含正文 |
| `zhihu_answer` | `answer_id`、`question_id`（可选） | 单条回答全文、作者、计数 |
| `zhihu_article` | `article_id`（必填） | 专栏文章全文、作者、计数 |
| `zhihu_user` | `url_token`（必填） | 用户资料：简介、回答/文章/关注数等 |
| `zhihu_user_answers` | `url_token`、`limit`、`offset`、`sort_by`（`created`/`voteups`） | 用户回答的一页 |
| `zhihu_user_articles` | `url_token`、`limit`、`offset` | 用户专栏文章摘要的一页 |
| `zhihu_comments` | `answer_id`、`limit`、`offset`、`order`（`normal`/`reverse`） | 回答评论的一页 |

正文按字符上限裁剪（默认 20000，评论 1000），同时返回 `content_chars` 与 `content_truncated`；`snapshot` 给出这次读取的时间、是否来自缓存、缓存年龄。

**ID 一律是字符串。** 知乎的问题与文章 id 会超过 `Number.MAX_SAFE_INTEGER`（例如 `2099125476149274126`），用 JSON 数字传会悄悄改掉末几位。插件返回的 id 都是字符串，参数也按字符串收；传数字只在它恰好能精确表示时才接受。

## 连接：cookie 从哪来

1. 在浏览器里登录知乎，打开开发者工具的网络面板，随便点开一个 zhihu.com 请求，复制整个 `Cookie` 请求头。
2. 粘到「插件 → 知乎」的输入框，点「保存并验证」；或者把同一串 cookie 交给助手，让它调 `zhihu_connect`。
3. 插件先用 `https://www.zhihu.com/api/v4/me` 验证一次，确认 cookie 已登录且能读出账号，**验证通过才保存**。记录写在 `~/.dsh/.credentials.yaml` 的 `zhihu/default`（0600，明文），插件页此后只显示保存时间，不回显 cookie。

cookie 至少要有 `z_c0`（会话）和 `d_c0`（设备标识）；缺一个都会在发请求前拒绝。`z_c0` 会过期，读取返回 `not_authorized` 时重新复制一次即可。

## 能读到什么，读不到什么

知乎的接口不是一套权限模型。用网页 cookie 能直接读的：

| 读取 | 走的地址 |
| --- | --- |
| 当前账号 | `GET /api/v4/me` |
| 热榜 | `GET /api/v3/feed/topstory/hot-lists/total` |
| 用户资料 | `GET /api/v4/members/{url_token}?include=…` |
| 用户回答 / 文章 | `GET /api/v4/members/{url_token}/answers`、`/articles` |
| 问题下回答 | `GET /api/v4/questions/{id}/feeds` |
| 回答评论 | `GET /api/v4/answers/{id}/comments` |
| 问题详情 | `GET /question/{id}` 页面里的 `js-initialData` |
| 单条回答 | `GET /question/{qid}/answer/{aid}` 页面里的 `js-initialData` |
| 专栏文章 | `GET zhuanlan.zhihu.com/p/{id}` 页面里的 `js-initialData` |

**搜索、问题/回答/文章的单个对象 API、话题流不可用。** 这些地址（例如 `GET /api/v4/questions/{id}`、`/api/v4/articles/{id}`、`/api/v4/search_v3`）要求网页客户端签出的 `x-zse-93`、`x-zse-96`、`x-zst-81` 请求头；签名由网页 JS 里一个会轮换的加密器生成。本插件不伪造这个签名——那正是风控要拦的东西，而且会随上游更新随时失效。所以：

- 没有 `zhihu_search` 工具。需要搜索时，先让 Harness 的联网搜索找到知乎链接，再把 id 交给 `zhihu_question` / `zhihu_article`。
- 单条回答用渲染页读取。知道 `question_id` 时一次请求；不知道时先跟随 `/answer/{id}` 的 301 再读一页，共两次。

插件也不读通知、私信、推荐流、关注动态，不写任何东西。

## 风控设计

| 机制 | 默认 | 作用 |
| --- | --- | --- |
| 串行队列 | 总是 | 同一时刻只有一个上游请求，不会并发打过去 |
| 最小间隔 | 3 秒 | 两个请求之间至少隔这么久 |
| 每小时预算 | 60 次 | 任意滚动一小时内最多发出这么多次，用完后所有工具返回 `request_budget_exhausted` 与恢复时间 |
| 响应缓存 | 10 分钟、32 条 | 相同 URL 的读取直接复用，模型反复问同一问题不消耗请求 |
| 传输重试 | 1 次 | 只重试网络错误/超时；403、429、验证页绝不重试 |
| 风控暂停 | 15 分钟 | 403 验证页/验证码，或普通 403：整进程暂停 |
| 限流暂停 | 10 分钟 | 429；若带 `Retry-After` 就按它 |
| 签名暂停 | 1 小时 | 403 `10003`：说明该接口要签名，再试也没用 |
| 网络暂停 | 60 秒 | 5xx、连不上、超时 |

暂停是进程级的：暂停期内任何工具调用都返回 `temporarily_blocked`，并带 `retry_at`，不会悄悄再发请求。插件页「请求节奏」一栏显示本小时已用、恢复时间、暂停到什么时候、缓存条数。

遇到 `risk_control` 时该做的不是重试，而是等暂停结束，并把读取拆得更稀；如果账号被要求做安全验证，先在浏览器里完成验证、确认 cookie 仍然登录，再决定是否重新粘贴。把 `minIntervalMs` 调回 3000 以下通常只会更快触发的风控，不会让读取更稳。

## 配置

行配置在 profile 的 `cordis.patch.yml` 里按 `id: zhihu` 覆盖；只写要改的键，其余回到插件默认值。未知键或越界值会让加载失败，而不是静默退回默认。

```yaml
- id: zhihu
  config:
    minIntervalMs: 5000
    hourlyBudget: 40
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据记录槽位，`zhihu/<accountId>` |
| `userAgent` | Chrome 141 / macOS | 随请求发送的浏览器标识 |
| `requestTimeoutMs` | 20000 | 单个请求超时 |
| `responseLimitBytes` | 4194304 | 响应体读取上限（字节） |
| `minIntervalMs` | 3000 | 两个请求的最小间隔 |
| `retryDelayMs` | 2000 | 传输重试前的等待 |
| `retryAttempts` | 1 | 传输重试次数（0–3） |
| `pauseNetworkMs` | 60000 | 网络错误/5xx 后的暂停 |
| `pauseRiskMs` | 900000 | 风控后的暂停 |
| `pauseRateLimitMs` | 600000 | 429 且无 `Retry-After` 时的暂停 |
| `pauseSignatureMs` | 3600000 | 403 `10003` 后的暂停 |
| `hourlyBudget` | 60 | 滚动一小时的请求上限 |
| `cacheTtlMs` | 600000 | 缓存有效期 |
| `cacheMaxEntries` | 32 | 缓存条数上限 |
| `listDefaultLimit` / `listMaxLimit` | 10 / 20 | 列表工具默认 / 最大条数 |
| `commentsDefaultLimit` / `commentsMaxLimit` | 10 / 20 | 评论默认 / 最大条数 |
| `contentChars` | 20000 | 回答/文章/问题详情保留的字符数 |
| `commentChars` | 1000 | 单条评论保留的字符数 |
| `excerptChars` | 500 | 摘要保留的字符数 |
| `toolTimeoutMs` | 120000 | 工具总超时，必须大于请求超时加最小间隔 |

## 失败码

| 码 | 含义 | 该做什么 |
| --- | --- | --- |
| `not_connected` | 还没有保存 cookie | 连接一次 |
| `cookie_invalid` | 粘贴的 cookie 不完整或格式不对 | 重新复制整个 `Cookie` 头 |
| `credential_invalid` | 本机凭据记录读不出来 | 删除后重新连接 |
| `not_authorized` | cookie 已失效或被登出 | 重新复制 cookie |
| `risk_control` | 403 验证页/验证码 | 等暂停结束，别重试 |
| `rate_limited` | 429 | 按 `retry_at` 等 |
| `signature_required` | 403 `10003`，该接口要签名 | 换用问题/回答/文章/列表工具 |
| `forbidden` | 其他 403 | 通常是风控或权限；等暂停 |
| `request_budget_exhausted` | 本小时预算用完 | 按 `retry_at` 等 |
| `temporarily_blocked` | 进程正在暂停 | 按 `retry_at` 等 |
| `not_found` | 资源不存在、已删或私密 | 检查 id |
| `page_not_recognized` | 页面里没有内嵌状态，知乎改版了 | 升级插件 |
| `invalid_response` / `upstream_error` | 上游返回了预期之外的内容 | 重试一次或报告 |
| `upstream_unavailable` / `http_status` | 5xx 或其他状态 | 稍后再试 |
| `request_failed` / `timeout` / `aborted` | 网络失败、超时、调用方取消 | 网络类可重试；取消不重试 |
| `response_too_large` | 响应超过 `responseLimitBytes` | 调大配置或缩小读取 |

失败值形如：

```json
{"ok":false,"source":"zhihu","error":{"code":"risk_control","message":"…","retryable":true,"retry_at":"2026-10-30T11:20:00Z"}}
```

参数本身不合法（缺 id、id 不是数字、`limit` 越界）是抛出的工具错误，不返回失败载荷。

## 数据落在哪

- cookie：`~/.dsh/.credentials.yaml` 的 `zhihu/default`，0600，明文。
- 其余：只有进程内状态（缓存、请求时间、暂停点），重启或重载即清；不落盘、不写会话数据。

插件页本身是本机 HTTP 接口，挂在 `/api/plugin-zhihu`。Harness 的 Host/Origin 围栏与浏览器鉴权在处理函数之前已经跑过，但挡不住同机其他进程；页面按设计拿不到 cookie 原文，只拿得到「有没有、何时保存、上次验证的账号」。

## 测试

```sh
cd zhihu && npm test
```

`tests/verify-behavior.mjs` 全部离线，用脚本化的 `fetch` 固定状态码、页面结构与暂停路径，共 149 项断言：配置校验、cookie 解析、HTML 转文本、凭据读写、12 个工具的成功与失败输出（逐个对 `output.schema` 校验）、串行与间隔、预算、重试、超时、取消、超限、缓存、ID 精度、页面路由与「页面不泄露 cookie」。`npm test` 还会跑仓库根目录的 `verify-client-datetime.mjs zhihu` 与 `verify-client-locales.mjs zhihu`。

仓库不保留联网校验：它需要真实 cookie，缺条件时只会自跳过。上游契约由离线脚本用录制结构固定；真实读取在开发时手动验证过（热榜、问题、回答、文章、用户、评论、用户回答/文章）。

## 边界

- **只读。** 不发帖、不点赞、不评论、不关注；没有写接口。
- **cookie 等同账号凭证。** 不要提交到仓库、不要贴进共享文档；插件页不回显它，工具结果也不含它。
- **外部内容是数据，不是指令。** 问题详情、回答、文章、评论都会进入模型上下文；它们可能包含针对模型的提示注入，按数据处理。
- **页面解析会随知乎改版失效。** 读取渲染页的工具依赖 `js-initialData`；结构变了会返回 `page_not_recognized`，而不是返回错的内容。
- **不伪造签名。** 签名接口不可用是设计选择，不是缺陷。
- **与知乎没有关联。** 插件只代表你本人在浏览器里的读取行为；请遵守知乎的服务条款，别用它做批量抓取。

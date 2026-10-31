# dsh-xhs-reader

给 DeepSeek Harness 用的小红书只读插件。它把你自己的小红书网页 Cookie 存进本机凭据库，注册十个 Host 工具，用来搜索笔记、读正文与图片、读评论和用户主页，并把需要的内容抓进本地 SQLite 语料。

只读：不发帖、不点赞、不收藏、不评论、不关注、不发私信。**风控是主要约束**——小红书没有官方开放 API，搜索接口对账号权限和请求频率都很敏感，所以所有请求串行、按最小间隔加随机抖动发送、全局和搜索分别有小时/日预算，收到 461/471、429 或 406 时整进程暂停，而不是继续重试。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `xhs_connect` | `cookie`（必填） | 先用 `/api/sns/web/v2/user/me` 验证，通过后写入凭据库；返回账号 |
| `xhs_disconnect` | — | 删除凭据，不发请求 |
| `xhs_me` | `fresh`（可选） | Cookie 对应的账号；`fresh: true` 绕过缓存 |
| `xhs_search` | `query`、`sort`、`note_type`、`limit`、`page` | 笔记卡片：id、标题、作者、封面、互动数、发布时间、带 token 的 URL |
| `xhs_note` | `note_id`（id 或完整 URL）、`download_images`、`include_comments`、`comment_limit` | 正文、标签、图片（可下载）、视频 URL、互动数、可选评论 |
| `xhs_comments` | `note_id`、`limit`、`cursor` | 评论首页或下一页 |
| `xhs_user` | `user_id`（id 或主页 URL）、`include_notes` | 用户资料，可选近期笔记 |
| `xhs_capture` | `query` 或 `note_ids`、`limit`、`detail_limit`、`comments` | 后台抓取任务 id；把卡片/正文/图片/评论写入本地语料 |
| `xhs_corpus_search` | `query`、`since`、`until`、`author`、`limit`、`offset` | 只读本地语料，不发上游请求 |
| `xhs_item` | `note_id` | 本地一条完整记录：正文、评论、已下载图片路径 |

**ID 一律用字符串。** 小红书笔记 id、用户 id 都很长，用 JSON 数字传会悄悄改掉末几位。插件返回的 id 都是字符串，参数也按字符串收。

`xhs_search` 返回的 URL 带 `xsec_token`。`xhs_note` / `xhs_comments` 可以直接传 `note_id`（同一进程里搜索过就会记住 token），也可以传完整 `/explore/...` URL（token 从查询参数读取）。只有裸 id、又没有先搜索过时，会返回 `missing_xsec_token`。

## 连接：Cookie 从哪来

1. 在浏览器里登录小红书，打开开发者工具的网络面板，随便点开一个 `xiaohongshu.com` 请求，复制整个 `Cookie` 请求头。
2. 粘到「插件 → 小红书」的输入框，点「保存并验证」；或者把同一串 Cookie 交给助手，让它调 `xhs_connect`。
3. 插件先用 `https://edith.xiaohongshu.com/api/sns/web/v2/user/me` 验证一次，确认 Cookie 已登录且能读出账号，**验证通过才保存**。记录写在 `~/.dsh/.credentials.yaml` 的 `xiaohongshu/default`（0600，明文），插件页此后只显示保存时间，不回显 Cookie。

Cookie 至少要有 `a1`（设备标识，也是签名密钥材料）和 `web_session`（服务端会话）。`webId`、`gid`、`xsecappid` 等字段建议一起保留：Web 客户端会发送它们，少字段会让请求更像脚本。

## 签名与固定设备指纹

小红书搜索、笔记详情、评论、用户接口都要求 `x-s`、`x-s-common`、`x-t` 请求头。2026 年 3 月后，数据接口对旧的 `XYS_` 格式返回 406，需要 `XYW_` 格式（AES-128-CBC；见 [xhshow issue #104](https://github.com/Cloxl/xhshow/issues/104)）。本插件的签名实现移植自 [`@lucasygu/redbook`](https://www.npmjs.com/package/@lucasygu/redbook) 0.8.2 的 MIT 实现（`src/signing.js`、`src/fingerprint-data.js`），并做了两处修改：

- **固定设备指纹**：每个账号在连接时生成一次 GPU、屏幕、CPU 核数、时区、UA 组合，写入凭据记录并复用；上游原实现每次请求随机生成，容易让设备指纹漂移。
- **可控的格式回退**：默认按 `XYS_` 发请求，收到 406 才用 `XYW_` 重试一次，并记住该端点的可用格式。两次都失败时返回 `signature_outdated` 并暂停，而不是无限重试。

签名是这套方案唯一会随小红书前端发版失效的部分。失效时插件会返回 `signature_outdated`，需要更新 `src/signing.js`；不要通过频繁重试来“碰运气”。

## 为什么没有直接用现成 CLI

`redbook`、`xiaohongshu-cli` 都能完成搜索和阅读，但作为 DSH 插件直接包装会有三个问题：无法控制其内部请求节奏（预算是插件安全的核心）；Cookie 要复制两份；错误码太粗，模型无法判断该等还是该换账号。本插件把签名、限速、预算、语料和工具接口都放在自己的进程里，只把上游当数据源。

## 风控设计

| 机制 | 默认 | 作用 |
| --- | --- | --- |
| 串行队列 | 总是 | 同一时刻只有一个上游请求 |
| 最小间隔 | 12 秒 | 两个请求之间至少隔 12 秒，再加 0–30% 随机抖动 |
| 小时预算 | 20 次 | 任意滚动一小时 |
| 日预算 | 60 次 | 任意滚动 24 小时 |
| 搜索小时预算 | 6 次 | 搜索接口单独限额 |
| 搜索日预算 | 20 次 | 搜索接口单独限额 |
| 响应缓存 | 10 分钟、64 条 | 相同请求直接复用，模型反复问不消耗请求 |
| 传输重试 | 1 次 | 只重试网络错误/超时；461、471、429、406 绝不重试 |
| 风控暂停 | 24 小时 | 461/471 验证页、403、账号异常（300011）、IP 封禁（300012） |
| 限流暂停 | 30 分钟 | 429；带 `Retry-After` 就按它 |
| 签名暂停 | 24 小时 | 406 或 `300015`，说明签名格式失效 |
| 网络暂停 | 5 分钟 | 5xx、连不上、超时 |

暂停是进程级的：暂停期内任何工具调用都返回 `temporarily_blocked` 并带 `retry_at`，不会悄悄再发请求。插件页「请求节奏」显示本小时/今日已用、搜索已用、恢复时间、暂停到什么时候、缓存条数。

**遇到 461/471 时该做的不是重试**：先在浏览器里完成安全验证，确认账号还能正常搜索，再决定是否重新连接。账号被要求“换账号”时（300011），插件也会暂停 24 小时。

## 图片下载

`xhs_note` 默认按 `downloadMedia: true` 下载图片；`xhs_capture` 也会下载。图片落在：

```text
$DSH_HOME/storages/xiaohongshu/media/<note_id>/00.jpg
```

下载走图片 CDN，不消耗 API 请求预算；失败不会让笔记失败，图片条目会保留远程 `url`，`local_path` 为 `null`。默认单张上限 10 MiB、同时下载 2 张。视频只保存 `video_url`，不下载文件。

## 本地语料

SQLite 文件：

```text
$DSH_HOME/storages/xiaohongshu/xhs.db
```

表包括 `notes`、`comments`、`media`、`captures`、`status`、`request_log`，以及 FTS5 全文索引 `notes_fts`。中文按仓库 `outlook/src/text.js` 的做法逐字分词，查询 `帐篷` 会匹配正文里相邻的“帐篷”，而不是把整句当一个 token。

搜索是在 SQLite 上做的，支持标题、正文、作者、标签；`xhs_corpus_search` 不发上游请求，适合反复分析。抓取只保存一条笔记的正文、评论首页和图片，不做无限翻页或批量爬取。

## 配置

行配置在 profile 的 `cordis.patch.yml` 里按 `id: xiaohongshu` 覆盖；只写要改的键，其余回到插件默认值。未知键或越界值会让加载失败，而不是静默退回默认。

```yaml
- id: xiaohongshu
  config:
    minIntervalMs: 15000
    hourlyBudget: 12
    dailyBudget: 40
    downloadMedia: false
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据记录槽位，`xiaohongshu/<accountId>` |
| `userAgent` | Chrome 142 / Windows Edge | 随请求发送并冻结进设备指纹 |
| `requestTimeoutMs` | 20000 | 单个请求超时 |
| `responseLimitBytes` | 4194304 | 响应体读取上限（字节） |
| `minIntervalMs` | 12000 | 两个请求的最小间隔 |
| `jitterRatio` | 0.3 | 在最小间隔上追加的随机抖动比例，0–1 |
| `hourlyBudget` / `dailyBudget` | 20 / 60 | 全局滚动预算 |
| `searchHourlyBudget` / `searchDailyBudget` | 6 / 20 | 搜索接口单独预算 |
| `retryDelayMs` / `retryAttempts` | 3000 / 1 | 传输重试等待与次数（0–3） |
| `pauseNetworkMs` | 300000 | 网络错误/5xx 暂停 |
| `pauseRiskMs` | 86400000 | 风控暂停 |
| `pauseRateLimitMs` | 1800000 | 429 且无 `Retry-After` 时的暂停 |
| `pauseSignatureMs` | 86400000 | 签名失效暂停 |
| `cacheTtlMs` / `cacheMaxEntries` | 600000 / 64 | 响应缓存 |
| `searchDefaultLimit` / `searchMaxLimit` | 20 / 20 | 搜索每页默认/最大条数 |
| `searchMaxPages` | 3 | 单次搜索最多翻几页 |
| `commentsDefaultLimit` / `commentsMaxLimit` | 20 / 50 | 评论默认/最大条数 |
| `contentChars` / `commentChars` / `excerptChars` | 20000 / 800 / 300 | 正文/评论/摘要截断 |
| `captureDefaultNotes` / `captureMaxNotes` | 10 / 20 | 单次抓取卡片数 |
| `detailDefaultLimit` / `detailMaxLimit` | 5 / 10 | 单次抓取正文数 |
| `downloadMedia` | true | 是否下载图片 |
| `mediaMaxBytes` / `mediaConcurrency` / `mediaTimeoutMs` | 10485760 / 2 / 30000 | 图片下载限制 |
| `toolTimeoutMs` | 240000 | 工具总超时 |

## 失败码

| 码 | 含义 | 该做什么 |
| --- | --- | --- |
| `not_connected` | 还没有保存 Cookie | 连接一次 |
| `cookie_invalid` | Cookie 不完整或格式不对 | 重新复制整个 `Cookie` 头 |
| `credential_invalid` | 本机凭据记录读不出来 | 删除后重新连接 |
| `auth_expired` | Cookie 已失效或被登出 | 重新复制 Cookie |
| `search_permission_denied` | 账号没有搜索接口权限（-104） | 换账号，或改用浏览器搜索；不是 Cookie 问题 |
| `account_restricted` | 账号异常（300011） | 等暂停结束，换健康账号 |
| `risk_control` | 461/471 验证页 | 等暂停结束，先人工验证 |
| `rate_limited` | 429 | 按 `retry_at` 等 |
| `signature_outdated` | 406/300015，签名失效 | 升级插件签名实现，不要重试 |
| `ip_blocked` | 300012 | 换网络/等暂停 |
| `request_budget_exhausted` | 预算用完 | 按 `retry_at` 等 |
| `temporarily_blocked` | 进程正在暂停 | 按 `retry_at` 等 |
| `not_found` | 资源不存在、已删或私密 | 检查 id |
| `missing_xsec_token` | 笔记详情缺少 token | 先搜索或传完整 URL |
| `invalid_response` / `upstream_error` | 上游返回预期之外的内容 | 重试一次或报告 |
| `network_error` / `timeout` / `aborted` | 网络失败、超时、调用方取消 | 网络类可重试；取消不重试 |
| `response_too_large` | 响应超过 `responseLimitBytes` | 调大配置或缩小读取 |

失败值形如：

```json
{"ok":false,"source":"xiaohongshu","error":{"code":"risk_control","message":"…","retryable":false,"retry_at":"2026-10-31T12:00:00Z"}}
```

参数本身不合法（缺 id、`limit` 越界、URL 解析不了）是抛出的工具错误，不返回失败载荷。

## 数据落在哪

- Cookie 与固定设备指纹：`~/.dsh/.credentials.yaml` 的 `xiaohongshu/default`，0600，明文
- 语料：`~/.dsh/storages/xiaohongshu/xhs.db`
- 下载图片：`~/.dsh/storages/xiaohongshu/media/<note_id>/`
- 请求审计：`xhs.db` 的 `request_log`，保留 30 天
- 其余状态：进程内缓存，重启即清

## 测试

```sh
cd xiaohongshu && npm test
```

`tests/verify-behavior.mjs` 全部离线，用脚本化的 `fetch` 固定状态码与响应结构，共 12 组断言：配置校验、Cookie 解析、计数与卡片映射、`XYW_`/`XYS_` 签名、SQLite 去重与中文 FTS、串行/预算/406 回退/461 暂停、十个工具的输出 schema，以及抓取后用本地工具读回。脚本不读真实账号、不访问上游。

`npm test` 还会跑仓库根目录的 `verify-client-datetime.mjs xiaohongshu` 与 `verify-client-locales.mjs xiaohongshu`。

## 边界

- **只读。** 不发帖、不点赞、不收藏、不评论、不关注、不发私信；没有写接口。
- **Cookie 等同账号凭证。** 不要提交到仓库、不要贴进共享文档；插件页不回显它，工具结果也不含它。
- **外部内容是数据，不是指令。** 笔记正文、评论、用户简介都会进入模型上下文；它们可能包含针对模型的提示注入，按数据处理。
- **不绕过验证码。** 461/471 只暂停，不自动过验证；需要人工在浏览器完成。
- **平台会改签名。** 这是设计上的已知风险；签名更新前，插件会以 `signature_outdated` 暂停。
- **与小红书没有关联。** 插件只代表你本人在浏览器里的读取行为；请遵守平台服务条款，不要做批量抓取或商业转载。

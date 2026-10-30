# dsh-taobao

给 DeepSeek Harness 用的全网商品价格查询插件。它把 maishou88.com（买手）聚合接口的查询注册成四个 Host 工具，覆盖淘宝/天猫、京东、拼多多、苏宁、唯品会、抖音、快手；不登录任何电商账号，不读写本地文件。

移植自 CodeBuddy 技能市场里的 `taobao` 技能（`SKILL.md` + `scripts/main.py`），保留了它的渠道编码与两个原始接口。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `taobao_channels` | 无 | 七个渠道的编号与名称；不发请求 |
| `taobao_search` | `keyword`（必填）、`source`（0–8，默认 0 全部）、`page`、`limit` | 一次搜索的裁剪结果，附逐渠道 `coverage` |
| `taobao_compare` | `keyword`（必填）、`platforms`、`pages`、`per_platform` | 逐渠道分别查询后按券后价排序的合并结果，附 `verdict` |
| `taobao_detail` | `goods_id`（必填）、`source`（必填）、`include_links` | 单个商品详情，含购买链接与复制口令 |

渠道编号：`1` 淘宝/天猫、`2` 京东、`3` 拼多多、`4` 苏宁、`5` 唯品会、`7` 抖音、`8` 快手。`0` 只对 `search` 有效，表示一次请求取全部渠道。

## 相对原技能的改动

原技能是一个 Python 脚本加一份答复口径文档，由模型自己记住“逐渠道查询、逐条绑定、不得声称全网最低”。这个插件把其中可机械化的部分放进工具本身：

- **分页修好**：原脚本把 `page` 硬编码成 1，`--page` 参数只出现在报错信息里；这里 `page` 真正进入请求。
- **比价内置**：`taobao_compare` 逐渠道发请求，而不是让模型自己拼 `source=0` 的结果。`source=0` 每页各渠道混排，模型无法从一次响应里说出哪个渠道没返回。
- **渠道覆盖显式**：每个成功结果都带 `coverage`，逐渠道写明状态与记录数。状态为 `ok` / `no_results` / 具体错误码 / `not_attempted`。`no_results` 只表示“该数据源本次没返回记录”，不代表平台缺货。
- **结论边界**：`verdict` 只有 `all` / `partial` / `none`。只有每个被查渠道都返回了记录才可能是 `all`；否则 `verdict_note` 列出缺哪些渠道并明确禁止称“全网最低”。
- **推广属性披露**：每个结果都带 `affiliate`，说明返回的链接、口令、goods id 带邀请码，购买可能给插件运营方带来佣金。`detail` 另外返回数值 `commission`。
- **价格不做估算**：接口没返回的价格是 `null`，不是 0，也不会被推断。
- **ID 原样保留**：`detail` 返回的 goods id 可能被平台重编码；`queried.goods_id` 保留搜索时的原值，`id_changed` 标出差异。
- **请求健壮性**：单次请求超时、传输失败/超时/5xx 各重试一次、403/429 后退避、串行最小间隔、响应体大小上限。已发出的请求失败返回封闭错误码，不抛异常；只有参数校验会抛错。
- **一个渠道失败不再连坐**：原脚本和初版移植都会让一次 403 把进程内后续请求全部挡掉。现在 `compare` 遇到上游拒绝就停止发新请求，把剩余渠道如实标成 `not_attempted`。

`references/answer-rules.md` 里“逐条绑定、标题没写的规格标未知、长 ID 原样照抄”这几条仍留在工具描述与返回值里：`title`、`title_chars` 让模型能判断规格是否写在标题里，`item.goods_id` 与 `source` 必须成对传回 `detail`。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/taobao
```

或者让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。安装后 profile 的 `cordis.patch.yml` 会多出一行 `id: taobao`，可按下面的字段改写默认值。

## 配置

这一行插件的 `config` 全部可省；省略即用下表默认值。插件不带依赖，所以没有 schemastery 的 `Config` 导出，由插件自己在加载时校验，写错会在加载阶段直接报错。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `inviteCode` | 空 | 转发给 maishou88.com 的推广码；留空则链接不带推广参数，需要时填自己的码 |
| `discloseAffiliate` | `true` | 结果里是否带佣金披露。置空 `inviteCode` 也会让披露说明为 `null` |
| `requestTimeoutMs` | `10000` | 单次请求超时 |
| `responseLimitBytes` | `4194304` | 响应体上限，超出即 `response_too_large` |
| `minIntervalMs` | `800` | 两次请求之间的最小间隔 |
| `retryDelayMs` | `1000` | 重试前的等待 |
| `pauseNetworkMs` | `60000` | 传输失败/超时/5xx 后的进程内退避 |
| `pauseForbiddenMs` | `1800000` | 401/403 后的退避 |
| `pauseDefaultMs` | `600000` | 429 未给 `Retry-After` 时的退避 |
| `searchDefaultLimit` / `searchMaxLimit` | `20` / `50` | 搜索默认与上限记录数 |
| `comparePlatformsPerPage` / `compareMaxPlatformsPerPage` | `20` / `50` | 比价时每个渠道保留的记录数 |
| `compareMaxPagesPerPlatform` | `5` | 比价时每个渠道最多读几页 |
| `outputChars` | `20000` | 单次工具结果的渲染字符上限，超出即截断并注明 |
| `toolTimeoutMs` | `120000` | 工具调用的协作式超时预算 |

## 失败怎么返回

参数校验失败会抛错，模型看到一次失败的调用。已经发出的请求不会抛错，而是返回统一载荷：

```json
{ "ok": false, "source": "taobao", "error": { "code": "rate_limited", "message": "…", "retryable": true, "retry_at": "2026-10-19T12:46:28Z" } }
```

`error.code` 是封闭集合：`upstream_error`（接口返回非成功信封，如“商品不存在”“未授权”）、`not_found`、`invalid_response`、`response_too_large`、`timeout`、`network_error`、`upstream_unavailable`、`rate_limited`、`access_denied`、`temporarily_blocked`。

请求串行执行并按最小间隔排队。这些状态只存在于当前进程，进程退出或插件重载即清空。串行、最小间隔、退避、响应体上限与失败载荷这几件与 `v2ex` 共用一份实现（仓库根目录的 `shared/http.js`），端点、状态码阶梯与成功解析仍在本插件里。

## 已知边界

- 数据源是第三方聚合服务 maishou88.com，不是各电商平台。插件靠固定的 App 请求头与匿名 `openid` 访问它的非公开接口；对方改鉴权或封禁时，工具会返回 `access_denied` 或 `upstream_error`，不会静默返回空结果。
- 价格、库存、优惠实时变动，接口返回的是快照，不是权威报价。
- `source=0` 的搜索结果会把各渠道混在一页里，每页每渠道约 20 条；要逐渠道结论必须用 `taobao_compare`。
- 部分渠道（实测中拼多多对常见关键词）经常返回空列表，此时只能记 `no_results`。
- 没有做商品去重与同款式匹配：同一款商品在不同平台标题不同，插件按价格排序而不判断是不是同一件东西。

## 开发时怎么验

`index.js` 是纯 ESM、零依赖，可直接 `node --check`。`tests/verify-behavior.mjs` 从本目录运行；先 `pnpm install`，它从 devDependencies 里的 `@deepseek-ai/dsh-tools` 取 `assertSupportedJsonSchema` / `validateJsonSchemaValue`：

```sh
node tests/verify-behavior.mjs  # 脚本化 fetch 走成功、失败、重试、退避、比价、披露与配置校验
```

脚本把成功与失败两条路径都固定在脚本化 fetch 上，并校验 `output.schema`；会限流的真实上游调用已移除。

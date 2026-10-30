# dsh-notify

给 DeepSeek Harness 用的 PushPlus 通知插件。它给助手一个工具，把一条消息推到你手机上（PushPlus 默认走微信），并带一个插件页（左侧栏「插件」里选中它，配置就在详情页描述下面）管理任意数量的 PushPlus token：**每条消息都会发往全部已配置的目标**。

它还 `provide` 一个 `notify` 服务，供别的插件按需投递（例如 `dsh-user-todo` 的到期提醒）。服务和工具走同一条发送路径，因此用哪一边都一样会按 `titleMaxChars`/`contentMaxChars` 截断、都不含 token。

移植自 yorha 的 `core/yorha/notify.py`，保留了它的接口约定（`POST {base}/send`、JSON 正文、`code != 200` 即失败）与那条安全属性：**token 不进入异常消息、日志与结果**。变化的部分是把「一个环境变量里的 token」换成凭据库里的多条记录，因此可以有多个目标。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `notify_send` | `content`（必填）、`title`（可选，默认取配置的 `defaultTitle`） | 逐目标投递结果与计数 |

模型面只描述用途与边界（单向、离开会话也能收到、纯文本），不出现 token、记录、bridge 这些实现词。标题与正文按 `titleMaxChars` / `contentMaxChars` 截断，并在返回值里用 `title_truncated` / `content_truncated` 说明。

## 给其他插件用的服务

装了本插件后，Host 里就有 `notify` 这个服务，任何插件都可以 `ctx.get('notify')` 拿到它（拿不到就是没装，按缺省路径处理即可）：

```js
const notify = ctx.get('notify')
const outcome = await notify.send({ title: '日程', content: '09:00 交周报' })
```

- `send({ title, content })` 返回 `{ ok, delivered, total, title_truncated, content_truncated }`；失败时 `ok: false`，并带一个封闭的 `code`：`not_configured`（一个 token 都没配）、`failed`（全部目标都失败）、`partial`（部分失败，`failures` 逐目标列出名字与原因）、`invalid_content`（正文为空）。它**不抛异常**，调用方按返回值记账即可。
- `status()` 返回 `{ total, ready }`：配置了几个目标、其中几个可用。
- 结果里永远不出现 token；失败的 `message` 来自上游，可能包含 PushPlus 的错误描述，但不含凭据。

服务与工具是同一个实现，不会出现「工具能发、服务发不出去」的分歧。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/notify
```

或者让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。安装后 profile 的 `cordis.patch.yml` 会多出一行 `id: notify`。

这个包有一个依赖：`@deepseek-ai/dsh-credentials`（npm 上的 `0.2.1-rc.3`），所以第一次使用前要在插件目录里装一次依赖：

```sh
cd dsh-plugins/notify && pnpm install
```

插件目录自带一份 `pnpm-workspace.yaml`（`packages: ["."]`），用来切断向上查找，使它成为一个独立工程而不进入仓库的 workspace。

## 配置

这一行插件的 `config` 全部可省；省略即用下表默认值。插件不带 schema 库，改由自己在加载时校验：写错的 endpoint、未知模板、小于请求超时的工具超时都会在加载阶段直接报错，而不是悄悄用默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://www.pushplus.plus` | 发送地址，实际请求 `<baseUrl>/send`；尾斜杠会被去掉 |
| `template` | `txt` | PushPlus 模板：`txt`、`html`、`markdown` |
| `defaultTitle` | `DeepSeek Harness` | 工具没给 `title` 时用它 |
| `requestTimeoutMs` | `15000` | 单个目标的请求超时 |
| `toolTimeoutMs` | `60000` | 一次工具调用的整体超时，必须不小于请求超时 |
| `titleMaxChars` | `100` | 标题上限，超出截断 |
| `contentMaxChars` | `4000` | 正文上限，超出截断 |

**token 不在这里。** 它是密钥，放在 Harness 的凭据库（`~/.dsh/.credentials.yaml`，600 权限）里，由该插件的页面管理。

## 目标与凭据记录

一个目标 = 凭据库 scope `notify` 下的一条记录，记录 id 就是目标名（`^[a-z][a-z0-9-]{0,31}$`）：

```yaml
records:
  notify/default:
    kind: grant
    payload:
      channel: pushplus
      token: '……'
      addedAt: '2026-10-14T03:23:33.938Z'
```

用 `grant` 而不是 `api-key`，是因为 `api-key` 记录只允许 `key` 与 `env` 两个字段，装不下 `channel`——那是留给以后接入其他推送通道的判别字段。载荷由本插件自己解释：`channel` 不认识、`token` 为空、记录类型不对，都会被当成**一个投递失败的目标**报出来，而不是静默跳过。

发送时逐个目标并行投递，各自独立超时：一个账号失败不会影响另一个账号，也不会被成功的那几个掩盖。

## 插件页

左侧栏「插件」里选中通知这个 bundle，配置就在它详情页的描述下面、「包含的组件」之前；标题、版本与描述由插件页自己画（取自本包的 `locale/*.json` 元信息）。页面管理目标：列出目标名、token（明文）与添加时间，可添加/替换（同名即替换 token）、删除，并对单个目标发一条测试消息。页面还会显示只读的发送设置（地址、模板、两个长度上限），它们来自 `cordis.patch.yml`。

页面经 Host 侧的 `/api/plugin-notify` 路由通信——这条路由挂在 Harness 自己已鉴权的 `/api` 通道下（Host/Origin 防护与浏览器鉴权已经先跑过），插件不再自带一套鉴权。

**token 在这个页面是明文**：`status` 会带回每个可用目标的 token，列表里直接显示，因此忘记的 token 可以查看，也可以复制。写入仍然只有「提交一个 token」这一条路；「测试」只返回成功或失败原因。

## 失败怎么返回

工具不抛异常（只有参数本身非法才由框架拒绝），预期失败返回闭集错误码，模型能据此判断要不要重试：

| 场景 | `ok` | `failures[].code` | `retryable` |
| --- | --- | --- | --- |
| 所有目标都送达 | `true` | — | — |
| 部分/全部目标失败 | `false` | 见下 | 见下 |
| 一个目标都没配置 | `false` | 顶层 `error.code = not_configured` | `false` |

- `rejected`：PushPlus 返回 `code != 200`（token 错误或失效最常见），`false`
- `http_status`：HTTP 状态码不是 200，`true`
- `invalid_response`：HTTP 200 但响应体不是预期的 JSON，`false`
- `request_failed`：传输失败或超时，`true`
- `aborted`：调用被取消，`true`
- `unusable_target`：记录读不出来（见上一节），`false`

## 安全边界

1. token 只出现在发往 PushPlus 的请求体与这个页面的明文列表里：不进 URL、不进日志、不进工具结果、不进会话记录。请求用 POST（PushPlus 也支持 GET 查询串），正是为了不让 token 出现在 URL 里被任何一层记下来。
2. 失败消息只保留原因：传输异常只留异常类型名，PushPlus 的 `msg` 会先做一次「出现 token 就替换成 `<token>`」再截断到 200 字符——上游把 token 回显回来也不会外泄。
3. 日志只记目标名与错误码。
4. 工具结果会进入会话记录（durable），所以那里同样不放 token。

## 已知边界

- **没有按目标分发**：每条消息发给全部目标。要少发就删掉目标，或以后再按名字/类型路由。
- **没有重试与去重**：一次调用对每个目标只发一次；失败靠模型看到 `retryable` 后决定是否再发，重发可能重复收到。
- **没有自发节流**：进程内不做频率限制，实际上限由 PushPlus 账号自己的额度决定（额度用尽会以 `rejected` 返回）。
- **只有一个通道**：目前只有 PushPlus；记录里的 `channel` 字段是给后续通道留的位置。
- **不落盘任何状态**：插件没有自己的库或缓存，全部事实都在凭据库与配置里。

## 开发时怎么验

```sh
node tests/verify-behavior.mjs   # 离线：本地 stub 充当 PushPlus，逐个请求断言
```

插件目录里 `pnpm test` 跑行为脚本，再跑根目录的 `verify-client-locales.mjs` 校验页面词典。行为脚本复用 `@deepseek-ai/dsh-tools` 的 schema 校验器，不需要 `pnpm run build`，也不需要同级 checkout。它覆盖：配置校验、请求体逐字段、多目标扇出、部分失败、上游回显 token 时的脱敏、超时、不可用记录、页面动作与体积上限、以及工具注册的释放。凭据那一层不靠假实现：脚本会在临时文件上挂载真实的 `dsh-credentials-local` 提供者，验证写入、替换（保留添加时间）、删除，以及别的通道写下的记录会被读成不可用。需要真实 PushPlus token 的联网校验已移除。

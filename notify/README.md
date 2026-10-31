# dsh-notify

PushPlus 通知插件：一个工具把消息推到手机（PushPlus 默认经微信送达），一个插件页管理任意数量的 token，每条消息发往全部已配置目标。插件还 `provide` 一个 `notify` 服务供其他插件投递（例如 `dsh-user-todo` 的到期提醒），两者共用同一条发送路径。

移植自 yorha 的 `core/yorha/notify.py`，保留了 `POST {base}/send`、JSON 正文、`code != 200` 视为失败的约定，以及「token 不进异常、日志与结果」这条属性。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `notify_send` | `content`（必填）、`title`（可选，默认取 `defaultTitle`） | 逐目标投递结果与计数 |

标题与正文按 `titleMaxChars` / `contentMaxChars` 截断，返回值用 `title_truncated` / `content_truncated` 说明。

## 面向其他插件的服务

```js
const notify = ctx.get('notify')          // 拿不到说明没装本插件，按默认方式处理
const outcome = await notify.send({ title: '日程', content: '09:00 交周报' })
```

`send({ title, content })` 返回 `{ ok, delivered, total, title_truncated, content_truncated }`；失败时 `ok: false` 并带封闭的 `code`：`not_configured`（一个 token 都没有）、`failed`（全部失败）、`partial`（部分失败，`failures` 逐目标列出名字与原因）、`invalid_content`（正文为空）。该调用不抛异常。`status()` 返回 `{ total, ready }`。结果里不出现 token。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/notify
cd dsh-plugins/notify && pnpm install   # 依赖 @deepseek-ai/dsh-credentials
```

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://www.pushplus.plus` | 实际请求 `<baseUrl>/send`；尾斜杠会被去掉 |
| `template` | `txt` | PushPlus 模板：`txt`、`html`、`markdown` |
| `defaultTitle` | `DeepSeek Harness` | 工具没有提供 `title` 时使用 |
| `requestTimeoutMs` | `15000` | 单个目标的请求超时 |
| `toolTimeoutMs` | `60000` | 一次工具调用的整体超时，不得小于请求超时 |
| `titleMaxChars` / `contentMaxChars` | `100` / `4000` | 标题与正文上限，超出截断 |

写错的 endpoint、未知模板、小于请求超时的工具超时都会在加载阶段报错。

## 目标与凭据

一个目标对应凭据库 scope `notify` 下的一条记录，记录 id 就是目标名（`^[a-z][a-z0-9-]{0,31}$`）：

```yaml
records:
  notify/default:
    kind: grant
    payload:
      channel: pushplus
      token: '……'
      addedAt: '2026-10-14T03:23:33.938Z'
```

用 `grant` 是因为 `api-key` 只允许 `key` 与 `env` 两个字段，放不下 `channel`。记录无法识别 `channel`、`token` 为空或类型不对时，会被当成一个失败目标报告出来，不会静默跳过。发送时逐目标并行、各自计算超时，一个账号失败不影响另一个。

## 插件页

左侧栏「插件」选中通知 bundle，配置在详情页描述下方。页面列出目标名、token（明文）与添加时间，可以添加或替换（同名替换 token）、删除、对单个目标发测试消息，并显示只读的发送设置。写入只有「提交一个 token」一种方式。页面走 Host 的 `/api/plugin-notify`，鉴权由 Harness 的 `/api` 通道负责。

## 失败码

| 场景 | `ok` | 说明 |
| --- | --- | --- |
| 全部送达 | `true` | — |
| 部分或全部失败 | `false` | `failures[].code` 见下 |
| 一个目标都没有配置 | `false` | 顶层 `error.code = not_configured` |

`rejected`（PushPlus 返回 `code != 200`，多为 token 失效，不可重试）、`http_status`（状态码非 200，可重试）、`invalid_response`（200 但 JSON 不符预期）、`request_failed`（传输失败或超时，可重试）、`aborted`（调用取消）、`unusable_target`（记录读不出来）。

## 安全边界

- token 只出现在发往 PushPlus 的请求体与插件页的明文列表里；用 POST 就是为了不让它进 URL。
- 失败消息只保留原因：传输异常只留类型名，上游 `msg` 先把 token 替换成 `<token>` 再截断到 200 字符；日志只记录目标名与错误码。
- 工具结果会进入会话记录，因此那里同样没有 token。

## 已知边界

没有按目标分发（每条消息发给全部目标）、没有重试与去重、没有自发节流（上限由 PushPlus 账号额度决定，用尽时以 `rejected` 返回）、只有一个通道（`channel` 字段为后续通道预留）、不写任何状态到磁盘。

## 测试

```sh
npm test   # verify-behavior.mjs（离线行为）、verify-service.mjs（服务契约），再校验页面词典
```

行为脚本用本地 stub 充当 PushPlus 逐请求断言。凭据层不使用模拟实现：脚本在临时文件上挂载真实的 `dsh-credentials-local`。

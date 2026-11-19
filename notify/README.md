# dsh-notify

PushPlus 手机通知插件：提供 `notify_send` 工具将消息推送到手机，附带插件页管理多个推送 token，并对外提供 `notify` 服务供其他插件（如 `dsh-user-todo`）调用。

## 工具与跨插件服务

- **`notify_send`**：参数 `content`（必填）、`title`（选填，默认取 `defaultTitle`），并发推送给所有已配置目标。超出 `titleMaxChars` / `contentMaxChars` 时截断并返回 `title_truncated` / `content_truncated`。
- **`ctx.get('notify')`**：提供 `send({ title, content })` 与 `status()` 方法；`send` 返回 `{ ok, delivered, total, title_truncated, content_truncated }`（失败时附带 `code` 与 `failures`），不抛异常。

## 安装与配置

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/notify
cd dsh-plugins/notify && pnpm install
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://www.pushplus.plus` | 推送接口地址（请求 `<baseUrl>/send`） |
| `template` | `txt` | PushPlus 模板：`txt`、`html`、`markdown` |
| `defaultTitle` | `DeepSeek Harness` | 默认消息标题 |
| `requestTimeoutMs` / `toolTimeoutMs` | `15000` / `60000` | 单目标超时与工具整体超时 |
| `titleMaxChars` / `contentMaxChars` | `100` / `4000` | 标题与正文字符上限 |

推送目标保存在凭据库 `notify/<目标名>`（目标名须匹配 `^[a-z][a-z0-9-]{0,31}$`），可在「插件 → 通知」页面添加、替换、删除或发送测试通知。

## 失败码

未配置目标返回顶层 `error.code = not_configured`；正文为空返回 `invalid_content`；部分或全部目标失败时在 `failures[].code` 中报告：`rejected`（PushPlus 返回 `code != 200`）、`http_status`、`invalid_response`、`request_failed`、`aborted`、`unusable_target`。

## 测试

```sh
pnpm test
```

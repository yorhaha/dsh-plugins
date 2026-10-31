# dsh-bilibili

B 站本人账号数据插件：把观看历史、稍后再看、收藏、关注、我的动态抓取到本机，助手可以跨时间检索；插件页管理账号与抓取节奏。移植自 yorha 的 `core/yorha/connectors/bilibili`，接口白名单、WBI 签名、游标状态机与封闭错误码都保留，持久化改用 Harness 的存储与凭据 seam（不再依赖 Postgres）。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `bilibili_sync` | `datasets`（五个数据集之一或多个）、`backfill` | 后台任务 id 与逐数据集结果 |
| `bilibili_search` | `query`、`dataset`、`since`、`until`、`limit`、`offset` | 匹配总数与本页条目，附数据新鲜度 |
| `bilibili_item` | `id`（必填，搜索返回的 id） | 单条完整记录 |
| `bilibili_schedule` | `recreate` | 定时抓取任务的创建/重建结果 |

抓取每分钟产生几十次受限请求，因此 `bilibili_sync` 用 `ctx.jobs` 起后台任务并立刻返回 id，模型用 `job_output` 收结果（没有 job registry 时退化为同步执行）。`bilibili_search` 的结果带 `sync` 块（`lastRunAt` / `stale` / `running` / `authRequired`），状态直接出现在模型正在看的地方。

搜索对内存中的全部条目做一次扫描，匹配标题、正文、作者与上游字段（按 BV 号、UP 主都能搜到），支持数据集与时间范围过滤，按上游时间倒序。domain 层在 open 时把全部记录读进内存逐条校验，没有二级索引或全文索引；个人使用规模（几千到几万条）下扫描是毫秒级，启动校验耗时随条目数线性增长。`contentKey` 让同一内容的不同 `sourceId` 可被识别。

## 安装

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/bilibili
cd dsh-plugins/bilibili && pnpm install   # 依赖 dsh-storage-domain、dsh-credentials、zod
```

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accountId` | `default` | 凭据记录槽位，须匹配 `^[a-z][a-z0-9-]*$`；一个账号一个槽位 |
| `scheduleCron` | `0 9 * * *` | 定时抓取的 5 段 cron，按宿主时区求值 |
| `loginTimeoutSeconds` | `180` | 二维码有效期，最小 30 |

## 扫码登录

登录由 Host 侧完整驱动：申请二维码、轮询、校验会话、写入凭据。浏览器半边只接收用于渲染的 URL 与状态，页面中途关闭不影响登录。二维码由插件自带的编码器（`src/qr.js`，字节模式 / 纠错等级 M / 版本 1–10）生成 SVG data URL，没有引入第三方库。

## 失败码

`credential_unavailable`、`auth_required`、`risk_control`、`rate_limited`、`wbi_signature_failed`、`api_<code>`、`network_error`、`upstream_5xx`、`http_<status>`、`invalid_json`、`invalid_envelope`，以及游标状态机的 `history_cursor_stalled`、`history_backfill_cursor_stalled`、`dynamic_cursor_stalled`。

触发风控后按连续触发次数分别退避 6、24、72 小时；`429` 按 `Retry-After` 退避。退避期间同步被跳过并说明原因。

## 已知边界

- 上游由 B 站决定，字段与可用性随时变化；只读取白名单内的七个路径。
- `history` 是有损数据源（只提供最近窗口），补历史要靠 `backfill` 逐步推进；其余四个数据集随时可以重新获取完整快照。
- 收藏与关注有单次页数上限，没抓完时游标在下次继续，`snapshotComplete: false` 表示这次只得到有界快照。
- 凭据以明文保存在 `$DSH_HOME/.credentials.yaml`（0600，无加密、无 OS keychain），同机同用户的其他进程可以读取。
- 定时任务绑定会话：该会话被归档（并选择停止活动）时任务一并删除。
- `/api/plugin-bilibili` 是本机 HTTP 接口，挡不住同机其他进程；它不返回 cookie，能触发的只有「同步一次」「退出登录」「重建任务」。

## 测试

```sh
node tests/verify-behavior.mjs   # 离线：domain 提交与去重、搜索、输出 schema、桥分发、二维码结构
```

使用本地伪上游与临时目录，不读真实账号。先在本目录 `pnpm install`。

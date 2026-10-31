# dsh-plugins

一组 DeepSeek Harness 本地插件。每个子目录都是一个可以独立安装的 Cordis bundle：Host 侧注册工具、提示段或本地路由，部分插件还带浏览器半边（插件页、侧栏面板、行情卡）。

13 个 bundle，68 个 Host 工具，10 个浏览器半边。数据流只有两类：把本机数据整理成助手可以检索的语料，或者把公开上游的查询变成工具调用。除 `notify` 与 `outlook` 的发信外，插件不向外写入。

## 插件一览

| 目录 | 包名 | 界面名 | 工具 | 界面 | 说明 |
| --- | --- | --- | --- | --- | --- |
| [`bilibili`](./bilibili/) | `dsh-bilibili` | 哔哩哔哩 | 4 | 插件页 | 本人账号的观看历史、稍后再看、收藏、关注、动态；扫码登录与定时抓取 |
| [`deepxiv`](./deepxiv/) | `dsh-deepxiv` | DeepXiv | 2 | 插件页 | arXiv、bioRxiv、medRxiv、PMC 全文检索与按节精读 |
| [`file-memory`](./file-memory/) | `dsh-file-memory` | 记忆 | — | 侧栏 | 纯 Markdown 长期记忆；注入提示段，不注册工具 |
| [`full-access`](./full-access/) | `dsh-full-access` | 默认完全权限 | — | — | 只覆盖权限行的组合层补丁，没有执行代码 |
| [`notify`](./notify/) | `dsh-notify` | 通知 | 1 | 插件页 | PushPlus 推送到手机；`provide` 一个 `notify` 服务供其他插件投递 |
| [`outlook`](./outlook/) | `dsh-outlook` | Outlook 邮件 | 5 | 插件页 | 设备代码登录；邮件抓取到本机 SQLite 后检索；授予 `Mail.Send` 后可以按确认发信 |
| [`stock`](./stock/) | `dsh-stock` | 股票行情 | 13 | 侧栏 + 行情卡 | 沪深、港股、美股行情与 K 线、资金流、财务、榜单、新闻、宏观；自选股与持仓标记 |
| [`taobao`](./taobao/) | `dsh-taobao` | 网上购物助手 | 4 | — | 淘宝/天猫、京东、拼多多、苏宁、唯品会、抖音、快手七渠道比价 |
| [`user-todo`](./user-todo/) | `dsh-user-todo` | 日历与待办 | 5 | 侧栏 | 跨会话的个人待办，带月历与到期提醒；面板与工具共享同一份清单，提醒经 `notify` 推送 |
| [`v2ex`](./v2ex/) | `dsh-v2ex` | V2EX 查询 | 5 | — | 只读查询热门、最新、节点主题、主题详情与回复 |
| [`wechat`](./wechat/) | `dsh-wechat` | 微信 | 7 | 插件页 | 导入本机微信导出批次，建立 SQLite 语料后跨会话、跨时间检索 |
| [`xiaohongshu`](./xiaohongshu/) | `dsh-xhs-reader` | 小红书 | 10 | 插件页 | 本人 cookie 只读访问小红书：搜索、正文与图片、评论、用户主页与本地语料 |
| [`zhihu`](./zhihu/) | `dsh-zhihu` | 知乎 | 12 | 插件页 | 本人 cookie 只读访问知乎：热榜、问题、回答、文章、用户与评论 |

「插件页」指左侧栏「插件」中选中该 bundle 后显示的详情页；「侧栏」指从左侧栏直接打开的面板（记忆、自选股、日历与待办）。工具参数、返回值与失败码见各目录的 `README.md`。

插件之间只有一处数据耦合：`user-todo` 的到期提醒通过 `notify` 提供的服务投递，两边都不要求对方存在——没有 `notify` 的时候提醒只记录在本地。

## 安装

前置条件：

- DeepSeek Harness `0.2.1-rc.3` 发布线（按 `@deepseek-ai/cordis ^4.0.1` 编写）；更新的运行线同样可以运行，`0.2.2-alpha.2` 实测可用。
- Node.js 22.5+（`outlook`、`wechat`、`xiaohongshu` 使用 `node:sqlite`），pnpm 10+。

安装一个插件，二选一：

1. 由助手调用 `plugin_manager`，`action: install_bundle`，`target` 传插件目录的绝对路径。
2. `dsh plugin --profile <profile> add /绝对路径/dsh-plugins/<插件>`。`dsh` 不在 PATH 中时用第一种。

安装会把插件目录作为 `link:` 依赖写入 profile 的 `package.json` 并加入 bundle 列表；插件自己的 `cordis.patch.yml` 负责把它的行带入 Loader。卸载用 `plugin_manager` 的 `remove_bundle`（`target` 传包名）或 `dsh plugin --profile <profile> remove <包名>`；插件留下的本机数据不会自动删除。

有运行时依赖的 9 个插件（`bilibili`、`deepxiv`、`notify`、`outlook`、`stock`、`user-todo`、`wechat`、`xiaohongshu`、`zhihu`）各自是独立工程，需要先在各自目录 `pnpm install` 一次。依赖都来自 npm：`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-storage-domain`（`0.2.1-rc.3`）、`@deepseek-ai/schemastery`（`~3.18.5`）、`@azure/msal-node`（`7.0.1`）、`zod`（`4.4.3`）。`file-memory`、`full-access`、`taobao`、`v2ex` 没有运行时依赖；`taobao`、`v2ex` 的测试需要 `@deepseek-ai/dsh-tools`，也要 `pnpm install` 一次。

## 目录约定

| 路径 | 作用 |
| --- | --- |
| `index.js` | Host 入口：`inject` 声明依赖，`apply` 注册工具、路由或提示段 |
| `src/` | Host 侧实现 |
| `client.js` 或 `web/client.js` | 浏览器半边，由 `package.json` 的 `dsh.client` 声明 |
| `locale/zh.json`、`locale/en.json` | 插件页标题、描述与界面文案 |
| `cordis.patch.yml` | 装载行；只写入本部署真正的覆盖 |
| `tests/` | 离线校验与本地挂载检查 |
| `icon.svg`、`README.md` | 图标；该插件的工具、配置与边界 |

`full-access` 只有 patch、locale 与 icon；`taobao`、`v2ex` 没有 `src/` 和浏览器半边。根目录的 `shared/` 存放共用代码：`schedule.js`（三个定时抓取任务的适配器）、`http.js`（请求串行、最小间隔、退避、响应体上限与失败载荷）、`route.js`（`/api` 路由样板与错误码）。bundle 以 `../../shared/...` 引用它，单独复制一个插件目录出去会丢失这个依赖；需要单独分发时把对应文件复制回插件目录。

## 配置

每个插件的 `cordis.patch.yml` 描述它如何进入 Loader，行中只写入本部署真正的覆盖；默认值只有一份，位于插件代码中。要修改时在 profile 的 `cordis.patch.yml` 里按行 `id` 覆盖：

```yaml
- id: stock
  config:
    watchlistMaxEntries: 20
    panelRefreshMs: 0
```

按 `id` 的覆盖会整体替换该行的 `config`，不做深合并：没写入的字段回到默认值。多数插件在加载时校验配置，未知字段、相对路径、越界值会导致加载失败。

密钥不写入配置。`deepxiv` 的 token、`notify` 的目标 token，以及 `bilibili`、`outlook`、`zhihu`、`xiaohongshu` 的登录态保存在凭据库（`~/.dsh/.credentials.yaml`，0600，明文）中，在各自的插件页录入。

## 数据落在哪

`$DSH_HOME` 默认是 `~/.dsh`。下列文件都没有加密存储。

| 插件 | 位置 | 形态 |
| --- | --- | --- |
| `bilibili` | `$DSH_HOME/storages/bilibili/` | 每条记录一个 JSON |
| `outlook` | `$DSH_HOME/storages/outlook/outlook.db` | SQLite + FTS5 |
| `stock` | `$DSH_HOME/storages/stock.json` | JSON |
| `user-todo` | `$DSH_HOME/storages/user_todo.json` | JSON |
| `wechat` | `$DSH_HOME/wechat/wechat.db`、`$DSH_HOME/wechat/batches/` | SQLite + 原始批次 |
| `xiaohongshu` | `$DSH_HOME/storages/xiaohongshu/` | SQLite + 下载图片 |
| `file-memory` | `$DSH_HOME/memory/` | Markdown |
| `zhihu` | `$DSH_HOME/.credentials.yaml` 的 `zhihu/default` | YAML 明文 cookie |
| 其余 | 不落盘 | 进程内状态，重启即清 |

`deepxiv`、`notify`、`taobao`、`v2ex` 不缓存任何上游内容；`bilibili`、`outlook`、`wechat` 的语料与批次，以及 `xiaohongshu` 的语料与图片，需要由你自行清理。

## 测试

带 `scripts.test` 的插件在各自目录运行 `npm test`。全部离线：不读本机账号，不访问上游。

- `taobao`、`v2ex` 没有 `scripts.test`，手动运行 `node tests/verify-behavior.mjs`。
- `full-access` 没有测试；用 `dsh --profile <profile> --dump-config` 检查 `sandbox-policy`、`approval`、`permission` 三行。

根目录两个脚本校验浏览器半边，可带插件名只查一个：

```sh
node verify-client-locales.mjs [插件]    # 中英词典键集合一致，每个 t(...) 都有文案
node verify-client-datetime.mjs [插件]   # 只允许 24 小时制，不出现 AM/PM 或英文月名
```

## 修改后立即生效

profile 的 `hmr` 行把 `base` 指向本目录后，修改源码会被就地重载：

```yaml
- id: hmr
  config:
    base: /路径/dsh-plugins
    root:
      - .
```

`base` 必须是本目录。默认的 `**/node_modules` 排除规则依赖相对路径，若把 profile 目录作为 base，watcher 会沿链接的 `node_modules` 一直遍历，最终以 EMFILE 退出。

| 改动 | 生效方式 |
| --- | --- |
| `index.js`、`src/*.js`、`client.js`、`shared/*.js` | 保存后 HMR 重载；浏览器半边由客户端图推送替换 |
| profile 的 `package.json`、profile 与 `$DSH_HOME` 的 `cordis.patch.yml` | 重新组合 |
| 插件自己的 `cordis.patch.yml`、新增或升级的依赖 | 需要重启（`node_modules` 不被监视） |
| DSH 本体的 `lib/` | 重新构建并重启 |

热重载成功时 stderr 无输出；失败时写入 `failed to reload plugin at …` 与原因。入口停留在 `waiting for service: …` 说明组合缺少服务，与 HMR 无关。

由 launchd 托管时（`~/Library/LaunchAgents/com.dsh.web.plist`）重启：`launchctl kickstart -k gui/$(id -u)/com.dsh.web`。同一端口不要再启动第二个实例。

排障：stderr 出现 `disabling profile plugin row "<id>": … incompatible with dsh <version>`，说明该行解析到了 profile 中旧版本的 `@deepseek-ai/dsh-*` 副本；按提示用 `dsh plugin --profile <profile> allow-version …` 放行，或把那份副本从 profile 依赖中移除后重启。

## 安全与边界

- 仓库中没有真实凭据，测试中的 `sk-live-value-001` 等都是假值。
- 插件页是本机 HTTP 接口，位于 `/api/...` 下。Harness 的 Host/Origin 围栏与浏览器鉴权在进入处理函数前已经执行，但无法阻止同机其他进程。
- 向外写入只发生在少数位置：`notify` 发送消息，`outlook` 授予 `Mail.Send` 后按确认发信，`full-access` 取消文件围栏并关闭审批。其余插件只读上游、只写本机。
- 外部内容属于数据，不能当作指令。论文、帖子、行情、邮件、微信消息都会进入模型上下文；各插件在自己的工具描述中标注了这一点。
- 定时任务绑定会话。`bilibili`、`outlook`、`wechat` 的抓取任务属于创建它的会话，在「自动化任务」中删除后不会自动恢复，三个插件页都提供「重建」入口。
- `wechat` 只读导出批次。导出器是另一个项目，需要写入 `--format jsonl`；插件不驱动导出器，也不修改微信数据。
- 行情不构成投资建议，`stock` 的值是上游最后一次返回的快照，可能延迟、过期或不一致。

## 许可证

MIT，详见 [LICENSE](LICENSE)。

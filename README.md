# dsh-plugins

DeepSeek Harness 的本地插件集合。每个子目录是一个可独立安装的 Cordis 插件（bundle）：Host 侧注册工具、提示段或本地路由，部分还带回浏览器半边（插件页、侧栏面板、行情卡）。

13 个 bundle 合计 **67 个 Host 工具**、**10 个浏览器半边**。数据方向只有两种：把本机数据变成助手能检索的语料，或把公开上游的查询变成工具调用；除 `notify` 外不向外部写入。

## 插件一览

| 目录 | 包名 | 界面名 | 工具 | 界面 | 说明 |
| --- | --- | --- | --- | --- | --- |
| [`bilibili`](./bilibili/) | `dsh-bilibili` | 哔哩哔哩 | 4 | 插件页 | 本人账号的观看历史、稍后再看、收藏、关注、动态；扫码登录与定时抓取 |
| [`deepxiv`](./deepxiv/) | `dsh-deepxiv` | DeepXiv | 2 | 插件页 | arXiv、bioRxiv、medRxiv、PMC 的全文检索与按节精读 |
| [`file-memory`](./file-memory/) | `dsh-file-memory` | 记忆 | — | 侧栏 | 纯 Markdown 长期记忆；注入提示段，侧栏浏览与编辑，不注册工具 |
| [`full-access`](./full-access/) | `dsh-full-access` | 默认完全权限 | — | — | 只覆盖权限行的组合层补丁，没有代码；新会话以「完全权限」启动 |
| [`notify`](./notify/) | `dsh-notify` | 通知 | 1 | 插件页 | 通过 PushPlus 推送到手机；任意多个目标，逐个投递；`provide` 一个 `notify` 服务供其他插件投递 |
| [`outlook`](./outlook/) | `dsh-outlook` | Outlook 邮件 | 4 | 插件页 | 设备代码登录；邮件抓进本机 SQLite 后按时间与文本检索 |
| [`stock`](./stock/) | `dsh-stock` | 股票行情 | 13 | 侧栏 + 行情卡 | 沪深、港股、美股行情与 K 线、资金流、财务、榜单、新闻、宏观；自选股与持仓标记 |
| [`taobao`](./taobao/) | `dsh-taobao` | 网上购物助手 | 4 | — | 淘宝/天猫、京东、拼多多、苏宁、唯品会、抖音、快手七渠道比价 |
| [`user-todo`](./user-todo/) | `dsh-user-todo` | 日历与待办 | 5 | 侧栏 | 跨会话的个人待办，带月历与到期提醒；面板与五个工具共享同一份清单（含删除与「清除已完成」），提醒经 `notify` 推送 |
| [`v2ex`](./v2ex/) | `dsh-v2ex` | V2EX 查询 | 5 | — | 只读查询热门、最新、节点主题、主题详情与回复 |
| [`zhihu`](./zhihu/) | `dsh-zhihu` | 知乎 | 12 | 插件页 | 用本人 cookie 只读知乎：热榜、问题、回答、文章、用户、评论；请求串行、限速、预算与风控暂停 |
| [`wechat`](./wechat/) | `dsh-wechat` | 微信 | 7 | 插件页 | 导入本机微信导出批次，建 SQLite 语料库后跨会话、跨时间检索 |
| [`xiaohongshu`](./xiaohongshu/) | `dsh-xhs-reader` | 小红书 | 10 | 插件页 | 用本人 cookie 只读小红书：搜索、笔记正文与图片下载、评论、用户主页与本地语料；低频预算与风控暂停 |

「插件页」指左侧栏「插件」里选中该 bundle 后的详情页；「侧栏」指左侧栏直接打开的面板，三个入口分别叫「记忆」「自选股」「日历与待办」。每个工具的参数、返回与失败码见该目录下的 `README.md`。

插件之间只有一处数据耦合：`user-todo` 的到期提醒通过 `notify` 提供的服务投递，两边都不依赖对方一定存在——没装 `notify` 时提醒只记账。

## 安装

### 前置条件

- DeepSeek Harness `0.2.1-rc.3` 发布线（插件按 `@deepseek-ai/cordis ^4.0.1` 编写）。更新的运行线也能跑：`@deepseek-ai/dsh-*` 服务按名字注入，插件自己那份依赖只提供工具函数；`0.2.2-alpha.2` 实测可用。
- Node.js 22.5+。`outlook`、`wechat` 与 `xiaohongshu` 用 `node:sqlite`；`outlook` 与 `wechat` 的测试用 `node --test`；Harness 自带的运行时已满足。
- pnpm 10+，用于安装插件目录里的依赖。

### 装一个插件

任选一种：

1. 在 Harness 里让助手调用 `plugin_manager`，`action: install_bundle`，`target` 传插件目录的绝对路径。
2. 命令行：`dsh plugin --profile <profile> add /绝对路径/dsh-plugins/<插件>`。`<profile>` 是 profile 名（如 `web`、`desktop`）；`dsh` 不在 PATH 上时用第一种。

一次装全本仓库的 13 个 bundle（装到哪个 profile 就只在该 profile 生效）：

```sh
dsh plugin --profile web add \
  /路径/dsh-plugins/bilibili /路径/dsh-plugins/deepxiv /路径/dsh-plugins/file-memory \
  /路径/dsh-plugins/full-access /路径/dsh-plugins/notify /路径/dsh-plugins/outlook \
  /路径/dsh-plugins/stock /路径/dsh-plugins/taobao \
  /路径/dsh-plugins/user-todo /路径/dsh-plugins/v2ex /路径/dsh-plugins/zhihu \
  /路径/dsh-plugins/wechat /路径/dsh-plugins/xiaohongshu
```

一条 `pnpm add` 里写完，bundle 列表按命令里的顺序追加；路径也可以写成相对于执行目录的 `../dsh-plugins/<插件>`，`dsh plugin` 会按执行目录展开。`full-access` 会把新会话的默认权限改成完全访问并关闭审批（见[安全与边界](#安全与边界)），不需要它就从这条命令里去掉。

安装会把插件目录作为 `link:` 依赖写进该 profile 的 `package.json`，并加入 bundle 列表；插件自己的 `cordis.patch.yml` 负责把它的行带进 Loader。Host 侧立即挂载；浏览器半边（`client.js` / `web/client.js`）是逐字下发的经典脚本、不参与 Web 产物打包，运行中的实例重组合后由 `dsh-client-hmr` 把新的客户端图推给已打开的页面。

卸载用 `plugin_manager` 的 `remove_bundle`（`target` 传包名），或 `dsh plugin --profile <profile> remove <包名>`；插件留下的本机数据不会自动删除。

### 装依赖

有运行时依赖的 9 个插件各自是独立工程（自带 `pnpm-workspace.yaml` 与 lockfile），先在目录里装一次：

```sh
cd /路径/dsh-plugins
for plugin in bilibili deepxiv notify outlook stock user-todo wechat xiaohongshu zhihu; do
  (cd "$plugin" && pnpm install)
done
```

运行时依赖都来自 npm：

| 包 | 版本 | 用到的插件 |
| --- | --- | --- |
| `@deepseek-ai/dsh-credentials` | `0.2.1-rc.3` | bilibili、deepxiv、notify、outlook、zhihu、xiaohongshu |
| `@deepseek-ai/dsh-storage-domain` | `0.2.1-rc.3` | bilibili、stock、user-todo |
| `@deepseek-ai/schemastery` | `~3.18.5` | outlook、wechat |
| `@azure/msal-node` | `7.0.1` | outlook |
| `zod` | `4.4.3` | bilibili、stock、user-todo |

`file-memory`、`full-access`、`taobao`、`v2ex` 没有运行时依赖。其中 `taobao`、`v2ex` 跑测试时要用 `@deepseek-ai/dsh-tools`，所以也要在各自目录 `pnpm install` 一次；`file-memory` 的测试只用 `node --test`，不装依赖也能跑。

测试与浏览器校验另用 `@deepseek-ai/dsh-tools@0.2.1-rc.2`、`@deepseek-ai/dsh-credentials-local@0.2.1-rc.3`、React 18、jsdom 与 `@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.3`；它们按需出现在各目录的 devDependencies 里，不随插件加载。

`node_modules/` 不纳入版本控制（见 `.gitignore`）。

## 目录约定

| 路径 | 作用 |
| --- | --- |
| `index.js` | Host 入口：导出 `inject` 声明依赖，`apply` 注册工具、路由或提示段 |
| `src/` | Host 侧实现 |
| `client.js` 或 `web/client.js` | 浏览器半边，由 `package.json` 的 `dsh.client` 声明 |
| `locale/zh.json`、`locale/en.json` | 插件页标题、描述与界面文案 |
| `cordis.patch.yml` | 装载行；只写本部署真正的覆盖，其余键的默认值在代码里 |
| `package.json` | 包名、`dsh.bundle.patch` 与 `dsh.client` 声明、依赖 |
| `tests/` | 离线校验与本地挂载检查 |
| `icon.svg` | 插件图标 |
| `README.md` | 该插件的工具、配置与边界 |

不是每个目录都有全部文件：`full-access` 只有 patch、locale 与 icon；`taobao`、`v2ex` 没有 `src/` 和浏览器半边。

仓库根目录还有一个 `shared/`，放的是多个 bundle 共用的 Host 侧代码：`schedule.js`（bilibili、outlook、wechat 的“定时任务”适配器只差几个字符串）、`http.js`（taobao、v2ex 的请求串行、最小间隔、退避、响应体上限与失败载荷；zhihu 复用其中的请求节奏、响应体读取、文本截断与失败载荷，xiaohongshu 复用响应体读取、重试等待与失败载荷；端点、状态阶梯与成功解析仍各自留在插件里）与 `route.js`（所有带页面的 bundle 共用的 JSON 路由样板：`sendJson` 的固定响应头、`errorCode` 的封闭错误码、`readJsonBody` 的上限读取，以及各 bundle 用来生成自有表单错误的 `defineCodeError`；`file-memory` 只用 `sendJson`，因为它的读取还要认 `content-length`。`readJsonBody` 的上限按 UTF-16 码元计而非字节。路由路径、动作表和“哪些错误码算调用方的错”仍各自留在插件里）。bundle 用相对路径 `../../shared/...` 引它，所以**单独复制一个插件目录出去会丢掉这个依赖**；这些包本来就用 `link:` 从本仓库安装，路径成立。真要单独分发时，把 `shared/` 里对应的文件复制回插件里即可。

## 配置

每个插件自带的 `cordis.patch.yml` 描述它如何进入 Loader：多数是一行 `insert`，`full-access` 是三行覆盖。行里**只写这个部署真正的覆盖**：默认值只有一份，在插件代码里（`index.js` / `src/config.js` 的默认配置）。要改，在 profile 的 `cordis.patch.yml` 里按行 `id` 覆盖：

```yaml
- id: stock
  config:
    watchlistMaxEntries: 20
    panelRefreshMs: 0
```

按 `id` 的覆盖会整体替换该行的 `config`，不是深合并：没写的字段回到插件自己的默认值，必填项缺失则由插件在加载阶段报错。所以覆盖时只需要写要改的键，其余交给默认值。多数插件在加载时校验配置，未知字段、相对路径、越界的值会让加载失败，而不是静默退回默认值；`user-todo` 与 `file-memory` 是例外——它们自带的 patch 里保留了整块配置（前者要求行里必须有 `config`，后者的 `root` 用 `!!js` 指明记忆目录）。

**密钥不写在配置里。** `deepxiv` 的 token、`notify` 的目标 token、`bilibili`、`outlook`、`zhihu` 与 `xiaohongshu` 的登录态存在 Harness 的凭据库（`~/.dsh/.credentials.yaml`，0600）。它们的录入都在各自的插件页完成。

## 数据落在哪

`$DSH_HOME` 默认是 `~/.dsh`。下列文件都不是加密存储，备份或共享目录前请自行判断。

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

`deepxiv`、`notify`、`taobao`、`v2ex` 不缓存任何上游内容；`bilibili`、`outlook`、`wechat` 的语料与批次、`xiaohongshu` 的语料与图片由你自己清理。

## 测试

有 `scripts.test` 的插件在自己的目录里跑 `npm test`：

```sh
cd bilibili && npm test
```

所有 `npm test` 都离线，不读本机账号、不访问上游：

- `stock`、`user-todo` 的脚本还包含浏览器半边的本地挂载检查。
- `taobao`、`v2ex` 没有 `scripts.test`，手动跑 `node tests/verify-behavior.mjs`。
- `full-access` 没有测试；它只是 patch，用 `dsh --profile <profile> --dump-config` 检查 `sandbox-policy`、`approval`、`permission` 三行。

仓库不再保留联网校验（`verify-live.mjs`）：它们需要真实账号、本机导出批次或凭据，缺条件时只会自跳过，无法作为回归门槛；上游契约仍由各插件的离线行为脚本用录制值或本地伪上游固定。

`tests/` 里的 schema 校验来自 npm 上的 `@deepseek-ai/dsh-tools`（devDependency），不需要同级存在 `deepseek-harness` checkout；目录里没有 `node_modules` 时先 `pnpm install`。`stock` 与 `user-todo` 的浏览器测试还用到 React、ReactDOM 与 jsdom，同样来自各自的 devDependencies。

`verify-client-locales.mjs` 校验每个浏览器半边的中英词典：两边键集一致，且每个 `t(...)` 都有文案。根目录直接跑会遍历所有带浏览器半边的插件，也可以只查一个：

```sh
node verify-client-locales.mjs
node verify-client-locales.mjs stock
```

`verify-client-datetime.mjs` 校验浏览器半边怎么显示时间：不许调用 `toLocaleDateString` / `toLocaleTimeString`，也不许用带日期字段的 `toLocaleString` 或 `Intl.DateTimeFormat`（区域决定时钟，`en-US` 会带回 AM/PM）；每个插件的时间格式化函数会被抽出来实跑，要求中文和英文页面都输出 24 小时制、不出现 AM/PM 或 `Oct` 这类英文月名。数值格式化（`toLocaleString` 只带小数位选项）不在此列。每个带浏览器半边的插件都登记在脚本的 `TARGETS` 或 `NO_TIMES` 里，新加时间显示却忘了登记会直接失败。

```sh
node verify-client-datetime.mjs
node verify-client-datetime.mjs notify
```

## 改完即生效

### 让 profile 监视本目录

profile 的 `hmr` 行把 `base` 指向本目录后，改源码会被就地重载，不必重启：

```yaml
- id: hmr
  config:
    base: /路径/dsh-plugins
    root:
      - .
```

`base` 必须是本目录。`hmr` 默认的 `**/node_modules` 排除规则依赖相对路径；若以 profile 目录为 base，每条被监视路径都会带上 `..` 前缀而匹配不到，watcher 会顺着链接的 `node_modules` 一路遍历，最终以 EMFILE 退出，表现是热重载静默失效。

这条 `cordis.patch.yml` 改动本身也不用重启：运行中的实例监视 profile 的补丁与 `package.json`，重组合后就带着新的 `base` / `root` 生效。

### 什么会热更新

| 改动 | 生效方式 |
| --- | --- |
| `index.js`、`src/*.js`、`client.js`、`web/client.js`、`shared/*.js` | 保存后由 HMR 重载；浏览器半边经客户端图推送换成新 bundle，不重建产物 |
| profile 的 `package.json`（bundle 列表）、profile 与 `$DSH_HOME` 的 `cordis.patch.yml` | 重组合 |
| 插件自己的 `cordis.patch.yml`（行配置）、插件目录里新装或升级的依赖 | 需要重启；`node_modules` 不被监视。行配置也可以不重启：在插件页拨一下任意开关触发一次重组合，就会重读各 bundle 的补丁 |
| DSH 本体的 `lib/` | 需要重新构建并重启；HMR 把宿主依赖的改动算作待重启 |

热重载成功时 stderr 没有输出；失败会写 `failed to reload plugin at …` 与原因，随后的下一次改动会再导入一次修正后的文件。入口停在 pending（`waiting for service: …`）是组合缺服务，不是 HMR 的问题。

### 验证

```sh
# 1. 组合里有这一行，且插件行都在
dsh --profile web --dump-config | grep -A4 'id: hmr'
# 2. Host 半边挂上了：带启动 cookie 访问插件路由，200 并返回真实数据
curl -s -b cookie.txt http://127.0.0.1:38922/api/plugin-stock/watchlist
# 3. 浏览器半边在客户端图里：取服务启动输出里的 ?token= 换 cookie，读第一帧 graph
curl -s -b cookie.txt -N --max-time 3 http://127.0.0.1:38922/plugins/events
```

`/plugins/events` 的 `entries` 里应当有 10 个带界面的包名（`dsh-bilibili`、`dsh-deepxiv`、`dsh-file-memory`、`dsh-notify`、`dsh-outlook`、`dsh-stock`、`dsh-user-todo`、`dsh-wechat`、`dsh-zhihu`、`dsh-xhs-reader`）；`taobao`、`v2ex`、`full-access` 没有浏览器半边，不在其中。

要确认 Host 侧真的换成了新代码，给某个插件路由的返回值临时加一个字段：保存后几秒内接口就带上它，删掉后几秒又消失。这条链路上没有缓存，撤掉探测字段就是最终状态。

### 重启

launchd 托管时（`~/Library/LaunchAgents/com.dsh.web.plist`，日志在其 `StandardOutPath` / `StandardErrorPath`）：

```sh
launchctl kickstart -k gui/$(id -u)/com.dsh.web
```

手动前台跑的实例 Ctrl-C 后重新起即可。同一个端口不要再起第二个实例，它会以 `EADDRINUSE` 退出。

### 排障

stderr 出现 `disabling profile plugin row "<id>": … incompatible with dsh <version>`，说明该行解析到了 profile 里旧版本的 `@deepseek-ai/dsh-*` 副本（常见于别的 bundle 把 `@deepseek-ai/dsh-storage-domain` 之类作为依赖一起装进 profile）。按提示用 `dsh plugin --profile <profile> allow-version <包名>@<版本> --dsh-version <版本> --accept-risk` 放行，或把那份副本从 profile 依赖里去掉后重启。

## 安全与边界

- **仓库里没有真实凭据。** 测试中出现的 `sk-live-value-001`、`ghp_example_value` 等都是假值；真实的 key 请放进凭据库，不要提交。
- **凭据存储。** `deepxiv`、`notify`、`bilibili`、`outlook`、`zhihu`、`xiaohongshu` 的凭据在 `~/.dsh/.credentials.yaml`（0600，明文）；其余插件的数据也不加密。
- **插件页是本机 HTTP 接口。** 它们挂在 `/api/...` 下，Harness 的 Host/Origin 围栏与浏览器鉴权在进入处理函数前已经跑过，但挡不住同机其他进程。`deepxiv`、`notify` 的页面按设计明文显示自己的 token，方便复制。
- **向外写入只发生在少数地方。** `notify` 发消息；`full-access` 取消文件围栏并关闭审批，只应在自己信任的机器与工作目录上启用。其余插件只读上游、只写本机。
- **推广披露。** `taobao` 默认不附带 `inviteCode`，结果里的 `affiliate` 字段为 `null`；只有你显式配置自己的推广码后，购买链接才带推广参数并给出披露。
- **外部内容是数据，不是指令。** 论文、帖子、行情、邮件、微信消息都会进入模型上下文；各插件在自己的工具描述里标注了这一点。
- **定时任务绑定会话。** `bilibili`、`outlook`、`wechat` 的抓取任务属于创建它的会话；在「自动化任务」里删掉后不会自动恢复，三个插件页都提供「重建」入口（`wechat` 也可以让助手调 `wechat_schedule`，`recreate: true`）。
- **`wechat` 只读导出批次。** 导出器（`export.py`）是另一个项目，必须写 `--format jsonl`；插件不驱动导出器，也不修改微信数据。
- **行情不构成投资建议。** `stock` 的值是上游最后一次返回的快照，可能延迟、过期或不一致，覆盖率也不完整。

## 许可证

MIT，详见 [LICENSE](LICENSE)。

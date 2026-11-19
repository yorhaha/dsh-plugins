# dsh-plugins

一组 DeepSeek Harness 本地插件，包含 14 个独立安装的 Cordis bundle，覆盖信息同步、内容检索、个人待办、通知推送与界面扩展。

## 插件一览

| 目录 | 包名 | 界面名称 | 工具数 | 界面位置 | 说明 |
| --- | --- | --- | --- | --- | --- |
| [`bilibili`](./bilibili/) | `dsh-bilibili` | 哔哩哔哩 | 4 | 插件页 | 同步 B 站观看历史、收藏与动态到本地检索 |
| [`deepxiv`](./deepxiv/) | `dsh-deepxiv` | DeepXiv | 2 | 插件页 | 检索并精读 arXiv、bioRxiv、medRxiv 与 PMC 论文 |
| [`file-memory`](./file-memory/) | `dsh-file-memory` | 记忆 | — | 左侧栏 | 使用 Markdown 文件保存与编辑长期记忆 |
| [`full-access`](./full-access/) | `dsh-full-access` | 默认完全权限 | — | — | 新建会话默认启用「完全权限」预设 |
| [`magpie-quota`](./magpie-quota/) | `dsh-magpie-quota` | Magpie 额度 | — | 右侧栏 | 在右侧栏显示 Magpie 额度（依赖 `dsh-better-sidebar`） |
| [`notify`](./notify/) | `dsh-notify` | 通知 | 1 | 插件页 | 通过 PushPlus 推送消息到手机，并提供 `notify` 服务 |
| [`outlook`](./outlook/) | `dsh-outlook` | Outlook 邮件 | 5 | 插件页 | 同步 Outlook 邮件到本地检索，支持确认发信 |
| [`stock`](./stock/) | `dsh-stock` | 股票行情 | 12 | — | 查询沪深、港股、美股行情、财务、新闻与宏观数据 |
| [`taobao`](./taobao/) | `dsh-taobao` | 网上购物助手 | 4 | — | 比对淘宝、京东、拼多多等平台商品价格 |
| [`user-todo`](./user-todo/) | `dsh-user-todo` | 日历与待办 | 5 | 左侧栏 | 跨会话个人待办清单与月历，支持到期推送 |
| [`v2ex`](./v2ex/) | `dsh-v2ex` | V2EX 查询 | 5 | — | 查询 V2EX 热门、最新、节点主题与回复 |
| [`wechat`](./wechat/) | `dsh-wechat` | 微信 | 7 | 插件页 | 导入本机微信导出记录至 SQLite 以供检索 |
| [`xiaohongshu`](./xiaohongshu/) | `dsh-xhs-reader` | 小红书 | 10 | 插件页 | 搜索和阅读小红书笔记、评论与用户主页 |
| [`zhihu`](./zhihu/) | `dsh-zhihu` | 知乎 | 12 | 插件页 | 浏览知乎热榜、问题、回答、专栏文章与评论 |

- **插件页**：左侧栏「插件」中选中对应插件后显示的详情与设置页。
- **左侧栏**：直接从左侧栏打开的独立面板（记忆、日历与待办）。
- **右侧栏**：右侧标签栏页面（`magpie-quota` 依赖 `dsh-better-sidebar` 提供的扩展点）。

`user-todo` 的到期提醒可通过 `notify` 推送至手机，但两者互不强制依赖：未安装 `notify` 时提醒仅记录在本地。

## 安装

环境要求：
- DeepSeek Harness `0.2.1-rc.3` 及以上版本（`0.2.2-alpha.2` 实测兼容）
- Node.js 22.5+（`outlook`、`wechat`、`xiaohongshu` 使用内置 `node:sqlite`）
- pnpm 10+

安装方式（二选一）：

1. 让助手调用 `plugin_manager`，设置 `action: install_bundle`、`target` 为插件目录的绝对路径。
2. 命令行执行：
   ```sh
   dsh plugin --profile <profile> add /绝对路径/dsh-plugins/<插件>
   ```

卸载请使用 `plugin_manager` 的 `remove_bundle`（`target` 传包名）或执行 `dsh plugin --profile <profile> remove <包名>`。

`bilibili`、`deepxiv`、`notify`、`outlook`、`user-todo`、`wechat`、`xiaohongshu`、`zhihu` 包含运行时依赖，安装前需先进入各自目录运行一次 `pnpm install`；`stock`、`taobao`、`v2ex` 仅测试需要 `pnpm install`。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `index.js` / `src/` | Host 端入口与实现（注册工具、路由或提示词） |
| `client.js` / `web/client.js` | 前端界面脚本（由 `package.json` 的 `dsh.client` 声明） |
| `locale/zh.json`、`locale/en.json` | 插件名称与简介文案 |
| `cordis.patch.yml` | 插件装载配置 |
| `tests/` | 离线测试与本地检查脚本 |
| `shared/` | 跨插件共用模块（`http.js`、`route.js`、`schedule.js`） |
| `verify-client-locales.mjs`、`verify-client-datetime.mjs` | 前端文案与 24 小时制校验脚本 |

> 如需单独拷贝某个插件分发，请一并带上其引用的 `../../shared/...` 与根目录校验脚本。

## 配置

默认值均定义在各插件源码中。如需修改，在 profile 的 `cordis.patch.yml` 中按 `id` 覆盖即可：

```yaml
- id: stock
  config:
    watchlistMaxEntries: 20
```

按 `id` 覆盖会**整体替换**该行的 `config` 对象，未声明字段将使用默认值；非法配置会在加载时报错。密钥与登录态统一保存在凭据库（`$DSH_HOME/.credentials.yaml`，明文 YAML，`0600`），在各插件页录入。

## 本地数据位置

`$DSH_HOME` 默认为 `~/.dsh`。下列本地文件均未加密存储：

| 归属 | 路径 | 形式 |
| --- | --- | --- |
| `bilibili` | `$DSH_HOME/storages/bilibili/` | JSON 文件 |
| `outlook` | `$DSH_HOME/storages/outlook/outlook.db` | SQLite + FTS5 |
| `user-todo` | `$DSH_HOME/storages/user_todo.json` | JSON 文件 |
| `wechat` | `$DSH_HOME/wechat/wechat.db`、`$DSH_HOME/wechat/batches/` | SQLite + 导出批次 |
| `xiaohongshu` | `$DSH_HOME/storages/xiaohongshu/` | SQLite + 已下载图片 |
| `file-memory` | `$DSH_HOME/memory/` | Markdown 文件 |
| 登录态与 token | `$DSH_HOME/.credentials.yaml` | 明文 YAML（`0600`） |

## 测试

各插件目录下可运行离线测试（不访问真实账号与上游接口）：

```sh
npm test                          # 适用于配置了 test 脚本的插件
node tests/verify-behavior.mjs    # taobao、v2ex 手动运行
```

单独校验前端文案与时间格式：

```sh
node verify-client-locales.mjs [插件]
node verify-client-datetime.mjs [插件]
```

## 热重载与排障

在 profile 的 `hmr` 配置中将 `base` 设为本仓库目录后，修改源码保存即可自动重载（勿将 profile 目录设为 `base`，否则 watcher 会顺着软链 `node_modules` 递归遍历导致 EMFILE）：

```yaml
- id: hmr
  config:
    base: /路径/dsh-plugins
    root:
      - .
```

- 修改 `index.js`、`src/*.js`、`client.js`、`shared/*.js` 保存即热重载；修改 `cordis.patch.yml` 或新增依赖需重启。
- 若由 launchd 托管，可使用 `launchctl kickstart -k gui/$(id -u)/com.dsh.web` 重启。
- 若出现 `disabling profile plugin row "<id>": … incompatible with dsh <version>`，按提示执行 `dsh plugin --profile <profile> allow-version …` 或移除 profile 中的旧版本依赖后重启即可。

## 注意事项

- **写操作范围**：仅 `notify`（推送消息）、`outlook`（授权 `Mail.Send` 后按确认发信）和 `full-access`（放开文件权限与审批）会对外写入或放宽权限，其余插件均只读上游、只写本机。
- **定时任务**：`bilibili`、`outlook`、`wechat` 的抓取任务绑定到创建它的会话；在「自动化任务」中删除后需在对应插件页重新创建。

## 许可证

MIT，详见 [LICENSE](LICENSE)。

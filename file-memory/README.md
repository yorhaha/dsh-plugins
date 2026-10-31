# dsh-file-memory

纯文件系统的记忆：**纯 Markdown 文件，没有向量、没有索引、没有数据库。**

它服务两个对象：模型（一段常量提示段，说明目录在哪、怎么检索）和用户（一个记忆面板，浏览、编辑、新建、删除同一批文件）。它**不注册任何 agent 工具**——读写走 Harness 已有的 `read`、`write`、`edit`、`glob`、`grep`。

## 记忆放在哪

一个目录，默认 `$DSH_HOME/memory`（`~/.dsh/memory`），agent 与面板读写同一份。

默认值是绝对路径且位于 Harness home 下，所以无论从哪个目录启动、用哪个 profile，指的都是同一个目录。**相对路径的 `root` 在加载时被拒绝**：启动目录不是工作区，解析错了表现为「记忆是空的」，而不是报配置错误。

Harness home 下的记忆在会话工作区之外，因此在 `workspace-write` 预设下，agent 的每次写入都会先弹审批。把 `root` 指到项目目录可以保存项目记忆——工作区内的写入不需要审批。个人笔记不要放进别人也会提交的仓库。

两侧共用一个目录，所以注入的文本会告诉模型「用户也在编辑这些文件」；没有这句话，它会认为每个文件都是自己的，从而覆盖人的修改。

## 约定

不做强制，也不会有东西过期：一个 `.md` 一个主题，文件名用将来搜索时会想到的词，可以嵌套目录，不写 frontmatter，**不建索引文件**。

## 安装与配置

```bash
dsh plugin --profile web add /绝对路径/dsh-plugins/file-memory
dsh --profile web --dump-config    # 应列出 file-memory 行
```

所有取值都在行的 `config` 里；同名 patch **整体替换**这个块，所以要把每个字段都重述一遍：

```yaml
- id: file-memory
  name: dsh-file-memory
  config:
    enabled: true
    root: '/srv/shared/memory'
    maxDepth: 5
    maxFileBytes: 1048576
```

写错——未知键、空路径或相对路径、越界上限——**会让加载失败**，而不是退回默认值。

## 浏览器路由

```
GET  /api/plugin-file-memory/read?op=tree|file[&path=…]
POST /api/plugin-file-memory/mutate?op=write|mkdir|delete[&path=…]
```

面板用不了 Remote namespace（客户端 namespace 来自编译进 web app 的清单），所以走共享 `/api` 通道上的这两个固定路由——Harness 的 Host/Origin 围栏与浏览器鉴权在那里已经执行过。只有一个配置好的根，所以没有请求能挑目录；`root` 查询参数被忽略而不是被拒绝。

每个请求路径都不可信。`src/safe-path.js` 先用 `realpath` 把根与目标规范化再比对——只做字面检查不够：根内的软链会解析到根外，而字面上仍在根内。写入只允许 `.md`，受 `maxFileBytes` 约束，并经由目标旁的临时文件原子落盘。

删除会移除一个可见的 `.md` 文件，或一个只装着笔记的可见文件夹；删文件夹前先遍历整个文件夹，一旦里面有目录树没列出的东西（隐藏项、`node_modules`、软链、非 Markdown 文件）就拒绝，因此一次请求抹不掉面板从未展示过的内容。根、隐藏路径、非 Markdown 文件永远不会被删除。根不存在时在加载阶段创建。

## 测试

```bash
node --test "tests/*.test.mjs"
```

覆盖路径包含性（含软链逃逸）、两个路由的端到端、配置校验、注入文本，以及客户端 bundle 的注册契约。

## 限制

- **字面检索匹配不了改述**：「token 刷新有竞态」匹配不到「登录并发 bug」。注入文本要求模型换同义词重试——这是没有向量时唯一的缓解。
- **提示段只能告诉模型记忆存在，不能让它真的去查。** 会不会先搜索，取决于措辞。
- **没有并发写保护**：agent 与面板可能写同一个文件，后写的赢。面板没有重命名或移动，也不观察 agent 的写入（打开时与点刷新时才取）；没有撤销，也没有自己的版本控制。
- **装着非记忆内容的文件夹无法从面板删除**——删掉会抹去目录树从未展示的文件，所以路由以 `unlisted_content` 拒绝。
- **面板直接对 `node:fs` 说话**，不走 `ctx.fs`：配置的根可能在工作区之外，工作区作用域的文件系统服务够不到。
- **目录树响应没有体积保护**：深度上限限制的是层数，不是宽度。

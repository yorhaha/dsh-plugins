# dsh-file-memory

使用纯 Markdown 文件保存长期记忆，不依赖向量库或数据库。

插件由两部分组成：向模型注入提示词（告知记忆目录位置与搜索方式，读写直接复用 Harness 内置的 `read`、`write`、`edit`、`glob`、`grep`），并在左侧栏提供「记忆」面板用于浏览和编辑文件。

## 存储目录与使用约定

- 默认目录为 `$DSH_HOME/memory`（`~/.dsh/memory`），助手与侧栏面板读写同一份文件。
- 位于工作区外时，在 `workspace-write` 模式下助手写入会弹出审批；如需保存项目记忆，可将 `root` 配置为项目内的绝对路径。
- 建议一个主题一个 `.md` 文件，文件名使用便于检索的关键词，无需 frontmatter 或索引文件。

## 安装与配置

```bash
dsh plugin --profile web add /绝对路径/dsh-plugins/file-memory
```

可在 profile 的 `cordis.patch.yml` 中按 `id: file-memory` 整体覆盖 `config`（`root` 必须为绝对路径，非法配置会在加载时报错）：

```yaml
- id: file-memory
  name: dsh-file-memory
  config:
    enabled: true
    root: '/srv/shared/memory'
    maxDepth: 5
    maxFileBytes: 1048576
```

## 后端路由

- `GET /api/plugin-file-memory/read?op=tree|file[&path=…]`
- `POST /api/plugin-file-memory/mutate?op=write|mkdir|delete[&path=…]`

仅允许操作根目录内的 `.md` 文件（防止软链接逃逸）；删除文件夹时若内含隐藏文件、软链接或非 `.md` 文件，会返回 `unlisted_content` 拒绝删除。

## 测试

```bash
node --test "tests/*.test.mjs"
```

## 注意事项

- 字面检索依赖关键词匹配，提示词已引导模型在未命中时换用同义词重试。
- 暂无并发写锁及内置版本控制，面板也不会自动监听后台写入（需手动刷新）。

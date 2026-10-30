# dsh-full-access

让 DeepSeek Harness 的**新会话默认使用「完全权限」预设**：文件沙箱不再限制写入，审批提示关闭，需要审批的动作直接按拒绝处理。

它不动任何执行代码，只用一份组合包 patch 覆盖 base 组合包已经声明的三行配置。默认值属于配置，不属于新的运行时机制；`permission` 服务本来就有 `defaultPreset` 这个面向“后续会话默认值”的字段。

## 它改了什么

| 行 id | 字段 | 取值 | 作用 |
| --- | --- | --- | --- |
| `sandbox-policy` | `mode` | `danger-full-access` | 组合层默认文件策略，供无会话的调用与未显式选择的会话使用 |
| `approval` | `policy` | `never` | 没有会话级覆盖时的审批策略：不询问任何人，直接拒绝 |
| `permission` | `defaultPreset` | `danger-full-access` | 新会话创建时固定写入 `permission/preset`、`sandbox/mode`、`approval/policy` 三条事实 |
| `permission` | `presets` | 原样重述三项 | id 覆盖会整体替换 `config`，所以把 base 的只读、工作区写入、完全权限三项预设一并写回 |

三处默认值必须一起改：`permission.defaultPreset` 决定新会话固定写入哪套权限；`sandbox-policy.mode` 与 `approval.policy` 是没有会话级覆盖时的兜底——没有 agent 的调用会按它们解析，恢复出来的空白会话也在补写权限事实前先按它们推导预设。只改预设时普通新会话仍会拿到完全权限，但组合层默认值仍是 `workspace-write`，恢复的空白会话会因此停留在受限模式。

## 安装

已经装进 `web` profile 时，配置页的「插件」里会多出 `dsh-full-access` 这个组合包，启用状态即生效。

重新安装（例如换一台机器或重建 profile）：

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/full-access
```

或者在本仓库里让 Harness 自己装：`plugin_manager` 的 `install_bundle`，`target` 传这个包的绝对目录。装完新会话即按完全权限启动；已打开的会话不受影响。

## 改默认值或移除

- **只改当前 profile**：在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 覆盖同样的行。profile patch 在全部组合包之后应用，优先级更高；在设置页修改「默认权限」也会写到这一层，所以用户的选择始终压过本包。
- **换一个默认预设**：同时改上面三处（`sandbox-policy.mode`、`approval.policy`、`permission.defaultPreset`），并保证组合包里的预设表存在对应名字，否则 `permission` 服务在加载阶段就会报错，而不是悄悄退回某个默认值。
- **移除**：`plugin_manager` 的 `remove_bundle`，或 `dsh plugin --profile web remove dsh-full-access`。移除后新会话回到 base 的 `workspace-write` 默认。
- **环境变量**：本包整体替换了 base 里 `sandbox-policy` 与 `approval` 两行的 `config`，因此 base 用 `DSH_PERMISSION_MODE` 做的进程级兜底在这个 profile 里不再生效。要按次覆盖，用 `--patch` 或 profile patch。

## 安全边界

- 这个包**只影响本 profile 的新会话**。已有会话按自己的日志保留当时的选择，不会被改写；其他 profile 不受影响。
- 「完全权限」意味着文件写入不受会话工作区限制，且不再有人工审批兜底。请只在自己信任的机器与工作目录上使用。
- 包内没有 JavaScript、依赖或安装脚本，卸载不会留下运行时状态。

## 怎么验

1. `dsh --profile web --dump-config` 里三行的 `config` 应为上表的值。
2. 新建一个会话，日志最前面的会话事件应是：

   ```text
   permission/preset  {"preset":"danger-full-access"}
   sandbox/mode       {"mode":"danger-full-access"}
   approval/policy    {"policy":"never"}
   ```

3. 会话的系统提示里应出现 `Current DSH file policy: danger-full-access` 与“审批提示已关闭”的说明。

本包的显示元信息在 `locale/en.json` 与 `locale/zh.json`，图标是 `icon.svg`。

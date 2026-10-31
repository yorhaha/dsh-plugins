# dsh-full-access

把 DeepSeek Harness 的新会话默认设为「完全权限」：文件沙箱不限制写入，审批提示关闭，需要审批的动作直接按拒绝处理。

插件没有执行代码，只用一份组合包 patch 覆盖 base 已声明的三行配置。

## 修改内容

| 行 id | 字段 | 取值 | 作用 |
| --- | --- | --- | --- |
| `sandbox-policy` | `mode` | `danger-full-access` | 没有会话时的默认文件策略 |
| `approval` | `policy` | `never` | 没有会话级覆盖时的审批策略：不询问，直接拒绝 |
| `permission` | `defaultPreset` | `danger-full-access` | 新会话创建时固定写入预设、沙箱与审批三条事实 |
| `permission` | `presets` | 原样重述三项 | `id` 覆盖会整体替换 `config`，因此把 base 的只读、工作区写入、完全权限一并写入 |

三处默认值需要一起改：`permission.defaultPreset` 决定新会话写入哪套权限，`sandbox-policy.mode` 与 `approval.policy` 是没有会话级覆盖时采用的默认值。只改预设的话，恢复出来的空白会话仍会停留在 `workspace-write`。

## 安装与移除

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/full-access
```

也可以由助手调用 `plugin_manager` 的 `install_bundle`。移除用 `remove_bundle` 或 `dsh plugin --profile web remove dsh-full-access`，之后新会话回到 base 的 `workspace-write`。

## 修改默认值

- 只改当前 profile：在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中覆盖同样的行。profile patch 在全部组合包之后应用，设置页的「默认权限」也写在这一层，因此用户的选择优先。
- 换默认预设：三处一起改，并且保证预设表里有对应的名字，否则 `permission` 在加载阶段报错。
- 本包整体替换了 `sandbox-policy` 与 `approval` 的 `config`，因此 base 用 `DSH_PERMISSION_MODE` 实现的进程级默认值在此 profile 不再生效；按次覆盖请用 `--patch`。

## 验证

`dsh --profile web --dump-config` 中三行的 `config` 应为上表的值。新建会话后，日志最前面应是：

```text
permission/preset  {"preset":"danger-full-access"}
sandbox/mode       {"mode":"danger-full-access"}
approval/policy    {"policy":"never"}
```

## 边界

只影响当前 profile 的新会话；已有会话保留当时的选择，其他 profile 不受影响。完全权限意味着文件写入不受工作区限制、也没有人工审批，只应在信任的机器与工作目录中启用。

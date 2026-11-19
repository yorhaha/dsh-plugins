# dsh-full-access

将 DeepSeek Harness 新建会话的默认权限设为「完全权限」：放开文件沙箱写入限制并关闭审批提示。

本插件不含执行代码，仅通过 `cordis.patch.yml` 覆盖以下配置：

| 行 id | 字段 | 取值 | 说明 |
| --- | --- | --- | --- |
| `sandbox-policy` | `mode` | `danger-full-access` | 默认文件沙箱策略 |
| `approval` | `policy` | `never` | 默认审批策略（不弹窗） |
| `permission` | `defaultPreset` | `danger-full-access` | 新建会话默认预设 |
| `permission` | `presets` | 完整保留三套预设 | 按 `id` 覆盖会整体替换 `config`，需保留全部预设 |

## 安装与移除

```sh
dsh plugin --profile web add /绝对路径/dsh-plugins/full-access
dsh plugin --profile web remove dsh-full-access   # 移除后新会话恢复 workspace-write
```

安装后可执行 `dsh --profile web --dump-config` 验证上述三项配置是否生效。

## 说明

- 仅对当前 profile 的**新建会话**生效，已有会话及其他 profile 不受影响。
- 若需单独调整当前 profile，可在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中覆盖相同配置（或通过设置页「默认权限」修改）。
- 请仅在可信的本地环境与工作目录中启用完全权限。

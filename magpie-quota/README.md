# dsh-magpie-quota

在 DeepSeek Harness 右侧栏显示 Magpie 跟踪的各账号剩余额度与重置时间（只读展示，不向模型暴露工具，切换模型等操作仍在 Magpie 原应用中进行）。

## 使用说明

安装 `dsh-better-sidebar` 后添加本插件，即可在右侧栏 `+` 菜单或标签栏中找到「Magpie 额度」（ID：`dsh-magpie-quota`）。

- 界面仅展示存在额度窗口的账号；百分比向下截断至一位小数，进度条按剩余比例着色（≥50% 绿、20–50% 橙、<20% 红）。
- 清晰区分周期性额度的**重置时间**（`resetsAt`）与积分包的**过期倒计时**（`runsOutAt`）。
- 仅当标签页激活且右侧栏展开时每 60 秒向本机网关刷新一次；Magpie 未运行时顶部提示错误并保留缓存数据。

## 接口与错误码

Host 端读取 `~/.config/magpie/gateway.json` 中的端口并请求 `GET http://127.0.0.1:3425/v1/magpie/quotas`，前端通过 `GET /api/plugin-magpie-quota/quotas` 获取经裁剪的数据。

| 错误码 | HTTP 状态 | 说明 |
| --- | --- | --- |
| `unreachable` | 503 | 无法连接 Magpie 网关 |
| `timeout` | 504 | 请求超时 |
| `bad_status` | 502 | 上游返回非 2xx 状态码 |
| `bad_json` | 502 | 响应非有效 JSON |
| `too_large` | 502 | 响应体积超出 `maxBytes` |
| `bad_payload` | 502 | 响应缺少 `data` 数组 |

## 配置

可在 profile 的 `cordis.patch.yml` 中按 `id: magpie-quota` 覆盖 `config`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用路由 |
| `gateway` | `http://127.0.0.1:3425` | Magpie 网关地址（`http(s)`，不可带路径） |
| `timeoutMs` | `4000` | 请求超时上限（毫秒，100–30000） |
| `maxBytes` | `524288` | 响应字符上限（4096–4 MiB） |
| `hiddenWindows` | `['workbuddy/Total credits']` | 需隐藏的额度窗口，格式为 `provider/窗口名`（默认隐藏重复汇总项 `Total credits`） |

## 安装与测试

```bash
dsh plugin --profile <profile> add /绝对路径/dsh-plugins/magpie-quota
npm test
```

无外部运行时依赖，无需执行 `pnpm install`。

# GitHub 小红书 CLI / API 项目调研

> 调研时间 2026-10-31，Star 数为当日 GitHub API 快照。小红书没有官方开放 API，以下项目都是非官方实现，普遍存在违反平台协议、账号被风控或封禁的风险。

## 四条技术路线

| 路线 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A 纯 HTTP 逆向 + 本地签名 | 复刻 Web 端签名（`x-s`、`x-s-common`、`x-t`、`x-rap-param`），直接调 `edith.xiaohongshu.com/api/sns/web/v1/*` | 快、省资源、易容器化、语义清晰 | 签名随前端发版失效（406 / `code=-1`）；对账号权重与 IP 最敏感；验证码与限流自己处理 |
| B 浏览器自动化 | Playwright/Puppeteer 驱动真实页面 | 抗签名变化，发布类操作成功率高 | 重、慢、占资源 |
| C 浏览器插件 / 会话桥接 | 借用户已登录的浏览器 | 复用真实会话 | 依赖人工，难批量 |
| D 第三方商业 API | TikHub、JustOneAPI、Rnote API | 不用维护签名与账号 | 付费，合规需自行评估 |

另有特例：只解析 HTML/SSR 页面的下载器路线（`XHS-Downloader`）。

## 代表项目

| 类别 | 项目 | 备注 |
| --- | --- | --- |
| 综合 CLI | `jackwener/xiaohongshu-cli`（Python，2.7k）、`lucasygu/redbook`（TS，535） | 命令完整、JSON 输出；`redbook` 面向 Agent |
| 逆向底座 | `cv-cat/Spider_XHS`（8.3k）、`ReaJason/xhs`（2.2k）、`Cloxl/xhshow`（1.1k） | `xhshow` 只做签名，被多个 CLI 复用 |
| MCP / Agent 封装 | `jobsonlook/xhs-mcp`、`RedNote-MCP`、`catbus`、`Agent-Reach` | 2026 年新项目普遍自带 `SKILL.md`、JSON 输出 |
| 采集 / 下载 / 发布 | `JoeanAmier/XHS-Downloader`、`social-auto-upload` | 下载无水印内容最成熟 |
| 商业 API | `TikHub`、`JustOneAPI`、`Rnote API` | 开源算法引流到付费 API 是常见做法 |

## 与实现相关的几点

- **Cookie 是主要资产**：`a1`、`web_session`、`webId`、`gid`、`xsecappid` 都要保留，少字段会让请求更像脚本。
- **签名有两种格式**：2026 年 3 月后数据接口对旧的 `XYS_` 返回 406，需要 `XYW_`（AES-128-CBC）。见 `xhshow` issue #104。
- **`xsec_token` 最容易被忽略**：笔记详情的 URL 必须带它，裸 id 取不到内容。
- **风控信号**：461/471 验证页、429 限流、406 签名失效、`300011` 账号异常、`300012` IP 封禁。命中后应暂停而不是重试。
- **创作者平台是另一套**：`creator.xiaohongshu.com` 用 AES-128-CBC 的 `sign`/`q-signature`，与主站签名无关。

## 为什么最终没有包装现成 CLI

`redbook`、`xiaohongshu-cli` 都能完成搜索与阅读，但作为 DSH 插件直接包装有三个问题：无法控制其内部请求节奏（预算是插件安全的主要保障）、Cookie 要复制两份、错误码太粗（模型无法判断该等待还是该换账号）。因此本插件只移植签名实现，限速、预算、语料与工具接口都留在自己进程里。

## 风险提示

所有项目都是非官方实现，使用即可能违反平台协议；建议用次要账号、控制频率、不用于批量营销或抓取隐私数据。本文件仅为技术调研，不构成使用建议。

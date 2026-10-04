# 插件命令自动化验收

状态：开发模式已验收。继续使用热更新；没有安装、发布或启用正式更新渠道。

## 已接入

- 本机和在线插件包可包含 `hooks/hooks.json`、显式包内路径或内联配置；只含 Hook 的插件也可以添加。
- 支持捆绑 Codex 0.159.2 的 12 个生命周期事件及 command Handler，保留 matcher、Windows 命令、超时、异步运行、状态说明和上下文长度设置。
- 添加插件默认不执行自动化。用户审阅后启用；本机校验整包资源及审阅版本，再交给 Codex 的真实 `hooks/list` 和 `hooks.state` 精确哈希信任机制。工作区其他 Hook 不会被一起授权。
- 运行脚本可使用插件资源、独立持久数据目录及兼容变量。桌面内部模型桥接凭据不传给脚本。
- 同步 Hook 的真实执行与错误回执归入对应回复的“思考与执行”。命令审阅支持中文、英文及明暗主题，长内容在限定尺寸中滚动。
- 完整备份保留安装资源与自动化数据；停用、移除和重启后的状态已核验。

## 实测证据

证据目录：`artifacts/product-gaps-20261004/plugin-hooks/`。

| 验收 | 结果 |
| --- | --- |
| 捆绑引擎协议 | 3 项通过：真实发现、只信任审阅哈希、真实 SessionStart 脚本执行。没有请求模型。 |
| 桌面原生与界面 | 4 项通过：默认停用、资源变化拒绝旧授权、暗色窄窗口审阅、英文浅色启停。 |
| 前台真实模型 | Codex + DeepSeek 收到脚本生成的随机标记。标记没有出现在用户提示中；实际调用工作区工具，五类事件均留下脚本回执。 |
| 关闭窗口的定时模型 | 原生后台进程执行同一插件；真实模型读到同一标记，任务状态 succeeded，保存 8 项同步 Hook 协议事件。 |
| 备份、重启与收尾 | 6 项通过：913 项原生记录备份、资源及自动化数据 SHA 核对、紧凑审阅、完整桌面/后台重启、停用后真实恢复线程不再执行 Hook、只清理本轮测试资源。 |
| 原有会话 | 30 个原有会话的内容哈希一致。 |
| 定向自动验证 | 9 项原生插件测试、2 项备份测试及 8 项前端/宿主测试通过；原生构建与前端构建通过。 |

本轮实际执行了 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse 和异步 Stop。其余事件的配置已接入，尚未逐个触发实测。

关键证据：`protocol-result.json`、`native-result.json`、`model-result.json`、`headless-result.json`、`recovery-result.json`、`actual-lifecycle-records.json`。测试插件及两条测试侧栏会话已移除；本轮一次性定时任务已停用，执行凭据保留。

## 修复的问题

1. Windows 当前线程使用 PowerShell。带引号的 Node 可执行文件必须使用调用运算符；按 cmd 规则拼接会在到达脚本前失败。命令启动方式已用实际引擎验证。
2. 从 Windows Store Codex 启动开发程序时，Roaming 目录可能映射到包的 LocalCache。实际引擎返回物理路径，宿主原先比较文字路径，误报发现不完整。改为核对真实文件路径，仍只授权应用生成的那份配置。
3. 单行命令原先占 76 px；改为按内容高度显示并限制长内容，实际窄窗口高度约 39 px。

## 支持边界与后续

- 本轮记录 command Handler 的验收。后续已接入并实际验收 mcp_tool，详见 [插件 MCP 自动化验收](2026-10-04-plugin-mcp-hooks.md)；prompt / agent Handler 及注册 App 映射仍待接入。
- 异步 Hook 确实由引擎执行。本版本 Codex 源码只向客户端发送同步 Hook 的常规开始/完成通知；不能把脚本完成误写成收到了一条异步协议回执。现有独立后台命令监控继续可用。
- 安装资源变化需要重新导入并审阅；没有自动更新插件或绕过工作区 Hook 的信任校验。
- 此改动仍在开发版；之前生成的 0.2.0 发行候选不包含之后新增的插件能力。

## 版本依据

实际捆绑版本：Codex 0.159.2；对应源码提交 `ff6aec96948b70d94983af2641a6b67c94faeff5`。

- [该版本 Hook 运行及通知规则](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/hook_runtime.rs)
- [该版本线程 Shell 配置](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/session/mod.rs)
- [该版本命令执行器](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/hooks/src/engine/command_runner.rs)
- [官方插件说明](https://developers.openai.com/plugins/build/plugins)

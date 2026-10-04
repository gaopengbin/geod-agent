# 后台命令：本地实现与真实验收

2026-10-03，本地开发候选，尚未发行。

## 已完成

- 使用配套 Codex 0.159.2 的真实 `command/exec`、`command/exec/write`、`command/exec/terminate`。每个后台命令使用独立连接，不占住聊天回合。
- 本机后台服务持有连接、进程树和 SQLite 记录。关闭桌面窗口后继续执行，重开读取同一任务及输出。
- 命令归属于账号和会话，保留原始 argv、工作目录、执行方式、计划摘要及时间。重复启动同一记录不会重跑。
- 完全访问模式可从 AI 直接启动；逐次确认模式由右侧“确认并运行”启动。模型工具没有 `confirmed` 参数，不能替代界面确认。
- 右侧“后台命令”使用紧凑列表，只展开选中命令的输出。聊天不堆叠命令卡片，后台轮询不触发 AI 回合。
- 支持发送一行输入、结束输入、停止进程树、丢弃尚未运行的命令。只有 Codex 确认接收后才报告输入成功。
- 超时和非零退出保留实际状态、退出码及输出；后台异常退出标为中断，保留原输出，不自动重跑可能已写入文件的命令。
- 无桌面的定时 AI 也可以使用相同的实际工具。

## Windows 执行方式

配套 Codex 明确拒绝在 Windows 沙箱中使用流式 `command/exec`。本实现的 Windows 后台命令使用当前 Windows 用户权限执行，准备结果包含 `executionMode: windowsUser`，界面明确显示执行方式。工作区固定工作目录，并不限制程序只能访问该目录。它与原有短命令的沙箱执行方式不同。

原始 argv 不经隐式 shell 拼接。需要解释器时须显式提供程序及其参数。账号身份和工作目录在准备、启动时重新核验；进程通过 Windows Job Object 管理。模型网关密钥、数据库密码及父 Codex 进程的环境变量不传给命令宿主。

每个输出流最多保留前 256 KiB，额外输出不保留并明确标记。模型查询最多收到各流尾部 12,000 字符，并标记摘要截断；界面可以读取已保存的全部输出。UTF-8 数据先按字节合并，截断处不制造半个汉字。命令使用新请求准备新记录，已结束的记录不会隐式重试。

为适配 Windows 打包环境中的长 AppData 路径，每个命令使用全局唯一任务 ID 目录，避免额外的账号哈希层使 Codex SQLite 路径超长。所有命令的账号归属保存在原生账本中。

## 验收证据

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| 实际命令、输出、文件、输入、超时、停止、关窗与重连 | 19 项通过 | `artifacts/background-commands-20261003/acceptance.json` |
| 实际明暗界面、确认、输入、停止、丢弃及真实模型调用 | 5 项通过 | `artifacts/background-commands-20261003/ai-acceptance.json` |
| 工作目录变化、重复后台进程、实际后台崩溃与子进程清理 | 3 项通过 | `artifacts/background-commands-20261003/recovery-acceptance.json` |
| 窗口关闭后定时 Codex + 托管模型启动真实命令并生成文件 | 1 项通过 | `artifacts/background-commands-20261003/schedule-acceptance.json` |

实际模型准备并启动了带随机编号的 Python 命令，首轮返回时命令仍在运行；之后模型调用状态查询，回答真实退出码和实际输出。文件随机编号与运行输出一致。记录见 `actual-ai-conversation.json`，界面见 `actual-ai-background-handoff.png`、`actual-ai-background-readback.png`。

界面测试使用真实组件和桌面注入的原生 IPC，没有模拟执行结果。三条命令的列表行均为 36 px，无悬浮缩放、无横向溢出；输出高度受限。明暗按钮对比度分别最低 5.93、6.46。

异常测试只终止已确认身份的本机 GeoD 后台进程，且仅有验收命令在运行。原子进程实际停止，新后台恢复中断记录，未重新运行。其他应用与服务未参与此测试。

## 实现位置

- `apps/geod-agent-desktop/src-tauri/src/background_commands.rs`：原生账本、归属核验、状态、进程控制。
- `apps/geod-agent-desktop/src-tauri/managed-command-host.mjs`：配套 Codex 的独立执行协议。
- `apps/geod-agent-desktop/src/background-command-panel.tsx`：紧凑列表、输出与操作。
- `apps/geod-agent-desktop/src/background-command-tools.ts` 与 `headless_tools.rs`：实际桌面 AI 和无窗口 AI 的工具路由。
- `scripts/accept-background-commands*.mjs`、`accept-background-command-recovery.mjs`、`accept-background-command-schedule.mjs`：可复现验收。

TypeScript 检查、离线 Rust 构建与差异格式检查通过。当前保持开发模式热更新。本轮没有安装发行版、启用收费或修改线上服务。

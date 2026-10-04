# 插件 MCP 自动化验收

状态：开发模式已实现并通过实际验收。没有重新安装、发布或启用正式更新渠道。

## 已接入

- 插件生命周期自动化支持 `mcp_tool`，目标必须是该插件声明的 MCP 服务；安装时保存声明名称与本机连接器的对应关系。
- 审阅页显示事件、服务、工具、超时及可展开的输入模板。添加插件默认关闭自动化，启用须审阅当前资源与定义。
- Codex 0.159.2 实际展开输入模板并执行生命周期事件。原生桥接复用已有 MCP 凭证、工作区权限、工具筛选、调用记录及进程清理。
- 应用生成的自动化配置使用实际 `hooks/list` 和当前哈希核对。内部代理不向普通模型工具列表暴露；只接受当前会话中已审阅事件的一次调用。
- 前台停止可取消原生 MCP 调用。后台需要用户输入时暂停为 `waiting_input`。
- 插件停用、重新审阅或资源变化会替换空闲的引擎进程，恢复同一个持久会话；已加载的旧自动化不继续触发。
- 完整备份保留声明绑定、审阅状态及安装资源。移除插件后旧连接器不可执行。

模型回复由实际供应商生成，宿主仅传递真实工具结果及协议事件。

## 实测证据

证据目录：`artifacts/product-gaps-20261004/plugin-mcp-hooks/`。

| 验收 | 结果 |
| --- | --- |
| 捆绑引擎协议 | 两种实际 Core 配置通过：SessionStart / UserPromptSubmit 真正调用 MCP；代理工具列表为空时仍可执行事件。没有请求模型。 |
| 桌面原生与界面 | 4 项通过：默认关闭、资源变化拒绝旧审阅、暗色窄窗口、英文浅色停用及重新审阅。 |
| 前台真实模型 | Codex + DeepSeek 读回原生 MCP 附加的随机标记；标记不在用户提示中。输入模板中的对象、布尔值、数字及实际提示得到保留。 |
| 关闭窗口的定时模型 | 实际关闭窗口后到期执行成功；5 次原生 MCP 调用，真实模型读回同一标记。 |
| 后台需要输入 | 实际 MCP 服务返回需要用户输入错误后任务暂停；没有模型请求或生成事件。此项不是外部账号授权验收。 |
| 前台取消 | 点击真实停止按钮后约 974 毫秒取消原生 MCP 调用，没有进入后续模型或工具步骤。 |
| 备份、重启、停用与收尾 | 7 个不同检查通过：975 项原生记录备份、资源哈希及声明绑定、完整桌面与后台重启、审阅恢复、热停用、移除及原始会话恢复。报告保留了修复期间的重复检查。 |
| 进程清理 | 23 个实际测试服务及其后代无存活残留；结合创建时间区分 Windows 重用的进程编号。 |
| 原有会话 | 30 个原有会话内容哈希及当前选择一致；测试会话已归档并移除，两个测试定时任务已关闭。 |
| 定向验证 | 4 项原生 Hook、4 项原生插件包、2 项宿主测试通过；前端及最新原生构建通过。 |

实际触发了 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse 和 Stop。其余支持事件仍需分别触发验收。

关键证据：`protocol-result.json`、`hidden-protocol-result.json`、`native-result.json`、`model-result.json`、`headless-result.json`、`required-input-result.json`、`cancel-result.json`、`recovery-result.json`、`process-cleanup-result.json`。

## 修复及边界

1. 首次实际模型测试中 2 秒超时不足，回执如实保留；测试包重新审阅为 10 秒后通过，没有把超时结果当成成功。
2. 同一引擎加载后仅重载 MCP 配置不会刷新旧 Hook。宿主进程身份现在包含已审阅定义；实际热启用后再停用，恢复同一线程且没有事件调用。
3. 同一次回复中 Stop 事件可能重复使用运行编号。原生执行缓存加入真实事件序次，避免把下一次调用误判为上一次。
4. 兼容当前引擎的 TOML 输入值约束：输入为对象，不含 `null`。SessionEnd 的 MCP Handler 在该版本不受支持；明确拒绝。prompt / agent Handler 仍未接入。
5. 后台需要输入测试使用本机 MCP 的真实错误路径；没有替代外部 OAuth、真实身份挑战或真实表单账号验收。
6. 之前生成的 0.2.0 发行候选尚未包含这批新增能力；当前通过的是开发程序。

## 版本依据

捆绑 Codex 0.159.2，源码提交 `ff6aec96948b70d94983af2641a6b67c94faeff5`。当前调用和模板行为按本地该版本源码与实际引擎核验。

- [MCP Handler 配置](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/config/src/hook_config.rs)
- [模板及 MCP 执行](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/hooks/src/engine/mcp_runner.rs)
- [事件发现与支持范围](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/hooks/src/engine/discovery.rs)
- [官方插件结构](https://developers.openai.com/plugins/build/plugins)

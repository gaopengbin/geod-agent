# 插件清单兼容性验收

状态：开发模式已实现并通过实际验收；没有安装或发布。

## 本轮补齐

- Codex 兼容清单的 `mcpServers` 可使用包内文件路径或内联对象；同时接受直接服务映射及包含 `mcpServers` 的对象。显式声明优先，不合并默认 `.mcp.json`。
- `skills` 支持多个包内目录以及嵌套的技能目录，重叠目录不会重复安装同一技能。技能的相对资源保留原归属。
- 可移植插件仍使用规范的根目录 `skills/` 和 `mcp.json`；OpenAI 扩展和兼容清单不会替换这些组件。
- 缺失显式配置、错误类型及越界路径返回明确错误。清单及 MCP 配置的凭证不作为插件资源安装；运行值进入原生凭证存储。
- 已有哈希审阅、账号隔离、工具筛选、工作目录、环境引用及启停行为继续适用。

## 实际验收

证据目录：`artifacts/product-gaps-20261004/plugin-manifest/`。

| 验收 | 结果 |
| --- | --- |
| 原生与界面 | 5 项通过：三种兼容 MCP 声明、可移植目录优先、错误回执、暗色及英文浅色导入、真正的 stdio / HTTP 调用。文件选择器只注入了测试目录路径，其余操作使用真实界面和原生后端。 |
| 前台真实 AI | Codex + DeepSeek 实际发现并读取嵌套技能，再调用内联 MCP；读回技能与工具的两个独立随机标记。标记不在用户提示中。 |
| 关闭窗口的后台 AI | 真实后台定时执行成功，技能读取与 MCP 调用回执均成功，两份实际内容读回通过。 |
| 备份及完整重启 | 3 项通过：994 项记录、6 份插件资源及绑定备份；完整桌面和后台进程重启；重启后的嵌套技能及原生凭证调用。 |
| 清理及原有会话 | 8 个实际服务进程无残留；测试插件移除，测试会话归档并从侧栏移除，一次性任务关闭。原有 30 个会话内容哈希及选择一致。 |
| 构建及定向检查 | 6 项原生插件测试通过；前端及最新原生构建通过。 |

关键文件：`native-result.json`、`model-result.json`、`headless-result.json`、`recovery-result.json`、`process-cleanup-result.json`；界面截图包含 1000×720 暗色中文与浅色英文。

## 依据及边界

实际捆绑 Codex 0.159.2，源码提交 `ff6aec96948b70d94983af2641a6b67c94faeff5`：

- [清单中的目录数组和 MCP 内联对象](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core-plugins/src/manifest.rs)
- [MCP 两种文件格式](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/codex-mcp/src/plugin_config.rs)
- [默认发现及显式声明优先](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core-plugins/src/loader.rs)
- [官方可移植组件与 OpenAI 扩展规则](https://developers.openai.com/plugins/build/plugins)

注册 App 路由需要使用 Codex 后端的账号认证，当前 GeoD 托管模型及 BYOK 不具备该路由。本轮没有把注册 ID 作为网址使用，也没有复用本机 Codex 登录凭据。具体映射兼容及支持状态继续推进。

最新能力仍通过开发程序运行，旧 0.2.0 安装候选没有自动重新打包。

# 对话中的 MCP 浏览器交互

日期：2026-10-04。开发模式验收，没有安装或发布。

## 已实现

- Codex `mcpServer/elicitation/request` 的 URL 请求显示实际目的域名、完整地址、连接器说明和打开/取消按钮。
- 用户点击后，通过原生系统浏览器打开；页面打开只回复协议的 `accept`，成功与否继续依据连接器实际结果。
- 原生私有 HTTP / OAuth / stdio 连接器改为具备交互的 MCP ClientHandler。账号、会话和调用编号绑定在本机待回复队列；切换会话不会把请求显示到其他对话。
- MCP 普通表单沿用 schema 类型校验。取消回复 `cancel`；执行结束或超时清除待回复状态。前台停止会话也取消对应原生 MCP 请求。
- 原生打开器只接受 HTTPS 或本机 HTTP，拒绝执行协议、本机文件和内嵌用户名密码。失效请求无法重复打开。
- 凭据仍只保留在原生连接器，不写入 Codex 配置或验证报告。

## 实际发现及修正

公开 MCP 的调用审批与会话审批之前没有对齐，完全访问会话会出现 “requires approval, but approval policy is never”。已映射服务器默认工具审批：完全访问使用 `approve`，逐次确认使用 `writes`。

另一个问题是 `never` 会自动拒绝真实 elicitation。前台完全访问现采用 granular policy，仅开启 `mcp_elicitations`；后台仍不出现人工交互。此处没有把执行权限误当作用户已经完成登录。

配置依据为 [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp) 与 [granular 配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)，并核对打包的 Codex 0.159.2 生成协议。已用真实引擎验证，不能仅以当前在线文档作为旧版本兼容证明。

## 验收

证据：`artifacts/product-gaps-20261004/browser-elicitation/result.json`，截图位于同目录。

1. 原生私有 HTTP MCP：取消时不打开页面，返回 cancel。
2. `javascript:` 请求：界面按钮不可用，原生打开器拒绝。
3. 原生表单：整数默认值 12 保持数值类型，文本实际读回。
4. 请求在原会话中等待，切到另一会话时隐藏，回到原会话继续处理。
5. 系统浏览器真正访问本机协议页面，连接器之后返回 `browserReached: true` 和 `confirmed: true`。
6. 真实 DeepSeek 通过 Codex 直接调用公开 MCP，app-server 发出 URL 请求，用户按钮回复后工具返回真实确认结果，模型再生成最终回答。
7. 实际启动原生 stdio MCP 进程，发送 URL 请求，经系统浏览器打开后返回 `accept`。
8. 后台 stdio 客户端没有交互能力，需要用户输入时返回 `USER_INPUT_REQUIRED`；没有生成前台请求或打开浏览器。
9. 前端相关七项测试通过，编译通过。

本机服务属于协议验收样本，没有验证外部提供方实际账号登录。HTTP、stdio 与后台分别使用实际原生客户端验收；不把本机协议通过等同于外部账号授权。

原生桌面编译及上述实际流程通过。Windows 测试程序曾返回 `0xc0000139`；进程内加载诊断定位到 Common Controls 5.82 缺少 `TaskDialogIndirect`。补上测试程序的 Common Controls 6 清单，并保留 Tauri 原有应用清单后，两个 MCP 交互原生单元测试实际运行通过。诊断保留在 `artifacts/product-gaps-20261004/native-test-loader.json`。此前两个原生分支存储测试也已运行通过。

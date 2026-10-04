# Codex 本地开发版接入

## 使用

开发桌面已运行。新建对话后，输入框底部选择 **Codex · 测试** 即可；也可切回 **现有引擎**。选择保存在当前对话中。

这是 Codex app-server **运行引擎**接入，模型继续使用现有 GeoD 登录与 DeepSeek Flash 网关。没有接入用户的 Codex 订阅或 OpenAI 模型。

关闭桌面后可重新启动：

```powershell
python -X utf8 G:\code\geod-agent\scripts\start-codex-dev.py
```

前端使用 Vite 热更新；开发版适配层 `src-tauri/codex-host.mjs` 会在每轮启动时读取源码。修改 Rust 仍须重新编译、重启桌面。本次没有安装或发布服务器。

## 接入路径

`GeoD 对话 → 本机 Node host → Codex app-server → 本机 Responses 适配 → 原有 GeoD 网关`

- 固定测试引擎为 Codex 0.159.2；此开发版依赖本机 Codex 可执行文件与 Node.js，还未捆绑进安装包。
- Codex 管理会话、工具循环、流式事件和中断。GeoD 继续执行 27 个已声明工具，并通过原来的工具发现流程使用 Skills、GDAL、OpenLayers 等 MCP。
- 每次模型调用通过桌面的原有 IPC 与凭据存储访问网关。Node/Codex 仅持有随机的本机代理令牌。
- 原生执行器按当前账号、当前会话工作区校验权限；Codex 的审批设置不覆盖 GeoD 的逐次确认/完全访问设置。
- 每个账号独立保存 Codex 会话映射。每轮退出 host 与子进程，Windows Job Object 在桌面退出时清理进程树；没有可见控制台。
- 下载启动或查询后，工具结果继续交给模型，由模型生成回答。本机后台监控独立更新进度，模型不需要持续轮询。2026-10-01 已移除原先替代模型回答的固定交接文本通道。
- 上下文圆环显示 Codex 实际报告的最近请求 token 与有效窗口；当前兼容元数据报告 258.4K，适配层继续执行原有 42K 字符压缩与网关 48K 字符/64 条保护。该有效窗口不代表 DeepSeek 的标称容量。

## 验证记录

真实桌面、当前 GeoD 账号、真实 DeepSeek 网关、真实 GDAL：

1. 工作区与图源读取成功，包括同一模型响应中的并行工具调用。
2. GDAL 实际生成 `points.gpkg`，98,304 字节；独立 SQLite 检查：`gpkg_contents` 为 features、EPSG:4326，1 个要素，名称 `native-probe`，`integrity_check = ok`。
3. 同一 Codex thread 在新进程中恢复，再次模型调用正确回答此前转换格式。
4. 两轮累计 30 个 `item/agentMessage/delta`；9 次网关生成均 settled。

本机真实 Codex + 可控模型响应验证了工具回调、会话恢复、中断，以及任务工具结果返回模型后生成最终回答。该测试没有另行启动真实下载。真实账号与模型的任务查询证据见 `2026-10-01-model-owned-task-replies.md`。

编译：`npm run build`、`cargo build` 通过。常规前端测试 40 个通过；指定 `GEOD_CODEX_EXE` 后，引擎测试文件 5/5 通过。原生截图确认选择器可见、16px、无错误提示。

证据：`evidence/codex-native-2026-10-01.json`、`evidence/codex-dev-2026-10-01.png`。

## 后续边界

此版本用固定 GeoD 工具合同兼容当前网关，尚不提供 Codex 的通用终端或任意代码执行。app-server 中使用的动态工具接口仍是实验接口，升级引擎版本需要重新验证协议。

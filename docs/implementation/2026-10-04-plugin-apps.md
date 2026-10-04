# 注册 App 声明与随包 MCP 兼容

日期：2026-10-04。开发程序已完成实际界面、真实模型、关窗后台及完整重启验收。此项接入插件声明和其自带 MCP；OpenAI 账号专属的云端 App 通道仍未接入。

## 当前行为

- 支持默认 `.app.json`、Codex 清单的显式 `apps` 文件路径，以及可移植清单的 `extensions.com.openai.apps`。
- 读取 `apps` 对象中的名称、注册 ID 和可选类别。注册 ID 保持不透明，不推导成网址、凭据或本机连接器。
- 同名随包 MCP 可以成为该声明的实际工具入口。绑定必须同时属于当前插件和账号，并引用真实存在的连接器；模型获得的是该服务的真实工具定义。
- 带 App 声明的插件仍可使用其中的 Skill、MCP 和已支持的自动化。只有 App 声明的插件可以保存和移除，界面显示“暂不可用”，不能按“添加并启用”把它冒充为可用工具。
- 声明详情默认折叠。界面标明“随包工具服务”或“需要账号通道”；停用连接器立即停止暴露可调用工具。
- 前台 `extensions_list` 和关窗后的原生工具发现都返回声明及其实际可用状态，允许模型按名称、类别或注册 ID 查找。
- 声明保存为插件元数据；声明文件和清单不进入安装资源。原有凭据库、资源哈希、账号隔离和旧记录读取方式保持兼容。

## 实际验收

证据目录：`artifacts/product-gaps-20261004/plugin-apps`。

| 验收 | 结果 |
| --- | --- |
| 原生预览、显式路径、可移植覆盖、无效配置、空声明 | 通过，包含 6 项原生/界面检查中的相应用例 |
| 实际 App-only 导入和不可用提示 | 通过；无连接器、无启用按钮，不能执行云端 App |
| 按 App ID 发现随包 MCP、实际读取、停用/恢复 | 通过；真实安装目录、继承环境及工具筛选读回 |
| 中文暗色与英文浅色 1000×720 界面 | 通过；键盘焦点、悬浮尺寸和稳定后的按钮对比度检查通过 |
| 真实 Codex / DeepSeek 前台调用 | 通过；实际读取 Skill，按两个 App ID 分别发现，再调用随包 MCP；两个随机资源标记未出现在提示词中 |
| 关窗后的真实后台模型 | 通过；实际成功完成 `skill_read`、两次 `extensions_list` 和 `mcp_call` |
| 备份与完整桌面/后台重启 | 通过，3 项；1,007 项记录备份，4 个插件资源逐个哈希核对，重启后原绑定可实际执行 |
| 原数据与清理 | 原有 30 个会话逐条严格相等，恢复原选中会话；两个测试插件和一个测试会话已清理，测试定时任务已停用 |
| 服务进程清理 | 核对 9 个实际 PID，无测试 Node 残留或 PID 复用 |

原生包测试 7 项、App 解析测试 1 项通过。前端发现测试 6 项、前端构建及原生开发构建通过。实际界面检查只供应文件夹选择结果，没有替换原生预览、安装、工具或模型结果；未点击系统文件选择器。

浅色稳定按钮对比度最低 4.97:1，暗色最低 5.17:1。早期验收脚本对英文词条的预期写错，失败记录已保留；使用实际词条并恢复同一测试会话后通过，没有另建重复会话。稳定截图已实际查看。

## 接入边界

Codex 0.159.2 的固定源码 `ff6aec96948b70d94983af2641a6b67c94faeff5` 中，注册 App 通道依赖 Codex 后端账号认证。API Key 模式不会获得该通道，随包 MCP 仍可独立运行。GeoD 托管和 BYOK 当前沿用自己的模型渠道，没有读取本机 Codex 登录凭据。

真实测试只使用本机明确声明的 App ID 和随包服务，不证明任何第三方云端 App 已授权。需要专属账号通道的声明持续返回 `registeredAccountRouteAvailable: false`；这与随包 MCP 的实际可用状态分别记录。

规范参考：[OpenAI 插件构建文档](https://developers.openai.com/plugins/build/plugins)。固定源码保存在 `artifacts/product-gaps-20261004/plugin-hooks/research/codex-source`，对应 `connectors/src/plugin_config.rs` 与 `core-plugins/src/app_mcp_routing.rs`。

## 实现位置

- 原生：`extensions/plugin_apps.rs`、`extensions/plugin_package.rs`、`extensions.rs`、`headless_tools.rs`。
- 界面与发现：`plugin-apps-ui.tsx`、`plugin-preview.tsx`、`plugin-panel.tsx`、`extension-discovery.ts`、词条及紧凑样式。
- 验收：`scripts/verify-plugin-apps-{native,ui,model,recovery}.mjs`、`verify-plugin-apps-headless.py`，实际后台及进程检查复用现有脚本。

开发版继续使用热更新；本项未重新安装或发布。

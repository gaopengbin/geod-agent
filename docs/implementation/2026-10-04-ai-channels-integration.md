# 多渠道 AI 与 BYOK 原生接入

日期：2026-10-04。状态：已接入开发桌面、完成真实模型与原生任务验收，开发模式已重新打开。安装候选没有重新打包。

## 使用入口

账号与设置 → **模型与渠道**，进入页内管理页面。可以添加多个渠道、填写自有 API Key、读取模型目录或手动配置模型；会话输入栏按“渠道 · 模型”选择。

- GeoD 托管继续作为新对话默认入口；已有会话保存自己的选择。
- 支持 OpenAI Chat Completions、Responses、Claude Messages 与 Gemini 四种接口。
- 可填官方服务或中转站基础地址，允许 HTTPS 和本机 loopback HTTP。
- 预设提供 DeepSeek、OpenAI、OpenRouter、LiteLLM、Anthropic / Claude 和 Google Gemini 地址。预设地址不代表该供应商已通过真实验收。
- 目录读取可以在保存前进行；读取失败后仍可手工填写模型 ID。目录可读与模型实际可用分别核验。
- 模型的上下文、输出上限、图片能力与 thinking 参数可单独配置；目录未返回的能力不推断为已支持。
- 浅色、深色、窄窗口、表单标签、滚动和会话选择器已检查，延续现有 LibreChat 风格、Inter / Noto Sans SC 字体与 Lucide 图标。

## 原生路由与凭据

`ai_channels.rs` 管理账号归属、渠道、模型选择、配置版本和本机用量。模型 Key 保存在 Windows 系统凭据库；配置数据库只保存凭据引用。输入密钥临时传给原生层，保存后清空，编辑时不回传原密钥。

模型请求由 Rust 原生层发送。协议工作进程只处理请求内容和流式事件，实际地址和认证头由原生层按固定快照生成。Codex 和协议子进程不继承模型密钥环境变量。默认托管请求继续使用原有 GeoD 网关。

每轮运行开始时固定渠道、模型与配置版本。密钥轮换保留旧凭据版本供既有任务使用；删除渠道移除其凭据，相关任务提示配置缺失；停用渠道也会明确拒绝后续请求。没有静默切换到其他渠道。

### 子任务与 AI 定时任务

真实的 `agent_tasks` 和 `ai_schedules` 保存 `modelRoute`。父任务快照通过本机原生注册记录传给独立后台进程；子任务和定时执行保留原有渠道、模型和版本。修改前台选择、新对话默认或渠道配置不会改写这些任务。

旧定时任务明确沿用托管入口。重试沿用原快照；旧会话迁移保留托管选择，避免新增默认渠道改变既有对话。

### 实际用量

自有渠道记录 `billingScope: personal`、渠道 ID、所选模型、实际模型、配置版本、输入/输出/缓存/推理 Token 及上游请求 ID（供应商有返回时）。缺失用量保持未知，不填写虚构 Token 或费用。

自有请求不走 GeoD 托管额度扣减；管理页单独展示服务返回的 Token。价格和余额由所用服务结算，本轮没有为任意供应商套用 GeoD 费率。

## 实际验证

供应商只使用已有授权的 DeepSeek 项目测试凭据；只读获取，没有修改线上 Key、额度、渠道或服务。临时 LiteLLM 1.103.2 绑定本机随机端口，验收后已停止。测试渠道和系统密钥已删除，原有默认与用户会话已保留。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 原生目录、系统凭据保存与不回传密钥 | 通过 | [原生验收 r4](../../artifacts/ai-channels-integration-20261004-r4/native-summary.json) |
| DeepSeek Flash / Pro 真实流式工具往返 | 通过 | r4 的父任务及模型切换用例 |
| 父任务执行期间编辑模型并轮换密钥 | 仍使用原配置 | r4 的固定快照用例 |
| 独立后台子任务实际读取、写入并核对随机文件内容 | 通过 | r4 的 companion 子任务用例 |
| 原生 AI 定时任务在前台切到托管后仍使用原 Flash 版本 | 通过，`succeeded` | r4 的原生定时用例 |
| 真实 Responses 接口及会话恢复 | 通过，DeepSeek 经临时 LiteLLM | [最终原生验收 r6](../../artifacts/ai-channels-integration-20261004-r6/native-summary.json) |
| 取消请求及下一轮恢复 | 通过 | r4 的取消与恢复用例 |
| 真实错误 Key 的规范提示 | 通过，`AI_KEY_REJECTED` | r6，不回显上游响应或密钥 |
| 浏览器状态无测试凭据、自有用量单独记录 | 通过 | r6 |
| 界面添加多模型、读取目录错误、密钥清空、明暗及窄窗口 | 通过 | [界面验收](../../artifacts/ai-channels-integration-20261004-r6/ui/ui-verification.json) |
| 最终开发程序重启后任务渠道记录 | 通过 | [重启读取](../../artifacts/ai-channels-integration-20261004-r6/restart-readback.json) |
| 最终开发程序原有托管工具往返 | 通过，16 个实际图源条目完整核对 | [托管回归](../../artifacts/ai-channels-integration-20261004-r6/native-baseline.json) |

r4 保留九个已通过用例；其整轮被测试控制器对结构化错误的处理问题中断，文件仍标记为未完成，不能称为整轮通过。修复控制器后，r6 的六个剩余及重点复测用例全部通过。此前未通过记录保留，没有删除或改写为成功。

### 修复了一个真实流式事件顺序问题

Codex 可以在收到 `response.output_item.done` 时立即执行工具。直接转发这个事件会让工具或最终回答先于原生生成记录落盘，导致用量和执行回执未完整保存。

宿主现在从第一个工具完成事件开始保留原始事件尾部顺序，在原生结果和回执保存后再交给 Codex。真实模型复测和真实 Codex 引擎的受控回归都已通过；没有替换模型最终回答或重写工具内容。

### 自动检查与凭据扫描

- 原生渠道测试：2 项通过，包括账号隔离、默认选择、地址和模型能力约束。
- 协议适配检查：7 项通过。
- 宿主与 Responses 回归：8 项通过，使用实际 Codex 0.159.2；受控响应回归与真实供应商验收分别记录。
- 前端构建、最终原生开发构建通过。前端仍有现有大包提示。
- [凭据扫描](../../artifacts/ai-channels-integration-20261004-r6/credential-audit.json)：检查 11,047 个文件，未发现本轮测试密钥。四个正在使用的 Codex 锁文件未读取，报告明确列出。临时代理已停止。

## 当前边界

- 四种协议已接入，但真实供应商仍只有 DeepSeek。Responses 经 LiteLLM、Claude / Gemini 经本机协议转换完成真实模型往返，不代表已验证这些官方服务或任意中转站。
- 图片输入配置已提供，本轮没有完成各渠道的真实图片验收。
- 定时记录跨开发程序重启已读取核对；实际使用 Windows 登录启动命令打开无界面后台后，BYOK DeepSeek 的工作区文件读取、一次性执行、错过周期合并执行与重开结果已通过。证据为 `artifacts/product-gaps-20261004/autostart/result.json`。没有执行真实系统重启或长期运行验收。
- Claude Messages 与 Gemini 的原生认证、思考签名、工具往返、后台定时执行和实际桌面重启恢复已通过；官方供应商与图片请求仍待验收，见 [原生协议记录](2026-10-04-native-ai-protocols.md)。
- 合作方可以提供兼容接口与个人凭据进行接入。统一赞助 Key、供应方品牌信息、赞助额度与服务端账本保留在原设计中，需实际合作方资料后继续完成。本轮未启用统一赞助服务或对外宣称合作关系。
- 当前交付为本机开发版；没有重做安装包、部署线上或进行干净 Windows 验收。

## 主要实现

- 原生：`src-tauri/src/ai_channels.rs`、`provider-worker.mjs`。
- Codex：`codex_runtime.rs`、`codex-host.mjs`。
- 原生任务：`agent_tasks.rs`、`ai_schedules.rs`、`execution_receipts.rs`。
- 页内管理与选择：`src/ai-channels.ts`、`src/ai-channels-page.tsx`、账号菜单、会话输入栏及 `theme.css`。
- 实际测试：`test/ai-channels-integrated.mjs`、`test/ai-channels-ui.mjs`、`test/ai-channels-restart.mjs`。
- 编排：`scripts/verify-integrated-ai-channels.py`。真实测试有供应商用量消耗，使用进程变量提供测试密钥或已有授权配置。

开发模式启动入口：`scripts/start-codex-dev.py --local-gateway`。前端使用热更新；原生层改动才需重新编译开发程序。

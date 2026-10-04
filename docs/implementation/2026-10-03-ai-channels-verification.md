# AI 渠道接入验证

2026-10-04 更新：已进一步完成开发桌面的原生接入与实际任务验收，详见 [原生接入报告](2026-10-04-ai-channels-integration.md)。下文保留此前隔离候选的验证范围。

日期：2026-10-03。结论：采用应用内渠道管理，保留 Codex；先支持 Responses 直通和 Chat Completions 适配。LiteLLM 可作为服务器的可选协议转换层。

**本轮完成的是隔离接入候选验证。开发桌面仍默认使用 GeoD 托管模型，尚未启用 BYOK 设置页、会话渠道选择或赞助渠道运营。**

## 验证环境

- 当前产品的真实 Codex app-server，版本 0.159.2，复用 `codex-host.mjs`。
- DeepSeek 官方接口，真实目录中的 `deepseek-flash`、`deepseek-v4-pro`。
- LiteLLM 1.103.2，安装在本轮产物目录内的独立 Python 环境；只绑定本机随机端口，结束后停止。
- 项目凭据由测试控制进程持有，Codex 子进程的环境不含本轮模型凭据。保存的渠道快照只有凭据引用。
- 凭据来自既有 GeoD 项目配置，经固定主机密钥的 SSH 只读获取；没有修改线上渠道、额度、Key 或服务。
- 实际供应商只验证了 DeepSeek。不同配置和两种接口协议，不等于已经验证多个供应商。

## 实测结果

最终选入报告的 12 个用例全部通过，原始记录见 [汇总 JSON](../../artifacts/ai-channels-verification-20261003/verification-summary.json)。

| 接入配置 | 模型目录 | 真实工具循环 | 重开恢复 | 取消后继续 | 独立进程/延时运行 |
| --- | --- | --- | --- | --- | --- |
| 本机 Chat Completions 适配 / Flash | 通过 | 通过 | 通过 | 通过 | 候选通过 |
| 本机 Chat Completions 适配 / Pro | 通过 | 通过 | 通过 | 本轮未单独测 | 本轮未单独测 |
| LiteLLM Responses / Flash | 通过 | 通过 | 通过 | 通过 | 候选通过 |
| 现有 GeoD 托管桌面 | 沿用既有配置 | 实际 `sources_list` 通过 | 本轮未单独测 | 本轮未单独测 | 沿用既有实现，本轮未测渠道切换 |

12 项为：三个目录读取、三个主对话验收、两个独立子进程、两个延时进程、一个错误凭据和一个原生桌面验收。恢复和取消检查包含在主对话验收中。

### 真实工具循环怎么核验

1. 在测试目录创建随机内容的 `input.txt`。
2. 由模型选择并调用文件读取工具，再调用文件写入工具。
3. 工具执行真实文件操作，把真实结果交回模型；最终回答由模型生成。
4. 读取 `output.txt`，核对完整内容及 SHA-256；脚本不替模型写最终成果。
5. 重启候选宿主，确认恢复同一 Codex thread，并能回答上一轮的随机内容。

主对话使用常规 Codex 工具上下文，实际请求包含 function/custom 工具；独立进程使用文件工具范围。两种传输均完成了文件工具的模型往返。

原生桌面验收使用当前产品的图源摘要结构，读取实际本机清单；模型返回的 **16 个条目及全部名称逐项一致**，当前 UI 会话没有切换或修改。

### 独立进程与定时的边界

候选将渠道快照写入测试文件，改变前台选择后，由另一个 Node 控制进程加载原快照，驱动自己的真实 Codex 完成文件读写。延时用例在一秒后启动同类独立进程。

这证明候选传输可以跨进程保持所选模型。它**不是**当前产品 `agent_tasks` / `ai_schedules` 的多渠道接入验收，也没有验证带渠道快照的跨重启定时恢复。正式接入时还需把快照落到原生任务记录，并验证无窗口、重启和凭据删除后的行为。

### 错误、用量和凭据

- 错误 Key 的真实请求返回 HTTP 401，被规范化为 `PROVIDER_HTTP_ERROR`，没有静默切换模型。
- Flash 直连和 Responses 均验证了取消、停止当前 turn，以及下一轮继续对话。
- 记录实际渠道、选定模型、上游模型/请求 ID、输入/输出/缓存/推理 token。缺失的用量保持 `null`，不使用当前 DeepSeek 费率估算其他渠道费用。
- 补齐适配结果的缓存/推理用量字段，使 Chat 桥接可以向 Codex传递这些数据。
- 两种配置的最终产物扫描均未发现本轮模型凭据；测试密钥没有写入渠道快照或 Codex 配置。
- BYOK 的原生系统凭据库读写、账户隔离、密钥轮换与删除，还需要正式功能接入后验收。本轮用进程内凭据验证传输。

## 耗时观察

相同文件任务的首轮工具循环，本机适配约 **3.8 秒**，LiteLLM Responses 约 **4.8 秒**。这是少量请求的本机观察，包含模型输出和工具操作；不能据此给供应商做稳定性能排名。两者都可用，尚无必要让全部个人渠道请求多经过一个服务。

## 已保存的实现

- `packages/codex-protocol/provider-adapter.mjs`：独立候选，渠道快照、目录读取、Chat 转换、Responses 原始事件传递、取消、错误和用量。
- `packages/codex-protocol/provider-adapter.test.mjs`：7 项协议/异常检查通过。
- `apps/geod-agent-desktop/src-tauri/codex-host.mjs`：增加可选 Responses 原始事件入口和模型能力元数据；现有托管路径继续使用原来的桥接。
- `apps/geod-agent-desktop/test/codex-host.test.mjs`：6 项检查通过，包括真实 Codex 引擎配合受控模型响应的回归；该回归不计为真实供应商测试。
- `apps/geod-agent-desktop/test/ai-channels-real.mjs`：真实供应商与独立候选控制器。
- `apps/geod-agent-desktop/test/ai-channels-native-baseline.mjs`：真实开发桌面的托管链路核验。
- `scripts/verify-ai-channels.py`：测试编排、凭据供给、临时 LiteLLM 和产物扫描。

## 可重跑的入口

在独立 GeoD Agent 仓库执行。默认读取进程变量 `GEOD_QA_DEEPSEEK_KEY`；已有授权时可使用 `--existing-geod-config` 只读读取现有项目凭据。

```powershell
rtk proxy node --test packages/codex-protocol/provider-adapter.test.mjs
rtk proxy python -X utf8 scripts/verify-ai-channels.py --existing-geod-config --route direct-flash
rtk proxy python -X utf8 scripts/verify-ai-channels.py --existing-geod-config --route direct-pro
rtk proxy python -X utf8 scripts/verify-ai-channels.py --existing-geod-config --route litellm-responses --litellm-python artifacts/ai-channels-verification-20261003/litellm-venv/Scripts/python.exe
rtk proxy node apps/geod-agent-desktop/test/ai-channels-native-baseline.mjs
```

真实模型测试会消耗供应商用量。原生桌面验收需要开发桌面已运行且当前没有进行中的用户对话。

## 正式接入顺序

1. 将候选的接口选择、固定快照和事件语义接入原生模型路由，凭据使用现有系统凭据库方式保存。
2. 增加页内“模型与渠道”、多个模型和会话选择器，默认保留 GeoD 托管。
3. 将渠道快照贯穿真实子任务与 AI 定时任务；验证删除/修改渠道不会让任务静默换模型。
4. 对接实际合作方：统一赞助 Key 放在服务端，按渠道核对用量与额度。
5. 获取其他供应商的项目凭据后，再测它们的真实工具循环、图片和重启恢复。

NoteGen 和 Cherry Studio 的服务商/模型管理结构适合借鉴；保持当前 Codex 执行层即可。LiteLLM 的最新候选已实测可用，可在合作渠道需要协议转换时加入现有服务端网关。正式赞助方、统一额度分账、Anthropic/Gemini 原生接口、其他供应商及图片输入没有在本轮通过验收。

参考：[NoteGen 配置](https://notegen.top/cn/docs/settings/model-config)、[LiteLLM Codex 接入](https://docs.litellm.ai/docs/proxy/client_setup/codex_cli)、[LiteLLM 转换边界](https://docs.litellm.ai/docs/harness/codex)。

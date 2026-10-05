# 个人中转的真实模型验收前置检查

日期：2026-10-05。此阶段完成只读发现与测试凭据门禁，未生成模型回复，未改变正式网关、价格、渠道或密钥。

## 当前证据

- 通过固定主机密钥的 SSH 隧道连接 New API；状态、当前价格和已认证模型目录均返回 HTTP 200，目录有 81 个模型名称。目录可见不代表每个模型已实际调用成功。
- 现有设备环境中的下游 Key 名为 `gpt`，不限额，不能作为 GeoD 专项验收凭据。未复用它生成回复，也没有把它写入脚本或证据。
- 新脚本 `scripts/verify-relay-project-access.py` 只读取进程变量 `GEOD_QA_RELAY_KEY`，拒绝全局 Key 回退。实际传入现有通用 Key 后返回 `PROJECT_KEY_SCOPE_MISMATCH`，没有付费生成、服务器写入或遗留隧道。
- 只读核对 New API 的三个启用渠道：面向选定模型的渠道仍指向 Metapi。没有查询渠道密钥、上游令牌、用户提示词或回复。
- 所选三种模型的最近 18 条 Metapi 历史记录仅覆盖 GPT，最后日期为 2026-09-08。因此不能把历史成功当作当前 Claude、Gemini 或 GPT 的可用性证明，也不能据此声称官方供应商已验收。

## 下一阶段的具体范围

| 当前目录中的模型名 | 拟验证接口 | 本阶段边界 |
| --- | --- | --- |
| `claude-sonnet-5` | Claude Messages | 目录和价格接口已发现，尚未实际调用。 |
| `gpt-5.6-terra` | Responses | 价格仅列出通用 `openai` 接口类型，Responses 仍需单独实测。 |
| `gemini-3.7-flash` | Chat Completions | 当前价格列出 `anthropic` / `openai`，未宣称支持 Google 原生 Gemini 接口。 |

待答复的是创建 GeoD 专项临时 Key 的授权：额度上限 1 美元、24 小时过期，仅用于上述三个模型的少量工具往返，完成后撤销。该问题不涉及发布、现金充值、正式费率或默认模型切换。

脚本进一步要求 Key 名精确匹配 `geod-agent-qa`、有限额度、未来过期时间，额度换算必须取当前 `/api/status` 的 `quota_per_unit`。未知换算、超限或不限额都会拒绝。上述专项 Key 的成功门禁和实际模型调用尚未执行，不能从现有通用 Key 的拒绝结果推导成功。

获得专项凭据后，需核验原生工具实际返回的随机文件名、流式结果、独立用量、实际路由及凭据清理；保留失败结果，不把模型别名视为官方供应商身份证明。现有 31 个会话和跨日 QA 继续保留。

## 本机证据

- `artifacts/relay-provider-acceptance-20261005/relay-preflight.json`
- `artifacts/relay-provider-acceptance-20261005/preflight-00786ceaff457b18/result.json`
- `artifacts/relay-provider-acceptance-20261005/current-new-api-topology.json`
- `artifacts/relay-provider-acceptance-20261005/route-health-readonly.json`

证据只有模型、价格、非秘密渠道元数据与固定错误码。检查脚本不包含付费生成操作；当前发行文件、产品源码和跨日测试控制脚本没有修改。

# 赞助渠道：原生接口、图片与活动时间

日期：2026-10-04。已在开发模式完成；正式网关没有发布这一候选。

## 已完成

- 服务端赞助渠道增加 `protocol`：`chatCompletions`、`responses`、`anthropic`、`gemini`。省略时继续使用原 Chat Completions；原有文本渠道的配置版本保持兼容，旧任务不会仅因这次升级失效。
- 复用个人渠道的协议适配层，供应商认证与 Key 留在服务器。客户端仍只提交渠道 ID、模型 ID、配置版本。
- 模型可声明 `inputModalities: ["text", "image"]`。图片通过现有原生附件传入，按对应接口转换；文本模型仍明确返回图片不支持，不改换付款渠道。
- Responses 语义事件通过网关和原生桥接传给 Codex；工具完成事件在持久结算之后交给引擎。重复请求重放已保存的输出，保留原始条目、命名空间及不透明思考内容，不再次请求上游。
- Claude / Gemini 的签名与工具关联状态随原始结果保存，下一次工具往返沿用；服务端检查工具属于本轮实际声明。
- 可选 `startsAt`、`endsAt` 指定赞助活动范围。日期必须包含时区，服务端统一成 UTC；界面以用户语言和本地时间显示。尚未开始或已结束的活动不可设为默认，模型选择列表自动更新。
- 活动日期、协议和模型能力属于配置版本。每次请求以服务器时间判断是否开放；已经提交的请求可以完成，下一次工具往返需要仍在活动范围内。已有任务不会自动切到托管付费模型。
- 默认 `observe` 继续不限额度，只记录用量。可选预算仍是同一渠道 ID 的累计预算；修改日期或版本不重置用量，没有增加自动按月充值或预算清零。

## 配置示例

以下是运营方审阅的配置结构，不是已经开放的公共活动。密钥放在服务器环境变量中。

```json
[
  {
    "id": "partner-autumn",
    "name": "合作方秋季体验",
    "description": "影像与地图 Agent 体验",
    "protocol": "responses",
    "baseUrl": "https://provider.example/v1",
    "apiKeyEnv": "PARTNER_AUTUMN_API_KEY",
    "allowedUsers": ["specific-geod-user-id"],
    "quotaMode": "observe",
    "startsAt": "2026-10-10T00:00:00+08:00",
    "endsAt": "2026-11-10T00:00:00+08:00",
    "models": [
      {
        "id": "partner-model",
        "name": "合作方图文模型",
        "contextWindow": 128000,
        "maxOutputTokens": 4096,
        "inputModalities": ["text", "image"],
        "thinking": null
      }
    ]
  }
]
```

`baseUrl` 是 API 基址：分别追加 `/chat/completions`、`/responses`、`/messages` 或 `/models/{model}:streamGenerateContent?alt=sse`。机密认证不放在 URL 中。`thinking: "adaptive"` 只允许 Claude 格式；Claude 的显式思考预算需要输出上限超过 1024。

显式预算模式中，图片的 token 数随供应商变化，因此请求暂按模型上下文上界预留；最终扣的是供应商实际用量，不把 base64 字节当作真实 token。观察模式不因此拒绝请求。

## 实际验收

证据目录：`artifacts/product-gaps-20261004/sponsored-native`。

| 检查 | 实际结果 |
| --- | --- |
| 网关和协议回归 | 40 项通过，包含四种实际本机 HTTP 接口的认证、图片、工具往返、幂等、缺失用量、未知工具、独立账本、旧默认配置版本兼容及原托管回归。受控接口测试不冒充真实模型。 |
| 原生 Rust | 2 项通过，包含旧快照、账号归属、四种接口/图片能力和活动起止门禁。 |
| 原生、界面及模型阶段 | 16 项通过；中文暗色与英文浅色 1000×720 活动列表无横向溢出，日期与禁用操作已查看实际截图。 |
| 实际前台 | 四种接口的 Codex 流程均读取附图随机六位数字、三种颜色/形状，并通过 `workspace_gis_files_list` 读回未放入提示词的随机文件名。每种接口两次模型请求。 |
| 官方接口范围 | Chat Completions、Responses 和 Claude Messages 直连 DeepSeek 官方对应接口；模型均为真实 `deepseek-flash`。这不等于 OpenAI 或 Anthropic 官方模型验收。 |
| Gemini 范围 | 本机 Gemini 格式转换服务连接真实 DeepSeek。图片传入、工具往返及一块签名状态的原样回放通过；Google 官方模型仍未验收。 |
| 实际关窗后台 | 保存 Responses 赞助和原生图片历史后，将会话选择改为托管并关闭前台。独立后台仍用赞助接口完成图片读取及实际工具查询。 |
| 实际用量 | 前台八次、后台两次请求，共 194,468 token，全部服务端结算为赞助。目录用量逐渠道与账本一致，没有新的托管请求。 |
| 备份和完整重启 | 1,187 项备份 SHA-256 全部核对；四张图片的原始文件、元数据与预览共 12 项记录完好。桌面与独立后台重启后，活动、选择、实际后台结果及账本一致。 |
| 密钥边界 | 验收目录、本机模型缓存、指定原生会话和完整备份共 11,294 个文件检查通过，没有供应商明文 Key；桌面进程环境没有供应商 Key。 |
| 收尾 | 已关闭验收任务、清空本机验收渠道缓存并停止独立服务，恢复原开发网关、原默认选择、当前会话及 30 个原会话。核验只忽略历史空闲标记 `pendingId: ""` 的正常移除，正文和工具记录按哈希一致。 |

实际答案与账本见 `actual-*-chat.json`、`actual-background-model.json`、`actual-server-ledger.json`；阶段结果为 `native/model/headless/recovery/restart/cleanup/finish-result.json`。Gemini 的真实上游与签名回放见 `gemini-wire-evidence.json`。

前端与原生构建通过。本轮没有生成或安装新安装包，没有修改旧 GeoD，没有发布服务器或启用真实收费。

## 核对的官方接口资料

- DeepSeek 官方现已提供 [Responses 格式](https://api-docs.deepseek.com/guides/responses_api/) 与 [多接口图片输入](https://api-docs.deepseek.com/guides/vision/)。本次前台与后台直接使用这些接口验证。
- Claude 的 [流式事件规范](https://platform.claude.com/docs/en/build-with-claude/streaming) 和 Google 的 [GenerateContent 接口规范](https://ai.google.dev/api/generate-content) 用于核对格式；它们的官方账号与模型未在本轮调用。

## 仍需推进

真实合作方、官方 OpenAI / Anthropic / Google 账号和供应商差异矩阵，以及正式赞助网关发布。活动周期已支持起止时间，按月刷新预算尚未实施。正式网关发布须以可审阅配置取得授权。

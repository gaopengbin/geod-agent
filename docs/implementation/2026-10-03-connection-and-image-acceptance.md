# 连接与图片输入：本地验收

## 数据与 MCP

- PostGIS 实际 TLS 服务：verify-full、verify-ca、CA 缺失和主机名错误；geometry/geography、条件筛选、范围筛选与数量超限完整性。证据：`artifacts/postgis-selection-20261003/acceptance.json`。
- 通用 stdio 调用真实 pgEdge 1.1.0，查询三条实际 PostgreSQL 记录；私有 HTTP 请求头、结果重复调用复用、阻止凭据随重定向发送。证据：`artifacts/private-mcp-20261003/acceptance.json`。
- 实际产品对话由 Codex + 托管模型发现、筛选、读取并回答上述数据。证据：`artifacts/connections-ai-20261003/acceptance.json`。
- OAuth 使用 rmcp 官方 SDK 的发现、PKCE 和刷新；凭据保存在 Windows 凭据库。本机协议服务验证错误 state/issuer、过期和 401 刷新、取消替换保留旧授权、移除取消未完成回调。证据：`artifacts/mcp-oauth-20261003/acceptance.json`。
- OAuth 测试属于协议验收，未使用外部提供方账号。支持自动注册的公共客户端或预注册 client ID；机密客户端 secret 与提供方服务端撤权未完成。本机移除不会声称已撤销提供方账号授权。

## 图片

- 接收 PNG/JPEG/WebP/GIF，检查真实内容、尺寸及解码，原图和预览保存在账号隔离的本机目录。对话存储仅保存元数据和引用，模型请求发送原图。
- 以随机数字和三个不同颜色/形状的图片测试，测试请求不包含预期数字。实际产品附件 → Codex 0.159.2 → GeoD 网关 → DeepSeek Flash，识别全部数字和颜色/形状。
- 原图损坏或跨对话读取会返回明确错误；图片不会转换为任意网络链接。每轮最多 8 张、单张 10 MB、合计 24 MB，这是当前客户端内存和请求容量。
- 证据：`artifacts/image-input-20261003/acceptance.json`、`real-model-image-answer.png`。
- 模型能力配置依据 [DeepSeek 视觉文档](https://api-docs.deepseek.com/guides/vision/) 和 [Codex 接入文档](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)，并经过实际调用验证。使用当前 Flash；不将托管模型称为 OpenAI 模型。

## 校验与边界

- TypeScript、Rust 检查及开发构建通过；图片传输协议和网关合同测试通过；MCP 大结果持久化与账号读取隔离两项测试通过。
- 本地测试网关用量 SQLite 先备份再重启，后续使用固定开发账本路径，避免重启丢失成本验收数据。
- 保持开发热更新，未发布网关或启用正式收费。

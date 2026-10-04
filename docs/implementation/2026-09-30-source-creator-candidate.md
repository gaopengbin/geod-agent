# 图源 Creator 本机候选（2026-09-30）

## 已授权发布与验收

- 用户于本会话授权发布网关；已发布 `geod-agent-extensions-20260930-3ab70aea`，服务器文件哈希与候选一致。仅替换 `server.mjs`，沿用现有依赖、配置与 `ledger.mjs`，无数据库结构变更。
- SQLite 在线备份及备份 `quick_check` 已通过：`/srv/laogao/backups/geod-agent-source-creator-20260930-1150/agent-model.sqlite`。旧 release 和旧 PM2 服务保留为回滚点。
- 新 PM2 服务 `geod-agent-extensions-20260930` 正常运行，9115 健康接口返回 `status: ok`，发布后 SQLite `quick_check` 通过。Nginx 配置未修改，语法检查通过。
- 发布后真实托管模型验收通过（25.36 秒）：实际调用 `extensions_list`、`skill_read`、`workspace_status`、`sources_list`，通过 `mcp_call` 检查 USGS ImageServer 与 USGS 官方版权、NAIP 说明页，最后调用 `source_registration_prepare`。在隔离临时任务库验证草稿合同及未确认授权时拒绝保存；未写入用户图源库、未下载影像。
- 成功请求的只读回查确认草稿使用真实 `/ImageServer/exportImage` 地址及 USGS 官方许可页面，同时明确公共领域说明不等同于提供方单独授予批量瓦片下载许可，仍须用户审核。
- 新版桌面构建成功并启动，窗口响应正常。Skills 页可看到默认启用的「图源 Creator」，浏览器预览验证了指令展开/收起。
- 补充模型调用被额度门槛拒绝：当前已用 80,524 / 100,000，剩余 19,476，小于每次预留的 20,000。已停止额外模型请求；提高测试额度需要用户另行授权。此前的真实流程验收通过，不代表当前额度足够继续测试。
- 随后用户另行授权提高到 200K。原额度配置已备份到 `/srv/laogao/backups/geod-agent-quota-20260930-1200/geod-agent.env`（目录 700，文件 600）；仅调整额度字段，保留全部用量记录，重启当前 GeoD Agent 服务后健康检查通过。
- 200K 生效后再次完成真实模型验收（18.83 秒）。证据保存在 `artifacts/source-creator-live-20260930.log` 和 `artifacts/source-creator-model-evidence-20260930.log`。测试对实际工具返回的校验错误按桌面合同回送给模型，禁止通过错误绕过网络地址限制。

以下为发布前候选记录，保留用于追溯。

## 已完成

- 桌面内置 `geod-source-creator`，默认启用，可在技能页查看指令、停用与重新启用。启用偏好跨重启保留；指令随应用版本更新。
- 原生只读工具 `search_sources` 搜索 ArcGIS Online 公共影像目录；`inspect_source` 读取公开 HTTPS 网页、ArcGIS 服务元数据或一张指定样本瓦片。使用应用代理设置，限制地址、跳转、超时和返回大小。
- 内置工具通过既有 `extensions_list → mcp_call` 合同发现／执行，无需新 MCP 进程；已有 `source_registration_prepare` 生成对话审核卡片，页内表单仍须用户确认授权再保存。
- 每次对话带入本机已启用的技能索引，供模型选择 `skill_read`；不把本机目录路径或凭证传入索引。

## 验证与当前限制

- Skill Creator 验证器通过。原生本地测试 22 项通过（5 项忽略）；前端现有测试 26 项、模型网关本地测试 8 项通过。
- 真实网络测试读取 USGS NAIP Plus ImageServer 元数据，并从在线目录返回影像候选。此测试验证接口兼容性，不声称完成影像批量下载。
- 使用现有桌面登录调用托管模型的 Creator 验收未通过：模型实际只能调用 `workspace_status` 和 `sources_list`，随后明确表示没有扩展发现／读取／调用工具。未在用户图源库保存测试图源，未启动下载。
- 只读核对线上 `/srv/laogao/current/geod-agent` 指向 `/srv/laogao/releases/geod-agent/geod-agent-loop-20260929-11e3db31`，其 `TOOL_NAMES` 仅含 10 项旧工具。Creator 全程 AI 接入仍须上线已有扩展工具网关候选；本机增加技能文件不能扩展服务器发给模型的工具清单。

## 可审核的网关候选

- 目标：GeoD Agent 模型网关服务；候选 release 名 `geod-agent-extensions-20260930-3ab70aea`。
- 仅替换本仓库 `services/geod-agent-model-gateway/server.mjs`，SHA-256 `3ab70aead307092bea0b179731f20ea2bf89ffbc7fa3a1fb27bf2b71d4774084`。启用已经实现的扩展发现、Skill 读取、MCP 调用、来源草稿等工具合同。
- 本地与线上 `ledger.mjs` SHA-256 均为 `7dbe4f85b1f7fd9389785d86a278dfbb01afe5b70e500ddb581b60bf1bf627f0`，无需修改该文件或数据库结构。
- 发布前备份该服务 SQLite，在新的不可变 release 中保留现有配套文件和配置，仅更换上述服务器文件，验证后切换服务。回滚指向当前 `geod-agent-loop-20260929-11e3db31`；不改账号服务、Nginx、DNS 或模型供应商密钥。
- `laogao-tencent-deploy` 要求服务器改动取得本次授权。当前仅做了本地改动及服务器只读核对，未发布。

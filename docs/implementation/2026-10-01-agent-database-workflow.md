# Agent 发起数据库连接与读取

本次补齐此前“只有手动表单能创建连接”的缺口。目标是在对话中由真实 Agent 决定并调用连接、发现图层、读取属性和使用范围的操作。

## 对话操作

已有测试连接可直接说：

> 连接 Docker PostGIS 测试库，列出空间图层，读取 demo.boundaries_3857.geom 的字段和样例数据。

新连接可提供主机、端口、数据库和用户名：

> 连接 127.0.0.1:55438 的 geod_test 数据库，用户名 geod_reader，看看有哪些图层。

Agent 发起连接并填写配置。如果数据库需要密码，自动出现紧凑的本机认证入口，只补密码；提交后原工具继续返回真实连接和图层，Agent 接着读取。取消会返回 `INPUT_CANCELLED`，停止按钮也会取消等待。

也可以让原生连接器读取用户指定的工作区 JSON 配置，例如 `connections/postgis.json`。配置包含 `host`、`database`、`user`、`password`，可选 `port`、`name`、`sslMode`。模型只传 `credentialFile` 的相对路径；内容由原生读取，不需要把密码发到对话中。默认端口 5432，默认 TLS `prefer`。

## 工具

| 工具 | 结果 |
| --- | --- |
| `data_connection_connect` | 新建连接、实际测试权限、保存凭据、返回稳定 ID 与真实可见图层 |
| `data_connections_list` | 发现已有连接，供 Agent 复用 |
| `data_layer_inspect` | 读取真实字段名称/类型、要素数和属性样例；支持点、线、面；不自动变成裁剪边界 |
| `data_input_read` | 读取面图层、转换 WGS84、保留孔洞并附加到裁剪规划范围 |

工具均可通过当前 Codex 的直接工具调用或 `builtin-data-input` 的 `mcp_call` 使用。旧会话通过 `extensions_list` 可发现新的工具定义。网关源码和桌面静态工具快照已同步到 31 个定义；生产服务本次没有发布。

字段与属性预览使用原生只读 PostgreSQL 连接和安全的 SQL 标识符；尊重表权限和 RLS。空间字段列出类型，几何不会混入样例属性或发给模型。预览最多 10 条，超过 10,000 条只报告明确的计数下界，不能把抽样数称为总数。不提供任意 SQL 或写表接口。

## 真实验证

- **11/11 原生工具检查通过**：从配置创建尚未保存的连接、缺失认证、无效配置、越出工作区、实际字段/中文记录、RLS、过量数据下界、点图层预览、未授权表和面范围读取。
- **真实 Codex 0.159.2 + DeepSeek 流程通过，约 21 秒**：模型主动调用 `data_connection_connect` → `data_layer_inspect` → `data_input_read` → `sources_list` → `plan_imagery`。连接不是测试脚本预先保存的；这四个数据工具使用桌面实际 `executeDataInputTool` 分发器及原生 API，没有伪造数据库结果。
- 实际发现 13 个图层；读取 `id`、`name`、`geom` 三列和唯一一条 `北京测试范围` 记录；面范围为 `[116.1,39.6,116.3,39.8]`，创建 Z12 / GeoTIFF / 16 瓦片裁剪计划。模型说明实际只有一条记录，没有为了满足“两条样例”的请求虚构第二条。
- **认证界面**：实际连接返回需要认证后，自动预填配置并仅显示一个密码输入框；取消后原工具正确结束。此界面验收检查了发起和取消路径；完整新建连接的模型测试使用本机配置文件认证。
- 相关 Agent / Codex 适配回归 12 项通过，1 项专用运行测试跳过；本次另有上述真实模型验证。
- 桌面原生编译、前端 TypeScript/Vite 构建、工具合同同步通过。凭据扫描确认模型测试证据没有数据库密码。

测试新建的临时连接在结束后移除。供用户继续测试的 **Docker PostGIS 测试库** 保留，两个 Docker 服务继续运行，开发桌面继续 HMR。

## 证据

- [原生 Agent 工具检查](evidence/agent-postgis-native-2026-10-01.json)
- [真实模型工具调用与回复](evidence/agent-postgis-real-model-2026-10-01.json)
- [认证界面截图](evidence/agent-postgis-auth-2026-10-01.png)
- [Docker 环境与前一轮测试](2026-10-01-docker-data-input-tests.md)

脚本：`scripts/test-agent-postgis.py`，以及 `test/data-input-real-model.mjs` 的 `postgis-connect` 场景。后者设置工作区和连接文件路径后，由模型调用新连接工具，不预先创建连接。只生成计划，没有启动下载。

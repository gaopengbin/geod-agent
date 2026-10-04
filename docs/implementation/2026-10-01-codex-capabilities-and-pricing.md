# Codex 能力、数据输入与收费实测

核对日期：2026-10-01。运行时：本机打包 Codex 0.159.2 + GeoD 本地网关 + DeepSeek `deepseek-flash`。本次仅更新开发版，没有发布服务器或修改付费/限额政策。

> 这是 10 月 1 日的历史核对快照。10 月 2 日已完成多区域实际下载、持久化影像定时任务与完整任务收费预览，当前能力和边界以 [新版验收报告](2026-10-02-batch-schedules-pricing.md) 为准；下文“调度器尚未实现”等为当时状态。

## 1. Codex 还有什么值得接

已接入的基础能力包括真实 Thread/Turn/Item 生命周期、流式文本/执行记录、持久会话恢复、steer/interrupt、原生授权与用户提问、Skills 完整包、HTTP MCP、命令执行、上下文用量与压缩事件。它们属于 Codex 引擎能力，GeoD 提供桌面交互和 GIS 执行器。

当前二进制导出的 ClientRequest 有 170 个请求方法（含实验和旧接口），不是 170 个产品功能。核对协议和 `codex-host.mjs` 后，剩余重点如下：

| 能力 | 开源/协议边界 | GeoD 当前状态 | 建议 |
| --- | --- | --- | --- |
| 定时任务、定时跟进 | 0.159.2 没有 automation RPC；官方应用有 Scheduled，宿主负责触发。不能把接上 app-server 等同于带了调度器 | 尚无产品调度器 | P0：自己实现持久化调度 + 运行记录，用 thread/resume、turn/start 运行 |
| 后台终端监控 | `thread/backgroundTerminals/list/terminate/clean` 已在本机协议内，实验接口 | 已展示 command 事件；没有统一后台进程管理页和按进程停止入口 | P0：接列表、状态、停止；GIS 下载继续由本机状态驱动 |
| 退出界面后继续工作 | 独立 Codex 进程能成为服务的一部分，但应用宿主管理、GIS 回调和通知仍需我们实现 | 关闭桌面会结束本机子进程；有持久会话，不等于后台服务 | P0：拆出本机 Agent/GIS daemon，再考虑关窗后调度 |
| 模型任务队列、会话分支 | `thread/queue/*`、`thread/fork` | 现有 GIS 任务队列和 steer 已接；原生模型排队、分支尚未形成 UI | P1：多项需求依次运行，保留会话分支和各自任务归属 |
| 并行子 Agent | Codex 开源引擎有相关能力；我们的适配还按单轮回调运行，不能直接承诺 GIS 工具并发安全 | 尚未完成子 Agent 事件/工具回调/工作区隔离的实测 | P1：先验证独立范围规划与只读检查，再开放并发写入 |
| 图片输入 | App-server 支持 image/localImage；当前 DeepSeek 官方也支持图像理解 | GeoD 网关仍按文本契约处理输入 | P1：补网关图片契约、原生附件与真模型测试 |
| MCP OAuth、自定义请求头、通用 stdio | 开源 MCP 客户端/插件相关接口可复用；各服务认证仍需单独适配 | 已有公开 HTTP、本机专用 GDAL/OpenLayers；缺少通用连接配置和 OAuth 流程 | P1：接数据库和私有在线服务时补认证入口 |
| Plugins、Hooks、Memory 管理 | 本机协议有 `plugin/*`、`hooks/list`、`memory/status/reset` 等 | 未接管理页面；已有 Skills 不等于完整插件生命周期 | P2：先验证 DeepSeek 路由与本机权限，再做可管理的插件与记忆 |
| Review / Git worktree / 文件变更审阅 | 开源引擎可复用 | 有文件执行事件，尚无完整审阅与 worktree 产品流程 | P2：GIS 脚本开发场景再优先接 |

依据：[官方开源组件](https://learn.chatgpt.com/docs/open-source)、[App-server 文档](https://learn.chatgpt.com/docs/app-server)、[定时任务文档](https://learn.chatgpt.com/docs/automations?surface=app)。定时器归属宿主的判断基于本机协议缺少 automation RPC 和官方 Scheduled 描述，不能推断整个闭源桌面产品已经开源。

### 定时任务在 GeoD 的实现边界

优先做两种：已有下载计划的定时执行，以及当前会话的定时检查/续作。SQLite 保存 scheduleId、accountId、conversationId、时区、到期时间/规则、启用状态、计划版本和每次 run。单次运行使用幂等 run key，失败可查，错过时间记录为 missed，不在重启后自动批量补发旧任务。

调度触发后读当前会话权限和图源配置。完全访问可执行用户已经安排的任务；逐次确认则生成待确认计划。关闭界面后继续执行，需要 daemon；先做“应用运行时触发”版必须在 UI 明确标注。调度器本次尚未实现，不是已经能用的能力。

## 2. 数据输入本次已实现

后续已补齐 **Agent 发起新数据库连接和属性读取**：`data_connection_connect`、`data_layer_inspect`。真实模型通过桌面同一工具分发器从未保存连接开始，完成图层发现、属性预览和裁剪规划。见 [Agent 数据库流程](2026-10-01-agent-database-workflow.md)。

对话输入框的 **＋ → 添加数据范围** 提供文件、在线数据、数据库三个入口。支持上传文件组；多图层显示真实图层选择；缺失坐标系要求填写已知源 CRS。读取只改应用暂存数据，原文件不修改。

粘贴文件与选择文件使用同一导入流程：保留整组 Shapefile 配套文件，多图层继续选择，不要求重新上传。连接和图层行只显示悬浮状态，不做放大。

- 文件：GeoJSON/JSON、Shapefile 配套文件或 ZIP、GeoPackage、空间 SQLite、KML/KMZ、GML、FlatGeobuf、EWKT/WKT、CSV WKT。
- 在线：HTTP(S) 矢量文件、WFS GetFeature、ArcGIS query、OGC API Features items 返回数据的网址。JSON 和 WFS GML 的分页标记/下一页被识别，避免把截断的边界当完整数据。
- 数据库：PostgreSQL/PostGIS，读取可见的 `geometry_columns`、选择图层，使用只读事务、SQL Identifier 和 ST_Transform。密码在 Windows 凭据库，模型只看连接名称/ID、图层元数据和范围摘要。
- AI：`data_input_read` / `data_connections_list`；旧会话可通过 `extensions_list` 发现 `builtin-data-input`，再用 `mcp_call` 调用，不需要重置历史。
- 核心规划仍接收 WGS84 Polygon/MultiPolygon；孔洞保留。点、线可被识别但不能直接当裁剪面；GPX 轨迹不自动猜测闭合范围。普通无几何 SQLite 不是空间范围输入。

### 验证证据

| 层级 | 实际结果 |
| --- | --- |
| GDAL 格式/异常检查 | 16 项通过，含 EPSG:3857 → 4326、孔洞、多图层、缺失 CRS、点几何、ZIP 路径 |
| 原生 Tauri IPC | 24 项通过，含上传文件组、在线返回、分页拒绝、真实 Esri Virginia 查询、数据库凭据隐藏 |
| 真实 PostgreSQL/PostGIS | 临时本机 PostgreSQL 17.4 / PostGIS 3.6，发现空间图层并读取 3857 多边形；同连接参数写入被只读事务拒绝 |
| Docker PostgreSQL/PostGIS 补测 | PostgreSQL 18.6 / PostGIS 3.6.4，22/22 桌面原生用例通过；只读连接保留供用户测试 |
| Docker GeoServer WFS 补测 | GeoServer 2.28.2 接同一 PostGIS 库，8/8 桌面原生用例通过，含 GML2/GML3.2、纬经轴与分页 |
| 公开在线服务补测 | ArcGIS Virginia 和 OGC API Features 的真实贝加尔湖多边形读入成功；WFS 演示站 HTTP 403，未取得通过证据 |
| 真实 Codex + DeepSeek | 4/4 流程成功：查询图源、GPKG、在线范围、PostGIS；后三种实际调用本机 plans_create 生成 16 瓦片裁剪计划，没有启动下载 |
| 界面 | 文件上传、多图层选择、loading、附加成功、暗/亮色；证据见下方 JSON/截图 |
| 网关账本回归 | 14 项通过，含缓存记录、未知缓存计量、幂等结算、无限测试模式 |
| Codex 适配回归 | 5 项通过，1 项需专用运行参数而跳过；本次模型链路另有上面的 4/4 真实测试。桌面工具快照与网关 29 个工具定义完全一致 |

限制：尚未通测 MySQL/SQL Server、空间 geography 字段、FileGDB、WFS/OGC 服务目录发现、分页自动合并、数据库条件筛选和数据库私有证书 UI。当前在线入口消费要素响应网址；不能把服务首页、地图图片/WMS 瓦片当作矢量边界。单个输入组 32 MiB、10,000 要素，规范化边界 1 MiB，超出后明确要求筛选/简化，不静默截取。

公开 WFS 端点仍有服务端拒绝访问的失败记录。用户启动 Docker 后补建了真实 GeoServer / PostGIS 环境，已完成 WFS GetFeature 的本机 HTTP/原生导入验证；不能把本机通过推断为所有公开端点均可访问。部署、修复与结果见 [Docker 数据输入报告](2026-10-01-docker-data-input-tests.md)。

## 3. 收费依据与建议

代码与设计里尚未落地正式收费 SKU。本次补充 SQLite `cached_input_tokens`、`reasoning_tokens`、`upstream_model`。缓存是输入的一部分，思考是输出的一部分，不重复计费；旧记录缺少缓存计量时保留 NULL，不能按零缓存伪装成精确成本。

DeepSeek Flash 官方人民币价格（2026-10-01核对，每百万 token）：闲时缓存输入 ¥0.02、未缓存输入 ¥1、输出 ¥4；高峰分别 ¥0.04 / ¥2 / ¥8。周末及中国法定节假日全天按闲时。模型成本由实际 usage 套用价格估算，不是供应商账单。[官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

| 真实测试流程 | 请求数 | 总输入 / 缓存输入 / 输出 | 用时 | 闲时成本估算 | 高峰同量估算 | 全部未缓存高峰压力估算 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 查询图源 | 2 | 29.80K / 22.14K / 0.13K | 10.4秒 | ¥0.008620 | ¥0.017240 | ¥0.060642 |
| GPKG → 裁剪计划 | 4 | 61.17K / 60.03K / 0.60K | 14.2秒 | ¥0.004740 | ¥0.009479 | ¥0.127142 |
| 在线范围 → 裁剪计划 | 3 | 45.64K / 44.67K / 0.49K | 12.9秒 | ¥0.003808 | ¥0.007617 | ¥0.095174 |
| PostGIS → 裁剪计划 | 6 | 92.41K / 90.88K / 0.66K | 18.2秒 | ¥0.005973 | ¥0.011945 | ¥0.190070 |

**结论：不能沿用 100K/200K 总 token 的小配额当商业标准。** 它会把廉价缓存输入和高价输出混为一谈，几轮工具调用就耗完，价格也难解释。先保持测试版不限额、仅记账。

建议首个付费试验（还未启用）：

- 个人版 **¥29/月，含 ¥10 AI 余额**；本机下载、格式转换、任务监控不按瓦片/token 另外收费。产品权益、维护与模型用量清楚分开。
- AI 单价按当前供应商高峰价 × 2 做初始基准：缓存输入 ¥0.08/百万、未缓存输入 ¥4/百万、输出 ¥16/百万。每次费用累积到高精度，不对每次工具调用最低扣 1 分钱。月度包含的 ¥10 余额最高对应约 ¥5 高峰模型成本；剩余 ¥24 覆盖应用服务、支付/税务和维护，不能直接称为净利润。
- 补充余额可先测 **¥10 充值 ¥10 AI 余额**。上述单价下模型部分高峰毛利约 50%，闲时约 75%，仍不包含固定服务成本。换模型/供应商必须新建价格版本，保留订单口径。
- 用户可看总价、缓存输入/未缓存输入/输出和失败结算；模型请求取消后可能已产生供应商用量，需要清晰口径。纯本机监控不调用模型，因此不持续扣 AI 余额。

只有 4 个短任务，存在热缓存、同账号和小范围偏差。历史 119 个已结算请求共约 1.985M 输入、33.3K 输出，但没有完整缓存明细，不能精确补算。正式定价前还需长会话、批量任务、重试/断流和多用户并发的 P50/P95；以上是本次证据支持的起步方案，不是已公布价格或无限量承诺。

## 证据和复现

- `evidence/data-input-formats-2026-10-01.json`
- `evidence/data-input-native-2026-10-01.json`
- `evidence/data-input-services-2026-10-01.json`
- `evidence/data-input-real-model-2026-10-01.json`
- `evidence/agent-cost-2026-10-01.json`
- `evidence/data-input-dark-2026-10-01.png`
- `evidence/data-input-light-2026-10-01.png`
- `evidence/data-input-postgis-ui-2026-10-01.png`
- `scripts/test-data-inputs.py`、`scripts/test-native-data-inputs.py`
- `scripts/test-data-input-services.py`（依赖外部服务可用性，当前 WFS 403 会令脚本报告失败）
- `apps/geod-agent-desktop/test/data-input-real-model.mjs`
- `scripts/assess-agent-cost.py`
- `scripts/sync-codex-tools.mjs`（从网关同步桌面工具快照）

真实模型测试需开发桌面、1421 原生测试代理、临时 PostGIS 与本地测试网关。测试连接会移除；不会保留测试密码在模型或证据中。后续复现要先启动测试数据库。

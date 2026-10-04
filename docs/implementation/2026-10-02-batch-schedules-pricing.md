# 多区域任务、定时下载与收费候选验收

日期：2026-10-02。仅本机开发模式；Codex 0.159.2、DeepSeek `deepseek-flash`、原生 Tauri/GDAL/pgEdge/OpenLayers。未安装新发行版，未发布服务器，未开启收费或测试额度限制。

## 1. 多区域与任务归属

- 会话保存多个独立范围，支持选择其中一个、合并选中范围，或 `plan_imagery_batch` 按区域拆分；合并后保留原范围与输入 ID。
- 计划、输出目录和成果分别关联区域。任务默认名称使用行政区/数据图层名称；聊天每轮只显示紧凑任务入口，右侧保留逐项、批量处理与历史。
- 首个验收：驻马店，以及真实共享行政边界的阜阳、平顶山、漯河、南阳、信阳、周口。依据 AreaCity `2025.251231.260403`、采集日期 2026-04-03；不是凭城市名称猜邻接。
- 原生测试完成七份独立裁剪及一份合并裁剪（13 个面、35,147 个顶点）。真实 AI 另完成七市合并的 Z8 / GeoTIFF 下载，20 张实际 Esri 瓦片，并调用 OpenLayers 加载、列出与定位成果；图层为可见、ready 的 GeoTIFF raster。
- 修复大范围导入成功后原生核验仍按 1 MiB 拒绝的问题：规范化边界允许 8 MiB，保持几何上限和文件核验。原失败记录保留；新作业实际完成，不把失败作业改写成成功。

证据：
[原生拆分及合并](evidence/batch-imagery-native-2026-10-02.json)、
[真实 AI 完整流程](evidence/batch-agent-model-2026-10-02.json)、
[真实地图](evidence/batch-agent-map-2026-10-02.png)。

## 2. 文件、数据库与在线输入

13 种原生实际输入均走完“读取 → 持久化范围 → 规划 → 下载裁剪 → 核验清单与 raster 非空像素”：GeoJSON、GeoPackage、空间 SQLite、KML、GML、FlatGeobuf、KMZ、EWKT、Shapefile 文件组、Shapefile ZIP、CSV WKT、在线 GeoJSON、PostGIS EPSG:3857。共 26 张实际瓦片，13/13 通过；孔洞保留，坐标转换至 WGS84。

另外，真实 Codex 模型独立完成 GeoPackage、在线范围、Docker PostgreSQL/PostGIS 三条下载及地图加载流程。PostGIS 从原生凭据文件建立新连接、发现实际图层、读取属性，密码不进入模型上下文。Docker PostgreSQL 18.6 / PostGIS 3.6，数据库发现由内置 pgEdge MCP 提供。

证据：
[13 种完整下载](evidence/data-input-download-native-2026-10-02.json)、
[AI GeoPackage](evidence/gpkg-agent-download-2026-10-02.json)、
[AI PostGIS](evidence/postgis-agent-download-2026-10-02.json)、
[AI 在线范围](evidence/online-agent-download-2026-10-02.json)。

范围：在线文件/WFS/ArcGIS query/OGC Features 的要素响应可以作为输入；服务目录自动遍历、其他数据库类型、geography、私有证书和自动分页合并仍未完成。在线 GeoJSON 的完整下载测试使用本机真实 HTTP 服务；不能推断所有公开服务均可用。

## 3. 取消、暂停与重启恢复

实际 187 瓦片任务在下载 3 张后取消，原生状态为 cancelled 且 worker 不再运行。另一个任务在下载 1 张后暂停，退出并重启桌面后恢复同一 job，最终 187/187 完成，清单完整、raster 非空；旧进度保留。

证据：[原生生命周期](evidence/native-job-lifecycle-2026-10-02.json)。该测试证明同一任务续传和保留进度；没有独立网络抓包，不能进一步宣称绝无重复瓦片请求。

## 4. 持久化定时下载

入口：右侧 **任务与成果 → 定时**；AI 可用 `schedules_create/list/set_enabled/cancel_run`，旧 Codex 会话可通过 `extensions_list → builtin-schedules → mcp_call` 使用相同原生能力。

- SQLite 保存任务模板、账号/会话、到期时间、间隔、运行记录、重试与租约。数据库 v4 迁移前生成备份。
- 单次、每小时、每天、每周；API 支持至少 60 秒的固定间隔。日期按设备本地时间显示，存 ISO 到期时间；固定间隔不是 cron/DST 日历调度。
- 到时重新核对当前图源/权限，生成独立计划和带运行 ID 的目录。完全访问可执行；逐次确认产生待确认计划，不自动下载。
- 应用运行时由原生后台检查，不持续请求 AI，也不在聊天刷进度。应用关闭期间不执行；重启后将错过的多次间隔合并为一次补执行，并计算下一次时间。
- 临时网络错误有有限重试和回退等待，同一任务保留进度。停止后续触发与取消本次执行是两个明确操作；完成记录保留。
- 事务认领、唯一到期键、leaseOwner 校验阻止重复启动和过期 worker 回写。定时模板显示“已设定时”，不提供立即下载/丢弃按钮；本次运行的计划另入队列。

真实原生验收：一次触发、周期触发后暂停、逐次确认与取消、HTTP503 → 同 job 重试成功、关闭后重启补执行且只产生一次运行，全部通过。

真实 AI 创建一次定时下载，模型回答结束后原生调度器到时完成下载；随后核验完整清单及 raster。旧会话确实用 MCP 读到同一运行的 succeeded 状态。

证据：
[原生定时与重试](evidence/native-schedules-2026-10-02.json)、
[AI 建立定时](evidence/schedule-agent-model-2026-10-02.json)、
[成果与模板归属](evidence/schedule-followup-native-2026-10-02.json)、
[旧会话真实调用](evidence/schedule-old-thread-model-2026-10-02.json)、
[任务区截图](evidence/schedule-task-panel-2026-10-02.png)。

边界：这一版是已有影像计划的定时下载，不是任意 AI 指令定时运行，也不是退出桌面后仍工作的系统服务。界面明确提示应用需运行。

## 5. 完整任务成本与可执行收费预览

四个正常真实模型流程共 40 次结算请求；另一个 HTTP503 故障任务 7 次。每次 generation ID、输入、输出、缓存计量与实际本地网关 SQLite 逐项交叉核对。思考是输出的子集，不重复计费。

按 [DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（2026-10-02 核对）估算，单位人民币：

| 完整任务 | 模型请求 | 闲时成本 | 高峰同量成本 | 全部未缓存的高峰压力估算 | 候选用户费用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 驻马店及周边六市下载和地图 | 12 | 0.038945 | 0.077890 | 0.597964 | 0.155780 |
| GeoPackage 下载和地图 | 12 | 0.019842 | 0.039683 | 0.522878 | 0.079366 |
| PostGIS 连接、读取、下载和地图 | 9 | 0.024745 | 0.049490 | 0.472474 | 0.098981 |
| 在线范围下载和地图 | 7 | 0.010847 | 0.021695 | 0.401276 | 0.043389 |
| 指定 HTTP503 故障任务 | 7 | 0.015988 | 0.031976 | 0.269308 | 整项失败后退回，净额 0 |

供应商成本是公开单价估算，不是供应商发票。展示闲时和高峰两种结果；没有猜测节假日归属。四个正常小范围任务 4/4 成功，故障用例 1/1 正确判定失败；不能将人为故障混入正常样本宣称生产失败率 20%，也不足以提供多用户 P95。

候选维持 **¥29/月，含 ¥10 AI 余额**。AI 每百万 token：缓存输入 ¥0.08、未缓存输入 ¥4、输出 ¥16；本机下载、格式转换和监控不另扣模型用量。这是待产品试验的候选价格，尚未启用。

新增独立 `pricing-candidate.mjs` 和 SQLite 预览账本：整数 nano-CNY、价格版本、幂等 generation 归属、重启持久化、未知缓存不假装精确计价。用 47 次实际结算生成本地费用预览，重复处理不多扣；故障任务必须有原生 terminal failed 证据才退回 AI 费用，重复退款为 0，供应商成本仍留在报告中。¥10 测试余额最终 ¥9.62248448。

证据：
[成本及预览](evidence/complete-workflow-cost-2026-10-02.json)、
[真实故障任务](evidence/failed-agent-download-2026-10-02.json)、
[实际计量导出](evidence/local-gateway-usage-2026-10-02.json)。

收费预览未接生产钱包、支付或扣费接口。正式启用前仍需权威任务状态接入账单、长会话/多用户成本样本和产品权益确认；当前测试版继续不限额。

## 6. 复现与运行

开发模式启动：`scripts/start-codex-dev.py --local-gateway`；本地网关可用 `services/geod-agent-model-gateway/dev/start-local-gateway.py --existing-config` 读取已有配置启动。后者仅只读获取既有供应商配置，不修改服务器。

- `test/batch-imagery-native.mjs`、`test/data-input-download-native.mjs`
- `test/native-job-lifecycle.mjs`（准备及重启恢复分两步）
- `test/native-schedules.mjs`（重启补执行分两步）
- `test/schedule-followup-native.mjs`
- `test/batch-workflow-harness.html`：真实模型执行；需要原生 IPC 测试代理
- `scripts/export-local-test-usage.py` → `scripts/assess-complete-workflow-cost.mjs`

本轮回归：前端 117 通过/1 专用环境跳过，引擎 30 通过/1 手工快照跳过，网关 19 通过；后续补丁又通过 TypeScript、5 个任务汇总测试和 3 个定价/网关合同测试。原生编译成功。所有实际触发过的测试周期任务已暂停后续触发。

后续产品阶段：任意 AI 指令调度与独立后台服务、长会话/并发成本测量、正式价格与付费上线分别推进；本次完成上面的本地验收范围。

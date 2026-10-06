# GeoD Agent 功能推进与验收清单

按用户 2026-10-03 指示整体推进。以下是待完成的本地候选目标，勾选须有实际验收证据；不是已发布能力。

2026-10-04 补充盘点：[当前产品缺口](2026-10-04-product-gaps.md)。本清单覆盖此前约定的功能范围；多语言、完整会话历史、会话管理、前台多会话并行、开机恢复及自动更新等尚未实现。

## 1. 独立后台

- [x] 下载、缓存维护、定时下载由独立后台进程持有；关闭桌面窗口后继续运行。
- [x] 重开桌面连接原后台，任务、暂停、取消和恢复保持一致，没有重复工作进程。
- [x] 本机通信认证、单实例、协议版本匹配、异常退出与停止行为可验证；二进制升级迁移另纳入发行验收。
- [x] 界面可查看后台状态与停止入口，用户能明确区分关闭窗口和退出后台。

证据：`artifacts/background-runtime-20261003/acceptance.json`、`artifacts/background-lifecycle-20261003/acceptance.json`。实际关闭桌面后原后台完成 GeoTIFF、定时影像及 MVT；重开连接原 PID。延迟图源经实际本机下载器完成暂停、关窗重开、同任务续传、取消、后台意外退出后重新连接及续传；无认证/错误认证/跨站 Origin 被拒绝，第二后台实例退出，错误协议版本明确返回，显式停止后轮询不自动重启。

## 2. 数据与连接

- [x] ArcGIS / OGC 在线服务目录发现、完整分页读取及范围/数量限制。
- [x] WFS 1.0/1.1/2.0 能力目录、字段、分页与声明 CRS 适配；旧版本分页按服务扩展核验。
- [x] 保存私有在线数据认证配置；服务字段、实际要素读取、GeoJSON/GeoPackage 导出及地图加载闭环。
- [x] PostGIS 条件筛选、geography 与 CA 证书配置，verify-full/verify-ca 实际验收。
- [x] PostgreSQL / PostGIS 双向 TLS，通过实际客户端证书读取、窗口重开和真实 Agent 流程。
- [x] 已支持范围内的普通 PostgreSQL、SQLite 矢量文件及 GeoPackage 按可复现服务/文件逐项验证。
- [x] 通用 stdio MCP、自定义请求头，秘密保存在本机凭据库。
- [x] MCP 浏览器 OAuth 授权、刷新、取消与移除本机授权的协议流程；外部提供方账号另行验收。

证据：`artifacts/online-inputs-20261003/recheck/acceptance.json`、`artifacts/postgis-selection-20261003/acceptance.json`、`artifacts/private-mcp-20261003/acceptance.json`。在线导出另有 `artifacts/online-exports-20261003/acceptance.json`、`artifacts/online-exports-public-20261003/public-acceptance.json` 及 `artifacts/online-exports-ai-20261003/ai-acceptance.json`。实际模型已完成私有服务发现、下载、关窗后台完成、重开核验及地图加载；公开 ArcGIS/OGC 文件保留源 ID 和属性。详见 `2026-10-03-online-vector-exports.md`。

真实模型证据：`artifacts/connections-ai-20261003/acceptance.json`。实际产品对话经 Codex + 托管模型完成 PostGIS 条件筛选、在线服务发现和通用 stdio pgEdge 查询，未将凭据写进对话。

WFS 证据：`artifacts/wfs-inputs-20261003/acceptance.json` 19 项实际 native 验收通过；`ai-acceptance.json` 为真实模型经实际产品工具发现并读取、保存范围。详见 `2026-10-03-wfs-inputs.md`。

OAuth 证据：`artifacts/mcp-oauth-20261003/acceptance.json`。通过实际 native 调用及本机协议服务验证发现、动态注册、PKCE、错误 state/issuer、过期及 401 刷新、取消重授权保留旧凭据、移除连接器取消回调。公共客户端自动注册和手工 client ID 的原有结果继续有效。2026-10-06 开发版补充预注册客户端密钥和固定本机回调端口；本机协议已验收 Basic / POST 密钥交换、重连及刷新、同端口重复授权和旧授权记录兼容，详见 `2026-10-04-browser-elicitation.md`。外部提供方账号、服务端撤权仍未完成。

双向 TLS 证据：`artifacts/postgis-mtls-20261003/acceptance.json` 16 项、`cancel-acceptance.json` 及 `ai-acceptance.json` 均通过。真实 pgEdge MCP 连接强制客户端证书的 Docker PostGIS；私钥以 Windows DPAPI 保存，真实模型复用连接读取属性并保存范围。详见 `2026-10-03-postgis-client-tls.md`。

普通数据库证据：`artifacts/plain-databases-20261003-final/acceptance.json` 7 项通过。实际 Agent 从本机凭据文件连接没有 PostGIS 的 PostgreSQL，读取真实属性；SQLite EPSG:3857 矢量文件经真实输入工具转换并保存为 WGS84 范围。GeoPackage 另通过内置 GIS 运行时验收。这里的范围不包含尚未接入的 MySQL、SQL Server 或 Oracle；详见 `2026-10-03-plain-databases.md`。

## 3. Agent 功能

- [x] 图片输入贯穿附件、Codex 与网关，使用真实模型验证。
- [x] 任意 AI 指令定时运行，保留独立任务上下文与运行记录，失败可重试/取消。
- [x] Codex 会话分支，保留分支时的上下文并隔离后续消息和图片归属。
- [x] 请求排队、暂停、移除与继续发送；队列保存在所属会话。
- [x] 后台命令管理，独立进程状态、停止和重连入口；实际桌面与无窗口定时 AI 均通过。
- [x] 本地插件整包管理，Skill 与私有 MCP 安装快照、启停、账号隔离及真实 AI 调用。
- [x] 明确请求的账号/工作区偏好，AI 保存、跨对话使用、页内编辑/停用/删除。
- [x] 大型对话和地图记录持久存储；容量问题后的实际迁移、重载和恢复验收。
- [x] 子 Agent 工作区/事件/执行隔离。

AI 定时执行证据：`artifacts/ai-schedules-20261003/acceptance.json`、`controls-acceptance.json`。关闭桌面窗口后，真实 Codex 与托管模型调用本机工具、读取随机编号并保存结果；重开桌面连接同一后台并读取原记录。运行中的命令可取消，逐次确认权限暂停后经完全访问重试完成真实 GeoTIFF 下载。实际对话可创建任务，右侧定时页可暂停；不同定时任务使用不同 Codex 线程，重试沿用原任务线程。实际 0.2.0 release 已验证一次性指令停机后补执行、再次重启不重复；长时间停止后的多周期合并另纳入长期验收。

分支与排队证据：`artifacts/conversation-controls-20261003/acceptance.json`。实际 `thread/fork` 创建不同 Codex 线程；原会话修改状态后，分支的真实模型仍回答分支时的状态。图片复制为新会话所属的附件，原图片 ID 不能越会话读取。真实本机命令执行期间加入两条消息、移除其中一条并暂停，完成后队列仍保留；继续发送后真实模型处理剩余消息。详见 `2026-10-03-conversation-controls.md`。

后台命令证据：`artifacts/background-commands-20261003/acceptance.json` 19 项、`ai-acceptance.json` 5 项、`recovery-acceptance.json` 3 项及 `schedule-acceptance.json` 均通过。真实 Codex `command/exec` 保存中文输出、接收输入、取消子进程、关窗继续、重开读取，并在后台意外退出后保留中断记录且不自动重跑。实际模型与关窗后的定时 AI 均启动真实命令并读到真实文件。Windows 流式执行使用当前用户权限，界面与工具结果明确标识。详见 `2026-10-03-background-commands.md`。

插件与记忆证据：`artifacts/plugins-memory-20261003-final/acceptance.json` 12 项实际桌面与真实 AI 验收；`artifacts/local-state-20261003/acceptance.json` 验证现有数据迁移、超过原存储上限的记录重开及实际请求恢复。详见 `2026-10-03-plugins-memory-and-persistence.md`。在线市场和 Hooks 未接入。

子任务证据：`artifacts/agent-tasks-20261003-final/acceptance.json` 13 项实际验收，独立 Codex 线程与模型收据、真实读写、主 Agent 分派和回读、取消、跨会话拒绝及关窗继续均通过。文件工具隔离不等于操作系统沙箱；详见 `2026-10-03-independent-agent-tasks.md`。

## 4. 三维

- [x] 公开 ArcGIS 在线地形、外部 GLB、动画和实际时钟逐项验证，补齐真实状态与高程采样。
- [x] S2 包围体、隐式四叉树/八叉树、glTF 1 及两种旧 b3dm 兼容，真实下载、核验和实际渲染通过。
- [x] 私有 Ion 地形与本机凭据通道的联合验收。

证据：`artifacts/cesium-scene-tools-20261003/acceptance.json` 8 项；`artifacts/tiles3d-compatibility-20261003-final/acceptance.json` 10 项，库测试 30 项。实际模型读取生产场景状态；S2 下载使用本机真实协议夹具与 Khronos 几何，两种旧 b3dm 使用固定 Cesium 官方样例。详见 `2026-10-03-cesium-scene-and-compatibility.md`。

Ion 地形证据：`artifacts/ion-terrain-20261003-visible/acceptance.json` 6 项实际桌面与真实模型验收，真实凭据加载 Asset 1，山体渲染及高程采样通过；401 刷新采用实际 HTTP 夹具验证。详见 `2026-10-03-ion-terrain.md`。

## 5. 收费与发行候选

- [x] 实际本机任务状态、模型收据与测试退款闭环；长会话和网关并发成本测试。
- [x] 支付、订阅、钱包的本地候选与明确的测试模式。
- [x] 0.2.0 安装/便携候选、本机应用目录隔离、空闲旧后台切换、数据恢复与独立依赖验收。
- [ ] 干净 Windows、首次安装及安装向导升级验收；用户已明确暂缓，不计入本轮本机完成条件。

开发阶段维持热更新，不反复安装，不启用正式收费，不发布线上服务。正式上线另交付完整可审阅候选。

收费候选证据：`artifacts/billing-candidate-20261003-final/acceptance.json` 5 组实际验收，6 轮长会话、4 个并发模型请求及实际失败下载退款；测试余额持久化、重放幂等均通过。详见 `2026-10-03-billing-candidate.md`。供应商价格按固定费率估算；正式支付、资金退款与远端可信证明未上线。

发行候选证据：`artifacts/release-candidate-0.2.0-20261003-r2/acceptance.json` 7 项通过；`development-restored.json` 确认原有 30 个会话和成果保留，0.2.0 开发模式与热更新已恢复。详见 `2026-10-03-release-candidate.md`。从真实安装包解出程序执行，没有运行安装向导；本机候选网关的通过不能替代正式环境验收。

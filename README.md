# GeoD Agent

GeoD Agent 是面向地理数据获取与交付的独立桌面产品。用户描述目标，检查图源、区域和资源预算，确认后由自己的电脑下载、拼接、裁剪并核验成果。GeoD 托管模型负责理解需求和提出工具调用；影像瓦片不经 GeoD 模型服务器中转。

**当前状态：Windows NSIS 安装版已用正式 GeoD 账号完成“AI 对话 → 本机图源工具 → Z18 计划 → 用户在成果页批准 → 本机下载与恢复 → 地图展示和成果核验”真实任务。GeoD OAuth、服务端 DeepSeek 网关与令牌自动刷新已在生产环境联调；USGS NAIP Plus 90/90 瓦片、GeoTIFF、MBTiles、预览和 SHA-256 均已复检。首个公开安装包仍须完成干净 Windows 环境、旧版回归和网络隐私检查。**

## 当前实现

本仓库现在有独立的 [`geod-core`](crates/geod-core) 格网计算和 [`geod-task-engine`](crates/geod-task-engine) 确定性计划。它们使用有版本的 [任务合同](contracts/0.1)，对授权图源元数据、范围、等级、输出目录和资源预算做校验，给出瓦片格网与 `planHash`。可运行样本和验证命令见[实施记录](docs/implementation/2026-09-28-planning-slice.md)。样本是合成数据，不下载第三方瓦片。

本地 [SQLite 任务账本](docs/implementation/2026-09-28-task-ledger.md)保存计划、批准、作业 ID 与事件，并在启动事务中校验计划和来源版本。[本机影像执行](docs/implementation/2026-09-28-imagery-worker.md)用合成 HTTP 图源和用户批准的 USGS NAIP ImageServer 样本生成 GeoTIFF、MBTiles、预览和可核验 manifest。桌面应用在 `apps/geod-agent-desktop`；模型网关在 `services/geod-agent-model-gateway`。正式账号、安装版和生产 DeepSeek 的实际验收见[发布与任务记录](docs/implementation/2026-09-28-production-candidate.md)。

## 设计资料

- [产品方案与竞品调研](docs/design/geod-agent-desktop-product-2026-09-27.md)
- [技术架构与实施顺序](docs/design/geod-agent-desktop-technical-architecture.md)
- [界面信息架构与主题方向](docs/design/geod-agent-desktop-product-2026-09-27.md#6-信息架构与界面)
- [仓库与产品边界](docs/REPOSITORY_BOUNDARY.md)

## 首条交付链

GeoD 账号登录 → 对话描述任务 → Agent 读取已授权图源并补问范围与格式 → 确定性估算与计划卡 → 用户批准 → 本机下载、拼接、裁剪 → 核验文件与 manifest。左侧保存本机对话，中间以对话和 MapLibre 地图为主，右侧成果页按需展开；界面提供蓝白亮色与黑色暗色主题。任务工作区不设手动参数表单；地图用 OpenStreetMap 在线底图显示计划范围，并按实际地理坐标叠加已校验的本地影像。OSM 瓦片只用于当前视窗显示和浏览缓存，不进入离线成果。图源授权、计划批准、暂停和取消仍由用户确认。任务按瓦片保存校验检查点，暂停或网络故障后可复用已校验瓦片。GeoJSON 多边形可附加到对话并用于本机透明裁剪；真实图源的多边形全流程仍需单独验收。

## 仓库状态

这是独立 Git 仓库。现有 [GeoD 桌面端、CLI、MCP](https://github.com/gaopengbin/geo-downloader) 继续在原仓库维护；[GeoD Global](https://github.com/gaopengbin/geod-global) 是另一个产品。当前实现没有指向旧仓库的运行时路径依赖。

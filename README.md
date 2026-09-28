# GeoD Agent

GeoD Agent 是面向地理数据获取与交付的独立桌面产品。用户描述目标，检查图源、区域和资源预算，确认后由自己的电脑下载、拼接、裁剪并核验成果。GeoD 托管模型负责理解需求和提出工具调用；影像瓦片不经 GeoD 模型服务器中转。

**当前状态：独立桌面程序和 Windows NSIS 安装包已构建，并完成隔离安装/启动/卸载冒烟；计划、批准、本地下载、范围裁剪、成果核验及 USGS 真实影像样本已验证。原生窗口交互尚未完整验收。GeoD 账号 OAuth 与托管模型网关已实现本地合同，真实账号与 New API 模型路由尚未完成端到端验收。**

## 已实现的第一步

本仓库现在有独立的 [`geod-core`](crates/geod-core) 格网计算和 [`geod-task-engine`](crates/geod-task-engine) 确定性计划。它们使用有版本的 [任务合同](contracts/0.1)，对授权图源元数据、范围、等级、输出目录和资源预算做校验，给出瓦片格网与 `planHash`。可运行样本和验证命令见[实施记录](docs/implementation/2026-09-28-planning-slice.md)。样本是合成数据，不下载第三方瓦片。

本地 [SQLite 任务账本](docs/implementation/2026-09-28-task-ledger.md)保存计划、批准、作业 ID 与事件，并在启动事务中校验计划和来源版本。[本机影像执行](docs/implementation/2026-09-28-imagery-worker.md)用合成 HTTP 图源和 USGS NAIP ImageServer 样本生成 GeoTIFF、MBTiles、预览和可核验 manifest。桌面应用在 `apps/geod-agent-desktop`；模型网关在 `services/geod-agent-model-gateway`。当前实现和剩余验收见[桌面与网关实施记录](docs/implementation/2026-09-28-desktop-and-gateway.md)。

## 设计资料

- [产品方案与竞品调研](docs/design/geod-agent-desktop-product-2026-09-27.md)
- [技术架构与实施顺序](docs/design/geod-agent-desktop-technical-architecture.md)
- [桌面工作区示意图](docs/design/geod-agent-desktop-wireframe.png)（[SVG 源文件](docs/design/geod-agent-desktop-wireframe.svg)）
- [仓库与产品边界](docs/REPOSITORY_BOUNDARY.md)

## 首条交付链

GeoD 账号登录 → 托管模型理解任务 → 用户选择或登记有权使用的图源 → 地图拖框或输入范围 → 估算与批准 → 本机下载、拼接、裁剪 → 核验文件与 manifest。任务状态、审批、暂停和恢复由本地确定性引擎负责，不能由模型回复代替。任务按瓦片保存校验检查点，暂停或网络故障后可复用已校验瓦片；多边形导入仍在后续开发范围内。

## 仓库状态

这是独立 Git 仓库。现有 [GeoD 桌面端、CLI、MCP](https://github.com/gaopengbin/geo-downloader) 继续在原仓库维护；[GeoD Global](https://github.com/gaopengbin/geod-global) 是另一个产品。当前实现没有指向旧仓库的运行时路径依赖。

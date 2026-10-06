# GeoD Agent

GeoD Agent 是面向地理数据获取与交付的独立桌面产品。用户描述目标，检查图源、区域和资源预算，确认后由自己的电脑下载、拼接、裁剪并核验成果。GeoD 托管模型负责理解需求和提出工具调用；影像瓦片不经 GeoD 模型服务器中转。

**当前版本：0.2.3 Windows x64 测试版。** 包含 Codex Agent、二维/三维地图、数据输入与下载、后台任务、多语言、定时任务、缩略图缓存和 Credits 界面。本版启用签名在线更新通道和应用内消息中心，正式网关已于 2026-10-06 同步。新用户首次启用 Agent 钱包仍赠送 20,000 Credits，支持一次性发放与真实用量结算；也可在“模型与渠道”配置自己的模型服务。充值和真实收费保持关闭，全新 Windows 与本版真实安装升级验收依用户指示暂缓。

安装包：[GeoD 公开下载](https://geod.laogao.xyz/agent-updates/windows-x86_64/0.2.3/GeoD%20Agent_0.2.3_x64-setup.exe)。完整发行资源：[GitHub Release v0.2.3](https://github.com/gaopengbin/geod-agent/releases/tag/v0.2.3)。Release 标记为预发布，仓库维持私有权限。旧 0.2.0/0.2.1 需要先手动安装这一版，之后可在应用内更新。

本轮入口见 [0.2.3 版本说明](docs/releases/0.2.3.md)和[更新与消息上线记录](docs/implementation/2026-10-06-updates-messages.md)。[0.2.1 版本说明](docs/releases/0.2.1.md)、[体验额度验收](docs/implementation/2026-10-04-welcome-credits.md)以及 0.2.0 的[版本说明](docs/releases/0.2.0.md)、[发行收尾](docs/implementation/2026-10-04-release-closeout.md)保留历史记录。完整验收范围见[功能清单](docs/implementation/2026-10-03-functional-roadmap.md)；以前的安装/升级核对保留在[原发行候选记录](docs/implementation/2026-10-03-release-candidate.md)。

## 当前实现

本仓库现在有独立的 [`geod-core`](crates/geod-core) 格网计算和 [`geod-task-engine`](crates/geod-task-engine) 确定性计划。它们使用有版本的 [任务合同](contracts/0.1)，对授权图源元数据、范围、等级、输出目录和资源预算做校验，给出瓦片格网与 `planHash`。可运行样本和验证命令见[实施记录](docs/implementation/2026-09-28-planning-slice.md)。样本是合成数据，不下载第三方瓦片。

本地 [SQLite 任务账本](docs/implementation/2026-09-28-task-ledger.md)保存计划、批准、作业 ID 与事件，并在启动事务中校验计划和来源版本。[本机影像执行](docs/implementation/2026-09-28-imagery-worker.md)用合成 HTTP 图源和用户批准的 USGS NAIP ImageServer 样本生成 GeoTIFF、MBTiles、预览和可核验 manifest。桌面应用在 `apps/geod-agent-desktop`；模型网关在 `services/geod-agent-model-gateway`。正式账号、安装版和生产 DeepSeek 的实际验收见[发布与任务记录](docs/implementation/2026-09-28-production-candidate.md)。

## 设计资料

- [产品方案与竞品调研](docs/design/geod-agent-desktop-product-2026-09-27.md)
- [技术架构与实施顺序](docs/design/geod-agent-desktop-technical-architecture.md)
- [界面信息架构与主题方向](docs/design/geod-agent-desktop-product-2026-09-27.md#6-信息架构与界面)
- [仓库与产品边界](docs/REPOSITORY_BOUNDARY.md)

## 技能与连接器（本地开发中）

在对话中描述需要的能力，Agent 会先搜索网络 Skill 目录；如果用户提供 Skill 页面、GitHub 仓库或 `SKILL.md` 链接，也可直接检查来源并获取。左侧“技能与连接器”可在线搜索、粘贴链接、检查内容后启用。GitHub 和本地导入保留 Skill 的脚本、参考资料和资源目录；GitHub 包固定到实际提交并记录内容 SHA-256。启用后的完整包交给 Codex 加载，脚本通过其原生执行工具运行。其他直接 Markdown 链接仍只导入指令文件。脚本自身的 Python、GDAL 等依赖需要在本机可用，不能把成功导入等同于依赖已安装。

Agent 也可以按对话需求搜索 [官方 MCP Registry](https://registry.modelcontextprotocol.io/docs) 中无需额外请求头的 Streamable HTTP 服务，或使用用户本轮明确提供的 HTTPS／本机 HTTP 地址。它先连接并列出真实工具，再把首次启用确认卡放在对话中；此权限独立于工作区“完全访问”。左侧商店可用于查看和手动管理。桌面端使用官方 Rust MCP SDK 列工具和调用工具；网络请求沿用应用的自动或手动代理设置。Registry 是发布者提交的发现目录，列出服务不代表 GeoD 授权其影像数据批量下载。

GIS 格式转换有内置的本机 GDAL MCP 入口，使用固定版本 `gdal-mcp==1.1.3` 与随应用分发的 Python/GDAL，开放栅格／矢量检查、转换、重投影、裁剪等工作区工具。安装候选运行时不依赖系统 `uvx`、Python 或 Node。文件范围绑定当前对话工作区，写入要求“完全访问”。HTTP 与通用 stdio MCP 保留真实工具参数、结果和错误；私有请求头和浏览器 OAuth 授权/刷新已接入，秘密保存在本机。外部提供方账号仍需逐项联调。GDAL、OpenLayers 与 Cesium 通过 GeoD 的工作区/场景桥接操作当前产品视图。

MCP 调用会以模型请求和工具调用编号保存本机执行记录。中断后可复用已经保存的结果；无法确定远端是否完成时，Agent 停止后续自动操作并提示核对，避免静默重复调用。

地图有内置 OpenLayers MCP，在当前对话中加载图源和下载成果、管理图层、调整视野、添加 GeoJSON/标注和截图；Cesium MCP 可操作三维相机、图层、地形与场景，并切换二维/三维视图。图层和视野按会话恢复。操作经真实工具调用及场景状态回读验证，见 [OpenLayers 修复记录](docs/implementation/2026-10-01-openlayers-mcp-0.2.md)与[三维验收](docs/implementation/2026-10-03-cesium-scene-and-compatibility.md)。

扩展工具已接入本地 Agent 多轮循环，真实模型已验证 Skill 搜索、链接检查、MCP 发现和工具调用。完整 Skill 包与 MCP 可以按本地插件快照安装、启停和移除；明确要求保存的偏好可跨会话使用。Codex 流式接口、运行时工具协议与 Credits 结算已在正式网关验证，详见[0.2.1 网关上线记录](docs/implementation/2026-10-04-gateway-021-production.md)。

## Codex 本地候选

当前开发版采用固定 Codex 0.159.2 引擎与 DeepSeek Flash 托管模型，两者在输入框中分别标识。Codex 的完整指令、工具合同、思考内容和历史由原生层经过专用网关协议传输；前端保存显示记录，不再给 Codex 另加 60 条／100 条截断。上下文圆环使用引擎返回的实际 token 和有效窗口，本次配置 128K、引擎有效窗口 121.6K。

原生命令、MCP 和思考记录可展开，执行中可以补充要求或停止本轮。模型基于真实工具结果产生回答；下载交给独立后台监控。图片附件、会话分支、消息排队、后台命令与 AI 定时指令均已通过真实模型验收。子任务使用独立 Codex 线程、事件和模型收据，目前开放文件读取/写入工具，最多并发 3 个；这不是操作系统沙箱。见[功能清单](docs/implementation/2026-10-03-functional-roadmap.md)及[子任务验收](docs/implementation/2026-10-03-independent-agent-tasks.md)。

文档附件支持常见 PDF、现代及旧版 Office 的打开密码，包括加密扫描识别。本机密码表单完成解密后，AI 通过附件工具读取保存文本；密码不进入会话、后台任务或模型提示词。真实前台/关窗模型、分支、完整备份和程序重启均已核对，详见[加密文档验收](docs/implementation/2026-10-04-encrypted-documents.md)。新增能力继续通过开发模式验证。

开发前运行 `python scripts/prepare-codex-runtime.py` 准备固定 Codex、Node 与许可证；GDAL 和 pgEdge 同样使用固定运行时，Tauri 发布构建会执行准备步骤。版本和校验值已固定，正确的本地文件可离线复用。前端使用 Vite HMR。内部网关联调可用 `python scripts/start-codex-dev.py --local-gateway` 启动开发桌面，前提是本机联调网关已启动。发行候选另有实际安装包执行与恢复证据；线上及干净 Windows 验收边界见[发行记录](docs/implementation/2026-10-03-release-candidate.md)。

## 首条交付链

GeoD 账号登录 → 对话描述任务 → Agent 配置或读取图源与范围 → 确定性估算 → 按工作区权限批准或自动执行 → 本机下载、拼接、裁剪 → 核验成果。聊天区仅保留紧凑任务入口，多个待确认/进行中任务暂存在右侧列表，用户可批量选择、丢弃或取消。关闭窗口后后台任务继续，重开可连接原后台；显式停止后台有单独入口。

输入范围支持多种矢量文件、普通 PostgreSQL/PostGIS 与在线 ArcGIS/OGC/WFS 数据；数据库通过内置 pgEdge MCP 发现表、读取属性和面范围。任务按资源保存校验检查点，暂停或网络故障后复用已核验进度。地图按实际坐标叠加本地成果，OSM 底图仅用于当前视窗显示和浏览缓存。各格式、图源及三维数据的具体范围与真实验收记录见[功能清单](docs/implementation/2026-10-03-functional-roadmap.md)。

## GeoD 独立运营报表

账号、官网事件、旧桌面匿名使用和 Agent 模型用量通过
[`scripts/Get-GeoDAnalytics.ps1`](scripts/Get-GeoDAnalytics.ps1) 生成独立聚合报表。
账户只读取 GeoD 自己的账号服务；官网固定筛选 `geod-web`，不使用微信工具箱
账户、导出、关注或支付数据。运行方式与统计限制见
[`services/geod-analytics/README.md`](services/geod-analytics/README.md)。

## 仓库状态

这是独立 Git 仓库。现有 [GeoD 桌面端、CLI、MCP](https://github.com/gaopengbin/geo-downloader) 继续在原仓库维护；[GeoD Global](https://github.com/gaopengbin/geod-global) 是另一个产品。当前实现没有指向旧仓库的运行时路径依赖。

数据库支持本机输入加密 PEM 私钥密码，认证后由 AI 继续读取。PostGIS、MySQL/MariaDB、Oracle 的真实连接、前台/关窗模型、完整重启及受保护凭证备份均已核对；详见[加密数据库私钥验收](docs/implementation/2026-10-04-encrypted-database-keys.md)。

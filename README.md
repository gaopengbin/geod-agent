# GeoD Agent

GeoD Agent 是面向地理数据获取与交付的独立桌面产品。用户描述目标，检查图源、区域和资源预算，确认后由自己的电脑下载、拼接、裁剪并核验成果。GeoD 托管模型负责理解需求和提出工具调用；影像瓦片不经 GeoD 模型服务器中转。

**当前状态：产品与技术设计。尚无可安装的 GeoD Agent 程序。**

## 设计资料

- [产品方案与竞品调研](docs/design/geod-agent-desktop-product-2026-09-27.md)
- [技术架构与实施顺序](docs/design/geod-agent-desktop-technical-architecture.md)
- [桌面工作区示意图](docs/design/geod-agent-desktop-wireframe.png)（[SVG 源文件](docs/design/geod-agent-desktop-wireframe.svg)）
- [仓库与产品边界](docs/REPOSITORY_BOUNDARY.md)

## 首条交付链

GeoD 账号登录 → 托管模型理解任务 → 用户选择或登记有权使用的图源 → 画图或导入边界 → 估算与批准 → 本机下载、拼接、裁剪 → 核验文件与 manifest。任务状态、审批和恢复由本地确定性引擎负责，不能由模型回复代替。

## 仓库状态

这是独立 Git 仓库，后续桌面应用、任务引擎和 Agent 专用服务在此开发。现有 [GeoD 桌面端、CLI、MCP](https://github.com/gaopengbin/geo-downloader) 继续在原仓库维护；[GeoD Global](https://github.com/gaopengbin/geod-global) 是另一个产品。当前仅迁入评审资料，未复制旧应用代码，也没有对旧产品的发布承诺。

# 数据库与 GIS MCP 现成项目选型

核对日期：2026-10-01。目标是应用自动管理的本地标准 MCP 连接器，让用户通过 Agent 建立连接、发现图层和读取数据。

## 结论

当前 Windows 桌面版的 PostgreSQL/PostGIS 连接器优先采用 **pgEdge Postgres MCP 1.1.0**；格式转换继续复用已经固定版本的 **GDAL MCP 1.1.3**。如果后续需要一个覆盖多种数据库的统一服务，再优先评估 **Google MCP Toolbox**。

这份结论基于公开源码、版本化发行物和本机真实 stdio MCP 测试。当前仅完成选型和候选验证，**GeoD 的数据库调用链尚未迁移**。这里的 MCP 测试也不是一次真实模型或完整桌面认证流程测试。

## 候选比较

| 项目 | 已核对的维护/发布 | 能力与适配情况 | 判断 |
| --- | --- | --- | --- |
| [pgEdge/pgedge-postgres-mcp](https://github.com/pgEdge/pgedge-postgres-mcp) | PostgreSQL License；正式版 1.1.0，2026-09-04 发布；主分支 2026-09-28 更新 | Go 独立程序；本地 stdio；SQL 查询、原生表/字段发现、连接池、配置多连接及切换；Windows 程序 17,682,944 字节，约 16.9 MiB | 当前 PostGIS 首选。空间专用工具和 GeoD 的认证/会话衔接仍需接入适配 |
| [googleapis/mcp-toolbox](https://github.com/googleapis/mcp-toolbox) | Apache-2.0；正式版 1.13.1，2026-09-25 发布；原名 genai-toolbox；主分支 2026-09-30 更新 | 多数据库来源；预置工具与自定义参数化 SQL 工具；本地 stdio；Windows 程序 293,772,440 字节，约 280.2 MiB | 通用多数据库框架更完整，适合作为后续扩展候选。此次只实测了 PostgreSQL/PostGIS |
| [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) | MIT；约 3.4K stars；主分支 2026-08-16 更新；正式版/PyPI 仍为 2025-05-16 的 0.3.0 | 通用 PostgreSQL 查询、模式发现、性能诊断；Python；stdio/SSE；当前发行版需固定兼容 SDK，restricted 模式拒绝实测 PostGIS 查询 | 可参考通用数据库查询设计，当前不优先采用 |
| [JordanGunn/gdal-mcp](https://github.com/JordanGunn/gdal-mcp) | MIT；正式版 1.1.3，2026-02-01 发布；主分支 2026-05-21 更新 | 栅格/矢量信息、转换、重投影、裁剪、缓冲与资源；现有 GeoD 已使用固定版本及 Windows 反思缓存适配 | 继续复用 GIS 文件处理能力；数据库连接管理需要独立模块 |
| [neverinfamous/postgres-mcp](https://github.com/neverinfamous/postgres-mcp) | MIT；正式版 3.1.0；主分支 2026-09-21 更新 | 有独立 PostGIS 工具实现，包括范围、空间查询、geometry/geography 支持；大型工具集及工具过滤 | 可借鉴空间工具组织。此次只审查源码，未实测；README 的性能/节省 token 比例未验证 |
| [receptopalak/postgis-mcp](https://github.com/receptopalak/postgis-mcp) | 主分支 2026-04-21 更新；未见 GitHub 正式 release；package.json 声明 ISC，GitHub 未识别单独许可文件 | TypeScript；多连接发现、空间查询与转换；仓库有 2 个测试文件 | 实现参考，发布和分发规范仍需核对；未实测 |
| [microsoft/postgres-mcp](https://github.com/microsoft/postgres-mcp) | MIT；标为 Preview；npm 0.2.0 | 连接配置档、OS keyring、连接/断开、查询及模式工具；公开 GitHub 仓库主要是文档，npm 包依赖平台发行物 | 认证与连接体验值得参考。此次没有验证完整可修改构建源码及真实协议调用，不作为源码复用首选 |

Stars、测试文件数量和更新日期只用于提供维护背景，不能单独证明产品成熟度。完整仓库快照、提交 SHA、发行链接及许可识别信息见 [仓库证据](evidence/gis-mcp-repositories-2026-10-01.json)。

## 标准 MCP 与真实 PostGIS 验证

使用现有 Docker `geod-agent-postgis-test`，PostgreSQL 18.6 / PostGIS 3.6.4，通过已有 `geod_reader` 测试角色访问合成数据。没有创建真实业务数据，也没有修改测试库数据。

客户端使用标准 Python MCP SDK，实际执行 `initialize` → `tools/list` → `tools/call`。候选运行在独立本地子进程中，凭据从本机测试文件读取后仅通过子进程环境传入。所有进程在测试结束后关闭。

两套候选都通过了下面 9 项真实读取检查：

1. 发现实际可见的 13 个空间表/几何列条目。
2. 读取真实中文属性值。
3. 读取真实字段和 `geometry(Polygon,3857)` 类型。
4. 3857 → 4326 转换、GeoJSON 输出与孔洞保留。
5. RLS 范围内读取，返回 1 条可见记录。
6. 带中文、空格和引号的表/列标识符。
7. 同表多个几何列和 NULL 值计数。
8. 空间视图读取。
9. 不存在表的错误返回。

pgEdge 还通过了原生 `get_schema_info` 工具发现 `demo.boundaries_3857` 的检查。Google Toolbox 测试使用 `--prebuilt=postgres/data --stdio`，发现了实际的 8 个数据工具。

### crystaldba 发行版的实际兼容问题

- 不固定依赖时，0.3.0 安装解析到 MCP 2.x，启动即报 `mcp.server.fastmcp` 不存在。
- 固定 `mcp==1.30.0` 后可启动。
- `restricted` 模式在第 4 项拒绝 `ST_Transform/ST_AsGeoJSON`，原因是发行版 SQL 校验器使用函数允许清单。
- 使用 `unrestricted` 解析模式、仍连接原来的 SELECT-only 测试角色时，9 项读取通过。
- 该发行版有些查询错误仅作为 `Error:` 文本返回，`isError` 仍为 false；接入时需要明确处理这种结果。

### Google Toolbox 的接入注意点

- 1.13.1 的 `POSTGRES_QUERY_PARAMS` 在本次实测中要求映射形式，例如 `{"sslmode":"disable"}`；`sslmode=disable` 字符串导致配置解析错误。
- 配置解析失败时，stderr 可能包含完整来源配置，包括密码。本次临时日志已脱敏；正式宿主应在收集日志前进行凭据脱敏。
- 原生发行物比 pgEdge 大。是否纳入桌面安装包、按需获取或另做精简构建，需要结合后续多数据库需求决定。

结果和真实返回见 [协议/数据库证据](evidence/oss-postgis-mcp-2026-10-01.json)。其中原始工具文本与解析后的结果都保留，密码及数据库 URI 不写入证据。

## GeoD 的接入边界

现成服务器可复用的部分：标准 MCP 传输、工具发现/调用、数据库连接池、模式读取、SQL 执行与错误返回。

GeoD 需要完成的适配：

- Agent 提供连接参数后，调用本机认证界面并保存到现有凭据系统。
- 由应用启动、关闭和恢复固定版本的 MCP 子进程，不要求用户手动安装或编写配置。
- 连接与当前会话绑定；服务实例/当前数据库选择按会话隔离，切换数据库不改变其他会话。
- 空间数据通过本地句柄/文件交给地图、范围附件和任务引擎；模型获取字段、数量和范围摘要。
- 为 Agent 提供清晰的空间图层发现与读取工具；借助已有 GIS 代码处理坐标、孔洞及格式输出。

pgEdge 的连接切换工具面向已配置的连接，它没有 GeoD 的新连接认证界面或地图/计划结果交接。这些操作仍由应用组织，用户可通过 Agent 完成整个流程。

## 复现

在仓库根目录执行：

```powershell
rtk proxy python -X utf8 scripts/research-gis-mcp.py
```

脚本返回本次研究缓存的绝对路径。将它用于下载固定版本的候选与补充源码：

```powershell
rtk proxy python -X utf8 scripts/research-gis-mcp.py --cache <研究缓存路径>
rtk proxy python -X utf8 scripts/research-gis-mcp.py --cache <研究缓存路径> --toolbox
rtk proxy uvx --from gdal-mcp==1.1.3 python -X utf8 scripts/test-oss-postgis-mcp.py --cache <研究缓存路径> --toolbox
```

需要现有 Docker PostGIS 测试库和本机 `.secrets/reader-connection.json`。pgEdge 发行 ZIP 已核对官方 SHA-256；Google Windows 二进制来自官方文档指定的 GCS 路径，已核对对象 MD5，并将本次 SHA-256 固定在证据中。

此次研究没有修改桌面业务调用链、模型网关或安装包。

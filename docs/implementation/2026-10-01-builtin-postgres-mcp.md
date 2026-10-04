# 内置 PostgreSQL / PostGIS MCP

## 完成范围

GeoD Agent 开发版已集成未经修改的 **pgEdge PostgreSQL MCP 1.1.0 Windows x86_64**。
连接、目录发现、字段与属性读取、PostGIS 面范围读取均实际经过标准 MCP
stdio 的 `initialize → tools/list → tools/call(query_database)`，不再由 Python
psycopg 直接访问数据库。普通 PostgreSQL 数据库不需要安装 PostGIS；可以发现
表和视图，读取字段、计数与属性样例。带 PostGIS 的数据库还会返回空间图层。

Agent 继续使用应用的四个稳定接口：`data_connections_list`、
`data_connection_connect`、`data_layer_inspect`、`data_input_read`。
这些是 GeoD 的数据输入适配器；它们在原生端调用 pgEdge MCP，不是把原来的
Python JSON worker 改名成 MCP。当前对话没有增加任意 SQL 或写入接口。

“技能与连接器”页提供紧凑的 **PostgreSQL / PostGIS · 内置** 卡片及使用说明。
连接中的 loading 保留；数据库提示改为“正在连接数据库并读取图层”。

## 运行与认证

- 应用按操作启动独立的隐藏 stdio 子进程，完成、错误或超时后关闭并回收。
  每个进程只有该操作选定的数据库上下文，不使用共享的全局数据库切换状态。
- 密码通过子进程环境传入，保存在 Windows 凭据库；不放在命令参数、模型
  工具参数或返回内容里。子进程不继承其他数据库配置、模型密钥和 trace 路径。
- 使用应用固定的配置文件、二进制 SHA-256 校验及 MCP 服务版本检查。
  pgEdge 的写入和数据库切换关闭；实际数据库查询在只读事务中运行。
- 凭据错误仍触发原来的本机认证表单，填写后把真实表目录、图层和 MCP 元数据
  交回当前 Agent 工具调用；模型根据真实结果继续执行。
- GIS 文件和在线输入继续使用 GDAL。数据库几何由 PostGIS 转换到 WGS84，
  保留 MultiPolygon、内孔和 NULL 几何处理，原生端验证后才附加裁剪范围。

上游查询结果是 TSV，应用把有界的结构化结果编码为单列 base64 JSON，避免
属性中的 TAB、换行和引号破坏返回解析。字段、属性样例、要素与几何字节数保留
现有输入上限；不会把超过上限的空间数据静默当作完整边界。数据库表名和列名
从实际发现目录解析，并单独转义 SQL 标识符及值。

## 固定版本与打包

来源：https://github.com/pgEdge/pgedge-postgres-mcp/releases/tag/v1.1.0

- 官方 ZIP SHA-256：`6db8f45f8f3d04d3637def1f095bdf70e5999dfb1d1ca61c0f2da2a6564ca885`
- EXE SHA-256：`8640a0d089284dc0a2005c550dc1c08f88a4c4b1e333f6f11b9bd8bd35766dae`
- 许可证：PostgreSQL License，原文与二进制一起打包。
- 版本及来源记录：`vendor/pgedge-postgres-mcp-1.1.0.json`。
- 准备脚本：`scripts/prepare-pgedge-runtime.py`；支持复用已下载的官方 ZIP。
- Tauri 发布资源：`pgedge-runtime/`；开发资源：`src-tauri/resources/pgedge/`。
- 开发启动和发布准备脚本均已接入资源准备。本次只运行开发版，未制作或安装
  新安装包，未发布服务器。网关文件只同步了工具描述。

## 实测结果

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 原生 PostGIS 范围输入回归 | 22/22 | `evidence/pgedge-postgis-native-2026-10-01.json` |
| Agent 数据库原生接口 | 11/11 | `evidence/pgedge-agent-native-2026-10-01.json` |
| 无 PostGIS 的普通 PostgreSQL | 4/4 | `evidence/pgedge-plain-postgres-native-2026-10-01.json` |
| MCP 并发上下文、RLS、只读写入拒绝 | 通过 | `evidence/pgedge-mcp-isolation-2026-10-01.json` |
| GeoJSON / GeoPackage 文件兼容 | 2/2 | `evidence/pgedge-file-regression-2026-10-01.json` |
| 实际 Codex 0.159.2 + DeepSeek 模型 | 通过 | `evidence/pgedge-agent-real-model-2026-10-01.json` |
| MCP 返回解析与 SQL 名称转义单元测试 | 2/2 | `cargo test postgis_mcp::tests --lib` |
| 原生编译及前端 TypeScript/Vite 构建 | 通过 | `cargo build`、`npm run build` |

PostGIS 回归包括 EPSG:3857、内孔、多面、NULL、多几何列、视图、中文及引号
名称、行权限、空图层、无效几何、SRID 0、10,001 要素、错误凭据和 Docker 重启。
该回归中的账号/事务写入检查使用数据库驱动；另一个并发验证直接调用真实 MCP，
确认拥有写权限的管理员连接也处于只读事务，且 MCP 拒绝零行 DELETE。

普通 PostgreSQL 验证创建了唯一临时数据库，未安装 PostGIS，读取带中文、引号、
TAB、换行和嵌套 JSON 的真实属性。测试结束删除该临时数据库及应用测试连接。

真实模型主动调用连接、字段读取及范围读取，然后使用已登记图源生成 **Z12 /
GeoTIFF、16 瓦片**裁剪计划。模型回答由实际模型生成，主机没有替换成固定话术。
测试仅生成计划，没有启动影像下载。实际 MCP 服务报告协议 **2025-11-25**、
服务版本 **1.1.0**，成功结果含原生返回的 MCP 服务与调用计数信息。

前端截图是后台浏览器中的组件验收页，检查内置入口与说明；数据库与模型验证
通过运行中的 Tauri 原生 IPC，而非页面模拟数据。

## 用户可直接测试

在 GeoD Agent 对话中输入：

> 连接 Docker PostGIS 测试库，列出图层，读取 demo.boundaries_3857.geom 的字段和属性样例，再把它作为裁剪范围。

已有用户测试连接与 Docker 容器保留。pgEdge 工作进程在操作结束后退出，应用
按需启动；开发桌面和前端 HMR 保持运行。

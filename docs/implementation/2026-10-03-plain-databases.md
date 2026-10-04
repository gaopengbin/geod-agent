# 普通 PostgreSQL 与 SQLite 矢量数据验收

## 实际结果

`artifacts/plain-databases-20261003-final/acceptance.json`：7 项通过，页面错误为 0。使用实际桌面、内置 MCP、Codex 0.159.2 和托管模型，没有以模拟模型代替 Agent。

- 在专用 Docker 服务创建唯一临时 PostgreSQL 数据库，明确没有安装 PostGIS。
- 内置 pgEdge MCP 发现真实表；正确读取带中文、双引号的表名、制表符、换行、整数和嵌套 JSON。
- 普通属性表不会被当作矢量裁剪范围。连接元数据保存数据库类型，不返回密码。
- 真实 Agent 使用工作区相对凭据文件连接数据库，再读取实际字段与两条记录。随机值只在数据库中，Agent 正确回答随机值和分数总和；凭据没有进入对话或证据。
- 内置 Python/GDAL 生成 EPSG:3857 的 SQLite 矢量文件；实际 native 输入读到完整面并转换成 WGS84。
- GDAL MCP 独立读取同一 SQLite 文件。
- 真实 Agent 通过产品工具读取 SQLite 文件，并将实际范围保存到当前会话。

临时数据库、保存的测试连接和凭据文件已移除。测试矢量文件留在唯一工作区测试子目录，方便复核。

## 支持边界

数据库连接面板支持 PostgreSQL / PostGIS；SQLite 和 GeoPackage 通过文件输入及 GDAL MCP 读取矢量图层。SQLite 文件读取不等于任意 SQLite SQL 查询，也不等于 MySQL、SQL Server、Oracle 已接入。

现有支持范围的其他证据：GeoPackage 位于 `artifacts/bundled-gdal-20261003-final/acceptance.json`；PostGIS 条件筛选、geography 和双向 TLS 见本轮对应验收记录。

## 复现

运行 `scripts/accept-plain-databases.mjs`，传入 Playwright 模块路径和证据目录。要求开发桌面、本机网关和专用 `geod-agent-postgis-test` Docker 服务已启动。`plain-postgres-fixture.py` 只创建/移除唯一验收数据库；不依赖系统 Python 的数据库库。

# Docker 数据输入实测

日期：2026-10-01。本次在用户启动的 Docker Desktop 中部署独立测试环境，通过运行中的 GeoD 开发桌面执行原生导入与真实模型测试。

## 已部署并保留运行

| 服务 | 实际版本 | 本机入口 | 容器 |
| --- | --- | --- | --- |
| PostgreSQL / PostGIS | PostgreSQL 18.6 / PostGIS 3.6.4 | `127.0.0.1:55438`，数据库 `geod_test` | `geod-agent-postgis-test` |
| GeoServer | 2.28.2，GeoTools 34.2 | `http://127.0.0.1:18083/geoserver` | `geod-agent-geoserver-test` |

两项服务均健康，使用命名卷保存数据，只绑定本机地址。退出 Codex 不会结束 Docker 容器；Docker Desktop 需要保持运行。`unless-stopped` 在 Docker 恢复时启动未被手动停止的容器。

镜像来源与固定版本：

- [PostGIS 官方镜像仓库](https://github.com/postgis/docker-postgis)，`postgis/postgis:18-3.6`，digest `sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677`。
- [GeoServer 官方 Docker 仓库](https://github.com/geoserver/docker)，`docker.osgeo.org/geoserver:2.28.2`，digest `sha256:4f25018703dabd617c00c74753ac2aa02829c555578db365e8c338722754cb88`。

配置位于 `infra/postgis-test/compose.yaml`。管理密码和只读连接草稿位于该目录的 `.secrets/`，已确认被 Git 忽略。GeoD 保存的连接密码在 Windows 凭据库，模型和测试证据不包含密码。

## 用户如何继续测试

**通过 Agent 对话操作**已补齐新建连接、图层发现、字段和属性读取。可以直接说“连接 Docker PostGIS 测试库，列出图层并读取 demo.boundaries_3857.geom 的字段和样例数据”。具体工具和真实模型证据见 [Agent 数据库流程](2026-10-01-agent-database-workflow.md)。下方表单入口作为另一个操作入口保留。

在开发版 GeoD 点击 **＋ → 添加数据范围 → 数据库 → Docker PostGIS 测试库**。

- `demo.boundaries_3857.geom`：投影坐标转 WGS84，保留内孔。
- `demo.multiple_regions.geom`：MultiPolygon，两个面均保留内孔。
- `demo.nullable_area.backup_geom`：第二几何列，含 NULL 行。
- `demo.projected_view.geom`：数据库视图。
- `demo.scoped_regions.geom`：行级权限，只能读授权的那一个面。
- `demo.empty_area`、`points`、`invalid_area`、`unknown_crs`、`big_area`：专门测试明确的空图层、非面、无效几何、缺失 SRID、过量要素反馈。

在线入口粘贴真实 WFS GetFeature 地址：

```text
http://127.0.0.1:18083/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=geod:boundary&outputFormat=application/json&srsName=EPSG:4326
```

这里是合成测试范围，不是北京市完整行政边界。数据库有 13 个可见空间图层（含几何列）；GeoServer 发布 `geod:boundary`、`geod:regions`、`geod:many_regions` 三个样例图层。

## 实测结果

| 测试 | 结果 | 覆盖范围 |
| --- | --- | --- |
| 桌面原生 PostGIS | 22/22 通过 | 图层发现、3857 转换、孔洞、多面、NULL、第二几何列、SQL 视图、中文及引号名称、行级权限、错误反馈、只读、凭据、容器重启持久化 |
| 桌面原生 WFS | 8/8 通过 | WFS 2.0 GeoJSON、3857 GeoJSON、WFS 1.0 GML2、WFS 2.0 GML3.2 的纬经轴顺序、多面、JSON/GML 分页、服务错误 |
| 真实 Codex + DeepSeek | 1/1 通过，最终回归约 16 秒 | AI 发现连接，读取 Docker 的 `demo.boundaries_3857.geom`，调用本机规划器生成 Z12 / GeoTIFF / 16 瓦片裁剪计划 |
| 文件读取回归 | 16/16 通过 | GeoJSON、SHP、ZIP、GPKG、空间 SQLite、KML/KMZ、GML、FGB、EWKT、CSV 和异常 |
| 异步初始化回归 | 1/1 通过 | 在真实 Tauri 异步任务中构建并释放令牌刷新的 blocking HTTP client，没有 runtime drop panic |
| 界面 | 通过 | 真实数据面板选择 PostGIS 图层、在线 GML2 的 loading 与导入成功状态，结果通过原生 IPC 返回 |

真实模型测试仅创建规划，没有启动下载。它使用本地开发网关和真正的 Codex app-server；回复由模型生成。测试记录保留工具调用和最终结果。

## 实测中修复的问题

1. **只读账号的空间图层发现失败。** 通过文本表名检查权限会提前触发 `tiger` 等未授权 schema 的名称解析错误。改用 `pg_namespace` / `pg_class` OID 检查 schema USAGE 和 SELECT，只返回账号实际可见的图层。
2. **登录令牌过期后导入卡住。** 异步导入直接调用同步认证刷新，在 Tokio worker 中创建/释放 blocking HTTP client 导致 panic，并污染凭据锁。文件、在线导入和数据库保存的认证初始化统一移到 `spawn_blocking`；新增真实 runtime 回归检查。
3. **GML 2 导入失败。** GDAL 3.12 在有界读取的末尾会尝试联网解析旧式 `http://www.opengis.net/gml/srs/epsg.xml#4326` 标识。将这种明确的 EPSG URI 在内存中规范为 `EPSG:4326`，保留 GML2 经纬坐标顺序，不改原文件。简单 GML 从响应本身发现结构，不依赖下载远程 schema；轴顺序行为参照 [GDAL GML 文档](https://gdal.org/en/stable/drivers/vector/gml.html)。
4. **GML 分页被当成完整范围。** GDAL 会正常读取第一页。现在先检查 WFS collection 的 `numberMatched`、`numberReturned`、`next`，未返回完整结果时给出 `INPUT_PAGED_RESULT`，与 JSON 入口保持一致。

边界输入仍要求 Polygon / MultiPolygon。尚未实现分页自动合并、数据库 WHERE 筛选、geography 列、复杂 GML 应用 schema、私有在线服务认证 UI。外部 WFS 演示站此前 HTTP 403 的记录保留；本次取得的是本机真实 GeoServer/PostGIS 的 WFS 验证证据，不能推断所有外部服务均能访问。

## 证据与复现

- [部署和使用说明](../../infra/postgis-test/README.md)
- [PostGIS 原生结果](evidence/docker-postgis-native-2026-10-01.json)
- [WFS 原生结果](evidence/docker-wfs-native-2026-10-01.json)
- [真实 AI 结果](evidence/docker-postgis-real-model-2026-10-01.json)
- [PostGIS 图层选择截图](evidence/docker-postgis-layer-list-2026-10-01.png)
- [PostGIS 导入成功截图](evidence/docker-postgis-import-success-2026-10-01.png)
- [WFS 导入成功截图](evidence/docker-wfs-import-success-2026-10-01.png)

测试脚本：`scripts/docker-postgis-test.py`、`scripts/docker-geoserver-test.py`、`scripts/test-docker-postgis.py`、`scripts/test-docker-wfs.py`。开发原生代理 `apps/geod-agent-desktop/test/openlayers-native-rpc.mjs` 只在测试期间运行，结束后关闭；保留开发桌面、HMR 服务、网关和两个 Docker 服务。

本次只更新本地开发版，没有安装发行版或发布生产服务；收费评估与 Codex 剩余能力见 [原报告](2026-10-01-codex-capabilities-and-pricing.md)。
